import { writeAuditEvent } from "@/lib/audit";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { requireArray, requireId, requireString } from "@/lib/validation";
import { MOVEMENT_TYPES, recordMovement, requireLivestock, type Movement } from "./movements";

/*
 * Livestock movements the AI suggests (example AIW8): when the AI finds
 * births, sales, deaths and so on in messy data, it suggests them with the
 * evidence; a person accepts each one, which records the movement as usual
 * (with every check, and the year's valuation using it), or declines it. The
 * AI never records livestock movements itself.
 */

export type LivestockSuggestion = {
  id: string;
  movement: Record<string, unknown>;
  evidence: string;
  suggestedByEmail: string;
  suggestedAt: string;
  decision: "accepted" | "declined" | null;
  movementId: string | null;
  decidedByEmail: string | null;
  decidedAt: string | null;
};

type Row = {
  id: string;
  movement: Record<string, unknown>;
  evidence: string;
  suggested_by_email: string;
  suggested_at: string;
  decision: "accepted" | "declined" | null;
  movement_id: string | null;
  decided_by_email: string | null;
  decided_at: string | null;
};

const COLUMNS = `id::text, movement, evidence, suggested_by_email, to_char(suggested_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as suggested_at,
  decision, movement_id::text, decided_by_email, to_char(decided_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as decided_at`;

const toSuggestion = (row: Row): LivestockSuggestion => ({
  id: row.id,
  movement: row.movement,
  evidence: row.evidence,
  suggestedByEmail: row.suggested_by_email,
  suggestedAt: row.suggested_at,
  decision: row.decision,
  movementId: row.movement_id,
  decidedByEmail: row.decided_by_email,
  decidedAt: row.decided_at,
});

const FIELDS = ["movementType", "movementDate", "kind", "classCode", "toClassCode", "head", "amount", "heldFor", "rationsFor", "note"] as const;

/** Keeps only a movement's own fields: no idempotency key, source, locations or document links (people add those when accepting). */
function movementFields(raw: unknown, label: string): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ValidationError(`${label} must be an object.`);
  const input = raw as Record<string, unknown>;
  const movement: Record<string, unknown> = {};
  for (const field of FIELDS) if (input[field] !== undefined && input[field] !== null && input[field] !== "") movement[field] = input[field];
  if (!MOVEMENT_TYPES.includes(movement.movementType as (typeof MOVEMENT_TYPES)[number])) {
    throw new ValidationError(`${label}: movementType must be one of ${MOVEMENT_TYPES.join(", ")}.`);
  }
  return movement;
}

export async function listLivestockSuggestions(tx: OrgTx, input: { open?: boolean } = {}): Promise<LivestockSuggestion[]> {
  const rows = await tx.query<Row>(`select ${COLUMNS} from livestock_suggestions where ($1::boolean is not true or decision is null) order by id desc limit 500`, [input.open ?? false]);
  return rows.rows.map(toSuggestion);
}

/** Saves up to 200 suggested movements, each with the evidence it came from (AIW8). */
export async function suggestLivestockMovements(tx: OrgTx, input: { suggestions: unknown }): Promise<LivestockSuggestion[]> {
  await requireLivestock(tx);
  const parsed = requireArray(input.suggestions, "suggestions", 200).map((raw, index) => {
    const entry = (raw ?? {}) as Record<string, unknown>;
    return {
      movement: movementFields(entry.movement, `Suggestion ${index + 1}`),
      evidence: requireString(entry.evidence, `Suggestion ${index + 1}'s evidence`, { maxLength: 2000 }),
    };
  });
  const open = await tx.query<{ n: number }>("select count(*)::int as n from livestock_suggestions where decision is null");
  if (open.rows[0].n + parsed.length > 1000) throw new ValidationError("There are already 1,000 suggestions waiting. Ask someone to accept or decline them first.");
  const ids: string[] = [];
  for (const entry of parsed) {
    const row = await tx.query<{ id: string }>("insert into livestock_suggestions (movement, evidence, suggested_by_email) values ($1::jsonb, $2, $3) returning id::text", [
      JSON.stringify(entry.movement),
      entry.evidence,
      tx.actor.email,
    ]);
    ids.push(row.rows[0].id);
  }
  await writeAuditEvent(tx, { eventType: "livestock.movements_suggested", entityType: "livestock_suggestion", entityId: ids[0] ?? "0", details: { count: ids.length } });
  return (await tx.query<Row>(`select ${COLUMNS} from livestock_suggestions where id = any($1::bigint[]) order by id`, [ids])).rows.map(toSuggestion);
}

async function reload(tx: OrgTx, id: string): Promise<LivestockSuggestion> {
  return toSuggestion((await tx.query<Row>(`select ${COLUMNS} from livestock_suggestions where id = $1`, [id])).rows[0]);
}

async function openSuggestion(tx: OrgTx, idInput: unknown): Promise<LivestockSuggestion> {
  const id = requireId(idInput, "suggestionId");
  const row = (await tx.query<Row>(`select ${COLUMNS} from livestock_suggestions where id = $1 for update`, [id])).rows[0];
  if (!row) throw new NotFoundError("Suggestion not found.");
  if (row.decision) throw new ConflictError(`That suggestion was already ${row.decision}.`);
  return toSuggestion(row);
}

/**
 * Accepts a suggestion (AIW8): records the movement as a person would, with
 * any changes they made (`changes`, e.g. a location or corrected head), so
 * every movement check applies.
 */
export async function acceptLivestockSuggestion(tx: OrgTx, idInput: unknown, input: { idempotencyKey: unknown; changes?: unknown }): Promise<{ suggestion: LivestockSuggestion; movement: Movement }> {
  const suggestion = await openSuggestion(tx, idInput);
  const changes = input.changes && typeof input.changes === "object" && !Array.isArray(input.changes) ? (input.changes as Record<string, unknown>) : {};
  const result = await recordMovement(tx, { ...suggestion.movement, ...changes, idempotencyKey: input.idempotencyKey, source: "livestock_suggestion" });
  await tx.query("update livestock_suggestions set decision = 'accepted', movement_id = $2, decided_by_email = $3, decided_at = now() where id = $1", [suggestion.id, result.movement.id, tx.actor.email]);
  await writeAuditEvent(tx, { eventType: "livestock.suggestion_accepted", entityType: "livestock_suggestion", entityId: suggestion.id, details: { movementId: result.movement.id } });
  return { suggestion: await reload(tx, suggestion.id), movement: result.movement };
}

export async function declineLivestockSuggestion(tx: OrgTx, idInput: unknown): Promise<LivestockSuggestion> {
  const suggestion = await openSuggestion(tx, idInput);
  await tx.query("update livestock_suggestions set decision = 'declined', decided_by_email = $2, decided_at = now() where id = $1", [suggestion.id, tx.actor.email]);
  await writeAuditEvent(tx, { eventType: "livestock.suggestion_declined", entityType: "livestock_suggestion", entityId: suggestion.id, details: {} });
  return reload(tx, suggestion.id);
}
