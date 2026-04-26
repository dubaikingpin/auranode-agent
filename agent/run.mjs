#!/usr/bin/env node
/**
 * AuraNode agent runner.
 * Usage: node agent/run.mjs [--threshold 0.015] [--tick 60]
 */

import { startAgent, stopAgent } from "./core.mjs";

const args = process.argv.slice(2);
function flag(name, defaultVal) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return defaultVal;
  return args[i + 1];
}

const config = {
  threshold: parseFloat(flag("threshold", "0.015")),
  tickMs: parseInt(flag("tick", "60"), 10) * 1000,
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
