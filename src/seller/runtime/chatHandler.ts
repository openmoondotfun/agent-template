import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";
import path from "path";
import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { listOfferings, listResources, loadOffering, LoadedOffering, ResourceConfig } from "./offerings";
import type { ValidationResult } from "./offeringTypes";
import { DEFAULT_SYSTEM_PROMPT } from "./defaultSystemPrompt";
import { getRpcUrl, getAgentDir, getAnthropicModel, getAnthropicApiKey } from "../../lib/config";

const RPC_URL = getRpcUrl();
const AGENT_DIR = getAgentDir();
const MODEL = getAnthropicModel();

let anthropic: Anthropic | null = null;

/** Side-channel tools: the model calls them as if they were normal tools,
 *  but their "result" is just an ack — the real effect is a signal to the
 *  seller runtime (e.g. set chat title). They never surface as tool chips
 *  in the UI; the chat handler intercepts them before they reach `blocks`. */
const SIDE_CHANNEL_TOOL_NAMES = new Set(["set_title"]);

function getClient(): Anthropic {
  if (!anthropic) {
    const apiKey = getAnthropicApiKey();
    if (!apiKey) {
      throw new Error("Anthropic API key not set. Add anthropicApiKey to config.json or set ANTHROPIC_API_KEY env var.");
    }
    anthropic = new Anthropic({ apiKey });
  }
  return anthropic;
}

let warnedDefaultPrompt = false;

/** The chat prompt: src/seller/offerings/<AGENT_DIR>/system_prompt.txt, else
 *  src/seller/offerings/default/system_prompt.txt, else the built-in
 *  DEFAULT_SYSTEM_PROMPT. Read on every call, so edits apply without a restart. */
function loadSystemPrompt(): string {
  for (const dir of [AGENT_DIR, "default"]) {
    const promptPath = path.join(__dirname, "..", "offerings", dir, "system_prompt.txt");
    try {
      const text = fs.readFileSync(promptPath, "utf-8").trim();
      if (text) return text;
    } catch {
      // Not there; try the next location.
    }
  }
  if (!warnedDefaultPrompt) {
    warnedDefaultPrompt = true;
    console.warn(`[chat] No system_prompt.txt (or an empty one) in src/seller/offerings/${AGENT_DIR}/ — using the built-in default prompt`);
  }
  return DEFAULT_SYSTEM_PROMPT;
}

/** Build tools dynamically from local offering.json files and resources */
function buildToolsFromOfferings(): {
  tools: Anthropic.Tool[];
  resourceMap: Map<string, ResourceConfig>;
  offeringConfigs: Map<string, any>;
  offeringDirs: Map<string, string>;
} {
  const tools: Anthropic.Tool[] = [
    {
      name: "check_balance",
      description: "Check the user's wallet balances (SOL and USDC) on Solana.",
      input_schema: { type: "object" as const, properties: {}, required: [] },
    },
    {
      name: "set_title",
      description:
        "Set or update the conversation title. Call this ONCE on the first turn of a new chat, BEFORE any other tool or prose reply. Keep titles short and specific: 2-6 words, e.g. \"Wallet balance check\", \"Gm - intro\". Never call with an empty string.",
      input_schema: {
        type: "object" as const,
        properties: {
          title: { type: "string" as const, description: "Short chat title, 2-6 words." },
        },
        required: ["title"],
      },
    },
  ];

  // Cache offering.json contents so executeTool can stamp pricing into the
  // pending envelope without re-reading disk on every call.
  const offeringConfigs = new Map<string, any>();
  // Tool name -> offering directory, for loading the offering's handlers.
  const offeringDirs = new Map<string, string>();

  const offeringNames = listOfferings(AGENT_DIR);
  for (const name of offeringNames) {
    try {
      const offeringPath = path.join(__dirname, "..", "offerings", AGENT_DIR, name, "offering.json");
      const config = JSON.parse(fs.readFileSync(offeringPath, "utf-8"));
      const toolName = config.name || name;
      offeringConfigs.set(toolName, config);
      offeringDirs.set(toolName, name);

      const feeNum = config.feeValue ?? config.fee ?? 0;
      const feeStr = config.feeType === "percentage"
        ? `${(feeNum * 100).toFixed(1)}%`
        : `${feeNum} SOL`;

      tools.push({
        name: toolName,
        description: `${config.description || name}. Fee: ${feeStr}`,
        input_schema: config.requirement || {
          type: "object" as const,
          properties: {},
          required: [],
        },
      });
    } catch (e: any) {
      console.warn(`[chat] Failed to load offering "${name}" for tools: ${e.message}`);
    }
  }

  // Add resources as free, instantly-executed tools
  const resourceMap = new Map<string, ResourceConfig>();
  const resources = listResources();
  for (const r of resources) {
    const toolName = `resource_${r.name}`;
    resourceMap.set(toolName, r);
    tools.push({
      name: toolName,
      description: `[Free Resource] ${r.description}. Returns data instantly, no payment required.`,
      input_schema: {
        type: "object" as const,
        properties: {
          params: {
            type: "object" as const,
            description: "Optional query parameters to pass to the resource endpoint",
          },
        },
        required: [],
      },
    });
  }

  return { tools, resourceMap, offeringConfigs, offeringDirs };
}

const {
  tools: TOOLS,
  resourceMap: RESOURCE_MAP,
  offeringConfigs: OFFERING_CONFIGS,
  offeringDirs: OFFERING_DIRS,
} = buildToolsFromOfferings();

/**
 * Run the offering's own validateRequirements on the model's tool input
 * before a job is proposed. Returns the rejection reason, or null when the
 * input passes or the offering has no validator. The seller validates again
 * when the job request arrives; this only keeps the user from paying for a
 * job the seller would reject. Fails closed: if the validator can't run, no
 * job is proposed.
 */
async function chatRejection(toolName: string, input: Record<string, any>): Promise<string | null> {
  const dir = OFFERING_DIRS.get(toolName);
  if (!dir) return null;
  let loaded: LoadedOffering;
  try {
    loaded = await loadOffering(dir, AGENT_DIR);
  } catch (e: any) {
    // The seller can't load it either; don't show server paths to the user.
    console.error(`[chat] Could not load offering ${toolName}: ${e.message}`);
    return "This service is unavailable right now";
  }
  const { config, handlers } = loaded;
  if (typeof handlers.validateRequirements !== "function") return null;
  try {
    const result: ValidationResult = await handlers.validateRequirements({
      ...input,
      offering: toolName,
      _offeringConfig: config,
    });
    if (result === true || (typeof result === "object" && result !== null && result.valid)) return null;
    return (typeof result === "object" && result?.reason) || "The request doesn't meet this offering's requirements";
  } catch (e: any) {
    console.error(`[chat] Could not validate ${toolName}: ${e.message}`);
    return `Could not validate the request: ${e.message}`;
  }
}

interface ChatMessage {
  role: "user" | "agent";
  content: string;
}

/** USDC mint on Solana (devnet and mainnet share the same address) */
const USDC_MINTS = [
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // mainnet
  "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", // devnet
];

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

/** Reject with a clear error if the inner promise hasn't settled within `ms`. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}

async function fetchWalletBalances(walletAddress: string): Promise<Record<string, any>> {
  const connection = new Connection(RPC_URL, "confirmed");
  const pubkey = new PublicKey(walletAddress);

  // SOL balance — web3.js has no built-in per-call timeout, so guard manually
  // to prevent a slow RPC from wedging the chat handler.
  const solBalance = await withTimeout(connection.getBalance(pubkey), 10_000, "getBalance");
  const solAmount = solBalance / LAMPORTS_PER_SOL;

  // Token accounts
  const tokenAccounts = await withTimeout(
    connection.getParsedTokenAccountsByOwner(pubkey, { programId: TOKEN_PROGRAM_ID }),
    15_000,
    "getParsedTokenAccountsByOwner"
  );

  const tokens: { symbol: string; mint: string; balance: number; decimals: number }[] = [];

  for (const { account } of tokenAccounts.value) {
    const parsed = account.data.parsed?.info;
    if (!parsed) continue;
    const mint = parsed.mint as string;
    const balance = parsed.tokenAmount?.uiAmount ?? 0;
    const decimals = parsed.tokenAmount?.decimals ?? 0;

    if (balance === 0) continue;

    const isUsdc = USDC_MINTS.includes(mint);
    tokens.push({
      symbol: isUsdc ? "USDC" : mint.slice(0, 8) + "...",
      mint,
      balance,
      decimals,
    });
  }

  return {
    wallet: walletAddress,
    network: "solana",
    sol: { balance: solAmount, symbol: "SOL" },
    tokens,
  };
}

/** Execute a tool call — returns structured result for Claude */
async function executeTool(
  name: string,
  input: Record<string, any>,
  userWallet: string | null
): Promise<Record<string, any>> {
  console.log(`[chat] Tool call: ${name}`, JSON.stringify(input));

  // Built-in: check_balance
  if (name === "check_balance") {
    if (!userWallet) {
      return { error: "User wallet address not available. Ask the user to connect their wallet." };
    }
    try {
      return await fetchWalletBalances(userWallet);
    } catch (e: any) {
      console.error("[chat] Balance check failed:", e.message);
      return { error: `Failed to fetch balance: ${e.message}` };
    }
  }

  // Resource tools — execute immediately via HTTP GET
  const resource = RESOURCE_MAP.get(name);
  if (resource) {
    try {
      const { default: axios } = await import("axios");
      const params = input.params && typeof input.params === "object" ? input.params : undefined;
      const resp = await axios.get(resource.url, { params, timeout: 15_000 });
      return { status: "resource_result", resource: resource.name, data: resp.data };
    } catch (e: any) {
      console.error(`[chat] Resource query failed for ${resource.name}:`, e.message);
      return { error: `Resource query failed: ${e.message}` };
    }
  }

  // Check the input with the offering's validateRequirements first. The error
  // result carries no `offering` key, so the tool-use loop goes on and the
  // model can ask the user to fix the request instead of proposing a job.
  const rejection = await chatRejection(name, input);
  if (rejection) return { error: rejection };

  // All other tools map to offerings — return as pending job for the frontend.
  // Include pricing metadata so the UI can show the real budget breakdown.
  const cfg = OFFERING_CONFIGS.get(name);
  const pricing: Record<string, any> = {};
  if (cfg) {
    if (typeof cfg.fee === "number" || typeof cfg.feeValue === "number") {
      pricing.fee = cfg.feeValue ?? cfg.fee;
    }
    if (typeof cfg.feeType === "string") pricing.feeType = cfg.feeType;
    if (typeof cfg.budgetReserve === "number") pricing.budgetReserve = cfg.budgetReserve;
    if (typeof cfg.slaMinutes === "number") pricing.slaMinutes = cfg.slaMinutes;
  }

  return {
    status: "pending",
    offering: name,
    ...input,
    ...pricing,
    message: `Executing ${name}`,
  };
}

/**
 * Handle an incoming chat message from a user (forwarded by indexer ChatServer).
 * Returns the agent's text response.
 *
 * `onTitle` is the side-channel sink for the `set_title` tool — invoked
 * synchronously when the model emits a title so the seller can forward it
 * to the indexer via `chat:update_title`.
 */
export async function handleChatMessage(
  conversationId: string,
  agentMint: string,
  userMessage: string,
  history: ChatMessage[],
  userWallet?: string | null,
  onTitle?: (title: string) => void
): Promise<string> {
  const client = getClient();

  // Convert history to Claude format
  const messages: Anthropic.MessageParam[] = history.map((m) => ({
    role: m.role === "user" ? "user" as const : "assistant" as const,
    content: m.content,
  }));

  // Build agent context
  const offerings = listOfferings(AGENT_DIR);
  const resources = listResources();
  let agentContext = `\n\nAvailable offerings: ${offerings.join(", ") || "none"}. Agent address: ${agentMint}`;
  if (resources.length > 0) {
    agentContext += `\nFree resources (use resource_<name> tools): ${resources.map((r) => r.name).join(", ")}`;
  }
  if (userWallet) {
    agentContext += `\nUser wallet: ${userWallet}`;
  }

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: loadSystemPrompt() + agentContext,
      tools: TOOLS,
      messages,
    });

    // Process response — tool-use loop (handles parallel and multi-level tool calls)
    const blocks: { type: string; [key: string]: any }[] = [];
    const MAX_TOOL_LOOPS = 5;
    let currentMessages = [...messages];
    let currentResponse = response;

    for (let loop = 0; loop < MAX_TOOL_LOOPS; loop++) {
      // Collect text and tool_use blocks
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      let hasJobTool = false;

      for (const block of currentResponse.content) {
        if (block.type === "text") {
          blocks.push({ type: "text", content: block.text });
        } else if (block.type === "tool_use") {
          // Side-channel tools (e.g. set_title) are signals to the seller
          // runtime, not user-visible work — ack the model so it continues,
          // fire the callback, and skip the blocks push entirely.
          if (SIDE_CHANNEL_TOOL_NAMES.has(block.name)) {
            if (block.name === "set_title" && onTitle) {
              const raw = (block.input as any)?.title;
              const title = typeof raw === "string" ? raw.trim().slice(0, 80) : "";
              if (title) onTitle(title);
            }
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: JSON.stringify({ ok: true }),
            });
            continue;
          }

          const toolResult = await executeTool(block.name, block.input as Record<string, any>, userWallet || null);
          blocks.push({ type: "tool_call", name: block.name, input: block.input, result: toolResult });

          if (toolResult.offering) hasJobTool = true;

          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: JSON.stringify(toolResult),
          });
        }
      }

      // If no tool use, stop. If ALL tools are ACP job tools (frontend handles them), stop.
      if (currentResponse.stop_reason !== "tool_use" || toolResults.length === 0) break;
      // If any tool is an ACP job tool, we still need to send results back but don't continue the loop
      if (hasJobTool) break;

      // Send ALL tool results back in one message (fixes parallel tool calls)
      try {
        currentMessages = [
          ...currentMessages,
          { role: "assistant" as const, content: currentResponse.content },
          { role: "user" as const, content: toolResults },
        ];

        currentResponse = await client.messages.create({
          model: MODEL,
          max_tokens: 1024,
          system: loadSystemPrompt() + agentContext,
          tools: TOOLS,
          messages: currentMessages,
        });
      } catch (err: any) {
        console.error("[chat] Follow-up error:", err.message);
        break;
      }
    }

    if (blocks.length === 0) {
      return "I'm not sure how to help with that. Could you rephrase?";
    }

    // Return as JSON for structured rendering
    return JSON.stringify(blocks);
  } catch (err: any) {
    console.error("[chat] Claude API error:", err.message);
    return "Sorry, I'm having trouble right now. Please try again.";
  }
}
