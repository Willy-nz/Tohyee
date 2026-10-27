import { randomUUID } from "node:crypto";
import { writeAuditEvent } from "@/lib/audit";
import { roleAtLeast } from "@/lib/auth/roles";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { canSeeFarm, visibleFarmIds } from "@/lib/farming/access";
import { requireFarming } from "@/lib/farming/paddocks";
import { canonicalJson, type ChainEntry, type ChainCheck, verifyChain } from "@/lib/safety/chain";
import { CHANGE_LABELS, type SafetyChange, type SafetyKind, type SafetyVersion } from "@/lib/safety/shared";
import { IDEMPOTENCY_KEY_PATTERN, optionalString } from "@/lib/validation";

/*
 * Safety records as versions (#446, decisions 930-936). Nothing here
 * updates or deletes: a change is a new version, a mistake is a "corrected"
 * version or the record is "withdrawn" (entered by mistake), each with why.
 * The database dates and chains every version (migration 0189).
 *
 * Who sees what:
 * - Records belong to a farm; a member sees only their farms (decision 744).
 *   Records with no farm (shared templates) are seen by everyone who sees
 *   safety.
 * - Incident and medical details ("report_details") are restricted: owners,
 *   members an owner names, and the person who entered them (decision 936).
 */

/** Columns that give a `ChainEntry`, with the entry date exactly as hashed. */
export const ENTRY_COLUMNS = `e.seq::text, e.kind, e.record_id::text, e.version, e.change, e.farm_id::text, e.restricted,
  to_char(e.happened_on, 'YYYY-MM-DD') as happened_on,
  to_char(e.entered_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as entered_at,
  e.entered_by_user_id::text, e.entered_by_email, e.via, e.operation_id, e.body, e.previous_hash, e.hash`;

export type EntryRow = {
  seq: string;
  kind: SafetyKind;
  record_id: string;
  version: number;
  change: SafetyChange;
  farm_id: string | null;
  restricted: boolean;
  happened_on: string | null;
  entered_at: string;
  entered_by_user_id: string | null;
  entered_by_email: string;
  via: string | null;
  operation_id: string | null;
  body: string;
  previous_hash: string;
  hash: string;
};

export function toChainEntry(row: EntryRow, withhold = false): ChainEntry {
  return {
    seq: row.seq,
    kind: row.kind,
    recordId: row.record_id,
    version: row.version,
    change: row.change,
    farmId: row.farm_id,
    restricted: row.restricted,
    happenedOn: row.happened_on,
    enteredAt: row.entered_at,
    enteredByUserId: row.entered_by_user_id,
    enteredByEmail: row.entered_by_email,
    via: row.via,
    operationId: row.operation_id,
    body: withhold ? null : row.body,
    previousHash: row.previous_hash,
    hash: row.hash,
  };
}

export function toVersion<T>(row: EntryRow): SafetyVersion<T> {
  return {
    seq: row.seq,
    kind: row.kind,
    recordId: row.record_id,
    version: row.version,
    change: row.change,
    changeLabel: CHANGE_LABELS[row.change],
    farmId: row.farm_id,
    happenedOn: row.happened_on,
    enteredAt: row.entered_at,
    enteredByEmail: row.entered_by_email,
    via: row.via,
    hash: row.hash,
    data: JSON.parse(row.body) as T,
  };
}

// Access ----------------------------------------------------------------------------------------

/** Keeping the safety registers (hazards, equipment, inductions, training...): bookkeepers and above (decision 935). */
export function canRecordSafety(tx: OrgTx): boolean {
  return !tx.actor.userId || (tx.actor.role !== undefined && roleAtLeast(tx.actor.role, "bookkeeper"));
}

export function requireSafetyRecorder(tx: OrgTx): void {
  if (!canRecordSafety(tx)) throw new ForbiddenError("Recording safety needs the bookkeeper role or higher in this organisation.");
}

/** Farm staff (#447's farm_worker role) on their own farms, decision 960. */
export function isFarmStaff(tx: OrgTx): boolean {
  return tx.actor.role === "farm_worker";
}

/**
 * Reporting a hazard, near miss or incident, doing a pre-start check and
 * adding its photos: farm staff as well as bookkeepers and above (decision
 * 960). Which farms is checked as always (decision 744).
 */
export function canReportSafety(tx: OrgTx): boolean {
  return canRecordSafety(tx) || isFarmStaff(tx);
}

export function requireSafetyReporter(tx: OrgTx): void {
  if (!canReportSafety(tx)) throw new ForbiddenError("Reporting needs the farm staff or bookkeeper role or higher in this organisation.");
}

/** Whether the person sees restricted details they entered themselves: everyone but farm staff (decision 961). */
function seesOwnRestricted(tx: OrgTx): boolean {
  return !isFarmStaff(tx);
}

/** Whether the person sees restricted incident and medical details (decision 936). */
export async function canSeeRestricted(tx: OrgTx): Promise<boolean> {
  if (!tx.actor.userId) return true;
  // Farm staff never see injury or medical details, even if named (decision 961).
  if (isFarmStaff(tx)) return false;
  if (tx.actor.role === "owner") return true;
  const row = await tx.query("select 1 from safety_restricted_members where user_id = $1", [tx.actor.userId]);
  return row.rowCount > 0;
}

/** Whether this person may read this version (farm and restricted rules). */
async function canRead(tx: OrgTx, row: Pick<EntryRow, "farm_id" | "restricted" | "entered_by_user_id">, restricted: boolean): Promise<boolean> {
  if (row.farm_id && !(await canSeeFarm(tx, row.farm_id))) return false;
  if (row.restricted && !restricted && (!seesOwnRestricted(tx) || row.entered_by_user_id !== tx.actor.userId)) return false;
  return true;
}

// Writing ---------------------------------------------------------------------------------------

export type AppendInput = {
  kind: SafetyKind;
  /** Absent for a new record. */
  recordId?: string;
  /** For a change: the version the person was looking at; a later one is a conflict. */
  expectedVersion?: unknown;
  change: SafetyChange;
  farmId: string | null;
  happenedOn?: string | null;
  data: Record<string, unknown>;
  /** The phone's id for this save (decision 933). */
  operationId?: unknown;
};

function operationIdOf(input: unknown): string | null {
  if (input == null || input === "") return null;
  if (typeof input !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(input)) throw new ValidationError("That save's id isn't valid. Reload the page and try again.");
  return input;
}

/**
 * Adds one version. A new record (no `recordId`) starts at version 1; a
 * change must name the version it started from. A save sent again with the
 * same operation id returns the version it made the first time.
 */
export async function appendEntry<T>(tx: OrgTx, input: AppendInput): Promise<SafetyVersion<T>> {
  await requireFarming(tx);
  const operationId = operationIdOf(input.operationId);
  const body = canonicalJson(input.data);
  if (operationId) {
    const existing = await tx.query<EntryRow>(`select ${ENTRY_COLUMNS} from safety_entries e where e.operation_id = $1`, [operationId]);
    if (existing.rows[0]) {
      const row = existing.rows[0];
      if (row.kind !== input.kind || row.body !== body || (input.recordId && row.record_id !== input.recordId)) {
        throw new ConflictError("This save was already sent with different details. Reload and check the record.");
      }
      return toVersion<T>(row);
    }
  }
  if (input.farmId && !(await canSeeFarm(tx, input.farmId))) throw new NotFoundError("Farm not found.");
  if (input.farmId && !input.recordId) {
    const farm = await tx.query<{ is_active: boolean }>("select is_active from farms where id = $1", [input.farmId]);
    if (!farm.rows[0]) throw new NotFoundError("Farm not found.");
    if (!farm.rows[0].is_active) throw new ValidationError("That farm is archived. Bring it back under Farms and paddocks to add records to it.");
  }
  let recordId = input.recordId;
  let version = 1;
  if (recordId) {
    if (input.change === "created") throw new ValidationError("A change can't be a new record.");
    const latest = await latestRow(tx, recordId);
    if (!latest || latest.kind !== input.kind || !(await canRead(tx, latest, await canSeeRestricted(tx)))) throw new NotFoundError("That safety record wasn't found.");
    if (latest.change === "withdrawn") throw new ValidationError("This record was withdrawn as entered by mistake, so it can't be changed. Add a new one.");
    if (String(input.expectedVersion ?? "") !== String(latest.version)) {
      throw new ConflictError(`Someone changed this record (version ${latest.version}) since you opened it. Reload to see their change, then try again.`);
    }
    if (input.change === "corrected" || input.change === "withdrawn") {
      if (!optionalString(input.data.why, "Why", { maxLength: 1000 })) throw new ValidationError(input.change === "corrected" ? "Say what was wrong, so the history shows why it was corrected." : "Say why it's withdrawn.");
    }
    version = latest.version + 1;
  } else {
    if (input.change !== "created") throw new ValidationError("A new record starts as created.");
    recordId = randomUUID();
  }
  const inserted = await tx.query<EntryRow>(
    `with added as (
       insert into safety_entries (seq, kind, record_id, version, change, farm_id, restricted, happened_on,
                                   entered_by_user_id, entered_by_email, via, operation_id, body, previous_hash, hash)
       values (0, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, '${"0".repeat(64)}', '${"0".repeat(64)}')
       returning *)
     select ${ENTRY_COLUMNS} from added e`,
    [input.kind, recordId, version, input.change, input.farmId, input.kind === "report_details", input.happenedOn ?? null, tx.actor.userId, tx.actor.email, tx.actor.via ?? null, operationId, body],
  );
  const row = inserted.rows[0];
  await writeAuditEvent(tx, { eventType: `safety.${input.kind}.${input.change}`, entityType: "safety_record", entityId: row.record_id, details: { version: row.version, seq: row.seq } });
  return toVersion<T>(row);
}

async function latestRow(tx: OrgTx, recordId: string): Promise<EntryRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(recordId)) return null;
  const row = await tx.query<EntryRow>(`select ${ENTRY_COLUMNS} from safety_entries e where e.record_id = $1 order by e.version desc limit 1`, [recordId]);
  return row.rows[0] ?? null;
}

// Reading ---------------------------------------------------------------------------------------

/** The latest version of each record of a kind on the person's farms (and shared ones), oldest first. */
export async function currentRecords<T>(tx: OrgTx, kind: SafetyKind, filter: { farmId?: string | null; includeWithdrawn?: boolean } = {}): Promise<Array<SafetyVersion<T> & { firstEnteredAt: string; firstEnteredByEmail: string }>> {
  await requireFarming(tx);
  const visible = await visibleFarmIds(tx);
  const restricted = kind === "report_details" ? await canSeeRestricted(tx) : true;
  const rows = await tx.query<EntryRow & { first_entered_at: string; first_entered_by_email: string }>(
    `select ${ENTRY_COLUMNS},
            to_char(f.entered_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as first_entered_at, f.entered_by_email as first_entered_by_email
       from (select distinct on (record_id) * from safety_entries where kind = $1 order by record_id, version desc) e
       join safety_entries f on f.record_id = e.record_id and f.version = 1
      where ($2::bigint is null or e.farm_id = $2 or e.farm_id is null)
        and ($3::bigint[] is null or e.farm_id is null or e.farm_id = any($3::bigint[]))
        and ($4 or e.change <> 'withdrawn')
        and ($5 or not e.restricted or f.entered_by_user_id = $6)
      order by f.seq`,
    [kind, filter.farmId ?? null, visible, filter.includeWithdrawn ?? false, restricted, seesOwnRestricted(tx) ? tx.actor.userId : null],
  );
  return rows.rows.map((row) => ({ ...toVersion<T>(row), firstEnteredAt: row.first_entered_at, firstEnteredByEmail: row.first_entered_by_email }));
}

/** One record's latest version, if the person may see it. */
export async function currentRecord<T>(tx: OrgTx, kind: SafetyKind, recordId: unknown): Promise<SafetyVersion<T>> {
  await requireFarming(tx);
  const row = typeof recordId === "string" ? await latestRow(tx, recordId) : null;
  if (!row || row.kind !== kind || !(await canRead(tx, row, await canSeeRestricted(tx)))) throw new NotFoundError("That safety record wasn't found.");
  return toVersion<T>(row);
}

/** Every version of a record, oldest first, with who entered each and when (decision 932). */
export async function recordHistory(tx: OrgTx, recordId: unknown): Promise<Array<SafetyVersion<Record<string, unknown>>>> {
  await requireFarming(tx);
  if (typeof recordId !== "string" || !/^[0-9a-f-]{36}$/i.test(recordId)) throw new NotFoundError("That safety record wasn't found.");
  const rows = await tx.query<EntryRow>(`select ${ENTRY_COLUMNS} from safety_entries e where e.record_id = $1 order by e.version`, [recordId]);
  if (!rows.rows[0] || !(await canRead(tx, rows.rows[0], await canSeeRestricted(tx)))) throw new NotFoundError("That safety record wasn't found.");
  return rows.rows.map((row) => toVersion<Record<string, unknown>>(row));
}

// Checking the history ----------------------------------------------------------------------------

export type SafetyChainReport = ChainCheck & {
  total: number;
  /** Problems with the kind of record, never its details. */
  problemsAt: Array<{ seq: string; kind: string; problem: string }>;
  checkedAt: string;
};

/**
 * Works out every entry's hash again, outside the database, and follows the
 * chain (decision 931). Only numbers, kinds and whether they check out are
 * returned, so anyone who can see safety may run it.
 */
export async function checkSafetyHistory(tx: OrgTx, copy?: { seq: string; hash: string } | null): Promise<SafetyChainReport & { copy: "found" | "different" | "missing" | null }> {
  await requireFarming(tx);
  const rows = await tx.query<EntryRow>(`select ${ENTRY_COLUMNS} from safety_entries e order by e.seq`);
  const entries = rows.rows.map((row) => toChainEntry(row));
  const result = verifyChain(entries);
  const kinds = new Map(rows.rows.map((row) => [row.seq, row.kind]));
  const now = await tx.query<{ now: string }>("select to_char(now() at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') as now");
  let copyResult: "found" | "different" | "missing" | null = null;
  if (copy) {
    const seq = String(copy.seq ?? "").trim();
    const hash = String(copy.hash ?? "").trim().toLowerCase();
    if (!/^[1-9]\d{0,17}$/.test(seq) || !/^[0-9a-f]{64}$/.test(hash)) throw new ValidationError("Enter the entry number and the 64-letter hash from the copy.");
    const entry = entries.find((each) => each.seq === seq);
    copyResult = !entry ? "missing" : entry.hash === hash ? "found" : "different";
  }
  return {
    ...result,
    total: entries.length,
    problemsAt: result.problems.map((problem) => ({ seq: problem.seq, kind: kinds.get(problem.seq) ?? "", problem: problem.problem })),
    checkedAt: now.rows[0].now,
    copy: copyResult,
  };
}

// Restricted access ----------------------------------------------------------------------------

export async function listRestrictedMembers(tx: OrgTx): Promise<Array<{ userId: string; grantedByEmail: string; grantedAt: string }>> {
  const rows = await tx.query<{ user_id: string; granted_by_email: string; granted_at: string }>("select user_id::text, granted_by_email, granted_at from safety_restricted_members order by granted_at");
  return rows.rows.map((row) => ({ userId: row.user_id, grantedByEmail: row.granted_by_email, grantedAt: new Date(row.granted_at).toISOString() }));
}

/** Owners choose who else sees incident and medical details (decision 936). */
export async function setRestrictedMember(tx: OrgTx, input: { userId: unknown; allowed: unknown }) {
  if (tx.actor.role !== "owner") throw new ForbiddenError("Only an owner can choose who sees incident and medical details.");
  const userId = typeof input.userId === "string" && /^[0-9a-f-]{36}$/i.test(input.userId) ? input.userId.toLowerCase() : null;
  if (!userId) throw new ValidationError("Choose a member.");
  if (input.allowed === true) {
    await tx.query("insert into safety_restricted_members (user_id, granted_by_email) values ($1, $2) on conflict (user_id) do nothing", [userId, tx.actor.email]);
  } else {
    await tx.query("delete from safety_restricted_members where user_id = $1", [userId]);
  }
  await writeAuditEvent(tx, { eventType: input.allowed === true ? "safety.restricted_granted" : "safety.restricted_removed", entityType: "user", entityId: userId });
  return listRestrictedMembers(tx);
}

