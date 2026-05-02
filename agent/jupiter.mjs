/**
 * Jupiter DEX swap for Solana — replaces Zerion swap API which is EVM-only.
 * Uses Jupiter v6 quote API (free, no key) + OWS for signing.
 */

import { Connection, PublicKey, VersionedTransaction } from "@solana/web3.js";
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

export async function getSolBalance(address) {
  return getConnection().getBalance(new PublicKey(address));
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
export async function executeJupiterSwap({ action, walletName, passphrase, amountLamports, maxPriceImpactPct = 0.5 }) {
  const solAddress = ows.getSolAddress(walletName);
  if (!solAddress) throw new Error(`No Solana address for wallet "${walletName}"`);

  const [inputMint, outputMint] = action === "buy"
    ? [USDC_MINT, SOL_MINT]
    : [SOL_MINT, USDC_MINT];

  const connection = getConnection();
  // Fetch blockhash before building tx — gives confirmTransaction the full ~90s block TTL
  // instead of the deprecated string-based API's hardcoded 30s wall-clock timeout.
  const latestBlockhash = await connection.getLatestBlockhash("confirmed");

  // 1. Quote
  const quote = await getJupiterQuote({
    inputMint,
    outputMint,
    amount: amountLamports,
  });

  const impact = parseFloat(quote.priceImpactPct ?? 0);
  if (impact > maxPriceImpactPct) {
    throw new Error(`Price impact ${impact.toFixed(3)}% exceeds max ${maxPriceImpactPct}% — skipping trade`);
  }

  // 2. Serialized tx
  const swapTxBase64 = await getJupiterSwapTx(quote, solAddress);

  // 3. Sign: pass full tx bytes to OWS, inject returned 64-byte sig into VersionedTransaction.
  const swapTxBytes = Buffer.from(swapTxBase64, "base64");
  const signResult = ows.signSolanaTransaction(walletName, swapTxBytes.toString("hex"), passphrase);
  const sig = Buffer.from(signResult.signature, "hex");

  const tx = VersionedTransaction.deserialize(swapTxBytes);
  if (sig.length !== 64) throw new Error(`Expected 64-byte signature, got ${sig.length}`);
  tx.signatures[0] = new Uint8Array(sig);
  const signedBytes = tx.serialize();

  // 4. Broadcast + confirm using blockhash strategy (~90s TTL, not hardcoded 30s)
  const txHash = await connection.sendRawTransaction(signedBytes, {
    skipPreflight: true,
    maxRetries: 3,
  });
  await connection.confirmTransaction({
    signature: txHash,
    blockhash: latestBlockhash.blockhash,
    lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
  }, "confirmed");

  return {
    hash: txHash,
    status: "success",
    inAmount: quote.inAmount,
    outAmount: quote.outAmount,
    priceImpactPct: quote.priceImpactPct,
  };
}
