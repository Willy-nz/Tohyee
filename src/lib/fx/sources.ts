import { writeAuditEvent } from "@/lib/audit";
import { decodeText, RowError } from "@/lib/bank/formats/common";
import { parseDelimited } from "@/lib/bank/formats/table";
import { readXlsxRows } from "@/lib/bank/formats/xlsx";
import { fromCsvCell } from "@/lib/csv";
import { parseIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, ValidationError } from "@/lib/errors";
import { financialYearStart, monthLabel } from "@/lib/financial-year";
import { formatDate } from "@/lib/format";
import { assertSameRequest, requestHash } from "@/lib/idempotency";
import { isSupportedCurrency } from "@/lib/money/currency";
import { cmp, dec, divide, isDecimalString, toFixedString, toPlainString, ZERO_DECIMAL } from "@/lib/money/decimal";
import { optionalSource, optionalString, requireIdempotencyKey, requireOneOf, requireString } from "@/lib/validation";

/**
 * Where exchange rates come from (#183, examples FX2-FX9, decision 479):
 * the European Central Bank's daily rates (FX1), uploaded rate sets (each
 * named for where it came from and covering a period), or typed only. Inland
 * Revenue accepts rates it publishes, the Reserve Bank's, other central
 * banks' or another rate that suits the transaction, but asks you to use the
 * same source over time and keep a record of why if you change (FX7).
 */
export const RATE_SOURCES = ["ecb", "uploaded", "typed"] as const;
export type RateSource = (typeof RATE_SOURCES)[number];

const SOURCE_NAMES: Record<RateSource, string> = {
  ecb: "ECB rates",
  uploaded: "uploaded rate sets",
  typed: "typed rates only",
};

export type RateSourceChange = {
  fromSource: RateSource;
  toSource: RateSource;
  reason: string | null;
  changedByEmail: string | null;
  changedAt: string;
};

export type RateSourceSettings = {
  source: RateSource;
  history: RateSourceChange[];
};

export async function getRateSource(tx: OrgTx): Promise<RateSource> {
  const row = (await tx.query<{ rate_source: RateSource }>("select rate_source from ecb_rate_settings where id = true")).rows[0];
  return row?.rate_source ?? "typed";
}

export async function getRateSourceSettings(tx: OrgTx): Promise<RateSourceSettings> {
  const history = await tx.query<{ from_source: RateSource; to_source: RateSource; reason: string | null; changed_by_email: string | null; changed_at: string }>(
    "select from_source, to_source, reason, changed_by_email, changed_at from exchange_rate_source_changes order by changed_at desc, id desc",
  );
  return {
    source: await getRateSource(tx),
    history: history.rows.map((row) => ({
      fromSource: row.from_source,
      toSource: row.to_source,
      reason: row.reason,
      changedByEmail: row.changed_by_email,
      changedAt: row.changed_at,
    })),
  };
}

/**
 * FX7: the warning shown before changing the source while another real
 * source (ECB or uploaded sets) is in use this financial year, or null.
 * Changing from typed only, or to the same source, needs no warning.
 */
export async function rateSourceWarning(tx: OrgTx, to: RateSource, today: string): Promise<string | null> {
  const from = await getRateSource(tx);
  if (from === to || from === "typed") return null;
  const yearEndMonth = (await tx.query<{ financial_year_end_month: number }>("select financial_year_end_month from organisation_settings where id = true")).rows[0]
    .financial_year_end_month;
  const yearStart = financialYearStart(today, yearEndMonth);
  return `Inland Revenue asks you to use the same exchange rate source over time. This year (from ${formatDate(yearStart)}) has used ${SOURCE_NAMES[from]}, so it would use two sources. Keep a note of why you're changing.`;
}

/**
 * Changes where rates come from (admins). A change that would mix sources in
 * a year needs a reason (FX7), kept in the history. Choosing ECB turns its
 * daily job on; anything else turns it off (FX8). Nothing already in the
 * books or the list changes.
 */
export async function setRateSource(tx: OrgTx, input: { source: unknown; reason?: unknown }, today: string): Promise<RateSourceSettings> {
  const to = requireOneOf(input.source, "source", RATE_SOURCES) as RateSource;
  const from = await getRateSource(tx);
  if (from === to) return getRateSourceSettings(tx);
  const reason = optionalString(input.reason, "reason", { maxLength: 500 })?.trim() || null;
  const warning = await rateSourceWarning(tx, to, today);
  if (warning && !reason) throw new ValidationError(`${warning} Enter the reason.`);
  await tx.query(
    `update ecb_rate_settings
        set rate_source = $1,
            enabled = $1 = 'ecb',
            enabled_on = case when $1 = 'ecb' and not enabled then $2::date when $1 <> 'ecb' then null else enabled_on end,
            last_error = case when $1 = 'ecb' then last_error else null end,
            updated_by_email = $3, updated_at = now()
      where id = true`,
    [to, today, tx.actor.email],
  );
  await tx.query(
    "insert into exchange_rate_source_changes (from_source, to_source, reason, changed_by_user_id, changed_by_email) values ($1, $2, $3, $4, $5)",
    [from, to, reason, tx.actor.userId, tx.actor.email],
  );
  await writeAuditEvent(tx, { eventType: "exchange_rates.source_changed", entityType: "exchange_rates", entityId: "1", details: { from, to, reason } });
  return getRateSourceSettings(tx);
}

// ---------------------------------------------------------------- rate sets

export type RateQuote = "foreign_per_base" | "base_per_foreign";

export type RateSet = {
  id: string;
  name: string;
  periodStart: string;
  periodEnd: string;
  quoted: RateQuote;
  fileName: string | null;
  replacesSetId: string | null;
  replaceReason: string | null;
  replacedAt: string | null;
  createdByEmail: string | null;
  createdAt: string;
  rates: Array<{ currencyCode: string; rate: string }>;
};

/** One line of an uploaded file, as previewed (FX3). */
export type RateSetPreview = {
  /** Converted to the organisation's currency per 1 unit, as every rate in Tohyee is. */
  rates: Array<{ row: number; currencyCode: string; quoted: string; rate: string; text: string }>;
  /** Currencies the organisation doesn't use, left out. */
  skipped: Array<{ row: number; currencyCode: string }>;
  /** Sets already covering part of the period, which this one would replace (FX6). */
  overlaps: Array<{ id: string; name: string; periodStart: string; periodEnd: string }>;
};

const MAX_RATE_FILE_BYTES = 2 * 1024 * 1024;
const MAX_RATE_ROWS = 400;
const RATE_SCALE = 6;

type SetRow = {
  id: string;
  name: string;
  period_start: string;
  period_end: string;
  quoted: RateQuote;
  file_name: string | null;
  replaces_set_id: string | null;
  replace_reason: string | null;
  replaced_at: string | null;
  created_by_email: string | null;
  created_at: string;
};

const SET_SELECT = `select id::text, name, period_start::text, period_end::text, quoted, file_name, replaces_set_id::text, replace_reason,
                           replaced_at, created_by_email, created_at from exchange_rate_sets`;

async function withRates(tx: OrgTx, rows: SetRow[]): Promise<RateSet[]> {
  if (rows.length === 0) return [];
  const rates = await tx.query<{ rate_set_id: string; currency_code: string; rate: string }>(
    "select rate_set_id::text, currency_code, rate::text from currency_exchange_rates where rate_set_id = any($1::bigint[]) order by currency_code",
    [rows.map((row) => row.id)],
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    quoted: row.quoted,
    fileName: row.file_name,
    replacesSetId: row.replaces_set_id,
    replaceReason: row.replace_reason,
    replacedAt: row.replaced_at,
    createdByEmail: row.created_by_email,
    createdAt: row.created_at,
    rates: rates.rows.filter((rate) => rate.rate_set_id === row.id).map((rate) => ({ currencyCode: rate.currency_code, rate: toPlainString(dec(rate.rate)) })),
  }));
}

/** Every uploaded set, newest period first; replaced ones included, marked. */
export async function listRateSets(tx: OrgTx): Promise<RateSet[]> {
  return withRates(tx, (await tx.query<SetRow>(`${SET_SELECT} order by period_start desc, created_at desc, id desc`)).rows);
}

/** The set in use for a date (not replaced, covering it), or null. */
async function setCovering(tx: OrgTx, date: string): Promise<SetRow | null> {
  return (
    (await tx.query<SetRow>(`${SET_SELECT} where replaced_at is null and period_start <= $1 and period_end >= $1 order by created_at desc, id desc limit 1`, [date]))
      .rows[0] ?? null
  );
}

/**
 * FX5: why a document dated `date` has no rate while uploaded sets are the
 * source, for its "type the rate" message.
 */
export async function missingSetRateReason(tx: OrgTx, currencyCode: string, date: string): Promise<string> {
  const covering = await setCovering(tx, date);
  if (covering) {
    return `The ${covering.name} set for ${formatDate(covering.period_start)} to ${formatDate(covering.period_end)} has no ${currencyCode} rate.`;
  }
  const latest = (await tx.query<{ name: string }>("select name from exchange_rate_sets where replaced_at is null order by period_end desc, created_at desc limit 1")).rows[0];
  return latest ? `There's no ${latest.name} set for ${monthLabel(date)} yet.` : `No rate set has been uploaded for ${monthLabel(date)} yet.`;
}

/** Currencies the organisation uses (contacts, accounts, documents and the ECB's extra currencies), other than its own. */
async function usedCurrencies(tx: OrgTx): Promise<Set<string>> {
  const found = await tx.query<{ code: string }>(
    `select code from (
       select currency_code as code from contacts where currency_code is not null
       union select currency_code from accounts where currency_code is not null
       union select currency_code from sales_invoices
       union select currency_code from bills
       union select unnest(extra_currencies) from ecb_rate_settings
     ) used where code <> $1`,
    [tx.baseCurrency],
  );
  return new Set(found.rows.map((row) => row.code));
}

/** The rows of an uploaded CSV or Excel (.xlsx) file, as text. */
function readRateFile(fileName: string, fileBase64: unknown): string[][] {
  if (typeof fileBase64 !== "string" || fileBase64.length === 0) throw new ValidationError("Choose a CSV or Excel file of currencies and rates.");
  if (fileBase64.length > Math.ceil((MAX_RATE_FILE_BYTES * 4) / 3) + 4) throw new ValidationError("The file is larger than 2 MB.");
  const bytes = Buffer.from(fileBase64, "base64");
  if (bytes.length === 0) throw new ValidationError("The file is empty.");
  let rows: string[][];
  try {
    if (bytes.length >= 4 && bytes.readUInt32LE(0) === 0x04034b50) {
      rows = readXlsxRows(bytes, MAX_RATE_ROWS + 20);
    } else if (fileName.toLowerCase().endsWith(".xls")) {
      throw new ValidationError("Older Excel files (.xls) aren't supported. Open it in Excel and save it as .xlsx or CSV.");
    } else {
      rows = parseDelimited(decodeText(bytes), { keepBlankRows: true });
    }
  } catch (error) {
    if (error instanceof RowError) throw new ValidationError(error.message);
    throw error;
  }
  return rows.map((row) => row.map((cell) => fromCsvCell(cell ?? "").trim()));
}

/**
 * FX3: the file's rates, converted. Each row is a currency and a rate (more
 * columns are ignored); a heading row is allowed. A currency the
 * organisation doesn't use, or its own, is listed and skipped. A blank or
 * non-numeric rate, an unknown currency or a currency twice refuses the
 * whole file, naming the row. Quoted as foreign currency per 1 of the
 * organisation's, a rate becomes 1 / rate, rounded to 6 decimal places.
 */
export function convertRateRows(
  rows: string[][],
  quoted: RateQuote,
  base: string,
  used: ReadonlySet<string>,
): Pick<RateSetPreview, "rates" | "skipped"> {
  const rates: RateSetPreview["rates"] = [];
  const skipped: RateSetPreview["skipped"] = [];
  const seen = new Set<string>();
  rows.forEach((cells, index) => {
    const row = index + 1;
    const [currencyCell = "", rateCell = ""] = cells;
    if (!currencyCell && !rateCell) return;
    // A heading row: no three-letter code and no number.
    if (rates.length === 0 && skipped.length === 0 && !/^[A-Za-z]{3}$/.test(currencyCell) && !isDecimalString(rateCell.replace(/,/g, ""))) return;
    const currencyCode = currencyCell.toUpperCase();
    if (!/^[A-Z]{3}$/.test(currencyCode)) {
      throw new ValidationError(`Row ${row}: "${currencyCell}" isn't a currency code like USD.`);
    }
    if (seen.has(currencyCode)) throw new ValidationError(`Row ${row}: ${currencyCode} is in the file twice.`);
    seen.add(currencyCode);
    if (currencyCode === base || !isSupportedCurrency(currencyCode) || !used.has(currencyCode)) {
      skipped.push({ row, currencyCode });
      return;
    }
    const text = rateCell.replace(/,/g, "");
    if (!text) throw new ValidationError(`Row ${row}: the ${currencyCode} rate is blank. Nothing has been saved.`);
    if (!isDecimalString(text) || cmp(dec(text), ZERO_DECIMAL) <= 0) {
      throw new ValidationError(`Row ${row}: the ${currencyCode} rate "${rateCell}" isn't a number above 0. Nothing has been saved.`);
    }
    const value = dec(text);
    if (value.scale > 8) throw new ValidationError(`Row ${row}: the ${currencyCode} rate has more than 8 decimal places.`);
    const rate = quoted === "foreign_per_base" ? toFixedString(divide(dec("1"), value, RATE_SCALE), RATE_SCALE) : toPlainString(value);
    if (cmp(dec(rate), ZERO_DECIMAL) <= 0) throw new ValidationError(`Row ${row}: the ${currencyCode} rate is too large to turn around.`);
    rates.push({ row, currencyCode, quoted: toPlainString(value), rate, text: `1 ${currencyCode} = ${rate} ${base}` });
  });
  if (rates.length === 0) throw new ValidationError("The file has no rates for currencies this organisation uses.");
  if (rates.length > MAX_RATE_ROWS) throw new ValidationError(`The file has more than ${MAX_RATE_ROWS} rates.`);
  return { rates, skipped };
}

type ParsedSet = {
  name: string;
  periodStart: string;
  periodEnd: string;
  quoted: RateQuote;
  fileName: string;
  rows: string[][];
};

function parseSetInput(input: Record<string, unknown>): ParsedSet {
  const name = requireString(input.name, "The set's name", { maxLength: 100 }).trim();
  if (!name) throw new ValidationError("Name the set for where its rates came from, like IRD monthly average.");
  const periodStart = parseIsoDate(input.periodStart, "The period's start");
  const periodEnd = parseIsoDate(input.periodEnd, "The period's end");
  if (periodEnd < periodStart) throw new ValidationError("The period's end can't be before its start.");
  const quoted = requireOneOf(input.quoted, "quoted", ["foreign_per_base", "base_per_foreign"]) as RateQuote;
  const fileName = optionalString(input.fileName, "fileName", { maxLength: 255 }) ?? "rates.csv";
  return { name, periodStart, periodEnd, quoted, fileName, rows: readRateFile(fileName, input.fileBase64) };
}

async function overlapping(tx: OrgTx, periodStart: string, periodEnd: string): Promise<RateSetPreview["overlaps"]> {
  const found = await tx.query<{ id: string; name: string; period_start: string; period_end: string }>(
    `select id::text, name, period_start::text, period_end::text from exchange_rate_sets
      where replaced_at is null and period_start <= $2 and period_end >= $1 order by exchange_rate_sets.period_start, exchange_rate_sets.id`,
    [periodStart, periodEnd],
  );
  return found.rows.map((row) => ({ id: row.id, name: row.name, periodStart: row.period_start, periodEnd: row.period_end }));
}

/** FX3: what an upload would add, without saving anything. */
export async function previewRateSet(tx: OrgTx, input: Record<string, unknown>): Promise<RateSetPreview> {
  const parsed = parseSetInput(input);
  const converted = convertRateRows(parsed.rows, parsed.quoted, tx.baseCurrency, await usedCurrencies(tx));
  return { ...converted, overlaps: await overlapping(tx, parsed.periodStart, parsed.periodEnd) };
}

/**
 * Saves an uploaded set (FX3, FX6): its rates go into the exchange rates
 * list, effective from the period's start and used only up to its end. A
 * set overlapping one already saved is refused unless `replaceReason` is
 * given; then the sets it overlaps are marked replaced and their rates
 * archived. Documents already made keep their rates (FX8).
 */
export async function uploadRateSet(tx: OrgTx, input: Record<string, unknown>): Promise<{ created: boolean; set: RateSet; skipped: RateSetPreview["skipped"] }> {
  const source = optionalSource(input.source);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const parsed = parseSetInput(input);
  const replaceReason = optionalString(input.replaceReason, "replaceReason", { maxLength: 500 })?.trim() || null;
  const { rates, skipped } = convertRateRows(parsed.rows, parsed.quoted, tx.baseCurrency, await usedCurrencies(tx));
  const hash = requestHash("exchange_rate_set", { ...parsed, rows: undefined, rates, replaceReason });
  const earlier = (await tx.query<SetRow & { request_hash: string }>(`${SET_SELECT.replace(" from ", ", request_hash from ")} where command_source = $1 and idempotency_key = $2`, [source, idempotencyKey]))
    .rows[0];
  if (earlier) {
    assertSameRequest(earlier.request_hash, hash, "exchange rate set");
    return { created: false, set: (await withRates(tx, [earlier]))[0], skipped };
  }
  // One upload at a time, so two overlapping sets can't both be saved.
  await tx.query("lock table exchange_rate_sets in share row exclusive mode");
  const overlaps = await overlapping(tx, parsed.periodStart, parsed.periodEnd);
  if (overlaps.length > 0 && !replaceReason) {
    const named = overlaps.map((set) => `${set.name} (${formatDate(set.periodStart)} to ${formatDate(set.periodEnd)})`).join(", ");
    throw new ConflictError(`Part of this period is already covered by ${named}. To replace it, give a reason; documents already made keep their rates.`);
  }
  for (const old of overlaps) {
    await tx.query("update exchange_rate_sets set replaced_at = now(), replaced_by_email = $2 where id = $1", [old.id, tx.actor.email]);
    await tx.query(
      "update currency_exchange_rates set archived_at = now(), archived_by_user_id = $2, archived_by_email = $3 where rate_set_id = $1 and archived_at is null",
      [old.id, tx.actor.userId, tx.actor.email],
    );
  }
  const inserted = await tx.query<SetRow>(
    `insert into exchange_rate_sets (command_source, idempotency_key, request_hash, name, period_start, period_end, quoted, file_name,
                                     replaces_set_id, replace_reason, created_by_user_id, created_by_email)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     returning id::text, name, period_start::text, period_end::text, quoted, file_name, replaces_set_id::text, replace_reason, replaced_at, created_by_email, created_at`,
    [
      source,
      idempotencyKey,
      hash,
      parsed.name,
      parsed.periodStart,
      parsed.periodEnd,
      parsed.quoted,
      parsed.fileName,
      overlaps[0]?.id ?? null,
      overlaps.length > 0 ? replaceReason : null,
      tx.actor.userId,
      tx.actor.email,
    ],
  );
  const set = inserted.rows[0];
  for (const [index, rate] of rates.entries()) {
    await tx.query(
      `insert into currency_exchange_rates (command_source, idempotency_key, line_number, request_hash, currency_code, effective_date, rate, note,
                                            created_by_user_id, created_by_email, rate_set_id)
       values ('rate_set', $1, $2, $3, $4, $5, $6::numeric, null, $7, $8, $9)`,
      [`set-${set.id}`, index + 1, hash, rate.currencyCode, parsed.periodStart, rate.rate, tx.actor.userId, tx.actor.email, set.id],
    );
  }
  await writeAuditEvent(tx, {
    eventType: "exchange_rate_set.uploaded",
    entityType: "exchange_rate_set",
    entityId: set.id,
    details: {
      name: parsed.name,
      periodStart: parsed.periodStart,
      periodEnd: parsed.periodEnd,
      quoted: parsed.quoted,
      fileName: parsed.fileName,
      rates: rates.length,
      skipped: skipped.map((entry) => entry.currencyCode),
      ...(overlaps.length > 0 ? { replaced: overlaps.map((old) => old.id), reason: replaceReason } : {}),
    },
  });
  return { created: true, set: (await withRates(tx, [set]))[0], skipped };
}
