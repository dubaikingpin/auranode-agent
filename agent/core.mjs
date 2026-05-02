/**
 * AuraNode autonomous agent core.
 * Loop: fetch SOL price → momentum signal → enforce spend limit → swap → log.
 */

import { loadState, saveState, recordTrade, recordError } from "./state.mjs";
import { momentumSignal } from "./strategy/momentum.mjs";
import { fetchExchangeBalances, whaleFlowSignal, DEFAULT_EXCHANGE_WALLETS } from "./strategy/whale-flow.mjs";
import { executeJupiterSwap, getSolBalance } from "./jupiter.mjs";
import { resolveWallet } from "../cli/lib/wallet/resolve.js";
import { getAgentToken, getSolAddress } from "../cli/lib/wallet/keystore.js";

const TRADE_AMOUNT_SOL_LAMPORTS  = 20_000_000;  // 0.02 SOL (above $1 min, leaves gas)
const TRADE_AMOUNT_USDC_LAMPORTS = 1_000_000;   // 1 USDC (6 decimals)
const MIN_SOL_BALANCE_LAMPORTS   = 15_000_000;  // 0.015 SOL — kill switch floor
const TICK_MS = 60_000;            // 60s between ticks — stay within free tier
const MAX_PRICE_HISTORY = 20;
const PRICE_CACHE_MS = 25_000;     // reuse last price if < 25s old

let priceHistory = [];
let exchangeBalanceCache = null;
let running = false;
let tickTimer = null;
let _cachedPrice = null;
let _cachePriceTs = 0;
let _inFlight = false;

function log(msg) {
  const ts = new Date().toISOString();
  process.stdout.write(`[${ts}] ${msg}\n`);
}

async function getSolPrice() {
  if (_cachedPrice !== null && Date.now() - _cachePriceTs < PRICE_CACHE_MS) {
    return _cachedPrice;
  }
  try {
    const res = await fetch(
      "https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT",
      { signal: AbortSignal.timeout(10_000) }
    );
    if (!res.ok) throw new Error(`Binance ${res.status}`);
    const { price } = await res.json();
    const num = parseFloat(price);
    if (isNaN(num)) throw new Error("non-numeric price");
    _cachedPrice = num;
    _cachePriceTs = Date.now();
    return num;
  } catch (err) {
    throw new Error(`Price fetch failed: ${err.message}`);
  }
}

async function executeTrade(action, walletName, passphrase) {
  const amountLamports = action === "buy"
    ? TRADE_AMOUNT_USDC_LAMPORTS
    : TRADE_AMOUNT_SOL_LAMPORTS;

  return executeJupiterSwap({ action, walletName, passphrase, amountLamports });
}

async function tick(config) {
  const state = loadState();
  state.lastTick = new Date().toISOString();

  let price = null;
  try {
    price = await getSolPrice();
    if (!price) throw new Error("null price returned");
    state.lastPrice = price;
    priceHistory.push(price);
    if (priceHistory.length > MAX_PRICE_HISTORY) {
      priceHistory = priceHistory.slice(-MAX_PRICE_HISTORY);
    }
    log(`SOL price: $${price.toFixed(2)}`);
  } catch (err) {
    recordError(state, err);
    saveState(state);
    log(`Price error: ${err.message}`);
    return;
  }

  const { signal, reason } = momentumSignal(priceHistory, {
    threshold: config.threshold,
  });
  log(`Signal: ${signal} — ${reason}`);

  if (signal === "hold") {
    saveState(state);
    return;
  }

  // Whale exchange flow — runs only when momentum has a trade signal (saves RPC calls on hold)
  const currBalances = await fetchExchangeBalances(DEFAULT_EXCHANGE_WALLETS, getSolBalance);
  const whale = whaleFlowSignal(exchangeBalanceCache, currBalances);
  exchangeBalanceCache = currBalances;
  log(`Whale flow: ${whale.signal} — ${whale.reason}`);

  if (
    (signal === "buy"  && whale.signal === "bearish") ||
    (signal === "sell" && whale.signal === "bullish")
  ) {
    log(`Skipping ${signal}: whale flow contradicts momentum`);
    saveState(state);
    return;
  }

  const passphrase = getAgentToken();
  if (!passphrase) {
    log("No agent token — cannot trade. Set up with: zerion agent create-token");
    saveState(state);
    return;
  }

  const { walletName } = resolveWallet({});
  const solAddress = getSolAddress(walletName);

  const balanceLamports = await getSolBalance(solAddress);
  if (balanceLamports < MIN_SOL_BALANCE_LAMPORTS) {
    log(`Kill switch: ${(balanceLamports / 1e9).toFixed(4)} SOL below 0.015 floor — skipping trade`);
    saveState(state);
    return;
  }

  try {
    const desc = signal === "buy" ? "0.02 SOL → USDC" : "1 USDC → SOL";
    log(`Executing ${signal} via Jupiter: ${desc}`);
    const result = await executeTrade(signal, walletName, passphrase);

    const trade = recordTrade(state, {
      action: signal,
      fromToken: signal === "buy" ? "USDC" : "SOL",
      toToken: signal === "buy" ? "SOL" : "USDC",
      amount: signal === "buy" ? "1 USDC" : "0.02 SOL",
      price,
      txHash: result.hash,
      status: "success",
    });

    log(`Trade executed: ${result.hash} (impact ${result.priceImpactPct ?? "?"}%)`);
    saveState(state);
  } catch (err) {
    recordError(state, err);
    saveState(state);
    log(`Trade failed: ${err.message}`);
  }
}

export async function startAgent(config = {}) {
  if (running) {
    log("Agent already running");
    return;
  }

  running = true;
  const state = loadState();
  state.status = "running";
  state.startedAt = new Date().toISOString();
  saveState(state);
  log("AuraNode agent started");

  const loop = async () => {
    if (!running) return;
    if (_inFlight) {
      log("Tick skipped — previous tick still in flight");
    } else {
      _inFlight = true;
      try {
        await tick(config);
      } catch (err) {
        log(`Tick error: ${err.message}`);
      } finally {
        _inFlight = false;
      }
    }
    if (running) {
      tickTimer = setTimeout(loop, config.tickMs ?? TICK_MS);
    }
  };

  await loop();
}

export function stopAgent() {
  running = false;
  if (tickTimer) clearTimeout(tickTimer);
  const state = loadState();
  state.status = "stopped";
  saveState(state);
  log("AuraNode agent stopped");
}

export { priceHistory };
