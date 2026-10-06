import * as anchor from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, type TransactionInstruction } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
} from "@solana/spl-token";
import { getClient } from "../lib/client";
import { output, field, heading, log, success, error, warn } from "../lib/output";
import { PLATFORM_EVALUATOR } from "../lib/config";
import {
  getProgram,
  getKeypair,
  AnchorMemoType,
  hashContent,
  hashToHex,
} from "../lib/program";
import {
  PHASE_NAMES,
  getAcpStatePda,
  getAgentFeeAuthorityPda,
  getJobPda,
  getMemoPda,
  getMemoSigPda,
  getPdaAgent,
  getEscrowVaultPda,
  getEscrowAuthorityPda,
  zeroHash,
} from "../lib/pda";

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

/**
 * Parse a base58 Solana address from user input, exiting with a clear error
 * instead of throwing a cryptic TypeError from PublicKey's constructor.
 */
function parsePubkeyArg(label: string, value: string | undefined): PublicKey {
  if (!value) {
    error(`${label} is required`);
    process.exit(1);
  }
  try {
    return new PublicKey(value);
  } catch {
    error(`Invalid ${label}: not a valid base58 public key (${value})`);
    process.exit(1);
  }
}

/** The job address to look up on the indexer. The indexer answers a number
 *  with any agent's job of that number, so numbers are refused. */
function jobRef(ref: string): string {
  if (/^\d+$/.test(ref)) {
    error(
      `"${ref}" is a job number, and job numbers repeat across agents; pass the job address (acp job create prints it, acp job active lists them)`
    );
    process.exit(1);
  }
  return parsePubkeyArg("job address", ref).toBase58();
}

/**
 * Store a memo's text with the indexer: the chain holds only the hash; the
 * other party, the seller and the evaluator read the text from the indexer.
 * Retries a passing failure (no response, 429 or 5xx), 3 attempts in all;
 * throws when the indexer refuses the text or the retries run out.
 */
async function postMemoText(hexHash: string, text: string): Promise<void> {
  const retryWaitsMs = [1000, 2000];
  for (let attempt = 0; ; attempt++) {
    try {
      await getClient().post("/memo-content", { hash: hexHash, text });
      return;
    } catch (e: any) {
      const status = e?.status ?? e?.response?.status;
      const passing = status === undefined || status === 429 || status >= 500;
      if (!passing || attempt >= retryWaitsMs.length) throw e;
      await new Promise((r) => setTimeout(r, retryWaitsMs[attempt]));
    }
  }
}

/** Sellers built on this template (seller.ts parseRequirements) and hosted
 *  agents route a job by the offering its request names. */
function requestNamesOffering(requirements: string | undefined): boolean {
  if (!requirements) return false;
  try {
    const parsed = JSON.parse(requirements);
    const name = parsed?.offering || parsed?.type || parsed?.offeringName;
    return typeof name === "string" && name.length > 0;
  } catch {
    return false;
  }
}

const NO_OFFERING_WARNING =
  "Sellers built on this template and Openmoon's hosted agents skip a job whose request doesn't name an offering; pass --requirements '{\"offering\":\"<name>\",...}'";

/** acp-core decodes accounts with the IDL it bundles; one older than the
 *  program has no termsLocked on jobs. */
function termsLockedKnown(jobAccount: any): boolean {
  return typeof jobAccount.termsLocked === "boolean";
}

const TERMS_LOCKED_UNKNOWN =
  "This acp-core decodes jobs without termsLocked (SDK older than the program). Update and rebuild ../sdk as the README describes, then reinstall dependencies.";

/** Instructions that wrap `lamports` of SOL into the owner's wSOL account
 *  for a deposit, and close the account afterwards (back to plain SOL). */
function wrapSolInstructions(owner: PublicKey, ata: PublicKey, lamports: bigint) {
  return {
    before: [
      createAssociatedTokenAccountIdempotentInstruction(owner, ata, owner, NATIVE_MINT),
      SystemProgram.transfer({ fromPubkey: owner, toPubkey: ata, lamports }),
      createSyncNativeInstruction(ata),
    ] as TransactionInstruction[],
    after: [createCloseAccountInstruction(ata, owner, owner)] as TransactionInstruction[],
  };
}

/** Base units the Agreement memo states for budget and fee, or null when its
 *  text can't be read. The seller writes human amounts plus paymentDecimals. */
function agreementTerms(memo: any): { budget: bigint; fee: bigint; paymentMint?: string } | null {
  if (!memo?.content) return null;
  try {
    const terms = JSON.parse(memo.content);
    const decimals = Number(terms.paymentDecimals);
    if (!Number.isInteger(decimals) || typeof terms.budget !== "number" || typeof terms.fee !== "number") return null;
    return {
      budget: BigInt(Math.round(terms.budget * 10 ** decimals)),
      fee: BigInt(Math.round(terms.fee * 10 ** decimals)),
      paymentMint: typeof terms.paymentMint === "string" ? terms.paymentMint : undefined,
    };
  } catch {
    return null;
  }
}

/** The provider's Agreement memo for the current negotiation, if indexed. */
function findAgreement(job: any): any | undefined {
  return [...(job.memos ?? [])]
    .reverse()
    .find((m: any) => isMemoType(m, "Agreement") && m.sender === job.provider && m.phaseAtCreation === PHASE_NEGOTIATION);
}

const PHASE_NEGOTIATION = 1;
const PHASE_TRANSACTION = 2;
const PHASE_EVALUATION = 3;

// ─── Write operations (direct on-chain) ─────────────────────────

export async function create(
  agentMint: string,
  provider: string | undefined,
  options: {
    evaluator?: string;
    expiredAt?: number;
    requirements?: string;
    isAutomated?: boolean;
    paymentMint?: string;
  } = {}
) {
  const program = getProgram();
  const keypair = getKeypair();

  // agentMint is now the agent PDA address directly
  const agentPda = parsePubkeyArg("agent address", agentMint);
  const providerArg = provider ? parsePubkeyArg("provider", provider) : undefined;
  // Sellers only take jobs judged by an evaluator they trust; without one
  // the client alone decides the Deliverable, so default to the platform's.
  const evaluatorKey = parsePubkeyArg("evaluator", options.evaluator || PLATFORM_EVALUATOR);

  // Sellers skip a job whose request names no offering. Warn, but leave the
  // decision to the caller.
  const warning = requestNamesOffering(options.requirements) ? undefined : NO_OFFERING_WARNING;
  if (warning) warn(warning);

  const agentAccount = await (program.account as any).agent.fetch(agentPda);
  // The agent's seller lists its jobs by provider, so the job must name the
  // agent's on-chain provider.
  const providerKey: PublicKey = agentAccount.provider;
  if (providerArg && !providerArg.equals(providerKey)) {
    error(
      `${provider} is not this agent's provider (${providerKey.toBase58()}): its seller would never see the job. Leave the provider out.`
    );
    process.exit(1);
  }
  const nextJobId = Number(agentAccount.jobCounter) + 1;
  const jobPda = getJobPda(agentPda, nextJobId);
  const acpStatePda = getAcpStatePda();

  // create_job needs the job's payment mint. Like the app, default to the
  // platform's payment token (acpState.paymentToken, wSOL).
  const paymentMint: PublicKey = options.paymentMint
    ? parsePubkeyArg("payment mint", options.paymentMint)
    : (await (program.account as any).acpState.fetch(acpStatePda)).paymentToken;

  const expiry = options.expiredAt || Math.floor(Date.now() / 1000) + 3600;

  // The JobRequest memo holds only the requirements' hash. Store the text
  // first: the seller skips a job whose request it can't read, and such a
  // job, never funded, just sits there until it expires.
  const requestHash = options.requirements ? hashContent(options.requirements) : undefined;
  if (options.requirements && requestHash) {
    try {
      await postMemoText(hashToHex(requestHash), options.requirements);
    } catch (e: any) {
      error(`Could not store the requirements with the indexer (${e.message}); no job was created`);
      process.exit(1);
    }
  }

  const tx = await (program.methods as any)
    .createJob(new anchor.BN(expiry))
    .accounts({
      client: keypair.publicKey,
      acpState: acpStatePda,
      agent: agentPda,
      job: jobPda,
      provider: providerKey,
      evaluator: evaluatorKey,
      paymentMint,
      systemProgram: SystemProgram.programId,
    })
    .signers([keypair])
    .rpc();

  // Create JobRequest memo with requirements
  if (requestHash) {
    const memoPda = getMemoPda(jobPda, 1);
    await (program.methods as any)
      .createMemo(requestHash, AnchorMemoType.jobRequest, false)
      .accounts({
        sender: keypair.publicKey,
        agent: agentPda,
        job: jobPda,
        memo: memoPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([keypair])
      .rpc();
  }

  const result = {
    jobId: nextJobId,
    jobAddress: jobPda.toBase58(),
    tx,
    isAutomated: !!options.isAutomated,
    ...(warning && { warning }),
  };
  output(result, (d) => {
    success("Job created");
    field("Job ID", d.jobId);
    field("Address", d.jobAddress);
    field("TX", d.tx);
    if (d.isAutomated) log("  Auto-pay enabled — will poll and pay automatically");
  });

  // Auto-pay: poll until the provider's Agreement has locked the terms, then
  // approve it and deposit; then approve the provider's Transaction memo,
  // which starts the work (as the app does). Job numbers repeat across
  // agents, so go by address.
  if (options.isAutomated) {
    const address = jobPda.toBase58();
    const me = keypair.publicKey.toBase58();
    let paid = false;
    log("\n  Waiting for provider to accept and propose terms...");
    const maxAttempts = 60; // 10min with 10s interval
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((r) => setTimeout(r, 10000));
      if (i % 6 === 5) log(`  Still waiting... (${Math.round((i + 1) * 10 / 60)}min elapsed)`);
      let phase: number;
      let jobData: any;
      let termsLocked: boolean;
      try {
        const jobAccount = await (program.account as any).job.fetch(jobPda);
        if (!termsLockedKnown(jobAccount)) {
          // pay() could never approve the Agreement; don't poll for nothing.
          log(`  ${TERMS_LOCKED_UNKNOWN}`);
          return;
        }
        phase = Number(jobAccount.phase);
        termsLocked = jobAccount.termsLocked;
        // Memo texts and signatures come from the indexer.
        ({ data: jobData } = await getClient().get(`/acp/jobs/${address}`));
      } catch {
        continue; // transient RPC/indexer errors — keep polling
      }
      if (phase > PHASE_TRANSACTION) {
        log(paid ? "  Work started. Poll `acp job status` for the deliverable." : `  Job moved on without payment (phase ${phase})`);
        return;
      }
      if (!paid && (phase === PHASE_TRANSACTION || (termsLocked && agreementTerms(findAgreement(jobData))))) {
        log("  Terms proposed — approving and depositing...");
        await pay(address, true);
        paid = true;
        log("  Paid. Waiting for the provider to start work...");
        continue;
      }
      const txMemo = paid && jobData.memos?.find((m: any) =>
        isMemoType(m, "Transaction") && m.sender === jobData.provider && m.phaseAtCreation === PHASE_TRANSACTION &&
        !jobData.signatures?.[m.memoId]?.some((sig: any) => sig.signer === me));
      if (txMemo) {
        await sign(address, String(txMemo.memoId), true);
        log("  Auto-pay complete. Poll `acp job status` for the deliverable.");
        return;
      }
    }
    log("  Auto-pay timeout (10min) — check job status manually with `acp job status`.");
  }
}

export async function accept(jobId: string, doAccept: boolean, reason?: string) {
  const program = getProgram();
  const keypair = getKeypair();

  // Fetch job from indexer to get agent PDA
  const { data: job } = await getClient().get(`/acp/jobs/${jobRef(jobId)}`);

  const jid = Number(job.jobId);
  const agentPda = new PublicKey(job.agent);
  const jobPda = getJobPda(agentPda, jid);

  // Find JobRequest memo
  const jobRequestMemo = job.memos?.find((m: any) => isMemoType(m, "JobRequest"));
  if (!jobRequestMemo) throw new Error("No JobRequest memo to sign");

  const memoSigPda = getMemoSigPda(jobPda, BigInt(jobRequestMemo.memoId), keypair.publicKey);
  const reasonHash = reason ? hashContent(reason) : zeroHash();

  if (reason) {
    try {
      await postMemoText(hashToHex(reasonHash), reason);
    } catch (e: any) {
      warn(`Could not store the reason text (${e.message}); the signature goes ahead with its hash only`);
    }
  }

  const tx = await (program.methods as any)
    .signMemo(doAccept, reasonHash)
    .accounts({
      signer: keypair.publicKey,
      acpState: getAcpStatePda(),
      agent: agentPda,
      job: jobPda,
      memo: getMemoPda(jobPda, Number(jobRequestMemo.memoId)),
      memoSignature: memoSigPda,
      escrowVault: getEscrowVaultPda(jobPda),
      systemProgram: SystemProgram.programId,
    })
    .signers([keypair])
    .rpc();

  output({ tx }, (d) => {
    success(`Job ${doAccept ? "accepted" : "rejected"}`);
    field("TX", d.tx);
  });
}

export async function memo(jobId: string, memoType: string, content: string) {
  const program = getProgram();
  const keypair = getKeypair();

  if (!Object.prototype.hasOwnProperty.call(AnchorMemoType, memoType)) {
    throw new Error(`Invalid memo type: ${memoType} (use ${Object.keys(AnchorMemoType).join(", ")})`);
  }
  const anchorType = AnchorMemoType[memoType];

  const { data: job } = await getClient().get(`/acp/jobs/${jobRef(jobId)}`);

  const jid = Number(job.jobId);
  const agentPda = new PublicKey(job.agent);
  const jobPda = getJobPda(agentPda, jid);

  const jobAccount = await (program.account as any).job.fetch(jobPda);
  const nextMemoId = Number(jobAccount.memoCount) + 1;
  const memoPda = getMemoPda(jobPda, nextMemoId);

  const contentHash = hashContent(content);

  // The memo holds only the hash; without the stored text nobody can read it.
  try {
    await postMemoText(hashToHex(contentHash), content);
  } catch (e: any) {
    error(`Could not store the memo text with the indexer (${e.message}); no memo was created`);
    process.exit(1);
  }

  const tx = await (program.methods as any)
    .createMemo(contentHash, anchorType, false)
    .accounts({
      sender: keypair.publicKey,
      agent: agentPda,
      job: jobPda,
      memo: memoPda,
      systemProgram: SystemProgram.programId,
    })
    .signers([keypair])
    .rpc();

  output({ memoId: nextMemoId, tx }, (d) => {
    success("Memo created");
    field("Memo ID", d.memoId);
    field("TX", d.tx);
  });
}

export async function sign(jobId: string, memoId: string, approve: boolean, reason?: string) {
  const program = getProgram();
  const keypair = getKeypair();

  const { data: job } = await getClient().get(`/acp/jobs/${jobRef(jobId)}`);

  const jid = Number(job.jobId);
  const agentPda = new PublicKey(job.agent);
  const jobPda = getJobPda(agentPda, jid);
  const mid = Number(memoId);
  const memoPda = getMemoPda(jobPda, mid);
  const memoSigPda = getMemoSigPda(jobPda, mid, keypair.publicKey);

  const reasonHash = reason ? hashContent(reason) : zeroHash();
  if (reason) {
    try {
      await postMemoText(hashToHex(reasonHash), reason);
    } catch (e: any) {
      warn(`Could not store the reason text (${e.message}); the signature goes ahead with its hash only`);
    }
  }

  const tx = await (program.methods as any)
    .signMemo(approve, reasonHash)
    .accounts({
      signer: keypair.publicKey,
      acpState: getAcpStatePda(),
      agent: agentPda,
      job: jobPda,
      memo: memoPda,
      memoSignature: memoSigPda,
      escrowVault: getEscrowVaultPda(jobPda),
      systemProgram: SystemProgram.programId,
    })
    .signers([keypair])
    .rpc();

  output({ tx }, (d) => {
    success(`Memo ${approve ? "approved" : "rejected"}`);
    field("TX", d.tx);
  });
}

export async function setBudget(jobId: string, budget: number, fee: number) {
  const program = getProgram();
  const keypair = getKeypair();

  const { data: job } = await getClient().get(`/acp/jobs/${jobRef(jobId)}`);

  const agentPda = new PublicKey(job.agent);
  const jobPda = getJobPda(agentPda, Number(job.jobId));

  const tx = await (program.methods as any)
    .setBudget(new anchor.BN(budget), new anchor.BN(fee))
    .accounts({
      provider: keypair.publicKey,
      agent: agentPda,
      job: jobPda,
    })
    .signers([keypair])
    .rpc();

  output({ tx }, (d) => {
    success("Budget set");
    field("TX", d.tx);
  });
}

export async function deposit(jobId: string) {
  const program = getProgram();

  const { data: job } = await getClient().get(`/acp/jobs/${jobRef(jobId)}`);

  const agentPda = new PublicKey(job.agent);
  const jobPda = getJobPda(agentPda, Number(job.jobId));
  const jobAccount = await (program.account as any).job.fetch(jobPda);

  const tx = await depositIx(jobPda, agentPda, jobAccount).rpc();

  output({ tx }, (d) => {
    success("Deposited to escrow");
    field("TX", d.tx);
  });
}

/** deposit_to_escrow for budget + fee, wrapping SOL first on wSOL jobs. */
function depositIx(jobPda: PublicKey, agentPda: PublicKey, jobAccount: any) {
  const program = getProgram();
  const keypair = getKeypair();
  const paymentMint: PublicKey = jobAccount.paymentMint;
  const clientAta = getAssociatedTokenAddressSync(paymentMint, keypair.publicKey);
  const total = BigInt(jobAccount.budget.toString()) + BigInt(jobAccount.fee.toString());
  const wrap = paymentMint.equals(NATIVE_MINT)
    ? wrapSolInstructions(keypair.publicKey, clientAta, total)
    : { before: [], after: [] };

  return (program.methods as any)
    .depositToEscrow()
    .accounts({
      client: keypair.publicKey,
      acpState: getAcpStatePda(),
      agent: agentPda,
      job: jobPda,
      paymentMint,
      clientTokenAccount: clientAta,
      escrowVault: getEscrowVaultPda(jobPda),
      escrowAuthority: getEscrowAuthorityPda(jobPda),
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .preInstructions(wrap.before)
    .postInstructions(wrap.after)
    .signers([keypair]);
}

export async function claim(jobId: string, amount?: number) {
  const program = getProgram();
  const keypair = getKeypair();

  const { data: job } = await getClient().get(`/acp/jobs/${jobRef(jobId)}`);

  const agentPda = new PublicKey(job.agent);
  const jobPda = getJobPda(agentPda, Number(job.jobId));
  const escrowVault = getEscrowVaultPda(jobPda);
  const escrowAuthority = getEscrowAuthorityPda(jobPda);

  const jobAccount = await (program.account as any).job.fetch(jobPda);
  const paymentMint: PublicKey = jobAccount.paymentMint;

  const claimable = amount || Number(jobAccount.budget) - Number(jobAccount.amountClaimed);
  const providerAta = getAssociatedTokenAddressSync(paymentMint, new PublicKey(job.provider));

  const createProviderAta = createAssociatedTokenAccountIdempotentInstruction(
    keypair.publicKey,
    providerAta,
    new PublicKey(job.provider),
    paymentMint
  );

  const tx = await (program.methods as any)
    .claimBudget(new anchor.BN(claimable))
    .accounts({
      provider: keypair.publicKey,
      agent: agentPda,
      job: jobPda,
      escrowVault,
      escrowAuthority,
      providerTokenAccount: providerAta,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .preInstructions([createProviderAta])
    .signers([keypair])
    .rpc();

  output({ tx }, (d) => {
    success("Budget claimed");
    field("TX", d.tx);
  });
}

/**
 * Return withdrawn budget to the job's escrow (refund_budget): moves tokens
 * from the provider's payment-mint account back into the job's escrow vault.
 * Use it when the provider withdrew budget (`acp job claim`) but cannot
 * deliver. `amount` defaults to the outstanding claim (claimed − refunded).
 *
 * If the provider had withdrawn the whole budget and returns all of it, the
 * program marks the job REJECTED, and the client then recovers the escrow
 * with `acp job claim-fee <job>`. Otherwise the job stays open, and after
 * expiry the client can `acp job cancel <job>`, which needs nothing
 * outstanding.
 *
 * On a wSOL job the withdrawn budget may have been spent or unwrapped, so
 * the shortfall is wrapped from the provider's SOL first.
 */
export async function refund(jobId: string, amount?: number) {
  const program = getProgram();
  const keypair = getKeypair();

  const { data: job } = await getClient().get(`/acp/jobs/${jobRef(jobId)}`);

  const agentPda = new PublicKey(job.agent);
  const jobPda = getJobPda(agentPda, Number(job.jobId));
  const escrowVault = getEscrowVaultPda(jobPda);

  const jobAccount = await (program.account as any).job.fetch(jobPda);
  const paymentMint: PublicKey = jobAccount.paymentMint;
  const outstanding = Number(jobAccount.amountClaimed) - Number(jobAccount.amountRefunded);

  if (outstanding <= 0) {
    error(`Nothing to refund — amountClaimed=${jobAccount.amountClaimed} amountRefunded=${jobAccount.amountRefunded}`);
    process.exit(1);
  }

  const refundLamports = amount ?? outstanding;
  if (refundLamports > outstanding) {
    error(`Refund amount ${refundLamports} exceeds outstanding ${outstanding}`);
    process.exit(1);
  }

  const providerAta = getAssociatedTokenAddressSync(paymentMint, keypair.publicKey);

  // Offerings that spend a wSOL budget unwrap it, which closes this account;
  // wrap whatever it lacks from the provider's SOL.
  const wrapIxs: TransactionInstruction[] = [];
  let wrapped = 0n;
  if (paymentMint.equals(NATIVE_MINT)) {
    let held = 0n;
    try {
      const { value } = await program.provider.connection.getTokenAccountBalance(providerAta);
      held = BigInt(value.amount);
    } catch {
      // No wSOL account: nothing held.
    }
    if (held < BigInt(refundLamports)) {
      wrapped = BigInt(refundLamports) - held;
      wrapIxs.push(
        createAssociatedTokenAccountIdempotentInstruction(keypair.publicKey, providerAta, keypair.publicKey, NATIVE_MINT),
        SystemProgram.transfer({ fromPubkey: keypair.publicKey, toPubkey: providerAta, lamports: wrapped }),
        createSyncNativeInstruction(providerAta),
      );
    }
  }

  const tx = await (program.methods as any)
    .refundBudget(new anchor.BN(refundLamports))
    .accounts({
      provider: keypair.publicKey,
      agent: agentPda,
      job: jobPda,
      escrowVault,
      providerTokenAccount: providerAta,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .preInstructions(wrapIxs)
    .signers([keypair])
    .rpc();

  output({ tx, lamports: refundLamports, wrapped: Number(wrapped) }, (d) => {
    success(`Refunded ${d.lamports} lamports to escrow`);
    if (d.wrapped > 0) field("Wrapped SOL", `${d.wrapped} lamports`);
    field("TX", d.tx);
  });
}

export async function claimFee(jobId: string) {
  const program = getProgram();
  const keypair = getKeypair();

  const { data: job } = await getClient().get(`/acp/jobs/${jobRef(jobId)}`);

  const agentPda = new PublicKey(job.agent);
  const jobPda = getJobPda(agentPda, Number(job.jobId));
  const acpStatePda = getAcpStatePda();
  const escrowVault = getEscrowVaultPda(jobPda);
  const escrowAuthority = getEscrowAuthorityPda(jobPda);

  const jobAccount = await (program.account as any).job.fetch(jobPda);
  const paymentMint: PublicKey = jobAccount.paymentMint;
  const acpState = await (program.account as any).acpState.fetch(acpStatePda);
  // state.platformTreasury is the ATA itself — do NOT derive another ATA
  // from it (yields #3012 AccountNotInitialized).
  const platformTreasuryAta: PublicKey = acpState.platformTreasury;

  const client = new PublicKey(job.client);
  const clientAta = getAssociatedTokenAddressSync(paymentMint, client);
  const agentFeeAuthority = getAgentFeeAuthorityPda(agentPda);
  const agentFeeVault = getAssociatedTokenAddressSync(paymentMint, agentFeeAuthority, true);

  // claim_fee needs the client's token account even when it only pays out the
  // fee (completed); a refund (rejected) lands there. A client claiming their
  // own wSOL refund gets it back as plain SOL.
  const createClientAta = createAssociatedTokenAccountIdempotentInstruction(
    keypair.publicKey,
    clientAta,
    client,
    paymentMint
  );
  const unwrap = paymentMint.equals(NATIVE_MINT) && client.equals(keypair.publicKey)
    ? [createCloseAccountInstruction(clientAta, keypair.publicKey, keypair.publicKey)]
    : [];

  const tx = await (program.methods as any)
    .claimFee()
    .accounts({
      claimer: keypair.publicKey,
      acpState: acpStatePda,
      agent: agentPda,
      job: jobPda,
      escrowVault,
      escrowAuthority,
      clientTokenAccount: clientAta,
      platformTreasuryTokenAccount: platformTreasuryAta,
      paymentMint,
      agentFeeAuthority,
      agentFeeVault,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .preInstructions([createClientAta])
    .postInstructions(unwrap)
    .signers([keypair])
    .rpc();

  output({ tx }, (d) => {
    success("Escrow settled");
    field("TX", d.tx);
  });
}

/** Client escape hatch: after expiry, take back the escrow of a funded job
 *  that never got a Deliverable (cancel_expired_job). */
export async function cancel(jobId: string) {
  const program = getProgram();
  const keypair = getKeypair();

  const { data: job } = await getClient().get(`/acp/jobs/${jobRef(jobId)}`);

  const agentPda = new PublicKey(job.agent);
  const jobPda = getJobPda(agentPda, Number(job.jobId));
  const jobAccount = await (program.account as any).job.fetch(jobPda);

  if (!jobAccount.client.equals(keypair.publicKey)) {
    error(`Only the job's client (${jobAccount.client.toBase58()}) can cancel it`);
    process.exit(1);
  }
  // cancel_expired_job takes only funded, unsettled jobs.
  const phase = Number(jobAccount.phase);
  if (phase < PHASE_TRANSACTION) {
    error(`The job was never funded (phase ${PHASE_NAMES[phase]}); there is no escrow to take back`);
    process.exit(1);
  }
  if (phase > PHASE_EVALUATION) {
    error(`The job is already ${PHASE_NAMES[phase]}; settle its escrow with \`acp job claim-fee ${jobId}\``);
    process.exit(1);
  }
  if (Date.now() / 1000 <= Number(jobAccount.expiredAt)) {
    error(`The job hasn't expired yet (expires ${new Date(Number(jobAccount.expiredAt) * 1000).toISOString()})`);
    process.exit(1);
  }
  if (jobAccount.hasDeliverable) {
    error("The provider delivered — the evaluator decides this job, it can't be cancelled");
    process.exit(1);
  }
  if (BigInt(jobAccount.amountClaimed.toString()) > BigInt(jobAccount.amountRefunded.toString())) {
    error("The provider still holds withdrawn budget — the job stays open until they refund it");
    process.exit(1);
  }

  const paymentMint: PublicKey = jobAccount.paymentMint;
  const clientAta = getAssociatedTokenAddressSync(paymentMint, keypair.publicKey);
  const unwrap = paymentMint.equals(NATIVE_MINT)
    ? [createCloseAccountInstruction(clientAta, keypair.publicKey, keypair.publicKey)]
    : [];

  const tx = await (program.methods as any)
    .cancelExpiredJob()
    .accounts({
      client: keypair.publicKey,
      agent: agentPda,
      job: jobPda,
      escrowVault: getEscrowVaultPda(jobPda),
      escrowAuthority: getEscrowAuthorityPda(jobPda),
      clientTokenAccount: clientAta,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .preInstructions([
      createAssociatedTokenAccountIdempotentInstruction(keypair.publicKey, clientAta, keypair.publicKey, paymentMint),
    ])
    .postInstructions(unwrap)
    .signers([keypair])
    .rpc();

  output({ tx }, (d) => {
    success("Job cancelled, escrow refunded");
    field("TX", d.tx);
  });
}

/** Answer the provider's Agreement: approve it and deposit budget + fee in
 *  one transaction (as the app does), or reject it, which ends the job. */
export async function pay(jobId: string, doAccept: boolean, content?: string) {
  const program = getProgram();
  const keypair = getKeypair();

  const { data: job } = await getClient().get(`/acp/jobs/${jobRef(jobId)}`);

  const agentPda = new PublicKey(job.agent);
  const jobPda = getJobPda(agentPda, Number(job.jobId));
  const jobAccount = await (program.account as any).job.fetch(jobPda);
  const phase = Number(jobAccount.phase);

  // Agreement already approved: only the deposit is left.
  if (phase === PHASE_TRANSACTION) {
    if (!doAccept) {
      error("The Agreement is already approved. To back out after expiry, use `acp job cancel`.");
      process.exit(1);
    }
    const tx = await depositIx(jobPda, agentPda, jobAccount).rpc();
    output({ jobId, tx }, (d) => {
      success("Deposited to escrow");
      field("TX", d.tx);
    });
    return;
  }

  const agreementMemo = phase === PHASE_NEGOTIATION ? findAgreement(job) : undefined;
  if (!agreementMemo) {
    error(`No Agreement to answer (phase ${phase}) — wait for the provider to propose terms`);
    process.exit(1);
  }

  const memoId = Number(agreementMemo.memoId);
  const reasonHash = !doAccept && content ? hashContent(content) : zeroHash();
  const signIx: TransactionInstruction = await (program.methods as any)
    .signMemo(doAccept, reasonHash)
    .accounts({
      signer: keypair.publicKey,
      acpState: getAcpStatePda(),
      agent: agentPda,
      job: jobPda,
      memo: getMemoPda(jobPda, memoId),
      memoSignature: getMemoSigPda(jobPda, memoId, keypair.publicKey),
      escrowVault: getEscrowVaultPda(jobPda),
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  if (!doAccept) {
    if (content) {
      try {
        await postMemoText(hashToHex(reasonHash), content);
      } catch (e: any) {
        warn(`Could not store the reason text (${e.message}); the signature goes ahead with its hash only`);
      }
    }
    const tx = await (program.provider as anchor.AnchorProvider).sendAndConfirm(
      new anchor.web3.Transaction().add(signIx)
    );
    output({ jobId, accepted: false, content, tx }, (d) => {
      success("Agreement rejected — the job is closed");
      if (d.content) field("Reason", d.content);
      field("TX", d.tx);
    });
    return;
  }

  // The Agreement locks budget and fee on-chain, so what's checked here is
  // what deposit_to_escrow moves.
  if (!termsLockedKnown(jobAccount)) {
    error(TERMS_LOCKED_UNKNOWN);
    process.exit(1);
  }
  if (!jobAccount.termsLocked) {
    error("The job's terms aren't locked on-chain yet — try again in a moment");
    process.exit(1);
  }
  const budget = BigInt(jobAccount.budget.toString());
  const fee = BigInt(jobAccount.fee.toString());
  const terms = agreementTerms(agreementMemo);
  if (!terms) {
    error(`Can't read the Agreement's terms (memo #${memoId}); check them with \`acp job status ${jobId}\``);
    process.exit(1);
  }
  // One base unit of slack: hosted agents pad a zero budget to 1 lamport.
  if (budget > terms.budget + 1n || fee > terms.fee + 1n ||
      (terms.paymentMint && terms.paymentMint !== jobAccount.paymentMint.toBase58())) {
    error(`The Agreement says budget ${terms.budget} + fee ${terms.fee}, but the job charges budget ${budget} + fee ${fee} — not paying`);
    process.exit(1);
  }

  const tx = await depositIx(jobPda, agentPda, jobAccount)
    .preInstructions([signIx], true)
    .rpc();

  output({ jobId, budget: budget.toString(), fee: fee.toString(), tx }, (d) => {
    success("Agreement approved and deposited");
    field("Job ID", d.jobId);
    field("Budget", d.budget);
    field("Fee", d.fee);
    field("TX", d.tx);
  });
}

// ─── Read operations (via indexer API) ───────────────────────────

const MEMO_TYPE_NAMES = Object.keys(MEMO_TYPE).map((t) => t.charAt(0).toLowerCase() + t.slice(1));

/** The indexer sends phases and memo types as numbers; name them. */
function phaseLabel(phase: unknown): string {
  return typeof phase === "number" ? PHASE_NAMES[phase] ?? String(phase) : String(phase);
}
function memoTypeLabel(memoType: unknown): string {
  return typeof memoType === "number" ? MEMO_TYPE_NAMES[memoType] ?? String(memoType) : String(memoType);
}

export async function status(jobId: string) {
  const { data: job } = await getClient().get(`/acp/jobs/${jobRef(jobId)}`);
  const data = {
    ...job,
    phaseName: phaseLabel(job.phase),
    memos: job.memos?.map((m: any) => ({ ...m, memoTypeName: memoTypeLabel(m.memoType) })),
  };

  output(data, (d) => {
    heading(`Job #${d.jobId}`);
    field("Address", d.address);
    field("Phase", d.phaseName);
    field("Client", d.client);
    field("Provider", d.provider);
    field("Evaluator", d.evaluator);
    field("Budget", d.budget);
    field("Fee", d.fee);
    field("Claimed", d.amountClaimed);
    field("Memos", d.memoCount);

    if (d.memos?.length > 0) {
      heading("Memos");
      for (const m of d.memos) {
        log(`  [${m.memoId}] ${m.memoTypeName} (${m.sender.slice(0, 8)}...)`);
        if (m.content) log(`      ${m.content.slice(0, 100)}`);
      }
    }
  });
}

export async function active(options: { page?: number; role?: string } = {}) {
  const keypair = getKeypair();
  const wallet = keypair.publicKey.toBase58();
  const { data } = await getClient().get("/acp/jobs/active", {
    params: { page: options.page || 1, role: options.role || "all", wallet },
  });

  output(data, (d) => {
    heading("Active Jobs");
    if (d.data.length === 0) {
      log("  No active jobs");
      return;
    }
    for (const j of d.data) {
      log(`  ${j.address} [${phaseLabel(j.phase)}] client=${j.client.slice(0, 8)}... provider=${j.provider.slice(0, 8)}... budget=${j.budget}`);
    }
    log(`  Page ${d.pagination.page}, total: ${d.pagination.total}`);
  });
}

export async function completed(options: { page?: number; role?: string } = {}) {
  const keypair = getKeypair();
  const wallet = keypair.publicKey.toBase58();
  const { data } = await getClient().get("/acp/jobs/completed", {
    params: { page: options.page || 1, role: options.role || "all", wallet },
  });

  output(data, (d) => {
    heading("Completed Jobs");
    if (d.data.length === 0) {
      log("  No completed jobs");
      return;
    }
    for (const j of d.data) {
      log(`  ${j.address} [${phaseLabel(j.phase)}] client=${j.client.slice(0, 8)}... budget=${j.budget} claimed=${j.amountClaimed}`);
    }
    log(`  Page ${d.pagination.page}, total: ${d.pagination.total}`);
  });
}
