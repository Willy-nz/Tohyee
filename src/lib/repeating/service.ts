import { writeAuditEvent } from "@/lib/audit";
import { keptCustom, parseCustomInput } from "@/lib/custom-fields/service";
import type { CustomValues } from "@/lib/custom-fields/values";
import { dueDateFromTerms } from "@/lib/customers/service";
import { parseIsoDate, parseOptionalIsoDate, todayIsoDate } from "@/lib/dates";
import type { Actor, OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, HttpError, NotFoundError, ValidationError } from "@/lib/errors";
import { assertSameRequest, requestHash } from "@/lib/idempotency";
import { AMOUNTS_MODES, type AmountsMode } from "@/lib/invoices/amounts";
import {
  approveInvoice,
  createInvoice,
  hashSalesLines,
  insertSalesLines,
  type InvoiceLine,
  linesAsSent,
  loadSalesLines,
  parseSalesLines,
  resolveSalesDraft,
  type ResolvedSalesDraft,
  type SalesDraft,
} from "@/lib/invoices/service";
import { datesBetween, nextDate, REPEAT_PERIODS, type RepeatPeriod } from "@/lib/repeating/schedule";
import { parseSalespersonInput } from "@/lib/salespeople/service";
import { keptValues } from "@/lib/tracking/service";
import { optionalId, optionalSource, optionalString, requireId, requireIdempotencyKey, requireOneOf } from "@/lib/validation";

/**
 * Repeating invoices (examples RI1-RI10), like Xero's. A template holds a
 * customer and invoice lines, how often (every N weeks or months from a
 * start date, until an optional end date), how the due date is set (the
 * customer's payment terms or N days after the invoice date) and whether each
 * invoice is saved as a draft or approved. `runRepeatingInvoices` makes each
 * scheduled date's invoice once: a row in `repeating_invoice_runs` per date
 * (unique), so running twice never makes two, and missed dates are caught up
 * in order. Templates post nothing; the invoices post when approved.
 */
export const REPEATING_STATUSES = ["active", "paused", "ended"] as const;
export type RepeatingStatus = (typeof REPEATING_STATUSES)[number];
export const DUE_RULES = ["terms", "days_after"] as const;
export type DueRule = (typeof DUE_RULES)[number];
export const SAVE_AS = ["draft", "approve"] as const;
export type SaveAs = (typeof SAVE_AS)[number];

/** Who the background job acts as in the audit trail and on the invoices it makes. */
export const REPEATING_ACTOR: Actor = { userId: null, email: "repeating-invoices@tohyee" };
/** At most this many dates are made per template in one run (the rest next run). */
const MAX_DATES_PER_RUN = 60;

export type RepeatingRun = {
  id: string;
  scheduledDate: string;
  invoiceId: string | null;
  invoiceNumber: string | null;
  invoiceDeleted: boolean;
  outcome: "draft" | "approved" | "approval_refused";
  message: string | null;
  createdByEmail: string | null;
  createdAt: string;
};

export type RepeatingInvoiceSummary = {
  id: string;
  status: RepeatingStatus;
  contactId: string;
  contactName: string;
  reference: string | null;
  amountsMode: AmountsMode;
  currencyCode: string;
  subtotal: string;
  taxTotal: string;
  total: string;
  customFields: CustomValues;
  salespersonId: string | null;
  period: RepeatPeriod;
  every: number;
  startDate: string;
  endDate: string | null;
  dueRule: DueRule;
  dueDays: number | null;
  saveAs: SaveAs;
  resumedFrom: string | null;
  /** The next date an invoice will be made for, or null when it's ended or paused. */
  nextDate: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  createdByEmail: string | null;
  createdAt: string;
  updatedAt: string;
};

export type RepeatingInvoice = RepeatingInvoiceSummary & { lines: InvoiceLine[]; runs: RepeatingRun[] };

export type RepeatingInput = {
  contactId?: unknown;
  reference?: unknown;
  amountsMode?: unknown;
  lines?: unknown;
  customFields?: unknown;
  salespersonId?: unknown;
  period?: unknown;
  every?: unknown;
  startDate?: unknown;
  endDate?: unknown;
  dueRule?: unknown;
  dueDays?: unknown;
  saveAs?: unknown;
};

type Row = {
  id: string;
  status: RepeatingStatus;
  contact_id: string;
  contact_name: string;
  reference: string | null;
  amounts_mode: AmountsMode;
  currency_code: string;
  subtotal: string;
  tax_total: string;
  total: string;
  custom_fields: CustomValues;
  salesperson_id: string | null;
  period: RepeatPeriod;
  every: number;
  start_date: string;
  end_date: string | null;
  due_rule: DueRule;
  due_days: number | null;
  save_as: SaveAs;
  resumed_from: string | null;
  last_error: string | null;
  last_error_at: string | null;
  created_by_email: string | null;
  created_at: string;
  updated_at: string;
  last_run: string | null;
};

const SUMMARY_SQL = `select r.*, c.name as contact_name,
       (select max(scheduled_date) from repeating_invoice_runs x where x.repeating_invoice_id = r.id) as last_run
  from repeating_invoices r join contacts c on c.id = r.contact_id`;

/** The first date still to be made: after the last one made, and not before a resume (RI7). */
function firstPending(row: Pick<Row, "start_date" | "resumed_from" | "last_run">): string {
  let from = row.start_date;
  if (row.resumed_from && row.resumed_from > from) from = row.resumed_from;
  if (row.last_run) {
    const after = new Date(Date.parse(`${row.last_run}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    if (after > from) from = after;
  }
  return from;
}

function toSummary(row: Row): RepeatingInvoiceSummary {
  const schedule = { period: row.period, every: row.every, startDate: row.start_date, endDate: row.end_date };
  return {
    id: row.id,
    status: row.status,
    contactId: row.contact_id,
    contactName: row.contact_name,
    reference: row.reference,
    amountsMode: row.amounts_mode,
    currencyCode: row.currency_code,
    subtotal: row.subtotal,
    taxTotal: row.tax_total,
    total: row.total,
    customFields: row.custom_fields ?? {},
    salespersonId: row.salesperson_id,
    period: row.period,
    every: row.every,
    startDate: row.start_date,
    endDate: row.end_date,
    dueRule: row.due_rule,
    dueDays: row.due_days,
    saveAs: row.save_as,
    resumedFrom: row.resumed_from,
    nextDate: row.status === "active" ? nextDate(schedule, firstPending(row)) : null,
    lastError: row.last_error,
    lastErrorAt: row.last_error_at,
    createdByEmail: row.created_by_email,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

type Parsed = {
  draft: SalesDraft;
  period: RepeatPeriod;
  every: number;
  startDate: string;
  endDate: string | null;
  dueRule: DueRule;
  dueDays: number | null;
  saveAs: SaveAs;
};

function parseWhole(input: unknown, field: string, min: number, max: number): number {
  const value = typeof input === "string" && /^\d{1,3}$/.test(input.trim()) ? Number(input.trim()) : input;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new ValidationError(`${field} must be a whole number from ${min} to ${max}.`);
  }
  return value;
}

function parseTemplate(input: RepeatingInput): Parsed {
  const contactId = requireId(input.contactId, "contactId");
  const startDate = parseIsoDate(input.startDate, "startDate");
  const endDate = parseOptionalIsoDate(input.endDate, "endDate");
  if (endDate !== null && endDate < startDate) throw new ValidationError("The end date can't be before the start date.");
  const amountsMode = requireOneOf(input.amountsMode, "amountsMode", AMOUNTS_MODES);
  const dueRule = requireOneOf(input.dueRule, "dueRule", DUE_RULES);
  return {
    draft: {
      contactId,
      invoiceDate: startDate,
      dueDate: startDate,
      reference: optionalString(input.reference, "reference", { maxLength: 100 }),
      amountsMode,
      lines: parseSalesLines(input.lines, amountsMode, "A repeating invoice"),
      customInput: parseCustomInput(input.customFields, ""),
      salespersonInput: parseSalespersonInput(input.salespersonId),
    },
    period: requireOneOf(input.period, "period", REPEAT_PERIODS),
    every: parseWhole(input.every, "every", 1, 99),
    startDate,
    endDate,
    dueRule,
    dueDays: dueRule === "days_after" ? parseWhole(input.dueDays, "dueDays", 0, 365) : null,
    saveAs: requireOneOf(input.saveAs, "saveAs", SAVE_AS),
  };
}

function hashPayload(parsed: Parsed): Record<string, unknown> {
  const { draft } = parsed;
  return {
    contactId: draft.contactId,
    reference: draft.reference,
    amountsMode: draft.amountsMode,
    lines: hashSalesLines(draft.lines),
    ...(draft.customInput !== undefined ? { customFields: draft.customInput } : {}),
    ...(draft.salespersonInput !== undefined ? { salespersonId: draft.salespersonInput } : {}),
    period: parsed.period,
    every: parsed.every,
    startDate: parsed.startDate,
    endDate: parsed.endDate,
    dueRule: parsed.dueRule,
    dueDays: parsed.dueDays,
    saveAs: parsed.saveAs,
  };
}

async function checkDueRule(tx: OrgTx, parsed: Parsed): Promise<void> {
  if (parsed.dueRule === "terms" && (await dueDateFromTerms(tx, parsed.draft.contactId, parsed.startDate)) === null) {
    throw new ValidationError("This customer has no payment terms, so choose a number of days for the due date instead.");
  }
}

export async function getRepeatingInvoice(tx: OrgTx, idInput: unknown): Promise<RepeatingInvoice> {
  const id = requireId(idInput, "repeatingInvoiceId");
  const found = await tx.query<Row>(`${SUMMARY_SQL} where r.id = $1`, [id]);
  const row = found.rows[0];
  if (!row) throw new NotFoundError("Repeating invoice not found.");
  const runs = await tx.query<{
    id: string;
    scheduled_date: string;
    invoice_id: string | null;
    invoice_number: string | null;
    invoice_deleted: boolean;
    outcome: RepeatingRun["outcome"];
    message: string | null;
    created_by_email: string | null;
    created_at: string;
  }>(
    `select x.id, x.scheduled_date, x.invoice_id, i.invoice_number, x.invoice_deleted, x.outcome, x.message, x.created_by_email, x.created_at
       from repeating_invoice_runs x left join sales_invoices i on i.id = x.invoice_id
      where x.repeating_invoice_id = $1 order by x.scheduled_date desc`,
    [id],
  );
  return {
    ...toSummary(row),
    lines: await loadSalesLines(tx, "repeating_invoice_lines", id),
    runs: runs.rows.map((run) => ({
      id: run.id,
      scheduledDate: run.scheduled_date,
      invoiceId: run.invoice_id,
      invoiceNumber: run.invoice_number,
      invoiceDeleted: run.invoice_deleted,
      outcome: run.outcome,
      message: run.message,
      createdByEmail: run.created_by_email,
      createdAt: run.created_at,
    })),
  };
}

export async function listRepeatingInvoices(
  tx: OrgTx,
  filters: { status?: unknown; contactId?: unknown } = {},
): Promise<{ repeatingInvoices: RepeatingInvoiceSummary[] }> {
  const status = filters.status == null || filters.status === "" ? null : requireOneOf(filters.status, "status", REPEATING_STATUSES);
  const contactId = optionalId(filters.contactId, "contactId");
  const found = await tx.query<Row>(
    `${SUMMARY_SQL} where ($1::text is null or r.status = $1) and ($2::bigint is null or r.contact_id = $2) order by r.id desc limit 500`,
    [status, contactId],
  );
  return { repeatingInvoices: found.rows.map(toSummary) };
}

function asSent(template: RepeatingInvoice): RepeatingInput {
  return {
    contactId: template.contactId,
    reference: template.reference,
    amountsMode: template.amountsMode,
    lines: linesAsSent(template.lines),
    customFields: template.customFields,
    salespersonId: template.salespersonId,
    period: template.period,
    every: template.every,
    startDate: template.startDate,
    endDate: template.endDate,
    dueRule: template.dueRule,
    dueDays: template.dueDays,
    saveAs: template.saveAs,
  };
}

async function resolveFor(tx: OrgTx, draft: SalesDraft, current?: RepeatingInvoice): Promise<ResolvedSalesDraft> {
  return current
    ? resolveSalesDraft(
        tx,
        draft,
        keptValues(current.lines),
        keptCustom(current.customFields, ...current.lines.map((line) => line.customFields)),
        current.salespersonId,
        current.lines,
      )
    : resolveSalesDraft(tx, draft);
}

/** Saves a new template (RI1). It starts active; nothing is made until the job runs. */
export async function createRepeatingInvoice(
  tx: OrgTx,
  input: RepeatingInput & { source?: unknown; idempotencyKey: unknown },
): Promise<{ created: boolean; repeatingInvoice: RepeatingInvoice }> {
  const source = optionalSource(input.source);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const parsed = parseTemplate(input);
  const hash = requestHash("repeating_invoice", hashPayload(parsed));
  const existing = await tx.query<{ id: string; request_hash: string }>(
    "select id, request_hash from repeating_invoices where command_source = $1 and idempotency_key = $2",
    [source, idempotencyKey],
  );
  if (existing.rows[0]) {
    assertSameRequest(existing.rows[0].request_hash, hash, "repeating invoice");
    return { created: false, repeatingInvoice: await getRepeatingInvoice(tx, existing.rows[0].id) };
  }
  await checkDueRule(tx, parsed);
  const resolved = await resolveFor(tx, parsed.draft);
  const inserted = await tx.query<{ id: string }>(
    `insert into repeating_invoices (command_source, idempotency_key, request_hash, contact_id, reference, amounts_mode, currency_code,
                                     subtotal, tax_total, total, custom_fields, salesperson_id, period, every, start_date, end_date,
                                     due_rule, due_days, save_as, created_by_user_id, created_by_email)
     values ($1, $2, $3, $4, $5, $6, $7, $8::numeric, $9::numeric, $10::numeric, $11::jsonb, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
     on conflict (command_source, idempotency_key) do nothing returning id`,
    [
      source,
      idempotencyKey,
      hash,
      resolved.contactId,
      resolved.reference,
      resolved.amountsMode,
      resolved.currencyCode,
      resolved.subtotal,
      resolved.taxTotal,
      resolved.total,
      JSON.stringify(resolved.customFields),
      resolved.salespersonId,
      parsed.period,
      parsed.every,
      parsed.startDate,
      parsed.endDate,
      parsed.dueRule,
      parsed.dueDays,
      parsed.saveAs,
      tx.actor.userId,
      tx.actor.email,
    ],
  );
  const id = inserted.rows[0]?.id;
  if (!id) throw new ConflictError("That repeating invoice is being saved by another request. Try again.");
  await insertSalesLines(tx, "repeating_invoice_lines", id, resolved.resolvedLines);
  await writeAuditEvent(tx, {
    eventType: "repeating_invoice.created",
    entityType: "repeating_invoice",
    entityId: id,
    details: { contactId: resolved.contactId, period: parsed.period, every: parsed.every, startDate: parsed.startDate, total: resolved.total },
  });
  return { created: true, repeatingInvoice: await getRepeatingInvoice(tx, id) };
}

async function lockTemplate(tx: OrgTx, id: string): Promise<RepeatingInvoice> {
  const locked = await tx.query("select id from repeating_invoices where id = $1 for update", [id]);
  if (locked.rowCount === 0) throw new NotFoundError("Repeating invoice not found.");
  return getRepeatingInvoice(tx, id);
}

function assertNotEnded(template: RepeatingInvoice): void {
  if (template.status === "ended") throw new ConflictError("This repeating invoice has ended, so it can't be changed. Save a new one instead.");
}

/**
 * Changes a template (RI8). Invoices already made keep what they had. If the
 * schedule (how often or the start date) changes, dates before today under
 * the new schedule aren't made.
 */
export async function updateRepeatingInvoice(tx: OrgTx, idInput: unknown, input: RepeatingInput, today = todayIsoDate()): Promise<RepeatingInvoice> {
  const current = await lockTemplate(tx, requireId(idInput, "repeatingInvoiceId"));
  assertNotEnded(current);
  const saved = asSent(current);
  const merged = Object.fromEntries(
    (Object.keys(saved) as Array<keyof RepeatingInput>).map((key) => [key, input[key] === undefined ? saved[key] : input[key]]),
  ) as RepeatingInput;
  const parsed = parseTemplate(merged);
  await checkDueRule(tx, parsed);
  const resolved = await resolveFor(tx, parsed.draft, current);
  const scheduleChanged = parsed.period !== current.period || parsed.every !== current.every || parsed.startDate !== current.startDate;
  const resumedFrom = scheduleChanged && current.runs.length > 0 ? (current.resumedFrom && current.resumedFrom > today ? current.resumedFrom : today) : current.resumedFrom;
  await tx.query(
    `update repeating_invoices
        set contact_id = $2, reference = $3, amounts_mode = $4, currency_code = $5, subtotal = $6::numeric, tax_total = $7::numeric,
            total = $8::numeric, custom_fields = $9::jsonb, salesperson_id = $10, period = $11, every = $12, start_date = $13,
            end_date = $14, due_rule = $15, due_days = $16, save_as = $17, resumed_from = $18, updated_at = now()
      where id = $1`,
    [
      current.id,
      resolved.contactId,
      resolved.reference,
      resolved.amountsMode,
      resolved.currencyCode,
      resolved.subtotal,
      resolved.taxTotal,
      resolved.total,
      JSON.stringify(resolved.customFields),
      resolved.salespersonId,
      parsed.period,
      parsed.every,
      parsed.startDate,
      parsed.endDate,
      parsed.dueRule,
      parsed.dueDays,
      parsed.saveAs,
      resumedFrom,
    ],
  );
  await tx.query("delete from repeating_invoice_lines where repeating_invoice_id = $1", [current.id]);
  await insertSalesLines(tx, "repeating_invoice_lines", current.id, resolved.resolvedLines);
  await writeAuditEvent(tx, {
    eventType: "repeating_invoice.updated",
    entityType: "repeating_invoice",
    entityId: current.id,
    details: { total: { from: current.total, to: resolved.total }, scheduleChanged },
  });
  return getRepeatingInvoice(tx, current.id);
}

/**
 * Pauses, resumes or ends a template (RI7). Paused and ended templates make
 * nothing. Resuming doesn't make the dates that fell while it was paused.
 * Ending is final.
 */
export async function setRepeatingStatus(
  tx: OrgTx,
  idInput: unknown,
  statusInput: unknown,
  today = todayIsoDate(),
): Promise<RepeatingInvoice> {
  const status = requireOneOf(statusInput, "status", REPEATING_STATUSES);
  const current = await lockTemplate(tx, requireId(idInput, "repeatingInvoiceId"));
  assertNotEnded(current);
  if (current.status === status) return current;
  const resumedFrom = status === "active" ? today : current.resumedFrom;
  await tx.query("update repeating_invoices set status = $2, resumed_from = $3, updated_at = now() where id = $1", [current.id, status, resumedFrom]);
  await writeAuditEvent(tx, {
    eventType: `repeating_invoice.${status === "active" ? "resumed" : status}`,
    entityType: "repeating_invoice",
    entityId: current.id,
    details: { from: current.status, to: status },
  });
  return getRepeatingInvoice(tx, current.id);
}

export type RunResult = { made: number; approved: number; refused: number; failed: number };

function reason(error: unknown): string {
  return (error instanceof HttpError ? error.message : "Something went wrong making this invoice; see the server log.").slice(0, 1000);
}

/**
 * Makes the invoices that are due (RI2-RI6, RI9): for each active template
 * (or just `repeatingInvoiceId`), every scheduled date up to `today` that
 * hasn't been made yet, oldest first. Each date gets a draft invoice dated
 * that day; with "approve" it's then approved, and a refused approval (a
 * locked period, a credit limit that blocks, a missing required field)
 * leaves the draft and records why on the template's history. If an invoice
 * can't be made at all (say the customer is archived), the template keeps the
 * error and stops at that date until the next run.
 */
export async function runRepeatingInvoices(
  tx: OrgTx,
  options: { today?: string; repeatingInvoiceId?: unknown } = {},
): Promise<RunResult> {
  const today = options.today ?? todayIsoDate();
  const only = optionalId(options.repeatingInvoiceId, "repeatingInvoiceId");
  const result: RunResult = { made: 0, approved: 0, refused: 0, failed: 0 };
  const due = await tx.query<{ id: string }>(
    "select id from repeating_invoices where status = 'active' and start_date <= $1 and ($2::bigint is null or id = $2) order by id",
    [today, only],
  );
  for (const { id } of due.rows) {
    // Locking the template makes two runs take turns, and the second sees the first's dates as made (RI3).
    await tx.query("select id from repeating_invoices where id = $1 for update", [id]);
    const template = await getRepeatingInvoice(tx, id);
    if (template.status !== "active") continue;
    const lastRun = template.runs[0]?.scheduledDate ?? null;
    const from = firstPending({ start_date: template.startDate, resumed_from: template.resumedFrom, last_run: lastRun });
    const dates = datesBetween(
      { period: template.period, every: template.every, startDate: template.startDate, endDate: template.endDate },
      from,
      today,
      MAX_DATES_PER_RUN,
    );
    let lastError: string | null = null;
    for (const date of dates) {
      await tx.query("savepoint repeating_date");
      let invoiceId: string;
      try {
        const dueDate =
          template.dueRule === "terms"
            ? await dueDateFromTerms(tx, template.contactId, date)
            : new Date(Date.parse(`${date}T00:00:00Z`) + (template.dueDays ?? 0) * 86_400_000).toISOString().slice(0, 10);
        if (dueDate === null) throw new ValidationError("The customer no longer has payment terms, so the due date can't be worked out. Edit the template.");
        const made = await createInvoice(tx, {
          source: "repeating",
          idempotencyKey: `repeating-${template.id}-${date}`,
          contactId: template.contactId,
          invoiceDate: date,
          dueDate,
          reference: template.reference,
          amountsMode: template.amountsMode,
          lines: linesAsSent(template.lines),
          customFields: template.customFields,
          salespersonId: template.salespersonId,
        });
        invoiceId = made.invoice.id;
        await tx.query("release savepoint repeating_date");
      } catch (error) {
        await tx.query("rollback to savepoint repeating_date");
        if (!(error instanceof HttpError)) console.warn(`[tohyee] Repeating invoice ${template.id} on ${date}:`, error);
        lastError = `${date}: ${reason(error)}`;
        result.failed += 1;
        break;
      }
      let outcome: RepeatingRun["outcome"] = "draft";
      let message: string | null = null;
      if (template.saveAs === "approve") {
        await tx.query("savepoint repeating_approve");
        try {
          const approved = await approveInvoice(tx, invoiceId, { source: "repeating", idempotencyKey: `repeating-${template.id}-${date}-approve` });
          await tx.query("release savepoint repeating_approve");
          outcome = "approved";
          message = approved.creditWarning ? `Approved over the credit limit: ${approved.creditWarning}` : null;
          result.approved += 1;
        } catch (error) {
          await tx.query("rollback to savepoint repeating_approve");
          if (!(error instanceof HttpError)) console.warn(`[tohyee] Repeating invoice ${template.id} approval on ${date}:`, error);
          outcome = "approval_refused";
          message = `Left as a draft: ${reason(error)}`.slice(0, 1000);
          result.refused += 1;
        }
      }
      await tx.query(
        `insert into repeating_invoice_runs (repeating_invoice_id, scheduled_date, invoice_id, outcome, message, created_by_email)
         values ($1, $2, $3, $4, $5, $6)`,
        [template.id, date, invoiceId, outcome, message, tx.actor.email],
      );
      await writeAuditEvent(tx, {
        eventType: "repeating_invoice.invoice_made",
        entityType: "repeating_invoice",
        entityId: template.id,
        details: { scheduledDate: date, invoiceId, outcome, ...(message ? { message } : {}) },
      });
      result.made += 1;
    }
    if (lastError !== null || (template.lastError !== null && dates.length > 0)) {
      await tx.query(
        `update repeating_invoices set last_error = $2, last_error_at = case when $2::text is null then null else now() end, updated_at = now() where id = $1`,
        [template.id, lastError],
      );
      if (lastError) {
        await writeAuditEvent(tx, { eventType: "repeating_invoice.failed", entityType: "repeating_invoice", entityId: template.id, details: { error: lastError } });
      }
    }
    // Past the end date with every date made: the template ends itself.
    if (lastError === null && template.endDate !== null && template.endDate <= today) {
      const after = await getRepeatingInvoice(tx, template.id);
      if (after.nextDate === null) {
        await tx.query("update repeating_invoices set status = 'ended', updated_at = now() where id = $1", [template.id]);
        await writeAuditEvent(tx, { eventType: "repeating_invoice.ended", entityType: "repeating_invoice", entityId: template.id, details: { reason: "end date reached" } });
      }
    }
  }
  return result;
}

/** Active templates with a date that may be due by `today`, for the job to run one at a time. */
export async function listDueRepeatingInvoiceIds(tx: OrgTx, today = todayIsoDate()): Promise<string[]> {
  const due = await tx.query<{ id: string }>("select id from repeating_invoices where status = 'active' and start_date <= $1 order by id", [today]);
  return due.rows.map((row) => row.id);
}

/** Makes a template's due invoices now, on request ("Run now"), with the same code as the nightly job. */
export async function runRepeatingInvoiceNow(tx: OrgTx, idInput: unknown): Promise<{ result: RunResult; repeatingInvoice: RepeatingInvoice }> {
  const id = requireId(idInput, "repeatingInvoiceId");
  const result = await runRepeatingInvoices(tx, { repeatingInvoiceId: id });
  return { result, repeatingInvoice: await getRepeatingInvoice(tx, id) };
}

/** The template and date that made an invoice (RI2), if any. */
export async function repeatingForInvoice(tx: OrgTx, invoiceId: string): Promise<{ id: string; scheduledDate: string } | null> {
  const found = await tx.query<{ id: string; scheduled_date: string }>(
    "select repeating_invoice_id as id, scheduled_date from repeating_invoice_runs where invoice_id = $1",
    [invoiceId],
  );
  const row = found.rows[0];
  return row ? { id: row.id, scheduledDate: row.scheduled_date } : null;
}
