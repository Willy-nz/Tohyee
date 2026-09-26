import { createHash } from "node:crypto";
import { ConflictError } from "@/lib/errors";

function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalise);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, canonicalise((value as Record<string, unknown>)[key])]),
    );
  }
  return value === undefined ? null : value;
}

/**
 * Fingerprint of a command's normalised input. Stored next to the idempotency
 * key so a retry with the same key can be told apart from a different request
 * that reused the key by mistake, without comparing columns one by one.
 */
export function requestHash(kind: string, payload: Record<string, unknown>): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalise({ kind, payload })))
    .digest("hex");
}

export function assertSameRequest(storedHash: string, incomingHash: string, what: string): void {
  if (storedHash !== incomingHash) {
    throw new ConflictError(
      `That idempotency key was already used for a different ${what}. Use a new key for a new ${what}.`,
    );
  }
}
