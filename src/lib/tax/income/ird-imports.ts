import { createHash } from "node:crypto";
import { writeAuditEvent } from "@/lib/audit";
import { parseIsoDate } from "@/lib/dates";
import { decodeText, parseBankAmount, parseBankDate, RowError } from "@/lib/bank/formats/common";
import { parseDelimited } from "@/lib/bank/formats/table";
import { readXlsxRows } from "@/lib/bank/formats/xlsx";
import { fromCsvCell } from "@/lib/csv";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { assertSameRequest, requestHash } from "@/lib/idempotency";
import { abs, add, cmp, dec, isNegative, isZero, roundHalfUp, sub, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";
import { financialYearEndMonth } from "@/lib/reports/financial";
import { addAllocation, setEffectiveDate } from "@/lib/tax/income/allocations";
import { APPLIES_TO, APPLIES_TO_LABELS, type AppliesToKey } from "@/lib/tax/income/allocation-kinds";
import {
  AMOUNT_SIGNS,
  DATE_ORDERS,
  headingsAt,
  IRD_IMPORT_COLUMNS,
  IRD_IMPORT_SOURCES,
  IRD_ROW_KIND_LABELS,
  IRD_ROW_KINDS,
  type IrdImportMapping,
  type IrdImportSource,
  type IrdRowKind,
  valueKey,
} from "@/lib/tax/income/ird-import-kinds";
import { getIrdDocument } from "@/lib/tax/income/ird-documents";
import { incomeYearOf, isSupportedIncomeYear, money, shortDate } from "@/lib/tax/income/rules";
import { addPayment, getIncomeTaxYear, requireIncomeYear, saveIncomeTaxYear } from "@/lib/tax/income/service";
import { asRecord, optionalBoolean, optionalId, optionalString, requireArray, requireId, requireIdempotencyKey, requireOneOf, requireString } from "@/lib/validation";

/*
 * Importing IRD account files (examples ITX-IMP1 to ITX-IMP12, decisions
 * 710-716; Codex, delegated by owner, 20 October 2026, issue #360 item 3:
 * "imports and reviewable forecasts first").
 *
 * A CSV or Excel file of an IRD account's transactions (from myIR, or a
 * spreadsheet typed up from it) is read through a column mapping the person
 * makes, with a preview. IRD doesn't publish the columns of its downloads,
 * so none are assumed. The file is kept as an IRD document (the source).
 * Each row becomes a proposed figure that a person accepts or declines, as
 * with the AI-read IRD documents (decision 549). Accepting a payment adds
 * (or links to) an income tax payment; it's allocated to an instalment only
 * when the row itself says which (confirmed by IRD for IRD's own file,
 * allocated with evidence for another spreadsheet), otherwise it's awaiting
 * reconciliation (decisions 620-623). Nothing posts, files or pays.
 * Owners and admins only (the routes check).
 */

export const MAX_IRD_IMPORT_BYTES = 10 * 1024 * 1024;
export const MAX_IRD_IMPORT_ROWS = 5000;

const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// --- Reading the file -------------------------------------------------------------

export type IrdImportFile = {
  fileName: string;
  contentType: string;
  rows: string[][];
  sha256: string;
};

/** Reads a CSV (UTF-8 or Windows-1252) or the first sheet of an .xlsx, as the other imports do. Saves nothing. */
export function readIrdImportFile(input: { fileName: unknown; fileBase64: unknown }): IrdImportFile & { bytes: Buffer } {
  const fileName = optionalString(input.fileName, "fileName", { maxLength: 255 }) ?? "file.csv";
  if (typeof input.fileBase64 !== "string" || input.fileBase64.length === 0) throw new ValidationError("Choose a CSV or Excel file.");
  if (input.fileBase64.length > Math.ceil((MAX_IRD_IMPORT_BYTES * 4) / 3) + 4) throw new ValidationError("The file is larger than 10 MB. Split it into smaller files.");
  const bytes = Buffer.from(input.fileBase64, "base64");
  if (bytes.length === 0) throw new ValidationError("The file is empty.");
  const extension = fileName.toLowerCase().split(".").pop() ?? "";
  let rows: string[][];
  let contentType = "text/csv";
  try {
    if (bytes.length >= 4 && bytes.readUInt32LE(0) === 0x04034b50) {
      rows = readXlsxRows(bytes);
      contentType = XLSX_TYPE;
    } else if (extension === "xls") {
      throw new ValidationError("Older Excel files (.xls) aren't supported. Open it in Excel and save it as .xlsx or CSV.");
    } else if (extension === "pdf" || bytes.subarray(0, 5).toString("latin1") === "%PDF-") {
      throw new ValidationError("That's a PDF. Add PDFs under IRD documents; this import reads CSV and Excel files.");
    } else {
      rows = parseDelimited(decodeText(bytes), { keepBlankRows: true });
    }
  } catch (error) {
    if (error instanceof RowError) throw new ValidationError(error.message);
    throw error;
  }
  rows = rows.map((row) => row.map((cell) => fromCsvCell(cell ?? "")));
  while (rows.length > 0 && !rows[rows.length - 1].some((cell) => cell.trim() !== "")) rows.pop();
  if (rows.length === 0) throw new ValidationError("The file has no rows.");
  if (rows.length > MAX_IRD_IMPORT_ROWS + 20) throw new ValidationError(`The file has more than ${MAX_IRD_IMPORT_ROWS} rows. Split it into smaller files.`);
  return { fileName, contentType, rows, sha256: createHash("sha256").update(bytes).digest("hex"), bytes };
}

// --- The mapping ----------------------------------------------------------------

/** Checks a mapping sent by the browser. */
export function parseMapping(input: unknown): IrdImportMapping {
  const raw = asRecord(input, "mapping");
  const headerRow = typeof raw.headerRow === "number" && Number.isInteger(raw.headerRow) && raw.headerRow >= 0 && raw.headerRow < 20 ? raw.headerRow : null;
  if (headerRow === null) throw new ValidationError("Choose the row with the column headings (one of the first 20).");
  const columnsIn = asRecord(raw.columns ?? {}, "mapping.columns");
  const columns: IrdImportMapping["columns"] = {};
  for (const [field, heading] of Object.entries(columnsIn)) {
    if (!(IRD_IMPORT_COLUMNS as readonly string[]).includes(field)) throw new ValidationError(`Tohyee doesn't know a "${field}" column.`);
    if (heading == null || heading === "") continue;
    columns[field as keyof IrdImportMapping["columns"]] = requireString(heading, `mapping.columns.${field}`, { maxLength: 200 });
  }
  const dateOrder = requireOneOf(raw.dateOrder ?? "dmy", "mapping.dateOrder", DATE_ORDERS);
  const amountSign = raw.amountSign == null || raw.amountSign === "" ? undefined : requireOneOf(raw.amountSign, "mapping.amountSign", AMOUNT_SIGNS);
  const kindValues: IrdImportMapping["kindValues"] = {};
  for (const [key, kind] of Object.entries(asRecord(raw.kindValues ?? {}, "mapping.kindValues"))) {
    if (key.length > 200) throw new ValidationError("A type value is too long.");
    kindValues[valueKey(key)] = requireOneOf(kind, "mapping.kindValues", [...IRD_ROW_KINDS, "skip"] as const);
  }
  const defaultKind = raw.defaultKind == null || raw.defaultKind === "" ? undefined : requireOneOf(raw.defaultKind, "mapping.defaultKind", IRD_ROW_KINDS);
  const appliesToValues: IrdImportMapping["appliesToValues"] = {};
  for (const [key, appliesTo] of Object.entries(asRecord(raw.appliesToValues ?? {}, "mapping.appliesToValues"))) {
    if (key.length > 200) throw new ValidationError("An instalment value is too long.");
    appliesToValues[valueKey(key)] = requireOneOf(appliesTo, "mapping.appliesToValues", [...APPLIES_TO, "none"] as const);
  }
  if (Object.keys(kindValues).length > 200 || Object.keys(appliesToValues).length > 200) throw new ValidationError("The mapping has too many values.");
  return { headerRow, columns, dateOrder, ...(amountSign ? { amountSign } : {}), kindValues, ...(defaultKind ? { defaultKind } : {}), appliesToValues };
}

/** Problems with the mapping itself (not the rows), in words. Empty when it can be used. */
export function mappingProblems(mapping: IrdImportMapping, headings: readonly string[], options: { fileIncomeYear: number | null }): string[] {
  const problems: string[] = [];
  const known = new Set(headings);
  for (const [field, heading] of Object.entries(mapping.columns)) {
    if (heading && !known.has(heading)) problems.push(`The file has no "${heading}" column (chosen for ${field}).`);
  }
  const used = Object.values(mapping.columns).filter(Boolean);
  if (new Set(used).size !== used.length) problems.push("Each column can be used for one thing only.");
  if (!mapping.columns.date) problems.push("Choose the Date column.");
  if (mapping.columns.amount && (mapping.columns.debit || mapping.columns.credit)) problems.push("Use either one Amount column, or Debit and Credit columns, not both.");
  if (!mapping.columns.amount && !mapping.columns.debit && !mapping.columns.credit) problems.push("Choose the Amount column, or the Debit and Credit columns.");
  if (mapping.columns.amount && !mapping.amountSign) problems.push("Say which way round the Amount column is: is a positive amount something you owe, or a payment?");
  if (!mapping.columns.type && !mapping.defaultKind) problems.push("Choose the Type column, or say what every row in the file is.");
  if (!mapping.columns.period && options.fileIncomeYear === null) problems.push("Choose the Period column, or the income year the whole file is for.");
  return problems;
}

export type ParsedRow = {
  /** Its row number in the file (1 is the first row). */
  row: number;
  /** Null when the row is left out (see `skipped`). */
  kind: IrdRowKind | null;
  incomeYear: number | null;
  transactionOn: string | null;
  effectiveOn: string | null;
  direction: "debit" | "credit" | null;
  amount: string | null;
  appliesTo: AppliesToKey | null;
  appliesToText: string | null;
  periodText: string | null;
  description: string | null;
  reference: string | null;
  cells: string[];
  /** Why it's left out: the type is mapped to Skip, or there's no amount. */
  skipped: string | null;
  /** What's wrong with it, if anything. Rows with a problem stop the import. */
  problems: string[];
};

function readMoney(text: string, what: string, problems: string[]): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    // Excel keeps numbers as binary fractions: 1725.1 can arrive as 1725.0999999999999.
    if (/^-?\d+\.\d{9,}$/.test(trimmed)) return toFixedString(roundHalfUp(dec(trimmed), 2), 2);
    return parseBankAmount(trimmed);
  } catch (error) {
    problems.push(`${what}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function yearFromPeriod(text: string, order: IrdImportMapping["dateOrder"], endMonth: number): number | null {
  const trimmed = text.trim();
  if (/^\d{4}$/.test(trimmed)) return Number(trimmed);
  const date = parseBankDate(trimmed, order);
  return date ? incomeYearOf(date, endMonth) : null;
}

/**
 * Turns the file's rows into proposed figures through the mapping (ITX-IMP2
 * to ITX-IMP5). Pure: the preview and the import use the same rules.
 */
export function parseRows(rows: readonly string[][], mapping: IrdImportMapping, options: { fileIncomeYear: number | null; endMonth: number }): ParsedRow[] {
  const headings = headingsAt(rows, mapping.headerRow);
  const column = (field: keyof IrdImportMapping["columns"]) => {
    const heading = mapping.columns[field];
    return heading ? headings.indexOf(heading) : -1;
  };
  const cell = (row: readonly string[], field: keyof IrdImportMapping["columns"]) => {
    const index = column(field);
    return index < 0 ? "" : (row[index] ?? "").trim();
  };
  const parsed: ParsedRow[] = [];
  for (let position = mapping.headerRow + 1; position < rows.length; position += 1) {
    const row = rows[position];
    if (!row.some((text) => text.trim() !== "")) continue;
    const problems: string[] = [];
    const typeText = cell(row, "type");
    let kind: IrdRowKind | null = null;
    let skipped: string | null = null;
    if (mapping.columns.type) {
      const chosen = mapping.kindValues[valueKey(typeText)];
      if (chosen === "skip") skipped = `"${typeText || "(blank)"}" rows are left out.`;
      else if (chosen) kind = chosen;
      else problems.push(`Say what "${typeText || "(blank)"}" rows are.`);
    } else {
      kind = mapping.defaultKind ?? null;
    }
    let direction: ParsedRow["direction"] = null;
    let amount: string | null = null;
    if (mapping.columns.amount) {
      const value = readMoney(cell(row, "amount"), "Amount", problems);
      if (value !== null && !isZero(dec(value))) {
        const positive = !isNegative(dec(value));
        direction = positive === (mapping.amountSign === "positive_is_debit") ? "debit" : "credit";
        amount = money(abs(dec(value)));
      }
    } else {
      const debit = mapping.columns.debit ? readMoney(cell(row, "debit"), "Debit", problems) : null;
      const credit = mapping.columns.credit ? readMoney(cell(row, "credit"), "Credit", problems) : null;
      const debitValue = debit !== null && !isZero(dec(debit)) ? dec(debit) : null;
      const creditValue = credit !== null && !isZero(dec(credit)) ? dec(credit) : null;
      if (debitValue && creditValue) problems.push("Both Debit and Credit have an amount.");
      else if (debitValue) {
        direction = isNegative(debitValue) ? "credit" : "debit";
        amount = money(abs(debitValue));
      } else if (creditValue) {
        direction = isNegative(creditValue) ? "debit" : "credit";
        amount = money(abs(creditValue));
      }
    }
    if (amount === null && problems.length === 0 && !skipped) skipped = "No amount (or nil), so there's nothing to bring in.";
    const dateText = cell(row, "date");
    const transactionOn = dateText ? parseBankDate(dateText, mapping.dateOrder) : null;
    if (!skipped && !transactionOn) problems.push(dateText ? `Date "${dateText}" isn't a date Tohyee can read.` : "No date.");
    const effectiveText = cell(row, "effectiveDate");
    const effectiveOn = effectiveText ? parseBankDate(effectiveText, mapping.dateOrder) : null;
    if (!skipped && effectiveText && !effectiveOn) problems.push(`Effective date "${effectiveText}" isn't a date Tohyee can read.`);
    const periodText = cell(row, "period") || null;
    let incomeYear: number | null = null;
    if (mapping.columns.period && periodText) {
      incomeYear = yearFromPeriod(periodText, mapping.dateOrder, options.endMonth);
      if (!skipped && incomeYear === null) problems.push(`Period "${periodText}" isn't a year or a date Tohyee can read.`);
    } else {
      incomeYear = options.fileIncomeYear;
      if (!skipped && incomeYear === null) problems.push("No period, and no income year chosen for the file.");
    }
    if (!skipped && incomeYear !== null && !isSupportedIncomeYear(incomeYear)) problems.push(`The ${incomeYear} income year isn't one Tohyee works out.`);
    const appliesToText = cell(row, "appliesTo") || null;
    const appliesToChoice = appliesToText ? mapping.appliesToValues[valueKey(appliesToText)] : undefined;
    const appliesTo = appliesToChoice && appliesToChoice !== "none" ? appliesToChoice : null;
    parsed.push({
      row: position + 1,
      kind: skipped ? null : kind,
      incomeYear,
      transactionOn,
      effectiveOn,
      direction,
      amount,
      appliesTo,
      appliesToText,
      periodText,
      description: cell(row, "description").slice(0, 500) || null,
      reference: cell(row, "reference").slice(0, 200) || null,
      cells: row.map((text) => text.slice(0, 500)).slice(0, 60),
      skipped: problems.length > 0 ? null : skipped,
      problems,
    });
  }
  return parsed;
}

export type IrdImportPreview = {
  headings: string[];
  mappingProblems: string[];
  rows: ParsedRow[];
  counts: { rows: number; skipped: number; withProblems: number; toReview: number };
};

/** The preview: what each row would become, with any problems (ITX-IMP2). Saves nothing. */
export async function previewIrdImport(tx: OrgTx, input: { rows: unknown; mapping: unknown; fileIncomeYear?: unknown }): Promise<IrdImportPreview> {
  const rows = requireArray(input.rows, "rows", MAX_IRD_IMPORT_ROWS + 20).map((row) =>
    requireArray(row, "row", 200).map((text) => (typeof text === "string" ? text.slice(0, 2000) : text == null ? "" : String(text))),
  );
  return preview(rows, parseMapping(input.mapping), optionalYear(input.fileIncomeYear), await financialYearEndMonth(tx));
}

function preview(rows: string[][], mapping: IrdImportMapping, fileIncomeYear: number | null, endMonth: number): IrdImportPreview {
  const headings = headingsAt(rows, mapping.headerRow);
  const problems = mappingProblems(mapping, headings, { fileIncomeYear });
  const parsed = problems.length > 0 ? [] : parseRows(rows, mapping, { fileIncomeYear, endMonth });
  return {
    headings,
    mappingProblems: problems,
    rows: parsed,
    counts: {
      rows: parsed.length,
      skipped: parsed.filter((row) => row.skipped).length,
      withProblems: parsed.filter((row) => row.problems.length > 0).length,
      toReview: parsed.filter((row) => !row.skipped && row.problems.length === 0).length,
    },
  };
}

function optionalYear(input: unknown): number | null {
  return input == null || input === "" ? null : requireIncomeYear(input);
}

// --- Saved mappings ------------------------------------------------------------

export type SavedIrdMapping = { id: string; name: string; headings: string[]; mapping: IrdImportMapping; updatedByEmail: string | null; updatedAt: string };

type MappingRow = { id: string; name: string; headings: string[]; mapping: IrdImportMapping; updated_by_email: string | null; updated_at: string };

const toSaved = (row: MappingRow): SavedIrdMapping => ({ id: row.id, name: row.name, headings: row.headings, mapping: row.mapping, updatedByEmail: row.updated_by_email, updatedAt: new Date(row.updated_at).toISOString() });

export async function listIrdMappings(tx: OrgTx): Promise<SavedIrdMapping[]> {
  const result = await tx.query<MappingRow>("select id::text, name, headings, mapping, updated_by_email, updated_at from ird_import_mappings order by lower(name), ird_import_mappings.id");
  return result.rows.map(toSaved);
}

/** Saves a mapping under a name (replacing one with the same name), for files with these headings (ITX-IMP3). */
export async function saveIrdMapping(tx: OrgTx, input: { name: unknown; headings: readonly string[]; mapping: IrdImportMapping }): Promise<SavedIrdMapping> {
  const name = requireString(input.name, "mappingName", { maxLength: 100 }).trim();
  const saved = await tx.query<MappingRow>(
    `insert into ird_import_mappings (name, headings, mapping, updated_by_email) values ($1, $2::jsonb, $3::jsonb, $4)
     on conflict (lower(name)) do update set name = excluded.name, headings = excluded.headings, mapping = excluded.mapping, updated_by_email = excluded.updated_by_email, updated_at = now()
     returning id::text, name, headings, mapping, updated_by_email, updated_at`,
    [name, JSON.stringify(input.headings), JSON.stringify(input.mapping), tx.actor.email],
  );
  await writeAuditEvent(tx, { eventType: "income_tax.ird_mapping_saved", entityType: "ird_import_mapping", entityId: saved.rows[0].id, details: { name, headings: input.headings } });
  return toSaved(saved.rows[0]);
}

export async function deleteIrdMapping(tx: OrgTx, idInput: unknown): Promise<void> {
  const id = requireId(idInput, "mappingId");
  const removed = await tx.query<{ name: string }>("delete from ird_import_mappings where id = $1 returning name", [id]);
  if (!removed.rows[0]) throw new NotFoundError("Saved mapping not found.");
  await writeAuditEvent(tx, { eventType: "income_tax.ird_mapping_deleted", entityType: "ird_import_mapping", entityId: id, details: { name: removed.rows[0].name } });
}

// --- Importing --------------------------------------------------------------------

export type IrdImportRowStatus = "waiting" | "accepted" | "declined";

export type IrdImportRow = {
  id: string;
  importId: string;
  row: number;
  kind: IrdRowKind;
  incomeYear: number;
  transactionOn: string;
  effectiveOn: string | null;
  direction: "debit" | "credit";
  amount: string;
  appliesTo: AppliesToKey | null;
  appliesToText: string | null;
  periodText: string | null;
  description: string | null;
  reference: string | null;
  cells: string[];
  status: IrdImportRowStatus;
  decidedByEmail: string | null;
  decidedAt: string | null;
  declineReason: string | null;
  /** What accepting it did, in words. */
  outcome: string | null;
  paymentId: string | null;
  allocationId: string | null;
  setAssessedRit: boolean;
  /** Waiting payments: the payment already in Tohyee that accepting would link to, instead of adding another (ITX-IMP8). */
  wouldLinkTo: { paymentId: string; paidOn: string; amount: string; note: string | null } | null;
  /** Waiting rows that look the same as a row already accepted from another file (ITX-IMP10). */
  sameAs: { importId: string; fileName: string; row: number } | null;
};

export type IrdImport = {
  id: string;
  documentId: string;
  fileName: string;
  fileRemoved: boolean;
  source: IrdImportSource;
  supportingDocument: { id: string; fileName: string; removed: boolean } | null;
  mappingName: string | null;
  fileIncomeYear: number | null;
  createdByEmail: string | null;
  createdAt: string;
  rows: IrdImportRow[];
  counts: { waiting: number; accepted: number; declined: number };
};

type ImportRow = {
  id: string;
  request_hash: string;
  document_id: string;
  file_name: string;
  file_removed: boolean;
  source: IrdImportSource;
  supporting_document_id: string | null;
  supporting_name: string | null;
  supporting_removed: boolean | null;
  mapping_name: string | null;
  file_income_year: number | null;
  created_by_email: string | null;
  created_at: string;
};

const IMPORT_SELECT = `select i.id::text, i.request_hash, i.document_id::text, d.file_name, d.removed_at is not null as file_removed, i.source,
       i.supporting_document_id::text, s.file_name as supporting_name, s.removed_at is not null as supporting_removed,
       i.mapping_name, i.file_income_year, i.created_by_email, i.created_at
  from ird_imports i join ird_documents d on d.id = i.document_id left join ird_documents s on s.id = i.supporting_document_id`;

type RowRow = {
  id: string;
  import_id: string;
  row_number: number;
  kind: IrdRowKind;
  income_year: number;
  transaction_on: string;
  effective_on: string | null;
  direction: "debit" | "credit";
  amount: string;
  applies_to: AppliesToKey | null;
  applies_to_text: string | null;
  period_text: string | null;
  description: string | null;
  reference: string | null;
  cells: string[];
  status: IrdImportRowStatus;
  decided_by_email: string | null;
  decided_at: string | null;
  decline_reason: string | null;
  outcome: string | null;
  payment_id: string | null;
  allocation_id: string | null;
  set_assessed_rit: boolean;
};

const ROW_COLUMNS = `r.id::text, r.import_id::text, r.row_number, r.kind, r.income_year, r.transaction_on::text, r.effective_on::text, r.direction, r.amount::text,
  r.applies_to, r.applies_to_text, r.period_text, r.description, r.reference, r.cells, r.status, r.decided_by_email, r.decided_at, r.decline_reason,
  r.outcome, r.payment_id::text, r.allocation_id::text, r.set_assessed_rit`;

function toRow(row: RowRow): Omit<IrdImportRow, "wouldLinkTo" | "sameAs"> {
  return {
    id: row.id,
    importId: row.import_id,
    row: row.row_number,
    kind: row.kind,
    incomeYear: row.income_year,
    transactionOn: row.transaction_on,
    effectiveOn: row.effective_on,
    direction: row.direction,
    amount: row.amount,
    appliesTo: row.applies_to,
    appliesToText: row.applies_to_text,
    periodText: row.period_text,
    description: row.description,
    reference: row.reference,
    cells: row.cells,
    status: row.status,
    decidedByEmail: row.decided_by_email,
    decidedAt: row.decided_at ? new Date(row.decided_at).toISOString() : null,
    declineReason: row.decline_reason,
    outcome: row.outcome,
    paymentId: row.payment_id,
    allocationId: row.allocation_id,
    setAssessedRit: row.set_assessed_rit,
  };
}

/** A payment row's date as IRD has it: the effective date when the file has one. */
const irdDate = (row: Pick<RowRow, "effective_on" | "transaction_on">) => row.effective_on ?? row.transaction_on;

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/**
 * The payment already in Tohyee that a payment row is (ITX-IMP8): same
 * income year and amount, paid on IRD's date or up to 7 days before it (a
 * bank payment can take days to reach IRD), not reversed and not already
 * linked to an imported row. The nearest date wins.
 */
async function matchingPayment(tx: OrgTx, row: Pick<RowRow, "id" | "income_year" | "amount" | "effective_on" | "transaction_on">, options: { lock?: boolean } = {}) {
  const date = irdDate(row);
  const result = await tx.query<{ id: string; paid_on: string; amount: string; note: string | null; ird_effective_on: string | null }>(
    `select p.id::text, p.paid_on::text, p.amount::text, p.note, p.ird_effective_on::text from income_tax_payments p
      where p.income_year = $1 and p.amount = $2::numeric
        and (p.paid_on between $3::date and $4::date or p.paid_on = $5::date or p.ird_effective_on = $4::date)
        and not exists (select 1 from ird_import_rows linked where linked.payment_id = p.id and linked.id <> $6)
        and not exists (
          select 1 from ledger_journal_lines rl join ledger_journals rj on rj.id = rl.journal_id
           where rl.id = p.journal_line_id
             and (rj.correction_kind = 'reversal' or exists (select 1 from ledger_journals rr where rr.related_journal_id = rj.id and rr.correction_kind = 'reversal')))
      order by abs(p.paid_on - $4::date), p.id limit 1 ${options.lock ? "for update of p" : ""}`,
    [row.income_year, row.amount, addDays(date, -7), date, row.transaction_on, row.id],
  );
  return result.rows[0] ?? null;
}

/** A row already accepted from another file with the same kind, year, date, direction and amount (ITX-IMP10). */
async function sameAccepted(tx: OrgTx, row: Pick<RowRow, "id" | "import_id" | "kind" | "income_year" | "transaction_on" | "direction" | "amount">) {
  const result = await tx.query<{ import_id: string; file_name: string; row_number: number }>(
    `select r.import_id::text, d.file_name, r.row_number from ird_import_rows r join ird_imports i on i.id = r.import_id join ird_documents d on d.id = i.document_id
      where r.status = 'accepted' and r.import_id <> $1 and r.kind = $2 and r.income_year = $3 and r.transaction_on = $4 and r.direction = $5 and r.amount = $6::numeric
      order by r.decided_at, r.id limit 1`,
    [row.import_id, row.kind, row.income_year, row.transaction_on, row.direction, row.amount],
  );
  const found = result.rows[0];
  return found ? { importId: found.import_id, fileName: found.file_name, row: found.row_number } : null;
}

async function withChecks(tx: OrgTx, row: RowRow): Promise<IrdImportRow> {
  const base = toRow(row);
  if (row.status !== "waiting") return { ...base, wouldLinkTo: null, sameAs: null };
  const sameAs = await sameAccepted(tx, row);
  const match = !sameAs && row.kind === "payment" && row.direction === "credit" ? await matchingPayment(tx, row) : null;
  return { ...base, sameAs, wouldLinkTo: match ? { paymentId: match.id, paidOn: match.paid_on, amount: match.amount, note: match.note } : null };
}

async function toImport(tx: OrgTx, row: ImportRow): Promise<IrdImport> {
  const rows = await tx.query<RowRow>(`select ${ROW_COLUMNS} from ird_import_rows r where r.import_id = $1 order by r.row_number`, [row.id]);
  const checked: IrdImportRow[] = [];
  for (const entry of rows.rows) checked.push(await withChecks(tx, entry));
  return {
    id: row.id,
    documentId: row.document_id,
    fileName: row.file_name,
    fileRemoved: row.file_removed,
    source: row.source,
    supportingDocument: row.supporting_document_id ? { id: row.supporting_document_id, fileName: row.supporting_name ?? "", removed: Boolean(row.supporting_removed) } : null,
    mappingName: row.mapping_name,
    fileIncomeYear: row.file_income_year,
    createdByEmail: row.created_by_email,
    createdAt: new Date(row.created_at).toISOString(),
    rows: checked,
    counts: {
      waiting: checked.filter((entry) => entry.status === "waiting").length,
      accepted: checked.filter((entry) => entry.status === "accepted").length,
      declined: checked.filter((entry) => entry.status === "declined").length,
    },
  };
}

export async function getIrdImport(tx: OrgTx, idInput: unknown): Promise<IrdImport> {
  const id = requireId(idInput, "importId");
  const found = await tx.query<ImportRow>(`${IMPORT_SELECT} where i.id = $1`, [id]);
  if (!found.rows[0]) throw new NotFoundError("Import not found.");
  return toImport(tx, found.rows[0]);
}

export async function listIrdImports(tx: OrgTx): Promise<IrdImport[]> {
  const found = await tx.query<ImportRow>(`${IMPORT_SELECT} order by i.created_at desc, i.id desc`);
  const imports: IrdImport[] = [];
  for (const row of found.rows) imports.push(await toImport(tx, row));
  return imports;
}

/**
 * Imports a file (ITX-IMP1 to ITX-IMP5): keeps it as an IRD document and
 * saves each row as a proposed figure, waiting for a person. Refused while
 * any row has a problem, or when the same file was imported before. Saves the
 * mapping too when it's given a name. Changes no figure.
 */
export async function createIrdImport(
  tx: OrgTx,
  input: { idempotencyKey: unknown; fileName: unknown; fileBase64: unknown; source: unknown; mapping: unknown; fileIncomeYear?: unknown; supportingDocumentId?: unknown; saveMappingAs?: unknown; note?: unknown },
): Promise<{ created: boolean; import: IrdImport }> {
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const file = readIrdImportFile({ fileName: input.fileName, fileBase64: input.fileBase64 });
  const source = requireOneOf(input.source, "source", IRD_IMPORT_SOURCES);
  const mapping = parseMapping(input.mapping);
  const fileIncomeYear = optionalYear(input.fileIncomeYear);
  const supportingDocumentId = optionalId(input.supportingDocumentId, "supportingDocumentId");
  const saveMappingAs = optionalString(input.saveMappingAs, "saveMappingAs", { maxLength: 100 });
  const hash = requestHash("ird_import", { sha256: file.sha256, fileName: file.fileName, source, mapping, fileIncomeYear, supportingDocumentId });
  const existing = await tx.query<ImportRow>(`${IMPORT_SELECT} where i.idempotency_key = $1`, [idempotencyKey]);
  if (existing.rows[0]) {
    assertSameRequest(existing.rows[0].request_hash, hash, "IRD import");
    return { created: false, import: await toImport(tx, existing.rows[0]) };
  }
  const before = await tx.query<{ created_at: string; created_by_email: string | null; file_name: string }>(
    "select i.created_at, i.created_by_email, d.file_name from ird_imports i join ird_documents d on d.id = i.document_id where i.sha256 = $1",
    [file.sha256],
  );
  if (before.rows[0]) {
    const at = new Date(before.rows[0].created_at).toISOString().slice(0, 10);
    throw new ConflictError(`This file was already imported (as ${before.rows[0].file_name}, on ${shortDate(at)}${before.rows[0].created_by_email ? ` by ${before.rows[0].created_by_email}` : ""}). Its rows are below.`);
  }
  if (supportingDocumentId) {
    const supporting = await getIrdDocument(tx, supportingDocumentId);
    if (supporting.removed) throw new ValidationError(`${supporting.fileName} was removed, so the import can't link to it.`);
  }
  const result = preview(file.rows, mapping, fileIncomeYear, await financialYearEndMonth(tx));
  if (result.mappingProblems.length > 0) throw new ValidationError(result.mappingProblems.join(" "));
  const bad = result.rows.find((row) => row.problems.length > 0);
  if (bad) throw new ValidationError(`Row ${bad.row}: ${bad.problems.join(" ")} (${result.counts.withProblems} row${result.counts.withProblems === 1 ? " has" : "s have"} a problem.)`);
  const keep = result.rows.filter((row) => !row.skipped);
  if (keep.length === 0) throw new ValidationError("No rows to bring in: every row is left out.");

  const document = await tx.query<{ id: string }>(
    `insert into ird_documents (idempotency_key, request_hash, file_name, content_type, byte_size, sha256, content, income_year, note, created_by_email)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id::text`,
    [
      `ird-import-file-${idempotencyKey}`,
      requestHash("ird_document", { fileName: file.fileName, sha256: file.sha256, incomeYear: fileIncomeYear, note: "imported" }),
      file.fileName,
      file.contentType,
      file.bytes.length,
      file.sha256,
      file.bytes,
      fileIncomeYear,
      source === "myir_export" ? "Imported: a myIR download" : "Imported: a spreadsheet (not IRD's own file)",
      tx.actor.email,
    ],
  );
  const documentId = document.rows[0].id;
  const inserted = await tx.query<{ id: string }>(
    `insert into ird_imports (idempotency_key, request_hash, document_id, sha256, source, supporting_document_id, mapping, mapping_name, file_income_year, created_by_email)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10) returning id::text`,
    [idempotencyKey, hash, documentId, file.sha256, source, supportingDocumentId, JSON.stringify(mapping), saveMappingAs, fileIncomeYear, tx.actor.email],
  );
  const importId = inserted.rows[0].id;
  for (const row of keep) {
    await tx.query(
      `insert into ird_import_rows (import_id, row_number, kind, income_year, transaction_on, effective_on, direction, amount, applies_to, applies_to_text, period_text, description, reference, cells)
       values ($1, $2, $3, $4, $5, $6, $7, $8::numeric, $9, $10, $11, $12, $13, $14::jsonb)`,
      [importId, row.row, row.kind, row.incomeYear, row.transactionOn, row.effectiveOn, row.direction, row.amount, row.appliesTo, row.appliesToText?.slice(0, 200) ?? null, row.periodText?.slice(0, 200) ?? null, row.description, row.reference, JSON.stringify(row.cells)],
    );
  }
  if (saveMappingAs) await saveIrdMapping(tx, { name: saveMappingAs, headings: result.headings, mapping });
  await writeAuditEvent(tx, {
    eventType: "income_tax.ird_file_imported",
    entityType: "ird_import",
    entityId: importId,
    details: { fileName: file.fileName, sha256: file.sha256, source, documentId, supportingDocumentId, rows: keep.length, skipped: result.counts.skipped, mappingName: saveMappingAs },
  });
  return { created: true, import: await getIrdImport(tx, importId) };
}

// --- Accepting and declining ----------------------------------------------------

async function lockWaitingRow(tx: OrgTx, idInput: unknown): Promise<RowRow & { source: IrdImportSource; document_id: string; file_name: string }> {
  const id = requireId(idInput, "rowId");
  await tx.query("select 1 from ird_import_rows where id = $1 for update", [id]);
  const found = await tx.query<RowRow & { source: IrdImportSource; document_id: string; file_name: string }>(
    `select ${ROW_COLUMNS}, i.source, i.document_id::text, d.file_name from ird_import_rows r join ird_imports i on i.id = r.import_id join ird_documents d on d.id = i.document_id where r.id = $1`,
    [id],
  );
  const row = found.rows[0];
  if (!row) throw new NotFoundError("Imported row not found.");
  if (row.status !== "waiting") throw new ConflictError(`Row ${row.row_number} was already ${row.status}.`);
  return row;
}

function fromWords(row: { source: IrdImportSource; file_name: string; row_number: number }): string {
  return row.source === "myir_export" ? `IRD's file ${row.file_name}, row ${row.row_number}` : `${row.file_name} (a spreadsheet, not IRD's own file), row ${row.row_number}`;
}

/**
 * A person accepts an imported row (ITX-IMP6 to ITX-IMP10):
 * - a payment (a credit) is added as an income tax payment, or linked to the
 *   same payment already in Tohyee; it's allocated only when the row says
 *   which instalment it's for, otherwise it's awaiting reconciliation;
 * - an assessment can be saved as the year's assessed RIT, with the date the
 *   return was filed, only when the person says that's what it is;
 * - anything else is recorded as IRD's figure for the year and changes
 *   nothing else.
 */
export async function acceptImportRow(tx: OrgTx, idInput: unknown, input: { useAsAssessedRit?: unknown; returnFiledOn?: unknown; asNewPayment?: unknown } = {}): Promise<IrdImportRow> {
  if (tx.actor.via) throw new ValidationError("Only a person can accept imported IRD figures, in Tohyee.");
  const useAsAssessedRit = optionalBoolean(input.useAsAssessedRit, "useAsAssessedRit") ?? false;
  const asNewPayment = optionalBoolean(input.asNewPayment, "asNewPayment") ?? false;
  const row = await lockWaitingRow(tx, idInput);
  const sameAs = await sameAccepted(tx, row);
  if (sameAs) throw new ConflictError(`Row ${row.row_number} looks the same as row ${sameAs.row} of ${sameAs.fileName}, which was already accepted. Decline it if it's the same transaction.`);
  const from = fromWords(row);
  let outcome: string;
  let paymentId: string | null = null;
  let allocationId: string | null = null;
  let setRit = false;
  if (useAsAssessedRit && row.kind !== "assessment") throw new ValidationError("Only an assessment can be used as the assessed RIT.");
  if (row.kind === "payment" && row.direction === "credit") {
    const match = asNewPayment ? null : await matchingPayment(tx, row, { lock: true });
    if (match) {
      paymentId = match.id;
      outcome = `Linked to the payment of ${money(dec(match.amount))} on ${shortDate(match.paid_on)} already in Tohyee, so it isn't counted twice.`;
      if (row.effective_on && !match.ird_effective_on) {
        await setEffectiveDate(tx, { paymentId: match.id, irdEffectiveOn: row.effective_on });
        outcome += ` IRD's effective date ${shortDate(row.effective_on)} added.`;
      }
    } else {
      const added = await addPayment(tx, {
        idempotencyKey: `ird-import-row-${row.id}`,
        incomeYear: row.income_year,
        paidOn: irdDate(row),
        irdEffectiveOn: row.effective_on,
        amount: row.amount,
        note: `From ${from}; accepted by ${tx.actor.email}`.slice(0, 200),
      });
      paymentId = added.payment.id;
      outcome = `Added as a payment of ${money(dec(row.amount))} on ${shortDate(irdDate(row))}${row.effective_on ? "" : " (the file's date; no effective date)"}.`;
    }
    if (row.applies_to) {
      const current = await tx.query<{ amount: string }>("select amount::text from income_tax_payment_allocations where payment_id = $1 and replaced_at is null", [paymentId]);
      if (current.rows.length > 0) {
        outcome += ` It was already allocated, so that's kept; the file says ${APPLIES_TO_LABELS[row.applies_to]} ("${row.applies_to_text}"). Change the allocation if the file is right.`;
      } else {
        const status = row.source === "myir_export" ? "confirmed" : "evidenced";
        const allocation = await addAllocation(tx, {
          idempotencyKey: `ird-import-allocation-${row.id}`,
          paymentId,
          appliesTo: row.applies_to,
          amount: row.amount,
          status,
          basis: `${from}: "${row.applies_to_text}"`.slice(0, 300),
          irdDocumentId: row.document_id,
        });
        allocationId = allocation.allocation.id;
        outcome += ` ${status === "confirmed" ? "Confirmed by IRD" : "Allocated with this file as evidence"}: towards ${APPLIES_TO_LABELS[row.applies_to]}.`;
      }
    } else {
      const allocated = await tx.query<{ total: string }>("select coalesce(sum(amount), 0)::text as total from income_tax_payment_allocations where payment_id = $1 and replaced_at is null and status <> 'forecast'", [paymentId]);
      const left = sub(dec(row.amount), dec(allocated.rows[0].total));
      if (cmp(left, ZERO_DECIMAL) > 0) outcome += ` The file doesn't say which instalment it's for, so ${money(left)} is awaiting reconciliation.`;
    }
  } else if (row.kind === "payment") {
    outcome = "Recorded only: a payment going the other way (reversed, dishonoured or refunded). Find the payment it undoes and remove or reallocate it yourself.";
  } else if (row.kind === "assessment" && useAsAssessedRit) {
    if (row.direction !== "debit") throw new ValidationError("That assessment is a credit (a reduction), so it can't be the assessed RIT. Accept it as a record only.");
    const returnFiledOn = parseIsoDate(input.returnFiledOn, "returnFiledOn");
    const year = await getIncomeTaxYear(tx, row.income_year);
    await saveIncomeTaxYear(tx, {
      incomeYear: row.income_year,
      assessedRit: row.amount,
      returnFiledOn,
      lossesBroughtForward: year.lossesBroughtForward,
      taxCredits: year.taxCredits,
      imputationCredits: year.imputationCredits,
      overseasTaxPaid: year.overseasTaxPaid,
      imputationBroughtForward: year.imputationBroughtForward,
      otherIncome: year.otherIncome,
      multipleActivity: year.multipleActivity,
      version: year.version,
    });
    setRit = true;
    outcome = `Saved as the ${row.income_year} assessed RIT (${money(dec(row.amount))}, return filed ${shortDate(returnFiledOn)})${year.assessedRit !== null ? `, replacing ${money(dec(year.assessedRit))}` : ""}.`;
  } else {
    outcome = `Recorded as IRD's ${IRD_ROW_KIND_LABELS[row.kind].toLowerCase()} for the ${row.income_year} income year. Nothing else changed.`;
  }
  await tx.query(
    "update ird_import_rows set status = 'accepted', decided_by_email = $2, decided_at = now(), outcome = $3, payment_id = $4, allocation_id = $5, set_assessed_rit = $6 where id = $1",
    [row.id, tx.actor.email, outcome.slice(0, 500), paymentId, allocationId, setRit],
  );
  await writeAuditEvent(tx, {
    eventType: "income_tax.ird_row_accepted",
    entityType: "ird_import_row",
    entityId: row.id,
    details: { importId: row.import_id, row: row.row_number, kind: row.kind, incomeYear: row.income_year, amount: row.amount, direction: row.direction, paymentId, allocationId, setAssessedRit: setRit, outcome },
  });
  return withChecks(tx, (await tx.query<RowRow>(`select ${ROW_COLUMNS} from ird_import_rows r where r.id = $1`, [row.id])).rows[0]);
}

/** Accepts several rows at once (no assessment is saved as the RIT this way). Each is accepted as `acceptImportRow` would. */
export async function acceptImportRows(tx: OrgTx, input: { rowIds: unknown }): Promise<IrdImportRow[]> {
  const ids = requireArray(input.rowIds, "rowIds", 500).map((id) => requireId(id, "rowId"));
  if (ids.length === 0) throw new ValidationError("Choose the rows to accept.");
  const accepted: IrdImportRow[] = [];
  for (const id of ids) accepted.push(await acceptImportRow(tx, id));
  return accepted;
}

/** A person declines an imported row, with a reason (ITX-IMP10). */
export async function declineImportRow(tx: OrgTx, idInput: unknown, input: { reason: unknown }): Promise<IrdImportRow> {
  if (tx.actor.via) throw new ValidationError("Only a person can decline imported IRD figures, in Tohyee.");
  const reason = requireString(input.reason, "reason", { maxLength: 500 });
  const row = await lockWaitingRow(tx, idInput);
  await tx.query("update ird_import_rows set status = 'declined', decided_by_email = $2, decided_at = now(), decline_reason = $3 where id = $1", [row.id, tx.actor.email, reason]);
  await writeAuditEvent(tx, { eventType: "income_tax.ird_row_declined", entityType: "ird_import_row", entityId: row.id, details: { importId: row.import_id, row: row.row_number, reason } });
  return withChecks(tx, (await tx.query<RowRow>(`select ${ROW_COLUMNS} from ird_import_rows r where r.id = $1`, [row.id])).rows[0]);
}

// --- IRD's figures for a year, from accepted rows -----------------------------

export type ImportedFigures = {
  incomeYear: number;
  /** By kind: debits and credits accepted, and the net (debits less credits). */
  byKind: Array<{ kind: IrdRowKind; debits: string; credits: string; net: string; rows: number }>;
  /** Accepted rows from IRD's own files, and from other spreadsheets. */
  fromIrd: number;
  fromOther: number;
};

/** IRD's figures for an income year, from accepted imported rows only (ITX-IMP11). */
export async function importedFigures(tx: OrgTx, incomeYearInput: unknown): Promise<ImportedFigures> {
  const incomeYear = requireIncomeYear(incomeYearInput);
  const result = await tx.query<{ kind: IrdRowKind; direction: "debit" | "credit"; amount: string; source: IrdImportSource }>(
    "select r.kind, r.direction, r.amount::text, i.source from ird_import_rows r join ird_imports i on i.id = r.import_id where r.status = 'accepted' and r.income_year = $1 order by r.id",
    [incomeYear],
  );
  const byKind = IRD_ROW_KINDS.map((kind) => {
    const rows = result.rows.filter((row) => row.kind === kind);
    const debits = rows.filter((row) => row.direction === "debit").reduce((total, row) => add(total, dec(row.amount)), ZERO_DECIMAL);
    const credits = rows.filter((row) => row.direction === "credit").reduce((total, row) => add(total, dec(row.amount)), ZERO_DECIMAL);
    return { kind, debits: money(debits), credits: money(credits), net: money(sub(debits, credits)), rows: rows.length };
  }).filter((entry) => entry.rows > 0);
  return { incomeYear, byKind, fromIrd: result.rows.filter((row) => row.source === "myir_export").length, fromOther: result.rows.filter((row) => row.source !== "myir_export").length };
}
