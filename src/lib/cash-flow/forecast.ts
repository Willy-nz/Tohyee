import { writeAuditEvent } from "@/lib/audit";
import { dueDateFromSupplierTerms, dueDateFromTerms, RECEIVABLES_SQL } from "@/lib/customers/service";
import { parseIsoDate, parseOptionalIsoDate, todayIsoDate } from "@/lib/dates";
import { PAYABLES_SQL } from "@/lib/reports/aged-payables";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { lastRateFor } from "@/lib/ledger/foreign";
import { currencyMinorUnits } from "@/lib/money/currency";
import { add, cmp, dec, type Decimal, isNegative, isPositive, mul, mulDiv, neg, parseDecimalInput, sub, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";
import { billDueDate } from "@/lib/repeating/bill-rules";
import { datesBetween } from "@/lib/repeating/schedule";
import { asRecord, optionalBoolean, optionalId, requireArray, requireId, requireOneOf, requireString } from "@/lib/validation";
import {
  CASH_FLOW_LIMITS,
  CASH_FLOW_PERIODS,
  type CashFlowAverage,
  type CashFlowForecast,
  type CashFlowItem,
  type CashFlowLine,
  type CashFlowPeriod,
  type CashFlowPeriodKind,
} from "@/lib/cash-flow/types";

/**
 * Cash flow forecast (CF1-CF9, decisions 432-436), like NetSuite's Cash 360:
 * the chosen bank accounts' ledger balance today, then each period's money
 * in and out from what's in the books (open invoices and bills on their due
 * dates, repeating documents, unpaid expense claims, and optionally sales
 * and purchase orders and drafts), account averages and forecast items.
 * Posts nothing; the only things stored are forecast items and averages.
 */

// ---------------------------------------------------------------- dates

function shift(date: string, days: number): string {
  const moved = new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000);
  return moved.toISOString().slice(0, 10);
}

function addMonths(date: string, months: number): string {
  const [year, month] = date.split("-").map(Number);
  const index = year * 12 + (month - 1) + months;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}-01`;
}

function daysFrom(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

/** The periods: days from today, weeks from this Monday, or months from the 1st of this month. */
export function forecastPeriods(today: string, kind: CashFlowPeriodKind, count: number): Array<{ start: string; end: string }> {
  const periods: Array<{ start: string; end: string }> = [];
  if (kind === "month") {
    let start = `${today.slice(0, 7)}-01`;
    for (let index = 0; index < count; index += 1) {
      const next = addMonths(start, 1);
      periods.push({ start, end: shift(next, -1) });
      start = next;
    }
    return periods;
  }
  const length = kind === "day" ? 1 : 7;
  // Monday is day 1; Sunday (0) is the end of the week.
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
  let start = kind === "day" ? today : shift(today, -((weekday + 6) % 7));
  for (let index = 0; index < count; index += 1) {
    periods.push({ start, end: shift(start, length - 1) });
    start = shift(start, length);
  }
  return periods;
}

// ---------------------------------------------------------------- forecast

type Options = {
  today?: unknown;
  period?: unknown;
  count?: unknown;
  accountIds?: unknown;
  includeDrafts?: unknown;
  includeOrders?: unknown;
};

function flag(input: unknown, name: string): boolean {
  return (input === "true" ? true : input === "false" ? false : optionalBoolean(input, name)) ?? false;
}

export async function cashFlowForecast(tx: OrgTx, options: Options = {}): Promise<CashFlowForecast> {
  const today = parseOptionalIsoDate(options.today, "today") ?? todayIsoDate();
  const period = options.period == null || options.period === "" ? "week" : requireOneOf(options.period, "period", CASH_FLOW_PERIODS);
  const limit = CASH_FLOW_LIMITS[period];
  const countRaw = options.count == null || options.count === "" ? limit.default : Number(options.count);
  if (!Number.isInteger(countRaw) || countRaw < 1 || countRaw > limit.max) throw new ValidationError(`Show 1 to ${limit.max} ${period}s.`);
  const includeDrafts = flag(options.includeDrafts, "includeDrafts");
  const includeOrders = flag(options.includeOrders, "includeOrders");
  const scale = currencyMinorUnits(tx.baseCurrency);
  const money = (value: Decimal) => toFixedString(value, scale);

  // The bank accounts: all active bank accounts unless chosen.
  const all = await tx.query<{ id: string; code: string; name: string; account_type: string; is_active: boolean; balance: string }>(
    `select a.id::text, a.code, a.name, a.account_type, a.is_active,
            coalesce((select sum(l.debit_amount - l.credit_amount) from ledger_journal_lines l join ledger_journals j on j.id = l.journal_id
                       where l.account_id = a.id and j.posting_date <= $1::date), 0)::text as balance
       from accounts a where a.account_type in ('bank', 'credit_card') order by a.code`,
    [today],
  );
  const chosenIds =
    options.accountIds == null || options.accountIds === ""
      ? null
      : (Array.isArray(options.accountIds) ? options.accountIds : String(options.accountIds).split(",")).map((id) => requireId(id, "accountIds"));
  const accounts = chosenIds
    ? chosenIds.map((id) => {
        const found = all.rows.find((row) => row.id === id);
        if (!found) throw new ValidationError("Choose bank or credit card accounts for the forecast.");
        return found;
      })
    : all.rows.filter((row) => row.account_type === "bank" && row.is_active);
  const opening = accounts.reduce((total, row) => add(total, dec(row.balance)), ZERO_DECIMAL);

  const shape = forecastPeriods(today, period, countRaw);
  const first = shape[0].start;
  const last = shape[shape.length - 1].end;
  const lines: Array<CashFlowLine & { value: Decimal }> = [];
  const excluded: { label: string; reason: string }[] = [];

  const rates = new Map<string, string | null>();
  const toBase = async (amount: Decimal, currency: string, label: string): Promise<Decimal | null> => {
    if (currency === tx.baseCurrency) return amount;
    if (!rates.has(currency)) rates.set(currency, (await lastRateFor(tx, currency, today))?.rate ?? null);
    const rate = rates.get(currency);
    if (!rate) {
      excluded.push({ label: `${label} (${currency} ${toFixedString(amount, currencyMinorUnits(currency))})`, reason: `no ${currency} exchange rate to convert it` });
      return null;
    }
    return dec(toFixedString(mul(amount, dec(rate)), scale));
  };
  const place = async (line: Omit<CashFlowLine, "amount" | "baseAmount" | "overdue"> & { amount: Decimal; currencyCode: string }) => {
    if (line.date > last) return;
    const base = await toBase(line.amount, line.currencyCode, line.label);
    if (base === null || !isPositive(base)) return;
    lines.push({
      ...line,
      date: line.date,
      amount: toFixedString(line.amount, currencyMinorUnits(line.currencyCode)),
      baseAmount: money(base),
      overdue: line.date < today && ["invoice", "bill"].includes(line.source),
      value: base,
    });
  };

  // Approved invoices and bills with something due, on their due dates (CF1, CF2).
  const invoices = await tx.query<{ id: string; number: string | null; name: string; due_date: string; currency_code: string; amount_due: string }>(
    `${RECEIVABLES_SQL}
     select i.id::text, i.invoice_number as number, c.name, i.due_date::text, i.currency_code, i.amount_due::text
       from invoices i join contacts c on c.id = i.contact_id where i.amount_due > 0 order by i.due_date, i.id`,
    [null],
  );
  for (const row of invoices.rows) {
    await place({ source: "invoice", id: row.id, direction: "in", date: row.due_date, label: `${row.number ?? "Invoice"} ${row.name}`, currencyCode: row.currency_code, amount: dec(row.amount_due), draft: false, fromOrder: false });
  }
  const bills = await tx.query<{ id: string; number: string; name: string; due_date: string; currency_code: string; amount_due: string }>(
    `${PAYABLES_SQL}
     select b.id::text, b.supplier_invoice_number as number, c.name, b.due_date::text, b.currency_code, b.amount_due::text
       from bills_due b join contacts c on c.id = b.contact_id where b.amount_due > 0 order by b.due_date, b.id`,
    [null],
  );
  for (const row of bills.rows) {
    await place({ source: "bill", id: row.id, direction: "out", date: row.due_date, label: `${row.number} ${row.name}`, currencyCode: row.currency_code, amount: dec(row.amount_due), draft: false, fromOrder: false });
  }
  // Approved expense claims still to be paid: no due date, so the first period (CF2).
  const claims = await tx.query<{ id: string; claimant_email: string; currency_code: string; due: string }>(
    `select e.id::text, e.claimant_email, e.currency_code,
            (e.total - coalesce((select sum(p.amount) from expense_claim_payments p where p.claim_id = e.id and p.status = 'active'), 0))::text as due
       from expense_claims e where e.status = 'approved' order by e.id`,
  );
  for (const row of claims.rows) {
    await place({ source: "expense_claim", id: row.id, direction: "out", date: first, label: `CLAIM-${row.id} ${tx.people.get(row.claimant_email.toLowerCase()) ?? row.claimant_email}`, currencyCode: row.currency_code, amount: dec(row.due), draft: false, fromOrder: false });
  }

  // Repeating invoices and bills still to be made (CF3).
  const repeatingInvoices = await tx.query<{ id: string; name: string; contact_id: string; currency_code: string; total: string; period: "week" | "month"; every: number; start_date: string; end_date: string | null; due_rule: string; due_days: number | null; next: string | null }>(
    `select r.id::text, c.name, r.contact_id::text, r.currency_code, r.total::text, r.period, r.every, r.start_date::text, r.end_date::text, r.due_rule, r.due_days,
            ${nextPendingSql("repeating_invoice_runs", "repeating_invoice_id")} as next
       from repeating_invoices r join contacts c on c.id = r.contact_id where r.status = 'active' order by r.id`,
  );
  for (const row of repeatingInvoices.rows) {
    for (const date of datesBetween({ period: row.period, every: row.every, startDate: row.start_date, endDate: row.end_date }, row.next ?? row.start_date, last, 400)) {
      const due = row.due_rule === "terms" ? ((await dueDateFromTerms(tx, row.contact_id, date)) ?? date) : shift(date, row.due_days ?? 0);
      await place({ source: "repeating_invoice", id: row.id, direction: "in", date: due < first ? first : due, label: `Repeating invoice to ${row.name}, ${date}`, currencyCode: row.currency_code, amount: dec(row.total), draft: false, fromOrder: false });
    }
  }
  const repeatingBills = await tx.query<{ id: string; name: string; contact_id: string; currency_code: string; total: string; period: "week" | "month"; every: number; start_date: string; end_date: string | null; due_rule: "terms" | "days_after" | "days_after_month_end" | "day_of_next_month"; due_days: number; next: string | null }>(
    `select r.id::text, c.name, r.contact_id::text, r.currency_code, r.total::text, r.period, r.every, r.start_date::text, r.end_date::text, r.due_rule, r.due_days,
            ${nextPendingSql("repeating_bill_runs", "repeating_bill_id")} as next
       from repeating_bills r join contacts c on c.id = r.contact_id where r.status = 'active' order by r.id`,
  );
  for (const row of repeatingBills.rows) {
    for (const date of datesBetween({ period: row.period, every: row.every, startDate: row.start_date, endDate: row.end_date }, row.next ?? row.start_date, last, 400)) {
      const due = row.due_rule === "terms" ? ((await dueDateFromSupplierTerms(tx, row.contact_id, date)) ?? date) : billDueDate(date, row.due_rule, row.due_days);
      await place({ source: "repeating_bill", id: row.id, direction: "out", date: due < first ? first : due, label: `Repeating bill from ${row.name}, ${date}`, currencyCode: row.currency_code, amount: dec(row.total), draft: false, fromOrder: false });
    }
  }

  // Sales and purchase orders, for what's not yet invoiced or billed (CF7).
  if (includeOrders) {
    const orders = await tx.query<{ id: string; number: string | null; name: string; contact_id: string; currency_code: string; date: string; remaining: string }>(
      `select o.id::text, o.so_number as number, c.name, o.contact_id::text, o.currency_code, coalesce(o.expected_date, o.order_date)::text as date,
              (o.total - coalesce((select sum(i.total) from sales_invoices i where i.sales_order_id = o.id and i.status <> 'voided'), 0))::text as remaining
         from sales_orders o join contacts c on c.id = o.contact_id where o.status = 'approved' order by o.id`,
    );
    for (const row of orders.rows) {
      const due = (await dueDateFromTerms(tx, row.contact_id, row.date)) ?? row.date;
      await place({ source: "sales_order", id: row.id, direction: "in", date: due < first ? first : due, label: `${row.number ?? "Sales order"} ${row.name}`, currencyCode: row.currency_code, amount: dec(row.remaining), draft: false, fromOrder: true });
    }
    const purchases = await tx.query<{ id: string; number: string | null; name: string; contact_id: string; currency_code: string; date: string; remaining: string }>(
      `select o.id::text, o.po_number as number, c.name, o.contact_id::text, o.currency_code, coalesce(o.delivery_date, o.order_date)::text as date,
              (o.total - coalesce((select sum(b.total) from bills b where b.purchase_order_id = o.id and b.status <> 'voided'), 0))::text as remaining
         from purchase_orders o join contacts c on c.id = o.contact_id where o.status = 'approved' order by o.id`,
    );
    for (const row of purchases.rows) {
      const due = (await dueDateFromSupplierTerms(tx, row.contact_id, row.date)) ?? row.date;
      await place({ source: "purchase_order", id: row.id, direction: "out", date: due < first ? first : due, label: `${row.number ?? "Purchase order"} ${row.name}`, currencyCode: row.currency_code, amount: dec(row.remaining), draft: false, fromOrder: true });
    }
  }

  // Draft invoices and bills, marked (CF8).
  if (includeDrafts) {
    const draftInvoices = await tx.query<{ id: string; name: string; due_date: string; currency_code: string; total: string }>(
      `select i.id::text, c.name, i.due_date::text, i.currency_code, i.total::text from sales_invoices i join contacts c on c.id = i.contact_id
        where i.status = 'draft' order by i.due_date, i.id`,
    );
    for (const row of draftInvoices.rows) {
      await place({ source: "invoice", id: row.id, direction: "in", date: row.due_date < first ? first : row.due_date, label: `Draft invoice ${row.name}`, currencyCode: row.currency_code, amount: dec(row.total), draft: true, fromOrder: false });
    }
    const draftBills = await tx.query<{ id: string; number: string | null; name: string; due_date: string; currency_code: string; total: string }>(
      `select b.id::text, b.supplier_invoice_number as number, c.name, b.due_date::text, b.currency_code, b.total::text from bills b join contacts c on c.id = b.contact_id
        where b.status = 'draft' order by b.due_date, b.id`,
    );
    for (const row of draftBills.rows) {
      await place({ source: "bill", id: row.id, direction: "out", date: row.due_date < first ? first : row.due_date, label: `Draft bill ${row.number ?? ""} ${row.name}`.replace(/\s+/g, " "), currencyCode: row.currency_code, amount: dec(row.total), draft: true, fromOrder: false });
    }
  }

  // Forecast items (CF4).
  for (const item of await listCashFlowItems(tx)) {
    const dates = item.repeat === "none" ? [item.date] : datesBetween({ period: item.repeat, every: 1, startDate: item.date, endDate: item.untilDate }, first, last, 400);
    for (const date of dates) {
      if (item.repeat === "none" && date < first) continue;
      await place({ source: "item", id: item.id, direction: item.direction, date, label: item.description, currencyCode: tx.baseCurrency, amount: dec(item.amount), draft: false, fromOrder: false });
    }
  }

  // Account averages (CF6): the last 3 or 6 whole months' average daily movement, times each period's days.
  const averages = await listCashFlowAverages(tx);
  const averageLines: Array<{ periodIndex: number; line: CashFlowLine & { value: Decimal } }> = [];
  for (const average of averages) {
    const windowStart = addMonths(`${today.slice(0, 7)}-01`, -average.months);
    const windowEnd = shift(`${today.slice(0, 7)}-01`, -1);
    const movement = await tx.query<{ net: string }>(
      `select coalesce(sum(l.debit_amount - l.credit_amount), 0)::text as net from ledger_journal_lines l join ledger_journals j on j.id = l.journal_id
        where l.account_id = $1 and j.posting_date between $2::date and $3::date`,
      [average.accountId, windowStart, windowEnd],
    );
    const net = average.direction === "out" ? dec(movement.rows[0].net) : neg(dec(movement.rows[0].net));
    if (!isPositive(net)) continue;
    const windowDays = daysFrom(windowStart, windowEnd);
    shape.forEach((range, periodIndex) => {
      const value = mulDiv(net, dec(String(daysFrom(range.start, range.end))), dec(String(windowDays)), scale);
      if (!isPositive(value)) return;
      averageLines.push({
        periodIndex,
        line: {
          source: "average",
          id: average.accountId,
          direction: average.direction,
          date: range.start,
          label: `${average.accountCode} ${average.accountName} (average of the last ${average.months} months)`,
          currencyCode: tx.baseCurrency,
          amount: money(value),
          baseAmount: money(value),
          overdue: false,
          draft: false,
          fromOrder: false,
          value,
        },
      });
    });
  }

  // Each period: in, out, net and closing (CF5).
  let balance = opening;
  const periods: CashFlowPeriod[] = shape.map((range, index) => {
    const own = [
      ...lines.filter((line) => (index === 0 ? line.date <= range.end : line.date >= range.start && line.date <= range.end)),
      ...averageLines.filter((entry) => entry.periodIndex === index).map((entry) => entry.line),
    ];
    const total = (direction: "in" | "out") => own.filter((line) => line.direction === direction).reduce((sum, line) => add(sum, line.value), ZERO_DECIMAL);
    const moneyIn = total("in");
    const moneyOut = total("out");
    balance = add(balance, sub(moneyIn, moneyOut));
    return {
      start: range.start,
      end: range.end,
      moneyIn: money(moneyIn),
      moneyOut: money(moneyOut),
      net: money(sub(moneyIn, moneyOut)),
      closing: money(balance),
      lines: own
        .sort((left, right) => left.direction.localeCompare(right.direction) || left.date.localeCompare(right.date) || left.label.localeCompare(right.label))
        .map((line) => {
          const { value, ...rest } = line;
          void value;
          return rest;
        }),
    };
  });
  const lowest = periods.reduce((best, entry, index) => (cmp(dec(entry.closing), dec(periods[best].closing)) < 0 ? index : best), 0);
  const belowZero = periods.findIndex((entry) => isNegative(dec(entry.closing)));
  return {
    today,
    period,
    count: countRaw,
    currencyCode: tx.baseCurrency,
    includeDrafts,
    includeOrders,
    accounts: accounts.map((row) => ({ id: row.id, code: row.code, name: row.name, accountType: row.account_type, balance: money(dec(row.balance)) })),
    availableAccounts: all.rows.filter((row) => row.is_active).map((row) => ({ id: row.id, code: row.code, name: row.name, accountType: row.account_type })),
    opening: money(opening),
    periods,
    lowest: { index: lowest, closing: periods[lowest].closing },
    firstBelowZero: belowZero === -1 ? null : belowZero,
    excluded,
  };
}

function nextPendingSql(runsTable: string, column: string): string {
  // The day after the last date made, or the start (or a resume) date: what's still to be made.
  return `greatest(r.start_date, coalesce(r.resumed_from, r.start_date),
                    coalesce((select max(x.scheduled_date) + 1 from ${runsTable} x where x.${column} = r.id), r.start_date))::text`;
}

// ---------------------------------------------------------------- forecast items

type ItemRow = {
  id: string;
  direction: "in" | "out";
  description: string;
  amount: string;
  item_date: string;
  repeat: "none" | "week" | "month";
  until_date: string | null;
  version: number;
  created_by_email: string | null;
  created_at: string;
  updated_by_email: string | null;
  updated_at: string;
};

function toItem(row: ItemRow, scale: number): CashFlowItem {
  return {
    id: row.id,
    direction: row.direction,
    description: row.description,
    amount: toFixedString(dec(row.amount), scale),
    date: row.item_date,
    repeat: row.repeat,
    untilDate: row.until_date,
    version: row.version,
    createdByEmail: row.created_by_email,
    createdAt: row.created_at,
    updatedByEmail: row.updated_by_email,
    updatedAt: row.updated_at,
  };
}

const ITEM_COLUMNS = "id::text, direction, description, amount::text, item_date::text, repeat, until_date::text, version, created_by_email, created_at, updated_by_email, updated_at";

export async function listCashFlowItems(tx: OrgTx): Promise<CashFlowItem[]> {
  const scale = currencyMinorUnits(tx.baseCurrency);
  const found = await tx.query<ItemRow>(`select ${ITEM_COLUMNS} from cash_flow_items where archived_at is null order by item_date, id`);
  return found.rows.map((row) => toItem(row, scale));
}

function parseItem(tx: OrgTx, input: Record<string, unknown>) {
  const direction = requireOneOf(input.direction, "direction", ["in", "out"] as const);
  const description = requireString(input.description, "The description", { maxLength: 200 });
  const amount = parseDecimalInput(input.amount, "The amount", { maxScale: currencyMinorUnits(tx.baseCurrency) });
  const date = parseIsoDate(input.date, "The date");
  const repeat = input.repeat == null || input.repeat === "" ? "none" : requireOneOf(input.repeat, "repeat", ["none", "week", "month"] as const);
  const untilDate = repeat === "none" ? null : parseOptionalIsoDate(input.untilDate, "The until date");
  if (untilDate !== null && untilDate < date) throw new ValidationError("The until date can't be before the date.");
  return { direction, description, amount, date, repeat, untilDate };
}

/** Adds a forecast item (CF4): money in or out, once or every week or month until a date. Bookkeepers. */
export async function createCashFlowItem(tx: OrgTx, input: Record<string, unknown>): Promise<CashFlowItem> {
  const item = parseItem(tx, input);
  const inserted = await tx.query<ItemRow>(
    `insert into cash_flow_items (direction, description, amount, item_date, repeat, until_date, created_by_email, updated_by_email)
     values ($1, $2, $3::numeric, $4, $5, $6, $7, $7) returning ${ITEM_COLUMNS}`,
    [item.direction, item.description, item.amount, item.date, item.repeat, item.untilDate, tx.actor.email],
  );
  const created = toItem(inserted.rows[0], currencyMinorUnits(tx.baseCurrency));
  await writeAuditEvent(tx, { eventType: "cash_flow_item.created", entityType: "cash_flow_item", entityId: created.id, details: { ...item } });
  return created;
}

async function lockItem(tx: OrgTx, idInput: unknown): Promise<ItemRow> {
  const id = requireId(idInput, "itemId");
  const found = await tx.query<ItemRow>(`select ${ITEM_COLUMNS} from cash_flow_items where id = $1 and archived_at is null for update`, [id]);
  if (!found.rows[0]) throw new NotFoundError("Forecast item not found.");
  return found.rows[0];
}

/** Changes a forecast item; `version` is the one read. */
export async function updateCashFlowItem(tx: OrgTx, idInput: unknown, input: Record<string, unknown>): Promise<CashFlowItem> {
  const current = await lockItem(tx, idInput);
  if (Number(input.version) !== current.version) throw new ConflictError("Someone else changed this forecast item since you opened it. Reload it and try again.");
  const item = parseItem(tx, input);
  const updated = await tx.query<ItemRow>(
    `update cash_flow_items set direction = $2, description = $3, amount = $4::numeric, item_date = $5, repeat = $6, until_date = $7,
            version = version + 1, updated_by_email = $8, updated_at = now()
      where id = $1 returning ${ITEM_COLUMNS}`,
    [current.id, item.direction, item.description, item.amount, item.date, item.repeat, item.untilDate, tx.actor.email],
  );
  await writeAuditEvent(tx, {
    eventType: "cash_flow_item.updated",
    entityType: "cash_flow_item",
    entityId: current.id,
    details: { ...item, before: { direction: current.direction, description: current.description, amount: current.amount, date: current.item_date, repeat: current.repeat, untilDate: current.until_date } },
  });
  return toItem(updated.rows[0], currencyMinorUnits(tx.baseCurrency));
}

/** Removes a forecast item (kept, archived, with its history). */
export async function removeCashFlowItem(tx: OrgTx, idInput: unknown): Promise<void> {
  const current = await lockItem(tx, idInput);
  await tx.query("update cash_flow_items set archived_at = now(), archived_by_email = $2 where id = $1", [current.id, tx.actor.email]);
  await writeAuditEvent(tx, { eventType: "cash_flow_item.removed", entityType: "cash_flow_item", entityId: current.id, details: { description: current.description, amount: current.amount } });
}

// ---------------------------------------------------------------- account averages

export async function listCashFlowAverages(tx: OrgTx): Promise<CashFlowAverage[]> {
  const found = await tx.query<{ account_id: string; code: string; name: string; direction: "in" | "out"; months: 3 | 6; updated_by_email: string | null; updated_at: string }>(
    `select v.account_id::text, a.code, a.name, v.direction, v.months, v.updated_by_email, v.updated_at
       from cash_flow_account_averages v join accounts a on a.id = v.account_id order by a.code`,
  );
  return found.rows.map((row) => ({ accountId: row.account_id, accountCode: row.code, accountName: row.name, direction: row.direction, months: row.months, updatedByEmail: row.updated_by_email, updatedAt: row.updated_at }));
}

/**
 * Replaces the accounts forecast from their average (CF6): each with money
 * in or out and 3 or 6 months. Bank, card, receivable and payable accounts
 * aren't averaged: their documents are already in the forecast.
 */
export async function setCashFlowAverages(tx: OrgTx, input: unknown): Promise<CashFlowAverage[]> {
  const entries = requireArray(input, "averages", 50).map((raw, index) => {
    const entry = asRecord(raw, `Average ${index + 1}`);
    return {
      accountId: optionalId(entry.accountId, "accountId"),
      direction: requireOneOf(entry.direction, "direction", ["in", "out"] as const),
      months: Number(entry.months ?? 3),
    };
  });
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!entry.accountId) throw new ValidationError("Choose an account for each average.");
    if (entry.months !== 3 && entry.months !== 6) throw new ValidationError("An average is over the last 3 or 6 months.");
    if (seen.has(entry.accountId)) throw new ValidationError("An account is averaged once.");
    seen.add(entry.accountId);
    const account = await tx.query<{ code: string; account_type: string; system_key: string | null }>("select code, account_type, system_key from accounts where id = $1", [entry.accountId]);
    const found = account.rows[0];
    if (!found) throw new ValidationError("That account wasn't found.");
    if (["bank", "credit_card"].includes(found.account_type) || ["accounts_receivable", "accounts_payable"].includes(found.system_key ?? "")) {
      throw new ValidationError(`${found.code} can't be averaged: its money is already in the forecast from the bank balance and open documents.`);
    }
  }
  const before = await listCashFlowAverages(tx);
  await tx.query("delete from cash_flow_account_averages");
  for (const entry of entries) {
    await tx.query("insert into cash_flow_account_averages (account_id, direction, months, updated_by_email) values ($1, $2, $3, $4)", [entry.accountId, entry.direction, entry.months, tx.actor.email]);
  }
  const after = await listCashFlowAverages(tx);
  await writeAuditEvent(tx, {
    eventType: "cash_flow_averages.updated",
    entityType: "cash_flow_averages",
    entityId: "1",
    details: { before: before.map((entry) => `${entry.accountCode} ${entry.direction} ${entry.months}`), after: after.map((entry) => `${entry.accountCode} ${entry.direction} ${entry.months}`) },
  });
  return after;
}
