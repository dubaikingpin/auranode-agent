#!/usr/bin/env node
/**
 * Policy: cap SOL spend per transaction at policy_config.max_lamports (default 0.1 SOL).
 * Blocks any Solana tx that transfers more than the configured limit.
 */

import { fileURLToPath } from "node:url";
import { runPolicyFromStdin } from "../lib/util/prompt.js";

const DEFAULT_MAX_SOL = 0.1;
const LAMPORTS_PER_SOL = 1_000_000_000n;

export function check(ctx) {
  const tx = ctx.transaction || {};
  const config = ctx.policy_config || {};

  const maxSol = config.max_sol ?? DEFAULT_MAX_SOL;
  const maxLamports = BigInt(Math.floor(maxSol * Number(LAMPORTS_PER_SOL)));

  const rawValue = tx.value ?? tx.lamports ?? "0";
  let spend;
  try {
    spend = BigInt(rawValue);
  } catch {
    return { allow: false, reason: `Cannot parse transaction value: ${rawValue}` };
  }

  if (spend > maxLamports) {
    const spendSol = (Number(spend) / Number(LAMPORTS_PER_SOL)).toFixed(4);
    return {
      allow: false,
      reason: `Spend limit exceeded: ${spendSol} SOL > max ${maxSol} SOL per trade.`,
    };
  }

  return { allow: true };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runPolicyFromStdin(check);
}
