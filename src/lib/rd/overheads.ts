import { writeAuditEvent } from "@/lib/audit";
import { parseIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { addDays } from "@/lib/financial-year";
import { assertSameRequest, requestHash } from "@/lib/idempotency";
import { add, cmp, dec, parseDecimalInput, sum, toFixedString } from "@/lib/money/decimal";
import { rdShare } from "@/lib/rd/amounts";
import { iso, loadHistories, rdSettings, requireUuid, timeliness, timeZone, writeHistory, type HistoryEntry, type Timeliness } from "@/lib/rd/common";
import { insertRdFile, listRdFiles, type RdFile } from "@/lib/rd/files";
import type { RdActivityRef } from "@/lib/rd/register";
import { SOURCES, UNTAGGABLE_SYSTEM_KEYS, type RdSourceType } from "@/lib/rd/tags";
import { asRecord, optionalString, requireIdempotencyKey, requireOneOf, requireString } from "@/lib/validation";

/**
 * Overhead rules (examples RD10, RD23, RD34, RD35; decisions 46, 58): "% of
 * an account" to an R&D activity over a period, with a basis from IR1240
 * p 15's list, a description of the calculation and the workings attached.
 * Applied when the claim report runs to every posted line on the account in
 * the period (excluding GST, rounded down per line); a line with its own tag
 * keeps its tag. Nothing is posted or tagged, and rules are never deleted:
 * changing one adds a rule that replaces it.
 */

/** IR1240 p 15: "a percentage of time; floor area used for the R&D; days/units of usage; volume used; unit sales; dollar value; activity-based costing principles". */
export const RD_OVERHEAD_BASES = {
  time: "Percentage of time",
  floor_area: "Floor area used for the R&D",
  usage: "Days or units of usage",
  volume: "Volume used",
  unit_sales: "Unit sales",
  dollar_value: "Dollar value",
  activity_based_costing: "Activity-based costing",
} as const;
export type RdOverheadBasis = keyof typeof RD_OVERHEAD_BASES;
export const RD_OVERHEAD_BASIS_CODES = Object.keys(RD_OVERHEAD_BASES) as RdOverheadBasis[];

const HUNDRED = dec("100");

export type RdOverheadRule = {
  id: string;
  accountId: string;
  accountCode: string;
  accountName: string;
  activity: RdActivityRef;
  percentage: string;
  basis: RdOverheadBasis;
  basisLabel: string;
  basisDetail: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  status: "active" | "replaced";
  replacedAt: string | null;
  replacesId: string | null;
  replacedById: string | null;
  version: number;
  createdAt: string;
  createdByEmail: string;
  updatedAt: string;
  updatedByEmail: string;
  /** Entered relative to the start of its period (decision 38). */
  timeliness: Timeliness;
  /** Entered after the period it covers began (RD23, RD35). */
  enteredAfterStart: boolean;
  files: RdFile[];
  history: HistoryEntry[];
};

type RuleRow = {
  id: string;
  account_id: string;
  account_code: string;
  account_name: string;
  activity_id: string;
  activity_code: string;
  activity_name: string;
  activity_kind: "core" | "supporting";
  activity_status: "active" | "archived";
  percentage: string;
  basis: RdOverheadBasis;
  basis_detail: string;
  effective_from: string;
  effective_to: string | null;
  status: "active" | "replaced";
  replaced_at: Date | null;
  replaces_id: string | null;
  replaced_by_id: string | null;
  version: number;
  created_at: Date;
  created_by_email: string;
  updated_at: Date;
  updated_by_email: string;
  entered_on: string;
  request_hash: string;
};

const RULE_QUERY = `
  select r.id, r.account_id::text, a.code as account_code, a.name as account_name, r.activity_id, act.code as activity_code,
         act.name as activity_name, act.kind as activity_kind, act.status as activity_status, r.percentage::text, r.basis, r.basis_detail,
         r.effective_from::text, r.effective_to::text, r.status, r.replaced_at, r.replaces_id,
         (select n.id from rd_overhead_rules n where n.replaces_id = r.id) as replaced_by_id, r.version, r.created_at, r.created_by_email,
         r.updated_at, r.updated_by_email, to_char((r.created_at at time zone $1)::date, 'YYYY-MM-DD') as entered_on, r.request_hash
    from rd_overhead_rules r join accounts a on a.id = r.account_id join rd_activities act on act.id = r.activity_id`;

async function loadRules(tx: OrgTx, where: string, params: unknown[]): Promise<RdOverheadRule[]> {
  const rows = (await tx.query<RuleRow>(`${RULE_QUERY} where ${where} order by a.code, r.effective_from, r.created_at`, [timeZone(), ...params])).rows;
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const files = await listRdFiles(tx, "overhead_rule", ids);
  const histories = await loadHistories(tx, "overhead_rule", ids);
  return rows.map((row) => {
    const when = timeliness(row.effective_from, row.entered_on, null);
    return {
      id: row.id,
      accountId: row.account_id,
      accountCode: row.account_code,
      accountName: row.account_name,
      activity: { id: row.activity_id, code: row.activity_code, name: row.activity_name, kind: row.activity_kind, status: row.activity_status },
      percentage: toFixedString(dec(row.percentage), 2),
      basis: row.basis,
      basisLabel: RD_OVERHEAD_BASES[row.basis],
      basisDetail: row.basis_detail,
      effectiveFrom: row.effective_from,
      effectiveTo: row.effective_to,
      status: row.status,
      replacedAt: row.replaced_at ? iso(row.replaced_at) : null,
      replacesId: row.replaces_id,
      replacedById: row.replaced_by_id,
      version: row.version,
      createdAt: iso(row.created_at),
      createdByEmail: row.created_by_email,
      updatedAt: iso(row.updated_at),
      updatedByEmail: row.updated_by_email,
      timeliness: when,
      enteredAfterStart: when.daysAfterWork > 0,
      files: files.filter((file) => file.recordId === row.id),
      history: histories.get(row.id) ?? [],
    };
  });
}

/** Every overhead rule, replaced ones included (viewers and above). */
export async function listOverheadRules(tx: OrgTx): Promise<RdOverheadRule[]> {
  return loadRules(tx, "true", []);
}

export async function getOverheadRule(tx: OrgTx, idInput: unknown): Promise<RdOverheadRule> {
  const id = requireUuid(idInput, "ruleId");
  const rule = (await loadRules(tx, "r.id = $2", [id]))[0];
  if (!rule) throw new NotFoundError("Overhead rule not found.");
  return rule;
}

type RuleFields = {
  percentage: string;
  basis: RdOverheadBasis;
  basisDetail: string;
  effectiveFrom: string;
  effectiveTo: string | null;
};

function parseFields(input: Record<string, unknown>): RuleFields {
  const percentage = parseDecimalInput(input.percentage, "percentage", { maxScale: 2 });
  if (cmp(dec(percentage), HUNDRED) > 0) throw new ValidationError("The percentage can be at most 100%.");
  if (input.basis == null || input.basis === "") throw new ValidationError("Choose the basis for the percentage (IR1240 p 15).");
  const basis = requireOneOf(input.basis, "basis", RD_OVERHEAD_BASIS_CODES);
  if (typeof input.basisDetail !== "string" || input.basisDetail.trim() === "") {
    throw new ValidationError("Say how the percentage was worked out, e.g. “lab 30 m² of 200 m²”.");
  }
  const basisDetail = requireString(input.basisDetail, "basisDetail", { maxLength: 500 });
  const effectiveFrom = parseIsoDate(input.effectiveFrom, "effectiveFrom");
  const effectiveTo = input.effectiveTo == null || input.effectiveTo === "" ? null : parseIsoDate(input.effectiveTo, "effectiveTo");
  if (effectiveTo != null && effectiveTo < effectiveFrom) throw new ValidationError("The rule can't end before it starts.");
  return { percentage: toFixedString(dec(percentage), 2), basis, basisDetail, effectiveFrom, effectiveTo };
}

/** An expense account whose lines can be R&D costs (as tags; decision 33 keeps book depreciation out). */
async function requireOverheadAccount(tx: OrgTx, input: Record<string, unknown>): Promise<{ id: string; code: string }> {
  const code = typeof input.accountCode === "string" ? input.accountCode.trim() : "";
  const id = typeof input.accountId === "string" || typeof input.accountId === "number" ? String(input.accountId).trim() : "";
  if (!code && !id) throw new ValidationError("Choose the account.");
  const row = (
    await tx.query<{ id: string; code: string; account_class: string; account_type: string; system_key: string | null }>(
      `select id::text, code, account_class, account_type, system_key from accounts where ${id ? "id = $1::bigint" : "lower(code) = lower($1)"}`,
      [id || code],
    )
  ).rows[0];
  if (!row) throw new ValidationError("That account doesn't exist.");
  if (row.account_type === "depreciation") throw new ValidationError("Book depreciation isn't R&D tax depreciation (decision 33); use the asset's tax depreciation and usage log.");
  if (row.account_class !== "expense" || (row.system_key && UNTAGGABLE_SYSTEM_KEYS.has(row.system_key))) {
    throw new ValidationError("An overhead rule needs an expense account.");
  }
  return { id: row.id, code: row.code };
}

async function requireActiveActivity(tx: OrgTx, activityId: string): Promise<{ code: string }> {
  const activity = (await tx.query<{ code: string; status: string }>("select code, status from rd_activities where id = $1 for share", [activityId])).rows[0];
  if (!activity) throw new ValidationError("That R&D activity doesn't exist.");
  if (activity.status !== "active") throw new ValidationError(`${activity.code} is archived, so it can't get a new overhead rule.`);
  return activity;
}

/**
 * On any day, an account's rules total at most 100%, with one rule per
 * activity (decision 58). `ignoreId` is the rule being replaced.
 */
async function assertFits(tx: OrgTx, accountId: string, activityId: string, fields: RuleFields, ignoreIds: string[]): Promise<void> {
  // Lock the account's rules so two people can't both add 60%.
  const others = (
    await tx.query<{ id: string; activity_id: string; activity_code: string; percentage: string; effective_from: string; effective_to: string | null }>(
      `select r.id, r.activity_id, act.code as activity_code, r.percentage::text, r.effective_from::text, r.effective_to::text
         from rd_overhead_rules r join rd_activities act on act.id = r.activity_id
        where r.account_id = $1 and r.status = 'active' and not (r.id = any($2::uuid[]))
          and r.effective_from <= coalesce($4::date, 'infinity'::date) and coalesce(r.effective_to, 'infinity'::date) >= $3::date
        for update of r`,
      [accountId, ignoreIds, fields.effectiveFrom, fields.effectiveTo],
    )
  ).rows;
  const same = others.find((other) => other.activity_id === activityId);
  if (same) throw new ConflictError(`${same.activity_code} already has a rule on this account from ${same.effective_from}. Change that rule instead.`);
  const days = new Set([fields.effectiveFrom, ...others.map((other) => other.effective_from).filter((day) => day > fields.effectiveFrom)]);
  for (const day of days) {
    if (fields.effectiveTo != null && day > fields.effectiveTo) continue;
    const covering = others.filter((other) => other.effective_from <= day && (other.effective_to == null || other.effective_to >= day));
    const total = add(sum(covering.map((other) => dec(other.percentage))), dec(fields.percentage));
    if (cmp(total, HUNDRED) > 0) {
      throw new ValidationError(`The rules on this account would total ${toFixedString(total, 2)}% on ${day}. An account's rules can total at most 100%.`);
    }
  }
}

function snapshot(accountCode: string, activityCode: string, fields: RuleFields, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { accountCode, activityCode, ...fields, ...extra };
}

type Workings = { fileName: string; content: Uint8Array } | null;

async function insertRule(
  tx: OrgTx,
  input: { idempotencyKey: string; hash: string; accountId: string; activityId: string; fields: RuleFields; replacesId: string | null; workings: Workings },
): Promise<string> {
  if (!input.workings) throw new ValidationError("Attach the workings that show how the % was worked out (IR1240 p 15, p 102).");
  const id = (
    await tx.query<{ id: string }>(
      `insert into rd_overhead_rules (idempotency_key, request_hash, account_id, activity_id, percentage, basis, basis_detail, effective_from,
                                      effective_to, replaces_id, created_by_user_id, created_by_email, updated_by_user_id, updated_by_email)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $11, $12) returning id`,
      [
        input.idempotencyKey,
        input.hash,
        input.accountId,
        input.activityId,
        input.fields.percentage,
        input.fields.basis,
        input.fields.basisDetail,
        input.fields.effectiveFrom,
        input.fields.effectiveTo,
        input.replacesId,
        tx.actor.userId,
        tx.actor.email,
      ],
    )
  ).rows[0].id;
  await insertRdFile(tx, {
    idempotencyKey: `${input.idempotencyKey}:workings`,
    hash: input.hash,
    recordType: "overhead_rule",
    recordId: id,
    purpose: "workings",
    fileName: input.workings.fileName,
    content: input.workings.content,
    replacesId: null,
  });
  return id;
}

/**
 * Sets an overhead rule (bookkeepers and above; RD10, RD34). Fields:
 * `idempotencyKey`, `accountId` or `accountCode`, `activityId`, `percentage`,
 * `basis`, `basisDetail`, `effectiveFrom`, optional `effectiveTo`, and the
 * workings file (required).
 */
export async function createOverheadRule(tx: OrgTx, bodyInput: unknown, workings: Workings): Promise<{ created: boolean; rule: RdOverheadRule }> {
  const body = asRecord(bodyInput, "body");
  const idempotencyKey = requireIdempotencyKey(body.idempotencyKey);
  const activityId = requireUuid(body.activityId, "activityId");
  const fields = parseFields(body);
  const account = await requireOverheadAccount(tx, body);
  const hash = requestHash("rd_overhead_rule", { accountId: account.id, activityId, ...fields, fileName: workings?.fileName ?? null, size: workings?.content.length ?? 0 });
  const existing = (await tx.query<{ id: string; request_hash: string }>("select id, request_hash from rd_overhead_rules where idempotency_key = $1", [idempotencyKey])).rows[0];
  if (existing) {
    assertSameRequest(existing.request_hash, hash, "overhead rule");
    return { created: false, rule: await getOverheadRule(tx, existing.id) };
  }
  const activity = await requireActiveActivity(tx, activityId);
  await assertFits(tx, account.id, activityId, fields, []);
  const id = await insertRule(tx, { idempotencyKey, hash, accountId: account.id, activityId, fields, replacesId: null, workings });
  await writeHistory(tx, "overhead_rule", id, "created", snapshot(account.code, activity.code, fields));
  await writeAuditEvent(tx, { eventType: "rd.overhead_rule_created", entityType: "rd_overhead_rule", entityId: id, details: { account: account.code, activity: activity.code } });
  return { created: true, rule: await getOverheadRule(tx, id) };
}

async function lockRule(tx: OrgTx, id: string) {
  const row = (
    await tx.query<{
      id: string;
      account_id: string;
      account_code: string;
      activity_id: string;
      activity_code: string;
      effective_from: string;
      effective_to: string | null;
      status: string;
      replaced_by: string | null;
    }>(
      `select r.id, r.account_id::text, a.code as account_code, r.activity_id, act.code as activity_code, r.effective_from::text,
              r.effective_to::text, r.status, (select n.id from rd_overhead_rules n where n.replaces_id = r.id) as replaced_by
         from rd_overhead_rules r join accounts a on a.id = r.account_id join rd_activities act on act.id = r.activity_id
        where r.id = $1 for update of r`,
      [id],
    )
  ).rows[0];
  if (!row) throw new NotFoundError("Overhead rule not found.");
  if (row.status !== "active" || row.replaced_by) throw new ValidationError("That rule has been changed since; change the latest rule instead.");
  return row;
}

/**
 * Changes a rule (bookkeepers and above; RD35): a new rule that replaces it,
 * with its own workings. From the same start date the old rule is marked
 * replaced; from a later date it ends the day before. The new rule keeps the
 * old one's end date.
 */
export async function changeOverheadRule(tx: OrgTx, idInput: unknown, bodyInput: unknown, workings: Workings): Promise<{ created: boolean; rule: RdOverheadRule }> {
  const id = requireUuid(idInput, "ruleId");
  const body = asRecord(bodyInput, "body");
  const idempotencyKey = requireIdempotencyKey(body.idempotencyKey);
  const parsed = parseFields({ ...body, effectiveTo: null });
  const hash = requestHash("rd_overhead_rule_change", { id, ...parsed, fileName: workings?.fileName ?? null, size: workings?.content.length ?? 0 });
  const existing = (await tx.query<{ id: string; request_hash: string }>("select id, request_hash from rd_overhead_rules where idempotency_key = $1", [idempotencyKey])).rows[0];
  if (existing) {
    assertSameRequest(existing.request_hash, hash, "overhead rule change");
    return { created: false, rule: await getOverheadRule(tx, existing.id) };
  }
  const old = await lockRule(tx, id);
  if (parsed.effectiveFrom < old.effective_from) throw new ValidationError(`The change can't start before the rule does (${old.effective_from}).`);
  if (old.effective_to != null && parsed.effectiveFrom > old.effective_to) throw new ValidationError(`The rule ended on ${old.effective_to}; set a new rule instead.`);
  const fields: RuleFields = { ...parsed, effectiveTo: old.effective_to };
  await assertFits(tx, old.account_id, old.activity_id, fields, [old.id]);
  if (parsed.effectiveFrom === old.effective_from) {
    await tx.query("update rd_overhead_rules set status = 'replaced', replaced_at = now(), version = version + 1, updated_by_user_id = $2, updated_by_email = $3 where id = $1", [
      old.id,
      tx.actor.userId,
      tx.actor.email,
    ]);
    await writeHistory(tx, "overhead_rule", old.id, "replaced", { replacedFrom: parsed.effectiveFrom });
  } else {
    const end = addDays(parsed.effectiveFrom, -1);
    await tx.query("update rd_overhead_rules set effective_to = $2, version = version + 1, updated_by_user_id = $3, updated_by_email = $4 where id = $1", [
      old.id,
      end,
      tx.actor.userId,
      tx.actor.email,
    ]);
    await writeHistory(tx, "overhead_rule", old.id, "ended", { effectiveTo: end, replacedFrom: parsed.effectiveFrom });
  }
  const newId = await insertRule(tx, { idempotencyKey, hash, accountId: old.account_id, activityId: old.activity_id, fields, replacesId: old.id, workings });
  await writeHistory(tx, "overhead_rule", newId, "created", snapshot(old.account_code, old.activity_code, fields, { replacesId: old.id }));
  await writeAuditEvent(tx, { eventType: "rd.overhead_rule_changed", entityType: "rd_overhead_rule", entityId: newId, details: { replacesId: old.id } });
  return { created: true, rule: await getOverheadRule(tx, newId) };
}

/** Ends a rule on a date (bookkeepers and above). It stays, and still applies up to that date. */
export async function endOverheadRule(tx: OrgTx, idInput: unknown, bodyInput: unknown): Promise<RdOverheadRule> {
  const id = requireUuid(idInput, "ruleId");
  const body = asRecord(bodyInput, "body");
  const effectiveTo = parseIsoDate(body.effectiveTo, "effectiveTo");
  const note = optionalString(body.note, "note", { maxLength: 500 });
  const old = await lockRule(tx, id);
  if (effectiveTo < old.effective_from) throw new ValidationError("The rule can't end before it starts.");
  await tx.query("update rd_overhead_rules set effective_to = $2, version = version + 1, updated_by_user_id = $3, updated_by_email = $4 where id = $1", [
    id,
    effectiveTo,
    tx.actor.userId,
    tx.actor.email,
  ]);
  await writeHistory(tx, "overhead_rule", id, "ended", { effectiveTo, previousEffectiveTo: old.effective_to, note });
  await writeAuditEvent(tx, { eventType: "rd.overhead_rule_ended", entityType: "rd_overhead_rule", entityId: id, details: { effectiveTo } });
  return getOverheadRule(tx, id);
}

export type RdOverheadLine = {
  sourceType: RdSourceType;
  lineId: string;
  documentLabel: string;
  description: string;
  postedOn: string;
  lineAmount: string;
};

export type RdOverheadShare = RdOverheadLine & { amount: string };

export type RdOverheadApplied = {
  rule: RdOverheadRule;
  shares: RdOverheadShare[];
  amount: string;
  /** Lines in the rule's period with their own tag, which the rule skips (decision 58). */
  skipped: RdOverheadLine[];
  /** The replaced rule's figure on the same lines, when this rule replaced one from the same start (RD35). */
  previous: { rule: RdOverheadRule; amount: string } | null;
};

/**
 * Applies the overhead rules to the posted lines dated `start` to `end`
 * (decision 58): each active rule to the untagged lines on its account in
 * its period, rounded down per line; and, for a rule that replaced one from
 * the same start, the replaced rule's figure for comparison.
 */
export async function applyOverheadRules(tx: OrgTx, start: string, end: string): Promise<RdOverheadApplied[]> {
  const settings = await rdSettings(tx);
  const rules = await loadRules(tx, "r.effective_from <= $3::date and coalesce(r.effective_to, 'infinity'::date) >= $2::date", [start, end]);
  if (rules.length === 0) return [];
  const lines = (
    await tx.query<{ source_type: RdSourceType; line_id: string; document_label: string; description: string; posted_on: string; amount: string; account_id: string; tagged: boolean }>(
      `select src.source_type, src.line_id::text, src.document_label, src.description, src.posted_on::text, src.amount::text, src.account_id::text,
              exists (select 1 from rd_tags t where t.status = 'active' and t.source_type = src.source_type
                        and coalesce(t.bill_line_id, t.expense_claim_receipt_id, t.bank_transaction_line_id, t.journal_line_id) = src.line_id) as tagged
         from ${SOURCES} src
        where src.usable and src.amount > 0 and src.account_id = any($1::bigint[]) and src.posted_on between $2 and $3
        order by src.posted_on, src.document_id, src.line_id`,
      [[...new Set(rules.map((rule) => rule.accountId))], start, end],
    )
  ).rows;
  const scale = settings.scale;
  const apply = (rule: RdOverheadRule) => {
    const inPeriod = lines.filter(
      (line) => line.account_id === rule.accountId && line.posted_on >= rule.effectiveFrom && (rule.effectiveTo == null || line.posted_on <= rule.effectiveTo),
    );
    const toLine = (line: (typeof lines)[number]): RdOverheadLine => ({
      sourceType: line.source_type,
      lineId: line.line_id,
      documentLabel: line.document_label,
      description: line.description,
      postedOn: line.posted_on,
      lineAmount: toFixedString(dec(line.amount), scale),
    });
    const shares = inPeriod.filter((line) => !line.tagged).map((line) => ({ ...toLine(line), amount: rdShare(line.amount, rule.percentage, scale) }));
    return {
      shares,
      amount: toFixedString(sum(shares.map((share) => dec(share.amount))), scale),
      skipped: inPeriod.filter((line) => line.tagged).map(toLine),
    };
  };
  const byId = new Map(rules.map((rule) => [rule.id, rule]));
  return rules
    .filter((rule) => rule.status === "active")
    .map((rule) => {
      const applied = apply(rule);
      const replaced = rule.replacesId ? byId.get(rule.replacesId) : undefined;
      const previous = replaced && replaced.status === "replaced" ? { rule: replaced, amount: apply(replaced).amount } : null;
      return { rule, ...applied, previous };
    });
}
