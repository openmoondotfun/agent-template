import * as anchor from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, Transaction, type Keypair, type TransactionInstruction } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
  NATIVE_MINT,
} from "@solana/spl-token";
import axios from "axios";
import {
  getProgram,
  getKeypair,
  AnchorMemoType,
  hashContent,
  hashToHex,
} from "../../lib/program";
import {
  getAcpStatePda,
  getAgentFeeAuthorityPda,
  getJobPda,
  getMemoPda,
  getMemoSigPda,
  getEscrowVaultPda,
  getEscrowAuthorityPda,
  zeroHash,
} from "../../lib/pda";

import { getApiUrl } from "../../lib/config";
import { attachSellerSigning } from "./signedAxios";
const API_URL = getApiUrl();
const client = axios.create({ baseURL: API_URL });
attachSellerSigning(client);

/** Waits between further posts of a memo's text after the first one failed:
 *  about an hour in all, the window of the indexer's upload budget. */
const MEMO_TEXT_RETRY_MS = [5_000, 30_000, 120_000, 300_000, 600_000, 1_200_000, 1_800_000];
/** Hashes with retries under way, so a memo attempted again doesn't stack more. */
const retryingMemoText = new Set<string>();

/** Posts a memo's text to the indexer, before the memo that commits to it.
 *  Until the text is there nobody can read the memo, and the evaluator
 *  doesn't judge a Deliverable it can't read — so a post that failed for a
 *  reason that can pass (network, rate limit, server error) keeps retrying
 *  in the background while the memo goes ahead. */
async function postMemoText(hexHash: string, text: string, what: string): Promise<void> {
  const post = () => client.post("/memo-content", { hash: hexHash, text });
  const transient = (e: any) => {
    const status = e?.response?.status;
    return status === undefined || status === 429 || status >= 500;
  };
  const label = `${what} text (hash=${hexHash.slice(0, 12)}…)`;
  try {
    await post();
    return;
  } catch (e: any) {
    if (!transient(e)) {
      console.error(`[seller-api] ${label} refused by the indexer: ${e.message}`);
      return;
    }
    console.warn(`[seller-api] ${label} upload failed (${e.message}); retrying in the background`);
  }
  if (retryingMemoText.has(hexHash)) return;
  retryingMemoText.add(hexHash);
  void (async () => {
    try {
      for (const wait of MEMO_TEXT_RETRY_MS) {
        await new Promise((resolve) => setTimeout(resolve, wait));
        try {
          await post();
          console.log(`[seller-api] ${label} uploaded on retry`);
          return;
        } catch (e: any) {
          if (!transient(e)) break;
        }
      }
      console.error(`[seller-api] ${label} never reached the indexer — the memo stays unreadable`);
    } finally {
      retryingMemoText.delete(hexHash);
    }
  })();
}

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

/** Fetch job details from indexer (read-only) */
export async function getJobStatus(jobId: string) {
  const { data } = await client.get(`/acp/jobs/${jobId}`);
  return data;
}

/** Fetch on-chain job state directly from Solana */
export async function getOnChainJob(jobAddress: string): Promise<{ phase: number; memoCount: number }> {
  const program = getProgram();
  const jobPda = new PublicKey(jobAddress);
  const jobAccount = await (program.account as any).job.fetch(jobPda);
  return { phase: Number(jobAccount.phase), memoCount: Number(jobAccount.memoCount) };
}

/** Fetch full on-chain job account */
export async function getOnChainJobFull(jobAddress: string): Promise<any> {
  const program = getProgram();
  const jobPda = new PublicKey(jobAddress);
  return (program.account as any).job.fetch(jobPda);
}

/** Fetch on-chain job phase directly from Solana */
export async function getOnChainPhase(jobAddress: string): Promise<number> {
  const { phase } = await getOnChainJob(jobAddress);
  return phase;
}

/** Base units in a job's escrow vault; 0 when it was never funded. */
async function escrowVaultBalance(jobPda: PublicKey): Promise<bigint> {
  const escrowInfo = await getProgram().provider.connection.getAccountInfo(getEscrowVaultPda(jobPda));
  return escrowInfo ? Buffer.from(escrowInfo.data).readBigUInt64LE(64) : 0n;
}

/** True once the escrow vault holds budget + fee — exactly what
 *  deposit_to_escrow moves. The indexer's `budget` only mirrors set_budget
 *  (the price), not whether the client actually paid. */
export async function isEscrowFunded(jobAddress: string): Promise<boolean> {
  const program = getProgram();
  const jobPda = new PublicKey(jobAddress);
  const jobAccount = await (program.account as any).job.fetch(jobPda);
  const required = BigInt(jobAccount.budget.toString()) + BigInt(jobAccount.fee.toString());
  if (required === 0n) return false;
  return (await escrowVaultBalance(jobPda)) >= required;
}

/** Accept or reject a job by signing the JobRequest memo */
export async function acceptOrRejectJob(
  jobId: string,
  params: { accept: boolean; reason?: string }
) {
  const program = getProgram();
  const keypair = getKeypair();

  console.log(`[seller-api] ${params.accept ? "Accepting" : "Rejecting"} job ${jobId}`);

  const job = await getJobStatus(jobId);
  const jid = Number(job.jobId);
  const agentPda = new PublicKey(job.agent);
  const jobPda = getJobPda(agentPda, jid);

  const jobRequestMemo = job.memos?.find((m: any) => isMemoType(m, "JobRequest"));
  if (!jobRequestMemo) throw new Error("No JobRequest memo to sign");

  const memoSigPda = getMemoSigPda(jobPda, BigInt(jobRequestMemo.memoId), keypair.publicKey);
  const reasonHash = params.reason ? hashContent(params.reason) : zeroHash();

  if (params.reason) {
    const hexHash = hashToHex(reasonHash);
    await postMemoText(hexHash, params.reason, "reject reason");
  }

  const tx = await (program.methods as any)
    .signMemo(params.accept, reasonHash)
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

  console.log(`[seller-api] Job ${jobId} ${params.accept ? "accepted" : "rejected"}: ${tx}`);
  return { tx };
}

/** Sign a memo by its ID (generic — for signing Transaction memos etc.) */
export async function signMemoById(
  jobId: string,
  memoId: number,
  approve: boolean
) {
  const program = getProgram();
  const keypair = getKeypair();

  console.log(`[seller-api] Signing memo ${memoId} on job ${jobId} (approve=${approve})`);

  const job = await getJobStatus(jobId);
  const agentPda = new PublicKey(job.agent);
  const jobPda = getJobPda(agentPda, Number(job.jobId));
  const memoSigPda = getMemoSigPda(jobPda, BigInt(memoId), keypair.publicKey);

  const tx = await (program.methods as any)
    .signMemo(approve, zeroHash())
    .accounts({
      signer: keypair.publicKey,
      acpState: getAcpStatePda(),
      agent: agentPda,
      job: jobPda,
      memo: getMemoPda(jobPda, memoId),
      memoSignature: memoSigPda,
      escrowVault: getEscrowVaultPda(jobPda),
      systemProgram: SystemProgram.programId,
    })
    .signers([keypair])
    .rpc();

  console.log(`[seller-api] Memo ${memoId} signed on job ${jobId}: ${tx}`);
  return { tx };
}

/** Set budget + fee on a job (provider sets price) */
export async function setBudgetOnChain(
  jobId: string,
  budget: number,
  fee: number
): Promise<{ tx: string }> {
  const program = getProgram();
  const keypair = getKeypair();

  console.log(`[seller-api] Setting budget=${budget} fee=${fee} for job ${jobId}`);

  const job = await getJobStatus(jobId);
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

  console.log(`[seller-api] Budget set for job ${jobId}: budget=${budget} fee=${fee} tx=${tx}`);
  return { tx };
}

/** Create a memo on a job */
export async function createMemo(
  jobId: string,
  memoType: string,
  content: string
) {
  const program = getProgram();
  const keypair = getKeypair();

  console.log(`[seller-api] Creating ${memoType} memo for job ${jobId}`);

  const job = await getJobStatus(jobId);
  const jid = Number(job.jobId);
  const agentPda = new PublicKey(job.agent);
  const jobPda = getJobPda(agentPda, jid);

  const jobAccount = await (program.account as any).job.fetch(jobPda);
  const nextMemoId = Number(jobAccount.memoCount) + 1;
  const memoPda = getMemoPda(jobPda, nextMemoId);

  const anchorType = AnchorMemoType[memoType];
  if (!anchorType) throw new Error(`Invalid memoType: ${memoType}`);

  const contentHash = hashContent(content);
  const hexHash = hashToHex(contentHash);

  await postMemoText(hexHash, content, `${memoType} memo`);

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

  console.log(`[seller-api] Memo created for job ${jobId}: memoId=${nextMemoId} tx=${tx}`);
  return { memoId: nextMemoId, tx };
}

/** Whether `sender` has a memo of `memoType` ("deliverable", "general", ...)
 *  on the job, read from chain: the indexer can lag behind a memo that just
 *  landed, e.g. one whose transaction reported an error after all. */
export async function hasOnChainMemoFrom(
  jobId: string,
  memoType: string,
  sender: PublicKey
): Promise<boolean> {
  const program = getProgram();
  const job = await getJobStatus(jobId);
  const jobPda = getJobPda(new PublicKey(job.agent), Number(job.jobId));
  const jobAccount = await (program.account as any).job.fetch(jobPda);
  const count = Number(jobAccount.memoCount);
  if (count === 0) return false;
  const memoPdas = Array.from({ length: count }, (_, i) => getMemoPda(jobPda, i + 1));
  const memos: any[] = await (program.account as any).memo.fetchMultiple(memoPdas);
  return memos.some(
    (m) => m && m.sender.equals(sender) && Object.keys(m.memoType ?? {})[0] === memoType
  );
}

/** Withdraw budget from escrow into provider wallet.
 *  Returns claimed amount, payment mint, and client pubkey — used by swap and other offerings
 *  that need to operate with the escrowed funds before the job completes. */
export async function withdrawBudget(jobId: string): Promise<{
  tx: string;
  amountLamports: number;
  paymentMint: PublicKey;
  clientWallet: PublicKey;
} | null> {
  const program = getProgram();
  const keypair = getKeypair();

  console.log(`[seller-api] Withdrawing budget for job ${jobId}`);

  const job = await getJobStatus(jobId);
  const agentPda = new PublicKey(job.agent);
  const jobPda = getJobPda(agentPda, Number(job.jobId));

  const jobAccount = await (program.account as any).job.fetch(jobPda);
  const claimable = Number(jobAccount.budget) - Number(jobAccount.amountClaimed);
  if (claimable <= 0) {
    console.log(`[seller-api] Job ${jobId} — nothing to withdraw (already claimed)`);
    return null;
  }

  const escrowVault = getEscrowVaultPda(jobPda);
  const escrowInfo = await program.provider.connection.getAccountInfo(escrowVault);
  if (!escrowInfo) {
    console.log(`[seller-api] Job ${jobId} — escrow not initialized`);
    return null;
  }
  const escrowBalance = Buffer.from(escrowInfo.data).readBigUInt64LE(64);
  if (escrowBalance === 0n) {
    console.log(`[seller-api] Job ${jobId} — escrow empty`);
    return null;
  }

  const escrowAuthority = getEscrowAuthorityPda(jobPda);
  const paymentMint: PublicKey = jobAccount.paymentMint;
  const providerAta = getAssociatedTokenAddressSync(paymentMint, keypair.publicKey);

  const createProviderAta = createAssociatedTokenAccountIdempotentInstruction(
    keypair.publicKey,
    providerAta,
    keypair.publicKey,
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

  console.log(`[seller-api] Budget withdrawn for job ${jobId}: ${claimable} lamports, tx=${tx}`);
  return {
    tx,
    amountLamports: claimable,
    paymentMint,
    clientWallet: jobAccount.client,
  };
}

/** Claim budget from escrow (provider takes from budget) — legacy wrapper */
export async function claimBudget(jobId: string): Promise<{ tx: string | null; skipped?: boolean }> {
  const result = await withdrawBudget(jobId);
  if (!result) return { tx: null, skipped: true };
  return { tx: result.tx };
}

/** Push `amountLamports` from the provider's payment-mint ATA back into the
 *  job's escrow vault (refund_budget); the job's amount_refunded grows, which
 *  the app shows as refunded.
 *  - The program takes it in TRANSACTION, EVALUATION or REJECTED, not in
 *    COMPLETED; there is only something to refund after withdrawBudget
 *    (claim_budget runs from EVALUATION).
 *  - The amount may not exceed amount_claimed - amount_refunded: a larger
 *    one fails with NoBudgetToClaim, it is not capped.
 *  - Once the whole budget has been claimed and all of it refunded, the
 *    program moves the job to REJECTED, and claim_fee (the seller's
 *    settlement sweep, or the client) returns the escrow, fee included, to
 *    the client.
 *  - A partial refund doesn't end the job, and if the job then completes,
 *    the refunded part stays in escrow for good: claim_budget doesn't count
 *    refunds and claim_fee on a completed job pays out only the fee. Refund
 *    everything you claimed, or nothing.
 *  - The provider ATA must hold the amount. It is shared by every job paid
 *    in that mint. */
export async function refundBudget(
  jobId: string,
  amountLamports: number | bigint
): Promise<{ tx: string }> {
  const program = getProgram();
  const keypair = getKeypair();

  const job = await getJobStatus(jobId);
  const agentPda = new PublicKey(job.agent);
  const jobPda = getJobPda(agentPda, Number(job.jobId));

  const jobAccount = await (program.account as any).job.fetch(jobPda);
  const paymentMint: PublicKey = jobAccount.paymentMint;
  const providerAta = getAssociatedTokenAddressSync(paymentMint, keypair.publicKey);

  console.log(`[seller-api] Refunding ${amountLamports} lamports to escrow for job ${jobId}`);

  const tx = await (program.methods as any)
    .refundBudget(new anchor.BN(amountLamports.toString()))
    .accounts({
      provider: keypair.publicKey,
      agent: agentPda,
      job: jobPda,
      escrowVault: getEscrowVaultPda(jobPda),
      providerTokenAccount: providerAta,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([keypair])
    .rpc();

  console.log(`[seller-api] Refunded ${amountLamports} lamports for job ${jobId}: tx=${tx}`);
  return { tx };
}

/** End a funded job the offering can't complete (provider self-abandon).
 *  Claims whatever budget is still in escrow, then refunds everything claimed
 *  and not yet refunded. With the whole budget claimed and refunded the
 *  program moves the job to REJECTED, and claim_fee (the seller's settlement
 *  sweep, or the client) returns the escrow, fee included, to the client.
 *  Call it from executeJob (job in EVALUATION, before it expires), then throw.
 *  Only jobs with a budget (requiredFunds offerings) can be ended this way;
 *  returns null when nothing was claimed or is claimable.
 *  Precondition: this job's claimed tokens are still in the provider's
 *  payment-mint ATA. That ATA is shared by every job paid in the same mint,
 *  so the balance check below only catches a shortfall, not tokens that
 *  belong to other jobs: don't call it once the job's funds were swapped,
 *  unwrapped or forwarded. Throws if the ATA holds less than the amount to
 *  refund or a transaction fails. */
export async function refundClaimedBudget(jobId: string): Promise<{ withdrawTx: string | null; refundTx: string; refundedLamports: bigint } | null> {
  // claim_budget fails once the job has expired; refunding what was already
  // claimed still lets the client cancel the expired job.
  let withdrawTx: string | null = null;
  try {
    withdrawTx = (await withdrawBudget(jobId))?.tx ?? null;
  } catch (e: any) {
    console.warn(`[seller-api] Job ${jobId} — couldn't claim the rest of the budget before refunding: ${e.message}`);
  }
  const program = getProgram();
  const job = await getJobStatus(jobId);
  const jobPda = getJobPda(new PublicKey(job.agent), Number(job.jobId));
  const acc = await (program.account as any).job.fetch(jobPda);
  const outstanding = BigInt(acc.amountClaimed.toString()) - BigInt(acc.amountRefunded.toString());
  if (outstanding <= 0n) return null;
  const ata = getAssociatedTokenAddressSync(acc.paymentMint, getKeypair().publicKey);
  let balance = 0n;
  try {
    balance = BigInt((await program.provider.connection.getTokenAccountBalance(ata, "confirmed")).value.amount);
  } catch { /* no ATA: nothing to refund from */ }
  if (balance < outstanding) {
    throw new Error(`Job ${jobId}: provider token account holds ${balance}, ${outstanding} needed to refund; put the job's tokens back, then run "acp job refund ${jobId}"`);
  }
  try {
    const { tx } = await refundBudget(jobId, outstanding);
    return { withdrawTx, refundTx: tx, refundedLamports: outstanding };
  } catch (e: any) {
    throw new Error(`Job ${jobId}: refund of ${outstanding} failed (${e.message}); the provider still holds the claimed budget, run "acp job refund ${jobId}"`);
  }
}

/** Below this a job wallet's balance isn't worth refunding: the provider
 *  pays more in fees for the wrap and refund transactions. */
const JOB_WALLET_DUST_LAMPORTS = 10_000;

/** Refund what a wSOL job still owes its escrow (amount_claimed −
 *  amount_refunded) from the provider's own SOL, wrapped into its wSOL account
 *  first, when that's at most `maxLamports`. Use it after refunding a per-job
 *  wallet that held less than was withdrawn (fees or rent of a failed
 *  attempt): only a full refund rejects the job, which lets claim_fee return
 *  the escrow to the client; short of it the client can't even cancel the job
 *  after it expires. Returns null when nothing is owed, the job isn't paid in
 *  wSOL, or the gap is larger than `maxLamports` (left to the operator). */
export async function coverRefundShortfall(
  jobAddress: string,
  maxLamports: bigint
): Promise<{ lamports: bigint; wrapTx: string; refundTx: string } | null> {
  const program = getProgram();
  const providerKp = getKeypair();
  const connection = program.provider.connection;

  const job = await (program.account as any).job.fetch(new PublicKey(jobAddress));
  if (!job.paymentMint.equals(NATIVE_MINT)) return null;
  const owed = BigInt(job.amountClaimed.toString()) - BigInt(job.amountRefunded.toString());
  if (owed <= 0n) return null;
  if (owed > maxLamports) {
    console.warn(`[seller-api] Job ${jobAddress} — ${owed} lamports still owed to escrow, more than the ${maxLamports} the provider covers; left to the operator`);
    return null;
  }

  const providerWsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, providerKp.publicKey);
  const wrapTx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(
      providerKp.publicKey,
      providerWsolAta,
      providerKp.publicKey,
      NATIVE_MINT
    ),
    SystemProgram.transfer({
      fromPubkey: providerKp.publicKey,
      toPubkey: providerWsolAta,
      lamports: owed,
    }),
    createSyncNativeInstruction(providerWsolAta)
  );
  wrapTx.feePayer = providerKp.publicKey;
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  wrapTx.recentBlockhash = blockhash;
  wrapTx.lastValidBlockHeight = lastValidBlockHeight;
  wrapTx.sign(providerKp);

  const wrapSig = await connection.sendRawTransaction(wrapTx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });
  const wrapRes = await connection.confirmTransaction(
    { signature: wrapSig, blockhash, lastValidBlockHeight },
    "confirmed"
  );
  if (wrapRes.value.err) {
    throw new Error(`wrap of the shortfall failed: ${JSON.stringify(wrapRes.value.err)}`);
  }

  const { tx: refundTxSig } = await refundBudget(jobAddress, owed);
  console.log(
    `[seller-api] Job ${jobAddress} — provider covered ${owed} lamports owed to escrow (wrap=${wrapSig} refund=${refundTxSig})`
  );
  return { lamports: owed, wrapTx: wrapSig, refundTx: refundTxSig };
}

/** Refund leftover native SOL from a per-job wallet through ACP escrow. */
export async function refundJobWalletViaAcp(
  jobAddress: string,
  jobKeypair: Keypair
): Promise<{ refundLamports: number; wrapTx: string; refundTx: string } | null> {
  const program = getProgram();
  const providerKp = getKeypair();
  const connection = program.provider.connection;

  const balance = await connection.getBalance(jobKeypair.publicKey, "confirmed");
  if (balance <= JOB_WALLET_DUST_LAMPORTS) return null;
  // refund_budget fails, rather than capping, above what the job still owes
  // its escrow (amount_claimed - amount_refunded).
  const job = await (program.account as any).job.fetch(new PublicKey(jobAddress));
  const owed = BigInt(job.amountClaimed.toString()) - BigInt(job.amountRefunded.toString());
  if (owed <= 0n) return null;
  // Empty the job wallet into the provider: the provider pays the fees, and a
  // job wallet left below its rent-exempt minimum makes Solana reject the
  // transfer (InsufficientFundsForRent). Refund what the job owes out of it;
  // anything above that stays with the provider.
  const refundLamports = Number(BigInt(balance) < owed ? BigInt(balance) : owed);

  const providerWsolAta = getAssociatedTokenAddressSync(
    NATIVE_MINT,
    providerKp.publicKey
  );

  // One transaction: job wallet -> provider -> provider WSOL ATA + sync_native,
  // so native SOL can't be left on the provider between the steps.
  const wrapTx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: jobKeypair.publicKey,
      toPubkey: providerKp.publicKey,
      lamports: balance,
    }),
    createAssociatedTokenAccountIdempotentInstruction(
      providerKp.publicKey,
      providerWsolAta,
      providerKp.publicKey,
      NATIVE_MINT
    ),
    SystemProgram.transfer({
      fromPubkey: providerKp.publicKey,
      toPubkey: providerWsolAta,
      lamports: refundLamports,
    }),
    createSyncNativeInstruction(providerWsolAta)
  );
  wrapTx.feePayer = providerKp.publicKey;
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  wrapTx.recentBlockhash = blockhash;
  wrapTx.lastValidBlockHeight = lastValidBlockHeight;
  wrapTx.sign(providerKp, jobKeypair);

  const wrapSig = await connection.sendRawTransaction(wrapTx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });
  const wrapRes = await connection.confirmTransaction(
    { signature: wrapSig, blockhash, lastValidBlockHeight },
    "confirmed"
  );
  if (wrapRes.value.err) {
    throw new Error(
      `wrap to provider WSOL ATA failed: ${JSON.stringify(wrapRes.value.err)}`
    );
  }

  const { tx: refundTxSig } = await refundBudget(jobAddress, refundLamports);
  console.log(
    `[seller-api] Job ${jobAddress} — refunded ${refundLamports} lamports via ACP (wrap=${wrapSig} refund=${refundTxSig})`
  );
  return { refundLamports, wrapTx: wrapSig, refundTx: refundTxSig };
}

/** On-chain `job.phase` values claim_fee settles. */
const ONCHAIN_PHASE_COMPLETED = 4;
const ONCHAIN_PHASE_REJECTED = 5;

/** Settle a finished job's escrow via claim_fee: a completed job pays its fee
 *  out (protocol share to the treasury, the rest to the agent fee vault); a
 *  rejected one refunds whatever escrow still holds to the client. */
export async function claimFee(jobId: string): Promise<{ tx: string | null; skipped?: boolean }> {
  const program = getProgram();
  const keypair = getKeypair();

  const job = await getJobStatus(jobId);
  const agentPda = new PublicKey(job.agent);
  const jobPda = getJobPda(agentPda, Number(job.jobId));

  const jobAccount = await (program.account as any).job.fetch(jobPda);
  const phase = Number(jobAccount.phase);
  const settleable =
    phase === ONCHAIN_PHASE_COMPLETED
      ? Number(jobAccount.fee) > 0
      : phase === ONCHAIN_PHASE_REJECTED && (await escrowVaultBalance(jobPda)) > 0n;
  if (!settleable) {
    console.log(`[seller-api] Job ${jobId} — nothing to claim`);
    return { tx: null, skipped: true };
  }

  const acpStatePda = getAcpStatePda();
  const escrowVault = getEscrowVaultPda(jobPda);
  const escrowAuthority = getEscrowAuthorityPda(jobPda);

  const acpState = await (program.account as any).acpState.fetch(acpStatePda);
  // `acpState.platformTreasury` already IS the ATA (set by initialize_acp).
  // Deriving another ATA off it yields a non-existent account → #3012.
  const platformTreasuryAta: PublicKey = acpState.platformTreasury;
  const paymentMint: PublicKey = jobAccount.paymentMint;

  const clientPk = new PublicKey(job.client);
  const clientAta = getAssociatedTokenAddressSync(paymentMint, clientPk);
  const agentFeeAuthority = getAgentFeeAuthorityPda(agentPda);
  const agentFeeVault = getAssociatedTokenAddressSync(paymentMint, agentFeeAuthority, true);

  // claim_fee requires the client's token account even when nothing is paid
  // into it (completed jobs), and wallets close an emptied wSOL account — so
  // recreate it at our expense (token account rent), or the claim can't run.
  const preInstructions: TransactionInstruction[] = [];
  if (!(await program.provider.connection.getAccountInfo(clientAta))) {
    console.log(`[seller-api] Job ${jobId} — creating the client's token account ${clientAta.toBase58()}`);
    preInstructions.push(
      createAssociatedTokenAccountIdempotentInstruction(keypair.publicKey, clientAta, clientPk, paymentMint)
    );
  }

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
    .preInstructions(preInstructions)
    .signers([keypair])
    .rpc();

  console.log(`[seller-api] Fee claimed for job ${jobId}: tx=${tx}`);
  return { tx };
}

const NATIVE_MINT_STR = "So11111111111111111111111111111111111111112";

/** Close the provider's WSOL ATA (unwrapping its whole balance to native SOL
 *  on the provider) and transfer `lamports` of it to `destination`, in one
 *  transaction. Use it for a SOL-paid job whose work must be signed with native
 *  SOL from another wallet: claim_budget pays out wrapped SOL. The ATA's rent
 *  returns to the provider, and withdrawBudget recreates the ATA next time.
 *  The ATA is shared by all SOL-paid jobs, so this also unwraps WSOL claimed
 *  for jobs still in progress, and a later refundBudget for them finds no
 *  WSOL; acp-core's withdrawBudgetToJobKeypair avoids the shared ATA. */
export async function unwrapAndTransferSol(
  destination: PublicKey,
  lamports: number | bigint
): Promise<string> {
  const keypair = getKeypair();
  const connection = getProgram().provider.connection;

  const wsolAta = getAssociatedTokenAddressSync(
    new PublicKey(NATIVE_MINT_STR),
    keypair.publicKey
  );

  const tx = new Transaction().add(
    createCloseAccountInstruction(wsolAta, keypair.publicKey, keypair.publicKey),
    SystemProgram.transfer({
      fromPubkey: keypair.publicKey,
      toPubkey: destination,
      lamports: BigInt(lamports),
    })
  );
  tx.feePayer = keypair.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  tx.sign(keypair);

  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
    preflightCommitment: "confirmed",
  });
  await connection.confirmTransaction(sig, "confirmed");

  console.log(
    `[seller-api] Unwrapped WSOL ATA and sent ${lamports} lamports to ${destination.toBase58()}: ${sig}`
  );
  return sig;
}

/** Transfer SPL tokens (or native SOL) from provider wallet to a destination wallet.
 *  If closeSourceAta=true, appends a CloseAccount ix to reclaim rent (only for SPL, not SOL). */
export async function transferToken(
  mint: PublicKey,
  destinationWallet: PublicKey,
  amountLamports: number | bigint,
  closeSourceAta: boolean = false,
): Promise<string> {
  const keypair = getKeypair();
  const connection = getProgram().provider.connection;
  const tx = new Transaction();

  if (mint.toBase58() === NATIVE_MINT_STR) {
    // Native SOL transfer (Jupiter unwraps WSOL → SOL after swap)
    tx.add(
      SystemProgram.transfer({
        fromPubkey: keypair.publicKey,
        toPubkey: destinationWallet,
        lamports: BigInt(amountLamports),
      })
    );
  } else {
    const sourceAta = getAssociatedTokenAddressSync(mint, keypair.publicKey);
    const destAta = getAssociatedTokenAddressSync(mint, destinationWallet);

    // If closing the ATA after transfer, always use the actual ATA balance.
    // The quoted outAmount from Jupiter may differ from actual received (slippage/rounding).
    // Using real balance guarantees balance=0 before CloseAccount and avoids "insufficient funds".
    let transferAmount = BigInt(amountLamports);
    if (closeSourceAta) {
      try {
        const balanceResp = await connection.getTokenAccountBalance(sourceAta, "confirmed");
        const fullBalance = BigInt(balanceResp.value.amount);
        if (fullBalance !== transferAmount) {
          console.log(`[seller-api] ATA has ${fullBalance} but expected ${transferAmount} — using actual balance`);
        }
        transferAmount = fullBalance;
      } catch { /* ATA might not exist yet, proceed with original amount */ }
    }

    tx.add(
      createAssociatedTokenAccountIdempotentInstruction(
        keypair.publicKey,
        destAta,
        destinationWallet,
        mint
      ),
      createTransferInstruction(
        sourceAta,
        destAta,
        keypair.publicKey,
        transferAmount,
      ),
    );

    if (closeSourceAta) {
      tx.add(
        createCloseAccountInstruction(sourceAta, keypair.publicKey, keypair.publicKey)
      );
    }
  }

  tx.feePayer = keypair.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  tx.sign(keypair);

  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
    preflightCommitment: "confirmed",
  });
  await connection.confirmTransaction(sig, "confirmed");

  console.log(`[seller-api] Transferred ${amountLamports} of ${mint.toBase58()} to ${destinationWallet.toBase58()}${closeSourceAta ? " (closed source ATA)" : ""}: ${sig}`);
  return sig;
}
