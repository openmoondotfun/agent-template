// =============================================================================
// acp agent create <name>   — Create agent on-chain + generate provider keypair
// acp agent import <name>   — Import existing agent (created on frontend)
// acp agent list             — Show all configured agents
// acp agent switch <name>   — Switch active agent
// acp agent claim-fees      — Withdraw the active agent's fee vault (creator)
// =============================================================================

import * as anchor from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL, Transaction } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  createCloseAccountInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import * as output from "../lib/output";
import {
  readConfig,
  writeConfig,
  findSellerPid,
  removePidFromConfig,
  getActiveAgent,
  getApiUrl,
  type AgentEntry,
} from "../lib/config";
import { getProgram, getKeypair, resetCache, loadKeypair } from "../lib/program";
import { getAcpStatePda, getAgentFeeAuthorityPda } from "../lib/pda";
import { getClient } from "../lib/client";

function stopSellerIfRunning(): boolean {
  const pid = findSellerPid();
  if (!pid) return true;
  output.warn(`Seller runtime is running (PID ${pid}). Stopping...`);
  try {
    process.kill(pid, "SIGTERM");
    removePidFromConfig();
    output.success("Seller stopped.");
  } catch {
    output.warn("Could not stop seller. You may need to stop it manually.");
  }
  return true;
}

// ─── list ──────────────────────────────────────────────────

export async function list(): Promise<void> {
  const config = readConfig();
  const agents = config.agents || {};
  const names = Object.keys(agents);

  if (names.length === 0) {
    output.log("  No agents configured. Run `acp agent create <name>` or `acp agent import <name> --address <agent-address>`.\n");
    return;
  }

  const data = names.map((name) => ({
    name,
    ...agents[name],
    active: name === config.activeAgent,
  }));

  output.output(data, (list) => {
    output.heading("Agents");
    for (const a of list) {
      const marker = a.active ? " (active)" : "";
      output.log(`\n  ${a.name}${marker}`);
      output.field("    Address", a.address || "(not set)");
      output.field("    Mint", a.mint || "(not set)");
      output.field("    Dir", a.dir);
      output.field("    Wallet", a.wallet ? "(configured)" : "(not set)");
    }
    output.log("");
  });
}

// ─── switch ────────────────────────────────────────────────

export async function switchAgent(name: string): Promise<void> {
  if (!name) output.fatal("Usage: acp agent switch <name>");

  const config = readConfig();
  const agents = config.agents || {};

  if (!agents[name]) {
    const available = Object.keys(agents).join(", ") || "(none)";
    output.fatal(`Agent "${name}" not found. Available: ${available}`);
  }

  if (config.activeAgent === name) {
    output.log(`  Agent "${name}" is already active.\n`);
    return;
  }

  stopSellerIfRunning();
  resetCache();

  config.activeAgent = name;
  writeConfig(config);

  const agent = agents[name];
  output.output({ switched: true, name, address: agent.address, mint: agent.mint, dir: agent.dir }, () => {
    output.success(`Switched to agent: ${name}`);
    output.field("  Address", agent.address || "(not set)");
    output.field("  Mint", agent.mint || "(not set)");
    output.field("  Dir", agent.dir);
    output.log("");
  });
}

// ─── create ────────────────────────────────────────────────
// Creates a new agent on-chain:
//   1. Generates a provider keypair
//   2. Calls createAgent instruction on ACP program
//   3. Saves provider key + mint to config.json

export async function create(name: string): Promise<void> {
  if (!name) output.fatal("Usage: acp agent create <name>");

  const config = readConfig();
  const agents = config.agents || {};
  if (agents[name]) output.fatal(`Agent "${name}" already exists.`);

  // Need a funded wallet to pay for the transaction
  const creatorKeypair = getKeypair();
  const program = getProgram();

  output.heading("Creating Agent On-Chain");

  const readline = await import("readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string) => new Promise<string>((resolve) => rl.question(q, resolve));

  const symbol = (await ask(`  Symbol [${name.toUpperCase().slice(0, 10)}]: `)).trim() || name.toUpperCase().slice(0, 10);
  const uri = (await ask("  Metadata URI (Enter to auto-generate): ")).trim() || `https://acp.dev/agent/${name}`;
  rl.close();

  output.log(`  Name: ${name}`);
  output.log(`  Symbol: ${symbol}`);
  output.log(`  URI: ${uri}`);
  output.log(`  Creator: ${creatorKeypair.publicKey.toBase58()}`);

  // Generate provider keypair
  const providerKeypair = Keypair.generate();
  output.log(`  Provider: ${providerKeypair.publicKey.toBase58()}`);

  // Read ACP state to get next agent ID
  const acpStatePda = getAcpStatePda();
  const acpState = await (program.account as any).acpState.fetch(acpStatePda);
  const nextAgentId = Number(acpState.agentCounter) + 1;

  // Derive agent PDA
  const [agentPda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), Buffer.alloc(8, (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(nextAgentId)); return b; })())],
    program.programId
  );

  output.log(`  Agent PDA: ${agentPda.toBase58()}`);
  output.log(`  Agent ID: ${nextAgentId}`);
  output.log("\n  Sending transaction...");

  try {
    const tx = await (program.methods as any)
      .createAgent(name, symbol, uri)
      .accounts({
        creator: creatorKeypair.publicKey,
        acpState: acpStatePda,
        agent: agentPda,
        provider: providerKeypair.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([creatorKeypair])
      .rpc();

    output.success(`Agent created on-chain! tx: ${tx}`);

    // Fund provider with SOL so it can sign transactions
    const rl2 = (await import("readline")).createInterface({ input: process.stdin, output: process.stdout });
    const fundInput = await new Promise<string>((resolve) => rl2.question("  How much SOL to fund provider? [0.05]: ", resolve));
    rl2.close();
    const fundAmount = Number(fundInput.trim()) || 0.05;
    output.log(`  Funding provider with ${fundAmount} SOL...`);
    try {
      const connection = program.provider.connection;
      const transferTx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: creatorKeypair.publicKey,
          toPubkey: providerKeypair.publicKey,
          lamports: Math.round(fundAmount * LAMPORTS_PER_SOL),
        })
      );
      const fundSig = await connection.sendTransaction(transferTx, [creatorKeypair]);
      await connection.confirmTransaction(fundSig, "confirmed");
      output.success(`Provider funded: ${fundAmount} SOL (tx: ${fundSig.slice(0, 16)}...)`);
    } catch (e: any) {
      output.warn(`Could not fund provider: ${e.message}. Fund manually: ${providerKeypair.publicKey.toBase58()}`);
    }

    // Save to config
    stopSellerIfRunning();
    resetCache();

    const providerKeyJson = JSON.stringify(Array.from(providerKeypair.secretKey));

    const entry: AgentEntry = {
      wallet: providerKeyJson,
      address: agentPda.toBase58(),
      mint: "",
      dir: name,
    };

    agents[name] = entry;
    config.agents = agents;
    config.activeAgent = name;
    writeConfig(config);

    output.output({
      created: true,
      name,
      agentId: nextAgentId,
      agentAddress: agentPda.toBase58(),
      provider: providerKeypair.publicKey.toBase58(),
      tx,
    }, (d) => {
      output.log(`\n  Agent address: ${d.agentAddress}`);
      output.log(`  Provider wallet: ${d.provider}`);
      output.log(`  Provider key saved to config.json`);
      output.log(`\n  Next: create offerings with \`acp sell init <name>\``);
      output.log("");
    });
  } catch (e: any) {
    output.fatal(`Failed to create agent: ${e.message}`);
  }
}

// ─── import ────────────────────────────────────────────────
// Import an agent created in the app:
//   1. Looks the agent up on the indexer by address or token mint
//   2. Generates a new provider keypair
//   3. Sets it as the agent's provider on-chain (updateAgent, signed by the
//      creator); if that fails, the user sets it in the app

export async function importAgent(name: string, identifier: string): Promise<void> {
  if (!name) output.fatal("Usage: acp agent import <name> --address <agent-address>");
  if (!identifier) {
    output.fatal("--address is required: the agent's address (the last part of its page URL in the app), or its token mint once launched.");
  }

  const config = readConfig();
  const agents = config.agents || {};
  if (agents[name]) output.fatal(`Agent "${name}" already exists.`);

  output.heading("Importing Agent");

  const creatorKeypair = getKeypair();
  const program = getProgram();

  // Generate provider keypair
  const providerKeypair = Keypair.generate();
  output.log(`  Name: ${name}`);
  output.log(`  Agent: ${identifier}`);
  output.log(`  Creator: ${creatorKeypair.publicKey.toBase58()}`);
  output.log(`  Provider: ${providerKeypair.publicKey.toBase58()}`);

  // Fund provider
  const readline = await import("readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const fundInput = await new Promise<string>((resolve) => rl.question("  How much SOL to fund provider? [0.05]: ", resolve));
  rl.close();
  const fundAmount = Number(fundInput.trim()) || 0.05;

  output.log(`  Funding provider with ${fundAmount} SOL...`);
  try {
    const connection = program.provider.connection;
    const transferTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: creatorKeypair.publicKey,
        toPubkey: providerKeypair.publicKey,
        lamports: Math.round(fundAmount * LAMPORTS_PER_SOL),
      })
    );
    const fundSig = await connection.sendTransaction(transferTx, [creatorKeypair]);
    await connection.confirmTransaction(fundSig, "confirmed");
    output.success(`Provider funded: ${fundAmount} SOL`);
  } catch (e: any) {
    output.warn(`Could not fund provider: ${e.message}. Fund manually: ${providerKeypair.publicKey.toBase58()}`);
  }

  // Update provider on-chain via updateAgent instruction
  output.log(`  Updating provider on-chain...`);
  let agentAddress = "";
  let agentMint = "";
  try {
    // The indexer finds the agent by address or by token mint
    const client = getClient();
    const { data: agentData } = await client.get(`/acp/agent/${identifier}`);
    agentAddress = agentData.address;
    agentMint = agentData.mint ?? "";

    if (!agentAddress) throw new Error(`The indexer has no address for agent ${identifier}`);

    const { PublicKey } = await import("@solana/web3.js");
    const agentPda = new PublicKey(agentAddress);

    const tx = await (program.methods as any)
      .updateAgent()
      .accounts({
        authority: creatorKeypair.publicKey,
        agent: agentPda,
        newProvider: providerKeypair.publicKey,
      })
      .signers([creatorKeypair])
      .rpc();

    output.success(`Provider updated on-chain! tx: ${tx.slice(0, 16)}...`);
  } catch (e: any) {
    output.warn(`Could not update provider on-chain: ${e.message}`);
    output.log(`  Update manually on the frontend: set provider to ${providerKeypair.publicKey.toBase58()}`);
  }

  stopSellerIfRunning();
  resetCache();

  const providerKeyJson = JSON.stringify(Array.from(providerKeypair.secretKey));

  const entry: AgentEntry = {
    wallet: providerKeyJson,
    address: agentAddress || identifier,
    mint: agentMint,
    dir: name,
  };

  agents[name] = entry;
  config.agents = agents;
  config.activeAgent = name;
  writeConfig(config);

  output.output({
    imported: true,
    name,
    address: entry.address,
    mint: entry.mint,
    provider: providerKeypair.publicKey.toBase58(),
  }, (d) => {
    output.success("Agent imported!");
    output.log(`  Agent address: ${d.address}`);
    output.log(`  Provider wallet: ${d.provider}`);
    output.log(`  Provider key saved to config.json`);
    output.log(`\n  Next: create offerings with \`acp sell init <name>\``);
    output.log("");
  });
}

// -- Claim fees: withdraw the agent's fee vault --

/** Completed jobs pay the agent's share of their fee into a vault only the
 *  agent's creator can withdraw (claim_agent_fee). The app signs with its
 *  built-in wallet, so for an agent created here — creator = WALLET_KEY — this
 *  is the way to get the fees out. wSOL comes back as SOL. */
export async function claimFees(mintArg?: string): Promise<void> {
  const agent = getActiveAgent();
  if (!agent?.address) {
    output.fatal("No active agent with an address. Run `acp agent create` or `acp agent import` first.");
  }
  const program = getProgram();
  const creator = getKeypair();
  const agentPda = new PublicKey(agent!.address);
  const mint = mintArg ? new PublicKey(mintArg) : NATIVE_MINT;

  const agentAccount = await (program.account as any).agent.fetch(agentPda);
  if (!agentAccount.creator.equals(creator.publicKey)) {
    output.fatal(
      `Only the agent's creator (${agentAccount.creator.toBase58()}) can withdraw its fees; WALLET_KEY is ${creator.publicKey.toBase58()}.`
    );
  }

  const agentFeeAuthority = getAgentFeeAuthorityPda(agentPda);
  const agentFeeVault = getAssociatedTokenAddressSync(mint, agentFeeAuthority, true);
  const vault = await program.provider.connection.getAccountInfo(agentFeeVault);
  const amount = vault ? Buffer.from(vault.data).readBigUInt64LE(64) : 0n;
  if (amount === 0n) {
    output.output({ claimed: "0", mint: mint.toBase58() }, () => output.log("  No fees to claim.\n"));
    return;
  }

  const creatorAta = getAssociatedTokenAddressSync(mint, creator.publicKey);
  const unwrap = mint.equals(NATIVE_MINT)
    ? [createCloseAccountInstruction(creatorAta, creator.publicKey, creator.publicKey)]
    : [];

  const tx = await (program.methods as any)
    .claimAgentFee()
    .accounts({
      creator: creator.publicKey,
      agent: agentPda,
      paymentMint: mint,
      agentFeeAuthority,
      agentFeeVault,
      creatorTokenAccount: creatorAta,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .postInstructions(unwrap)
    .signers([creator])
    .rpc();

  output.output({ claimed: amount.toString(), mint: mint.toBase58(), tx }, (d) => {
    output.success(`Claimed ${d.claimed} base units of ${d.mint}`);
    output.field("TX", d.tx);
  });
}
