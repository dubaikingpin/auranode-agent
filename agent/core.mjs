/**
 * AuraNode autonomous agent core.
 * Loop: fetch SOL price → momentum signal → enforce spend limit → swap → log.
 */

import { loadState, saveState, recordTrade, recordError } from "./state.mjs";
import { momentumSignal } from "./strategy/momentum.mjs";
import { getSwapQuote, executeSwap } from "../cli/lib/trading/swap.js";
import { resolveWallet } from "../cli/lib/wallet/resolve.js";
import { getAgentToken } from "../cli/lib/wallet/keystore.js";
import * as api from "../cli/lib/api/client.js";

const TRADE_AMOUNT_SOL = "0.02";   // 0.02 SOL per sell (~$1.73, above $1 min swap)
const TRADE_AMOUNT_USDC = "1";     // $1 USDC per buy (matches wallet balance)
const TICK_MS = 60_000;            // 60s between ticks — stay within free tier
const MAX_PRICE_HISTORY = 20;
const PRICE_CACHE_MS = 25_000;     // reuse last price if < 25s old

let priceHistory = [];
let running = false;
let tickTimer = null;
let _cachedPrice = null;
let _cachePriceTs = 0;

function log(msg) {
  const ts = new Date().toISOString();
  process.stdout.write(`[${ts}] ${msg}\n`);
}

async function getSolPrice() {
  if (_cachedPrice !== null && Date.now() - _cachePriceTs < PRICE_CACHE_MS) {
    return _cachedPrice;
  }
  try {
    const res = await api.searchFungibles("SOL", { chain: "solana" });
    const sol = (res.data || []).find(
      (f) => f.attributes?.symbol?.toUpperCase() === "SOL"
    );
    const price = sol?.attributes?.market_data?.price ?? null;
    if (typeof price === "number") {
      _cachedPrice = price;
      _cachePriceTs = Date.now();
    }
    return price;
  } catch (err) {
    throw new Error(`Price fetch failed: ${err.message}`);
  }
}

async function executeTrade(action, walletName, walletAddress, passphrase) {
  const isSOL = action === "buy";
  const fromToken = isSOL ? "USDC" : "SOL";
  const toToken = isSOL ? "SOL" : "USDC";
  const amount = isSOL ? TRADE_AMOUNT_USDC : TRADE_AMOUNT_SOL;

  const quote = await getSwapQuote({
    fromToken,
    toToken,
    amount,
    fromChain: "solana",
    toChain: "solana",
    walletAddress,
  });

  if (quote.preconditions.enough_balance === false) {
    throw new Error(`Insufficient ${fromToken} balance`);
  }

  const result = await executeSwap(quote, walletName, passphrase);
  return { quote, result };
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

  const passphrase = getAgentToken();
  if (!passphrase) {
    log("No agent token — cannot trade. Set up with: zerion agent create-token");
    saveState(state);
    return;
  }

  const { walletName, address: walletAddress } = resolveWallet({});

  try {
    log(`Executing ${signal}: ${signal === "buy" ? `${TRADE_AMOUNT_USDC} USDC → SOL` : `${TRADE_AMOUNT_SOL} SOL → USDC`}`);
    const { quote, result } = await executeTrade(signal, walletName, walletAddress, passphrase);

    const trade = recordTrade(state, {
      action: signal,
      fromToken: signal === "buy" ? "USDC" : "SOL",
      toToken: signal === "buy" ? "SOL" : "USDC",
      amount: signal === "buy" ? TRADE_AMOUNT_USDC : TRADE_AMOUNT_SOL,
      price,
      txHash: result.hash,
      status: result.status === "success" ? "success" : "failed",
    });

    log(`Trade executed: ${result.hash} (${result.status})`);
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
    try {
      await tick(config);
    } catch (err) {
      log(`Tick error: ${err.message}`);
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
