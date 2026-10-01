import { writeAuditEvent } from "@/lib/audit";
import { parseIsoDate, todayIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { assertSameRequest, requestHash } from "@/lib/idempotency";
import { add, cmp, dec, parseDecimalInput, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";
import { incomeYearOf, RD_INELIGIBLE_REASON_CODES, RD_INELIGIBLE_REASONS, usageSplit, type RdIneligibleReason } from "@/lib/rd/amounts";
import {
  iso,
  loadHistories,
  optionalUuid,
  rdSettings,
  requireIncomeYear,
  requireUuid,
  timeliness,
  timeZone,
  writeHistory,
  yearLabel,
  type HistoryEntry,
  type RdSettings,
  type Timeliness,
} from "@/lib/rd/common";
import { listRdFiles, type RdFile } from "@/lib/rd/files";
import type { RdActivityRef } from "@/lib/rd/register";
import { asRecord, optionalString, requireId, requireIdempotencyKey, requireOneOf, requireString } from "@/lib/validation";

/**
 * R&D tax depreciation (RD11; decision 33). R&D uses an asset's tax
 * depreciation for the income year, entered from the organisation's tax
 * workings, never the book depreciation the fixed asset register posts
 * (Tohyee has no IRD rates). Investment Boost (DI 5) is entered with it and
 * counts as depreciation. The total is split by the asset's usage log: each
 * activity gets total × its hours / all hours logged, rounded down to the
 * cent; idle time isn't logged (IR1240 p 62).
 */

export type TaxDepreciationEntry = {
  id: string;
  incomeYear: number;
  incomeYearLabel: string;
  taxDepreciation: string;
  investmentBoost: string;
  total: string;
  ineligibleReason: RdIneligibleReason | null;
  ineligibleReasonLabel: string | null;
  note: string | null;
  createdAt: string;
  createdByEmail: string;
};

export type UsageEntry = {
  id: string;
  activity: RdActivityRef | null;
  workDate: string;
  incomeYear: number;
  incomeYearLabel: string;
  hours: string;
  description: string | null;
  status: "active" | "removed";
  removedReason: string | null;
  removedAt: string | null;
  removedByEmail: string | null;
  version: number;
  createdAt: string;
  createdByEmail: string;
  updatedAt: string;
  updatedByEmail: string;
  timeliness: Timeliness;
  history: HistoryEntry[];
};

export type AssetRdYear = {
  incomeYear: number;
  incomeYearLabel: string;
  /** The entry that counts: the latest for the year. */
  entry: TaxDepreciationEntry | null;
  /** Earlier entries for the year, newest first. */
  earlierEntries: TaxDepreciationEntry[];
  totalHours: string;
  otherHours: string;
  /** Each activity's share of the year's tax depreciation (0.00 while none is entered). */
  shares: { activity: RdActivityRef; hours: string; amount: string }[];
  other: string;
  warnings: string[];
};

export type AssetRd = {
  asset: { id: string; assetNumber: string; name: string; status: string };
  years: AssetRdYear[];
  usage: UsageEntry[];
  files: RdFile[];
};

type EntryRow = {
  id: string;
  income_year: number;
  tax_depreciation: string;
  investment_boost: string;
  ineligible_reason: RdIneligibleReason | null;
  note: string | null;
  created_at: Date;
  created_by_email: string;
};

type UsageRow = {
  id: string;
  asset_id: string;
  activity_id: string | null;
  activity_code: string | null;
  activity_name: string | null;
  activity_kind: "core" | "supporting" | null;
  activity_status: "active" | "archived" | null;
  work_date: string;
  hours: string;
  description: string | null;
  status: "active" | "removed";
  removed_reason: string | null;
  removed_at: Date | null;
  removed_by_email: string | null;
  version: number;
  created_at: Date;
  created_by_email: string;
  updated_at: Date;
  updated_by_email: string;
  entered_on: string;
  changed_on: string;
};

function toEntry(row: EntryRow, settings: RdSettings): TaxDepreciationEntry {
  return {
    id: row.id,
    incomeYear: row.income_year,
    incomeYearLabel: yearLabel(settings, row.income_year),
    taxDepreciation: toFixedString(dec(row.tax_depreciation), settings.scale),
    investmentBoost: toFixedString(dec(row.investment_boost), settings.scale),
    total: toFixedString(add(dec(row.tax_depreciation), dec(row.investment_boost)), settings.scale),
    ineligibleReason: row.ineligible_reason,
    ineligibleReasonLabel: row.ineligible_reason ? RD_INELIGIBLE_REASONS[row.ineligible_reason].label : null,
    note: row.note,
    createdAt: iso(row.created_at),
    createdByEmail: row.created_by_email,
  };
}

function activityRef(row: Pick<UsageRow, "activity_id" | "activity_code" | "activity_name" | "activity_kind" | "activity_status">): RdActivityRef | null {
  return row.activity_id ? { id: row.activity_id, code: row.activity_code!, name: row.activity_name!, kind: row.activity_kind!, status: row.activity_status! } : null;
}

async function loadUsage(tx: OrgTx, where: string, params: unknown[]): Promise<UsageRow[]> {
  return (
    await tx.query<UsageRow>(
      `select u.id, u.asset_id::text, u.activity_id, a.code as activity_code, a.name as activity_name, a.kind as activity_kind,
              a.status as activity_status, u.work_date::text, u.hours::text, u.description, u.status, u.removed_reason, u.removed_at,
              u.removed_by_email, u.version, u.created_at, u.created_by_email, u.updated_at, u.updated_by_email,
              to_char((u.created_at at time zone $1)::date, 'YYYY-MM-DD') as entered_on,
              to_char((u.updated_at at time zone $1)::date, 'YYYY-MM-DD') as changed_on
         from rd_asset_usage u left join rd_activities a on a.id = u.activity_id
        where ${where} order by u.work_date, u.created_at`,
      [timeZone(), ...params],
    )
  ).rows;
}

/** Splits each year's latest tax depreciation entry by that year's active usage. */
export function assetYears(settings: RdSettings, entries: EntryRow[], usage: UsageRow[]): AssetRdYear[] {
  const years = new Set<number>([...entries.map((entry) => entry.income_year), ...usage.map((row) => incomeYearOf(row.work_date, settings.yearEndMonth))]);
  return [...years]
    .sort((a, b) => b - a)
    .map((year) => {
      const yearEntries = entries.filter((entry) => entry.income_year === year).map((entry) => toEntry(entry, settings));
      const [entry, ...earlierEntries] = yearEntries;
      const yearUsage = usage.filter((row) => row.status === "active" && incomeYearOf(row.work_date, settings.yearEndMonth) === year);
      const refs = new Map(yearUsage.filter((row) => row.activity_id).map((row) => [row.activity_id!, activityRef(row)!]));
      const total = entry && !entry.ineligibleReason ? entry.total : toFixedString(ZERO_DECIMAL, settings.scale);
      const split = usageSplit(total, yearUsage.map((row) => ({ key: row.activity_id, hours: row.hours })), settings.scale);
      const warnings: string[] = [];
      const label = yearLabel(settings, year);
      if (!entry && split.shares.length > 0) warnings.push(`No tax depreciation entered for ${label}, so its R&D share is 0.00.`);
      if (entry?.ineligibleReason) warnings.push(`Tax depreciation for ${label} is ineligible: ${entry.ineligibleReasonLabel}.`);
      if (entry && yearUsage.length === 0) warnings.push(`No usage logged for ${label}, so none of its tax depreciation is R&D.`);
      return {
        incomeYear: year,
        incomeYearLabel: label,
        entry: entry ?? null,
        earlierEntries,
        totalHours: split.totalHours,
        otherHours: split.otherHours,
        shares: split.shares.map((share) => ({ activity: refs.get(share.key)!, hours: share.hours, amount: share.amount })),
        other: split.other,
        warnings,
      };
    });
}

async function requireAsset(tx: OrgTx, assetIdInput: unknown, lock = false): Promise<{ id: string; asset_number: string; name: string; status: string }> {
  const assetId = requireId(assetIdInput, "assetId");
  const row = (
    await tx.query<{ id: string; asset_number: string; name: string; status: string }>(
      `select id::text, asset_number, name, status from fixed_assets where id = $1${lock ? " for share" : ""}`,
      [assetId],
    )
  ).rows[0];
  if (!row) throw new NotFoundError("Fixed asset not found.");
  return row;
}

async function entriesFor(tx: OrgTx, assetIds: string[]): Promise<(EntryRow & { asset_id: string })[]> {
  return (
    await tx.query<EntryRow & { asset_id: string }>(
      `select id, asset_id::text, income_year, tax_depreciation::text, investment_boost::text, ineligible_reason, note, created_at, created_by_email
         from rd_asset_tax_depreciation where asset_id = any($1::bigint[]) order by entry_number desc`,
      [assetIds],
    )
  ).rows;
}

/** An asset's R&D records: tax depreciation per year, usage log and the split (viewers and above). */
export async function getAssetRd(tx: OrgTx, assetIdInput: unknown): Promise<AssetRd> {
  const asset = await requireAsset(tx, assetIdInput);
  const settings = await rdSettings(tx);
  const entries = await entriesFor(tx, [asset.id]);
  const usage = await loadUsage(tx, "u.asset_id = $2", [asset.id]);
  const histories = await loadHistories(tx, "asset_usage", usage.map((row) => row.id));
  return {
    asset: { id: asset.id, assetNumber: asset.asset_number, name: asset.name, status: asset.status },
    years: assetYears(settings, entries, usage),
    usage: usage.map((row) => toUsage(row, settings, histories.get(row.id) ?? [])),
    files: await listRdFiles(tx, "asset", [asset.id]),
  };
}

function toUsage(row: UsageRow, settings: RdSettings, history: HistoryEntry[]): UsageEntry {
  const incomeYear = incomeYearOf(row.work_date, settings.yearEndMonth);
  return {
    id: row.id,
    activity: activityRef(row),
    workDate: row.work_date,
    incomeYear,
    incomeYearLabel: yearLabel(settings, incomeYear),
    hours: toFixedString(dec(row.hours), 2),
    description: row.description,
    status: row.status,
    removedReason: row.removed_reason,
    removedAt: row.removed_at ? iso(row.removed_at) : null,
    removedByEmail: row.removed_by_email,
    version: row.version,
    createdAt: iso(row.created_at),
    createdByEmail: row.created_by_email,
    updatedAt: iso(row.updated_at),
    updatedByEmail: row.updated_by_email,
    timeliness: timeliness(row.work_date, row.entered_on, row.version > 1 ? row.changed_on : null),
    history,
  };
}

function amount(input: unknown, field: string, scale: number): string {
  if (input == null || input === "") return toFixedString(ZERO_DECIMAL, scale);
  return toFixedString(dec(parseDecimalInput(input, field, { maxScale: scale, allowZero: true })), scale);
}

/**
 * Enters an asset's tax depreciation and Investment Boost for an income year
 * (bookkeepers and above). Entering it again for the same year replaces the
 * figure; the earlier entry stays, with who entered it and when.
 */
export async function enterTaxDepreciation(tx: OrgTx, assetIdInput: unknown, bodyInput: unknown): Promise<{ created: boolean; asset: AssetRd }> {
  const body = asRecord(bodyInput, "body");
  const asset = await requireAsset(tx, assetIdInput, true);
  const settings = await rdSettings(tx);
  const idempotencyKey = requireIdempotencyKey(body.idempotencyKey);
  const incomeYear = requireIncomeYear(body.incomeYear, "incomeYear");
  const taxDepreciation = amount(body.taxDepreciation, "taxDepreciation", settings.scale);
  const investmentBoost = amount(body.investmentBoost, "investmentBoost", settings.scale);
  const ineligibleReason = body.ineligibleReason == null || body.ineligibleReason === "" ? null : requireOneOf(body.ineligibleReason, "ineligibleReason", RD_INELIGIBLE_REASON_CODES);
  const note = optionalString(body.note, "note", { maxLength: 2000 });
  if (ineligibleReason === "other" && !note) throw new ValidationError("Say why it's ineligible in the note.");
  const hash = requestHash("rd_asset_tax_depreciation", { assetId: asset.id, incomeYear, taxDepreciation, investmentBoost, ineligibleReason, note });
  const existing = (await tx.query<{ request_hash: string }>("select request_hash from rd_asset_tax_depreciation where idempotency_key = $1", [idempotencyKey])).rows[0];
  if (existing) {
    assertSameRequest(existing.request_hash, hash, "tax depreciation entry");
    return { created: false, asset: await getAssetRd(tx, asset.id) };
  }
  const id = (
    await tx.query<{ id: string }>(
      `insert into rd_asset_tax_depreciation (idempotency_key, request_hash, asset_id, income_year, tax_depreciation, investment_boost, ineligible_reason, note,
                                              created_by_user_id, created_by_email)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
      [idempotencyKey, hash, asset.id, incomeYear, taxDepreciation, investmentBoost, ineligibleReason, note, tx.actor.userId, tx.actor.email],
    )
  ).rows[0].id;
  await writeHistory(tx, "asset_tax_depreciation", id, "created", { assetId: asset.id, incomeYear, taxDepreciation, investmentBoost, ineligibleReason, note });
  await writeAuditEvent(tx, {
    eventType: "rd.asset_tax_depreciation_entered",
    entityType: "fixed_asset",
    entityId: asset.id,
    details: { incomeYear: yearLabel(settings, incomeYear), taxDepreciation, investmentBoost },
  });
  return { created: true, asset: await getAssetRd(tx, asset.id) };
}

type UsageFields = { activityId: string | null; hours: string; description: string | null };

function parseUsage(body: Record<string, unknown>): UsageFields {
  const hours = parseDecimalInput(body.hours, "hours", { maxScale: 2 });
  if (cmp(dec(hours), dec("100000")) > 0) throw new ValidationError("That's too many hours for one entry.");
  return {
    activityId: optionalUuid(body.activityId, "activityId"),
    hours: toFixedString(dec(hours), 2),
    description: optionalString(body.description, "description", { maxLength: 500 }),
  };
}

async function checkUsageActivity(tx: OrgTx, activityId: string | null): Promise<void> {
  if (!activityId) return;
  const activity = (await tx.query<{ code: string; status: string }>("select code, status from rd_activities where id = $1 for share", [activityId])).rows[0];
  if (!activity) throw new ValidationError("That R&D activity doesn't exist.");
  if (activity.status !== "active") throw new ValidationError(`${activity.code} is archived.`);
}

/**
 * Logs hours an asset was used, on an activity or on other work (bookkeepers
 * and above). The date of the use is entered; when it was entered comes from
 * the server, and entries more than 14 days after the use are flagged
 * (decision 38).
 */
export async function addUsage(tx: OrgTx, assetIdInput: unknown, bodyInput: unknown): Promise<{ created: boolean; asset: AssetRd }> {
  const body = asRecord(bodyInput, "body");
  const asset = await requireAsset(tx, assetIdInput, true);
  const idempotencyKey = requireIdempotencyKey(body.idempotencyKey);
  const workDate = parseIsoDate(body.workDate, "workDate");
  if (workDate > todayIsoDate()) throw new ValidationError("Usage can't be logged for a future date.");
  const fields = parseUsage(body);
  const hash = requestHash("rd_asset_usage", { assetId: asset.id, workDate, ...fields });
  const existing = (await tx.query<{ request_hash: string }>("select request_hash from rd_asset_usage where idempotency_key = $1", [idempotencyKey])).rows[0];
  if (existing) {
    assertSameRequest(existing.request_hash, hash, "usage log entry");
    return { created: false, asset: await getAssetRd(tx, asset.id) };
  }
  await checkUsageActivity(tx, fields.activityId);
  const id = (
    await tx.query<{ id: string }>(
      `insert into rd_asset_usage (idempotency_key, request_hash, asset_id, activity_id, work_date, hours, description,
                                   created_by_user_id, created_by_email, updated_by_user_id, updated_by_email)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $8, $9) returning id`,
      [idempotencyKey, hash, asset.id, fields.activityId, workDate, fields.hours, fields.description, tx.actor.userId, tx.actor.email],
    )
  ).rows[0].id;
  await writeHistory(tx, "asset_usage", id, "created", { assetId: asset.id, workDate, ...fields });
  await writeAuditEvent(tx, { eventType: "rd.asset_usage_logged", entityType: "fixed_asset", entityId: asset.id, details: { usageId: id, workDate, hours: fields.hours } });
  return { created: true, asset: await getAssetRd(tx, asset.id) };
}

async function lockUsage(tx: OrgTx, id: string) {
  const row = (
    await tx.query<{ asset_id: string; status: string; version: number; activity_id: string | null; hours: string; description: string | null; work_date: string }>(
      "select asset_id::text, status, version, activity_id, hours::text, description, work_date::text from rd_asset_usage where id = $1 for update",
      [id],
    )
  ).rows[0];
  if (!row) throw new NotFoundError("Usage log entry not found.");
  return row;
}

/** Changes a usage log entry's activity, hours or description; the old version stays in its history (RD23). */
export async function updateUsage(tx: OrgTx, idInput: unknown, bodyInput: unknown): Promise<AssetRd> {
  const id = requireUuid(idInput, "usageId");
  const body = asRecord(bodyInput, "body");
  const current = await lockUsage(tx, id);
  if (body.version != null && Number(body.version) !== current.version) {
    throw new ConflictError("Someone else changed this entry since you opened it. Reload it and make your change again.");
  }
  if (current.status !== "active") throw new ValidationError("That usage log entry has been removed.");
  if (body.workDate != null && body.workDate !== current.work_date) {
    throw new ValidationError("A usage log entry keeps its date; remove it and log the use on the right date instead.");
  }
  const before: UsageFields = { activityId: current.activity_id, hours: toFixedString(dec(current.hours), 2), description: current.description };
  const fields = parseUsage({ ...before, ...body });
  const changed = (Object.keys(fields) as (keyof UsageFields)[]).filter((key) => fields[key] !== before[key]);
  if (changed.length === 0) return getAssetRd(tx, current.asset_id);
  if (fields.activityId !== before.activityId) await checkUsageActivity(tx, fields.activityId);
  await tx.query(
    `update rd_asset_usage set activity_id = $2, hours = $3, description = $4, version = version + 1, updated_by_user_id = $5, updated_by_email = $6
      where id = $1`,
    [id, fields.activityId, fields.hours, fields.description, tx.actor.userId, tx.actor.email],
  );
  await writeHistory(tx, "asset_usage", id, "changed", { ...fields, workDate: current.work_date, changed });
  await writeAuditEvent(tx, { eventType: "rd.asset_usage_changed", entityType: "fixed_asset", entityId: current.asset_id, details: { usageId: id, changed } });
  return getAssetRd(tx, current.asset_id);
}

/** Removes a usage log entry; it stays in history with the reason and drops out of the split. */
export async function removeUsage(tx: OrgTx, idInput: unknown, reasonInput: unknown): Promise<AssetRd> {
  const id = requireUuid(idInput, "usageId");
  const reason = requireString(reasonInput, "reason", { maxLength: 500 });
  const current = await lockUsage(tx, id);
  if (current.status !== "active") throw new ValidationError("That usage log entry has already been removed.");
  await tx.query(
    `update rd_asset_usage set status = 'removed', removed_reason = $2, removed_at = now(), removed_by_user_id = $3, removed_by_email = $4,
            version = version + 1, updated_by_user_id = $3, updated_by_email = $4 where id = $1`,
    [id, reason, tx.actor.userId, tx.actor.email],
  );
  await writeHistory(tx, "asset_usage", id, "removed", { reason });
  await writeAuditEvent(tx, { eventType: "rd.asset_usage_removed", entityType: "fixed_asset", entityId: current.asset_id, details: { usageId: id, reason } });
  return getAssetRd(tx, current.asset_id);
}

/** Every asset's split for one income year, for the tagged costs list. */
export async function assetSharesForYear(
  tx: OrgTx,
  settings: RdSettings,
  year: number,
): Promise<{ asset: { id: string; assetNumber: string; name: string }; year: AssetRdYear }[]> {
  const assets = (
    await tx.query<{ id: string; asset_number: string; name: string }>(
      `select id::text, asset_number, name from fixed_assets f
        where exists (select 1 from rd_asset_tax_depreciation e where e.asset_id = f.id and e.income_year = $1)
           or exists (select 1 from rd_asset_usage u where u.asset_id = f.id and u.status = 'active')
        order by asset_number`,
      [year],
    )
  ).rows;
  if (assets.length === 0) return [];
  const ids = assets.map((asset) => asset.id);
  const entries = await entriesFor(tx, ids);
  const usage = await loadUsage(tx, "u.asset_id = any($2::bigint[])", [ids]);
  return assets
    .map((asset) => ({
      asset: { id: asset.id, assetNumber: asset.asset_number, name: asset.name },
      year: assetYears(
        settings,
        entries.filter((entry) => entry.asset_id === asset.id),
        usage.filter((row) => row.asset_id === asset.id),
      ).find((row) => row.incomeYear === year),
    }))
    .filter((row): row is { asset: { id: string; assetNumber: string; name: string }; year: AssetRdYear } => row.year != null);
}
