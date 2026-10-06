/**
 * Unit tests for the per-job keypair derivation — the canonical
 * implementation lives in `acp-core`, this test file sits here because
 * `acp-core` doesn't ship its own vitest setup.
 *
 * We verify:
 *   1. Same `(providerKp, jobAddress)` always produces the same keypair.
 *      Load-bearing: any process holding the provider secret must be
 *      able to reconstruct the job keypair for cleanup / inspection.
 *   2. Different jobs under the same provider → disjoint keypairs.
 *      If two jobs collided, budgets would mix — worse than the
 *      shared-ATA flaw.
 *   3. Different providers → disjoint keypairs for the same job.
 *      A provider rotation must not accidentally grant the new key
 *      access to a past job's vault.
 *   4. Derived seed is a valid 32-byte Ed25519.
 */
import { describe, it, expect } from "vitest";
import { Keypair } from "@solana/web3.js";
import { deriveJobKeypair } from "acp-core";

const JOB_A = "8LqoXjfS6hNpXo5DtgcEb8cUo4q52No5uhsmMYpb2PHp";
const JOB_B = "AbCdEfGhIjKlMnOpQrStUvWxYz1234567890aBcDeFgH";

function makeProvider(seedByte: number): Keypair {
  const seed = Buffer.alloc(32, seedByte);
  return Keypair.fromSeed(seed);
}

describe("deriveJobKeypair", () => {
  it("is deterministic for the same (provider, job)", () => {
    const provider = makeProvider(0x11);
    const first = deriveJobKeypair(provider, JOB_A);
    const second = deriveJobKeypair(provider, JOB_A);
    expect(first.publicKey.equals(second.publicKey)).toBe(true);
    expect(
      Buffer.from(first.secretKey).equals(Buffer.from(second.secretKey))
    ).toBe(true);
  });

  it("yields distinct keypairs for different jobs under the same provider", () => {
    const provider = makeProvider(0x22);
    const forA = deriveJobKeypair(provider, JOB_A);
    const forB = deriveJobKeypair(provider, JOB_B);
    expect(forA.publicKey.equals(forB.publicKey)).toBe(false);
  });

  it("yields distinct keypairs for the same job under different providers", () => {
    const providerX = makeProvider(0x33);
    const providerY = makeProvider(0x44);
    const forX = deriveJobKeypair(providerX, JOB_A);
    const forY = deriveJobKeypair(providerY, JOB_A);
    expect(forX.publicKey.equals(forY.publicKey)).toBe(false);
  });

  it("produces a valid 32-byte Ed25519 keypair (sanity)", () => {
    const provider = makeProvider(0x55);
    const kp = deriveJobKeypair(provider, JOB_A);
    expect(kp.secretKey.length).toBe(64);
    expect(kp.publicKey.toBytes().length).toBe(32);
  });

  it("is sensitive to the full job address, not just a prefix", () => {
    const provider = makeProvider(0x66);
    const full = deriveJobKeypair(provider, JOB_A);
    const tampered = JOB_A.slice(0, 10) + "X" + JOB_A.slice(11);
    const nearly = deriveJobKeypair(provider, tampered);
    expect(full.publicKey.equals(nearly.publicKey)).toBe(false);
  });

  it("does not leak provider key bytes into the output address", () => {
    const provider = makeProvider(0x77);
    const kp = deriveJobKeypair(provider, JOB_A);
    const secretHex = Buffer.from(provider.secretKey).toString("hex");
    const pubHex = Buffer.from(kp.publicKey.toBytes()).toString("hex");
    for (let i = 0; i <= 32 - 8; i++) {
      const slice = secretHex.slice(i * 2, (i + 8) * 2);
      expect(pubHex.includes(slice)).toBe(false);
    }
  });
});
