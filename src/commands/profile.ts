// =============================================================================
// acp profile show    — Show agent profile
// acp profile update  — Update agent info
// =============================================================================

import type { Keypair } from "@solana/web3.js";
import * as output from "../lib/output";
import { readConfig, writeConfig, getActiveAgent, getAgentAddress } from "../lib/config";
import { getKeypair } from "../lib/program";
import { getClient, signedWalletFields, agentUpdateSigner } from "../lib/client";

export async function show(): Promise<void> {
  const agent = getActiveAgent();
  // The address the sell and profile commands act on (AGENT_ADDRESS wins).
  const address = getAgentAddress();

  let wallet = "(not configured)";
  try {
    wallet = getKeypair().publicKey.toBase58();
  } catch (e) { output.debug("profile: could not load the wallet key", e); }

  // Enrich from the indexer when there is an agent to look up
  let agentData: any = null;
  if (address) {
    try {
      const { data } = await getClient().get(`/acp/agent/${address}`);
      agentData = data;
    } catch (e) { output.debug(`profile: agent lookup (${address})`, e); }
  }

  const info = {
    name: agent?.name || "(not set)",
    wallet,
    address: address || "(not set)",
    mint: agent?.mint || "(not set)",
    dir: agent?.dir || "default",
    description: agentData?.description || "(none)",
    offerings: agentData?.offerings || [],
  };

  output.output(info, (data) => {
    output.heading("Agent Profile");
    output.field("Name", data.name);
    output.field("Wallet", data.wallet);
    output.field("Address", data.address);
    output.field("Mint", data.mint);
    output.field("Dir", data.dir);
    output.field("Description", data.description);
    if (data.offerings?.length > 0) {
      output.log("\n  Offerings:");
      for (const o of data.offerings) {
        output.log(`    - ${o.name}  fee: ${o.fee} (${o.feeType})`);
      }
    }
    output.log("");
  });
}

export async function update(key: string, value: string): Promise<void> {
  const localKeys = ["name", "mint", "dir", "wallet"];
  const apiKeys = ["description"];
  const supportedKeys = [...localKeys, ...apiKeys];

  if (!key?.trim() || !value?.trim()) {
    output.fatal(
      `Usage: acp profile update <key> <value>\n  Supported keys: ${supportedKeys.join(", ")}`
    );
  }

  if (!supportedKeys.includes(key)) {
    output.fatal(`Invalid key: ${key}. Supported keys: ${supportedKeys.join(", ")}`);
  }

  // API-side fields (stored in indexer DB)
  if (apiKeys.includes(key)) {
    const address = getAgentAddress();
    if (!address) return output.fatal("No agent address. Run `acp agent create` or `acp agent import` first.");

    let signer: Keypair;
    try {
      signer = agentUpdateSigner();
    } catch {
      return output.fatal("Wallet not configured. Run `acp setup` first.");
    }

    try {
      await getClient().put(`/acp/agent/${address}`, {
        [key]: value,
        ...signedWalletFields(signer),
      });
    } catch (e: any) {
      return output.fatal(`Failed to update ${key}: ${e.message || e}`);
    }

    output.output({ updated: key, value }, () => {
      output.heading("Profile Updated");
      output.log(`  ${key} set to: "${value}"\n`);
    });
    return;
  }

  // Local config fields
  const config = readConfig();
  const agentName = config.activeAgent;

  if (!agentName || !config.agents?.[agentName]) {
    output.fatal("No active agent. Run `acp setup` or `acp agent create` first.");
  }

  if (key === "name") {
    const agent = config.agents![agentName];
    delete config.agents![agentName];
    config.agents![value] = agent;
    config.activeAgent = value;
  } else {
    (config.agents![agentName] as any)[key] = value;
  }

  writeConfig(config);

  output.output({ updated: key, value }, () => {
    output.heading("Profile Updated");
    output.log(`  ${key} set to: "${value}"\n`);
  });
}
