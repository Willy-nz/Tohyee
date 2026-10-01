import { businessTimeZone } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ValidationError } from "@/lib/errors";
import { currencyMinorUnits } from "@/lib/money/currency";
import { DEFAULT_FINANCIAL_YEAR_END_MONTH } from "@/lib/financial-year";
import { daysBetween, enteredAfterText, incomeYearLabel, isEnteredLate } from "@/lib/rd/amounts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** R&D records have uuid ids. */
export function requireUuid(input: unknown, fieldName: string): string {
  if (typeof input !== "string" || !UUID_PATTERN.test(input.trim())) throw new ValidationError(`${fieldName} isn't a valid id.`);
  return input.trim().toLowerCase();
}

export function optionalUuid(input: unknown, fieldName: string): string | null {
  if (input == null || input === "") return null;
  return requireUuid(input, fieldName);
}

/** An income year as a number like 2027 (the year it ends in). */
export function requireIncomeYear(input: unknown, fieldName: string): number {
  const value = typeof input === "string" && /^\d{4}$/.test(input.trim()) ? Number(input.trim()) : input;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 2000 || value > 2999) {
    throw new ValidationError(`${fieldName} must be an income year like 2027.`);
  }
  return value;
}

export function optionalIncomeYear(input: unknown, fieldName: string): number | null {
  if (input == null || input === "") return null;
  return requireIncomeYear(input, fieldName);
}

/** A timestamp from PostgreSQL as ISO 8601. */
export function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export type RdSettings = { yearEndMonth: number; scale: number };

/** The organisation's balance date month and its base currency's decimal places. */
export async function rdSettings(tx: OrgTx): Promise<RdSettings> {
  const row = (await tx.query<{ financial_year_end_month: number }>("select financial_year_end_month from organisation_settings where id = true")).rows[0];
  return { yearEndMonth: row?.financial_year_end_month ?? DEFAULT_FINANCIAL_YEAR_END_MONTH, scale: currencyMinorUnits(tx.baseCurrency) };
}

export function yearLabel(settings: RdSettings, year: number): string {
  return incomeYearLabel(year, settings.yearEndMonth);
}

export const timeZone = businessTimeZone;

/** How long after the work a record was entered, and whether that's late (decision 38). */
export type Timeliness = {
  workDate: string;
  enteredOn: string;
  daysAfterWork: number;
  enteredLate: boolean;
  timelinessText: string;
  /** Days between being entered and last changed, when it has been changed (RD23). */
  changedDaysAfterEntry: number | null;
};

export function timeliness(workDate: string, enteredOn: string, changedOn: string | null): Timeliness {
  const days = daysBetween(workDate, enteredOn);
  return {
    workDate,
    enteredOn,
    daysAfterWork: days,
    enteredLate: isEnteredLate(days),
    timelinessText: enteredAfterText(days),
    changedDaysAfterEntry: changedOn == null ? null : daysBetween(enteredOn, changedOn),
  };
}

export type HistoryRecordType = "activity" | "approval" | "tag" | "asset_usage" | "asset_tax_depreciation" | "file";
export type HistoryAction = "created" | "changed" | "archived" | "restored" | "withdrawn" | "removed" | "replaced";

/** Appends a version of an R&D record to rd_history, stamped with the signed-in user and the server's time. */
export async function writeHistory(
  tx: OrgTx,
  recordType: HistoryRecordType,
  recordId: string,
  action: HistoryAction,
  snapshot: Record<string, unknown>,
): Promise<void> {
  await tx.query(
    `insert into rd_history (record_type, record_id, version, action, snapshot, changed_by_user_id, changed_by_email)
     values ($1, $2, coalesce((select max(version) from rd_history where record_type = $1 and record_id = $2), 0) + 1,
             $3, $4::jsonb, $5, $6)`,
    [recordType, recordId, action, JSON.stringify(snapshot), tx.actor.userId, tx.actor.email],
  );
}

export type HistoryEntry = {
  version: number;
  action: HistoryAction;
  snapshot: Record<string, unknown>;
  changedByEmail: string;
  changedAt: string;
};

export async function loadHistory(tx: OrgTx, recordType: HistoryRecordType, recordId: string): Promise<HistoryEntry[]> {
  const rows = await tx.query<{ version: number; action: HistoryAction; snapshot: Record<string, unknown>; changed_by_email: string; created_at: Date }>(
    "select version, action, snapshot, changed_by_email, created_at from rd_history where record_type = $1 and record_id = $2 order by version",
    [recordType, recordId],
  );
  return rows.rows.map((row) => ({
    version: row.version,
    action: row.action,
    snapshot: row.snapshot,
    changedByEmail: row.changed_by_email,
    changedAt: iso(row.created_at),
  }));
}

/** The history of several records of one type, by record id. */
export async function loadHistories(tx: OrgTx, recordType: HistoryRecordType, recordIds: string[]): Promise<Map<string, HistoryEntry[]>> {
  const result = new Map<string, HistoryEntry[]>();
  if (recordIds.length === 0) return result;
  const rows = await tx.query<{ record_id: string; version: number; action: HistoryAction; snapshot: Record<string, unknown>; changed_by_email: string; created_at: Date }>(
    `select record_id, version, action, snapshot, changed_by_email, created_at from rd_history
      where record_type = $1 and record_id = any($2::text[]) order by record_id, version`,
    [recordType, recordIds],
  );
  for (const row of rows.rows) {
    const list = result.get(row.record_id) ?? [];
    list.push({ version: row.version, action: row.action, snapshot: row.snapshot, changedByEmail: row.changed_by_email, changedAt: iso(row.created_at) });
    result.set(row.record_id, list);
  }
  return result;
}
