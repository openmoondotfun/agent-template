import axios from "axios";
import nacl from "tweetnacl";
import type { Keypair } from "@solana/web3.js";
import { getApiUrl, getActiveAgent } from "./config";
import { getKeypair, parseKeypair } from "./program";
import { debug } from "./output";
import { attachSellerSigning } from "../seller/runtime/signedAxios";

export function createClient() {
  const client = axios.create({
    baseURL: getApiUrl(),
    headers: { "Content-Type": "application/json" },
  });
  // Lets the indexer show this wallet's jobs and memo texts.
  attachSellerSigning(client);

  client.interceptors.response.use(
    (res) => res,
    (err) => {
      const data = err.response?.data;
      if (data) {
        const e = new Error(typeof data === "string" ? data : JSON.stringify(data));
        // Keep the HTTP status so callers can tell a passing failure from a refusal.
        (e as any).status = err.response?.status;
        throw e;
      }
      throw err;
    }
  );

  return client;
}

// Singleton
let _client: ReturnType<typeof createClient> | null = null;

export function getClient() {
  if (!_client) _client = createClient();
  return _client;
}

/** Body fields the indexer takes as proof of wallet ownership on agent
 *  updates (PUT /acp/agent/:id): the wallet's signature over a fresh nonce.
 *  The wallet must be the agent's on-chain creator or provider. */
export function signedWalletFields(keypair: Keypair = getKeypair()): { wallet: string; signature: string; nonce: string } {
  const nonce = `acp-auth-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const signature = Buffer.from(nacl.sign.detached(Buffer.from(nonce), keypair.secretKey)).toString("base64");
  return { wallet: keypair.publicKey.toBase58(), signature, nonce };
}

/**
 * The key that signs agent updates (PUT /acp/agent/:id). The indexer lets
 * only the agent's creator or provider update it. config.json holds the
 * provider key the seller registers its offerings with, so that key comes
 * first: an agent imported from the app has a creator other than WALLET_KEY.
 * Falls back to the CLI's own key when the active agent has no readable key.
 */
export function agentUpdateSigner(): Keypair {
  const wallet = getActiveAgent()?.wallet;
  if (wallet) {
    try {
      return parseKeypair(wallet);
    } catch (e) {
      debug("config.json: the active agent's wallet is not a readable key", e);
    }
  }
  return getKeypair();
}
