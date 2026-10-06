import "dotenv/config";
import { io, Socket } from "socket.io-client";
import axios from "axios";
import nacl from "tweetnacl";
import { loadOffering, listOfferings, listResources, LoadedOffering } from "./offerings";
import { acceptOrRejectJob, createMemo, signMemoById, getJobStatus, claimBudget, claimFee, setBudgetOnChain, getOnChainJob, getOnChainJobFull, isEscrowFunded, hasOnChainMemoFrom } from "./sellerApi";
import { AcpJobPhase, SocketEvent } from "./types";
import { getKeypair } from "../../lib/program";
import { getTokenDecimals, KNOWN_MINTS, resolveTokenMint } from "../../lib/tokens";
import { handleChatMessage } from "./chatHandler";
import type { ValidationResult } from "./offeringTypes";
import { attachSellerSigning } from "./signedAxios";
import { getApiUrl, getChatUrl, getAgentDir, getAgentAddress, getPollInterval, getAnthropicApiKey, getTrustedEvaluators, getShutdownGraceMs } from "../../lib/config";

const API_URL = getApiUrl();
const CHAT_URL = getChatUrl();
const AGENT_DIR = getAgentDir();
const AGENT_ADDRESS = getAgentAddress();
const POLL_INTERVAL = getPollInterval();
const TRUSTED_EVALUATORS = getTrustedEvaluators();
const STARTED_AT = Date.now();

const api = axios.create({ baseURL: API_URL });
attachSellerSigning(api);

/** Track in-flight operations to avoid duplicate processing.
 *  Entries are timestamped so we can evict stale locks. */
const pending = new Map<string, number>();

/** Set on SIGTERM/SIGINT: no new work starts, work in progress finishes. */
let shuttingDown = false;
/** Phase handlers and settlements running right now, which a shutdown waits for. */
let activeWork = 0;

/** Results of executeJob() whose Deliverable memo failed to post (e.g. an RPC
 *  error), by job address. The next poll posts them again instead of running
 *  the handler again. Process memory only: a restart runs the handler again. */
const unpostedDeliverables = new Map<string, string>();

/** Track when we first noticed indexer lag per job, so we can stop waiting after a timeout */
const indexerLagFirstSeen = new Map<string, number>();
const INDEXER_LAG_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes

/** Memo types as the indexer sends them: its REST API gives memoType as a
 *  number (0..4); older indexer builds sent the enum's string value
 *  ("jobRequest", "agreement", ...). Match both. */
const MEMO_TYPE = {
  JobRequest: 0,
  Agreement: 1,
  Transaction: 2,
  Deliverable: 3,
  General: 4,
} as const;

function isMemoType(memo: any, type: keyof typeof MEMO_TYPE): boolean {
  if (!memo) return false;
  const numeric = MEMO_TYPE[type];
  const lower = type.charAt(0).toLowerCase() + type.slice(1);
  return memo.memoType === numeric || memo.memoType === lower || memo.memoType === type;
}

/** True if `wallet` already posted a General memo on the job. A failure in
 *  prepareAgreement() or executeJob() is reported to the client once, as a
 *  General memo, and the job is then left alone: the poller re-enters the
 *  same phase every cycle until the job moves on or expires, and the error
 *  text can change between polls, so this goes by sender, not content. Any
 *  General memo from this wallet counts, including one an operator posts
 *  with `acp job memo` using the provider key. */
function hasOwnGeneralMemo(job: any, wallet: string): boolean {
  return !!job.memos?.some(
    (m: any) => isMemoType(m, "General") && m.sender === wallet
  );
}

/** Returns true if we should skip due to indexer lag, false if timeout expired and we should proceed */
function shouldSkipForIndexerLag(jobAddress: string, dbCount: number, onChainCount: number): boolean {
  if (onChainCount <= dbCount) {
    indexerLagFirstSeen.delete(jobAddress);
    return false;
  }
  const now = Date.now();
  const firstSeen = indexerLagFirstSeen.get(jobAddress);
  if (!firstSeen) {
    indexerLagFirstSeen.set(jobAddress, now);
    return true;
  }
  if (now - firstSeen > INDEXER_LAG_TIMEOUT_MS) {
    console.warn(`[seller] Job ${jobAddress.slice(0, 8)}... — indexer lag persisted for ${Math.round((now - firstSeen) / 1000)}s, proceeding anyway`);
    indexerLagFirstSeen.delete(jobAddress);
    return false;
  }
  return true;
}

function isPending(key: string): boolean {
  const ts = pending.get(key);
  if (!ts) return false;
  // Evict locks older than 5 minutes (stuck/crashed handlers)
  if (Date.now() - ts > 300_000) {
    pending.delete(key);
    return false;
  }
  return true;
}

/** Cache loaded offerings */
const offeringCache = new Map<string, LoadedOffering>();

async function getOffering(name: string): Promise<LoadedOffering | null> {
  if (offeringCache.has(name)) return offeringCache.get(name)!;
  try {
    const offering = await loadOffering(name, AGENT_DIR);
    offeringCache.set(name, offering);
    return offering;
  } catch (e: any) {
    console.warn(`[seller] Failed to load offering "${name}": ${e.message}`);
    return null;
  }
}

/** Try to parse requirements JSON from job's JobRequest memo */
function parseRequirements(job: any): { offeringName: string; request: Record<string, any> } | null {
  const jobRequestMemo = job.memos?.find((m: any) => isMemoType(m, "JobRequest"));
  if (!jobRequestMemo?.content) return null;

  try {
    const parsed = JSON.parse(jobRequestMemo.content);
    const offeringName = parsed.offering || parsed.type || parsed.offeringName;
    if (!offeringName) return null;
    return { offeringName, request: parsed };
  } catch {
    return null;
  }
}

// ─── Job Processing ──────────────────────────────────────────────

/** Map on-chain numeric phase to AcpJobPhase string */
const PHASE_MAP: AcpJobPhase[] = [
  AcpJobPhase.REQUEST,
  AcpJobPhase.NEGOTIATION,
  AcpJobPhase.TRANSACTION,
  AcpJobPhase.EVALUATION,
  AcpJobPhase.COMPLETED,
  AcpJobPhase.REJECTED,
];

async function processJob(jobAddress: string) {
  if (shuttingDown) return;
  const job = await getJobStatus(jobAddress);
  if (!job) return;

  // The indexer's REST API sends the phase as its number.
  let phase = (typeof job.phase === "number" ? PHASE_MAP[job.phase] : job.phase) as AcpJobPhase;

  // Reconcile with on-chain state — indexer may lag behind (missed WS events)
  try {
    const onChain = await getOnChainJob(jobAddress);
    const onChainPhase = PHASE_MAP[onChain.phase];
    if (onChainPhase && onChainPhase !== phase) {
      console.log(`[seller] Job ${jobAddress.slice(0, 8)}... — DB phase="${phase}" != on-chain="${onChainPhase}", using on-chain`);
      phase = onChainPhase;
      job.phase = phase;
    }
    // Store on-chain memo count so handlers can detect stale DB memos
    job._onChainMemoCount = onChain.memoCount;
  } catch (e: any) {
    console.warn(`[seller] Job ${jobAddress.slice(0, 8)}... — failed to check on-chain state: ${e.message}`);
  }

  const key = `${jobAddress}:${phase}`;
  // A shutdown may have started during the lookups above.
  if (shuttingDown || isPending(key)) return;
  // Lock immediately to prevent concurrent processing (TOCTOU fix)
  pending.set(key, Date.now());
  activeWork++;

  try {
    switch (phase) {
      case AcpJobPhase.REQUEST:
        await handleRequest(job, key);
        break;
      case AcpJobPhase.NEGOTIATION:
        await handleNegotiation(job, key);
        break;
      case AcpJobPhase.TRANSACTION:
        await handleTransaction(job, key);
        break;
      case AcpJobPhase.EVALUATION:
        await handleEvaluation(job, key);
        break;
      case AcpJobPhase.COMPLETED:
        await handleCompleted(job, key);
        break;
    }
  } catch (err: any) {
    console.error(`[seller] Job ${jobAddress.slice(0, 8)}... phase=${phase} error: ${err.message}`);
  } finally {
    // Always release lock — if phase advanced, key won't match next poll anyway.
    // If phase didn't change, we want to retry on next poll cycle.
    pending.delete(key);
    activeWork--;
  }
}

/** Why a job for this offering could never be funded, or null when it can.
 *  set_budget needs a budget or a fee above zero, and only requiredFunds
 *  offerings take a budget, which a percentage fee is computed from. */
function unfundableReason(config: any): string | null {
  const fee = Number(config?.feeValue ?? config?.fee ?? 0);
  if (config?.requiredFunds) return null;
  if (config?.feeType === "percentage") {
    return "Offering misconfigured: its fee is a percentage of the budget, but it takes no budget (requiredFunds is off)";
  }
  if (!(fee > 0)) return "Offering misconfigured: no fee and no budget, so there is nothing to escrow";
  return null;
}

/** Resolve offering: try exact name, then fallback to "delegate" if available */
async function resolveOffering(offeringName: string): Promise<{ offering: LoadedOffering; delegated: boolean } | null> {
  const exact = await getOffering(offeringName);
  if (exact) return { offering: exact, delegated: false };

  // Fallback: if we have a "delegate" offering, route unknown offerings through it
  const delegate = await getOffering("delegate");
  if (delegate) {
    console.log(`[seller] Offering "${offeringName}" not found locally, routing through delegate`);
    return { offering: delegate, delegated: true };
  }

  return null;
}

/** Pubkey::default() as job.evaluator — the client evaluates their own job. */
const NO_EVALUATOR = "11111111111111111111111111111111";

async function handleRequest(job: any, key: string) {
  // The evaluator (fixed at create_job) decides whether the Deliverable is
  // paid or refunded. With none, or one the client controls, the client could
  // read the finished work and reject it for a refund — so only take jobs
  // judged by an evaluator we trust. Read from chain, not the indexer.
  const jobAccount = await getOnChainJobFull(job.address);
  const evaluator: string = jobAccount.evaluator.toBase58();
  if (!TRUSTED_EVALUATORS.includes(evaluator)) {
    const reason = evaluator === NO_EVALUATOR
      ? "Untrusted evaluator: none set (client-evaluated job)"
      : `Untrusted evaluator: ${evaluator}`;
    console.log(`[seller] Job ${job.address.slice(0, 8)}... — ${reason}, rejecting`);
    await acceptOrRejectJob(job.address, { accept: false, reason });
    return;
  }

  const parsed = parseRequirements(job);
  if (!parsed) {
    console.log(`[seller] Job ${job.address.slice(0, 8)}... — no parseable requirements, skipping`);
    return;
  }

  const { offeringName, request } = parsed;
  const resolved = await resolveOffering(offeringName);
  if (!resolved) {
    console.log(`[seller] Job ${job.address.slice(0, 8)}... — unknown offering "${offeringName}", rejecting`);
    await acceptOrRejectJob(job.address, { accept: false, reason: `Unknown offering: ${offeringName}` });
    return;
  }

  const { offering, delegated } = resolved;

  // Reject now what can't be escrowed later: the program's set_budget needs a
  // budget or a fee, and the provider has no way to reject once the job is
  // past REQUEST.
  const unfundable = unfundableReason(offering.config);
  if (unfundable) {
    console.log(`[seller] Job ${job.address.slice(0, 8)}... — ${unfundable}, rejecting`);
    await acceptOrRejectJob(job.address, { accept: false, reason: unfundable });
    return;
  }

  // For delegated offerings, inject the original offering name as the task
  const validateRequest = delegated
    ? { ...request, task: request.task || `Execute ${offeringName} service`, offering: offeringName, _offeringConfig: offering.config }
    : { ...request, _offeringConfig: offering.config };

  if (offering.handlers.validateRequirements) {
    let result: ValidationResult;
    try {
      result = await offering.handlers.validateRequirements(validateRequest);
    } catch (e: any) {
      // Left uncaught, this would retry every poll until the job expires.
      result = { valid: false, reason: `Could not validate the request: ${e.message}` };
    }
    const isValid = result === true || (typeof result === "object" && result !== null && result.valid);

    if (!isValid) {
      const reason = (typeof result === "object" && result?.reason) || "Validation failed";
      console.log(`[seller] Job ${job.address.slice(0, 8)}... — validation failed: ${reason}`);
      await acceptOrRejectJob(job.address, { accept: false, reason });
      return;
    }
  }

  const label = delegated ? `delegate(${offeringName})` : offeringName;
  console.log(`[seller] Job ${job.address.slice(0, 8)}... — accepting (offering: ${label})`);
  await acceptOrRejectJob(job.address, { accept: true });
}

async function handleNegotiation(job: any, key: string) {
  // Check if we already created an Agreement memo
  const hasAgreement = job.memos?.some((m: any) => isMemoType(m, "Agreement"));
  if (hasAgreement) return;

  // Already told the client (General memo) that we can't take this job. The
  // program has no provider-side reject in NEGOTIATION: the JobRequest memo
  // can only be signed in REQUEST and the provider can't sign its own
  // Agreement, so the job sits here until it expires. Don't re-run
  // prepareAgreement() or post again: every memo account costs the provider rent.
  const ownWallet = getKeypair().publicKey.toBase58();
  if (hasOwnGeneralMemo(job, ownWallet)) return;

  // If on-chain has more memos than DB knows about, DB is stale — skip to avoid duplicates (with timeout)
  const dbMemoCount = job.memos?.length ?? 0;
  const onChainMemoCount = job._onChainMemoCount ?? dbMemoCount;
  if (shouldSkipForIndexerLag(job.address, dbMemoCount, onChainMemoCount)) {
    console.log(`[seller] Job ${job.address.slice(0, 8)}... — DB has ${dbMemoCount} memos but on-chain has ${onChainMemoCount}, skipping negotiation (indexer lag)`);
    return;
  }

  // Resolve fee and budget from offering + request
  const parsed = parseRequirements(job);
  const offeringName = parsed?.offeringName;
  let feeRate = 0;
  let feeType = "fixed";
  let supportedMints: string[] = [];
  let budgetHuman = 0;
  let resolvedOffering: LoadedOffering | null = null;

  if (offeringName) {
    const resolved = await resolveOffering(offeringName);
    if (resolved) {
      resolvedOffering = resolved.offering;
      const config = resolved.offering.config;
      feeRate = config?.feeValue ?? config?.fee ?? 0;
      feeType = config?.feeType ?? "fixed";
      supportedMints = config?.supportedMints ?? [];
    }
  }

  // Default budget = requested amount from job request (human-readable units).
  // Offerings can override it in prepareAgreement() before lamport conversion.
  // Only offerings that spend the client's funds (requiredFunds) escrow a
  // budget: the evaluator wants a transaction tied to the job for any budget,
  // and read-only work has none to show.
  if (parsed?.request && resolvedOffering?.config.requiredFunds) {
    budgetHuman = parsed.request.amount ?? 0;
  }

  // Get payment mint decimals from on-chain job to convert correctly
  const jobAccount = await getOnChainJobFull(job.address);
  const paymentMint: string = jobAccount.paymentMint.toBase58();
  const decimals = await getTokenDecimals(paymentMint);
  const factor = 10 ** decimals;

  // Reverse lookup: mint address → symbol (e.g. "SOL", "USDC")
  const mintToSymbol = Object.entries(KNOWN_MINTS).find(([, addr]) => addr === paymentMint);
  const paymentSymbol = mintToSymbol ? mintToSymbol[0] : paymentMint.slice(0, 8) + "…";

  // Resolve output mint from job request for the agreement
  const toToken = parsed?.request?.toSymbol || parsed?.request?.toContractAddress;
  const outputMintAddress = toToken ? resolveTokenMint(toToken) : undefined;
  const outputSymbolEntry = outputMintAddress ? Object.entries(KNOWN_MINTS).find(([, addr]) => addr === outputMintAddress) : undefined;
  const outputSymbol = outputSymbolEntry ? outputSymbolEntry[0] : undefined;

  let agreementMessage = "Accepting the job. Terms agreed.";
  let extraAgreement: Record<string, any> = {};
  if (resolvedOffering?.handlers.prepareAgreement) {
    try {
      const prep = await resolvedOffering.handlers.prepareAgreement({
        ...(parsed?.request ?? {}),
        jobAddress: job.address,
        clientWallet: jobAccount.client.toBase58(),
        paymentMint,
        paymentDecimals: decimals,
        budget: budgetHuman,
      });
      if (prep?.extraMessage) agreementMessage = prep.extraMessage;
      if (prep?.extra) extraAgreement = prep.extra;
      if (typeof prep?.budgetOverride === "number") budgetHuman = prep.budgetOverride;
    } catch (e: any) {
      console.error(`[seller] Job ${job.address.slice(0, 8)}... — prepareAgreement failed: ${e.message}`);
      if (hasOwnGeneralMemo(job, ownWallet)) return;
      // Don't post a broken Agreement; tell the client why. No money has moved:
      // the client can only deposit once the job reaches TRANSACTION.
      try {
        await createMemo(job.address, "general", JSON.stringify({ error: e.message }));
      } catch (memoErr: any) {
        console.error(`[seller] Job ${job.address.slice(0, 8)}... — failed to post rejection memo: ${memoErr.message}`);
      }
      return;
    }
  }

  // Platform fee is computed after prepareAgreement(), so percentage fees see
  // the final budget when the offering overrides it. A percentage of no
  // budget is no fee (not the rate itself as a fixed amount).
  const feeHuman = feeType === "percentage" ? budgetHuman * feeRate : feeRate;

  const budgetLamports = Math.round(budgetHuman * factor);
  const feeLamports = Math.round(feeHuman * factor);

  // set_budget refuses a zero budget with a zero fee (e.g. a requiredFunds
  // job whose request has no amount), and would fail on every poll. Tell the
  // client once instead; the provider can't reject the job at this phase.
  if (budgetLamports <= 0 && feeLamports <= 0) {
    console.log(`[seller] Job ${job.address.slice(0, 8)}... — nothing to escrow (budget and fee are 0)`);
    try {
      await createMemo(job.address, "general", JSON.stringify({ error: "Nothing to escrow: the request has no amount and the offering charges no fee" }));
    } catch (memoErr: any) {
      console.error(`[seller] Job ${job.address.slice(0, 8)}... — failed to post rejection memo: ${memoErr.message}`);
    }
    return;
  }

  const agreementContent = JSON.stringify({
    message: agreementMessage,
    offering: offeringName || "unknown",
    budget: budgetHuman,
    fee: feeHuman,
    feeType,
    paymentMint,
    paymentSymbol,
    paymentDecimals: decimals,
    ...(outputMintAddress && { outputMint: outputMintAddress }),
    ...(outputSymbol && { outputSymbol }),
    ...(supportedMints.length > 0 && { supportedMints }),
    ...extraAgreement,
  });

  console.log(`[seller] Job ${job.address.slice(0, 8)}... — setting budget=${budgetLamports} fee=${feeLamports} (decimals=${decimals}) + creating Agreement memo`);

  try {
    // Set budget on-chain (budget = funds for the job, fee = protocol/provider commission)
    await setBudgetOnChain(job.address, budgetLamports, feeLamports);
    // Then create Agreement memo
    await createMemo(job.address, "agreement", agreementContent);
  } catch (e: any) {
    console.error(`[seller] Job ${job.address.slice(0, 8)}... — negotiation failed: ${e.message}`);
  }
}

async function handleTransaction(job: any, key: string) {
  // Check if Transaction memo exists
  const txMemo = job.memos?.find((m: any) => isMemoType(m, "Transaction"));

  if (!txMemo) {
    // If on-chain has more memos than DB, skip — DB is stale (with timeout)
    const dbMemoCount = job.memos?.length ?? 0;
    const onChainMemoCount = job._onChainMemoCount ?? dbMemoCount;
    if (shouldSkipForIndexerLag(job.address, dbMemoCount, onChainMemoCount)) {
      console.log(`[seller] Job ${job.address.slice(0, 8)}... — DB has ${dbMemoCount} memos but on-chain has ${onChainMemoCount}, skipping transaction (indexer lag)`);
      return;
    }

    // The client's signature on this memo moves the job to EVALUATION, where
    // we do the work — don't offer it until their deposit is in escrow.
    if (!(await isEscrowFunded(job.address))) {
      console.log(`[seller] Job ${job.address.slice(0, 8)}... — waiting for escrow deposit`);
      return;
    }

    console.log(`[seller] Job ${job.address.slice(0, 8)}... — creating Transaction memo`);

    try {
      await createMemo(job.address, "transaction", "Transaction confirmed. Work in progress.");
    } catch (e: any) {
      console.error(`[seller] Job ${job.address.slice(0, 8)}... — tx memo failed: ${e.message}`);
    }
    return;
  }

  // Transaction memo exists — sign it if we haven't
  const keypair = getKeypair();

  // Can't sign our own memo (contract enforces OnlyCounterParty)
  if (txMemo.sender === keypair.publicKey.toBase58()) return;

  // The indexer lists signatures per memo id next to the memos.
  const alreadySigned = job.signatures?.[txMemo.memoId]?.some(
    (sig: any) => sig.signer === keypair.publicKey.toBase58()
  );
  if (alreadySigned) return;

  // Same gate before our signature moves the job to EVALUATION: job.budget
  // is only the set_budget price, not proof the client paid it.
  if (!(await isEscrowFunded(job.address))) return;

  console.log(`[seller] Job ${job.address.slice(0, 8)}... — signing Transaction memo`);

  try {
    await signMemoById(job.address, Number(txMemo.memoId), true);
  } catch (e: any) {
    console.error(`[seller] Job ${job.address.slice(0, 8)}... — sign tx failed: ${e.message}`);
  }
}

async function handleEvaluation(job: any, key: string) {
  const hasDeliverable = job.memos?.some((m: any) => isMemoType(m, "Deliverable"));
  if (hasDeliverable) {
    unpostedDeliverables.delete(job.address);
    return;
  }

  // Same as in handleNegotiation: the failure was reported once; re-running
  // executeJob() would repeat it and post again, so leave the job until it expires.
  const ownWallet = getKeypair().publicKey.toBase58();
  if (hasOwnGeneralMemo(job, ownWallet)) return;

  // If on-chain has more memos than DB knows about, DB is stale — skip to avoid duplicates (with timeout)
  const dbMemoCount = job.memos?.length ?? 0;
  const onChainMemoCount = job._onChainMemoCount ?? dbMemoCount;
  if (shouldSkipForIndexerLag(job.address, dbMemoCount, onChainMemoCount)) {
    console.log(`[seller] Job ${job.address.slice(0, 8)}... — DB has ${dbMemoCount} memos but on-chain has ${onChainMemoCount}, skipping (indexer lag)`);
    return;
  }

  // The work is done but its Deliverable didn't post: post that result
  // instead of running executeJob() again.
  const unposted = unpostedDeliverables.get(job.address);
  if (unposted !== undefined) {
    await postDeliverable(job.address, unposted);
    return;
  }

  const parsed = parseRequirements(job);
  if (!parsed) {
    console.log(`[seller] Job ${job.address.slice(0, 8)}... — no requirements for execution`);
    return;
  }

  const { offeringName, request } = parsed;
  const resolved = await resolveOffering(offeringName);
  if (!resolved) return;

  const { offering, delegated } = resolved;

  let clientWallet: string | undefined;
  try {
    const jobAccount = await getOnChainJobFull(job.address);
    clientWallet = jobAccount.client.toBase58();
  } catch (e: any) {
    console.warn(`[seller] Job ${job.address.slice(0, 8)}... — could not fetch on-chain client: ${e.message}`);
  }

  // Inject jobAddress, clientWallet, and offering config so handlers can
  // interact with ACP escrow and verify the requester.
  const baseRequest = {
    ...request,
    jobAddress: job.address,
    clientWallet,
    _offeringConfig: offering.config,
  };

  // For delegated offerings, pass original request with task context
  const execRequest = delegated
    ? { ...baseRequest, task: request.task || `Execute ${offeringName} service`, offering: offeringName }
    : baseRequest;

  const label = delegated ? `delegate(${offeringName})` : offeringName;
  console.log(`[seller] Job ${job.address.slice(0, 8)}... — executing "${label}"`);

  let deliverable: string;
  try {
    const result = await offering.handlers.executeJob(execRequest);
    deliverable = typeof result.deliverable === "string"
      ? result.deliverable
      : JSON.stringify(result.deliverable);
  } catch (e: any) {
    console.error(`[seller] Job ${job.address.slice(0, 8)}... — execution failed: ${e.message}`);
    if (e?.stack) console.error(e.stack);
    // Deliver the failure itself when that's safe: the evaluator rejects it,
    // and the client gets the escrow back right away instead of waiting for
    // the job to expire and cancelling it (the provider can't reject in this
    // phase). Same shape as Openmoon's hosted agents use. Otherwise only tell
    // the client why, in a General memo:
    // - the job is already rejected (refundClaimedBudget ended it), where a
    //   Deliverable can't be posted any more;
    // - budget was withdrawn and not returned: ending the job would leave the
    //   client's funds with the provider, and during a deploy the other seller
    //   process may still be completing this job with them.
    let deliverFailure = true;
    try {
      const onChain = await getOnChainJobFull(job.address);
      const outstanding = BigInt(onChain.amountClaimed.toString()) - BigInt(onChain.amountRefunded.toString());
      deliverFailure = PHASE_MAP[Number(onChain.phase)] !== AcpJobPhase.REJECTED && outstanding <= 0n;
    } catch {
      // Chain state unknown: don't end the job.
      deliverFailure = false;
    }
    if (deliverFailure) {
      await postDeliverable(
        job.address,
        JSON.stringify({ status: "error", offering: offeringName, error: e.message })
      );
      return;
    }
    if (hasOwnGeneralMemo(job, ownWallet)) return;
    try {
      await createMemo(job.address, "general", JSON.stringify({ error: e.message }));
    } catch (memoErr: any) {
      console.error(`[seller] Job ${job.address.slice(0, 8)}... — failed to post failure memo: ${memoErr.message}`);
    }
    return;
  }

  console.log(`[seller] Job ${job.address.slice(0, 8)}... — execution complete, creating Deliverable`);
  await postDeliverable(job.address, deliverable);
}

/** Post a finished job's Deliverable memo. If it fails, keep the result so the
 *  next poll posts it again: the work is done, so neither re-running the
 *  handler nor reporting a failure is right. Checks the chain first, since a
 *  memo whose transaction reported an error may have landed after all, and
 *  during a deploy the other seller process may have delivered already. */
async function postDeliverable(jobAddress: string, deliverable: string) {
  try {
    if (await hasOnChainMemoFrom(jobAddress, "deliverable", getKeypair().publicKey)) {
      console.log(`[seller] Job ${jobAddress.slice(0, 8)}... — Deliverable already on-chain`);
      unpostedDeliverables.delete(jobAddress);
      return;
    }
    await createMemo(jobAddress, "deliverable", deliverable);
    unpostedDeliverables.delete(jobAddress);
  } catch (e: any) {
    unpostedDeliverables.set(jobAddress, deliverable);
    console.error(`[seller] Job ${jobAddress.slice(0, 8)}... — posting the Deliverable failed, retrying on the next poll: ${e.message}`);
  }
}

async function handleCompleted(job: any, key: string) {
  const budget = Number(job.budget || 0);
  const claimed = Number(job.amountClaimed || 0);

  if (budget > 0 && claimed < budget) {
    console.log(`[seller] Job ${job.address.slice(0, 8)}... — claiming budget`);
    try {
      const result = await claimBudget(job.address);
      if (result.skipped) console.log(`[seller] Job ${job.address.slice(0, 8)}... — budget already claimed`);
    } catch (e: any) {
      console.error(`[seller] Job ${job.address.slice(0, 8)}... — budget claim failed: ${e.message}`);
    }
  }

  try {
    const result = await claimFee(job.address);
    if (!result.skipped) {
      console.log(`[seller] Job ${job.address.slice(0, 8)}... — fee claimed: tx=${result.tx}`);
    }
  } catch (e: any) {
    console.error(`[seller] Job ${job.address.slice(0, 8)}... — fee claim failed: ${e.message}`);
  }
}

// ─── Settlement sweep ────────────────────────────────────────────
// handleCompleted only runs while a job is in the active list or on a live
// phase event, so a job that finishes while this process is down (or whose
// claim failed) leaves its fee — or a rejected job's refund — in escrow for
// good. Walk our finished jobs periodically and settle what's still there.

const SETTLE_INTERVAL_MS = 10 * 60_000;
/** Rejected jobs found with an empty escrow — final, so never re-checked. */
const settledJobs = new Set<string>();
let sweeping = false;

/** Whether the indexer still shows money in escrow for a finished job. */
function hasEscrowLeft(job: any, phase: AcpJobPhase | undefined): boolean {
  const budget = Number(job.budget || 0);
  const fee = Number(job.fee || 0);
  if (phase === AcpJobPhase.COMPLETED) return fee > 0 || budget > Number(job.amountClaimed || 0);
  if (phase === AcpJobPhase.REJECTED) return fee > 0 || budget > 0;
  return false;
}

async function settleFinishedJob(job: any, phase: AcpJobPhase) {
  const key = `${job.address}:${phase}`;
  if (shuttingDown || isPending(key)) return;
  pending.set(key, Date.now());
  activeWork++;
  try {
    if (phase === AcpJobPhase.COMPLETED) {
      await handleCompleted(job, key);
    } else {
      const result = await claimFee(job.address);
      if (result.skipped) settledJobs.add(job.address);
      else console.log(`[seller] Job ${job.address.slice(0, 8)}... — escrow refunded to client: tx=${result.tx}`);
    }
  } catch (e: any) {
    console.error(`[seller] Job ${job.address.slice(0, 8)}... — settlement failed: ${e.message}`);
  } finally {
    pending.delete(key);
    activeWork--;
  }
}

async function sweepFinishedJobs() {
  if (sweeping || shuttingDown) return;
  sweeping = true;
  try {
    const wallet = getKeypair().publicKey.toBase58();
    for (let page = 1; !shuttingDown; page++) {
      const { data } = await api.get("/acp/jobs/completed", {
        params: { wallet, role: "provider", page, pageSize: 50 },
      });
      for (const job of data.data || []) {
        if (shuttingDown) break;
        const phase = typeof job.phase === "number" ? PHASE_MAP[job.phase] : job.phase;
        if (settledJobs.has(job.address) || !hasEscrowLeft(job, phase)) continue;
        await settleFinishedJob(job, phase);
      }
      if (page >= (data.pagination?.pageCount ?? 1)) break;
    }
  } catch (e: any) {
    console.error(`[seller] Settlement sweep error: ${e.message}`);
  } finally {
    sweeping = false;
  }
}

// ─── Polling ─────────────────────────────────────────────────────

let polling = false;

async function pollActiveJobs() {
  if (polling || shuttingDown) return;
  polling = true;

  try {
    const keypair = getKeypair();
    const wallet = keypair.publicKey.toBase58();
    // Collect every page first (the indexer returns at most 50 jobs per page,
    // 20 by default): the list is ordered by recent activity, so working on
    // jobs while paging would shift it under us.
    const addresses = new Set<string>();
    for (let page = 1; ; page++) {
      const { data } = await api.get("/acp/jobs/active", {
        params: { wallet, role: "provider", page, pageSize: 50 },
      });
      for (const job of data.data || []) addresses.add(job.address);
      if (page >= (data.pagination?.pageCount ?? 1)) break;
    }

    for (const address of addresses) {
      if (shuttingDown) break;
      try {
        await processJob(address);
      } catch (e: any) {
        console.error(`[seller] Error processing job ${address.slice(0, 8)}...: ${e.message}`);
      }
    }
  } catch (e: any) {
    console.error(`[seller] Poll error: ${e.message}`);
  } finally {
    polling = false;
  }
}

// ─── Chat ────────────────────────────────────────────────────────

function connectChat(agentAddress: string) {
  if (!getAnthropicApiKey()) {
    console.warn("[seller] Anthropic API key not set — chat disabled");
    return;
  }

  if (!agentAddress) {
    console.warn("[seller] AGENT_ADDRESS not set — chat disabled");
    return;
  }

  const keypair = getKeypair();
  const wallet = keypair.publicKey.toBase58();

  // Load offering configs to send to ChatServer
  const offeringNames = listOfferings(AGENT_DIR);
  const offerings = offeringNames.map((name) => {
    const cached = offeringCache.get(name);
    return cached ? cached.config : { name };
  });
  const chatResources = listResources();

  const chatSocket: Socket = io(CHAT_URL, {
    reconnection: true,
    reconnectionDelay: 3000,
    path: "/chat",
    auth: {
      role: "provider",
      agentMint: agentAddress, // chat server uses agentMint as agent identifier
      wallet,
      offerings,
      resources: chatResources,
      // The indexer marks the agent hasChat when its seller declares chat, so the
      // app offers direct chat with it.
      capabilities: { chat: true },
      // During a deploy the old and new seller are both connected for a
      // moment; the chat server talks to the one that started last.
      startedAt: STARTED_AT,
    },
  });

  chatSocket.on("connect", () => console.log("[seller:chat] Connected to chat server, awaiting challenge..."));
  chatSocket.on("disconnect", (r) => console.log(`[seller:chat] Disconnected: ${r}`));
  chatSocket.on("connect_error", (e) => console.warn(`[seller:chat] Error: ${e.message}`));

  // Challenge-sign authentication
  chatSocket.on("auth:challenge", (data: { nonce: string }) => {
    console.log("[seller:chat] Received auth challenge, signing...");
    const message = Buffer.from(data.nonce);
    const signature = nacl.sign.detached(message, keypair.secretKey);
    chatSocket.emit("auth:solve", { signature: Buffer.from(signature).toString("base64") });
  });

  chatSocket.on("auth:success", (data: { agentMint: string }) => {
    console.log(`[seller:chat] Authenticated as provider for ${data.agentMint.slice(0, 8)}...`);
  });

  chatSocket.on("auth:error", (data: { message: string }) => {
    console.error(`[seller:chat] Auth failed: ${data.message}`);
  });

  // Chat message handler (server only sends after auth:success)
  chatSocket.on("chat:message", async (data: {
    conversationId: string;
    agentMint: string;
    userId: string;
    wallet: string | null;
    content: string;
    history: { role: string; content: string }[];
  }) => {
    console.log(`[seller:chat] Message from ${data.userId.slice(0, 12)}... in conv ${data.conversationId.slice(0, 8)}...`);

    try {
      const reply = await handleChatMessage(
        data.conversationId,
        data.agentMint,
        data.content,
        data.history.map((m) => ({
          role: m.role as "user" | "agent",
          content: m.content,
        })),
        data.wallet,
        (title) => {
          chatSocket.emit("chat:update_title", {
            conversationId: data.conversationId,
            title,
          });
        }
      );

      chatSocket.emit("chat:response", {
        conversationId: data.conversationId,
        content: reply,
      });
    } catch (e: any) {
      console.error(`[seller:chat] Error generating response: ${e.message}`);
      chatSocket.emit("chat:response", {
        conversationId: data.conversationId,
        content: "Sorry, something went wrong. Please try again.",
      });
    }
  });

  return chatSocket;
}

// ─── Main ────────────────────────────────────────────────────────

async function main() {
  const keypair = getKeypair();
  const wallet = keypair.publicKey.toBase58();

  console.log("[seller] Starting seller runtime...");
  console.log(`[seller] Wallet: ${wallet}`);
  console.log(`[seller] API: ${API_URL}`);
  console.log(`[seller] Chat: ${CHAT_URL}`);
  console.log(`[seller] Agent dir: ${AGENT_DIR}`);
  console.log(`[seller] Agent address: ${AGENT_ADDRESS || "(not set)"}`);
  console.log(`[seller] Trusted evaluators: ${TRUSTED_EVALUATORS.join(", ") || "(none — all jobs will be rejected)"}`);

  // List available offerings
  const offeringNames = listOfferings(AGENT_DIR);
  console.log(`[seller] Available offerings: ${offeringNames.join(", ") || "(none)"}`);

  if (offeringNames.length === 0) {
    console.warn("[seller] No offerings found! Seller will reject all jobs.");
  }

  // Pre-load all offerings
  for (const name of offeringNames) {
    await getOffering(name);
  }

  // Load resources from disk
  const resourcesPayload = listResources();
  if (resourcesPayload.length > 0) {
    console.log(`[seller] Available resources: ${resourcesPayload.map((r) => r.name).join(", ")}`);
  }

  // Register offerings and resources with indexer so they appear in search/marketplace
  try {
    const offeringsPayload = offeringNames
      .map((name) => offeringCache.get(name))
      .filter(Boolean)
      .map((o) => ({
        name: o!.config.name || o!.config.offering,
        description: o!.config.description || "",
        fee: o!.config.feeValue ?? o!.config.fee ?? 0,
        feeType: o!.config.feeType || "fixed",
        budgetReserve: o!.config.budgetReserve ?? 0,
        slaMinutes: o!.config.slaMinutes ?? 30,
        requiredFunds: o!.config.requiredFunds ?? false,
        requirement: o!.config.requirement ?? {},
        deliverable: o!.config.deliverable ?? {},
      }));
    // Sign nonce for auth
    const nonce = `acp-auth-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const sigBytes = nacl.sign.detached(Buffer.from(nonce), keypair.secretKey);
    const signature = Buffer.from(sigBytes).toString("base64");
    await api.put(`/acp/agent/${AGENT_ADDRESS}`, {
      offerings: offeringsPayload,
      resources: resourcesPayload,
      wallet,
      signature,
      nonce,
    });
    console.log(`[seller] Registered ${offeringsPayload.length} offerings and ${resourcesPayload.length} resources with indexer`);
  } catch (e: any) {
    console.warn(`[seller] Failed to register offerings/resources: ${e.message}`);
  }

  // Connect to indexer WebSocket for ACP job events
  const sellerSocket: Socket = io(API_URL, {
    path: "/seller-events",
    transports: ["websocket"],
    reconnection: true,
    reconnectionDelay: 3000,
    // Prove the wallet with a signed server nonce. The indexer requires it in
    // production mode, and a nonce works once, so sign a fresh one on every
    // (re)connect. Without a nonce, connect unsigned: a non-production indexer
    // accepts that, and polling covers the rest.
    auth: (cb) => {
      const base = { wallet, agentAddress: AGENT_ADDRESS || undefined };
      api
        .get("/auth/nonce")
        .then(({ data }) => {
          const nonce: string = data.nonce;
          const signature = Buffer.from(nacl.sign.detached(Buffer.from(nonce), keypair.secretKey)).toString("base64");
          cb({ ...base, nonce, signature });
        })
        .catch((e) => {
          console.warn(`[seller:ws] Could not get an auth nonce (${e.message}); connecting unsigned`);
          cb(base);
        });
    },
  });

  sellerSocket.on("connect", () => console.log("[seller:ws] Connected to seller events"));
  sellerSocket.on("disconnect", (r) => console.log(`[seller:ws] Disconnected: ${r}`));
  sellerSocket.on("connect_error", (e) => console.warn(`[seller:ws] Error: ${e.message}`));

  sellerSocket.on(SocketEvent.JOB_CREATED, (data) => {
    console.log(`[seller:ws] New job: ${data.jobAddress}`);
    processJob(data.jobAddress).catch((e) =>
      console.error(`[seller] Error handling new job: ${e.message}`)
    );
  });

  sellerSocket.on(SocketEvent.JOB_PHASE, (data) => {
    console.log(`[seller:ws] Phase update: ${data.jobAddress} → ${data.phase}`);
    const addr = data.jobAddress;
    for (const key of pending.keys()) {
      if (key.startsWith(addr + ":") && !key.endsWith(`:${data.phase}`)) {
        pending.delete(key);
      }
    }
    processJob(data.jobAddress).catch((e) =>
      console.error(`[seller] Error handling phase update: ${e.message}`)
    );
  });

  sellerSocket.on(SocketEvent.MEMO_CREATED, (data) => {
    console.log(`[seller:ws] Memo created: ${data.jobAddress} (${data.memoType})`);
  });

  sellerSocket.on(SocketEvent.JOB_BUDGET, (data) => {
    console.log(`[seller:ws] Budget set: ${data.jobAddress} = ${data.budget}`);
  });

  // Connect to chat server
  const chatSocket = connectChat(AGENT_ADDRESS);

  // Graceful shutdown: start no new work and let work in progress finish (an
  // executeJob killed halfway may have moved funds without delivering), up to
  // SHUTDOWN_GRACE_MS. A second signal exits at once.
  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      console.log(`[seller] ${signal} again, exiting now`);
      process.exit(1);
    }
    shuttingDown = true;
    console.log(`\n[seller] ${signal}: shutting down...`);
    sellerSocket.disconnect();
    chatSocket?.disconnect();
    if (activeWork > 0) {
      const graceMs = getShutdownGraceMs();
      console.log(`[seller] Waiting up to ${Math.round(graceMs / 1000)}s for ${activeWork} job(s) in progress`);
      const deadline = Date.now() + graceMs;
      while (activeWork > 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 250));
      }
      if (activeWork > 0) console.warn(`[seller] ${activeWork} job(s) still running, exiting anyway`);
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // Initial poll + periodic polling as fallback
  await pollActiveJobs();
  setInterval(pollActiveJobs, POLL_INTERVAL);

  // Settle finished jobs left with money in escrow (see sweepFinishedJobs).
  void sweepFinishedJobs();
  setInterval(sweepFinishedJobs, SETTLE_INTERVAL_MS);

  console.log(`[seller] Running. Polling every ${POLL_INTERVAL}ms`);
}

main().catch((e) => {
  console.error("[seller] Fatal:", e);
  process.exit(1);
});
