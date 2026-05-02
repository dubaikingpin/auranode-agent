/**
 * Whale exchange flow signal — tracks net SOL movement into/out of known exchange
 * hot wallets. Net outflow (exchanges losing SOL) → accumulation signal (bullish).
 * Net inflow (SOL piling into exchanges) → sell pressure signal (bearish).
 *
 * Uses public Solana RPC getBalance — no API key required.
 * Safe failure mode: if addresses are stale or unreachable, returns "neutral".
 */

// Publicly-known Solana exchange hot wallet addresses.
// Can be overridden via WHALE_WATCH_ADDRESSES env var (comma-separated).
export const DEFAULT_EXCHANGE_WALLETS = (
  process.env.WHALE_WATCH_ADDRESSES
    ? process.env.WHALE_WATCH_ADDRESSES.split(",").map((s) => s.trim()).filter(Boolean)
    : [
        "5tzFkiKscXHK5ZXCGbXZxdw7gm3XboYSoFfXJkFEGV2", // Binance hot wallet
        "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", // Binance hot wallet #2
      ]
);

// 1000 SOL net move in a single tick = significant whale signal
const NET_FLOW_THRESHOLD_LAMPORTS = 1_000 * 1e9;

/**
 * Fetch current SOL balances for a list of addresses.
 * Silently skips addresses that fail (invalid address, RPC error, etc.).
 *
 * @param {string[]} addresses
 * @param {(address: string) => Promise<number>} getSolBalance
 * @returns {Promise<Record<string, number>>}
 */
export async function fetchExchangeBalances(addresses, getSolBalance) {
  const results = {};
  await Promise.allSettled(
    addresses.map(async (addr) => {
      try {
        results[addr] = await getSolBalance(addr);
      } catch {
        // skip — stale address or RPC hiccup; neutral signal is the safe default
      }
    })
  );
  return results;
}

/**
 * Compare two balance snapshots and return a directional signal.
 *
 * @param {Record<string, number> | null} prevBalances  - balances from the previous tick
 * @param {Record<string, number>}        currBalances  - balances from the current tick
 * @returns {{ signal: "bullish" | "bearish" | "neutral", reason: string }}
 */
export function whaleFlowSignal(prevBalances, currBalances) {
  if (!prevBalances || Object.keys(prevBalances).length === 0) {
    return { signal: "neutral", reason: "no baseline yet" };
  }

  let netDeltaLamports = 0;
  for (const addr of Object.keys(currBalances)) {
    if (prevBalances[addr] != null) {
      netDeltaLamports += currBalances[addr] - prevBalances[addr];
    }
  }

  const netDeltaSol = netDeltaLamports / 1e9;

  if (netDeltaLamports > NET_FLOW_THRESHOLD_LAMPORTS) {
    return { signal: "bearish", reason: `+${netDeltaSol.toFixed(0)} SOL into exchanges` };
  }
  if (netDeltaLamports < -NET_FLOW_THRESHOLD_LAMPORTS) {
    return { signal: "bullish", reason: `${netDeltaSol.toFixed(0)} SOL out of exchanges` };
  }
  return { signal: "neutral", reason: `net ${netDeltaSol.toFixed(0)} SOL (below threshold)` };
}
