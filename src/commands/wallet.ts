import { getAssociatedTokenAddressSync, getAccount, NATIVE_MINT } from "@solana/spl-token";
import { output, field, heading, log, debug } from "../lib/output";
import { getKeypair, getProgram, getConnection } from "../lib/program";
import { getAcpStatePda } from "../lib/pda";
import { PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";

export async function address() {
  const keypair = getKeypair();
  output({ wallet: keypair.publicKey.toBase58() }, (d) => {
    heading("Wallet");
    field("Address", d.wallet);
  });
}

export async function balance() {
  const keypair = getKeypair();
  const program = getProgram();
  const connection = (program.provider as anchor.AnchorProvider).connection;

  const wallet = keypair.publicKey;
  const solBalance = await connection.getBalance(wallet);

  // The platform's payment token (acpState.paymentToken, wSOL by default).
  // Deposits close the client's wSOL account afterwards, so a missing token
  // account is normal and means 0.
  let paymentMint = "";
  let paymentBalance = "0";
  try {
    const acpState = await (program.account as any).acpState.fetch(getAcpStatePda());
    const mint: PublicKey = acpState.paymentToken;
    paymentMint = mint.toBase58();
    const ata = getAssociatedTokenAddressSync(mint, wallet);
    const tokenAccount = await getAccount(connection, ata);
    paymentBalance = tokenAccount.amount.toString();
  } catch (e) { debug("wallet: payment-token balance", e); }

  const mintLabel = !paymentMint
    ? "(unknown)"
    : paymentMint === NATIVE_MINT.toBase58() ? `${paymentMint} (wSOL)` : paymentMint;

  output(
    {
      wallet: wallet.toBase58(),
      sol: solBalance / 1e9,
      solLamports: solBalance,
      // `usdc` is the payment-token balance under its old name, kept for scripts.
      usdc: paymentBalance,
      paymentToken: paymentBalance,
      paymentMint,
    },
    (d) => {
      heading("Wallet Balance");
      field("Address", d.wallet);
      field("SOL", d.sol);
      field("Payment token (raw)", d.paymentToken);
      field("Payment mint", mintLabel);
    }
  );
}

export async function airdrop(amount?: number) {
  const keypair = getKeypair();
  const connection = getConnection();
  const wallet = keypair.publicKey;
  const sol = amount || 1;

  log(`  Requesting ${sol} SOL airdrop to ${wallet.toBase58()}...`);

  try {
    const sig = await connection.requestAirdrop(wallet, sol * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig, "confirmed");
    output({ success: true, signature: sig, amount: sol }, (d) => {
      heading("Airdrop");
      field("Amount", `${d.amount} SOL`);
      field("Signature", d.signature);
    });
  } catch (e: any) {
    output({ error: e.message }, () => {
      log(`  Airdrop failed: ${e.message}`);
      log("  Airdrop only works on devnet/localnet. For mainnet, transfer SOL manually.\n");
    });
  }
}
