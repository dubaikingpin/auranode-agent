/**
 * AuraNode autonomous agent core.
 * Loop: fetch SOL price → momentum signal → enforce spend limit → swap → log.
 */

import { loadState, saveState, recordTrade, recordError } from "./state.mjs";
import { momentumSignal } from "./strategy/momentum.mjs";
import { executeJupiterSwap } from "./jupiter.mjs";
import { resolveWallet } from "../cli/lib/wallet/resolve.js";
import { getAgentToken } from "../cli/lib/wallet/keystore.js";
import * as api from "../cli/lib/api/client.js";

const TRADE_AMOUNT_SOL_LAMPORTS  = 20_000_000;  // 0.02 SOL (above $1 min, leaves gas)
const TRADE_AMOUNT_USDC_LAMPORTS = 1_000_000;   // 1 USDC (6 decimals)
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

  const passphrase = getAgentToken();
  if (!passphrase) {
    log("No agent token — cannot trade. Set up with: zerion agent create-token");
    saveState(state);
    return;
  }

  const { walletName } = resolveWallet({});

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
