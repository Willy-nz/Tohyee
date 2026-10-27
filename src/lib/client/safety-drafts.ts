/*
 * Safety reports saved on this phone until they're sent (#446, decision
 * 944; William's review: "A report saved offline survives reopening and
 * syncs once, with visible unresolved conflicts and no false
 * alert-delivered message").
 *
 * - Each draft keeps the operation id it was made with, so sending it
 *   again (after a dropped connection, or twice from two tabs) adds it once.
 * - "Saved on this phone" is never shown as sent: a draft goes only when
 *   the server says it was recorded.
 * - No connection (or the server busy): it stays saved, to try again. A
 *   refusal (a mistake in it, or someone else's change): "needs attention"
 *   with the reason, kept until the person fixes or discards it.
 * - Drafts belong to one person in one organisation and farm (the farm is
 *   in the draft, so switching farms never sends it to another), and are
 *   dropped after 14 days.
 * - Photos aren't kept in drafts (a phone's storage is small): they're
 *   added once there's a connection.
 */

export type DraftStatus = "saved" | "needs_attention";

export type SafetyDraft = {
  operationId: string;
  userId: string;
  organisationId: string;
  farmId: string;
  farmName: string;
  /** What it is, for the list ("Near miss: tractor on the race"). */
  label: string;
  /** The API path and body it's sent with. */
  path: string;
  body: Record<string, unknown>;
  savedAt: string;
  status: DraftStatus;
  problem: string | null;
};

export const DRAFT_DAYS = 14;
const KEY = "tohyee.safety.drafts";

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

export function createDraftStore(storage: () => Storage | null, now: () => Date = () => new Date()) {
  const readAll = (): SafetyDraft[] => {
    try {
      const raw = storage()?.getItem(KEY);
      const parsed = raw ? (JSON.parse(raw) as SafetyDraft[]) : [];
      const cutoff = now().getTime() - DRAFT_DAYS * 86_400_000;
      return Array.isArray(parsed) ? parsed.filter((draft) => draft && new Date(draft.savedAt).getTime() >= cutoff) : [];
    } catch {
      return [];
    }
  };
  const writeAll = (drafts: SafetyDraft[]): boolean => {
    try {
      storage()?.setItem(KEY, JSON.stringify(drafts));
      return true;
    } catch {
      return false;
    }
  };
  return {
    list(userId: string, organisationId: string): SafetyDraft[] {
      return readAll().filter((draft) => draft.userId === userId && draft.organisationId === organisationId);
    },
    /** Saves (or replaces, by operation id) a draft. False when the phone wouldn't keep it. */
    save(draft: Omit<SafetyDraft, "savedAt" | "status" | "problem">): boolean {
      const drafts = readAll().filter((each) => each.operationId !== draft.operationId);
      return writeAll([...drafts, { ...draft, savedAt: now().toISOString(), status: "saved", problem: null }]);
    },
    remove(operationId: string): void {
      writeAll(readAll().filter((draft) => draft.operationId !== operationId));
    },
    flag(operationId: string, problem: string): void {
      writeAll(readAll().map((draft) => (draft.operationId === operationId ? { ...draft, status: "needs_attention" as const, problem } : draft)));
    },
  };
}

export type SendOutcome = { result: "sent" } | { result: "kept"; reason: string } | { result: "needs_attention"; reason: string };

/**
 * What became of one try at sending: a refusal (4xx) needs the person; no
 * connection, a timeout or a server problem (5xx) keeps it to try again.
 */
export function sendOutcome(error: unknown): SendOutcome {
  if (error === null) return { result: "sent" };
  const status = error && typeof error === "object" && "status" in error ? Number((error as { status: unknown }).status) : null;
  const message = error instanceof Error ? error.message : "Something went wrong.";
  if (status !== null && Number.isFinite(status) && status >= 400 && status < 500 && status !== 408 && status !== 429) return { result: "needs_attention", reason: message };
  return { result: "kept", reason: status ? message : "No connection to Tohyee." };
}

/** Sends a draft once; removes it only when the server recorded it. */
export async function sendDraft(store: ReturnType<typeof createDraftStore>, draft: SafetyDraft, send: (path: string, body: Record<string, unknown>) => Promise<unknown>): Promise<SendOutcome> {
  let outcome: SendOutcome;
  try {
    await send(draft.path, { ...draft.body, operationId: draft.operationId });
    outcome = { result: "sent" };
  } catch (error) {
    outcome = sendOutcome(error);
  }
  if (outcome.result === "sent") store.remove(draft.operationId);
  else if (outcome.result === "needs_attention") store.flag(draft.operationId, outcome.reason);
  return outcome;
}
