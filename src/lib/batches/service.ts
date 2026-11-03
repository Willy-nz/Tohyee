import { randomBytes } from "node:crypto";
import { writeAuditEvent } from "@/lib/audit";
import { lineErrorText } from "@/lib/bank/bulk";
import type { OrgRunner, OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, HttpError, NotFoundError } from "@/lib/errors";
import { assertSameRequest } from "@/lib/idempotency";
import { requireId } from "@/lib/validation";

/**
 * Durable batches (#547, decisions 1273-1279): a list of actions asked for
 * in one go, kept in the organisation's database so that what happened to
 * each one can be read after a lost answer or a server restart, and the
 * rest resumed with the same idempotency keys.
 *
 * Each action runs in its own transaction, and its status is written in
 * that same transaction, so "committed" is never claimed for an effect that
 * rolled back, nor the other way round. Before the work starts the action
 * is marked "started" in a transaction of its own; one left "started" (the
 * server or its database connection went away) is shown as outcome unknown,
 * and resuming runs it again with its original key, which finds the earlier
 * result if there was one instead of doing it twice.
 *
 * One worker at a time holds a batch's lease. The lease runs out by itself,
 * so a server that stopped mid-batch blocks it for at most a minute.
 *
 * Generic on purpose: the bank batches (src/lib/bank/batches.ts) give the
 * work for each action kind; other kinds can be added later.
 */

export const BATCH_KINDS = ["bank_reconcile", "bank_unreconcile", "bank_undo", "bank_coding"] as const;
export type BatchKind = (typeof BATCH_KINDS)[number];

/** What callers see: "started" is shown as in_progress while a worker holds the lease, else unknown. */
export type BatchActionStatus = "pending" | "in_progress" | "unknown" | "committed" | "failed";

export type BatchAction = {
  id: string;
  position: number;
  action: string;
  targetId: string | null;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  status: BatchActionStatus;
  attempts: number;
  result: unknown;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
};

export type BatchCounts = { total: number; committed: number; failed: number; pending: number; inProgress: number; unknown: number };

/**
 * done: every action committed. finished_with_failures: none left to do, some refused.
 * working: a worker is on it now. waiting: some left to do (resume it).
 * rate_limited: some left to do, not before retryAfterSeconds.
 */
export type BatchState = "done" | "finished_with_failures" | "working" | "waiting" | "rate_limited";

export type BatchSummary = {
  id: string;
  kind: BatchKind;
  source: string;
  idempotencyKey: string;
  createdAt: string;
  createdByEmail: string | null;
  createdVia: string | null;
  undoesBatchId: string | null;
  undoneByBatchIds: string[];
  runs: number;
  lastRunAt: string | null;
  counts: BatchCounts;
  state: BatchState;
  /** Seconds to wait before resuming (a rate limit, or another worker on it), else null. */
  retryAfterSeconds: number | null;
};

export type Batch = BatchSummary & { actions: BatchAction[] };

export type NewBatchAction = {
  action: string;
  targetId: string | null;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  /** Refused before any work (e.g. a malformed action): recorded as failed with this reason. */
  refused?: string;
};

type BatchRow = {
  id: string;
  kind: BatchKind;
  command_source: string;
  idempotency_key: string;
  request_hash: string;
  undoes_batch_id: string | null;
  created_by_email: string | null;
  created_via: string | null;
  created_at: string;
  runs: number;
  last_run_at: string | null;
  leased: boolean;
  wait_seconds: string | null;
  undone_by: string[] | null;
};

type ActionRow = {
  id: string;
  batch_id: string;
  position: number;
  action: string;
  target_id: string | null;
  payload: Record<string, unknown>;
  idempotency_key: string;
  status: "pending" | "started" | "committed" | "failed";
  attempts: number;
  result: unknown;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
};

const BATCH_SELECT = `
  select b.id::text, b.kind, b.command_source, b.idempotency_key, b.request_hash, b.undoes_batch_id::text,
         b.created_by_email, b.created_via, b.created_at::text, b.runs, b.last_run_at::text,
         (b.lease_until is not null and b.lease_until > now()) as leased,
         ceil(extract(epoch from (greatest(coalesce(b.lease_until, now()), coalesce(b.not_before, now())) - now())))::text as wait_seconds,
         (select array_agg(u.id::text order by u.id) from batches u where u.undoes_batch_id = b.id) as undone_by
    from batches b`;

const ACTION_SELECT = `
  select a.id::text, a.batch_id::text, a.position, a.action, a.target_id, a.payload, a.idempotency_key, a.status, a.attempts,
         a.result, a.error, a.started_at::text, a.finished_at::text
    from batch_actions a`;

function publicStatus(status: ActionRow["status"], leased: boolean): BatchActionStatus {
  if (status === "started") return leased ? "in_progress" : "unknown";
  return status;
}

function toAction(row: ActionRow, leased: boolean): BatchAction {
  return {
    id: row.id,
    position: row.position,
    action: row.action,
    targetId: row.target_id,
    payload: row.payload,
    idempotencyKey: row.idempotency_key,
    status: publicStatus(row.status, leased),
    attempts: row.attempts,
    result: row.result,
    error: row.error,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

/** Counts by what callers see. Pure, for tests too. */
export function countActions(statuses: readonly BatchActionStatus[]): BatchCounts {
  const counts: BatchCounts = { total: statuses.length, committed: 0, failed: 0, pending: 0, inProgress: 0, unknown: 0 };
  for (const status of statuses) {
    if (status === "in_progress") counts.inProgress += 1;
    else counts[status] += 1;
  }
  return counts;
}

/** The batch's state from its counts and whether it's leased or told to wait. Pure, for tests too. */
export function batchState(counts: BatchCounts, leased: boolean, waitSeconds: number): BatchState {
  if (leased) return "working";
  if (counts.pending + counts.unknown + counts.inProgress === 0) return counts.failed === 0 ? "done" : "finished_with_failures";
  return waitSeconds > 0 ? "rate_limited" : "waiting";
}

function summaryFrom(row: BatchRow, statuses: BatchActionStatus[]): BatchSummary {
  const counts = countActions(statuses);
  const wait = Math.max(0, Number(row.wait_seconds ?? 0));
  const state = batchState(counts, row.leased, wait);
  return {
    id: row.id,
    kind: row.kind,
    source: row.command_source,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
    createdByEmail: row.created_by_email,
    createdVia: row.created_via,
    undoesBatchId: row.undoes_batch_id,
    undoneByBatchIds: row.undone_by ?? [],
    runs: row.runs,
    lastRunAt: row.last_run_at,
    counts,
    state,
    retryAfterSeconds: (state === "working" || state === "rate_limited") && wait > 0 ? wait : null,
  };
}

/** One batch with every action, in order. */
export async function getBatch(tx: OrgTx, batchIdInput: unknown): Promise<Batch> {
  const batchId = requireId(batchIdInput, "batchId");
  const row = (await tx.query<BatchRow>(`${BATCH_SELECT} where b.id = $1`, [batchId])).rows[0];
  if (!row) throw new NotFoundError("Batch not found.");
  const actions = (await tx.query<ActionRow>(`${ACTION_SELECT} where a.batch_id = $1 order by a.position`, [batchId])).rows.map((action) =>
    toAction(action, row.leased),
  );
  return { ...summaryFrom(row, actions.map((action) => action.status)), actions };
}

/** Summaries of these batches (newest first), without their actions. */
export async function batchSummaries(tx: OrgTx, batchIds: readonly string[]): Promise<BatchSummary[]> {
  if (batchIds.length === 0) return [];
  const rows = (await tx.query<BatchRow>(`${BATCH_SELECT} where b.id = any($1::bigint[]) order by b.created_at desc, b.id desc`, [batchIds])).rows;
  const statuses = await tx.query<{ batch_id: string; status: ActionRow["status"] }>(
    "select batch_id::text, status from batch_actions where batch_id = any($1::bigint[]) order by batch_id, position",
    [batchIds],
  );
  const byBatch = new Map<string, ActionRow["status"][]>();
  for (const entry of statuses.rows) byBatch.set(entry.batch_id, [...(byBatch.get(entry.batch_id) ?? []), entry.status]);
  return rows.map((row) => summaryFrom(row, (byBatch.get(row.id) ?? []).map((status) => publicStatus(status, row.leased))));
}

/** The newest batches of these kinds, optionally only one command source's. */
export async function listBatches(
  tx: OrgTx,
  options: { kinds?: readonly BatchKind[]; source?: string; limit?: number } = {},
): Promise<BatchSummary[]> {
  const ids = await tx.query<{ id: string }>(
    `select b.id::text from batches b
      where ($1::text[] is null or b.kind = any($1::text[])) and ($2::text is null or b.command_source = $2)
      order by b.created_at desc, b.id desc limit $3`,
    [options.kinds ? [...options.kinds] : null, options.source ?? null, Math.min(Math.max(options.limit ?? 50, 1), 200)],
  );
  return batchSummaries(
    tx,
    ids.rows.map((row) => row.id),
  );
}

/**
 * Records a batch and its actions, or finds the one made earlier with the
 * same source and key (the same request again: `created` false). The same
 * key for a different request, or another kind, is refused.
 */
export async function createBatch(
  tx: OrgTx,
  input: {
    kind: BatchKind;
    source: string;
    idempotencyKey: string;
    requestHash: string;
    undoesBatchId?: string | null;
    actions: readonly NewBatchAction[];
  },
): Promise<{ batch: Batch; created: boolean }> {
  const find = async () =>
    (
      await tx.query<{ id: string; kind: string; request_hash: string }>(
        "select id::text, kind, request_hash from batches where command_source = $1 and idempotency_key = $2",
        [input.source, input.idempotencyKey],
      )
    ).rows[0];
  const existing = await find();
  if (existing) {
    if (existing.kind !== input.kind) throw new ConflictError("That idempotency key was already used for a different kind of batch.");
    assertSameRequest(existing.request_hash, input.requestHash, "batch");
    return { batch: await getBatch(tx, existing.id), created: false };
  }
  const inserted = await tx.query<{ id: string }>(
    `insert into batches (kind, command_source, idempotency_key, request_hash, undoes_batch_id, created_by_user_id, created_by_email, created_via)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (command_source, idempotency_key) do nothing returning id::text`,
    [input.kind, input.source, input.idempotencyKey, input.requestHash, input.undoesBatchId ?? null, tx.actor.userId, tx.actor.email, tx.actor.via ?? null],
  );
  if (!inserted.rows[0]) {
    // Someone else made it a moment ago with the same key.
    const raced = await find();
    if (!raced) throw new ConflictError("That batch couldn't be recorded. Try again.");
    assertSameRequest(raced.request_hash, input.requestHash, "batch");
    return { batch: await getBatch(tx, raced.id), created: false };
  }
  const batchId = inserted.rows[0].id;
  for (const [position, action] of input.actions.entries()) {
    await tx.query(
      `insert into batch_actions (batch_id, position, action, target_id, payload, idempotency_key, status, error, finished_at)
       values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, case when $7 = 'failed' then now() end)`,
      [
        batchId,
        position,
        action.action,
        action.targetId,
        JSON.stringify(action.payload),
        action.idempotencyKey,
        action.refused ? "failed" : "pending",
        action.refused ? action.refused.slice(0, 2000) : null,
      ],
    );
  }
  await writeAuditEvent(tx, {
    eventType: "batch.created",
    entityType: "batch",
    entityId: batchId,
    details: { kind: input.kind, actions: input.actions.length, refused: input.actions.filter((action) => action.refused).length, ...(input.undoesBatchId ? { undoesBatchId: input.undoesBatchId } : {}) },
  });
  return { batch: await getBatch(tx, batchId), created: true };
}

/** A database error that means "try again shortly", not "this is refused". */
const TRANSIENT_PG = new Set(["40001", "40P01", "55P03"]);
/** How long to wait after a transient database error. */
const TRANSIENT_WAIT_SECONDS = 5;

/** Seconds to wait when the error means "slow down" (a rate limit, a lock or serialisation clash); null when it's a real refusal. */
export function retryAfterFor(error: unknown): number | null {
  if (error instanceof HttpError && error.status === 429) {
    const seconds = Number(error.details?.retryAfterSeconds);
    return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : 60;
  }
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" && TRANSIENT_PG.has(code) ? TRANSIENT_WAIT_SECONDS : null;
}

export type RunOptions = {
  /** Also run actions that failed before (each with its original key). */
  retryFailed?: boolean;
  /** Stop starting new actions after this long; the rest wait for a resume. Default 25 seconds. */
  budgetMs?: number;
  /** How long the lease lasts without a checkpoint. Default 60 seconds. */
  leaseSeconds?: number;
  /** For tests: the clock used for the budget. */
  now?: () => number;
};

export type RunOutcome = {
  batch: Batch;
  /** Why it stopped before the end: out of time, told to wait, or the database went away mid-action. */
  stopped: "time" | "rate_limit" | "busy" | "lost_connection" | null;
  /** When `stopped` is rate_limit or busy: wait this long before resuming. */
  retryAfterSeconds: number | null;
};

export type ActionWork = (tx: OrgTx, action: BatchAction) => Promise<unknown>;

const DEFAULT_BUDGET_MS = 25_000;
const DEFAULT_LEASE_SECONDS = 60;

/**
 * Works through a batch's actions that are still to do (pending, or
 * started with no outcome; failed ones too with `retryFailed`), in order,
 * each in its own transaction. Stops early when out of time, when an action
 * hits a rate limit (it goes back to pending and the batch waits), or when
 * the database goes away (that action's outcome is unknown). Calling it
 * again on a finished batch changes nothing.
 */
export async function runBatch(run: OrgRunner, batchIdInput: unknown, work: ActionWork, options: RunOptions = {}): Promise<RunOutcome> {
  const batchId = requireId(batchIdInput, "batchId");
  const now = options.now ?? Date.now;
  const started = now();
  const budget = options.budgetMs ?? DEFAULT_BUDGET_MS;
  const leaseSeconds = options.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
  const token = randomBytes(12).toString("hex");
  const statuses = options.retryFailed ? ["pending", "started", "failed"] : ["pending", "started"];

  const claimed = await run(async (tx) => {
    const found = await tx.query("select 1 from batches where id = $1", [batchId]);
    if (found.rowCount === 0) throw new NotFoundError("Batch not found.");
    const claim = await tx.query<{ id: string }>(
      `update batches set lease_token = $2, lease_until = now() + make_interval(secs => $3), runs = runs + 1, last_run_at = now(), not_before = null
        where id = $1 and (lease_until is null or lease_until <= now()) and (not_before is null or not_before <= now())
        returning id::text`,
      [batchId, token, leaseSeconds],
    );
    if (!claim.rows[0]) return null;
    const todo = await tx.query<{ id: string }>(
      // A failed action is tried again only if it was tried at all: one refused before any work (malformed, or blocked in the preview) stays refused.
      "select id::text from batch_actions where batch_id = $1 and status = any($2::text[]) and not (status = 'failed' and attempts = 0) order by position",
      [batchId, statuses],
    );
    if (todo.rows.length > 0) {
      await writeAuditEvent(tx, { eventType: "batch.run", entityType: "batch", entityId: batchId, details: { actions: todo.rows.length, retryFailed: Boolean(options.retryFailed) } });
    }
    return todo.rows.map((row) => row.id);
  });
  if (claimed === null) {
    const batch = await run((tx) => getBatch(tx, batchId));
    return { batch, stopped: "busy", retryAfterSeconds: batch.retryAfterSeconds ?? 1 };
  }

  let stopped: RunOutcome["stopped"] = null;
  let retryAfterSeconds: number | null = null;
  let lostConnection: unknown = null;
  for (const actionId of claimed) {
    if (now() - started > budget) {
      stopped = "time";
      break;
    }
    try {
      const marked = await run(async (tx) => {
        const row = (
          await tx.query<ActionRow>(
            `update batch_actions a set status = 'started', attempts = attempts + 1, started_at = now(), finished_at = null
               from batches b
              where a.id = $1 and b.id = a.batch_id and b.lease_token = $2 and a.status = any($3::text[]) and not (a.status = 'failed' and a.attempts = 0)
              returning a.id::text, a.batch_id::text, a.position, a.action, a.target_id, a.payload, a.idempotency_key, a.status,
                        a.attempts, a.result, a.error, a.started_at::text, a.finished_at::text`,
            [actionId, token, statuses],
          )
        ).rows[0];
        return row ?? null;
      });
      if (!marked) continue; // done meanwhile, or the lease was lost (the checkpoint below notices)
      const outcome = await run(async (tx) => {
        // The checkpoint: still ours? This also keeps a second worker out until this action commits.
        const lease = await tx.query(
          "update batches set lease_until = now() + make_interval(secs => $3) where id = $1 and lease_token = $2 returning id",
          [batchId, token, leaseSeconds],
        );
        if (lease.rowCount === 0) return { kind: "lost_lease" as const };
        const current = (await tx.query<{ status: string }>("select status from batch_actions where id = $1 for update", [actionId])).rows[0];
        if (current?.status !== "started") return { kind: "skipped" as const };
        await tx.query("savepoint batch_action");
        try {
          const value = await work(tx, toAction(marked, true));
          await tx.query("release savepoint batch_action");
          await tx.query("update batch_actions set status = 'committed', result = $2::jsonb, error = null, finished_at = now() where id = $1", [
            actionId,
            JSON.stringify(value ?? null),
          ]);
          return { kind: "committed" as const };
        } catch (error) {
          await tx.query("rollback to savepoint batch_action");
          const wait = retryAfterFor(error);
          if (wait !== null) {
            await tx.query("update batch_actions set status = 'pending', started_at = null where id = $1", [actionId]);
            await tx.query("update batches set not_before = now() + make_interval(secs => $2) where id = $1", [batchId, wait]);
            return { kind: "wait" as const, seconds: wait };
          }
          await tx.query("update batch_actions set status = 'failed', error = $2, finished_at = now() where id = $1", [
            actionId,
            lineErrorText(error).slice(0, 2000),
          ]);
          return { kind: "failed" as const };
        }
      });
      if (outcome.kind === "lost_lease") {
        stopped = "busy";
        break;
      }
      if (outcome.kind === "wait") {
        stopped = "rate_limit";
        retryAfterSeconds = outcome.seconds;
        break;
      }
    } catch (error) {
      // The transaction itself didn't finish (the database or the connection went away):
      // whether it committed isn't known, so the action stays "started" for a resume to check.
      lostConnection = error;
      stopped = "lost_connection";
      break;
    }
  }

  try {
    return await run(async (tx) => {
      // Released only when it's still ours; a rate limit's not_before stays.
      await tx.query("update batches set lease_token = null, lease_until = null where id = $1 and lease_token = $2", [batchId, token]);
      const batch = await getBatch(tx, batchId);
      return { batch, stopped, retryAfterSeconds: retryAfterSeconds ?? (stopped === "busy" ? (batch.retryAfterSeconds ?? 1) : null) };
    });
  } catch (error) {
    // The lease runs out by itself.
    throw lostConnection ?? error;
  }
}
