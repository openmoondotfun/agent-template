import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  ROOT,
  LOGS_DIR,
  readConfig,
  findSellerPid,
  writePidToConfig,
  removePidFromConfig,
  listAgentNames,
  type AgentEntry,
} from "../lib/config";
import { log, success, error, warn, field, heading } from "../lib/output";
import { getProgram } from "../lib/program";
import { syncDescription } from "./sell";

function loadAgentKeypair(raw: string): Keypair {
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(trimmed)));
  }

  const resolved = path.isAbsolute(trimmed)
    ? trimmed
    : path.resolve(ROOT, trimmed);
  const secretKey = JSON.parse(fs.readFileSync(resolved, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(secretKey));
}

async function warnIfProviderMismatch(agentName: string, agent: AgentEntry): Promise<void> {
  if (!agent.address || !agent.wallet) return;

  let localProvider: string;
  try {
    localProvider = loadAgentKeypair(agent.wallet).publicKey.toBase58();
  } catch (e: any) {
    warn(`${agentName}: could not read local provider key: ${e.message || e}`);
    return;
  }

  try {
    const agentAccount = await (getProgram().account as any).agent.fetch(
      new PublicKey(agent.address),
    );
    const onchainProvider =
      typeof agentAccount.provider?.toBase58 === "function"
        ? agentAccount.provider.toBase58()
        : String(agentAccount.provider);

    if (onchainProvider === localProvider) return;

    warn(`${agentName}: provider key does not match the on-chain agent provider.`);
    field("  Local provider", localProvider);
    field("  On-chain provider", onchainProvider);
    log("  In the app, open the agent's Settings, paste the local provider address into Provider Wallet under General, and save.");
  } catch (e: any) {
    warn(`${agentName}: could not verify on-chain provider: ${e.message || e}`);
  }
}

async function startAgent(agentName: string): Promise<boolean> {
  const existing = findSellerPid(agentName);
  if (existing) {
    warn(`${agentName}: already running (PID ${existing})`);
    return false;
  }

  const cfg = readConfig();
  const agent = cfg.agents?.[agentName];
  if (!agent) {
    error(`${agentName}: not found in config`);
    return false;
  }

  await warnIfProviderMismatch(agentName, agent);

  if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });

  const logFile = path.join(LOGS_DIR, `seller-${agentName}.log`);
  const out = fs.openSync(logFile, "a");
  const err_ = fs.openSync(logFile, "a");

  const sellerScript = path.join(ROOT, "src", "seller", "runtime", "seller.ts");

  // Pass agent config via env so the seller process uses the right wallet/dir/mint
  const child = spawn("npx", ["tsx", sellerScript], {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", out, err_],
    env: {
      ...process.env,
      WALLET_KEY: agent.wallet,
      AGENT_DIR: agent.dir,
      AGENT_ADDRESS: agent.address || "",
      _ACP_AGENT_NAME: agentName,
    },
  });

  if (child.pid) {
    writePidToConfig(child.pid, agentName);
    child.unref();
    success(`${agentName}: started (PID ${child.pid})`);
    field("  Logs", logFile);
    return true;
  } else {
    error(`${agentName}: failed to start`);
    return false;
  }
}

export async function start(all = false) {
  if (all) {
    const agents = listAgentNames();
    if (agents.length === 0) {
      error("No agents configured");
      return;
    }

    heading("Starting all agents");
    for (const name of agents) {
      await startAgent(name);
    }

    // Sync descriptions for all
    // (syncDescription uses active agent, so we skip here — each seller logs on its own)
    return;
  }

  // Single agent (active)
  const cfg = readConfig();
  const agentName = cfg.activeAgent;
  if (!agentName) {
    error("No active agent. Run `acp setup` first.");
    return;
  }

  await startAgent(agentName);
  await syncDescription();
}

export function stop(all = false) {
  if (all) {
    const agents = listAgentNames();
    heading("Stopping all agents");
    for (const name of agents) {
      const pid = findSellerPid(name);
      if (!pid) {
        log(`  ${name}: not running`);
        continue;
      }
      try {
        process.kill(pid, "SIGTERM");
        removePidFromConfig(name);
        success(`${name}: stopped (PID ${pid})`);
      } catch (e: any) {
        error(`${name}: failed to stop: ${e.message}`);
        removePidFromConfig(name);
      }
    }
    return;
  }

  const pid = findSellerPid();
  if (!pid) {
    warn("Seller is not running");
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
    removePidFromConfig();
    success(`Seller stopped (PID ${pid})`);
  } catch (e: any) {
    error(`Failed to stop seller: ${e.message}`);
    removePidFromConfig();
  }
}

export function status(all = false) {
  if (all) {
    heading("All Agents Status");
    for (const name of listAgentNames()) {
      const pid = findSellerPid(name);
      if (pid) {
        log(`  ${name}: Running (PID ${pid})`);
      } else {
        log(`  ${name}: Stopped`);
      }
    }
    return;
  }

  const pid = findSellerPid();
  heading("Seller Status");
  if (pid) {
    field("Status", "Running");
    field("PID", pid);
  } else {
    field("Status", "Stopped");
  }
}

export function logs(follow = false, filter?: string, agentName?: string) {
  const name = agentName || readConfig().activeAgent || "default";
  const logFile = path.join(LOGS_DIR, `seller-${name}.log`);

  // Fallback to old log file
  const file = fs.existsSync(logFile) ? logFile : path.join(LOGS_DIR, "seller.log");
  if (!fs.existsSync(file)) {
    warn("No logs found");
    return;
  }

  const args = follow ? ["-f", file] : ["-100", file];

  const child = spawn("tail", args, { stdio: "pipe" });

  child.stdout.on("data", (data: Buffer) => {
    const lines = data.toString().split("\n");
    for (const line of lines) {
      if (filter && !line.includes(filter)) continue;
      if (line.trim()) console.log(line);
    }
  });

  child.on("close", () => {});
}
