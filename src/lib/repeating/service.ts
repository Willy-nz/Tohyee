import { writeAuditEvent } from "@/lib/audit";
import { assertForeignTemplateSavesDrafts } from "@/lib/fx/documents";
import { keptCustom, parseCustomInput } from "@/lib/custom-fields/service";
import type { CustomValues } from "@/lib/custom-fields/values";
import { dueDateFromTerms } from "@/lib/customers/service";
import { parseIsoDate, parseOptionalIsoDate, todayIsoDate } from "@/lib/dates";
import type { Actor, OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
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
import {
  assertNotEnded,
  firstPending as firstPendingDate,
  listDueTemplateIds,
  lockTemplate as lockAny,
  parseWhole,
  REPEATING_STATUSES,
  type RepeatingKind,
  type RepeatingStatus,
  resumedAfterChange,
  type RunOutcome,
  type RunResult,
  runTemplates,
  SAVE_AS,
  type SaveAs,
  setTemplateStatus,
  templateForDocument,
} from "@/lib/repeating/runner";
import { nextDate, REPEAT_PERIODS, type RepeatPeriod } from "@/lib/repeating/schedule";
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
export { REPEATING_STATUSES, SAVE_AS };
export type { RepeatingStatus, RunResult, SaveAs } from "@/lib/repeating/runner";
export const DUE_RULES = ["terms", "days_after"] as const;
export type DueRule = (typeof DUE_RULES)[number];

export type RepeatingRun = {
  id: string;
  scheduledDate: string;
  invoiceId: string | null;
  invoiceNumber: string | null;
  invoiceDeleted: boolean;
  outcome: RunOutcome;
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
  return firstPendingDate({ startDate: row.start_date, resumedFrom: row.resumed_from, lastRun: row.last_run });
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

/**
 * A template for a customer in another currency (MC26) is in that currency,
 * like NetSuite's memorized transactions, with no rate: each invoice made
 * from it takes a rate for its own date.
 */
const TEMPLATE_FOREIGN = { foreignCurrency: true, template: true, feature: "Repeating invoices" } as const;

async function resolveFor(tx: OrgTx, draft: SalesDraft, current?: RepeatingInvoice): Promise<ResolvedSalesDraft> {
  return current
    ? resolveSalesDraft(
        tx,
        draft,
        keptValues(current.lines),
        keptCustom(current.customFields, ...current.lines.map((line) => line.customFields)),
        current.salespersonId,
        current.lines,
        TEMPLATE_FOREIGN,
      )
    : resolveSalesDraft(tx, draft, undefined, undefined, undefined, undefined, TEMPLATE_FOREIGN);
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
  assertForeignTemplateSavesDrafts(tx.baseCurrency, resolved.currencyCode, parsed.saveAs, "invoice");
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
  return lockAny(tx, INVOICES, id);
}

/**
 * Changes a template (RI8). Invoices already made keep what they had. If the
 * schedule (how often or the start date) changes, dates before today under
 * the new schedule aren't made.
 */
export async function updateRepeatingInvoice(tx: OrgTx, idInput: unknown, input: RepeatingInput, today = todayIsoDate()): Promise<RepeatingInvoice> {
  const current = await lockTemplate(tx, requireId(idInput, "repeatingInvoiceId"));
  assertNotEnded(INVOICES, current);
  const saved = asSent(current);
  const merged = Object.fromEntries(
    (Object.keys(saved) as Array<keyof RepeatingInput>).map((key) => [key, input[key] === undefined ? saved[key] : input[key]]),
  ) as RepeatingInput;
  const parsed = parseTemplate(merged);
  await checkDueRule(tx, parsed);
  const resolved = await resolveFor(tx, parsed.draft, current);
  assertForeignTemplateSavesDrafts(tx.baseCurrency, resolved.currencyCode, parsed.saveAs, "invoice");
  const { scheduleChanged, resumedFrom } = resumedAfterChange(current, parsed, today);
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
  return setTemplateStatus(tx, INVOICES, requireId(idInput, "repeatingInvoiceId"), statusInput, today);
}

/**
 * How the shared scheduler (`./runner`) makes repeating invoices (RI2-RI6,
 * RI9): each date gets a draft invoice dated that day, due by the customer's
 * terms or N days after; with "approve" it's then approved as a person would
 * (period locks, the credit limit, required fields).
 */
const INVOICES: RepeatingKind<RepeatingInvoice> = {
  table: "repeating_invoices",
  runsTable: "repeating_invoice_runs",
  templateColumn: "repeating_invoice_id",
  documentColumn: "invoice_id",
  entityType: "repeating_invoice",
  label: "repeating invoice",
  documentNoun: "invoice",
  actor: { userId: null, email: "repeating-invoices@tohyee" },
  get: (tx, id) => getRepeatingInvoice(tx, id),
  async make(tx, template, date) {
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
      // In the template's currency (MC26), at the last rate used on or before the date (MC3).
    }, { foreignCurrency: true, feature: "Repeating invoices" });
    return made.invoice.id;
  },
  async approve(tx, template, date, invoiceId) {
    const approved = await approveInvoice(tx, invoiceId, { source: "repeating", idempotencyKey: `repeating-${template.id}-${date}-approve` });
    return approved.creditWarning ? `Approved over the credit limit: ${approved.creditWarning}` : null;
  },
};

/** How the shared scheduler makes repeating invoices, for the hourly job. */
export const REPEATING_INVOICE_KIND = INVOICES;

/** Who the background job acts as in the audit trail and on the invoices it makes. */
export const REPEATING_ACTOR: Actor = INVOICES.actor;

/**
 * Makes the invoices that are due (RI2-RI6, RI9): for each active template
 * (or just `repeatingInvoiceId`), every scheduled date up to `today` that
 * hasn't been made yet, oldest first, with the shared scheduler. A refused
 * approval leaves the draft and records why; an invoice that can't be made
 * at all (say the customer is archived) stops the template at that date
 * until the next run.
 */
export async function runRepeatingInvoices(
  tx: OrgTx,
  options: { today?: string; repeatingInvoiceId?: unknown } = {},
): Promise<RunResult> {
  return runTemplates(tx, INVOICES, { today: options.today, templateId: options.repeatingInvoiceId, idField: "repeatingInvoiceId" });
}

/** Active templates with a date that may be due by `today`, for the job to run one at a time. */
export async function listDueRepeatingInvoiceIds(tx: OrgTx, today = todayIsoDate()): Promise<string[]> {
  return listDueTemplateIds(tx, INVOICES, today);
}

/** Makes a template's due invoices now, on request ("Run now"), with the same code as the hourly job. */
export async function runRepeatingInvoiceNow(tx: OrgTx, idInput: unknown): Promise<{ result: RunResult; repeatingInvoice: RepeatingInvoice }> {
  const id = requireId(idInput, "repeatingInvoiceId");
  const result = await runRepeatingInvoices(tx, { repeatingInvoiceId: id });
  return { result, repeatingInvoice: await getRepeatingInvoice(tx, id) };
}

/** The template and date that made an invoice (RI2), if any. */
export async function repeatingForInvoice(tx: OrgTx, invoiceId: string): Promise<{ id: string; scheduledDate: string } | null> {
  return templateForDocument(tx, INVOICES, invoiceId);
}
