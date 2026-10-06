// =============================================================================
// acp setup  — Interactive setup (configure everything into config.json)
// acp whoami — Show current agent info
// =============================================================================

import readline from "readline";
import * as output from "../lib/output";
import {
  readConfig,
  writeConfig,
  getActiveAgent,
  getRpcUrl,
  getApiUrl,
  getChatUrl,
  getAgentAddress,
  getAgentDir,
} from "../lib/config";

function question(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => rl.question(prompt, resolve));
}

export async function setup(): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    output.heading("ACP Setup");

    const config = readConfig();

    // Step 1: Global settings
    output.log("\n  Step 1: Global settings\n");

    const currentRpc = config.rpc || getRpcUrl();
    output.log(`  Current RPC: ${currentRpc}`);
    const rpc = (await question(rl, "  RPC URL (Enter to keep): ")).trim();
    if (rpc) config.rpc = rpc;

    const currentApi = config.apiUrl || getApiUrl();
    output.log(`  Current API URL: ${currentApi}`);
    const apiUrl = (await question(rl, "  API URL (Enter to keep): ")).trim();
    if (apiUrl) config.apiUrl = apiUrl;

    const currentChat = config.chatUrl || getChatUrl();
    output.log(`  Current Chat URL: ${currentChat}`);
    const chatUrl = (await question(rl, "  Chat URL (Enter to keep): ")).trim();
    if (chatUrl) config.chatUrl = chatUrl;

    // Step 2: Anthropic
    output.log("\n  Step 2: Anthropic API\n");
    const currentKey = config.anthropicApiKey ? "(configured)" : "(not set)";
    output.log(`  Anthropic API Key: ${currentKey}`);
    const anthKey = (await question(rl, "  Anthropic API Key (Enter to keep): ")).trim();
    if (anthKey) config.anthropicApiKey = anthKey;

    // Step 3: Create or select agent
    output.log("\n  Step 3: Agent configuration\n");

    if (!config.agents) config.agents = {};
    const agentNames = Object.keys(config.agents);

    if (agentNames.length > 0) {
      output.log(`  Existing agents: ${agentNames.join(", ")}`);
      if (config.activeAgent) output.log(`  Active: ${config.activeAgent}`);
    }

    const agentName = (await question(rl, "  Agent name (new or existing, Enter to skip): ")).trim();

    if (agentName) {
      if (!config.agents[agentName]) {
        // New agent
        const wallet = (await question(rl, "  Wallet keypair (JSON array or path): ")).trim();
        const address = (await question(rl, "  Agent address (PDA): ")).trim();
        const mint = (await question(rl, "  Agent token mint (Enter to skip): ")).trim();
        const dir = (await question(rl, `  Offerings directory [${agentName}]: `)).trim() || agentName;

        config.agents[agentName] = { wallet, address, mint, dir };
        output.success(`Agent "${agentName}" created.`);
      } else {
        output.log(`  Agent "${agentName}" already exists. Activating.`);
      }
      config.activeAgent = agentName;
    }

    writeConfig(config);
    output.success("\nSetup complete. Config saved to config.json.");
    output.log("  Run `acp whoami` to verify, `acp --help` for commands.\n");
  } finally {
    rl.close();
  }
}

export async function whoami(): Promise<void> {
  const agent = getActiveAgent();

  let wallet = "(not configured)";
  if (agent?.wallet) {
    try {
      const { getKeypair } = await import("../lib/program");
      wallet = getKeypair().publicKey.toBase58();
    } catch {
      wallet = agent.wallet.startsWith("[") ? "(inline key — load error)" : agent.wallet;
    }
  }

  const info = {
    name: agent?.name || "(no active agent)",
    wallet,
    // The address the sell and profile commands act on (AGENT_ADDRESS wins).
    address: getAgentAddress() || "(not set)",
    mint: agent?.mint || "(not set)",
    dir: agent?.dir || getAgentDir(),
    apiUrl: getApiUrl(),
    rpc: getRpcUrl(),
    chatUrl: getChatUrl(),
  };

  output.output(info, (d) => {
    output.heading("Agent Profile");
    output.field("Name", d.name);
    output.field("Wallet", d.wallet);
    output.field("Address", d.address);
    output.field("Mint", d.mint);
    output.field("Dir", d.dir);
    output.field("API URL", d.apiUrl);
    output.field("RPC", d.rpc);
    output.field("Chat URL", d.chatUrl);
    output.log("");
  });
}
