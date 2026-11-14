import { writeAuditEvent } from "@/lib/audit";
import { type Role, roleAtLeast } from "@/lib/auth/roles";
import { isDestructiveTool } from "@/lib/ai/tool-names";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { requestHash } from "@/lib/idempotency";
import { requireId } from "@/lib/validation";

/*
 * A person approves the AI's voids, deletes and roll-backs (#697, decision
 * 1633; worked examples AIH1-AIH6).
 *
 * At Full access an AI confirms its own destructive actions: the first call
 * shows what it acts on, the second (with the hash from the first) does it.
 * That stops slips, but no person need see the preview. With this setting
 * on, the second call doesn't do it: it leaves a request, with the same
 * preview, for a bookkeeper or higher to approve or decline in Tohyee.
 * Approving runs the same tool with the same arguments, as the approver.
 */

export type AiApprovalSettings = { required: boolean };

export async function getAiApprovalSettings(tx: OrgTx): Promise<AiApprovalSettings> {
  const row = await tx.query<{ required: boolean }>("select required from ai_approval_settings where id = true");
  return { required: row.rows[0]?.required === true };
}

/** Owners turn it on or off. */
export async function saveAiApprovalSettings(tx: OrgTx, input: { required: unknown }): Promise<AiApprovalSettings> {
  if (typeof input.required !== "boolean") throw new ValidationError("required is true or false.");
  await tx.query(
    `insert into ai_approval_settings (id, required, updated_by_email) values (true, $1, $2)
     on conflict (id) do update set required = excluded.required, updated_by_email = excluded.updated_by_email, updated_at = now()`,
    [input.required, tx.actor.email],
  );
  await writeAuditEvent(tx, { eventType: "ai.action_approval_set", entityType: "organisation", entityId: tx.organisationId, details: { required: input.required } });
  return { required: input.required };
}

const HASH_FIELDS = ["confirmHash", "previewHash"] as const;

/** The hash a destructive tool's second call carries (confirmHash or previewHash), or null on a first call. */
export function doingHash(args: Record<string, unknown>): { field: (typeof HASH_FIELDS)[number]; value: string } | null {
  for (const field of HASH_FIELDS) {
    const value = args[field];
    if (typeof value === "string" && value !== "") return { field, value };
  }
  return null;
}

/**
 * Whether this call is one a person approves when the setting is on: a
 * destructive tool's second call, the one that would do it. First calls
 * (previews) and tools with no confirmation of their own (an AI discarding
 * its own unposted draft) go ahead as usual.
 */
export function heldForApproval(toolName: string, args: Record<string, unknown>): boolean {
  return isDestructiveTool(toolName) && doingHash(args) !== null;
}

/** The same call without its hash: what the tool is asked to show a preview. */
export function previewArguments(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).filter(([name]) => !(HASH_FIELDS as readonly string[]).includes(name)));
}

export type AiActionStatus = "pending" | "running" | "approved" | "declined" | "failed";

export type AiActionRequest = {
  id: string;
  toolName: string;
  title: string;
  /** What the AI was shown before it asked: the record it acts on. */
  preview: unknown;
  via: string;
  requestedByEmail: string;
  status: AiActionStatus;
  decidedByEmail: string | null;
  decidedAt: string | null;
  error: string | null;
  createdAt: string;
};

type Row = {
  id: string;
  tool_name: string;
  title: string;
  arguments: Record<string, unknown>;
  preview: unknown;
  token_id: string;
  source: string;
  via: string;
  requested_by_user_id: string;
  requested_by_email: string;
  status: AiActionStatus;
  decided_by_email: string | null;
  decided_at: Date | string | null;
  outcome: unknown;
  error: string | null;
  created_at: Date | string;
};

const COLUMNS = "id::text, tool_name, title, arguments, preview, token_id, source, via, requested_by_user_id::text, requested_by_email, status, decided_by_email, decided_at, outcome, error, created_at";
const iso = (value: Date | string | null) => (value === null ? null : new Date(value).toISOString());
/** A request left "running" this long was cut off (the server stopped): it can be approved again; the tool's idempotency key stops it happening twice. */
const RUNNING_MINUTES = 5;
/** A decline, or an approval, answers the same call for this long, so an AI that asks again straight away gets the person's answer and not a new request. */
const ANSWER_HOURS = 24;

function toRequest(row: Row): AiActionRequest {
  return {
    id: row.id,
    toolName: row.tool_name,
    title: row.title,
    preview: row.preview,
    via: row.via,
    requestedByEmail: row.requested_by_email,
    status: row.status,
    decidedByEmail: row.decided_by_email,
    decidedAt: iso(row.decided_at),
    error: row.error,
    createdAt: iso(row.created_at)!,
  };
}

/** What the AI is told about a request: waiting, done (with the tool's own answer), declined or failed. */
export function answerFor(row: Pick<Row, "id" | "status" | "title" | "decided_by_email" | "outcome" | "error">): Record<string, unknown> {
  const link = "/operations/ai";
  if (row.status === "approved") return { approved: true, requestId: row.id, approvedBy: row.decided_by_email, result: row.outcome };
  if (row.status === "declined") {
    return { declined: true, requestId: row.id, declinedBy: row.decided_by_email, note: `${row.decided_by_email} declined this (${row.title}). Nothing was changed. Don't ask again unless the person tells you to.` };
  }
  if (row.status === "failed") {
    return { failed: true, requestId: row.id, error: row.error, note: "A person approved it but it couldn't be done as it stood. Nothing was changed. Call the tool again without the hash to see how things stand now." };
  }
  return {
    waitingForApproval: true,
    requestId: row.id,
    note: `Nothing has been changed yet. This organisation has a person approve the AI's voids, deletes and roll-backs: a bookkeeper or higher approves or declines it in Tohyee on the AI page (${link}). Tell the person it's waiting there. Calling this again with the same arguments shows whether it's been decided.`,
  };
}

function actionHash(input: { toolName: string; tokenId: string; args: Record<string, unknown> }): string {
  const comparable = Object.fromEntries(Object.entries(input.args).filter(([name]) => name !== "idempotencyKey"));
  return requestHash("ai-action-request", { tool: input.toolName, token: input.tokenId, args: comparable });
}

async function existingRequest(tx: OrgTx, hash: string): Promise<Row | null> {
  const existing = await tx.query<Row>(
    `select ${COLUMNS} from ai_action_requests
      where request_hash = $1 and (status in ('pending', 'running') or (status in ('approved', 'declined') and decided_at > now() - make_interval(hours => $2)))
      order by id desc limit 1`,
    [hash, ANSWER_HOURS],
  );
  return existing.rows[0] ?? null;
}

/** The answer to a call that already has a request (waiting, or decided in the last day), or null. Asked first, before any preview: once it's done, the record has changed. */
export async function answerToSameRequest(tx: OrgTx, input: { toolName: string; tokenId: string; args: Record<string, unknown> }): Promise<Record<string, unknown> | null> {
  const existing = await existingRequest(tx, actionHash(input));
  return existing ? answerFor(existing) : null;
}

/**
 * Leaves a request for a person, or answers from the one already there: the
 * same call (same tool, arguments and key, whatever its idempotency key)
 * while one is waiting, or decided in the last day, gets that one's answer.
 */
export async function requestAiAction(
  tx: OrgTx,
  input: { toolName: string; title: string; args: Record<string, unknown>; preview: unknown; tokenId: string; source: string; via: string },
): Promise<Record<string, unknown>> {
  if (!tx.actor.userId) throw new ForbiddenError("An AI key acts as a person.");
  const hash = actionHash(input);
  const existing = await existingRequest(tx, hash);
  if (existing) return answerFor(existing);
  const inserted = await tx.query<Row>(
    `insert into ai_action_requests (tool_name, title, arguments, preview, request_hash, token_id, source, via, requested_by_user_id, requested_by_email)
     values ($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7, $8, $9, $10) returning ${COLUMNS}`,
    [input.toolName, input.title.slice(0, 200), JSON.stringify(input.args), JSON.stringify(input.preview ?? {}), hash, input.tokenId, input.source, input.via, tx.actor.userId, tx.actor.email],
  );
  const row = inserted.rows[0];
  await writeAuditEvent(tx, { eventType: "ai_action.requested", entityType: "ai_action_request", entityId: row.id, details: { tool: input.toolName, title: input.title } });
  return answerFor(row);
}

/** For the AI page: what's waiting, then the last 20 decided. */
export async function listAiActionRequests(tx: OrgTx): Promise<{ waiting: AiActionRequest[]; decided: AiActionRequest[] }> {
  const waiting = await tx.query<Row>(`select ${COLUMNS} from ai_action_requests where status in ('pending', 'running') order by id`);
  const decided = await tx.query<Row>(`select ${COLUMNS} from ai_action_requests where status in ('approved', 'declined', 'failed') order by decided_at desc, id desc limit 20`);
  return { waiting: waiting.rows.map(toRequest), decided: decided.rows.map(toRequest) };
}

export async function countWaitingAiActions(tx: OrgTx): Promise<number> {
  const result = await tx.query<{ count: string }>("select count(*)::text as count from ai_action_requests where status in ('pending', 'running')");
  return Number(result.rows[0]?.count ?? "0");
}

/** What approving needs to run the tool: taken under a lock, and marked running so two people can't both do it. */
export type ClaimedAction = { id: string; toolName: string; title: string; args: Record<string, unknown>; tokenId: string; source: string; via: string };

export async function declineAiAction(tx: OrgTx, idInput: unknown, role: Role): Promise<AiActionRequest> {
  if (!roleAtLeast(role, "bookkeeper")) throw new ForbiddenError("Approving or declining what the AI asked for is for bookkeepers and up.");
  const id = requireId(idInput, "requestId");
  const updated = await tx.query<Row>(
    `update ai_action_requests set status = 'declined', decided_by_email = $2, decided_at = now()
      where id = $1 and (status = 'pending' or (status = 'running' and decided_at < now() - make_interval(mins => $3))) returning ${COLUMNS}`,
    [id, tx.actor.email, RUNNING_MINUTES],
  );
  if (!updated.rows[0]) throw await notWaiting(tx, id);
  await writeAuditEvent(tx, { eventType: "ai_action.declined", entityType: "ai_action_request", entityId: id, details: { tool: updated.rows[0].tool_name } });
  return toRequest(updated.rows[0]);
}

async function notWaiting(tx: OrgTx, id: string): Promise<Error> {
  const found = await tx.query<{ status: AiActionStatus }>("select status from ai_action_requests where id = $1", [id]);
  if (!found.rows[0]) return new NotFoundError("That request wasn't found.");
  return new ConflictError(found.rows[0].status === "running" ? "Someone is approving that now." : `That request was already ${found.rows[0].status}.`);
}

export async function claimAiAction(tx: OrgTx, idInput: unknown, role: Role): Promise<ClaimedAction> {
  if (!roleAtLeast(role, "bookkeeper")) throw new ForbiddenError("Approving or declining what the AI asked for is for bookkeepers and up.");
  const id = requireId(idInput, "requestId");
  const claimed = await tx.query<Row>(
    `update ai_action_requests set status = 'running', decided_by_email = $2, decided_at = now()
      where id = $1 and (status = 'pending' or (status = 'running' and decided_at < now() - make_interval(mins => $3))) returning ${COLUMNS}`,
    [id, tx.actor.email, RUNNING_MINUTES],
  );
  const row = claimed.rows[0];
  if (!row) throw await notWaiting(tx, id);
  return { id: row.id, toolName: row.tool_name, title: row.title, args: row.arguments, tokenId: row.token_id, source: row.source, via: row.via };
}

/** Records how an approved action went. */
export async function finishAiAction(tx: OrgTx, id: string, result: { ok: true; outcome: unknown } | { ok: false; error: string }): Promise<AiActionRequest> {
  const updated = await tx.query<Row>(
    `update ai_action_requests set status = $2, outcome = $3::jsonb, error = $4, decided_by_email = $5, decided_at = now() where id = $1 and status = 'running' returning ${COLUMNS}`,
    [id, result.ok ? "approved" : "failed", result.ok ? JSON.stringify(result.outcome ?? null) : null, result.ok ? null : result.error.slice(0, 2000), tx.actor.email],
  );
  if (!updated.rows[0]) throw new ConflictError("That request is no longer being approved.");
  await writeAuditEvent(tx, { eventType: result.ok ? "ai_action.approved" : "ai_action.failed", entityType: "ai_action_request", entityId: id, details: { tool: updated.rows[0].tool_name, ...(result.ok ? {} : { error: result.error.slice(0, 500) }) } });
  return toRequest(updated.rows[0]);
}
