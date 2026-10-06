/**
 * Tests for refundClaimedBudget (sellerApi.ts) against a mocked indexer and
 * program (no network). It must claim what is left in escrow, then refund
 * everything claimed and not yet refunded from the provider's payment-mint
 * ATA, and refuse to refund when that ATA holds less than the job is owed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, NATIVE_MINT } from "@solana/spl-token";

/** Chain state the mocks read and update, in base units of the payment mint. */
const chain = vi.hoisted(() => ({
  agent: "",
  provider: null as any,
  program: null as any,
  budget: 0n,
  amountClaimed: 0n,
  amountRefunded: 0n,
  /** Balance of the job's escrow vault. */
  escrow: 0n,
  /** Balance of the provider's payment-mint ATA; null when it doesn't exist. */
  providerAta: null as bigint | null,
  claims: [] as bigint[],
  refunds: [] as bigint[],
  balanceQueries: [] as string[],
}));

vi.mock("axios", () => ({
  default: {
    create: () => ({
      get: async () => ({ data: { agent: chain.agent, jobId: 7 } }),
      post: async () => ({}),
    }),
  },
}));
vi.mock("./signedAxios", () => ({ attachSellerSigning: () => {} }));
vi.mock("../../lib/program", () => ({
  getProgram: () => chain.program,
  getKeypair: () => chain.provider,
  AnchorMemoType: {},
  hashContent: () => new Uint8Array(32),
  hashToHex: () => "",
}));

import { refundClaimedBudget } from "./sellerApi";

const JOB = "8LqoXjfS6hNpXo5DtgcEb8cUo4q52No5uhsmMYpb2PHp";
const MINT = NATIVE_MINT;

/** Anchor's chainable method builder; rpc() runs `send`. */
function builder(send: () => Promise<string>) {
  const b: any = { accounts: () => b, preInstructions: () => b, signers: () => b, rpc: send };
  return b;
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  chain.provider = Keypair.generate();
  chain.agent = Keypair.generate().publicKey.toBase58();
  chain.claims = [];
  chain.refunds = [];
  chain.balanceQueries = [];
  chain.program = {
    account: {
      job: {
        fetch: async () => ({
          budget: new BN(chain.budget.toString()),
          amountClaimed: new BN(chain.amountClaimed.toString()),
          amountRefunded: new BN(chain.amountRefunded.toString()),
          paymentMint: MINT,
          phase: 3,
        }),
      },
    },
    methods: {
      // claim_budget: escrow -> provider ATA
      claimBudget: (amount: BN) =>
        builder(async () => {
          const n = BigInt(amount.toString());
          chain.escrow -= n;
          chain.providerAta = (chain.providerAta ?? 0n) + n;
          chain.amountClaimed += n;
          chain.claims.push(n);
          return "claim-sig";
        }),
      // refund_budget: provider ATA -> escrow
      refundBudget: (amount: BN) =>
        builder(async () => {
          const n = BigInt(amount.toString());
          chain.providerAta = (chain.providerAta ?? 0n) - n;
          chain.escrow += n;
          chain.amountRefunded += n;
          chain.refunds.push(n);
          return "refund-sig";
        }),
    },
    provider: {
      connection: {
        // Only the escrow vault is read this way: its token amount sits at offset 64.
        getAccountInfo: async () => {
          const data = Buffer.alloc(165);
          data.writeBigUInt64LE(chain.escrow, 64);
          return { data };
        },
        getTokenAccountBalance: async (ata: PublicKey) => {
          chain.balanceQueries.push(ata.toBase58());
          if (chain.providerAta === null) throw new Error("could not find account");
          return { value: { amount: chain.providerAta.toString() } };
        },
      },
    },
  };
});

describe("refundClaimedBudget", () => {
  it("returns null for a fee-only job", async () => {
    Object.assign(chain, { budget: 0n, amountClaimed: 0n, amountRefunded: 0n, escrow: 50n, providerAta: null });

    await expect(refundClaimedBudget(JOB)).resolves.toBeNull();
    expect(chain.claims).toEqual([]);
    expect(chain.refunds).toEqual([]);
  });

  it("throws without refunding when the provider's token account holds less than is owed", async () => {
    // The whole budget was claimed earlier and part of it has been spent since.
    Object.assign(chain, { budget: 1000n, amountClaimed: 1000n, amountRefunded: 0n, escrow: 50n, providerAta: 400n });

    await expect(refundClaimedBudget(JOB)).rejects.toThrow(/holds 400, 1000 needed to refund/);
    expect(chain.claims).toEqual([]);
    expect(chain.refunds).toEqual([]);
  });

  it("claims the rest of the budget, then refunds amountClaimed - amountRefunded", async () => {
    // 600 claimed earlier, 100 of it refunded; escrow holds the other 400 of the
    // budget plus a 50 fee, and the provider ATA the 500 still owed.
    Object.assign(chain, { budget: 1000n, amountClaimed: 600n, amountRefunded: 100n, escrow: 550n, providerAta: 500n });

    const result = await refundClaimedBudget(JOB);

    expect(chain.claims).toEqual([400n]);
    expect(chain.refunds).toEqual([900n]);
    expect(result).toEqual({ withdrawTx: "claim-sig", refundTx: "refund-sig", refundedLamports: 900n });
    expect(chain.balanceQueries).toEqual([getAssociatedTokenAddressSync(MINT, chain.provider.publicKey).toBase58()]);
    // The whole budget is now claimed and refunded: the program would move the job to REJECTED.
    expect(chain.amountRefunded).toBe(chain.budget);
    expect(chain.providerAta).toBe(0n);
  });
});
