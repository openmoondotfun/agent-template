// =============================================================================
// acp serve deploy railway [--replace]
// acp serve deploy railway [setup|status|teardown]
// acp serve deploy railway logs [-f] [--lines N]
// acp serve deploy railway env [set|delete]
// =============================================================================

import { execSync, execFileSync, spawnSync, spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as output from "../lib/output";
import { ROOT, readConfig, getActiveAgent, getShutdownGraceMs } from "../lib/config";

function checkRailwayCli(): boolean {
  try {
    execSync("railway --version", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function runRailway(args: string[], inherit = false): string {
  try {
    // Use execFileSync with array args to prevent command injection
    if (inherit) {
      execFileSync("railway", args, { cwd: ROOT, stdio: "inherit" });
      return "";
    }
    return execFileSync("railway", args, { cwd: ROOT, encoding: "utf-8" }).trim();
  } catch (e: any) {
    throw new Error(e.message || "Railway command failed");
  }
}

function hasLinkedService(): boolean {
  try {
    // `railway variable list` fails if no service is linked
    execSync("railway variable list", { cwd: ROOT, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/** Replace every occurrence of a secret value, e.g. in a failed CLI call's
 *  message, which can repeat the command line. */
function redact(text: string, secret: string): string {
  return secret ? text.split(secret).join("<redacted>") : text;
}

function ensureService(): void {
  if (hasLinkedService()) return;

  output.log("  No service linked. Select or create a service:");
  try {
    // Interactive prompt — lets user pick/create a service
    execSync("railway service", { cwd: ROOT, stdio: "inherit" });
  } catch {
    output.fatal(
      "No service linked. Run `railway service` manually to link or create a service."
    );
  }

  // Verify it worked
  if (!hasLinkedService()) {
    output.fatal("Service still not linked. Run `railway service` and try again.");
  }
}

/** Same as the repo's Dockerfile: the SDK isn't on npm, so build it at /sdk
 *  where `file:../sdk` points. */
function generateDockerfile(): string {
  return `FROM node:20-slim
WORKDIR /app
# SDK version: main by default. Set the SDK_REF build arg (on Railway, a
# service variable of that name) to a tag or commit SHA to pin it.
ARG SDK_REF=main
ADD https://github.com/openmoondotfun/sdk/archive/\${SDK_REF}.tar.gz /tmp/sdk.tar.gz
RUN mkdir -p /sdk && tar -xzf /tmp/sdk.tar.gz -C /sdk --strip-components=1 && rm /tmp/sdk.tar.gz \\
  && cd /sdk && npm install && npm run build
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
RUN ln -s /app/node_modules /node_modules
COPY . .
CMD ["npx", "tsx", "src/seller/runtime/seller.ts"]
`;
}

/** Same as the repo's .dockerignore. */
const DOCKERIGNORE = `# The image gets its settings from environment variables. Keep local
# state, secrets and host-built dependencies out of the build context.
**/node_modules
**/dist
**/.git
**/.env
**/.env.*
config.json
agents/
**/logs
**/*.log
.keys/
*.pem
.DS_Store
`;

/** WALLET_KEY for the hosted seller: the agent's provider key as a JSON array
 *  of secret key bytes. A keypair file is inlined, since key files stay out of
 *  the image. Never prints the key. */
function providerKeyValue(wallet: string): string {
  const trimmed = wallet.trim();
  if (trimmed.startsWith("[")) return trimmed;

  // Resolved like loadKeypair() in src/lib/program.ts
  const file = path.isAbsolute(trimmed) ? trimmed : path.resolve(ROOT, trimmed);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch (e: any) {
    output.fatal(`Cannot read the provider keypair file ${file} (${e.code || "read error"}).`);
  }

  // JSON.parse errors can quote the file, so the message names only the path
  let bytes: unknown;
  try {
    bytes = JSON.parse(raw);
  } catch {
    bytes = undefined;
  }
  if (
    !Array.isArray(bytes) ||
    bytes.length !== 64 ||
    !bytes.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)
  ) {
    output.fatal(`${file} is not a keypair file: expected a JSON array of 64 secret key bytes.`);
  }

  output.log(`  WALLET_KEY: inlined from ${file}`);
  return JSON.stringify(bytes);
}

/**
 * The variables the hosted seller needs, resolved with the CLI's precedence
 * (process.env, which includes .env, then config.json) but without the
 * localhost defaults in src/lib/config.ts. Exits on missing settings, so call
 * it before any Railway call. Values include secrets: never print them.
 */
function resolveSyncVars(): Record<string, string> {
  const agent = getActiveAgent();
  if (!agent) {
    output.fatal("No active agent. Run `acp agent create` or `acp agent import` first.");
  }
  if (!agent.address) {
    output.fatal("The active agent has no address; re-import it with `acp agent import`.");
  }
  if (!agent.wallet?.trim()) {
    output.fatal("The active agent has no provider key in config.json; re-import it with `acp agent import`.");
  }

  const cfg = readConfig();
  const vars: Record<string, string | undefined> = {
    RPC_URL: process.env.RPC_URL || process.env.RPC || cfg.rpc,
    ACP_API_URL: process.env.ACP_API_URL || cfg.apiUrl,
    CHAT_URL: process.env.CHAT_URL || cfg.chatUrl,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || cfg.anthropicApiKey,
    ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL || cfg.anthropicModel,
    POLL_INTERVAL:
      process.env.POLL_INTERVAL || (cfg.pollInterval ? String(cfg.pollInterval) : undefined),
    // Pushed only when set; an unset value never deletes the Railway variable
    TRUSTED_EVALUATORS: process.env.TRUSTED_EVALUATORS,
    SHUTDOWN_GRACE_MS: process.env.SHUTDOWN_GRACE_MS,
    RAILWAY_DEPLOYMENT_DRAINING_SECONDS: process.env.RAILWAY_DEPLOYMENT_DRAINING_SECONDS,
  };

  if (!vars.RPC_URL || !vars.ACP_API_URL) {
    output.fatal(
      "Set RPC_URL and ACP_API_URL in .env or run `acp setup`: the deployed seller would fall back to localhost."
    );
  }
  if (vars.ANTHROPIC_API_KEY && !vars.CHAT_URL) {
    output.warn("CHAT_URL is not set: the deployed seller cannot reach the chat server.");
  }

  // Never sync process.env.WALLET_KEY: in .env it is the creator key; the seller signs with the provider key.
  vars.WALLET_KEY = providerKeyValue(agent.wallet);
  vars.AGENT_ADDRESS = agent.address;
  vars.AGENT_DIR = agent.dir;

  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(vars)) {
    if (value) resolved[key] = value;
  }
  return resolved;
}

/**
 * Push the seller's settings to the linked Railway service as variables, so
 * the hosted seller runs without .env and config.json (both stay out of the
 * image). skipDeploys: true when a deploy follows anyway; false lets the last
 * variable trigger the one redeploy that applies them all.
 */
function syncEnvVars(skipDeploys: boolean, vars?: Record<string, string>): void {
  const entries = Object.entries(vars ?? resolveSyncVars());
  output.log(`  Syncing ${entries.map(([key]) => key).join(", ")} to Railway`);

  entries.forEach(([key, value], i) => {
    // One pair per call; only the last call may trigger a redeploy
    const skip = skipDeploys || i < entries.length - 1;
    const result = spawnSync(
      "railway",
      ["variable", "set", `${key}=${value}`, ...(skip ? ["--skip-deploys"] : [])],
      { cwd: ROOT, stdio: "pipe" }
    );
    if (result.status !== 0) {
      const err = result.stderr?.toString().trim() || result.error?.message || "unknown error";
      output.fatal(`Failed to set ${key}: ${redact(err, value)}`);
    }
  });
  output.success("Environment variables synced.");
}

/** Variables of the linked service, parsed from `railway variable list --kv`.
 *  The output holds raw secrets: it stays in memory and is never printed.
 *  Returns null when the call fails. */
function readServiceVars(): Record<string, string> | null {
  let kv: string;
  try {
    kv = execFileSync("railway", ["variable", "list", "--kv"], {
      cwd: ROOT,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return null;
  }

  const vars: Record<string, string> = {};
  for (const line of kv.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) vars[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return vars;
}

export async function setup(): Promise<void> {
  if (!checkRailwayCli()) {
    output.fatal(
      "Railway CLI not found. Install: npm i -g @railway/cli\n  Then: railway login"
    );
  }

  output.heading("Railway Setup");

  output.log("  Logging in to Railway...");
  try {
    runRailway(["login"], true);
  } catch {
    output.fatal("Railway login failed.");
  }

  output.log("  Creating Railway project...");
  try {
    runRailway(["init"], true);
    output.success("Railway project created.");
  } catch {
    output.warn("Project may already exist. Continuing...");
  }

  output.log("  Linking service...");
  ensureService();

  output.success("Railway setup complete. Run `acp serve deploy railway` to deploy.\n");
}

export async function deploy(opts: { replace?: boolean } = {}): Promise<void> {
  if (!checkRailwayCli()) {
    output.fatal("Railway CLI not found. Run `acp serve deploy railway setup` first.");
  }

  output.heading("Deploying to Railway");

  // Resolve the seller's settings first, so missing ones fail before any
  // Railway call
  const vars = resolveSyncVars();

  // Generate Dockerfile if not present
  const dockerfilePath = path.join(ROOT, "Dockerfile");
  if (!fs.existsSync(dockerfilePath)) {
    output.log("  Generating Dockerfile...");
    fs.writeFileSync(dockerfilePath, generateDockerfile());
    output.success("Dockerfile created.");
  }

  // Generate .dockerignore if not present
  const dockerignorePath = path.join(ROOT, ".dockerignore");
  if (!fs.existsSync(dockerignorePath)) {
    fs.writeFileSync(dockerignorePath, DOCKERIGNORE);
    output.log("  Generated .dockerignore");
  }

  // Ensure a service is linked (Railway requires it for variables + deploy)
  ensureService();

  // One service runs one agent: replacing another agent's seller takes it
  // offline, so it needs --replace
  const current = readServiceVars();
  if (!current) {
    output.warn("Could not read the service's variables; skipping the check for another agent on it.");
  } else if (current.AGENT_ADDRESS && current.AGENT_ADDRESS !== vars.AGENT_ADDRESS) {
    if (!opts.replace) {
      output.fatal(
        `The linked Railway service runs agent ${current.AGENT_ADDRESS}, not the active agent ${vars.AGENT_ADDRESS}. ` +
          "Link another service with `railway service`, or rerun with --replace to replace it."
      );
    }
    output.warn(`Replacing agent ${current.AGENT_ADDRESS} on this service.`);
  }

  // Railway kills the old deployment right after SIGTERM unless the service
  // sets a draining time; give the seller its shutdown grace to finish jobs in
  // progress. Never overwrite a value the service already has.
  if (current && !current.RAILWAY_DEPLOYMENT_DRAINING_SECONDS && !vars.RAILWAY_DEPLOYMENT_DRAINING_SECONDS) {
    vars.RAILWAY_DEPLOYMENT_DRAINING_SECONDS = String(Math.ceil(getShutdownGraceMs() / 1000));
  }

  // Settings → Railway variables (.env and config.json stay out of the image).
  // Skip the per-variable redeploy: `railway up` below deploys once.
  syncEnvVars(true, vars);

  output.log("  Deploying...");
  try {
    runRailway(["up", "--detach"], true);
    output.success("Deployment started. Check status with `acp serve deploy railway status`.\n");
  } catch (e: any) {
    output.fatal(`Deploy failed: ${e.message}`);
  }
}

export async function status(): Promise<void> {
  if (!checkRailwayCli()) {
    output.fatal("Railway CLI not found.");
  }

  try {
    const result = runRailway(["status"]);
    output.heading("Railway Deployment Status");
    output.log(result || "  No active deployment found.");
    output.log("");
  } catch (e: any) {
    output.fatal(`Failed to get status: ${e.message}`);
  }
}

export async function logs(follow = false, lines = 100): Promise<void> {
  if (!checkRailwayCli()) {
    output.fatal("Railway CLI not found.");
  }

  const count = Number.isInteger(lines) && lines > 0 ? lines : 100;
  // railway logs streams by default; --lines prints recent lines and exits.
  const args = follow ? ["logs"] : ["logs", "--lines", String(count)];

  const child = spawn("railway", args, { cwd: ROOT, stdio: "inherit" });
  child.on("error", (e) => output.fatal(`Failed to get logs: ${e.message}`));
  child.on("close", (code) => {
    if (code) process.exitCode = code;
  });
}

export async function teardown(): Promise<void> {
  if (!checkRailwayCli()) {
    output.fatal("Railway CLI not found.");
  }

  output.log("  Removing Railway deployment...");
  try {
    runRailway(["down"], true);
    output.success("Deployment removed.\n");
  } catch (e: any) {
    output.fatal(`Teardown failed: ${e.message}`);
  }
}

export async function env(): Promise<void> {
  if (!checkRailwayCli()) {
    output.fatal("Railway CLI not found.");
  }

  ensureService();

  try {
    const result = runRailway(["variable", "list"]);
    output.heading("Railway Environment Variables");
    output.log(result || "  No variables set.");
    output.log("");
  } catch (e: any) {
    output.fatal(`Failed to list env vars: ${e.message}`);
  }
}

export async function envSet(keyValue: string): Promise<void> {
  if (!keyValue || !keyValue.includes("=")) {
    output.fatal("Usage: acp serve deploy railway env set KEY=value");
  }

  ensureService();

  try {
    runRailway(["variable", "set", keyValue]);
    output.success(`Variable set: ${keyValue.split("=")[0]}. Redeploy to apply.`);
  } catch (e: any) {
    // The error message repeats the command line, value included
    const value = keyValue.slice(keyValue.indexOf("=") + 1);
    output.fatal(`Failed to set variable: ${redact(e.message, value)}`);
  }
}

export async function envDelete(key: string): Promise<void> {
  if (!key) {
    output.fatal("Usage: acp serve deploy railway env delete KEY");
  }

  ensureService();

  try {
    runRailway(["variable", "delete", key]);
    output.success(`Variable deleted: ${key}. Redeploy to apply.`);
  } catch (e: any) {
    output.fatal(`Failed to delete variable: ${e.message}`);
  }
}
