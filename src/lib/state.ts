import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { logger } from "./errors.js";

const ROOT = resolve(import.meta.dirname, "../..");
const LAST_RUN_FILE = resolve(ROOT, "last_run.txt");
const STATE_FILE = resolve(ROOT, "notified_events.json");
const PRUNE_DAYS = 30;

// -- last_run.txt --

export function readLastRun(): string | null {
  if (!existsSync(LAST_RUN_FILE)) return null;
  const val = readFileSync(LAST_RUN_FILE, "utf-8").trim();
  return val || null;
}

export function writeLastRun(ts: string) {
  writeFileSync(LAST_RUN_FILE, ts);
}

// -- notified_events.json --

export function loadNotifiedEvents(): Record<string, string> {
  if (!existsSync(STATE_FILE)) return {};
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
  } catch (err) {
    logger.warn("Failed to load state file:", err);
    return {};
  }
}

export function saveNotifiedEvents(state: Record<string, string>) {
  const cutoff = Date.now() - PRUNE_DAYS * 86_400_000;
  const pruned: Record<string, string> = {};
  let prunedCount = 0;

  for (const [key, val] of Object.entries(state)) {
    if (new Date(val).getTime() > cutoff) {
      pruned[key] = val;
    } else {
      prunedCount++;
    }
  }

  writeFileSync(STATE_FILE, JSON.stringify(pruned, null, 2));
  logger.info(`State saved (${Object.keys(pruned).length} entries, pruned ${prunedCount} old)`);
}

export function stateKey(eventId: string, dealRecordId: string): string {
  return `${eventId}:${dealRecordId}`;
}
