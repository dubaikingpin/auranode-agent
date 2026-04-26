#!/usr/bin/env node
/**
 * AuraNode agent runner.
 * Usage: node agent/run.mjs [--threshold 0.015] [--tick 30]
 */

// Auto-load .env from the repo root before any imports use process.env.
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, "../.env");
try {
  const lines = readFileSync(envPath, "utf-8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (key && !(key in process.env)) process.env[key] = val;
  }
} catch { /* no .env file — rely on shell env */ }

import { startAgent, stopAgent } from "./core.mjs";

const args = process.argv.slice(2);
function flag(name, defaultVal) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return defaultVal;
  return args[i + 1];
}

const config = {
  threshold: parseFloat(flag("threshold", "0.0001")),
  tickMs: parseInt(flag("tick", "30"), 10) * 1000,
};

process.on("SIGINT", () => {
  stopAgent();
  process.exit(0);
});

process.on("SIGTERM", () => {
  stopAgent();
  process.exit(0);
});

process.stdout.write(`AuraNode Agent — threshold=${config.threshold}, tick=${config.tickMs / 1000}s\n`);
startAgent(config).catch((err) => {
  process.stderr.write(`Fatal: ${err.message}\n`);
  process.exit(1);
});
