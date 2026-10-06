/**
 * Singleton facade around `acp-core`'s `AcpClient`. Keeps the legacy
 * `getProgram()` / `getKeypair()` / `getConnection()` / `loadKeypair()` surface
 * used by CLI commands and the seller runtime, so nothing outside this file
 * needs to know we migrated to the shared lib.
 */
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair } from "@solana/web3.js";
import fs from "fs";
import path from "path";
import { AcpClient } from "acp-core";
import { getWalletKey, getRpcUrl, ROOT } from "./config";

export { AnchorMemoType, hashContent, hashToHex } from "acp-core";

let _client: AcpClient | null = null;
let _keypair: Keypair | null = null;
let _connection: Connection | null = null;

/** Reset cached singletons (needed when switching agents) */
export function resetCache(): void {
  _client = null;
  _keypair = null;
  _connection = null;
}

/** A keypair from a JSON array of secret-key bytes, or from a keypair file
 *  (a path relative to the project root unless absolute). */
export function parseKeypair(raw: string): Keypair {
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(trimmed)));
  }
  const resolved = path.isAbsolute(trimmed)
    ? trimmed
    : path.resolve(ROOT, trimmed);
  const secretKey = JSON.parse(fs.readFileSync(resolved, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(secretKey));
}

export function loadKeypair(walletPathOrKey?: string): Keypair {
  if (_keypair) return _keypair;

  const raw = walletPathOrKey || getWalletKey();

  if (!raw) {
    throw new Error(
      "No wallet configured. Run `acp setup` or set wallet in config.json"
    );
  }

  _keypair = parseKeypair(raw);
  return _keypair;
}

export function getConnection(): Connection {
  if (_connection) return _connection;
  _connection = new Connection(getRpcUrl(), "confirmed");
  return _connection;
}

/** acp-core loads its bundled IDL first; this copy is used only when that is missing. */
function idlFallbackPaths(): string[] {
  return [path.resolve(ROOT, "idl", "virtuals_acp.json")];
}

function getClient(): AcpClient {
  if (_client) return _client;
  _client = new AcpClient({
    connection: getConnection(),
    keypair: loadKeypair(),
    idlCandidates: idlFallbackPaths(),
  });
  return _client;
}

// Return type is inferred from `AcpClient.program` so we pick up the
// anchor `Program` type from acp-core's resolved @coral-xyz/anchor
// install. An explicit `anchor.Program` annotation here would use
// acp-template's own anchor resolution and break on TS structural
// equality when the two node_modules copies diverge even slightly.
export function getProgram(): ReturnType<typeof getClient>["program"] {
  return getClient().program;
}

export function getKeypair(): Keypair {
  return loadKeypair();
}

/** Expose the `AcpClient` directly for callers that want the high-level API. */
export function getAcpClient(): AcpClient {
  return getClient();
}
