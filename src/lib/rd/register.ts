import { writeAuditEvent } from "@/lib/audit";
import { parseIsoDate, todayIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { assertSameRequest, requestHash } from "@/lib/idempotency";
import { incomeYearOf, RD_ACTIVITY_KINDS, RD_PLACES, type RdActivityKind, type RdPlace } from "@/lib/rd/amounts";
import {
  iso,
  loadHistory,
  optionalIncomeYear,
  rdSettings,
  requireIncomeYear,
  requireUuid,
  writeHistory,
  yearLabel,
  type HistoryEntry,
  type RdSettings,
} from "@/lib/rd/common";
import { insertRdFile, listRdFiles, type RdFile } from "@/lib/rd/files";
import { asRecord, optionalString, requireArray, requireIdempotencyKey, requireOneOf, requireString } from "@/lib/validation";

/**
 * The R&D activity register (examples RD1-RD3; decisions 39, 40, 47). An
 * activity is core or supporting, performed in New Zealand or overseas, and
 * has the descriptions IRD asks for in the general approval application
 * (IR1240 p 104). Tohyee never decides whether work is R&D: IRD does, when
 * it approves the activity. Activities are archived, never deleted; every
 * change keeps the old version with who changed it and when.
 */

export type RdActivityRef = { id: string; code: string; name: string; kind: RdActivityKind; status: "active" | "archived" };

export type RdApproval = {
  id: string;
  kind: "general";
  reference: string;
  letterDate: string;
  firstIncomeYear: number;
  lastIncomeYear: number;
  yearsLabel: string;
  note: string | null;
  status: "active" | "withdrawn";
  withdrawnReason: string | null;
  withdrawnAt: string | null;
  withdrawnByEmail: string | null;
  activities: RdActivityRef[];
  createdAt: string;
  createdByEmail: string;
  /** Tohyee can't check approvals with IRD (decision 40). */
  checkedWithIrd: false;
  letters: RdFile[];
};

export type RdActivity = {
  id: string;
  code: string;
  name: string;
  projectName: string;
  kind: RdActivityKind;
  place: RdPlace;
  firstIncomeYear: number;
  lastIncomeYear: number | null;
  yearsLabel: string;
  purposeAndUncertainty: string;
  whyNotPublicKnowledge: string;
  systematicApproach: string;
  whyRequired: string;
  /** The core activities a supporting activity supports. */
  supports: RdActivityRef[];
  /** The supporting activities that support a core one. */
  supportedBy: RdActivityRef[];
  status: "active" | "archived";
  archivedAt: string | null;
  archivedByEmail: string | null;
  version: number;
  createdAt: string;
  createdByEmail: string;
  updatedAt: string;
  updatedByEmail: string;
  materialChangedAt: string | null;
  /** Income years covered by an active approval. */
  approvedYears: number[];
  /** Descriptions, type, place or links changed after the latest active approval was entered (TAA 68CB(3B); RD3). */
  changedSinceApproval: boolean;
};

export type RdActivityDetail = RdActivity & {
  approvals: RdApproval[];
  files: RdFile[];
  history: HistoryEntry[];
};

type ActivityRow = {
  id: string;
  code: string;
  name: string;
  project_name: string;
  kind: RdActivityKind;
  place: RdPlace;
  first_income_year: number;
  last_income_year: number | null;
  purpose_and_uncertainty: string;
  why_not_public_knowledge: string;
  systematic_approach: string;
  why_required: string;
  status: "active" | "archived";
  archived_at: Date | null;
  archived_by_email: string | null;
  version: number;
  created_at: Date;
  created_by_email: string;
  updated_at: Date;
  updated_by_email: string;
  material_changed_at: Date | null;
  request_hash: string;
};

const ACTIVITY_COLUMNS = `id, code, name, project_name, kind, place, first_income_year, last_income_year, purpose_and_uncertainty,
  why_not_public_knowledge, systematic_approach, why_required, status, archived_at, archived_by_email, version, created_at,
  created_by_email, updated_at, updated_by_email, material_changed_at, request_hash`;

const DESCRIPTION_FIELDS = ["purposeAndUncertainty", "whyNotPublicKnowledge", "systematicApproach", "whyRequired"] as const;

export function yearsLabel(settings: RdSettings, first: number, last: number | null): string {
  if (last == null) return `${yearLabel(settings, first)} onwards`;
  return first === last ? yearLabel(settings, first) : `${yearLabel(settings, first)} to ${yearLabel(settings, last)}`;
}

async function loadActivities(tx: OrgTx, where: string, params: unknown[]): Promise<RdActivity[]> {
  const settings = await rdSettings(tx);
  const rows = (await tx.query<ActivityRow>(`select ${ACTIVITY_COLUMNS} from rd_activities where ${where} order by lower(code)`, params)).rows;
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const links = (
    await tx.query<{ supporting_id: string; core_id: string; code: string; name: string; kind: RdActivityKind; status: "active" | "archived"; other_id: string }>(
      `select s.supporting_id, s.core_id, a.id as other_id, a.code, a.name, a.kind, a.status
         from rd_activity_supports s join rd_activities a on a.id = case when s.supporting_id = any($1::uuid[]) then s.core_id else s.supporting_id end
        where s.supporting_id = any($1::uuid[]) or s.core_id = any($1::uuid[])
        order by lower(a.code)`,
      [ids],
    )
  ).rows;
  const approvals = (
    await tx.query<{ activity_id: string; first_income_year: number; last_income_year: number; created_at: Date }>(
      `select aa.activity_id, p.first_income_year, p.last_income_year, p.created_at
         from rd_approval_activities aa join rd_approvals p on p.id = aa.approval_id
        where aa.activity_id = any($1::uuid[]) and p.status = 'active'`,
      [ids],
    )
  ).rows;
  return rows.map((row) => {
    const mine = approvals.filter((approval) => approval.activity_id === row.id);
    const years = new Set<number>();
    for (const approval of mine) for (let year = approval.first_income_year; year <= approval.last_income_year; year++) years.add(year);
    const latestApproval = mine.reduce<Date | null>((latest, approval) => (latest == null || approval.created_at > latest ? approval.created_at : latest), null);
    const ref = (link: (typeof links)[number]): RdActivityRef => ({ id: link.other_id, code: link.code, name: link.name, kind: link.kind, status: link.status });
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      projectName: row.project_name,
      kind: row.kind,
      place: row.place,
      firstIncomeYear: row.first_income_year,
      lastIncomeYear: row.last_income_year,
      yearsLabel: yearsLabel(settings, row.first_income_year, row.last_income_year),
      purposeAndUncertainty: row.purpose_and_uncertainty,
      whyNotPublicKnowledge: row.why_not_public_knowledge,
      systematicApproach: row.systematic_approach,
      whyRequired: row.why_required,
      supports: links.filter((link) => link.supporting_id === row.id).map(ref),
      supportedBy: links.filter((link) => link.core_id === row.id).map(ref),
      status: row.status,
      archivedAt: row.archived_at ? iso(row.archived_at) : null,
      archivedByEmail: row.archived_by_email,
      version: row.version,
      createdAt: iso(row.created_at),
      createdByEmail: row.created_by_email,
      updatedAt: iso(row.updated_at),
      updatedByEmail: row.updated_by_email,
      materialChangedAt: row.material_changed_at ? iso(row.material_changed_at) : null,
      approvedYears: [...years].sort((a, b) => a - b),
      changedSinceApproval: latestApproval != null && row.material_changed_at != null && row.material_changed_at > latestApproval,
    };
  });
}

/** The register (viewers and above). Archived activities only when asked for. */
export async function listActivities(tx: OrgTx, options: { includeArchived?: boolean } = {}): Promise<RdActivity[]> {
  return loadActivities(tx, options.includeArchived ? "true" : "status = 'active'", []);
}

export async function getActivity(tx: OrgTx, idInput: unknown): Promise<RdActivityDetail> {
  const id = requireUuid(idInput, "activityId");
  const activity = (await loadActivities(tx, "id = $1", [id]))[0];
  if (!activity) throw new NotFoundError("R&D activity not found.");
  const approvalIds = (
    await tx.query<{ approval_id: string }>("select approval_id from rd_approval_activities where activity_id = $1", [id])
  ).rows.map((row) => row.approval_id);
  return {
    ...activity,
    approvals: await loadApprovals(tx, approvalIds),
    files: await listRdFiles(tx, "activity", [id]),
    history: await loadHistory(tx, "activity", id),
  };
}

type ActivityInput = {
  code: string;
  name: string;
  projectName: string;
  kind: RdActivityKind;
  place: RdPlace;
  firstIncomeYear: number;
  lastIncomeYear: number | null;
  purposeAndUncertainty: string;
  whyNotPublicKnowledge: string;
  systematicApproach: string;
  whyRequired: string;
  supports: string[];
};

function description(input: unknown, field: string): string {
  return optionalString(input, field, { maxLength: 10000 }) ?? "";
}

function parseActivity(body: Record<string, unknown>): ActivityInput {
  const kind = requireOneOf(body.kind, "kind", RD_ACTIVITY_KINDS);
  const place = requireOneOf(body.place ?? "nz", "place", RD_PLACES);
  if (kind === "core" && place === "overseas") {
    throw new ValidationError("Core R&D must be performed in New Zealand (LY 2(1)(c)); only a supporting activity can be overseas.");
  }
  const firstIncomeYear = requireIncomeYear(body.firstIncomeYear, "firstIncomeYear");
  const lastIncomeYear = optionalIncomeYear(body.lastIncomeYear, "lastIncomeYear");
  if (lastIncomeYear != null && lastIncomeYear < firstIncomeYear) throw new ValidationError("The last income year can't be before the first.");
  const supports = body.supports == null ? [] : requireArray(body.supports, "supports", 50).map((id) => requireUuid(id, "supports"));
  if (kind === "core" && supports.length > 0) throw new ValidationError("A core activity doesn't support another activity; only supporting activities are linked.");
  if (kind === "supporting" && supports.length === 0) throw new ValidationError("A supporting activity needs the core activity (or activities) it supports.");
  const whyRequired = description(body.whyRequired, "whyRequired");
  if (kind === "core" && whyRequired) throw new ValidationError("Why it was required is asked only for supporting activities.");
  return {
    code: requireString(body.code, "code", {
      maxLength: 20,
      pattern: /^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$/,
      patternHint: "The code is up to 20 letters, numbers, dots, dashes or underscores, like C1.",
    }),
    name: requireString(body.name, "name", { maxLength: 200 }),
    projectName: requireString(body.projectName, "projectName", { maxLength: 200 }),
    kind,
    place,
    firstIncomeYear,
    lastIncomeYear,
    purposeAndUncertainty: description(body.purposeAndUncertainty, "purposeAndUncertainty"),
    whyNotPublicKnowledge: description(body.whyNotPublicKnowledge, "whyNotPublicKnowledge"),
    systematicApproach: description(body.systematicApproach, "systematicApproach"),
    whyRequired,
    supports: [...new Set(supports)].sort(),
  };
}

/** The linked activities must be active core activities (RD2; decision 39). */
async function checkSupports(tx: OrgTx, input: ActivityInput, selfId: string | null): Promise<void> {
  if (input.supports.length === 0) return;
  if (selfId && input.supports.includes(selfId)) throw new ValidationError("An activity can't support itself.");
  const found = (
    await tx.query<{ id: string; code: string; kind: RdActivityKind; status: string }>(
      "select id, code, kind, status from rd_activities where id = any($1::uuid[]) for share",
      [input.supports],
    )
  ).rows;
  if (found.length !== input.supports.length) throw new ValidationError("One of the activities it supports doesn't exist.");
  for (const core of found) {
    if (core.kind !== "core") throw new ValidationError(`${core.code} is a supporting activity; a supporting activity can only support core activities.`);
    if (core.status !== "active") throw new ValidationError(`${core.code} is archived.`);
  }
}

function snapshot(input: ActivityInput, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...input, ...extra };
}

function codeTaken(error: unknown): boolean {
  const pg = error as { code?: string; constraint?: string };
  return pg?.code === "23505" && pg.constraint === "rd_activities_code_idx";
}

/** Registers an activity (RD1, RD2). Bookkeepers and above. */
export async function createActivity(tx: OrgTx, bodyInput: unknown): Promise<{ created: boolean; activity: RdActivityDetail }> {
  const body = asRecord(bodyInput, "body");
  const idempotencyKey = requireIdempotencyKey(body.idempotencyKey);
  const input = parseActivity(body);
  const hash = requestHash("rd_activity", input);
  const existing = (await tx.query<{ id: string; request_hash: string }>("select id, request_hash from rd_activities where idempotency_key = $1", [idempotencyKey])).rows[0];
  if (existing) {
    assertSameRequest(existing.request_hash, hash, "R&D activity");
    return { created: false, activity: await getActivity(tx, existing.id) };
  }
  await checkSupports(tx, input, null);
  let id: string;
  try {
    await tx.query("savepoint rd_activity_insert");
    id = (
      await tx.query<{ id: string }>(
        `insert into rd_activities (idempotency_key, request_hash, code, name, project_name, kind, place, first_income_year, last_income_year,
                                    purpose_and_uncertainty, why_not_public_knowledge, systematic_approach, why_required,
                                    created_by_user_id, created_by_email, updated_by_user_id, updated_by_email)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $14, $15) returning id`,
        [
          idempotencyKey,
          hash,
          input.code,
          input.name,
          input.projectName,
          input.kind,
          input.place,
          input.firstIncomeYear,
          input.lastIncomeYear,
          input.purposeAndUncertainty,
          input.whyNotPublicKnowledge,
          input.systematicApproach,
          input.whyRequired,
          tx.actor.userId,
          tx.actor.email,
        ],
      )
    ).rows[0].id;
    await tx.query("release savepoint rd_activity_insert");
  } catch (error) {
    if (codeTaken(error)) {
      await tx.query("rollback to savepoint rd_activity_insert");
      throw new ConflictError(`There's already an R&D activity with the code ${input.code}.`);
    }
    throw error;
  }
  for (const coreId of input.supports) {
    await tx.query("insert into rd_activity_supports (supporting_id, core_id) values ($1, $2)", [id, coreId]);
  }
  await writeHistory(tx, "activity", id, "created", snapshot(input, { status: "active" }));
  await writeAuditEvent(tx, { eventType: "rd.activity_created", entityType: "rd_activity", entityId: id, details: { code: input.code, kind: input.kind } });
  return { created: true, activity: await getActivity(tx, id) };
}

async function lockActivity(tx: OrgTx, id: string): Promise<ActivityRow & { supports: string[] }> {
  const row = (await tx.query<ActivityRow>(`select ${ACTIVITY_COLUMNS} from rd_activities where id = $1 for update`, [id])).rows[0];
  if (!row) throw new NotFoundError("R&D activity not found.");
  const supports = (await tx.query<{ core_id: string }>("select core_id from rd_activity_supports where supporting_id = $1 order by core_id", [id])).rows.map(
    (link) => link.core_id,
  );
  return { ...row, supports };
}

function currentInput(row: ActivityRow & { supports: string[] }): ActivityInput {
  return {
    code: row.code,
    name: row.name,
    projectName: row.project_name,
    kind: row.kind,
    place: row.place,
    firstIncomeYear: row.first_income_year,
    lastIncomeYear: row.last_income_year,
    purposeAndUncertainty: row.purpose_and_uncertainty,
    whyNotPublicKnowledge: row.why_not_public_knowledge,
    systematicApproach: row.systematic_approach,
    whyRequired: row.why_required,
    supports: row.supports,
  };
}

/**
 * Changes an activity (bookkeepers and above). The old version stays in its
 * history. A change to the descriptions, type, place or links is a material
 * change: the activity shows "changed since approval was entered" if an
 * approval was entered before it (RD3; TAA 68CB(3B)). `version` must be the
 * version the person edited, so two people's changes don't overwrite each
 * other silently.
 */
export async function updateActivity(tx: OrgTx, idInput: unknown, bodyInput: unknown): Promise<RdActivityDetail> {
  const id = requireUuid(idInput, "activityId");
  const body = asRecord(bodyInput, "body");
  const current = await lockActivity(tx, id);
  if (body.version != null && Number(body.version) !== current.version) {
    throw new ConflictError("Someone else changed this activity since you opened it. Reload it and make your change again.");
  }
  if (current.status !== "active") throw new ValidationError("This activity is archived. Restore it before changing it.");
  const before = currentInput(current);
  const input = parseActivity({ ...before, ...body });
  if (input.kind !== before.kind && before.kind === "core") {
    const supported = await tx.query<{ code: string }>(
      "select a.code from rd_activity_supports s join rd_activities a on a.id = s.supporting_id where s.core_id = $1 order by lower(a.code)",
      [id],
    );
    if (supported.rows[0]) {
      throw new ValidationError(`${current.code} is supported by ${supported.rows.map((row) => row.code).join(", ")}, so it has to stay a core activity.`);
    }
  }
  await checkSupports(tx, input, id);
  const changed = (Object.keys(input) as (keyof ActivityInput)[]).filter((key) => JSON.stringify(input[key]) !== JSON.stringify(before[key]));
  if (changed.length === 0) return getActivity(tx, id);
  const material = changed.some((key) => key === "kind" || key === "place" || key === "supports" || (DESCRIPTION_FIELDS as readonly string[]).includes(key));
  try {
    await tx.query("savepoint rd_activity_update");
    await tx.query(
      `update rd_activities
          set code = $2, name = $3, project_name = $4, kind = $5, place = $6, first_income_year = $7, last_income_year = $8,
              purpose_and_uncertainty = $9, why_not_public_knowledge = $10, systematic_approach = $11, why_required = $12,
              version = version + 1, updated_by_user_id = $13, updated_by_email = $14,
              material_changed_at = case when $15 then now() else material_changed_at end
        where id = $1`,
      [
        id,
        input.code,
        input.name,
        input.projectName,
        input.kind,
        input.place,
        input.firstIncomeYear,
        input.lastIncomeYear,
        input.purposeAndUncertainty,
        input.whyNotPublicKnowledge,
        input.systematicApproach,
        input.whyRequired,
        tx.actor.userId,
        tx.actor.email,
        material,
      ],
    );
    await tx.query("release savepoint rd_activity_update");
  } catch (error) {
    if (codeTaken(error)) {
      await tx.query("rollback to savepoint rd_activity_update");
      throw new ConflictError(`There's already an R&D activity with the code ${input.code}.`);
    }
    throw error;
  }
  if (changed.includes("supports")) {
    await tx.query("delete from rd_activity_supports where supporting_id = $1 and not (core_id = any($2::uuid[]))", [id, input.supports]);
    for (const coreId of input.supports) {
      await tx.query("insert into rd_activity_supports (supporting_id, core_id) values ($1, $2) on conflict do nothing", [id, coreId]);
    }
  }
  await writeHistory(tx, "activity", id, "changed", snapshot(input, { status: "active", changed }));
  await writeAuditEvent(tx, { eventType: "rd.activity_changed", entityType: "rd_activity", entityId: id, details: { changed, material } });
  return getActivity(tx, id);
}

/**
 * Archives or restores an activity (admins and above). Its tags and history
 * stay; an archived activity can't be tagged. A core activity can't be
 * archived while an active supporting activity supports it.
 */
export async function setActivityArchived(tx: OrgTx, idInput: unknown, archivedInput: unknown): Promise<RdActivityDetail> {
  const id = requireUuid(idInput, "activityId");
  if (typeof archivedInput !== "boolean") throw new ValidationError("archived must be true or false.");
  const current = await lockActivity(tx, id);
  if ((current.status === "archived") === archivedInput) return getActivity(tx, id);
  if (archivedInput) {
    const supported = await tx.query<{ code: string }>(
      `select a.code from rd_activity_supports s join rd_activities a on a.id = s.supporting_id
        where s.core_id = $1 and a.status = 'active' order by lower(a.code)`,
      [id],
    );
    if (supported.rows[0]) {
      throw new ValidationError(`${current.code} is supported by ${supported.rows.map((row) => row.code).join(", ")}. Archive or relink them first.`);
    }
    await tx.query(
      `update rd_activities set status = 'archived', archived_at = now(), archived_by_user_id = $2, archived_by_email = $3,
              version = version + 1, updated_by_user_id = $2, updated_by_email = $3 where id = $1`,
      [id, tx.actor.userId, tx.actor.email],
    );
  } else {
    await tx.query(
      `update rd_activities set status = 'active', archived_at = null, archived_by_user_id = null, archived_by_email = null,
              version = version + 1, updated_by_user_id = $2, updated_by_email = $3 where id = $1`,
      [id, tx.actor.userId, tx.actor.email],
    );
  }
  await writeHistory(tx, "activity", id, archivedInput ? "archived" : "restored", snapshot(currentInput(current), { status: archivedInput ? "archived" : "active" }));
  await writeAuditEvent(tx, { eventType: archivedInput ? "rd.activity_archived" : "rd.activity_restored", entityType: "rd_activity", entityId: id });
  return getActivity(tx, id);
}

// ---------------------------------------------------------------------------
// Approvals (RD3; decision 40)

type ApprovalRow = {
  id: string;
  kind: "general";
  reference: string;
  letter_date: string;
  first_income_year: number;
  last_income_year: number;
  note: string | null;
  status: "active" | "withdrawn";
  withdrawn_reason: string | null;
  withdrawn_at: Date | null;
  withdrawn_by_email: string | null;
  created_at: Date;
  created_by_email: string;
};

async function loadApprovals(tx: OrgTx, ids: string[]): Promise<RdApproval[]> {
  if (ids.length === 0) return [];
  const settings = await rdSettings(tx);
  const rows = (
    await tx.query<ApprovalRow>(
      `select id, kind, letter_date::text, reference, first_income_year, last_income_year, note, status, withdrawn_reason, withdrawn_at,
              withdrawn_by_email, created_at, created_by_email
         from rd_approvals where id = any($1::uuid[]) order by first_income_year, created_at`,
      [ids],
    )
  ).rows;
  const activities = (
    await tx.query<RdActivityRef & { approval_id: string }>(
      `select aa.approval_id, a.id, a.code, a.name, a.kind, a.status from rd_approval_activities aa join rd_activities a on a.id = aa.activity_id
        where aa.approval_id = any($1::uuid[]) order by lower(a.code)`,
      [ids],
    )
  ).rows;
  const letters = await listRdFiles(tx, "approval", ids);
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    reference: row.reference,
    letterDate: row.letter_date,
    firstIncomeYear: row.first_income_year,
    lastIncomeYear: row.last_income_year,
    yearsLabel: yearsLabel(settings, row.first_income_year, row.last_income_year),
    note: row.note,
    status: row.status,
    withdrawnReason: row.withdrawn_reason,
    withdrawnAt: row.withdrawn_at ? iso(row.withdrawn_at) : null,
    withdrawnByEmail: row.withdrawn_by_email,
    activities: activities.filter((activity) => activity.approval_id === row.id).map(({ id, code, name, kind, status }) => ({ id, code, name, kind, status })),
    createdAt: iso(row.created_at),
    createdByEmail: row.created_by_email,
    checkedWithIrd: false,
    letters: letters.filter((file) => file.recordId === row.id),
  }));
}

export async function listApprovals(tx: OrgTx): Promise<RdApproval[]> {
  const ids = (await tx.query<{ id: string }>("select id from rd_approvals")).rows.map((row) => row.id);
  return loadApprovals(tx, ids);
}

/**
 * Enters a general approval from IRD's letter (RD3), with the letter
 * attached: it isn't saved without one (decision 40). Shown as "entered by
 * ... from IRD's letter; not checked with IRD". Bookkeepers and above.
 */
export async function createApproval(
  tx: OrgTx,
  input: {
    idempotencyKey: unknown;
    kind: unknown;
    reference: unknown;
    letterDate: unknown;
    firstIncomeYear: unknown;
    lastIncomeYear: unknown;
    activityIds: unknown;
    note: unknown;
    letter: { fileName: string; content: Uint8Array } | null;
  },
): Promise<{ created: boolean; approval: RdApproval }> {
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const kind = input.kind == null || input.kind === "" ? "general" : String(input.kind);
  if (kind !== "general") {
    throw new ValidationError("Only general approvals can be entered. Criteria and methodologies approval (significant performers) isn't supported yet.");
  }
  const reference = requireString(input.reference, "reference", { maxLength: 100 });
  const letterDate = parseIsoDate(input.letterDate, "letterDate");
  if (letterDate > todayIsoDate()) throw new ValidationError("The letter's date can't be in the future.");
  const firstIncomeYear = requireIncomeYear(input.firstIncomeYear, "firstIncomeYear");
  const lastIncomeYear = requireIncomeYear(input.lastIncomeYear ?? input.firstIncomeYear, "lastIncomeYear");
  if (lastIncomeYear < firstIncomeYear) throw new ValidationError("The last income year can't be before the first.");
  if (lastIncomeYear - firstIncomeYear > 2) throw new ValidationError("A general approval covers at most 3 income years (TAA 68CB(2)).");
  const ids = typeof input.activityIds === "string" ? input.activityIds.split(",").filter(Boolean) : input.activityIds;
  const activityIds = [...new Set(requireArray(ids, "activityIds", 200).map((id) => requireUuid(id, "activityIds")))].sort();
  if (activityIds.length === 0) throw new ValidationError("Choose the activities the approval covers.");
  const note = optionalString(input.note, "note", { maxLength: 2000 });
  if (!input.letter) throw new ValidationError("Attach IRD's approval letter. Approval details aren't saved without it.");
  const settings = await rdSettings(tx);
  const hash = requestHash("rd_approval", { kind, reference, letterDate, firstIncomeYear, lastIncomeYear, activityIds, note, fileName: input.letter.fileName, size: input.letter.content.length });
  const existing = (await tx.query<{ id: string; request_hash: string }>("select id, request_hash from rd_approvals where idempotency_key = $1", [idempotencyKey])).rows[0];
  if (existing) {
    assertSameRequest(existing.request_hash, hash, "R&D approval");
    return { created: false, approval: (await loadApprovals(tx, [existing.id]))[0] };
  }
  const activities = (await tx.query<{ id: string; code: string; status: string }>("select id, code, status from rd_activities where id = any($1::uuid[]) for share", [activityIds])).rows;
  if (activities.length !== activityIds.length) throw new ValidationError("One of the activities doesn't exist.");
  const archived = activities.find((activity) => activity.status !== "active");
  if (archived) throw new ValidationError(`${archived.code} is archived.`);
  const id = (
    await tx.query<{ id: string }>(
      `insert into rd_approvals (idempotency_key, request_hash, kind, reference, letter_date, first_income_year, last_income_year, note,
                                 created_by_user_id, created_by_email, updated_by_user_id, updated_by_email)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $9, $10) returning id`,
      [idempotencyKey, hash, kind, reference, letterDate, firstIncomeYear, lastIncomeYear, note, tx.actor.userId, tx.actor.email],
    )
  ).rows[0].id;
  for (const activityId of activityIds) {
    await tx.query("insert into rd_approval_activities (approval_id, activity_id) values ($1, $2)", [id, activityId]);
  }
  await insertRdFile(tx, {
    idempotencyKey: `${idempotencyKey}:letter`.slice(0, 120),
    hash,
    recordType: "approval",
    recordId: id,
    purpose: "approval_letter",
    fileName: input.letter.fileName,
    content: input.letter.content,
    replacesId: null,
  });
  await writeHistory(tx, "approval", id, "created", { kind, reference, letterDate, firstIncomeYear, lastIncomeYear, activityIds, note });
  await writeAuditEvent(tx, {
    eventType: "rd.approval_entered",
    entityType: "rd_approval",
    entityId: id,
    details: { reference, years: yearsLabel(settings, firstIncomeYear, lastIncomeYear), activityIds },
  });
  return { created: true, approval: (await loadApprovals(tx, [id]))[0] };
}

/** Withdraws an approval entered by mistake (admins and above). It stays in the register as withdrawn, with the reason. */
export async function withdrawApproval(tx: OrgTx, idInput: unknown, reasonInput: unknown): Promise<RdApproval> {
  const id = requireUuid(idInput, "approvalId");
  const reason = requireString(reasonInput, "reason", { maxLength: 500 });
  const row = (await tx.query<{ status: string }>("select status from rd_approvals where id = $1 for update", [id])).rows[0];
  if (!row) throw new NotFoundError("Approval not found.");
  if (row.status !== "active") throw new ValidationError("That approval has already been withdrawn.");
  await tx.query(
    `update rd_approvals set status = 'withdrawn', withdrawn_reason = $2, withdrawn_at = now(), withdrawn_by_user_id = $3, withdrawn_by_email = $4,
            version = version + 1, updated_by_user_id = $3, updated_by_email = $4 where id = $1`,
    [id, reason, tx.actor.userId, tx.actor.email],
  );
  await writeHistory(tx, "approval", id, "withdrawn", { reason });
  await writeAuditEvent(tx, { eventType: "rd.approval_withdrawn", entityType: "rd_approval", entityId: id, details: { reason } });
  return (await loadApprovals(tx, [id]))[0];
}

/** Whether an active approval covering the income year has been entered for an activity (decision 47). */
export async function approvedYearsFor(tx: OrgTx, activityIds: string[]): Promise<Map<string, Set<number>>> {
  const result = new Map<string, Set<number>>();
  if (activityIds.length === 0) return result;
  const rows = await tx.query<{ activity_id: string; first_income_year: number; last_income_year: number }>(
    `select aa.activity_id, p.first_income_year, p.last_income_year from rd_approval_activities aa join rd_approvals p on p.id = aa.approval_id
      where p.status = 'active' and aa.activity_id = any($1::uuid[])`,
    [activityIds],
  );
  for (const row of rows.rows) {
    const years = result.get(row.activity_id) ?? new Set<number>();
    for (let year = row.first_income_year; year <= row.last_income_year; year++) years.add(year);
    result.set(row.activity_id, years);
  }
  return result;
}

/** The income year a date is in, for messages. */
export function incomeYearText(settings: RdSettings, date: string): string {
  return yearLabel(settings, incomeYearOf(date, settings.yearEndMonth));
}
