import { writeAuditEvent } from "@/lib/audit";
import {
  approveBill,
  type BillLine,
  type BillStatus,
  createBill,
  type DraftDetails,
  hashPurchaseLines,
  insertPurchaseLines,
  loadPurchaseLines,
  parsePurchaseLines,
  resolveDraft,
  type ResolvedDraft,
} from "@/lib/bills/service";
import { keptCustom, parseCustomInput } from "@/lib/custom-fields/service";
import type { CustomValues } from "@/lib/custom-fields/values";
import { parseIsoDate, parseOptionalIsoDate, todayIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { assertSameRequest, requestHash } from "@/lib/idempotency";
import { loadStockContext, stockLocation } from "@/lib/inventory/stock";
import { AMOUNTS_MODES, type AmountsMode } from "@/lib/invoices/amounts";
import { dec, toPlainString } from "@/lib/money/decimal";
import { dueDateFromSupplierTerms } from "@/lib/customers/service";
import { BILL_DUE_RULES, billDueDate, billNumberFor, type BillDueRule, NUMBER_PATTERN_MAX, numberPatternProblem } from "@/lib/repeating/bill-rules";
import {
  assertNotEnded,
  firstPending,
  listDueTemplateIds,
  lockTemplate,
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
import { keptValues } from "@/lib/tracking/service";
import { optionalId, optionalSource, requireId, requireIdempotencyKey, requireOneOf, requireString } from "@/lib/validation";

/**
 * Repeating bills (examples RB1-RB10), the purchases twin of repeating
 * invoices and like Xero's repeating bills (NetSuite's memorized bills). A
 * template holds a supplier and bill lines (the bill line rules: items fill
 * the supplier's price, stock items need a Location once locations are in
 * use), a supplier invoice number pattern, a due date rule, how often, and
 * whether each bill is saved as a draft or approved. The shared scheduler
 * (`./runner`) makes each date's bill once, catching up missed dates.
 * Templates post nothing; bills post when approved, and nothing is ever
 * paid automatically.
 */
export type RepeatingBillRun = {
  id: string;
  scheduledDate: string;
  billId: string | null;
  /** The bill's supplier invoice number, while the bill exists. */
  supplierInvoiceNumber: string | null;
  billStatus: BillStatus | null;
  billDeleted: boolean;
  outcome: RunOutcome;
  message: string | null;
  createdByEmail: string | null;
  createdAt: string;
};

export type RepeatingBillSummary = {
  id: string;
  status: RepeatingStatus;
  contactId: string;
  contactName: string;
  /**
   * The pattern each bill's supplier invoice number is made from, e.g. "Rent
   * {month}" (RB3), or null: each bill is a draft without a number (RB11).
   */
  supplierInvoiceNumber: string | null;
  amountsMode: AmountsMode;
  currencyCode: string;
  subtotal: string;
  taxTotal: string;
  total: string;
  customFields: CustomValues;
  period: RepeatPeriod;
  every: number;
  startDate: string;
  endDate: string | null;
  dueRule: BillDueRule;
  dueDays: number;
  saveAs: SaveAs;
  resumedFrom: string | null;
  /** The next date a bill will be made for, or null when it's ended or paused. */
  nextDate: string | null;
  /** The supplier invoice number the next bill will have. */
  nextSupplierInvoiceNumber: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  createdByEmail: string | null;
  createdAt: string;
  updatedAt: string;
};

export type RepeatingBill = RepeatingBillSummary & { lines: BillLine[]; runs: RepeatingBillRun[] };

export type RepeatingBillInput = {
  contactId?: unknown;
  supplierInvoiceNumber?: unknown;
  amountsMode?: unknown;
  lines?: unknown;
  customFields?: unknown;
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
  supplier_invoice_number: string | null;
  amounts_mode: AmountsMode;
  currency_code: string;
  subtotal: string;
  tax_total: string;
  total: string;
  custom_fields: CustomValues;
  period: RepeatPeriod;
  every: number;
  start_date: string;
  end_date: string | null;
  due_rule: BillDueRule;
  due_days: number;
  save_as: SaveAs;
  resumed_from: string | null;
  last_error: string | null;
  last_error_at: string | null;
  created_by_email: string | null;
  created_at: string;
  updated_at: string;
  last_run: string | null;
  run_count: number;
};

const SUMMARY_SQL = `select r.*, c.name as contact_name,
       (select max(scheduled_date) from repeating_bill_runs x where x.repeating_bill_id = r.id) as last_run,
       (select count(*)::int from repeating_bill_runs x where x.repeating_bill_id = r.id) as run_count
  from repeating_bills r join contacts c on c.id = r.contact_id`;

function toSummary(row: Row): RepeatingBillSummary {
  const schedule = { period: row.period, every: row.every, startDate: row.start_date, endDate: row.end_date };
  const next = row.status === "active" ? nextDate(schedule, firstPending({ startDate: row.start_date, resumedFrom: row.resumed_from, lastRun: row.last_run })) : null;
  return {
    id: row.id,
    status: row.status,
    contactId: row.contact_id,
    contactName: row.contact_name,
    supplierInvoiceNumber: row.supplier_invoice_number,
    amountsMode: row.amounts_mode,
    currencyCode: row.currency_code,
    subtotal: row.subtotal,
    taxTotal: row.tax_total,
    total: row.total,
    customFields: row.custom_fields ?? {},
    period: row.period,
    every: row.every,
    startDate: row.start_date,
    endDate: row.end_date,
    dueRule: row.due_rule,
    dueDays: row.due_days,
    saveAs: row.save_as,
    resumedFrom: row.resumed_from,
    nextDate: next,
    nextSupplierInvoiceNumber: next ? billNumberFor(row.supplier_invoice_number, next, row.run_count + 1) : null,
    lastError: row.last_error,
    lastErrorAt: row.last_error_at,
    createdByEmail: row.created_by_email,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

type Parsed = {
  draft: DraftDetails;
  period: RepeatPeriod;
  every: number;
  startDate: string;
  endDate: string | null;
  dueRule: BillDueRule;
  dueDays: number;
  saveAs: SaveAs;
};

function parseTemplate(input: RepeatingBillInput): Parsed {
  const contactId = requireId(input.contactId, "contactId");
  const startDate = parseIsoDate(input.startDate, "startDate");
  const endDate = parseOptionalIsoDate(input.endDate, "endDate");
  if (endDate !== null && endDate < startDate) throw new ValidationError("The end date can't be before the start date.");
  const period = requireOneOf(input.period, "period", REPEAT_PERIODS);
  const saveAs = requireOneOf(input.saveAs, "saveAs", SAVE_AS);
  // RB11: an empty pattern makes drafts without a number, to be completed from the supplier's invoice.
  const sentPattern = input.supplierInvoiceNumber;
  const pattern =
    sentPattern === null || sentPattern === undefined || (typeof sentPattern === "string" && sentPattern.trim() === "")
      ? null
      : requireString(sentPattern, "supplierInvoiceNumber", { maxLength: NUMBER_PATTERN_MAX });
  const problem = numberPatternProblem(pattern ?? "", period, saveAs);
  if (problem) throw new ValidationError(problem);
  const amountsMode = requireOneOf(input.amountsMode, "amountsMode", AMOUNTS_MODES);
  const dueRule = requireOneOf(input.dueRule, "dueRule", BILL_DUE_RULES);
  return {
    // The bill line rules and maths apply (B1-B4, IT6, ST1); the bill date is each scheduled date.
    draft: {
      contactId,
      billDate: startDate,
      dueDate: startDate,
      supplierInvoiceNumber: pattern,
      amountsMode,
      lines: parsePurchaseLines(input.lines, amountsMode, "A repeating bill"),
      customInput: parseCustomInput(input.customFields, ""),
    },
    period,
    every: parseWhole(input.every, "every", 1, 99),
    startDate,
    endDate,
    dueRule,
    // RB12: the supplier's terms need no days.
    dueDays:
      dueRule === "terms"
        ? 0
        : dueRule === "day_of_next_month"
          ? parseWhole(input.dueDays, "dueDays", 1, 31)
          : parseWhole(input.dueDays, "dueDays", 0, 365),
    saveAs,
  };
}

/** RB12: due by the supplier's payment terms needs a supplier that has them. */
async function checkDueRule(tx: OrgTx, parsed: Parsed): Promise<void> {
  if (parsed.dueRule === "terms" && (await dueDateFromSupplierTerms(tx, parsed.draft.contactId, parsed.startDate)) === null) {
    throw new ValidationError("This supplier has no payment terms, so choose a number of days for the due date instead (or give the supplier payment terms in Contacts).");
  }
}

function hashPayload(parsed: Parsed): Record<string, unknown> {
  const { draft } = parsed;
  return {
    contactId: draft.contactId,
    supplierInvoiceNumber: draft.supplierInvoiceNumber,
    amountsMode: draft.amountsMode,
    lines: hashPurchaseLines(draft.lines),
    ...(draft.customInput !== undefined ? { customFields: draft.customInput } : {}),
    period: parsed.period,
    every: parsed.every,
    startDate: parsed.startDate,
    endDate: parsed.endDate,
    dueRule: parsed.dueRule,
    dueDays: parsed.dueDays,
    saveAs: parsed.saveAs,
  };
}

/** Saved lines in the shape a person sends them (and createBill takes). */
function purchaseLinesAsSent(lines: readonly BillLine[]) {
  return lines.map((line) => ({
    description: line.description,
    quantity: toPlainString(dec(line.quantity)),
    unitPrice: toPlainString(dec(line.unitPrice)),
    accountCode: line.accountCode,
    taxCode: line.taxCode,
    tracking: line.tracking,
    customFields: line.customFields,
    itemId: line.itemId,
    unitId: line.unitId,
  }));
}

function asSent(template: RepeatingBill): RepeatingBillInput {
  return {
    contactId: template.contactId,
    supplierInvoiceNumber: template.supplierInvoiceNumber,
    amountsMode: template.amountsMode,
    lines: purchaseLinesAsSent(template.lines),
    customFields: template.customFields,
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
 * Checks the lines as a bill's (RB1): the supplier, accounts, tax codes and
 * items, with items filling the supplier's price. Stock items need a Location
 * once locations are in use (RB7), since every bill made would need one.
 */
async function resolveFor(tx: OrgTx, draft: DraftDetails, current?: RepeatingBill): Promise<ResolvedDraft> {
  const resolved = current
    ? await resolveDraft(tx, draft, keptValues(current.lines), keptCustom(current.customFields, ...current.lines.map((line) => line.customFields)), current.lines)
    : await resolveDraft(tx, draft);
  const stockLines = resolved.resolvedLines.flatMap((line, index) => (line.itemType === "stock" ? [{ line, index }] : []));
  if (stockLines.length > 0) {
    const ctx = await loadStockContext(tx, "repeating bills with stock items can't be saved");
    for (const { line, index } of stockLines) stockLocation(ctx, line.tracking, `Line ${index + 1}`, line.itemCode ?? "");
  }
  return resolved;
}

export async function getRepeatingBill(tx: OrgTx, idInput: unknown): Promise<RepeatingBill> {
  const id = requireId(idInput, "repeatingBillId");
  const found = await tx.query<Row>(`${SUMMARY_SQL} where r.id = $1`, [id]);
  const row = found.rows[0];
  if (!row) throw new NotFoundError("Repeating bill not found.");
  const runs = await tx.query<{
    id: string;
    scheduled_date: string;
    bill_id: string | null;
    supplier_invoice_number: string | null;
    bill_status: BillStatus | null;
    bill_deleted: boolean;
    outcome: RunOutcome;
    message: string | null;
    created_by_email: string | null;
    created_at: string;
  }>(
    `select x.id, x.scheduled_date, x.bill_id, b.supplier_invoice_number, b.status as bill_status, x.bill_deleted, x.outcome, x.message,
            x.created_by_email, x.created_at
       from repeating_bill_runs x left join bills b on b.id = x.bill_id
      where x.repeating_bill_id = $1 order by x.scheduled_date desc`,
    [id],
  );
  return {
    ...toSummary(row),
    lines: await loadPurchaseLines(tx, "repeating_bill_lines", id),
    runs: runs.rows.map((run) => ({
      id: run.id,
      scheduledDate: run.scheduled_date,
      billId: run.bill_id,
      supplierInvoiceNumber: run.supplier_invoice_number,
      billStatus: run.bill_status,
      billDeleted: run.bill_deleted,
      outcome: run.outcome,
      message: run.message,
      createdByEmail: run.created_by_email,
      createdAt: run.created_at,
    })),
  };
}

export async function listRepeatingBills(
  tx: OrgTx,
  filters: { status?: unknown; contactId?: unknown } = {},
): Promise<{ repeatingBills: RepeatingBillSummary[] }> {
  const status = filters.status == null || filters.status === "" ? null : requireOneOf(filters.status, "status", REPEATING_STATUSES);
  const contactId = optionalId(filters.contactId, "contactId");
  const found = await tx.query<Row>(
    `${SUMMARY_SQL} where ($1::text is null or r.status = $1) and ($2::bigint is null or r.contact_id = $2) order by r.id desc limit 500`,
    [status, contactId],
  );
  return { repeatingBills: found.rows.map(toSummary) };
}

/** Saves a new template (RB1). It starts active; nothing is made until the job runs. */
export async function createRepeatingBill(
  tx: OrgTx,
  input: RepeatingBillInput & { source?: unknown; idempotencyKey: unknown },
): Promise<{ created: boolean; repeatingBill: RepeatingBill }> {
  const source = optionalSource(input.source);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const parsed = parseTemplate(input);
  const hash = requestHash("repeating_bill", hashPayload(parsed));
  const existing = await tx.query<{ id: string; request_hash: string }>(
    "select id, request_hash from repeating_bills where command_source = $1 and idempotency_key = $2",
    [source, idempotencyKey],
  );
  if (existing.rows[0]) {
    assertSameRequest(existing.rows[0].request_hash, hash, "repeating bill");
    return { created: false, repeatingBill: await getRepeatingBill(tx, existing.rows[0].id) };
  }
  const resolved = await resolveFor(tx, parsed.draft);
  await checkDueRule(tx, parsed);
  const inserted = await tx.query<{ id: string }>(
    `insert into repeating_bills (command_source, idempotency_key, request_hash, contact_id, supplier_invoice_number, amounts_mode, currency_code,
                                  subtotal, tax_total, total, custom_fields, period, every, start_date, end_date,
                                  due_rule, due_days, save_as, created_by_user_id, created_by_email)
     values ($1, $2, $3, $4, $5, $6, $7, $8::numeric, $9::numeric, $10::numeric, $11::jsonb, $12, $13, $14, $15, $16, $17, $18, $19, $20)
     on conflict (command_source, idempotency_key) do nothing returning id`,
    [
      source,
      idempotencyKey,
      hash,
      resolved.contactId,
      resolved.supplierInvoiceNumber,
      resolved.amountsMode,
      resolved.currencyCode,
      resolved.subtotal,
      resolved.taxTotal,
      resolved.total,
      JSON.stringify(resolved.customFields),
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
  if (!id) throw new ConflictError("That repeating bill is being saved by another request. Try again.");
  await insertPurchaseLines(tx, "repeating_bill_lines", id, resolved.resolvedLines);
  await writeAuditEvent(tx, {
    eventType: "repeating_bill.created",
    entityType: "repeating_bill",
    entityId: id,
    details: { contactId: resolved.contactId, period: parsed.period, every: parsed.every, startDate: parsed.startDate, total: resolved.total },
  });
  return { created: true, repeatingBill: await getRepeatingBill(tx, id) };
}

/**
 * Changes a template (RB6). Bills already made keep what they had. If the
 * schedule (how often or the start date) changes, dates before today under
 * the new schedule aren't made.
 */
export async function updateRepeatingBill(tx: OrgTx, idInput: unknown, input: RepeatingBillInput, today = todayIsoDate()): Promise<RepeatingBill> {
  const current = await lockTemplate(tx, BILLS, requireId(idInput, "repeatingBillId"));
  assertNotEnded(BILLS, current);
  const saved = asSent(current);
  const merged = Object.fromEntries(
    (Object.keys(saved) as Array<keyof RepeatingBillInput>).map((key) => [key, input[key] === undefined ? saved[key] : input[key]]),
  ) as RepeatingBillInput;
  const parsed = parseTemplate(merged);
  const resolved = await resolveFor(tx, parsed.draft, current);
  await checkDueRule(tx, parsed);
  const { scheduleChanged, resumedFrom } = resumedAfterChange(current, parsed, today);
  await tx.query(
    `update repeating_bills
        set contact_id = $2, supplier_invoice_number = $3, amounts_mode = $4, currency_code = $5, subtotal = $6::numeric, tax_total = $7::numeric,
            total = $8::numeric, custom_fields = $9::jsonb, period = $10, every = $11, start_date = $12,
            end_date = $13, due_rule = $14, due_days = $15, save_as = $16, resumed_from = $17, updated_at = now()
      where id = $1`,
    [
      current.id,
      resolved.contactId,
      resolved.supplierInvoiceNumber,
      resolved.amountsMode,
      resolved.currencyCode,
      resolved.subtotal,
      resolved.taxTotal,
      resolved.total,
      JSON.stringify(resolved.customFields),
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
  await tx.query("delete from repeating_bill_lines where repeating_bill_id = $1", [current.id]);
  await insertPurchaseLines(tx, "repeating_bill_lines", current.id, resolved.resolvedLines);
  await writeAuditEvent(tx, {
    eventType: "repeating_bill.updated",
    entityType: "repeating_bill",
    entityId: current.id,
    details: { total: { from: current.total, to: resolved.total }, scheduleChanged },
  });
  return getRepeatingBill(tx, current.id);
}

/** Pauses, resumes or ends a template (RB8), with the same rules as repeating invoices. */
export async function setRepeatingBillStatus(tx: OrgTx, idInput: unknown, statusInput: unknown, today = todayIsoDate()): Promise<RepeatingBill> {
  return setTemplateStatus(tx, BILLS, requireId(idInput, "repeatingBillId"), statusInput, today);
}

/**
 * How the shared scheduler makes repeating bills (RB2-RB5, RB7): each date
 * gets a draft bill dated that day, due by the template's rule, with the
 * supplier invoice number from its pattern. A number the supplier already
 * has on another bill stops the template at that date (B5), since it may be
 * the same bill entered by hand. With "approve" the bill is approved as a
 * person would (period locks, required tracking and fields, stock).
 */
const BILLS: RepeatingKind<RepeatingBill> = {
  table: "repeating_bills",
  runsTable: "repeating_bill_runs",
  templateColumn: "repeating_bill_id",
  documentColumn: "bill_id",
  entityType: "repeating_bill",
  label: "repeating bill",
  documentNoun: "bill",
  actor: { userId: null, email: "repeating-bills@tohyee" },
  get: (tx, id) => getRepeatingBill(tx, id),
  async make(tx, template, date, sequence) {
    const dueDate =
      template.dueRule === "terms"
        ? await dueDateFromSupplierTerms(tx, template.contactId, date)
        : billDueDate(date, template.dueRule, template.dueDays);
    if (dueDate === null) {
      throw new ValidationError(`${template.contactName} no longer has payment terms, so the due date can't be worked out. Edit the template, or give the supplier payment terms.`);
    }
    const made = await createBill(tx, {
      source: "repeating",
      idempotencyKey: `repeating-bill-${template.id}-${date}`,
      contactId: template.contactId,
      billDate: date,
      dueDate,
      supplierInvoiceNumber: billNumberFor(template.supplierInvoiceNumber, date, sequence),
      amountsMode: template.amountsMode,
      lines: purchaseLinesAsSent(template.lines),
      customFields: template.customFields,
    });
    return made.bill.id;
  },
  async approve(tx, template, date, billId) {
    await approveBill(tx, billId, { source: "repeating", idempotencyKey: `repeating-bill-${template.id}-${date}-approve` });
    return null;
  },
};

/** How the shared scheduler makes repeating bills, for the hourly job. */
export const REPEATING_BILL_KIND = BILLS;

/** Makes the bills that are due, for each active template or just `repeatingBillId` (RB2-RB5). */
export async function runRepeatingBills(tx: OrgTx, options: { today?: string; repeatingBillId?: unknown } = {}): Promise<RunResult> {
  return runTemplates(tx, BILLS, { today: options.today, templateId: options.repeatingBillId, idField: "repeatingBillId" });
}

/** Active templates with a date that may be due by `today`. */
export async function listDueRepeatingBillIds(tx: OrgTx, today = todayIsoDate()): Promise<string[]> {
  return listDueTemplateIds(tx, BILLS, today);
}

/** Makes a template's due bills now ("Run now"), with the same code as the hourly job. */
export async function runRepeatingBillNow(tx: OrgTx, idInput: unknown): Promise<{ result: RunResult; repeatingBill: RepeatingBill }> {
  const id = requireId(idInput, "repeatingBillId");
  const result = await runRepeatingBills(tx, { repeatingBillId: id });
  return { result, repeatingBill: await getRepeatingBill(tx, id) };
}

/** The template and date that made a bill (RB2), if any. */
export async function repeatingForBill(tx: OrgTx, billId: string): Promise<{ id: string; scheduledDate: string } | null> {
  return templateForDocument(tx, BILLS, billId);
}
