import nacl from "tweetnacl";

/** Minimal shape we need from a Solana keypair — matches `@solana/web3.js`
 *  `Keypair` (publicKey.toBase58() + secretKey) without importing it. */
export interface SignerKeypair {
  publicKey: { toBase58(): string };
  secretKey: Uint8Array;
}

/** Minimal structural view of an axios-like instance — just the request
 *  interceptor hook, so any `AxiosInstance` satisfies it. */
export interface RequestSignable {
  interceptors: {
    request: {
      use(onFulfilled: (config: any) => any): unknown;
    };
  };
}

/**
 * Attach ed25519 signing headers to every request on `axiosInstance`.
 *
 * A seller runtime has no Privy session, so REST endpoints that gate by wallet
 * (e.g. /acp/jobs/active) need an out-of-band auth path. We sign a fresh
 * timestamp + method + path with the provider keypair on each request; the
 * indexer (`verifySignedRequest`) verifies the pubkey matches the route.
 *
 * Stateless on both sides — no nonce store, no shared secret. Replay window is
 * ±60s and the signature is bound to method+path so a captured header can't be
 * reused against a different endpoint.
 *
 * `getKeypair` is a lazy getter rather than a fixed keypair so callers can wire
 * in a singleton that may not be loaded when signing is attached (and so the
 * active agent can switch underneath it). If it throws or returns nothing the
 * request goes through unsigned — the indexer will answer 403 and the caller
 * logs it.
 */
export function attachSellerSigning(
  axiosInstance: RequestSignable,
  getKeypair: () => SignerKeypair
): void {
  axiosInstance.interceptors.request.use((cfg) => {
    try {
      const kp = getKeypair();
      const ts = Math.floor(Date.now() / 1000).toString();
      const method = (cfg.method || "get").toUpperCase();
      // Axios composes baseURL + url; we only want the path portion (without
      // query) so the indexer signature check matches its computed path.
      const rawUrl = cfg.url || "";
      const path = rawUrl.startsWith("http")
        ? new URL(rawUrl).pathname
        : rawUrl.split("?")[0];
      const message = `acp-seller-auth:${ts}:${method}:${path}`;
      const sig = nacl.sign.detached(Buffer.from(message), kp.secretKey);
      cfg.headers = cfg.headers || {};
      (cfg.headers as Record<string, string>)["x-acp-pubkey"] = kp.publicKey.toBase58();
      (cfg.headers as Record<string, string>)["x-acp-timestamp"] = ts;
      (cfg.headers as Record<string, string>)["x-acp-signature"] = Buffer.from(sig).toString("base64");
    } catch {
      // Signing failed (e.g. keypair not loaded yet) — send unsigned.
    }
    return cfg;
  });
}
