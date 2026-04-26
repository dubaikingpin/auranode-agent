/**
 * Agent state — JSON file persistence for trade history and PnL tracking.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const STATE_PATH = join(homedir(), ".auranode", "agent-state.json");

function ensureDir() {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
}

function defaultState() {
  return {
    status: "stopped",
    startedAt: null,
    lastTick: null,
    lastPrice: null,
    totalTrades: 0,
    totalPnlUsdc: 0,
    trades: [],
    errors: [],
  };
}

export function loadState() {
  try {
    const raw = readFileSync(STATE_PATH, "utf-8");
    return { ...defaultState(), ...JSON.parse(raw) };
  } catch {
    return defaultState();
  }
}

export function saveState(state) {
  ensureDir();
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

export function recordTrade(state, trade) {
  const entry = {
    id: Date.now(),
    timestamp: new Date().toISOString(),
    action: trade.action,       // "buy" | "sell"
    fromToken: trade.fromToken,
    toToken: trade.toToken,
    amount: trade.amount,
    price: trade.price,
    txHash: trade.txHash,
    status: trade.status,       // "success" | "failed"
    pnlUsdc: trade.pnlUsdc ?? null,
  };

  state.trades = [entry, ...state.trades].slice(0, 100);
  state.totalTrades += 1;
  if (entry.pnlUsdc) state.totalPnlUsdc += entry.pnlUsdc;
  return entry;
}

export function recordError(state, err) {
  const entry = {
    timestamp: new Date().toISOString(),
    message: err.message || String(err),
  };
  state.errors = [entry, ...state.errors].slice(0, 20);
}

export { STATE_PATH };
