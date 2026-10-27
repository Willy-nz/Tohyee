import { createHash } from "node:crypto";

/*
 * The tamper-evident history of farm safety records (#446, decisions
 * 930-934). Each version of a safety record is one entry; the database
 * numbers it, dates it and works out its hash from the text below, which
 * includes the hash of the entry before it (migration 0189,
 * `safety_entry_canonical`). This file works the same text and hashes out
 * again, separately from the database, so a change made straight in the
 * database (past its rules) is found, and so anyone given a WorkSafe pack
 * can check it with the same steps (docs/FARM-SAFETY.md).
 *
 * What it can't show by itself: someone with full control of the database
 * who rewrites every entry after a point, hashes and all. The copy sent off
 * the farm (with the latest entry's number and hash) catches that: compare
 * it with `findInChain`.
 */

export const GENESIS_HASH = "0".repeat(64);
export const CANONICAL_PREFIX = "tohyee-safety-entry-v1";

/** One entry as stored, with its date as the database writes it into the hash (UTC, to the microsecond). */
export type ChainEntry = {
  seq: string;
  kind: string;
  recordId: string;
  version: number;
  change: string;
  farmId: string | null;
  restricted: boolean;
  happenedOn: string | null;
  /** `YYYY-MM-DDTHH:MM:SS.ffffffZ`, as `safety_entry_canonical` writes it. */
  enteredAt: string;
  enteredByUserId: string | null;
  enteredByEmail: string;
  via: string | null;
  operationId: string | null;
  /** The record's details as stored (JSON text); null when withheld from a pack (restricted details). */
  body: string | null;
  previousHash: string;
  hash: string;
};

/** The exact text the database hashes for an entry (the same as `safety_entry_canonical`). */
export function canonicalText(entry: ChainEntry & { body: string }): string {
  return [
    CANONICAL_PREFIX,
    entry.seq,
    entry.kind,
    entry.recordId,
    String(entry.version),
    entry.change,
    entry.farmId ?? "",
    entry.restricted ? "true" : "false",
    entry.happenedOn ?? "",
    entry.enteredAt,
    entry.enteredByUserId ?? "",
    entry.enteredByEmail,
    entry.via ?? "",
    entry.operationId ?? "",
    entry.body,
    entry.previousHash,
  ].join("\n");
}

export function sha256Hex(text: string | Uint8Array): string {
  return createHash("sha256").update(text).digest("hex");
}

export function entryHash(entry: ChainEntry & { body: string }): string {
  return sha256Hex(canonicalText(entry));
}

/** JSON with its keys in a fixed order, so the same details always give the same text. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

export type ChainProblem = { seq: string; problem: "missing" | "out_of_order" | "link" | "hash" };

export type ChainCheck = {
  /** Entries whose hash was worked out again and matched. */
  checked: number;
  /** Entries whose details were withheld (restricted), so only their place in the chain was checked. */
  withheld: number;
  problems: ChainProblem[];
  /** The last entry: its number and hash (what the copy sent off the farm records). */
  head: { seq: string; hash: string } | null;
};

export const PROBLEM_TEXT: Record<ChainProblem["problem"], string> = {
  missing: "An entry is missing here (the numbers skip).",
  out_of_order: "The entries aren't in order.",
  link: "This entry doesn't follow on from the one before it (the history was changed or an entry removed).",
  hash: "This entry's details don't match its hash (it was changed after it was saved).",
};

/**
 * Checks a run of entries, in order: numbers go up by one, each names the
 * hash of the one before, and each hash matches its details. Starts from the
 * first entry (number 1, after the all-zero hash) unless `from` says where
 * the run begins.
 */
export function verifyChain(entries: readonly ChainEntry[], from: { seq: string; hash: string } | null = null): ChainCheck {
  const problems: ChainProblem[] = [];
  let checked = 0;
  let withheld = 0;
  let expectedSeq = from ? BigInt(from.seq) + BigInt(1) : BigInt(1);
  let previousHash = from ? from.hash : GENESIS_HASH;
  for (const entry of entries) {
    const seq = BigInt(entry.seq);
    if (seq < expectedSeq) problems.push({ seq: entry.seq, problem: "out_of_order" });
    else if (seq > expectedSeq) problems.push({ seq: entry.seq, problem: "missing" });
    if (entry.previousHash !== previousHash) problems.push({ seq: entry.seq, problem: "link" });
    if (entry.body === null) withheld += 1;
    else if (entryHash(entry as ChainEntry & { body: string }) !== entry.hash) problems.push({ seq: entry.seq, problem: "hash" });
    else checked += 1;
    expectedSeq = seq + BigInt(1);
    previousHash = entry.hash;
  }
  const last = entries.at(-1);
  return { checked, withheld, problems, head: last ? { seq: last.seq, hash: last.hash } : from };
}

/**
 * Whether an entry number and hash from an earlier copy (e.g. the weekly
 * email) is still in the history: "found", "different" (that entry's hash
 * has changed, so the history before it was rewritten), or "missing".
 */
export function findInChain(entries: readonly Pick<ChainEntry, "seq" | "hash">[], copy: { seq: string; hash: string }): "found" | "different" | "missing" {
  const entry = entries.find((each) => each.seq === copy.seq);
  if (!entry) return "missing";
  return entry.hash === copy.hash.trim().toLowerCase() ? "found" : "different";
}
