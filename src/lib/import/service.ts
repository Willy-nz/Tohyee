import { type Account, createAccount, listAccounts, parseAccountCodeInput, updateAccount } from "@/lib/accounts/service";
import { ACCOUNT_TYPES, type AccountType, type SystemKey } from "@/lib/accounts/types";
import { writeAuditEvent } from "@/lib/audit";
import { type Contact, type ContactInput, createContact, listContacts, updateContact } from "@/lib/contacts/service";
import { loadCustomFieldContext } from "@/lib/custom-fields/service";
import type { CustomField } from "@/lib/custom-fields/values";
import type { OrgTx } from "@/lib/db/org-transaction";
import { HttpError, ValidationError } from "@/lib/errors";
import {
  IMPORT_FIELDS,
  IMPORT_KINDS,
  IMPORT_PRESETS,
  type ImportKind,
  type ImportMapping,
  type ImportOptions,
  type ImportRecord,
} from "@/lib/import/fields";
import { accountType, date, itemType, number, TaxCodeFinder, yesNo } from "@/lib/import/values";
import { createItem, type Item, type ItemInput, ITEM_PRICE_SCALE, listItems, updateItem } from "@/lib/items/service";
import { ITEM_TYPE_LABELS } from "@/lib/items/pricing";
import { requireArray, requireIdempotencyKey, requireOneOf } from "@/lib/validation";

/**
 * Bringing in the chart of accounts, contacts, and products and services
 * (examples IM1-IM4, IM13-IM16), and writing them out again as CSV.
 *
 * Every row goes through the ordinary services (createAccount, createContact,
 * createItem and their updates), so every rule that applies when someone
 * types it in applies here. Each row runs in its own savepoint, so one bad
 * row doesn't hide the problems in the rows after it; but if any row is
 * refused, the whole file is rolled back and nothing is imported (no partial
 * imports). A preview runs exactly the same way and always rolls back.
 */

export type MasterKind = "accounts" | "contacts" | "items";
export const MASTER_KINDS: readonly MasterKind[] = ["accounts", "contacts", "items"];

export type RowOutcome = {
  row: number;
  /** What the row is, e.g. "1100 Accounts receivable" or "Kobe Ltd". */
  label: string;
  action: "create" | "update" | "unchanged";
  detail?: string;
};

export type RowProblem = { row: number; message: string; kind?: ImportKind };

export type ImportResult = {
  kind: MasterKind;
  /** True once the rows are saved; a preview, or a file with any problem, saves nothing. */
  committed: boolean;
  outcomes: RowOutcome[];
  problems: RowProblem[];
  counts: { create: number; update: number; unchanged: number };
};

const MAX_RECORDS = 5000;

/** Checks records sent by the import screen: `[{ row, values: { field: text } }]`. */
export function parseRecords(input: unknown, label = "records"): ImportRecord[] {
  return requireArray(input, label, MAX_RECORDS).map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ValidationError(`${label} ${index + 1} must be an object.`);
    const entry = raw as Record<string, unknown>;
    const row = Number(entry.row);
    if (!Number.isInteger(row) || row < 1) throw new ValidationError(`${label} ${index + 1} needs its row number.`);
    const values: Record<string, string> = {};
    if (entry.values && typeof entry.values === "object" && !Array.isArray(entry.values)) {
      for (const [key, value] of Object.entries(entry.values as Record<string, unknown>)) {
        if (value === null || value === undefined) continue;
        if (typeof value !== "string" && typeof value !== "number") throw new ValidationError(`Row ${row}: ${key} must be text.`);
        const text = String(value);
        if (text.length > 4000) throw new ValidationError(`Row ${row}: ${key} is too long.`);
        values[key] = text.trim();
      }
    }
    return { row, values };
  });
}

export function parseOptions(input: unknown): ImportOptions {
  const raw = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const options: ImportOptions = {};
  if (raw.dateOrder != null && raw.dateOrder !== "") options.dateOrder = requireOneOf(raw.dateOrder, "dateOrder", ["dmy", "mdy", "ymd"] as const);
  if (raw.defaultRole != null && raw.defaultRole !== "") {
    options.defaultRole = requireOneOf(raw.defaultRole, "defaultRole", ["customer", "supplier", "both", "neither"] as const);
  }
  return options;
}

/** A refusal that belongs to a row: one of Tohyee's own errors, or a database rule. */
export function isRowProblem(error: unknown): boolean {
  if (error instanceof HttpError) return error.status < 500;
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" && /^(23|22)|^P0001$/.test(code);
}

export function problemMessage(error: unknown): string {
  return error instanceof Error ? error.message : "This row was refused.";
}

type Applier = (record: ImportRecord) => Promise<RowOutcome>;

/**
 * Runs `apply` for every record inside one savepoint for the file and one per
 * row. Saved only when `commit` is set and no row was refused.
 */
async function runRows(tx: OrgTx, records: readonly ImportRecord[], apply: Applier, commit: boolean, earlier: RowProblem[]) {
  const outcomes: RowOutcome[] = [];
  const problems: RowProblem[] = [...earlier];
  await tx.query("savepoint import_file");
  for (const record of records) {
    if (earlier.some((problem) => problem.row === record.row)) continue;
    await tx.query("savepoint import_row");
    try {
      outcomes.push(await apply(record));
      await tx.query("release savepoint import_row");
    } catch (error) {
      if (!isRowProblem(error)) throw error;
      await tx.query("rollback to savepoint import_row");
      await tx.query("release savepoint import_row");
      problems.push({ row: record.row, message: problemMessage(error) });
    }
  }
  const committed = commit && problems.length === 0;
  if (!committed) await tx.query("rollback to savepoint import_file");
  await tx.query("release savepoint import_file");
  problems.sort((a, b) => a.row - b.row);
  return { outcomes, problems, committed };
}

/** The same key twice in one file (code or name, ignoring case) is refused on the later rows. */
function duplicates(records: readonly ImportRecord[], field: string, what: string): RowProblem[] {
  const seen = new Map<string, number>();
  const problems: RowProblem[] = [];
  for (const record of records) {
    const value = (record.values[field] ?? "").trim().toLowerCase();
    if (!value) continue;
    const first = seen.get(value);
    if (first !== undefined) problems.push({ row: record.row, message: `${what} ${record.values[field]} is on row ${first} too. Each can be in the file once.` });
    else seen.set(value, record.row);
  }
  return problems;
}

const given = (values: Record<string, string>, field: string): string | undefined => {
  const text = values[field];
  return text === undefined || text.trim() === "" ? undefined : text.trim();
};

// ---------------------------------------------------------------------------
// Chart of accounts (IM2)

/** Names another system gives the accounts Tohyee uses for automatic postings. */
const ROLE_NAMES: Record<string, SystemKey> = {
  "accounts receivable": "accounts_receivable",
  debtors: "accounts_receivable",
  "trade debtors": "accounts_receivable",
  "accounts payable": "accounts_payable",
  creditors: "accounts_payable",
  "trade creditors": "accounts_payable",
  gst: "gst",
  "gst payable": "gst",
  "gst account": "gst",
  inventory: "inventory",
  "stock on hand": "inventory",
  "retained earnings": "retained_earnings",
  "historical adjustment": "conversion_clearing",
  "opening balance": "conversion_clearing",
  "opening balance equity": "conversion_clearing",
  "conversion clearing": "conversion_clearing",
};

const ROLE_LABELS: Partial<Record<SystemKey, string>> = {
  accounts_receivable: "accounts receivable",
  accounts_payable: "accounts payable",
  gst: "GST",
  inventory: "inventory",
  retained_earnings: "retained earnings",
  conversion_clearing: "historical adjustment",
};

function accountsApplier(tx: OrgTx, accounts: Account[], taxCodes: TaxCodeFinder): Applier {
  const byCode = new Map(accounts.map((account) => [account.code.toLowerCase(), account]));
  const bySystemKey = new Map(accounts.filter((account) => account.systemKey).map((account) => [account.systemKey!, account]));
  const remember = (account: Account, oldCode?: string) => {
    if (oldCode) byCode.delete(oldCode.toLowerCase());
    byCode.set(account.code.toLowerCase(), account);
    if (account.systemKey) bySystemKey.set(account.systemKey, account);
  };
  return async ({ values }) => {
    const code = parseAccountCodeInput(values.code, "Code");
    const name = given(values, "name");
    const typeText = given(values, "type");
    const type: AccountType | undefined = typeText ? accountType(typeText) : undefined;
    const gstText = given(values, "gstCode");
    const defaultTaxCode = gstText === undefined ? undefined : taxCodes.find(gstText, "GST code");
    const description = given(values, "description");
    const label = `${code}${name ? ` ${name}` : ""}`;

    let existing = byCode.get(code.toLowerCase());
    let recoded: string | undefined;
    if (!existing && name) {
      // Another system's accounts receivable (say 610) is Tohyee's 1100: it's re-coded, so postings by role still find it.
      const role = ROLE_NAMES[name.toLowerCase().replace(/\s+/g, " ")];
      const system = role ? bySystemKey.get(role) : undefined;
      if (system && role) {
        existing = system;
        recoded = `Tohyee's ${ROLE_LABELS[role]} account, re-coded from ${system.code}`;
      }
    }
    if (existing) {
      // Another system's historical adjustment account is often a current liability (Xero's 840); Tohyee's stays equity (IM1).
      const keepsType = existing.systemKey === "conversion_clearing" && type !== undefined && type !== existing.accountType;
      if (existing.systemKey && type && type !== existing.accountType && !keepsType) {
        throw new ValidationError(
          `${existing.code} (${existing.name}) is used by Tohyee for automatic postings, so its type stays ${ACCOUNT_TYPES[existing.accountType].label}, not ${ACCOUNT_TYPES[type].label}.`,
        );
      }
      const changes: Record<string, unknown> = {};
      if (existing.code !== code) changes.code = code;
      if (name && name !== existing.name) changes.name = name;
      if (type && type !== existing.accountType && !keepsType) changes.accountType = type;
      if (description !== undefined && description !== existing.description) changes.description = description;
      if (defaultTaxCode !== undefined && defaultTaxCode !== existing.defaultTaxCode) changes.defaultTaxCode = defaultTaxCode;
      if (Object.keys(changes).length === 0) return { row: 0, label, action: "unchanged" };
      const updated = await updateAccount(tx, existing.id, changes);
      remember(updated, existing.code);
      const names: Record<string, string> = { code: "code", name: "name", accountType: "type", description: "description", defaultTaxCode: "GST code" };
      const kept = keepsType ? ` (it stays ${ACCOUNT_TYPES[existing.accountType].label}, not ${ACCOUNT_TYPES[type!].label})` : "";
      return { row: 0, label, action: "update", detail: `${recoded ?? `Changes its ${Object.keys(changes).map((field) => names[field]).join(", ")}`}${kept}` };
    }
    if (!name) throw new ValidationError("Name is needed for a new account.");
    if (!type) throw new ValidationError("Type is needed for a new account (for example Expense or Current asset).");
    const created = await createAccount(tx, { code, name, accountType: type, description, defaultTaxCode });
    remember(created);
    return { row: 0, label, action: "create" };
  };
}

// ---------------------------------------------------------------------------
// Contacts (IM3)

/** A custom field's value from a cell: options by name, yes/no for a tick box, dates as written. */
function customValue(field: CustomField, text: string, dateOrder: ImportOptions["dateOrder"]): unknown {
  const option = (name: string) => {
    const found = field.options.find((entry) => entry.name.toLowerCase() === name.trim().toLowerCase());
    if (!found) throw new ValidationError(`${field.label}: "${name}" isn't one of its options.`);
    return found.id;
  };
  switch (field.type) {
    case "checkbox":
      return yesNo(text, field.label);
    case "list":
      return option(text);
    case "multi_select":
      return text
        .split(/[;,\n]/)
        .map((part) => part.trim())
        .filter(Boolean)
        .map(option);
    case "date":
      return date(text, field.label, dateOrder);
    default:
      return text;
  }
}

async function contactsApplier(tx: OrgTx, options: ImportOptions, idempotencyKey: string): Promise<Applier> {
  const contacts = await listContacts(tx);
  const byName = new Map(contacts.map((contact) => [contact.name.toLowerCase(), contact]));
  const terms = await tx.query<{ id: string; name: string }>("select id, name from payment_terms where is_active");
  const termByName = new Map(terms.rows.map((row) => [row.name.toLowerCase(), row.id]));
  const customCtx = await loadCustomFieldContext(tx);
  const role = options.defaultRole ?? "customer";
  return async ({ row, values }) => {
    const name = given(values, "name");
    if (!name) throw new ValidationError("Name is required.");
    const input: ContactInput = {};
    const customerText = given(values, "isCustomer");
    const supplierText = given(values, "isSupplier");
    if (customerText !== undefined) input.isCustomer = yesNo(customerText, "Customer");
    if (supplierText !== undefined) input.isSupplier = yesNo(supplierText, "Supplier");
    for (const field of ["email", "phone", "postalAddress", "deliveryAddress", "gstNumber"] as const) {
      const text = given(values, field);
      if (text !== undefined) input[field] = text;
    }
    const termText = given(values, "paymentTerms");
    if (termText !== undefined) {
      const termId = termByName.get(termText.toLowerCase());
      if (!termId) throw new ValidationError(`There are no payment terms called "${termText}". Add them under Payment terms and customers first.`);
      input.paymentTermId = termId;
    }
    const custom: Record<string, unknown> = {};
    for (const [key, text] of Object.entries(values)) {
      if (!key.startsWith("custom:") || !text.trim()) continue;
      const field = customCtx.fields.get(key.slice("custom:".length));
      if (!field) throw new ValidationError(`There's no custom field ${key.slice(7)}.`);
      custom[field.id] = customValue(field, text, options.dateOrder);
    }

    const existing = byName.get(name.toLowerCase());
    if (existing) {
      if (Object.keys(custom).length > 0) input.customFields = { ...existing.customFields, ...custom };
      const updated = await updateContact(tx, existing.id, input);
      byName.set(updated.name.toLowerCase(), updated);
      const same = JSON.stringify(updated) === JSON.stringify(existing);
      return { row, label: name, action: same ? "unchanged" : "update" };
    }
    const flags = {
      isCustomer: input.isCustomer ?? (role === "customer" || role === "both"),
      isSupplier: input.isSupplier ?? (role === "supplier" || role === "both"),
    };
    const created = await createContact(tx, {
      source: "import",
      idempotencyKey: `${idempotencyKey}:contact:${row}`,
      name,
      ...input,
      ...flags,
      ...(Object.keys(custom).length > 0 ? { customFields: custom } : {}),
    });
    byName.set(created.contact.name.toLowerCase(), created.contact);
    return { row, label: name, action: "create" };
  };
}

// ---------------------------------------------------------------------------
// Products and services (IM4)

async function itemsApplier(tx: OrgTx, idempotencyKey: string, taxCodes: TaxCodeFinder): Promise<Applier> {
  const list = await listItems(tx, { includeArchived: true });
  const byCode = new Map(list.items.map((item) => [item.code.toLowerCase(), item]));
  return async ({ row, values }) => {
    const code = given(values, "code");
    if (!code) throw new ValidationError("Code is required.");
    const input: ItemInput = {};
    const name = given(values, "name");
    if (name !== undefined) input.name = name;
    const description = given(values, "description");
    if (description !== undefined) input.description = description;
    const unit = given(values, "unit");
    if (unit !== undefined) input.baseUnit = unit;
    const typeText = given(values, "type");
    const inventoryAccount = given(values, "inventoryAccount");
    if (typeText !== undefined) input.itemType = itemType(typeText);
    else if (inventoryAccount !== undefined) input.itemType = "stock";
    for (const [field, key] of [
      ["salePrice", "salePrice"],
      ["purchasePrice", "purchasePrice"],
    ] as const) {
      const text = given(values, field);
      if (text !== undefined) input[key] = number(text, field === "salePrice" ? "Sale price" : "Purchase price", ITEM_PRICE_SCALE);
    }
    const incomeAccount = given(values, "incomeAccount");
    if (incomeAccount !== undefined) input.incomeAccountCode = incomeAccount;
    const purchaseAccount = given(values, "purchaseAccount");
    if (purchaseAccount !== undefined) input.purchaseAccountCode = purchaseAccount;
    else if (input.itemType === "stock" && inventoryAccount !== undefined) input.purchaseAccountCode = inventoryAccount;
    const salesTax = given(values, "salesTaxCode");
    if (salesTax !== undefined) input.salesTaxCode = taxCodes.find(salesTax, "Sales GST code");
    const purchaseTax = given(values, "purchaseTaxCode");
    if (purchaseTax !== undefined) input.purchaseTaxCode = taxCodes.find(purchaseTax, "Purchase GST code");

    const existing = byCode.get(code.toLowerCase());
    if (existing) {
      const updated = await updateItem(tx, existing.id, input);
      byCode.set(updated.code.toLowerCase(), updated);
      return { row, label: `${updated.code} ${updated.name}`, action: JSON.stringify(updated) === JSON.stringify(existing) ? "unchanged" : "update" };
    }
    if (input.itemType === undefined) {
      // Another system's export says whether stock is tracked but not whether an item is a product or a service.
      input.itemType = input.purchasePrice !== undefined || input.purchaseAccountCode !== undefined ? "non_stock" : "service";
    }
    const created = await createItem(tx, {
      source: "import",
      idempotencyKey: `${idempotencyKey}:item:${row}`,
      code,
      ...input,
      name: input.name ?? code,
    });
    byCode.set(created.item.code.toLowerCase(), created.item);
    return { row, label: `${created.item.code} ${created.item.name}`, action: "create" };
  };
}

// ---------------------------------------------------------------------------

/**
 * Checks (`commit` false) or imports (`commit` true) one file of accounts,
 * contacts or items. Accounts and items are matched by code and contacts by
 * name (ignoring case): a match is updated with the columns that have
 * something in them (blank cells change nothing), anything else is added, and
 * nothing is ever deleted. Admins and owners only (the route checks).
 */
export async function importMasterRecords(
  tx: OrgTx,
  input: { kind: unknown; records: unknown; options?: unknown; idempotencyKey: unknown; commit: boolean; mapping?: unknown },
): Promise<ImportResult> {
  const kind = requireOneOf(input.kind, "kind", MASTER_KINDS);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const records = parseRecords(input.records);
  const options = parseOptions(input.options);
  if (records.length === 0) throw new ValidationError("The file has no rows to import.");

  let apply: Applier;
  let earlier: RowProblem[];
  if (kind === "accounts") {
    apply = accountsApplier(tx, await listAccounts(tx, { includeArchived: true }), await TaxCodeFinder.load(tx));
    earlier = duplicates(records, "code", "Code");
  } else if (kind === "contacts") {
    apply = await contactsApplier(tx, options, idempotencyKey);
    earlier = duplicates(records, "name", "Contact");
  } else {
    apply = await itemsApplier(tx, idempotencyKey, await TaxCodeFinder.load(tx));
    earlier = duplicates(records, "code", "Code");
  }
  const applyWithRow: Applier = async (record) => ({ ...(await apply(record)), row: record.row });
  const result = await runRows(tx, records, applyWithRow, input.commit, earlier);
  const counts = { create: 0, update: 0, unchanged: 0 };
  for (const outcome of result.outcomes) counts[outcome.action] += 1;
  if (result.committed) {
    if (input.mapping !== undefined) await saveMapping(tx, kind, input.mapping);
    await writeAuditEvent(tx, { eventType: `import.${kind}`, entityType: "import", entityId: kind, details: { rows: records.length, ...counts } });
  }
  return { kind, committed: result.committed, outcomes: result.outcomes, problems: result.problems, counts };
}

// ---------------------------------------------------------------------------
// Saved mappings

type MappingRow = { kind: ImportKind; preset: ImportMapping["preset"]; columns: Record<string, string[]>; options: ImportOptions };

/** The column mapping last used for each kind of file (per organisation). */
export async function getMappings(tx: OrgTx): Promise<Partial<Record<ImportKind, ImportMapping>>> {
  const result = await tx.query<MappingRow>("select kind, preset, columns, options from import_mappings");
  return Object.fromEntries(result.rows.map((row) => [row.kind, { preset: row.preset, columns: row.columns, options: row.options ?? {} }]));
}

export async function saveMapping(tx: OrgTx, kindInput: unknown, input: unknown): Promise<ImportMapping> {
  const kind = requireOneOf(kindInput, "kind", IMPORT_KINDS);
  const raw = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : null;
  if (!raw) throw new ValidationError("mapping must be an object.");
  const preset = requireOneOf(raw.preset, "preset", IMPORT_PRESETS);
  const known = new Set(IMPORT_FIELDS[kind].map((field) => field.key));
  const columns: Record<string, string[]> = {};
  const rawColumns = raw.columns && typeof raw.columns === "object" && !Array.isArray(raw.columns) ? (raw.columns as Record<string, unknown>) : {};
  for (const [field, names] of Object.entries(rawColumns)) {
    if (!known.has(field) && !(kind === "contacts" && /^custom:[1-9]\d{0,17}$/.test(field))) throw new ValidationError(`${field} isn't a field of this file.`);
    if (!Array.isArray(names) || names.length > 20 || names.some((name) => typeof name !== "string" || name.length > 200)) {
      throw new ValidationError(`The columns for ${field} must be a list of headings.`);
    }
    if (names.length > 0) columns[field] = names as string[];
  }
  const options = parseOptions(raw.options);
  await tx.query(
    `insert into import_mappings (kind, preset, columns, options, updated_by_email, updated_at)
     values ($1, $2, $3::jsonb, $4::jsonb, $5, now())
     on conflict (kind) do update set preset = excluded.preset, columns = excluded.columns, options = excluded.options,
       updated_by_email = excluded.updated_by_email, updated_at = now()`,
    [kind, preset, JSON.stringify(columns), JSON.stringify(options), tx.actor.email],
  );
  return { preset, columns, options };
}

// ---------------------------------------------------------------------------
// Exports (IM16): the chart of accounts, contacts and items as CSV, with the
// headings the import reads, so a file can be checked or edited and brought
// back in.

function csvCell(value: string | null | undefined): string {
  const text = value ?? "";
  return /[",\n\r]/.test(text) || /^\s|\s$/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(rows: ReadonlyArray<ReadonlyArray<string | null | undefined>>): string {
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

const labelOf = (kind: MasterKind, key: string) => IMPORT_FIELDS[kind].find((field) => field.key === key)!.label;

export async function exportCsv(tx: OrgTx, kindInput: unknown): Promise<{ fileName: string; csv: string }> {
  const kind = requireOneOf(kindInput, "kind", MASTER_KINDS);
  const yes = (value: boolean) => (value ? "Yes" : "No");
  if (kind === "accounts") {
    const keys = ["code", "name", "type", "gstCode", "description"];
    const accounts = await listAccounts(tx);
    return {
      fileName: "chart-of-accounts.csv",
      csv: toCsv([
        keys.map((key) => labelOf(kind, key)),
        ...accounts.map((account) => [account.code, account.name, ACCOUNT_TYPES[account.accountType].label, account.defaultTaxCode, account.description]),
      ]),
    };
  }
  if (kind === "contacts") {
    const keys = ["name", "isCustomer", "isSupplier", "email", "phone", "postalAddress", "deliveryAddress", "gstNumber", "paymentTerms"];
    const contacts: Contact[] = await listContacts(tx);
    const terms = await tx.query<{ id: string; name: string }>("select id, name from payment_terms");
    const termName = new Map(terms.rows.map((row) => [row.id, row.name]));
    return {
      fileName: "contacts.csv",
      csv: toCsv([
        keys.map((key) => labelOf(kind, key)),
        ...contacts.map((contact) => [
          contact.name,
          yes(contact.isCustomer),
          yes(contact.isSupplier),
          contact.email,
          contact.phone,
          contact.postalAddress,
          contact.deliveryAddress,
          contact.gstNumber,
          contact.paymentTermId ? termName.get(contact.paymentTermId) : null,
        ]),
      ]),
    };
  }
  const keys = ["code", "name", "description", "type", "unit", "salePrice", "incomeAccount", "salesTaxCode", "purchasePrice", "purchaseAccount", "purchaseTaxCode"];
  const list = await listItems(tx);
  return {
    fileName: "products-and-services.csv",
    csv: toCsv([
      keys.map((key) => labelOf(kind, key)),
      ...list.items.map((item: Item) => [
        item.code,
        item.name,
        item.description,
        ITEM_TYPE_LABELS[item.itemType],
        item.baseUnit,
        item.salePrice,
        item.incomeAccountCode,
        item.salesTaxCode,
        item.purchasePrice,
        item.purchaseAccountCode,
        item.purchaseTaxCode,
      ]),
    ]),
  };
}
