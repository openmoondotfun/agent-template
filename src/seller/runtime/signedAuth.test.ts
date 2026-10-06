/**
 * Tests for attachSellerSigning (signedAuth.ts). The indexer's
 * verifySignedRequest rebuilds the message `acp-seller-auth:<ts>:<METHOD>:<path>`
 * (path without query) and checks it against x-acp-pubkey; if this format
 * drifts, the seller's job poll gets 403 and memo texts come back null.
 */
import { describe, it, expect } from "vitest";
import nacl from "tweetnacl";
import { Keypair } from "@solana/web3.js";
import { attachSellerSigning } from "./signedAuth";

/** Capture the interceptor registered by attachSellerSigning. */
function fakeAxios() {
  let onFulfilled: ((cfg: any) => any) | null = null;
  return {
    instance: { interceptors: { request: { use: (fn: (cfg: any) => any) => { onFulfilled = fn; } } } },
    run: (cfg: any) => onFulfilled!(cfg),
  };
}

function verifies(cfg: any, method: string, path: string, kp: Keypair): boolean {
  const ts = cfg.headers["x-acp-timestamp"];
  const sig = Buffer.from(cfg.headers["x-acp-signature"], "base64");
  return nacl.sign.detached.verify(
    Buffer.from(`acp-seller-auth:${ts}:${method}:${path}`),
    sig,
    kp.publicKey.toBytes()
  );
}

describe("attachSellerSigning", () => {
  it("adds pubkey, timestamp and a signature bound to the method and the path without query", () => {
    const kp = Keypair.generate();
    const ax = fakeAxios();
    attachSellerSigning(ax.instance, () => kp);

    const cfg = ax.run({ method: "get", url: "/acp/jobs/active?wallet=abc", headers: {} });

    expect(cfg.headers["x-acp-pubkey"]).toBe(kp.publicKey.toBase58());
    expect(cfg.headers["x-acp-timestamp"]).toMatch(/^\d+$/);
    expect(verifies(cfg, "GET", "/acp/jobs/active", kp)).toBe(true);
    expect(verifies(cfg, "GET", "/acp/jobs/active?wallet=abc", kp)).toBe(false);
    expect(verifies(cfg, "POST", "/acp/jobs/active", kp)).toBe(false);
  });

  it("defaults the method to GET", () => {
    const kp = Keypair.generate();
    const ax = fakeAxios();
    attachSellerSigning(ax.instance, () => kp);

    const cfg = ax.run({ url: "/x", headers: {} });
    expect(verifies(cfg, "GET", "/x", kp)).toBe(true);
  });

  it("signs only the pathname of an absolute URL", () => {
    const kp = Keypair.generate();
    const ax = fakeAxios();
    attachSellerSigning(ax.instance, () => kp);

    const cfg = ax.run({ method: "put", url: "https://indexer.example/acp/agent/abc?x=1", headers: {} });
    expect(verifies(cfg, "PUT", "/acp/agent/abc", kp)).toBe(true);
  });

  it("passes the request through unsigned when the keypair getter throws", () => {
    const ax = fakeAxios();
    attachSellerSigning(ax.instance, () => {
      throw new Error("no keypair yet");
    });

    const cfg = ax.run({ method: "post", url: "/x", headers: {} });
    expect(cfg.headers["x-acp-pubkey"]).toBeUndefined();
    expect(cfg.headers["x-acp-signature"]).toBeUndefined();
  });
});
