import type { AxiosInstance } from "axios";
import { attachSellerSigning as coreAttachSellerSigning } from "./signedAuth";
import { getKeypair } from "../../lib/program";

/**
 * Signs every request on `axiosInstance` with the active keypair (see
 * signedAuth.ts). The indexer serves a wallet's jobs, and memo texts, only to
 * a caller that proves it controls the wallet.
 */
export function attachSellerSigning(axiosInstance: AxiosInstance): void {
  coreAttachSellerSigning(axiosInstance, getKeypair);
}
