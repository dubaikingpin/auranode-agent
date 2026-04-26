/**
 * Jupiter DEX swap for Solana — replaces Zerion swap API which is EVM-only.
 * Uses Jupiter v6 quote API (free, no key) + OWS for signing.
 */

import { Connection, VersionedTransaction } from "@solana/web3.js";
import { getSolanaRpcUrl } from "../cli/lib/chain/registry.js";
import * as ows from "../cli/lib/wallet/keystore.js";

const JUPITER_QUOTE_URL = "https://api.jup.ag/swap/v1/quote";
const JUPITER_SWAP_URL  = "https://api.jup.ag/swap/v1/swap";

// Solana token mints
export const SOL_MINT  = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

let _connection;
function getConnection() {
  if (!_connection) _connection = new Connection(getSolanaRpcUrl(), "confirmed");
  return _connection;
}

/**
 * Get a Jupiter swap quote.
 * @param {{ inputMint, outputMint, amount, slippageBps? }} opts
 */
export async function getJupiterQuote({ inputMint, outputMint, amount, slippageBps = 50 }) {
  const url = new URL(JUPITER_QUOTE_URL);
  url.searchParams.set("inputMint", inputMint);
  url.searchParams.set("outputMint", outputMint);
  url.searchParams.set("amount", String(amount));
  url.searchParams.set("slippageBps", String(slippageBps));

  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Jupiter quote error ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * Get a Jupiter serialized swap transaction.
 */
async function getJupiterSwapTx(quoteResponse, userPublicKey) {
  const res = await fetch(JUPITER_SWAP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse,
      userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: "auto",
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Jupiter swap tx error ${res.status}: ${body.slice(0, 200)}`);
  }
  const { swapTransaction } = await res.json();
  return swapTransaction; // base64-encoded VersionedTransaction
}

/**
 * Execute a Jupiter swap — quote → serialized tx → sign via OWS → broadcast.
 *
 * @param {{ action: "buy"|"sell", walletName: string, passphrase: string, amountLamports: number }} opts
 * @returns {{ hash: string, status: string, inAmount: string, outAmount: string }}
 */
export async function executeJupiterSwap({ action, walletName, passphrase, amountLamports }) {
  const solAddress = ows.getSolAddress(walletName);
  if (!solAddress) throw new Error(`No Solana address for wallet "${walletName}"`);

  const [inputMint, outputMint] = action === "buy"
    ? [USDC_MINT, SOL_MINT]
    : [SOL_MINT, USDC_MINT];

  // 1. Quote
  const quote = await getJupiterQuote({
    inputMint,
    outputMint,
    amount: amountLamports,
  });

  // 2. Serialized tx
  const swapTxBase64 = await getJupiterSwapTx(quote, solAddress);

  // 3. Deserialize VersionedTransaction — sign message bytes only, then inject signature.
  // OWS returns a raw 64-byte Ed25519 signature, not a reassembled transaction.
  const swapTxBytes = Buffer.from(swapTxBase64, "base64");
  const tx = VersionedTransaction.deserialize(swapTxBytes);
  const messageBytes = tx.message.serialize();
  const signResult = ows.signSolanaTransaction(walletName, Buffer.from(messageBytes).toString("hex"), passphrase);
  const sig = Buffer.from(signResult.signature, "hex");
  if (sig.length !== 64) throw new Error(`Expected 64-byte signature, got ${sig.length}`);
  tx.signatures[0] = sig;
  const signedBytes = Buffer.from(tx.serialize());

  // 4. Broadcast
  const connection = getConnection();
  const txHash = await connection.sendRawTransaction(signedBytes, {
    skipPreflight: true,
    maxRetries: 3,
  });
  await connection.confirmTransaction(txHash, "confirmed");

  return {
    hash: txHash,
    status: "success",
    inAmount: quote.inAmount,
    outAmount: quote.outAmount,
  };
}
