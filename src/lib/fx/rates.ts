import { writeAuditEvent } from "@/lib/audit";
import { parseIsoDate, todayIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { parsePastedRates } from "@/lib/fx/rate-text";
import { assertSameRequest, requestHash } from "@/lib/idempotency";
import { parseExchangeRate } from "@/lib/ledger/journals";
import { parseCurrencyCode } from "@/lib/money/currency";
import { dec, toPlainString } from "@/lib/money/decimal";
import { optionalSource, requireArray, requireId, requireIdempotencyKey } from "@/lib/validation";

/**
 * The currency exchange rates list (examples MC46-MC53), like NetSuite's
 * Currency Exchange Rates: for each foreign currency the organisation uses,
 * rates with the date each takes effect, in the base currency per 1 unit
 * (the direction of every document's rate). A new foreign-currency invoice,
 * bill, credit note, payment, refund or statement line takes the latest
 * entry effective on or before its date, and it can still be changed; with
 * none in the list, the last rate used in the books (D4, MC3). Entries are
 * never changed or deleted: a correction is a newer entry for the same date
 * (the newest one added wins, MC47), or archiving the wrong one.
 */
export type ExchangeRate = {
  id: string;
  currencyCode: string;
  effectiveDate: string;
  rate: string;
  note: string | null;
  createdByEmail: string | null;
  createdAt: string;
  archivedAt: string | null;
  archivedByEmail: string | null;
  /** Where it came from (FX2): the ECB's daily job, an uploaded set, or typed (or pasted) here. */
  source: "ecb" | "set" | "typed";
  /** "ECB", the set's name, or "Typed". */
  sourceLabel: string;
  rateSetId: string | null;
  /** For a set's rate, the last day it's used (the set's period end). */
  until: string | null;
};

export type ExchangeRatesList = {
  baseCurrency: string;
  /** Foreign currencies on contacts, accounts or in the list, for the form. */
  currenciesInUse: string[];
  /** Per currency, the entry in effect today (null when every entry is later). */
  current: Array<{ currencyCode: string; rate: ExchangeRate | null }>;
  /** Newest effective date first. */
  rates: ExchangeRate[];
};

type Row = {
  id: string;
  currency_code: string;
  effective_date: string;
  rate: string;
  note: string | null;
  created_by_email: string | null;
  created_at: string;
  archived_at: string | null;
  archived_by_email: string | null;
  command_source: string;
  rate_set_id: string | null;
  set_name: string | null;
  set_end: string | null;
};

const COLUMNS = `r.id::text, r.currency_code, r.effective_date::text, r.rate::text, r.note, r.created_by_email, r.created_at, r.archived_at, r.archived_by_email,
                 r.command_source, r.rate_set_id::text, s.name as set_name, s.period_end::text as set_end`;
const SELECT = `select ${COLUMNS} from currency_exchange_rates r left join exchange_rate_sets s on s.id = r.rate_set_id`;
/** Which entry wins for a date: the latest effective date on or before it, then the one added last. */
const ORDER = "order by r.effective_date desc, r.created_at desc, r.id desc";

function toRate(row: Row): ExchangeRate {
  return {
    id: row.id,
    currencyCode: row.currency_code,
    effectiveDate: row.effective_date,
    rate: toPlainString(dec(row.rate)),
    note: row.note,
    createdByEmail: row.created_by_email,
    createdAt: row.created_at,
    archivedAt: row.archived_at,
    archivedByEmail: row.archived_by_email,
    source: row.rate_set_id ? "set" : row.command_source === "ecb" ? "ecb" : "typed",
    sourceLabel: row.set_name ?? (row.command_source === "ecb" ? "ECB" : "Typed"),
    rateSetId: row.rate_set_id,
    until: row.set_end,
  };
}

/** The label a document records for a list rate it took (FX4). */
export function listSourceLabel(rate: Pick<ExchangeRate, "source" | "sourceLabel">): string {
  return rate.source === "typed" ? "Exchange rates list" : rate.sourceLabel;
}

export async function listExchangeRates(tx: OrgTx, options: { includeArchived?: boolean; today?: string } = {}): Promise<ExchangeRatesList> {
  const rows = await tx.query<Row>(`${SELECT} ${options.includeArchived ? "" : "where r.archived_at is null"} ${ORDER}`);
  const rates = rows.rows.map(toRate);
  const used = await tx.query<{ code: string }>(
    `select code from (
       select currency_code as code from contacts where currency_code is not null
       union select currency_code from accounts where currency_code is not null
       union select currency_code from currency_exchange_rates
     ) c where code <> $1 order by code`,
    [tx.baseCurrency],
  );
  const today = options.today ?? todayIsoDate();
  const active = rates.filter((rate) => rate.archivedAt === null);
  return {
    baseCurrency: tx.baseCurrency,
    currenciesInUse: used.rows.map((row) => row.code),
    current: used.rows.map((row) => ({
      currencyCode: row.code,
      rate: active.find((rate) => rate.currencyCode === row.code && rate.effectiveDate <= today && (rate.until === null || today <= rate.until)) ?? null,
    })),
    rates,
  };
}

export type ListedRate = { rate: string; date: string; until: string | null; label: string };

/**
 * The list's entries for some currencies, newest effective date first (the
 * order `lastRateOnOrBefore` wants), archived ones left out. An uploaded
 * set's rate is used only up to its period's end (`until`). With uploaded
 * sets as the source (FX4), only sets' rates count.
 */
export async function listedRates(tx: OrgTx, currencies: readonly string[], options: { setsOnly?: boolean } = {}): Promise<Map<string, ListedRate[]>> {
  const wanted = [...new Set(currencies)].filter((code) => code !== tx.baseCurrency);
  const byCurrency = new Map<string, ListedRate[]>(wanted.map((code) => [code, []]));
  if (wanted.length === 0) return byCurrency;
  const rows = await tx.query<Row>(
    `${SELECT} where r.archived_at is null and r.currency_code = any($1::text[]) ${options.setsOnly ? "and r.rate_set_id is not null" : ""} ${ORDER}`,
    [wanted],
  );
  for (const row of rows.rows) {
    const rate = toRate(row);
    byCurrency.get(row.currency_code)?.push({ rate: rate.rate, date: rate.effectiveDate, until: rate.until, label: listSourceLabel(rate) });
  }
  return byCurrency;
}

/** The list's rate for a currency effective on a date (MC48), or null. */
export async function listedRateOn(tx: OrgTx, currencyCode: string, date: string): Promise<ListedRate | null> {
  return (await listedRates(tx, [currencyCode])).get(currencyCode)?.find((entry) => entry.date <= date && (entry.until === null || date <= entry.until)) ?? null;
}

type RateInput = { currencyCode: unknown; effectiveDate: unknown; rate: unknown; note?: unknown };

function parseRate(tx: OrgTx, input: RateInput, where: string) {
  const prefix = where ? `${where}: ` : "";
  try {
    const currencyCode = parseCurrencyCode(input.currencyCode, "The currency");
    if (currencyCode === tx.baseCurrency) {
      throw new ValidationError(`${currencyCode} is the base currency, so it has no exchange rate. Add rates for foreign currencies only.`);
    }
    const effectiveDate = parseIsoDate(input.effectiveDate, "The effective date");
    const rate = parseExchangeRate(input.rate, "The rate");
    let note: string | null = null;
    if (input.note !== undefined && input.note !== null && input.note !== "") {
      if (typeof input.note !== "string" || input.note.trim().length > 200) throw new ValidationError("The note can be at most 200 characters.");
      note = input.note.trim() || null;
    }
    return { currencyCode, effectiveDate, rate: toPlainString(dec(rate)), note };
  } catch (error) {
    if (error instanceof ValidationError && prefix) throw new ValidationError(`${prefix}${error.message}`);
    throw error;
  }
}

/**
 * Adds rates to the list (MC46, MC52): one, or several pasted at once
 * (`text`, see `parsePastedRates`) in one command, all or nothing. A retry
 * with the same idempotency key returns what was added the first time.
 */
export async function addExchangeRates(
  tx: OrgTx,
  input: { source?: unknown; idempotencyKey: unknown; rates?: unknown; text?: unknown },
): Promise<{ created: boolean; added: ExchangeRate[] }> {
  const source = optionalSource(input.source);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const parsed =
    input.text !== undefined
      ? parsePastedRates(input.text).map((row) => parseRate(tx, row, `Line ${row.line}`))
      : (() => {
          const list = requireArray(input.rates, "rates");
          if (list.length === 0) throw new ValidationError("Add at least one rate.");
          return list.map((entry, index) => parseRate(tx, (entry ?? {}) as RateInput, list.length > 1 ? `Rate ${index + 1}` : ""));
        })();
  const hash = requestHash("exchange_rates", { rates: parsed });
  const earlier = await tx.query<Row & { request_hash: string }>(
    `select ${COLUMNS}, r.request_hash from currency_exchange_rates r left join exchange_rate_sets s on s.id = r.rate_set_id
      where r.command_source = $1 and r.idempotency_key = $2 order by r.line_number`,
    [source, idempotencyKey],
  );
  if (earlier.rows[0]) {
    assertSameRequest(earlier.rows[0].request_hash, hash, "exchange rate");
    return { created: false, added: earlier.rows.map(toRate) };
  }
  const added: ExchangeRate[] = [];
  for (const [index, rate] of parsed.entries()) {
    const inserted = await tx.query<Row>(
      `insert into currency_exchange_rates (command_source, idempotency_key, line_number, request_hash, currency_code, effective_date, rate, note,
                                            created_by_user_id, created_by_email)
       values ($1, $2, $3, $4, $5, $6, $7::numeric, $8, $9, $10)
       returning id::text, currency_code, effective_date::text, rate::text, note, created_by_email, created_at, archived_at, archived_by_email,
                 command_source, rate_set_id::text, null as set_name, null as set_end`,
      [source, idempotencyKey, index + 1, hash, rate.currencyCode, rate.effectiveDate, rate.rate, rate.note, tx.actor.userId, tx.actor.email],
    );
    added.push(toRate(inserted.rows[0]));
  }
  for (const rate of added) {
    await writeAuditEvent(tx, {
      eventType: "exchange_rate.added",
      entityType: "exchange_rate",
      entityId: rate.id,
      details: { currencyCode: rate.currencyCode, effectiveDate: rate.effectiveDate, rate: rate.rate, note: rate.note, ...(added.length > 1 ? { pasted: added.length } : {}) },
    });
  }
  return { created: true, added };
}

/**
 * Archives an entry (MC47): it stops being used for new documents, and the
 * entry before it (or the last rate used) takes over. Documents that already
 * took it keep their rate. Archiving is final; add the rate again to undo.
 */
export async function archiveExchangeRate(tx: OrgTx, idInput: unknown): Promise<ExchangeRate> {
  const id = requireId(idInput, "exchangeRateId");
  const found = await tx.query<Row>(`${SELECT} where r.id = $1 for update of r`, [id]);
  const row = found.rows[0];
  if (!row) throw new NotFoundError("Exchange rate not found.");
  if (row.archived_at) throw new ConflictError("This exchange rate is already archived.");
  await tx.query("update currency_exchange_rates set archived_at = now(), archived_by_user_id = $2, archived_by_email = $3 where id = $1", [
    id,
    tx.actor.userId,
    tx.actor.email,
  ]);
  const rate = toRate((await tx.query<Row>(`${SELECT} where r.id = $1`, [id])).rows[0]);
  await writeAuditEvent(tx, {
    eventType: "exchange_rate.archived",
    entityType: "exchange_rate",
    entityId: id,
    details: { currencyCode: rate.currencyCode, effectiveDate: rate.effectiveDate, rate: rate.rate },
  });
  return rate;
}
