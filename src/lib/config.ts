import fs from "fs";
import path from "path";
export const ROOT = process.cwd();
export const CONFIG_JSON_PATH = path.resolve(ROOT, "config.json");
export const LOGS_DIR = path.resolve(ROOT, "logs");

// ─── Types ──────────────────────────────────────────────────────

export interface AgentEntry {
  // The agent's PROVIDER keypair (JSON array of secret key bytes or a path to a
  // keypair file). `acp agent create` and `acp agent import` generate it and store
  // it here. The seller signs with it: `acp serve start` and `acp serve deploy
  // railway` pass it to the seller as WALLET_KEY. The creator key lives in .env
  // (WALLET_KEY) and is not stored here.
  wallet: string;
  address: string;      // Agent PDA address on-chain (always set after create)
  mint: string;         // Agent token mint (empty until token launch)
  dir: string;          // Offerings directory name
}

export interface ConfigJson {
  // Global settings
  rpc?: string;
  apiUrl?: string;
  chatUrl?: string;
  anthropicApiKey?: string;
  anthropicModel?: string;
  pollInterval?: number;

  // Runtime state
  sellerPid?: number;

  // Agent management
  activeAgent?: string;                    // name of active agent
  agents?: Record<string, AgentEntry>;     // name → agent config
}

// ─── Read / Write ───────────────────────────────────────────────

export function readConfig(): ConfigJson {
  if (!fs.existsSync(CONFIG_JSON_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(CONFIG_JSON_PATH, "utf-8"));
  } catch {
    return {};
  }
}

export function writeConfig(cfg: ConfigJson): void {
  fs.writeFileSync(CONFIG_JSON_PATH, JSON.stringify(cfg, null, 2) + "\n");
}

// ─── Active agent helpers ───────────────────────────────────────

/** Get the active agent entry, or null */
export function getActiveAgent(): { name: string } & AgentEntry | null {
  const cfg = readConfig();
  const name = cfg.activeAgent;
  if (!name || !cfg.agents?.[name]) return null;
  return { name, ...cfg.agents[name] };
}

/**
 * Returns the key the current process signs with.
 *
 * Priority:
 *   1. WALLET_KEY (the creator key in .env for the CLI; the provider key in a
 *      seller started by `acp serve start` or deployed to Railway)
 *   2. PROVIDER_WALLET (provider key for a seller started without WALLET_KEY)
 *   3. config.json agents[active].wallet (the provider key)
 */
export function getWalletKey(): string | undefined {
  if (process.env.WALLET_KEY) return process.env.WALLET_KEY;
  if (process.env.PROVIDER_WALLET) return process.env.PROVIDER_WALLET;
  const agent = getActiveAgent();
  return agent?.wallet;
}

/** Get agent PDA address. Env overrides config — a hosted seller gets its
 *  agent from env since config.json (which holds the key) stays local. */
export function getAgentAddress(): string {
  if (process.env.AGENT_ADDRESS) return process.env.AGENT_ADDRESS;
  const agent = getActiveAgent();
  return agent?.address || "";
}

/** Get agent token mint. Empty until token is launched. */
export function getAgentMint(): string {
  const agent = getActiveAgent();
  return agent?.mint || "";
}

/** Get agent offerings directory name. Env overrides config. */
export function getAgentDir(): string {
  if (process.env.AGENT_DIR) return process.env.AGENT_DIR;
  const agent = getActiveAgent();
  return agent?.dir || "default";
}

// ─── Global settings helpers ────────────────────────────────────

export function getRpcUrl(): string {
  const cfg = readConfig();
  return process.env.RPC_URL || process.env.RPC || cfg.rpc || "http://127.0.0.1:8899";
}

export function getApiUrl(): string {
  const cfg = readConfig();
  return process.env.ACP_API_URL || cfg.apiUrl || "http://localhost:3001";
}

export function getChatUrl(): string {
  const cfg = readConfig();
  return process.env.CHAT_URL || cfg.chatUrl || "http://localhost:3001";
}

export function getAnthropicApiKey(): string {
  const cfg = readConfig();
  return process.env.ANTHROPIC_API_KEY || cfg.anthropicApiKey || "";
}

export function getAnthropicModel(): string {
  const cfg = readConfig();
  return process.env.ANTHROPIC_MODEL || cfg.anthropicModel || "claude-sonnet-4-6";
}

export function getPollInterval(): number {
  const cfg = readConfig();
  return Number(process.env.POLL_INTERVAL) || cfg.pollInterval || 5000;
}

/** How long a stopping seller (SIGTERM/SIGINT) waits for jobs in progress
 *  before it exits, in ms. */
export function getShutdownGraceMs(): number {
  return Number(process.env.SHUTDOWN_GRACE_MS) || 30_000;
}

/** Platform evaluator — the wallet the app names on every job it creates. */
export const PLATFORM_EVALUATOR = "evaVTMB8XGagwDBeGxfi9G4zRxV458WrBAmi5DYXvuY";

/** Evaluators the seller will work under (TRUSTED_EVALUATORS, comma-separated
 *  base58). The evaluator decides whether a Deliverable is paid or refunded,
 *  so the client must not get to pick it. */
export function getTrustedEvaluators(): string[] {
  const raw = process.env.TRUSTED_EVALUATORS || PLATFORM_EVALUATOR;
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

// ─── Seller PID ─────────────────────────────────────────────────

export function findSellerPid(agentName?: string): number | null {
  const cfg = readConfig();
  const name = agentName || cfg.activeAgent;

  // Check per-agent PID first
  if (name && cfg.agents?.[name]) {
    const pid = (cfg.agents[name] as any).sellerPid;
    if (pid) {
      try { process.kill(pid, 0); return pid; } catch { return null; }
    }
  }

  // Fallback to global PID (legacy)
  if (!cfg.sellerPid) return null;
  try { process.kill(cfg.sellerPid, 0); return cfg.sellerPid; } catch { return null; }
}

export function writePidToConfig(pid: number, agentName?: string): void {
  const cfg = readConfig();
  const name = agentName || cfg.activeAgent;
  if (name && cfg.agents?.[name]) {
    (cfg.agents[name] as any).sellerPid = pid;
  } else {
    cfg.sellerPid = pid;
  }
  writeConfig(cfg);
}

export function removePidFromConfig(agentName?: string): void {
  const cfg = readConfig();
  const name = agentName || cfg.activeAgent;
  if (name && cfg.agents?.[name]) {
    delete (cfg.agents[name] as any).sellerPid;
  }
  delete cfg.sellerPid;
  writeConfig(cfg);
}

/** Get all agent names from config */
export function listAgentNames(): string[] {
  const cfg = readConfig();
  return Object.keys(cfg.agents || {});
}

// ─── Misc ───────────────────────────────────────────────────────

export function formatPrice(price: number, feeType?: string): string {
  if (feeType === "percentage") return `${(price * 100).toFixed(1)}%`;
  return `${price} USDC`;
}
