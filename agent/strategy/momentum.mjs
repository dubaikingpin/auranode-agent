/**
 * Momentum strategy — compare current SOL price to N-tick rolling window.
 * Signal: BUY when price rose > threshold, SELL when fell > threshold, HOLD otherwise.
 */

const DEFAULT_THRESHOLD = 0.015; // 1.5% move
const MIN_WINDOW = 3;            // need at least 3 price samples

/**
 * @param {number[]} priceHistory - array of prices, oldest first
 * @param {object}  [opts]
 * @param {number}  [opts.threshold] - fractional change required (default 0.015 = 1.5%)
 * @returns {{ signal: "buy" | "sell" | "hold", change: number, reason: string }}
 */
export function momentumSignal(priceHistory, opts = {}) {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;

  if (priceHistory.length < MIN_WINDOW) {
    return { signal: "hold", change: 0, reason: "insufficient history" };
  }

  const current = priceHistory[priceHistory.length - 1];
  const anchor = priceHistory[priceHistory.length - MIN_WINDOW];

  if (!anchor || anchor === 0) {
    return { signal: "hold", change: 0, reason: "anchor price zero" };
  }

  const change = (current - anchor) / anchor;

  if (change > threshold || (threshold <= 0.0001 && change > 0)) {
    return {
      signal: "buy",
      change,
      reason: `price up ${(change * 100).toFixed(4)}%`,
    };
  }

  if (change < -threshold || (threshold <= 0.0001 && change < 0)) {
    return {
      signal: "sell",
      change,
      reason: `price down ${(change * 100).toFixed(4)}%`,
    };
  }

  return {
    signal: "hold",
    change,
    reason: `no price movement`,
  };
}
