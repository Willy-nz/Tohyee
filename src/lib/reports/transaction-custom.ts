import { customValueText, type CustomValues } from "@/lib/custom-fields/values";
import { getCustomFieldSetup } from "@/lib/custom-fields/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { parseIsoDate } from "@/lib/dates";
import { ValidationError } from "@/lib/errors";
import { accountTransactions } from "@/lib/reports/account-transactions";
import { agedPayables } from "@/lib/reports/aged-payables";
import { agedReceivables } from "@/lib/reports/aged-receivables";
import { journalReport } from "@/lib/reports/journal-report";
import { salesBySalesperson } from "@/lib/reports/sales-by-salesperson";
import { parseTrackingFilter } from "@/lib/reports/account-transactions";
import { getTrackingSetup } from "@/lib/tracking/service";
import type { TrackingTags } from "@/lib/tracking/service";
import { requireId } from "@/lib/validation";
import {
  CUSTOM_REPORT_BASES,
  CUSTOM_REPORT_LIMITS,
  type TransactionCustomReportFigures,
  type TransactionReportBase,
  type TransactionReportColumn,
  type TransactionReportFilters,
  type TransactionReportLayout,
  TRANSACTION_REPORT_DEFAULT_COLUMNS,
} from "@/lib/reports/custom-layout";

const COMMON_COLUMNS: TransactionReportColumn[] = [
  { key: "contact.name", label: "Contact" },
  { key: "contact.email", label: "Contact email" },
  { key: "contact.phone", label: "Contact phone" },
  { key: "contact.address", label: "Billing address" },
  { key: "contact.delivery_address", label: "Delivery address" },
  { key: "contact.group", label: "Contact group" },
];

const REPORT_COLUMNS: Record<TransactionReportBase, TransactionReportColumn[]> = {
  account_transactions: [
    { key: "date", label: "Date" },
    { key: "source", label: "Source" },
    { key: "description", label: "Description" },
    { key: "debit", label: "Debit" },
    { key: "credit", label: "Credit" },
    { key: "balance", label: "Balance" },
  ],
  aged_receivables: [
    { key: "contact.name", label: "Contact" },
    { key: "current", label: "Current" },
    { key: "days1to30", label: "1-30 days" },
    { key: "days31to60", label: "31-60 days" },
    { key: "days61to90", label: "61-90 days" },
    { key: "over90", label: "Over 90 days" },
    { key: "credit", label: "Credit" },
    { key: "total", label: "Total" },
    { key: "document.date", label: "Document date" },
    { key: "document.reference", label: "Document" },
    { key: "document.amount", label: "Amount due" },
  ],
  aged_payables: [
    { key: "contact.name", label: "Contact" },
    { key: "current", label: "Current" },
    { key: "days1to30", label: "1-30 days" },
    { key: "days31to60", label: "31-60 days" },
    { key: "days61to90", label: "61-90 days" },
    { key: "over90", label: "Over 90 days" },
    { key: "credit", label: "Credit" },
    { key: "total", label: "Total" },
    { key: "document.date", label: "Document date" },
    { key: "document.reference", label: "Document" },
    { key: "document.amount", label: "Amount due" },
  ],
  sales_by_salesperson: [
    { key: "salesperson", label: "Salesperson" },
    { key: "invoices", label: "Invoices" },
    { key: "sales", label: "Sales" },
    { key: "creditNotes", label: "Credit notes" },
    { key: "netSales", label: "Net sales" },
    { key: "document.date", label: "Document date" },
    { key: "document.reference", label: "Document" },
    { key: "document.amount", label: "Document amount" },
  ],
  journal_report: [
    { key: "date", label: "Date" },
    { key: "source", label: "Source" },
    { key: "account", label: "Account" },
    { key: "description", label: "Description" },
    { key: "debit", label: "Debit" },
    { key: "credit", label: "Credit" },
  ],
};

/** Reports with a row per ledger line; the others have a row per document. */
const LINE_LEVEL_BASES: ReadonlySet<TransactionReportBase> = new Set(["account_transactions", "journal_report"]);

function usesFor(base: TransactionReportBase): string[] {
  if (base === "aged_receivables") return ["customer", "invoice", "credit_note"];
  if (base === "aged_payables") return ["supplier", "bill", "supplier_credit_note"];
  if (base === "sales_by_salesperson") return ["customer", "invoice", "credit_note"];
  return ["customer", "supplier", "invoice", "bill", "credit_note", "supplier_credit_note", "spend", "receive", "journal"];
}

export async function transactionReportColumnOptions(tx: OrgTx, base: TransactionReportBase): Promise<TransactionReportColumn[]> {
  const customFields = await getCustomFieldSetup(tx);
  const tracking = await getTrackingSetup(tx);
  const uses = usesFor(base);
  const options = [
    ...REPORT_COLUMNS[base],
    ...COMMON_COLUMNS,
    ...customFields.fields
      .filter((field) => field.record === "contact" && field.usedOn.some((use) => uses.includes(use)))
      .map((field) => ({ key: `contact.custom.${field.id}`, label: `Contact · ${field.label}` })),
    ...customFields.fields
      .filter((field) => field.record === "document" && field.usedOn.some((use) => uses.includes(use)))
      .map((field) => ({ key: `document.custom.${field.id}`, label: `Document · ${field.label}` })),
  ];
  // Line fields and tracking only where each row is one line, so a cell never mixes several lines' values.
  if (LINE_LEVEL_BASES.has(base)) {
    options.push(
      ...customFields.fields
        .filter((field) => field.record === "line" && field.usedOn.some((use) => uses.includes(use)))
        .map((field) => ({ key: `line.custom.${field.id}`, label: `Line · ${field.label}` })),
      ...tracking.categories.map((category) => ({ key: `tracking.${category.id}`, label: category.name })),
    );
  }
  return options;
}

type ReportColumnContext = {
  target: Record<string, unknown>;
  contactId?: string | null;
  sourceType?: string | null;
  recordId?: string | null;
  documentFields?: CustomValues;
  lineFields?: CustomValues;
  tracking?: TrackingTags;
};

type ContactColumnRecord = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  postal_address: string | null;
  delivery_address: string | null;
  custom_fields: CustomValues;
  group_name: string | null;
};

const SOURCE_FIELD_TABLES: Record<string, string> = {
  invoice: "sales_invoices",
  customer_payment: "sales_invoices",
  customer_overpayment_refund: "sales_invoices",
  sales_credit_note: "sales_credit_notes",
  sales_credit_note_refund: "sales_credit_notes",
  bill: "bills",
  supplier_payment: "bills",
  supplier_credit_note: "supplier_credit_notes",
  supplier_credit_note_refund: "supplier_credit_notes",
  bank_transaction: "bank_transactions",
  journal: "ledger_journals",
};

function reportContexts(base: TransactionReportBase, data: Record<string, unknown>): ReportColumnContext[] {
  const contexts: ReportColumnContext[] = [];
  const sourceContext = (target: Record<string, unknown>, contactId?: string | null): ReportColumnContext => {
    const source = target.source as Record<string, unknown> | undefined;
    return {
      target,
      contactId: contactId ?? (source?.contactId as string | null | undefined),
      sourceType: source?.type as string | null | undefined,
      recordId: source?.recordId as string | null | undefined,
    };
  };
  if (base === "account_transactions") {
    for (const account of (data.accounts ?? []) as Array<Record<string, unknown>>) {
      for (const line of (account.lines ?? []) as Array<Record<string, unknown>>) {
        contexts.push({ ...sourceContext(line), lineFields: (line.customFields as CustomValues) ?? {}, tracking: (line.tracking as TrackingTags) ?? {} });
      }
    }
  } else if (base === "aged_receivables" || base === "aged_payables") {
    for (const row of (data.rows ?? []) as Array<Record<string, unknown>>) {
      const contactId = row.contactId as string;
      contexts.push({ target: row, contactId });
      const details = base === "aged_receivables" ? row.invoices : [...(row.bills as unknown[]), ...(row.credits as unknown[])];
      for (const detail of (details ?? []) as Array<Record<string, unknown>>) {
        const isCredit = "supplierCreditNoteNumber" in detail;
        contexts.push({
          target: detail,
          contactId,
          sourceType: base === "aged_receivables" ? (isCredit ? "sales_credit_note" : "invoice") : (isCredit ? "supplier_credit_note" : "bill"),
          recordId: detail.id as string,
          documentFields: (detail.customFields as CustomValues) ?? {},
        });
      }
    }
  } else if (base === "sales_by_salesperson") {
    for (const person of (data.rows ?? []) as Array<Record<string, unknown>>) {
      for (const document of (person.documents ?? []) as Array<Record<string, unknown>>) {
        contexts.push({
          target: document,
          contactId: document.contactId as string,
          sourceType: String(document.kind).startsWith("invoice") ? "invoice" : "sales_credit_note",
          recordId: document.id as string,
          documentFields: (document.customFields as CustomValues) ?? {},
        });
      }
    }
  } else {
    for (const journal of (data.journals ?? []) as Array<Record<string, unknown>>) {
      const header = sourceContext(journal);
      contexts.push(header);
      for (const line of (journal.lines ?? []) as Array<Record<string, unknown>>) {
        contexts.push({
          ...header,
          target: line,
          lineFields: (line.customFields as CustomValues) ?? {},
          tracking: (line.tracking as TrackingTags) ?? {},
        });
      }
    }
  }
  return contexts;
}

async function addTransactionColumnValues(
  tx: OrgTx,
  base: TransactionReportBase,
  data: Record<string, unknown>,
  selectedColumns: string[],
): Promise<void> {
  const contexts = reportContexts(base, data);
  const contactIds = [...new Set(contexts.map((entry) => entry.contactId).filter((id): id is string => Boolean(id)))];
  const contacts = new Map<string, ContactColumnRecord>();
  if (contactIds.length > 0) {
    const found = await tx.query<ContactColumnRecord>(
      `select c.id::text, c.name, c.email, c.phone, c.postal_address, c.delivery_address, c.custom_fields, g.name as group_name
         from contacts c left join customer_groups g on g.id = c.customer_group_id
        where c.id = any($1::bigint[])`,
      [contactIds],
    );
    found.rows.forEach((row) => contacts.set(row.id, row));
  }

  const recordIdsByTable = new Map<string, Set<string>>();
  for (const entry of contexts) {
    const table = entry.sourceType ? SOURCE_FIELD_TABLES[entry.sourceType] : null;
    if (table && entry.recordId && !entry.documentFields) {
      const ids = recordIdsByTable.get(table) ?? new Set<string>();
      ids.add(entry.recordId);
      recordIdsByTable.set(table, ids);
    }
  }
  const documents = new Map<string, CustomValues>();
  for (const [table, ids] of recordIdsByTable) {
    const found = await tx.query<{ id: string; custom_fields: CustomValues }>(
      `select id::text, custom_fields from ${table} where id = any($1::bigint[])`,
      [[...ids]],
    );
    found.rows.forEach((row) => documents.set(`${table}:${row.id}`, row.custom_fields ?? {}));
  }
  const fields = await getCustomFieldSetup(tx);
  const tracking = await getTrackingSetup(tx);
  for (const entry of contexts) {
    const contact = entry.contactId ? contacts.get(entry.contactId) : undefined;
    const table = entry.sourceType ? SOURCE_FIELD_TABLES[entry.sourceType] : undefined;
    const documentFields =
      entry.documentFields ??
      (table && entry.recordId ? documents.get(`${table}:${entry.recordId}`) : undefined) ??
      {};
    const columnValues: Record<string, string> = {};
    for (const key of selectedColumns) {
      if (
        !key.startsWith("contact.") &&
        !key.startsWith("document.custom.") &&
        !key.startsWith("line.custom.") &&
        !key.startsWith("tracking.")
      ) {
        continue;
      }
      let value = "";
      if (key === "contact.name") value = contact?.name ?? "";
      else if (key === "contact.email") value = contact?.email ?? "";
      else if (key === "contact.phone") value = contact?.phone ?? "";
      else if (key === "contact.address") value = contact?.postal_address ?? "";
      else if (key === "contact.delivery_address") value = contact?.delivery_address ?? "";
      else if (key === "contact.group") value = contact?.group_name ?? "";
      else if (key.startsWith("contact.custom.")) {
        const fieldId = key.slice("contact.custom.".length);
        const field = fields.fields.find((candidate) => candidate.id === fieldId);
        if (field) value = customValueText(field, contact?.custom_fields?.[fieldId]);
      } else if (key.startsWith("document.custom.")) {
        const fieldId = key.slice("document.custom.".length);
        const field = fields.fields.find((candidate) => candidate.id === fieldId);
        if (field) value = customValueText(field, documentFields[fieldId]);
      } else if (key.startsWith("line.custom.")) {
        const fieldId = key.slice("line.custom.".length);
        const field = fields.fields.find((candidate) => candidate.id === fieldId);
        if (field) value = customValueText(field, entry.lineFields?.[fieldId]);
      } else if (key.startsWith("tracking.")) {
        const categoryId = key.slice("tracking.".length);
        const category = tracking.categories.find((candidate) => candidate.id === categoryId);
        const valueId = entry.tracking?.[categoryId];
        value = (valueId ?? "").split(",").filter(Boolean).map((id) => category?.values.find((candidate) => candidate.id === id)?.path ?? "").filter(Boolean).join(", ");
      }
      columnValues[key] = value;
    }
    entry.target.columnValues = columnValues;
  }
}

function text(value: unknown, what: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) throw new ValidationError(`${what} is required.`);
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new ValidationError(`${what} can be at most ${maxLength} characters.`);
  return normalized;
}

function parseFilters(base: TransactionReportBase, input: unknown): TransactionReportFilters {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ValidationError("The report filters are missing.");
  const raw = input as Record<string, unknown>;
  const filters: TransactionReportFilters = {};
  if (base === "account_transactions" || base === "sales_by_salesperson" || base === "journal_report") {
    filters.from = raw.from == null || raw.from === "" ? null : parseIsoDate(raw.from, "from");
    filters.to = raw.to == null || raw.to === "" ? null : parseIsoDate(raw.to, "to");
    if (filters.from && filters.to && filters.from > filters.to) throw new ValidationError("The start date must be on or before the end date.");
  } else {
    filters.asAt = raw.asAt == null || raw.asAt === "" ? null : parseIsoDate(raw.asAt, "asAt");
  }
  if (base === "account_transactions") {
    filters.accountId = raw.accountId == null || raw.accountId === "" ? null : requireId(raw.accountId, "accountId");
    filters.trackingCategoryId = raw.trackingCategoryId == null || raw.trackingCategoryId === "" ? null : requireId(raw.trackingCategoryId, "trackingCategoryId");
    filters.trackingValueId = raw.trackingValueId == null || raw.trackingValueId === "" ? null : String(raw.trackingValueId);
    if (Boolean(filters.trackingCategoryId) !== Boolean(filters.trackingValueId)) {
      throw new ValidationError("Choose both a tracking category and a value to filter by.");
    }
    if (filters.trackingValueId && filters.trackingValueId !== "unassigned") requireId(filters.trackingValueId, "trackingValueId");
  }
  if (base === "aged_receivables") {
    if (raw.rollUp != null && typeof raw.rollUp !== "boolean") throw new ValidationError("rollUp must be true or false.");
    filters.rollUp = raw.rollUp === true;
  }
  return filters;
}

export async function parseTransactionReportLayout(
  tx: OrgTx,
  base: TransactionReportBase,
  input: unknown,
): Promise<TransactionReportLayout> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ValidationError("The report is missing.");
  const raw = input as Record<string, unknown>;
  if (JSON.stringify(raw).length > 200_000) throw new ValidationError("This report is too big to save.");
  const title = text(raw.title, "The title", CUSTOM_REPORT_LIMITS.titleLength);
  if (!Array.isArray(raw.columns) || raw.columns.length < 1 || raw.columns.length > 100) {
    throw new ValidationError("Choose between 1 and 100 report columns.");
  }
  const columns = raw.columns.map((column) => text(column, "A report column", 100));
  if (new Set(columns).size !== columns.length) throw new ValidationError("A report column can't be selected twice.");
  const options = await transactionReportColumnOptions(tx, base);
  const known = new Set(options.map((column) => column.key));
  const unknown = columns.find((column) => !known.has(column));
  if (unknown) throw new ValidationError("That report column isn't available.");
  return { title, filters: parseFilters(base, raw.filters), columns };
}

export function templateTransactionReportLayout(base: TransactionReportBase, periodEnd: string): TransactionReportLayout {
  const period = parseIsoDate(periodEnd, "periodEnd");
  const filters: TransactionReportFilters =
    base === "aged_receivables" || base === "aged_payables"
      ? { asAt: period, ...(base === "aged_receivables" ? { rollUp: false } : {}) }
      : { from: null, to: period };
  if (base === "account_transactions") Object.assign(filters, { accountId: null, trackingCategoryId: null, trackingValueId: null });
  return { title: CUSTOM_REPORT_BASES[base], filters, columns: [...TRANSACTION_REPORT_DEFAULT_COLUMNS[base]] };
}

export async function computeTransactionCustomReport(
  tx: OrgTx,
  base: TransactionReportBase,
  layout: TransactionReportLayout,
): Promise<TransactionCustomReportFigures> {
  const filters = layout.filters;
  const data = await ({
    account_transactions: () =>
      accountTransactions(tx, {
        accountId: filters.accountId,
        from: filters.from,
        to: filters.to,
        trackingCategoryId: filters.trackingCategoryId,
        trackingValueId: filters.trackingValueId,
      }),
    aged_receivables: () => agedReceivables(tx, { asAt: filters.asAt, rollUp: filters.rollUp }),
    aged_payables: () => agedPayables(tx, { asAt: filters.asAt }),
    sales_by_salesperson: () => salesBySalesperson(tx, { from: filters.from, to: filters.to }),
    journal_report: () => journalReport(tx, { from: filters.from, to: filters.to }),
  })[base]();
  await addTransactionColumnValues(tx, base, data as Record<string, unknown>, layout.columns);
  return {
    title: layout.title,
    base,
    currencyCode: tx.baseCurrency,
    columns: [],
    selectedColumns: layout.columns,
    columnOptions: await transactionReportColumnOptions(tx, base),
    data,
    blocks: [],
    notInReport: [],
    inSeveralGroups: [],
    computedAt: new Date().toISOString(),
  };
}

export function transactionCustomFieldText(field: Parameters<typeof customValueText>[0], value: Parameters<typeof customValueText>[1]): string {
  return customValueText(field, value);
}

export async function validateTransactionTrackingFilter(tx: OrgTx, filters: TransactionReportFilters): Promise<void> {
  if (filters.trackingCategoryId) {
    await parseTrackingFilter(tx, filters.trackingCategoryId, filters.trackingValueId);
  }
}
