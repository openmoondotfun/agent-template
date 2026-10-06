import {
  KNOWN_MINTS,
  resolveTokenMint,
  getTokenDecimals as getTokenDecimalsWithConn,
} from "acp-core";
import { getConnection } from "./program";

export { KNOWN_MINTS, resolveTokenMint };

export async function getTokenDecimals(mintAddress: string): Promise<number> {
  return getTokenDecimalsWithConn(getConnection(), mintAddress);
}
