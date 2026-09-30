import { parseAccountCodeInput } from "@/lib/accounts/service";
import { ACCOUNT_TYPES, type AccountType } from "@/lib/accounts/types";
import { writeAuditEvent } from "@/lib/audit";
import { type Role, roleAtLeast } from "@/lib/auth/roles";
import { dueDateFromTerms } from "@/lib/customers/service";
import { parseIsoDate, parseOptionalIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { assertSameRequest, requestHash } from "@/lib/idempotency";
import { createInvoice, getInvoice, type Invoice } from "@/lib/invoices/service";
import { add, cmp, dec, parseDecimalInput, sub, toFixedString, toPlainString, ZERO_DECIMAL, type Decimal } from "@/lib/money/decimal";
import { listMembers } from "@/lib/organisations/members";
import { personName } from "@/lib/people/names";
import {
  CHARGE_TYPES,
  chargeWithMarkup,
  type ChargeType,
  durationMinutes,
  timeAmount,
  timeInvoiceLine,
} from "@/lib/projects/amounts";
import { optionalBoolean, optionalId, optionalSource, optionalString, requireArray, requireId, requireIdempotencyKey, requireOneOf, requireString } from "@/lib/validation";

/**
 * Projects and time tracking (examples PJ1-PJ13), like Xero Projects. A
 * project is work for one customer, with tasks (hourly, fixed price or
 * non-chargeable), time entries in whole minutes and expenses linked from
 * approved bill lines, expense claim receipts and spend money lines. None of
 * it posts to the ledger. "Invoice" makes an ordinary draft sales invoice from
 * chosen unbilled items and links each item to it, so nothing is billed twice;
 * voiding the invoice or deleting the draft makes them unbilled again (the
 * database keeps all of this, see migration 0030). Profitability and the time
 * report are worked out from these tables whenever they're read.
 */

export const PROJECT_STATUSES = ["in_progress", "closed"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const EXPENSE_SOURCE_TYPES = ["bill_line", "expense_claim_receipt", "bank_transaction_line"] as const;
export type ExpenseSourceType = (typeof EXPENSE_SOURCE_TYPES)[number];

/** Where an invoiced item is: the invoice's number (or null for a draft), id and status. */
export type BilledOn = { invoiceId: string; invoiceNumber: string | null; invoiceStatus: "draft" | "approved" };

export type ProjectFigures = {
  /** Active time, in minutes. */
  minutes: number;
  timeCost: string;
  expenseCost: string;
  costs: string;
  /** Approved project invoices' totals excluding GST. */
  invoiced: string;
  onDraftInvoices: string;
  profit: string;
  unbilledTime: string;
  unbilledFixed: string;
  unbilledExpenses: string;
  unbilled: string;
  writtenOff: string;
  /** Invoiced, on draft invoices and unbilled together, to compare with the estimate. */
  toDate: string;
  /** The estimate less `toDate`, or null without an estimate. */
  estimateLeft: string | null;
};

export type ProjectSummary = {
  id: string;
  name: string;
  contactId: string;
  contactName: string;
  estimate: string | null;
  deadline: string | null;
  status: ProjectStatus;
  closedAt: string | null;
  closedByEmail: string | null;
  createdByEmail: string | null;
  createdAt: string;
  updatedAt: string;
  figures: ProjectFigures;
};

export type ProjectTask = {
  id: string;
  name: string;
  chargeType: ChargeType;
  /** The hourly rate or fixed price; null for non-chargeable tasks. */
  rate: string | null;
  estimateMinutes: number | null;
  status: "active" | "archived";
  writtenOffAt: string | null;
  /** Active time on the task. */
  minutes: number;
  /** Hourly tasks: time not invoiced or written off. */
  unbilledMinutes: number;
  /** What's still to invoice: unbilled time at the rate, or the fixed price. */
  unbilledAmount: string;
  /** Fixed price tasks: the invoice the price is on. */
  billedOn: BilledOn | null;
};

export type TimeEntry = {
  id: string;
  projectId: string;
  projectName: string;
  taskId: string;
  taskName: string;
  chargeType: ChargeType;
  userId: string;
  userEmail: string;
  entryDate: string;
  minutes: number;
  description: string | null;
  costRate: string;
  cost: string;
  status: "active" | "removed";
  writtenOffAt: string | null;
  billedOn: BilledOn | null;
  createdByEmail: string | null;
};

export type ProjectExpense = {
  id: string;
  sourceType: ExpenseSourceType;
  sourceLineId: string;
  /** The bill, expense claim or bank transaction. */
  documentId: string;
  documentLabel: string;
  contactName: string;
  date: string;
  description: string;
  accountCode: string;
  cost: string;
  chargeable: boolean;
  markupPercent: string;
  charge: string;
  status: "active" | "removed";
  writtenOffAt: string | null;
  billedOn: BilledOn | null;
};

export type ProjectInvoice = {
  invoiceId: string;
  invoiceNumber: string | null;
  status: "draft" | "approved" | "voided";
  invoiceDate: string;
  subtotal: string;
  total: string;
  createdByEmail: string | null;
  createdAt: string;
};

export type Project = ProjectSummary & {
  tasks: ProjectTask[];
  timeEntries: TimeEntry[];
  expenses: ProjectExpense[];
  invoices: ProjectInvoice[];
};

/** A line that can be put on a project (PJ4). */
export type ExpenseSource = {
  sourceType: ExpenseSourceType;
  lineId: string;
  documentId: string;
  documentLabel: string;
  contactName: string;
  date: string;
  description: string;
  accountCode: string;
  cost: string;
};

export type StaffRate = { userId: string; email: string; displayName: string; role: Role; costRate: string; updatedByEmail: string | null; updatedAt: string | null };

const MAX_ITEMS = 500;
const plain = (value: string) => toPlainString(dec(value));
const money = (value: Decimal) => toFixedString(value, 2);

// ---------------------------------------------------------------------------
// Staff cost rates (PJ3)

/** The organisation's members with their cost rate per hour (0.00 when not set). */
export async function listStaffRates(tx: OrgTx): Promise<StaffRate[]> {
  const members = await listMembers(tx.organisationId);
  const rates = await tx.query<{ user_id: string; cost_rate: string; updated_by_email: string | null; updated_at: string }>(
    "select user_id::text, cost_rate, updated_by_email, updated_at from project_staff_rates",
  );
  const byUser = new Map(rates.rows.map((row) => [row.user_id, row]));
  return members
    .filter((member) => member.isActive)
    .map((member) => {
      const rate = byUser.get(member.userId);
      return {
        userId: member.userId,
        email: member.email,
        displayName: member.displayName,
        role: member.role,
        costRate: rate ? money(dec(rate.cost_rate)) : "0.00",
        updatedByEmail: rate?.updated_by_email ?? null,
        updatedAt: rate?.updated_at ?? null,
      };
    });
}

async function requireMember(tx: OrgTx, userId: unknown, what = "userId"): Promise<{ userId: string; email: string }> {
  if (typeof userId !== "string" || !userId.trim()) throw new ValidationError(`${what} must be a member of the organisation.`);
  const members = await listMembers(tx.organisationId);
  const member = members.find((entry) => entry.userId === userId.trim());
  if (!member) throw new ValidationError(`${what} must be a member of the organisation.`);
  return { userId: member.userId, email: member.email };
}

/** Sets a member's cost rate per hour (admins; PJ3). Only time entered afterwards uses it. */
export async function setStaffRate(tx: OrgTx, role: Role, input: { userId: unknown; costRate: unknown }): Promise<StaffRate[]> {
  if (!roleAtLeast(role, "admin")) throw new ForbiddenError("Only admins can set staff cost rates.");
  const member = await requireMember(tx, input.userId);
  const costRate = parseDecimalInput(input.costRate, "costRate", { maxScale: 4, allowZero: true });
  const before = await tx.query<{ cost_rate: string }>("select cost_rate from project_staff_rates where user_id = $1 for update", [member.userId]);
  const from = before.rows[0] ? plain(before.rows[0].cost_rate) : "0";
  if (from !== plain(costRate)) {
    await tx.query(
      `insert into project_staff_rates (user_id, cost_rate, updated_by_email, updated_at) values ($1, $2::numeric, $3, now())
       on conflict (user_id) do update set cost_rate = excluded.cost_rate, updated_by_email = excluded.updated_by_email, updated_at = now()`,
      [member.userId, costRate, tx.actor.email],
    );
    await writeAuditEvent(tx, {
      eventType: "project.staff_rate_set",
      entityType: "project_staff_rate",
      entityId: member.userId,
      details: { email: member.email, costRate: { from, to: plain(costRate) } },
    });
  }
  return listStaffRates(tx);
}

async function costRateFor(tx: OrgTx, userId: string): Promise<string> {
  const rate = await tx.query<{ cost_rate: string }>("select cost_rate from project_staff_rates where user_id = $1", [userId]);
  return rate.rows[0] ? plain(rate.rows[0].cost_rate) : "0";
}

// ---------------------------------------------------------------------------
// Reading

type ProjectRow = {
  id: string;
  name: string;
  contact_id: string;
  contact_name: string;
  estimate: string | null;
  deadline: string | null;
  status: ProjectStatus;
  closed_at: string | null;
  closed_by_email: string | null;
  created_by_email: string | null;
  created_at: string;
  updated_at: string;
};

const PROJECT_COLUMNS = `p.id::text, p.name, p.contact_id::text, c.name as contact_name, p.estimate, p.deadline, p.status,
  p.closed_at, p.closed_by_email, p.created_by_email, p.created_at, p.updated_at`;

const BILLED_COLUMNS = (kind: string, id: string) => `(select s.id::text from sales_invoices s where s.id = tohyee_project_item_invoice('${kind}', ${id})) as billed_invoice_id,
  (select s.invoice_number from sales_invoices s where s.id = tohyee_project_item_invoice('${kind}', ${id})) as billed_invoice_number,
  (select s.status from sales_invoices s where s.id = tohyee_project_item_invoice('${kind}', ${id})) as billed_invoice_status`;

type BilledRow = { billed_invoice_id: string | null; billed_invoice_number: string | null; billed_invoice_status: "draft" | "approved" | null };

function billedOn(row: BilledRow): BilledOn | null {
  return row.billed_invoice_id
    ? { invoiceId: row.billed_invoice_id, invoiceNumber: row.billed_invoice_number, invoiceStatus: row.billed_invoice_status ?? "draft" }
    : null;
}

type TaskRow = BilledRow & {
  id: string;
  project_id: string;
  name: string;
  charge_type: ChargeType;
  rate: string | null;
  estimate_minutes: number | null;
  status: "active" | "archived";
  written_off_at: string | null;
};

type EntryRow = BilledRow & {
  id: string;
  project_id: string;
  project_name: string;
  task_id: string;
  task_name: string;
  charge_type: ChargeType;
  rate: string | null;
  user_id: string;
  user_email: string;
  entry_date: string;
  minutes: number;
  description: string | null;
  cost_rate: string;
  status: "active" | "removed";
  written_off_at: string | null;
  created_by_email: string | null;
};

type ExpenseRow = BilledRow & {
  id: string;
  project_id: string;
  source_type: ExpenseSourceType;
  line_id: string;
  document_id: string;
  document_label: string;
  contact_name: string;
  date: string;
  description: string;
  account_code: string;
  cost: string;
  chargeable: boolean;
  markup_percent: string;
  status: "active" | "removed";
  written_off_at: string | null;
};

type InvoiceRow = {
  project_id: string;
  invoice_id: string;
  invoice_number: string | null;
  status: "draft" | "approved" | "voided";
  invoice_date: string;
  subtotal: string;
  total: string;
  created_by_email: string | null;
  created_at: string;
};

/**
 * A source line's document, e.g. "Bill PS-300", or "Expense claim CLAIM-3
 * (Aroha Ngata)" with the claimant's name (their email if they can't be found).
 */
function sourceLabel(tx: OrgTx, row: { document_label: string; person_email: string | null }): string {
  return row.person_email ? `${row.document_label} (${personName(tx, row.person_email)})` : row.document_label;
}

/** Every line that can be (or is) a project expense, with its document. */
const SOURCES = `(
  select 'bill_line'::text as source_type, l.id as line_id, b.id as document_id,
         'Bill ' || b.supplier_invoice_number as document_label, c.name as contact_name, b.bill_date as date,
         l.description, a.code as account_code, a.name as account_name, a.account_type, a.account_class, l.net_amount,
         b.status = 'approved' as usable,
         null::text as person_email
    from bill_lines l join bills b on b.id = l.bill_id join contacts c on c.id = b.contact_id join accounts a on a.id = l.account_id
  union all
  select 'expense_claim_receipt', r.id, x.id, 'Expense claim CLAIM-' || x.id, r.supplier_name,
         r.receipt_date, r.description, a.code, a.name, a.account_type, a.account_class, r.net_amount, x.status = 'approved', x.claimant_email
    from expense_claim_receipts r join expense_claims x on x.id = r.claim_id join accounts a on a.id = r.account_id
  union all
  select 'bank_transaction_line', l.id, t.id, 'Spend money' || coalesce(' ' || t.reference, ''), c.name, t.transaction_date,
         l.description, a.code, a.name, a.account_type, a.account_class, coalesce(l.base_net_amount, l.net_amount), t.kind = 'spend' and t.status = 'posted', null
    from bank_transaction_lines l join bank_transactions t on t.id = l.bank_transaction_id
    join contacts c on c.id = t.contact_id join accounts a on a.id = l.account_id
)`;

async function loadTasks(tx: OrgTx, projectIds: string[]): Promise<TaskRow[]> {
  const result = await tx.query<TaskRow>(
    `select t.id::text, t.project_id::text, t.name, t.charge_type, t.rate, t.estimate_minutes, t.status, t.written_off_at,
            ${BILLED_COLUMNS("fixed_task", "t.id")}
       from project_tasks t where t.project_id = any($1::bigint[]) order by t.id`,
    [projectIds],
  );
  return result.rows;
}

async function loadEntries(tx: OrgTx, where: string, values: unknown[]): Promise<EntryRow[]> {
  const result = await tx.query<EntryRow>(
    `select e.id::text, e.project_id::text, p.name as project_name, e.task_id::text, t.name as task_name, t.charge_type, t.rate,
            e.user_id::text, e.user_email, e.entry_date, e.minutes, e.description, e.cost_rate, e.status, e.written_off_at,
            e.created_by_email, ${BILLED_COLUMNS("time", "e.id")}
       from project_time_entries e join project_tasks t on t.id = e.task_id join projects p on p.id = e.project_id
      where ${where}
      order by e.entry_date, e.id`,
    values,
  );
  return result.rows;
}

async function loadExpenses(tx: OrgTx, projectIds: string[]): Promise<ExpenseRow[]> {
  const result = await tx.query<ExpenseRow & { person_email: string | null }>(
    `select x.id::text, x.project_id::text, x.source_type, src.line_id::text, src.document_id::text, src.document_label, src.person_email, src.contact_name,
            src.date, src.description, src.account_code, x.cost, x.chargeable, x.markup_percent, x.status, x.written_off_at,
            ${BILLED_COLUMNS("expense", "x.id")}
       from project_expenses x
       join ${SOURCES} src on src.source_type = x.source_type
        and src.line_id = coalesce(x.bill_line_id, x.expense_claim_receipt_id, x.bank_transaction_line_id)
      where x.project_id = any($1::bigint[])
      order by x.id`,
    [projectIds],
  );
  return result.rows.map(({ person_email, ...row }) => ({ ...row, document_label: sourceLabel(tx, { document_label: row.document_label, person_email }) }));
}

async function loadInvoices(tx: OrgTx, projectIds: string[]): Promise<InvoiceRow[]> {
  const result = await tx.query<InvoiceRow>(
    `select pi.project_id::text, s.id::text as invoice_id, s.invoice_number, s.status, s.invoice_date, s.subtotal, s.total,
            pi.created_by_email, pi.created_at
       from project_invoices pi join sales_invoices s on s.id = pi.invoice_id
      where pi.project_id = any($1::bigint[])
      order by s.id`,
    [projectIds],
  );
  return result.rows;
}

function toEntry(row: EntryRow): TimeEntry {
  return {
    id: row.id,
    projectId: row.project_id,
    projectName: row.project_name,
    taskId: row.task_id,
    taskName: row.task_name,
    chargeType: row.charge_type,
    userId: row.user_id,
    userEmail: row.user_email,
    entryDate: row.entry_date,
    minutes: row.minutes,
    description: row.description,
    costRate: money(dec(row.cost_rate)),
    cost: timeAmount(row.minutes, row.cost_rate),
    status: row.status,
    writtenOffAt: row.written_off_at,
    billedOn: billedOn(row),
    createdByEmail: row.created_by_email,
  };
}

function toExpense(row: ExpenseRow): ProjectExpense {
  return {
    id: row.id,
    sourceType: row.source_type,
    sourceLineId: row.line_id,
    documentId: row.document_id,
    documentLabel: row.document_label,
    contactName: row.contact_name,
    date: row.date,
    description: row.description,
    accountCode: row.account_code,
    cost: money(dec(row.cost)),
    chargeable: row.chargeable,
    markupPercent: plain(row.markup_percent),
    charge: row.chargeable ? chargeWithMarkup(row.cost, row.markup_percent) : "0.00",
    status: row.status,
    writtenOffAt: row.written_off_at,
    billedOn: billedOn(row),
  };
}

const sumOf = (values: Iterable<string>) => {
  let total = ZERO_DECIMAL;
  for (const value of values) total = add(total, dec(value));
  return total;
};

/** Profitability figures for one project (PJ5, PJ9), from its tasks, active time, active expenses and invoices. */
function figuresFor(
  estimate: string | null,
  tasks: TaskRow[],
  entries: EntryRow[],
  expenses: ExpenseRow[],
  invoices: InvoiceRow[],
): { figures: ProjectFigures; tasks: ProjectTask[] } {
  const active = entries.filter((entry) => entry.status === "active");
  const timeCost = sumOf(active.map((entry) => timeAmount(entry.minutes, entry.cost_rate)));
  const liveExpenses = expenses.filter((expense) => expense.status === "active");
  const expenseCost = sumOf(liveExpenses.map((expense) => expense.cost));
  const invoiced = sumOf(invoices.filter((invoice) => invoice.status === "approved").map((invoice) => invoice.subtotal));
  const onDraft = sumOf(invoices.filter((invoice) => invoice.status === "draft").map((invoice) => invoice.subtotal));

  let unbilledTime = ZERO_DECIMAL;
  let unbilledFixed = ZERO_DECIMAL;
  let writtenOff = ZERO_DECIMAL;
  const taskViews: ProjectTask[] = tasks.map((task) => {
    const onTask = active.filter((entry) => entry.task_id === task.id);
    const minutes = onTask.reduce((total, entry) => total + entry.minutes, 0);
    let unbilledMinutes = 0;
    let unbilledAmount = "0.00";
    if (task.charge_type === "hourly" && task.rate) {
      unbilledMinutes = onTask.filter((entry) => !entry.billed_invoice_id && !entry.written_off_at).reduce((total, entry) => total + entry.minutes, 0);
      const offMinutes = onTask.filter((entry) => !entry.billed_invoice_id && entry.written_off_at).reduce((total, entry) => total + entry.minutes, 0);
      unbilledAmount = timeAmount(unbilledMinutes, task.rate);
      unbilledTime = add(unbilledTime, dec(unbilledAmount));
      writtenOff = add(writtenOff, dec(timeAmount(offMinutes, task.rate)));
    }
    if (task.charge_type === "fixed" && task.rate && !task.billed_invoice_id) {
      if (task.written_off_at) {
        writtenOff = add(writtenOff, dec(task.rate));
      } else if (task.status === "active") {
        unbilledAmount = money(dec(task.rate));
        unbilledFixed = add(unbilledFixed, dec(task.rate));
      }
    }
    return {
      id: task.id,
      name: task.name,
      chargeType: task.charge_type,
      rate: task.rate === null ? null : task.charge_type === "fixed" ? money(dec(task.rate)) : plain(task.rate),
      estimateMinutes: task.estimate_minutes,
      status: task.status,
      writtenOffAt: task.written_off_at,
      minutes,
      unbilledMinutes,
      unbilledAmount,
      billedOn: task.charge_type === "fixed" ? billedOn(task) : null,
    };
  });
  let unbilledExpenses = ZERO_DECIMAL;
  for (const expense of liveExpenses) {
    if (!expense.chargeable || expense.billed_invoice_id) continue;
    const charge = dec(chargeWithMarkup(expense.cost, expense.markup_percent));
    if (expense.written_off_at) writtenOff = add(writtenOff, charge);
    else unbilledExpenses = add(unbilledExpenses, charge);
  }
  const costs = add(timeCost, expenseCost);
  const unbilled = add(add(unbilledTime, unbilledFixed), unbilledExpenses);
  const toDate = add(add(invoiced, onDraft), unbilled);
  return {
    figures: {
      minutes: active.reduce((total, entry) => total + entry.minutes, 0),
      timeCost: money(timeCost),
      expenseCost: money(expenseCost),
      costs: money(costs),
      invoiced: money(invoiced),
      onDraftInvoices: money(onDraft),
      profit: money(sub(invoiced, costs)),
      unbilledTime: money(unbilledTime),
      unbilledFixed: money(unbilledFixed),
      unbilledExpenses: money(unbilledExpenses),
      unbilled: money(unbilled),
      writtenOff: money(writtenOff),
      toDate: money(toDate),
      estimateLeft: estimate === null ? null : money(sub(dec(estimate), toDate)),
    },
    tasks: taskViews,
  };
}

function toSummary(row: ProjectRow, figures: ProjectFigures): ProjectSummary {
  return {
    id: row.id,
    name: row.name,
    contactId: row.contact_id,
    contactName: row.contact_name,
    estimate: row.estimate === null ? null : money(dec(row.estimate)),
    deadline: row.deadline,
    status: row.status,
    closedAt: row.closed_at,
    closedByEmail: row.closed_by_email,
    createdByEmail: row.created_by_email,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    figures,
  };
}

/** Projects with their figures, newest first; `status` and `contactId` filter them. */
export async function listProjects(tx: OrgTx, filters: { status?: unknown; contactId?: unknown } = {}): Promise<ProjectSummary[]> {
  const status = filters.status == null || filters.status === "" ? null : requireOneOf(filters.status, "status", PROJECT_STATUSES);
  const contactId = optionalId(filters.contactId, "contactId");
  const rows = await tx.query<ProjectRow>(
    `select ${PROJECT_COLUMNS} from projects p join contacts c on c.id = p.contact_id
      where ($1::text is null or p.status = $1) and ($2::bigint is null or p.contact_id = $2)
      order by p.id desc limit 500`,
    [status, contactId],
  );
  const ids = rows.rows.map((row) => row.id);
  if (ids.length === 0) return [];
  const tasks = await loadTasks(tx, ids);
  const entries = await loadEntries(tx, "e.project_id = any($1::bigint[]) and e.status = 'active'", [ids]);
  const expenses = await loadExpenses(tx, ids);
  const invoices = await loadInvoices(tx, ids);
  const of = <T extends { project_id: string }>(list: T[], id: string) => list.filter((entry) => entry.project_id === id);
  return rows.rows.map((row) =>
    toSummary(row, figuresFor(row.estimate, of(tasks, row.id), of(entries, row.id), of(expenses, row.id), of(invoices, row.id)).figures),
  );
}

export async function getProject(tx: OrgTx, idInput: unknown): Promise<Project> {
  const id = requireId(idInput, "projectId");
  const row = (await tx.query<ProjectRow>(`select ${PROJECT_COLUMNS} from projects p join contacts c on c.id = p.contact_id where p.id = $1`, [id])).rows[0];
  if (!row) throw new NotFoundError("Project not found.");
  const tasks = await loadTasks(tx, [id]);
  const entries = await loadEntries(tx, "e.project_id = $1", [id]);
  const expenses = await loadExpenses(tx, [id]);
  const invoices = await loadInvoices(tx, [id]);
  const { figures, tasks: taskViews } = figuresFor(row.estimate, tasks, entries, expenses, invoices);
  return {
    ...toSummary(row, figures),
    tasks: taskViews,
    timeEntries: entries.map(toEntry),
    expenses: expenses.map(toExpense),
    invoices: invoices.map((invoice) => ({
      invoiceId: invoice.invoice_id,
      invoiceNumber: invoice.invoice_number,
      status: invoice.status,
      invoiceDate: invoice.invoice_date,
      subtotal: invoice.subtotal,
      total: invoice.total,
      createdByEmail: invoice.created_by_email,
      createdAt: invoice.created_at,
    })),
  };
}

/** Locks a project row until the transaction ends, so commands on one project run one at a time. */
async function lockProject(tx: OrgTx, id: string): Promise<{ id: string; name: string; status: ProjectStatus; contact_id: string }> {
  const result = await tx.query<{ id: string; name: string; status: ProjectStatus; contact_id: string }>(
    "select id::text, name, status, contact_id::text from projects where id = $1 for update",
    [id],
  );
  if (!result.rows[0]) throw new NotFoundError("Project not found.");
  return result.rows[0];
}

function assertOpen(project: { name: string; status: ProjectStatus }): void {
  if (project.status === "closed") throw new ConflictError(`Project ${project.name} is closed. Reopen it first.`);
}

// ---------------------------------------------------------------------------
// Projects (PJ1)

type ProjectDetails = { name: string; contactId: string; estimate: string | null; deadline: string | null };

function parseProject(input: { name?: unknown; contactId?: unknown; estimate?: unknown; deadline?: unknown }): ProjectDetails {
  const estimateInput = input.estimate;
  return {
    name: requireString(input.name, "name", { maxLength: 200 }),
    contactId: requireId(input.contactId, "contactId"),
    estimate:
      estimateInput == null || (typeof estimateInput === "string" && !estimateInput.trim())
        ? null
        : parseDecimalInput(estimateInput, "estimate", { maxScale: 2, allowZero: true }),
    deadline: parseOptionalIsoDate(input.deadline, "deadline"),
  };
}

async function requireCustomer(tx: OrgTx, contactId: string): Promise<string> {
  const contact = (await tx.query<{ name: string; is_customer: boolean; is_archived: boolean }>("select name, is_customer, is_archived from contacts where id = $1", [contactId])).rows[0];
  if (!contact) throw new ValidationError(`There's no contact #${contactId}.`);
  if (contact.is_archived) throw new ValidationError(`${contact.name} is archived. Unarchive them first, or pick another customer.`);
  if (!contact.is_customer) throw new ValidationError(`${contact.name} isn't marked as a customer. Edit the contact first, or pick another one.`);
  return contact.name;
}

/** Starts a project for a customer (PJ1). It posts nothing and starts in progress. */
export async function createProject(
  tx: OrgTx,
  input: { source?: unknown; idempotencyKey: unknown; name?: unknown; contactId?: unknown; estimate?: unknown; deadline?: unknown },
): Promise<{ created: boolean; project: Project }> {
  const source = optionalSource(input.source);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const details = parseProject(input);
  const hash = requestHash("project", { ...details, estimate: details.estimate === null ? null : plain(details.estimate) });
  const find = async () =>
    (await tx.query<{ id: string; request_hash: string }>("select id::text, request_hash from projects where command_source = $1 and idempotency_key = $2", [source, idempotencyKey])).rows[0];
  const existing = await find();
  if (existing) {
    assertSameRequest(existing.request_hash, hash, "project");
    return { created: false, project: await getProject(tx, existing.id) };
  }
  await requireCustomer(tx, details.contactId);
  const inserted = await tx.query<{ id: string }>(
    `insert into projects (command_source, idempotency_key, request_hash, contact_id, name, estimate, deadline, created_by_user_id, created_by_email)
     values ($1, $2, $3, $4, $5, $6::numeric, $7, $8, $9)
     on conflict (command_source, idempotency_key) do nothing returning id::text`,
    [source, idempotencyKey, hash, details.contactId, details.name, details.estimate, details.deadline, tx.actor.userId, tx.actor.email],
  );
  const id = inserted.rows[0]?.id;
  if (!id) {
    const winner = await find();
    if (!winner) throw new ConflictError("That project is being saved by another request. Try again.");
    assertSameRequest(winner.request_hash, hash, "project");
    return { created: false, project: await getProject(tx, winner.id) };
  }
  await writeAuditEvent(tx, { eventType: "project.created", entityType: "project", entityId: id, details: { ...details } });
  return { created: true, project: await getProject(tx, id) };
}

/** Changes a project's name, customer (only before any invoice), estimate or deadline. Not its status. */
export async function updateProject(
  tx: OrgTx,
  idInput: unknown,
  input: { name?: unknown; contactId?: unknown; estimate?: unknown; deadline?: unknown },
): Promise<Project> {
  const id = requireId(idInput, "projectId");
  const locked = await lockProject(tx, id);
  assertOpen(locked);
  const current = await getProject(tx, id);
  const details = parseProject({
    name: input.name === undefined ? current.name : input.name,
    contactId: input.contactId === undefined ? current.contactId : input.contactId,
    estimate: input.estimate === undefined ? current.estimate : input.estimate,
    deadline: input.deadline === undefined ? current.deadline : input.deadline,
  });
  if (details.contactId !== current.contactId) {
    if (current.invoices.length > 0) throw new ConflictError(`Project ${current.name} has invoices, so its customer can't change.`);
    await requireCustomer(tx, details.contactId);
  }
  const before = { name: current.name, contactId: current.contactId, estimate: current.estimate, deadline: current.deadline };
  const after = { ...details, estimate: details.estimate === null ? null : money(dec(details.estimate)) };
  if (JSON.stringify(before) === JSON.stringify(after)) return current;
  await tx.query("update projects set name = $2, contact_id = $3, estimate = $4::numeric, deadline = $5, updated_at = now() where id = $1", [
    id,
    details.name,
    details.contactId,
    details.estimate,
    details.deadline,
  ]);
  await writeAuditEvent(tx, { eventType: "project.updated", entityType: "project", entityId: id, details: { before, after } });
  return getProject(tx, id);
}

// ---------------------------------------------------------------------------
// Tasks (PJ2)

type TaskDetails = { name: string; chargeType: ChargeType; rate: string | null; estimateMinutes: number | null };

function parseTask(input: { name?: unknown; chargeType?: unknown; rate?: unknown; estimateHours?: unknown; estimateMinutes?: unknown }): TaskDetails {
  const name = requireString(input.name, "name", { maxLength: 200 });
  const chargeType = requireOneOf(input.chargeType, "chargeType", CHARGE_TYPES);
  const blank = (value: unknown) => value == null || (typeof value === "string" && !value.trim());
  let rate: string | null = null;
  if (chargeType === "non_chargeable") {
    if (!blank(input.rate)) throw new ValidationError("A non-chargeable task has no rate.");
  } else {
    if (blank(input.rate)) throw new ValidationError(chargeType === "hourly" ? "An hourly task needs its rate per hour." : "A fixed price task needs its price.");
    rate = parseDecimalInput(input.rate, chargeType === "hourly" ? "rate" : "price", { maxScale: chargeType === "fixed" ? 2 : 4 });
    if (cmp(dec(rate), ZERO_DECIMAL) <= 0) throw new ValidationError(chargeType === "hourly" ? "The rate must be more than 0." : "The price must be more than 0.");
  }
  const estimateMinutes = blank(input.estimateHours) && blank(input.estimateMinutes) ? null : durationMinutes(input.estimateHours, input.estimateMinutes, "The estimate", 1_000_000);
  return { name, chargeType, rate, estimateMinutes };
}

async function lockTask(tx: OrgTx, taskIdInput: unknown): Promise<TaskRow & { project_status: ProjectStatus; project_name: string }> {
  const taskId = requireId(taskIdInput, "taskId");
  const found = await tx.query<{ project_id: string }>("select project_id::text from project_tasks where id = $1", [taskId]);
  if (!found.rows[0]) throw new NotFoundError("Task not found.");
  const project = await lockProject(tx, found.rows[0].project_id);
  const task = (await loadTasks(tx, [project.id])).find((row) => row.id === taskId)!;
  return { ...task, project_status: project.status, project_name: project.name };
}

/** Adds a task to a project (PJ2). */
export async function createTask(
  tx: OrgTx,
  projectIdInput: unknown,
  input: { source?: unknown; idempotencyKey: unknown; name?: unknown; chargeType?: unknown; rate?: unknown; estimateHours?: unknown; estimateMinutes?: unknown },
): Promise<{ created: boolean; project: Project; taskId: string }> {
  const projectId = requireId(projectIdInput, "projectId");
  const source = optionalSource(input.source);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const details = parseTask(input);
  const hash = requestHash("project_task", { projectId, ...details, rate: details.rate === null ? null : plain(details.rate) });
  const find = async () =>
    (await tx.query<{ id: string; request_hash: string }>("select id::text, request_hash from project_tasks where command_source = $1 and idempotency_key = $2", [source, idempotencyKey])).rows[0];
  const project = await lockProject(tx, projectId);
  const existing = await find();
  if (existing) {
    assertSameRequest(existing.request_hash, hash, "task");
    return { created: false, project: await getProject(tx, projectId), taskId: existing.id };
  }
  assertOpen(project);
  await assertUniqueTaskName(tx, projectId, details.name, null);
  const inserted = await tx.query<{ id: string }>(
    `insert into project_tasks (command_source, idempotency_key, request_hash, project_id, name, charge_type, rate, estimate_minutes)
     values ($1, $2, $3, $4, $5, $6, $7::numeric, $8) returning id::text`,
    [source, idempotencyKey, hash, projectId, details.name, details.chargeType, details.rate, details.estimateMinutes],
  );
  const taskId = inserted.rows[0].id;
  await writeAuditEvent(tx, { eventType: "project.task_created", entityType: "project", entityId: projectId, details: { taskId, ...details } });
  return { created: true, project: await getProject(tx, projectId), taskId };
}

async function assertUniqueTaskName(tx: OrgTx, projectId: string, name: string, exceptId: string | null): Promise<void> {
  const clash = await tx.query(
    "select 1 from project_tasks where project_id = $1 and lower(name) = lower($2) and status = 'active' and ($3::bigint is null or id <> $3)",
    [projectId, name, exceptId],
  );
  if (clash.rowCount) throw new ConflictError(`This project already has a task called ${name}.`);
}

/** Changes a task. Its charge type, and a fixed price, can't change once something of it is invoiced (PJ2). */
export async function updateTask(
  tx: OrgTx,
  taskIdInput: unknown,
  input: { name?: unknown; chargeType?: unknown; rate?: unknown; estimateHours?: unknown; estimateMinutes?: unknown },
): Promise<Project> {
  const task = await lockTask(tx, taskIdInput);
  assertOpen({ name: task.project_name, status: task.project_status });
  if (task.status === "archived") throw new ConflictError(`Task ${task.name} is archived.`);
  const keepEstimate = input.estimateHours === undefined && input.estimateMinutes === undefined;
  const details = parseTask({
    name: input.name === undefined ? task.name : input.name,
    chargeType: input.chargeType === undefined ? task.charge_type : input.chargeType,
    rate: input.rate === undefined ? task.rate : input.rate,
    estimateHours: keepEstimate ? null : input.estimateHours,
    estimateMinutes: keepEstimate ? task.estimate_minutes : input.estimateMinutes,
  });
  if (details.name.toLowerCase() !== task.name.toLowerCase()) await assertUniqueTaskName(tx, task.project_id, details.name, task.id);
  const billed = (await tx.query<{ billed: boolean }>("select tohyee_project_task_billed($1) as billed", [task.id])).rows[0].billed;
  const rateChanged = (details.rate === null ? null : plain(details.rate)) !== (task.rate === null ? null : plain(task.rate));
  if (billed && (details.chargeType !== task.charge_type || (task.charge_type === "fixed" && rateChanged))) {
    throw new ConflictError(`Task ${task.name} has been invoiced, so its charge type and fixed price can't change.`);
  }
  await tx.query("update project_tasks set name = $2, charge_type = $3, rate = $4::numeric, estimate_minutes = $5, updated_at = now() where id = $1", [
    task.id,
    details.name,
    details.chargeType,
    details.rate,
    details.estimateMinutes,
  ]);
  await writeAuditEvent(tx, {
    eventType: "project.task_updated",
    entityType: "project",
    entityId: task.project_id,
    details: { taskId: task.id, before: { name: task.name, chargeType: task.charge_type, rate: task.rate, estimateMinutes: task.estimate_minutes }, after: details },
  });
  return getProject(tx, task.project_id);
}

/** Archives a task (tasks are never deleted): no more time goes on it; its time still counts (PJ2). */
export async function archiveTask(tx: OrgTx, taskIdInput: unknown): Promise<Project> {
  const task = await lockTask(tx, taskIdInput);
  assertOpen({ name: task.project_name, status: task.project_status });
  if (task.status !== "archived") {
    await tx.query("update project_tasks set status = 'archived', updated_at = now() where id = $1", [task.id]);
    await writeAuditEvent(tx, { eventType: "project.task_archived", entityType: "project", entityId: task.project_id, details: { taskId: task.id, name: task.name } });
  }
  return getProject(tx, task.project_id);
}

// ---------------------------------------------------------------------------
// Time (PJ3)

type TimeDetails = { taskId: string; entryDate: string; minutes: number; description: string | null };

function parseTime(input: { taskId?: unknown; entryDate?: unknown; hours?: unknown; minutes?: unknown; description?: unknown }): TimeDetails {
  return {
    taskId: requireId(input.taskId, "taskId"),
    entryDate: parseIsoDate(input.entryDate, "entryDate"),
    minutes: durationMinutes(input.hours, input.minutes),
    description: optionalString(input.description, "description", { maxLength: 500 }),
  };
}

async function assertTaskOnProject(tx: OrgTx, projectId: string, taskId: string): Promise<void> {
  const task = (await tx.query<{ project_id: string; status: string; name: string }>("select project_id::text, status, name from project_tasks where id = $1", [taskId])).rows[0];
  if (!task || task.project_id !== projectId) throw new ValidationError("That task isn't on this project.");
  if (task.status !== "active") throw new ConflictError(`Task ${task.name} is archived, so no more time can go on it.`);
}

/**
 * Records time on a project (PJ3): whole minutes, the signed-in member's own
 * unless an admin or owner names another member. The member's staff cost rate
 * is copied onto the entry. Posts nothing.
 */
export async function createTimeEntry(
  tx: OrgTx,
  role: Role,
  projectIdInput: unknown,
  input: { source?: unknown; idempotencyKey: unknown; userId?: unknown; taskId?: unknown; entryDate?: unknown; hours?: unknown; minutes?: unknown; description?: unknown },
): Promise<{ created: boolean; entry: TimeEntry }> {
  const projectId = requireId(projectIdInput, "projectId");
  const source = optionalSource(input.source);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const details = parseTime(input);
  if (!tx.actor.userId) throw new ForbiddenError("Time is recorded by a signed-in member.");
  const forSomeoneElse = input.userId != null && input.userId !== "" && input.userId !== tx.actor.userId;
  const userId = forSomeoneElse ? String(input.userId) : tx.actor.userId;
  const hash = requestHash("project_time", { projectId, userId, ...details });
  const find = async () =>
    (await tx.query<{ id: string; request_hash: string }>("select id::text, request_hash from project_time_entries where command_source = $1 and idempotency_key = $2", [source, idempotencyKey])).rows[0];
  const existing = await find();
  if (existing) {
    assertSameRequest(existing.request_hash, hash, "time entry");
    return { created: false, entry: await getTimeEntry(tx, existing.id) };
  }
  let person = { userId: tx.actor.userId, email: tx.actor.email };
  if (forSomeoneElse) {
    if (!roleAtLeast(role, "admin")) throw new ForbiddenError("Only admins can record time for someone else.");
    person = await requireMember(tx, userId);
  }
  const project = await lockProject(tx, projectId);
  assertOpen(project);
  await assertTaskOnProject(tx, projectId, details.taskId);
  const costRate = await costRateFor(tx, person.userId);
  const inserted = await tx.query<{ id: string }>(
    `insert into project_time_entries (command_source, idempotency_key, request_hash, project_id, task_id, user_id, user_email, entry_date,
                                       minutes, description, cost_rate, created_by_user_id, created_by_email)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::numeric, $12, $13) returning id::text`,
    [source, idempotencyKey, hash, projectId, details.taskId, person.userId, person.email, details.entryDate, details.minutes, details.description, costRate, tx.actor.userId, tx.actor.email],
  );
  const id = inserted.rows[0].id;
  await writeAuditEvent(tx, {
    eventType: "project.time_recorded",
    entityType: "project",
    entityId: projectId,
    details: { timeEntryId: id, userEmail: person.email, ...details, costRate },
  });
  return { created: true, entry: await getTimeEntry(tx, id) };
}

export async function getTimeEntry(tx: OrgTx, idInput: unknown): Promise<TimeEntry> {
  const id = requireId(idInput, "timeEntryId");
  const row = (await loadEntries(tx, "e.id = $1", [id]))[0];
  if (!row) throw new NotFoundError("Time entry not found.");
  return toEntry(row);
}

async function lockEntryForChange(tx: OrgTx, role: Role, idInput: unknown): Promise<TimeEntry> {
  const id = requireId(idInput, "timeEntryId");
  const found = await tx.query<{ project_id: string }>("select project_id::text from project_time_entries where id = $1", [id]);
  if (!found.rows[0]) throw new NotFoundError("Time entry not found.");
  const project = await lockProject(tx, found.rows[0].project_id);
  const entry = await getTimeEntry(tx, id);
  if (entry.userId !== tx.actor.userId && !roleAtLeast(role, "admin")) {
    throw new ForbiddenError(`Only ${personName(tx, entry.userEmail)} or an admin can change this time entry.`);
  }
  assertOpen(project);
  if (entry.status === "removed") throw new ConflictError("This time entry has been removed.");
  if (entry.writtenOffAt) throw new ConflictError("This time entry has been written off and can't change.");
  if (entry.billedOn) {
    throw new ConflictError(`This time entry is on ${invoiceLabel(entry.billedOn)}, so it can't change. Void or delete the invoice first.`);
  }
  return entry;
}

function invoiceLabel(billed: BilledOn): string {
  return billed.invoiceNumber ? `invoice ${billed.invoiceNumber}` : `draft invoice #${billed.invoiceId}`;
}

/** Changes an unbilled time entry: its task, date, duration or description (PJ8). */
export async function updateTimeEntry(
  tx: OrgTx,
  role: Role,
  idInput: unknown,
  input: { taskId?: unknown; entryDate?: unknown; hours?: unknown; minutes?: unknown; description?: unknown },
): Promise<TimeEntry> {
  const entry = await lockEntryForChange(tx, role, idInput);
  const keepDuration = input.hours === undefined && input.minutes === undefined;
  const details = parseTime({
    taskId: input.taskId === undefined ? entry.taskId : input.taskId,
    entryDate: input.entryDate === undefined ? entry.entryDate : input.entryDate,
    hours: keepDuration ? 0 : input.hours,
    minutes: keepDuration ? entry.minutes : input.minutes,
    description: input.description === undefined ? entry.description : input.description,
  });
  if (details.taskId !== entry.taskId) await assertTaskOnProject(tx, entry.projectId, details.taskId);
  const before = { taskId: entry.taskId, entryDate: entry.entryDate, minutes: entry.minutes, description: entry.description };
  if (JSON.stringify(before) === JSON.stringify(details)) return entry;
  await tx.query("update project_time_entries set task_id = $2, entry_date = $3, minutes = $4, description = $5, updated_at = now() where id = $1", [
    entry.id,
    details.taskId,
    details.entryDate,
    details.minutes,
    details.description,
  ]);
  await writeAuditEvent(tx, { eventType: "project.time_updated", entityType: "project", entityId: entry.projectId, details: { timeEntryId: entry.id, before, after: details } });
  return getTimeEntry(tx, entry.id);
}

/** Removes an unbilled time entry (it's kept, marked removed, and no longer counts). */
export async function removeTimeEntry(tx: OrgTx, role: Role, idInput: unknown): Promise<TimeEntry> {
  const entry = await lockEntryForChange(tx, role, idInput);
  await tx.query("update project_time_entries set status = 'removed', removed_at = now(), removed_by_email = $2, updated_at = now() where id = $1", [entry.id, tx.actor.email]);
  await writeAuditEvent(tx, {
    eventType: "project.time_removed",
    entityType: "project",
    entityId: entry.projectId,
    details: { timeEntryId: entry.id, userEmail: entry.userEmail, entryDate: entry.entryDate, minutes: entry.minutes, taskId: entry.taskId },
  });
  return getTimeEntry(tx, entry.id);
}

// ---------------------------------------------------------------------------
// Expenses (PJ4)

/**
 * Lines that can go on a project: approved bills and claims, posted spend
 * money, coded to a profit and loss cost account (PJ13), not already on a project.
 */
export async function listExpenseSources(tx: OrgTx, filters: { search?: unknown } = {}): Promise<ExpenseSource[]> {
  const search = optionalString(filters.search, "search", { maxLength: 100 });
  const result = await tx.query<{
    source_type: ExpenseSourceType;
    line_id: string;
    document_id: string;
    document_label: string;
    person_email: string | null;
    contact_name: string;
    date: string;
    description: string;
    account_code: string;
    net_amount: string;
  }>(
    `select src.source_type, src.line_id::text, src.document_id::text, src.document_label, src.person_email, src.contact_name, src.date, src.description,
            src.account_code, src.net_amount
       from ${SOURCES} src
      where src.usable and src.account_class = 'expense' and src.net_amount > 0
        and not exists (select 1 from project_expenses x where x.status = 'active' and x.source_type = src.source_type
                          and coalesce(x.bill_line_id, x.expense_claim_receipt_id, x.bank_transaction_line_id) = src.line_id)
        and ($1::text is null or src.description ilike '%' || $1 || '%' or src.contact_name ilike '%' || $1 || '%'
             or src.document_label ilike '%' || $1 || '%' or src.person_email ilike '%' || $1 || '%')
      order by src.date desc, src.line_id desc
      limit 200`,
    [search],
  );
  return result.rows.map((row) => ({
    sourceType: row.source_type,
    lineId: row.line_id,
    documentId: row.document_id,
    documentLabel: sourceLabel(tx, row),
    contactName: row.contact_name,
    date: row.date,
    description: row.description,
    accountCode: row.account_code,
    cost: money(dec(row.net_amount)),
  }));
}

function parseMarkup(input: unknown): string {
  if (input == null || (typeof input === "string" && !input.trim())) return "0";
  const markup = parseDecimalInput(input, "markupPercent", { maxScale: 2, allowZero: true });
  if (cmp(dec(markup), dec("1000")) > 0) throw new ValidationError("The markup can be at most 1000%.");
  return markup;
}

/**
 * Links a line to a project (PJ4) at its amount excluding GST, chargeable or
 * not, with an optional markup. The line isn't re-posted: its document keeps
 * its journal. Refused for lines of drafts, voided documents, receive money,
 * stock, balance sheet accounts (only expense-class accounts are project
 * costs, PJ13), and lines already on a project.
 */
export async function linkProjectExpense(
  tx: OrgTx,
  projectIdInput: unknown,
  input: { source?: unknown; idempotencyKey: unknown; sourceType?: unknown; lineId?: unknown; chargeable?: unknown; markupPercent?: unknown },
): Promise<{ created: boolean; project: Project; expenseId: string }> {
  const projectId = requireId(projectIdInput, "projectId");
  const source = optionalSource(input.source);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const sourceType = requireOneOf(input.sourceType, "sourceType", EXPENSE_SOURCE_TYPES);
  const lineId = requireId(input.lineId, "lineId");
  const chargeable = optionalBoolean(input.chargeable, "chargeable") ?? true;
  const markupPercent = chargeable ? parseMarkup(input.markupPercent) : "0";
  if (!chargeable && input.markupPercent != null && input.markupPercent !== "" && cmp(dec(parseMarkup(input.markupPercent)), ZERO_DECIMAL) !== 0) {
    throw new ValidationError("Only a chargeable expense has a markup.");
  }
  const hash = requestHash("project_expense", { projectId, sourceType, lineId, chargeable, markupPercent: plain(markupPercent) });
  const find = async () =>
    (await tx.query<{ id: string; request_hash: string }>("select id::text, request_hash from project_expenses where command_source = $1 and idempotency_key = $2", [source, idempotencyKey])).rows[0];
  const project = await lockProject(tx, projectId);
  const existing = await find();
  if (existing) {
    assertSameRequest(existing.request_hash, hash, "project expense");
    return { created: false, project: await getProject(tx, projectId), expenseId: existing.id };
  }
  assertOpen(project);
  const line = (
    await tx.query<{
      usable: boolean;
      account_type: AccountType;
      account_class: string;
      account_code: string;
      account_name: string;
      net_amount: string;
      document_label: string;
    }>(
      `select usable, account_type, account_class, account_code, account_name, net_amount, document_label
         from ${SOURCES} src where src.source_type = $1 and src.line_id = $2`,
      [sourceType, lineId],
    )
  ).rows[0];
  if (!line) throw new ValidationError("There's no such line.");
  if (!line.usable) {
    throw new ValidationError(
      sourceType === "bank_transaction_line"
        ? "Only lines of spend money that hasn't been voided can go on a project."
        : `Only lines of approved ${sourceType === "bill_line" ? "bills" : "expense claims"} can go on a project (${line.document_label} isn't approved, or is voided).`,
    );
  }
  if (line.account_type === "inventory") throw new ValidationError(`That line is stock (account ${line.account_code}); stock is costed when it's sold, so it can't go on a project.`);
  if (line.account_class !== "expense") {
    // A project's costs are profit and loss costs (PJ13): a fixed asset bought, a prepayment or a
    // liability paid isn't an expense of the project.
    throw new ValidationError(
      `That line is coded to ${line.account_code} ${line.account_name}, a ${ACCOUNT_TYPES[line.account_type].label.toLowerCase()} account, not an expense. ` +
        "Only lines coded to expense or direct cost accounts can go on a project.",
    );
  }
  if (cmp(dec(line.net_amount), ZERO_DECIMAL) <= 0) throw new ValidationError("That line has no amount excluding GST.");
  const taken = await tx.query<{ name: string }>(
    `select p.name from project_expenses x join projects p on p.id = x.project_id
      where x.status = 'active' and x.source_type = $1 and coalesce(x.bill_line_id, x.expense_claim_receipt_id, x.bank_transaction_line_id) = $2`,
    [sourceType, lineId],
  );
  if (taken.rows[0]) throw new ConflictError(`That line is already on project ${taken.rows[0].name}.`);
  const column = { bill_line: "bill_line_id", expense_claim_receipt: "expense_claim_receipt_id", bank_transaction_line: "bank_transaction_line_id" }[sourceType];
  const inserted = await tx.query<{ id: string }>(
    `insert into project_expenses (command_source, idempotency_key, request_hash, project_id, source_type, ${column}, cost, chargeable, markup_percent,
                                   created_by_user_id, created_by_email)
     values ($1, $2, $3, $4, $5, $6, $7::numeric, $8, $9::numeric, $10, $11) returning id::text`,
    [source, idempotencyKey, hash, projectId, sourceType, lineId, line.net_amount, chargeable, markupPercent, tx.actor.userId, tx.actor.email],
  );
  const expenseId = inserted.rows[0].id;
  await writeAuditEvent(tx, {
    eventType: "project.expense_linked",
    entityType: "project",
    entityId: projectId,
    details: { expenseId, sourceType, lineId, cost: money(dec(line.net_amount)), chargeable, markupPercent: plain(markupPercent) },
  });
  return { created: true, project: await getProject(tx, projectId), expenseId };
}

async function lockExpenseForChange(tx: OrgTx, idInput: unknown): Promise<{ expense: ProjectExpense; projectId: string }> {
  const id = requireId(idInput, "expenseId");
  const found = await tx.query<{ project_id: string }>("select project_id::text from project_expenses where id = $1", [id]);
  if (!found.rows[0]) throw new NotFoundError("Project expense not found.");
  const project = await lockProject(tx, found.rows[0].project_id);
  assertOpen(project);
  const expense = (await loadExpenses(tx, [project.id])).map(toExpense).find((entry) => entry.id === id)!;
  if (expense.status === "removed") throw new ConflictError("This expense has been removed from its project.");
  if (expense.writtenOffAt) throw new ConflictError("This expense has been written off and can't change.");
  if (expense.billedOn) {
    throw new ConflictError(`This expense is on ${invoiceLabel(expense.billedOn)}, so it can't change. Void or delete the invoice first.`);
  }
  return { expense, projectId: project.id };
}

/** Changes whether an unbilled expense is chargeable, and its markup (PJ8). */
export async function updateProjectExpense(tx: OrgTx, idInput: unknown, input: { chargeable?: unknown; markupPercent?: unknown }): Promise<Project> {
  const { expense, projectId } = await lockExpenseForChange(tx, idInput);
  const chargeable = input.chargeable === undefined ? expense.chargeable : (optionalBoolean(input.chargeable, "chargeable") ?? expense.chargeable);
  const markupPercent = chargeable ? parseMarkup(input.markupPercent === undefined ? expense.markupPercent : input.markupPercent) : "0";
  if (chargeable === expense.chargeable && plain(markupPercent) === plain(expense.markupPercent)) return getProject(tx, projectId);
  await tx.query("update project_expenses set chargeable = $2, markup_percent = $3::numeric, updated_at = now() where id = $1", [expense.id, chargeable, markupPercent]);
  await writeAuditEvent(tx, {
    eventType: "project.expense_updated",
    entityType: "project",
    entityId: projectId,
    details: { expenseId: expense.id, before: { chargeable: expense.chargeable, markupPercent: expense.markupPercent }, after: { chargeable, markupPercent: plain(markupPercent) } },
  });
  return getProject(tx, projectId);
}

/** Takes an unbilled expense off its project (kept, marked removed); the line can then go on another project, or be voided. */
export async function removeProjectExpense(tx: OrgTx, idInput: unknown): Promise<Project> {
  const { expense, projectId } = await lockExpenseForChange(tx, idInput);
  await tx.query("update project_expenses set status = 'removed', removed_at = now(), removed_by_email = $2, updated_at = now() where id = $1", [expense.id, tx.actor.email]);
  await writeAuditEvent(tx, {
    eventType: "project.expense_removed",
    entityType: "project",
    entityId: projectId,
    details: { expenseId: expense.id, sourceType: expense.sourceType, lineId: expense.sourceLineId, cost: expense.cost },
  });
  return getProject(tx, projectId);
}

// ---------------------------------------------------------------------------
// Invoicing (PJ6-PJ8)

function parseIds(input: unknown, field: string): string[] {
  if (input == null) return [];
  const ids = requireArray(input, field, MAX_ITEMS).map((value, index) => requireId(value, `${field}[${index}]`));
  return [...new Set(ids)].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));
}

/**
 * Makes a draft sales invoice from chosen unbilled items (PJ6): time on
 * hourly tasks grouped per task at its current rate, fixed prices, and
 * chargeable expenses with their markup, to one revenue account and tax code
 * (none for no tax). Each item is linked to the invoice so it can't be billed
 * again; voiding the invoice or deleting the draft makes them unbilled again.
 */
export async function invoiceProject(
  tx: OrgTx,
  projectIdInput: unknown,
  input: {
    source?: unknown;
    idempotencyKey: unknown;
    invoiceDate?: unknown;
    dueDate?: unknown;
    accountCode?: unknown;
    taxCode?: unknown;
    timeEntryIds?: unknown;
    taskIds?: unknown;
    expenseIds?: unknown;
  },
): Promise<{ created: boolean; invoice: Invoice; project: Project }> {
  const projectId = requireId(projectIdInput, "projectId");
  const source = optionalSource(input.source);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const invoiceDate = parseIsoDate(input.invoiceDate, "invoiceDate");
  const sentDue = parseOptionalIsoDate(input.dueDate, "dueDate");
  if (sentDue !== null && sentDue < invoiceDate) throw new ValidationError("The due date can't be before the invoice date.");
  const accountCode = parseAccountCodeInput(input.accountCode, "accountCode");
  const taxCode = optionalString(input.taxCode, "taxCode", { maxLength: 20 })?.toUpperCase() ?? null;
  const timeEntryIds = parseIds(input.timeEntryIds, "timeEntryIds");
  const taskIds = parseIds(input.taskIds, "taskIds");
  const expenseIds = parseIds(input.expenseIds, "expenseIds");
  const hash = requestHash("project_invoice", { projectId, invoiceDate, dueDate: sentDue, accountCode: accountCode.toLowerCase(), taxCode, timeEntryIds, taskIds, expenseIds });
  const replay = async () => {
    const earlier = (
      await tx.query<{ request_hash: string; invoice_id: string }>(
        "select request_hash, invoice_id::text from project_invoices where command_source = $1 and idempotency_key = $2",
        [source, idempotencyKey],
      )
    ).rows[0];
    if (!earlier) return null;
    assertSameRequest(earlier.request_hash, hash, "project invoice");
    return { created: false, invoice: await getInvoice(tx, earlier.invoice_id), project: await getProject(tx, projectId) };
  };
  const earlier = await replay();
  if (earlier) return earlier;
  const locked = await lockProject(tx, projectId);
  const meanwhile = await replay();
  if (meanwhile) return meanwhile;
  assertOpen(locked);
  if (timeEntryIds.length + taskIds.length + expenseIds.length === 0) throw new ValidationError("Choose the time, fixed prices or expenses to invoice.");

  const project = await getProject(tx, projectId);
  const already = (billed: BilledOn | null, what: string) => {
    if (billed) throw new ConflictError(`${what} is already on ${invoiceLabel(billed)}.`);
  };
  const entries = timeEntryIds.map((id) => {
    const entry = project.timeEntries.find((row) => row.id === id);
    if (!entry || entry.status !== "active") throw new ValidationError(`Time entry #${id} isn't on this project.`);
    if (entry.chargeType === "non_chargeable") throw new ValidationError(`Time entry #${id} is on ${entry.taskName}, which is non-chargeable.`);
    if (entry.chargeType === "fixed") throw new ValidationError(`Time entry #${id} is on ${entry.taskName}, a fixed price task: invoice its price instead.`);
    if (entry.writtenOffAt) throw new ConflictError(`Time entry #${id} has been written off.`);
    already(entry.billedOn, `Time entry #${id}`);
    return entry;
  });
  const fixedTasks = taskIds.map((id) => {
    const task = project.tasks.find((row) => row.id === id);
    if (!task) throw new ValidationError(`Task #${id} isn't on this project.`);
    if (task.chargeType !== "fixed") throw new ValidationError(`${task.name} isn't a fixed price task: invoice its time instead.`);
    if (task.status !== "active") throw new ConflictError(`${task.name} is archived.`);
    if (task.writtenOffAt) throw new ConflictError(`${task.name} has been written off.`);
    already(task.billedOn, task.name);
    return task;
  });
  const expenses = expenseIds.map((id) => {
    const expense = project.expenses.find((row) => row.id === id);
    if (!expense || expense.status !== "active") throw new ValidationError(`Expense #${id} isn't on this project.`);
    if (!expense.chargeable) throw new ValidationError(`${expense.description} isn't chargeable.`);
    if (expense.writtenOffAt) throw new ConflictError(`${expense.description} has been written off.`);
    already(expense.billedOn, expense.description);
    return expense;
  });

  type Line = { description: string; quantity: string; unitPrice: string; items: Array<{ kind: "time" | "fixed_task" | "expense"; id: string }> };
  const lines: Line[] = [];
  for (const task of project.tasks) {
    const onTask = entries.filter((entry) => entry.taskId === task.id);
    if (onTask.length === 0) continue;
    const minutes = onTask.reduce((total, entry) => total + entry.minutes, 0);
    const line = timeInvoiceLine(task.name, minutes, task.rate!);
    lines.push({ description: line.description, quantity: line.quantity, unitPrice: line.unitPrice, items: onTask.map((entry) => ({ kind: "time", id: entry.id })) });
  }
  for (const task of fixedTasks) {
    lines.push({ description: task.name, quantity: "1", unitPrice: task.rate!, items: [{ kind: "fixed_task", id: task.id }] });
  }
  for (const expense of expenses) {
    lines.push({ description: expense.description, quantity: "1", unitPrice: expense.charge, items: [{ kind: "expense", id: expense.id }] });
  }

  const dueDate = sentDue ?? (await dueDateFromTerms(tx, project.contactId, invoiceDate));
  if (dueDate === null) throw new ValidationError("dueDate is required (YYYY-MM-DD): this customer has no payment terms to work it out from.");
  const { invoice } = await createInvoice(tx, {
    source: "project",
    idempotencyKey: `project-${requestHash("project_invoice_key", { source, idempotencyKey }).slice(0, 48)}`,
    contactId: project.contactId,
    invoiceDate,
    dueDate,
    reference: project.name.slice(0, 100),
    amountsMode: taxCode ? "exclusive" : "no_tax",
    lines: lines.map((line) => ({ description: line.description, quantity: line.quantity, unitPrice: line.unitPrice, accountCode, taxCode })),
  });
  const projectInvoice = await tx.query<{ id: string }>(
    `insert into project_invoices (command_source, idempotency_key, request_hash, project_id, invoice_id, created_by_user_id, created_by_email)
     values ($1, $2, $3, $4, $5, $6, $7) returning id::text`,
    [source, idempotencyKey, hash, projectId, invoice.id, tx.actor.userId, tx.actor.email],
  );
  const values: unknown[] = [];
  const tuples: string[] = [];
  lines.forEach((line, index) => {
    for (const item of line.items) {
      values.push(projectInvoice.rows[0].id, projectId, item.kind, item.kind === "time" ? item.id : null, item.kind === "fixed_task" ? item.id : null, item.kind === "expense" ? item.id : null, index + 1);
      const base = values.length - 7;
      tuples.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`);
    }
  });
  await tx.query(
    `insert into project_invoice_items (project_invoice_id, project_id, kind, time_entry_id, task_id, expense_id, line_order) values ${tuples.join(", ")}`,
    values,
  );
  await writeAuditEvent(tx, {
    eventType: "project.invoiced",
    entityType: "project",
    entityId: projectId,
    details: { invoiceId: invoice.id, subtotal: invoice.subtotal, timeEntryIds, taskIds, expenseIds },
  });
  await writeAuditEvent(tx, { eventType: "invoice.created_from_project", entityType: "sales_invoice", entityId: invoice.id, details: { projectId, projectName: project.name } });
  return { created: true, invoice: await getInvoice(tx, invoice.id), project: await getProject(tx, projectId) };
}

// ---------------------------------------------------------------------------
// Closing and reopening (PJ10)

/**
 * Closes a project. Refused while a project invoice is a draft, or anything
 * is unbilled unless `writeOff` is true, which writes those items off first
 * (they're then never billed). Closing a closed project changes nothing.
 */
export async function closeProject(tx: OrgTx, idInput: unknown, input: { writeOff?: unknown } = {}): Promise<Project> {
  const id = requireId(idInput, "projectId");
  const writeOff = optionalBoolean(input.writeOff, "writeOff") ?? false;
  const locked = await lockProject(tx, id);
  if (locked.status === "closed") return getProject(tx, id);
  const project = await getProject(tx, id);
  if (project.invoices.some((invoice) => invoice.status === "draft")) {
    throw new ConflictError(`Project ${project.name} has a draft invoice. Approve or delete it before closing the project.`);
  }
  const unbilled = dec(project.figures.unbilled);
  if (cmp(unbilled, ZERO_DECIMAL) !== 0 && !writeOff) {
    throw new ConflictError(`Project ${project.name} has ${project.figures.unbilled} unbilled. Invoice it, or close the project with write-off.`);
  }
  const writtenOff = { timeEntryIds: [] as string[], taskIds: [] as string[], expenseIds: [] as string[] };
  if (writeOff) {
    for (const entry of project.timeEntries) {
      if (entry.status === "active" && entry.chargeType === "hourly" && !entry.billedOn && !entry.writtenOffAt) writtenOff.timeEntryIds.push(entry.id);
    }
    for (const task of project.tasks) {
      if (task.chargeType === "fixed" && task.status === "active" && !task.billedOn && !task.writtenOffAt) writtenOff.taskIds.push(task.id);
    }
    for (const expense of project.expenses) {
      if (expense.status === "active" && expense.chargeable && !expense.billedOn && !expense.writtenOffAt) writtenOff.expenseIds.push(expense.id);
    }
    const mark = (table: string, ids: string[]) =>
      ids.length === 0
        ? Promise.resolve()
        : tx.query(`update ${table} set written_off_at = now(), written_off_by_email = $2, updated_at = now() where id = any($1::bigint[])`, [ids, tx.actor.email]);
    await mark("project_time_entries", writtenOff.timeEntryIds);
    await mark("project_tasks", writtenOff.taskIds);
    await mark("project_expenses", writtenOff.expenseIds);
  }
  await tx.query("update projects set status = 'closed', closed_at = now(), closed_by_email = $2, updated_at = now() where id = $1", [id, tx.actor.email]);
  await writeAuditEvent(tx, {
    eventType: "project.closed",
    entityType: "project",
    entityId: id,
    details: writeOff ? { writtenOff: project.figures.unbilled, ...writtenOff } : {},
  });
  return getProject(tx, id);
}

/** Reopens a closed project. Anything written off stays written off. */
export async function reopenProject(tx: OrgTx, idInput: unknown): Promise<Project> {
  const id = requireId(idInput, "projectId");
  const locked = await lockProject(tx, id);
  if (locked.status === "closed") {
    await tx.query("update projects set status = 'in_progress', closed_at = null, closed_by_email = null, updated_at = now() where id = $1", [id]);
    await writeAuditEvent(tx, { eventType: "project.reopened", entityType: "project", entityId: id, details: {} });
  }
  return getProject(tx, id);
}

// ---------------------------------------------------------------------------
// Reports (PJ9, PJ11)

export type TimeReportGroup = { key: string; label: string; minutes: number; cost: string };
export type TimeReport = {
  from: string;
  to: string;
  entries: TimeEntry[];
  byPerson: TimeReportGroup[];
  byProject: TimeReportGroup[];
  byTask: TimeReportGroup[];
  totalMinutes: number;
  totalCost: string;
};

/** Active time entries in a date range, optionally for one person, project or task, grouped with their hours and cost (PJ11). */
export async function timeReport(tx: OrgTx, filters: { from?: unknown; to?: unknown; userId?: unknown; projectId?: unknown; taskId?: unknown }): Promise<TimeReport> {
  const from = parseIsoDate(filters.from, "from");
  const to = parseIsoDate(filters.to, "to");
  if (to < from) throw new ValidationError("The end date can't be before the start date.");
  const userId = typeof filters.userId === "string" && filters.userId.trim() ? filters.userId.trim() : null;
  if (userId !== null && !/^[0-9a-f-]{36}$/i.test(userId)) throw new ValidationError("userId must be a member's id.");
  const projectId = optionalId(filters.projectId, "projectId");
  const taskId = optionalId(filters.taskId, "taskId");
  const rows = await loadEntries(
    tx,
    `e.status = 'active' and e.entry_date between $1 and $2 and ($3::uuid is null or e.user_id = $3)
       and ($4::bigint is null or e.project_id = $4) and ($5::bigint is null or e.task_id = $5)`,
    [from, to, userId, projectId, taskId],
  );
  const entries = rows.map(toEntry);
  const group = (keyOf: (entry: TimeEntry) => string, labelOf: (entry: TimeEntry) => string): TimeReportGroup[] => {
    const groups = new Map<string, { label: string; minutes: number; cost: Decimal }>();
    for (const entry of entries) {
      const key = keyOf(entry);
      const current = groups.get(key) ?? { label: labelOf(entry), minutes: 0, cost: ZERO_DECIMAL };
      current.minutes += entry.minutes;
      current.cost = add(current.cost, dec(entry.cost));
      groups.set(key, current);
    }
    return [...groups.entries()]
      .map(([key, value]) => ({ key, label: value.label, minutes: value.minutes, cost: money(value.cost) }))
      .sort((a, b) => a.label.localeCompare(b.label));
  };
  return {
    from,
    to,
    entries,
    byPerson: group((entry) => entry.userId, (entry) => personName(tx, entry.userEmail)),
    byProject: group((entry) => entry.projectId, (entry) => entry.projectName),
    byTask: group((entry) => entry.taskId, (entry) => `${entry.projectName} › ${entry.taskName}`),
    totalMinutes: entries.reduce((total, entry) => total + entry.minutes, 0),
    totalCost: money(sumOf(entries.map((entry) => entry.cost))),
  };
}

export type ProfitabilityReport = { projects: ProjectSummary[]; totals: Omit<ProjectFigures, "estimateLeft" | "minutes"> & { minutes: number } };

/** Every project's figures (PJ9), with totals; `status` keeps only in progress or closed ones. */
export async function projectProfitability(tx: OrgTx, filters: { status?: unknown } = {}): Promise<ProfitabilityReport> {
  const projects = await listProjects(tx, { status: filters.status });
  const total = (field: keyof Omit<ProjectFigures, "estimateLeft" | "minutes">) => money(sumOf(projects.map((project) => project.figures[field])));
  return {
    projects,
    totals: {
      minutes: projects.reduce((sum, project) => sum + project.figures.minutes, 0),
      timeCost: total("timeCost"),
      expenseCost: total("expenseCost"),
      costs: total("costs"),
      invoiced: total("invoiced"),
      onDraftInvoices: total("onDraftInvoices"),
      profit: total("profit"),
      unbilledTime: total("unbilledTime"),
      unbilledFixed: total("unbilledFixed"),
      unbilledExpenses: total("unbilledExpenses"),
      unbilled: total("unbilled"),
      writtenOff: total("writtenOff"),
      toDate: total("toDate"),
    },
  };
}
