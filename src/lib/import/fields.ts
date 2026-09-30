/**
 * Bringing in existing books (examples IM1-IM16): what each kind of file
 * holds and how its columns are matched to Tohyee's fields. Browser-safe: the
 * import screen maps columns with it, and the server checks the mapped values.
 *
 * Following NetSuite's import assistant: pick a file, map its columns to
 * fields (matched automatically from the headings, saved per organisation),
 * check every row, then import in one go. Two presets: Tohyee's own columns
 * (what the exports write), and another accounting system's standard exports
 * (Xero-style headings such as `*ContactName` or `InvoiceAmountDue`).
 */

export const IMPORT_KINDS = ["accounts", "contacts", "items", "trial_balance", "stock", "open_invoices", "open_bills"] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];

export const IMPORT_KIND_LABELS: Readonly<Record<ImportKind, string>> = {
  accounts: "Chart of accounts",
  contacts: "Contacts",
  items: "Products and services",
  trial_balance: "Trial balance",
  stock: "Stock on hand",
  open_invoices: "Open invoices",
  open_bills: "Open bills",
};

export const IMPORT_PRESETS = ["tohyee", "other_system"] as const;
export type ImportPreset = (typeof IMPORT_PRESETS)[number];

export const IMPORT_PRESET_LABELS: Readonly<Record<ImportPreset, string>> = {
  tohyee: "Tohyee's own columns (or your own spreadsheet)",
  other_system: "From another accounting system (Xero-style export)",
};

export type ImportField = {
  key: string;
  label: string;
  required?: boolean;
  /** Several columns can go into this field, joined with new lines (addresses). */
  multi?: boolean;
  hint?: string;
  /** Headings matched automatically, compared ignoring case, spaces, "*" and punctuation. */
  aliases: string[];
  /** Headings another system's standard export uses, in order (for multi fields, all of them). */
  otherSystem?: string[];
};

const ADDRESS_PARTS = ["AddressLine1", "AddressLine2", "AddressLine3", "AddressLine4", "City", "Region", "PostalCode", "Country"];

export const IMPORT_FIELDS: Readonly<Record<ImportKind, readonly ImportField[]>> = {
  accounts: [
    { key: "code", label: "Code", required: true, aliases: ["code", "account code"], otherSystem: ["*Code"] },
    { key: "name", label: "Name", required: true, aliases: ["name", "account name", "account"], otherSystem: ["*Name"] },
    {
      key: "type",
      label: "Type",
      hint: "Needed for new accounts: Bank, Current asset, Fixed asset, Current liability, Equity, Revenue, Expense, Direct costs…",
      aliases: ["type", "account type"],
      otherSystem: ["*Type"],
    },
    { key: "gstCode", label: "GST code", hint: "GST, ZERO, EXEMPT or NONE, or names like \"15% GST on Income\".", aliases: ["gst code", "tax code", "tax rate", "gst"], otherSystem: ["*Tax Code"] },
    { key: "description", label: "Description", aliases: ["description"], otherSystem: ["Description"] },
  ],
  contacts: [
    { key: "name", label: "Name", required: true, aliases: ["name", "contact name", "contact"], otherSystem: ["*ContactName"] },
    { key: "isCustomer", label: "Customer (yes/no)", aliases: ["customer", "is customer"] },
    { key: "isSupplier", label: "Supplier (yes/no)", aliases: ["supplier", "is supplier"] },
    { key: "email", label: "Email", aliases: ["email", "email address"], otherSystem: ["EmailAddress"] },
    { key: "phone", label: "Phone", aliases: ["phone", "phone number"], otherSystem: ["PhoneNumber"] },
    {
      key: "postalAddress",
      label: "Billing (postal) address",
      multi: true,
      aliases: ["billing address", "postal address", "address"],
      otherSystem: ADDRESS_PARTS.map((part) => `PO${part}`),
    },
    {
      key: "deliveryAddress",
      label: "Delivery address",
      multi: true,
      aliases: ["delivery address", "street address"],
      otherSystem: ADDRESS_PARTS.map((part) => `SA${part}`),
    },
    { key: "gstNumber", label: "GST number", aliases: ["gst number", "tax number", "gst no"], otherSystem: ["TaxNumber"] },
    { key: "paymentTerms", label: "Payment terms", hint: "The name of payment terms set up in Tohyee.", aliases: ["payment terms", "terms"] },
  ],
  items: [
    { key: "code", label: "Code", required: true, aliases: ["code", "item code"], otherSystem: ["*ItemCode"] },
    { key: "name", label: "Name", aliases: ["name", "item name"], otherSystem: ["ItemName"] },
    { key: "description", label: "Description", aliases: ["description", "sales description"], otherSystem: ["SalesDescription"] },
    { key: "type", label: "Type", hint: "Service, Non-stock or Stock.", aliases: ["type", "item type"] },
    {
      key: "inventoryAccount",
      label: "Inventory account",
      hint: "Filled in for items whose stock is tracked; they become stock items.",
      aliases: ["inventory account", "inventory asset account"],
      otherSystem: ["InventoryAssetAccount"],
    },
    { key: "unit", label: "Unit", aliases: ["unit", "base unit"] },
    { key: "salePrice", label: "Sale price (excl. GST)", aliases: ["sale price", "sales price", "sales unit price"], otherSystem: ["SalesUnitPrice"] },
    { key: "incomeAccount", label: "Income account", aliases: ["income account", "sales account"], otherSystem: ["SalesAccount"] },
    { key: "salesTaxCode", label: "Sales GST code", aliases: ["sales gst code", "sales tax code", "sales tax rate"], otherSystem: ["SalesTaxRate"] },
    { key: "purchasePrice", label: "Purchase price (excl. GST)", aliases: ["purchase price", "purchases unit price"], otherSystem: ["PurchasesUnitPrice"] },
    { key: "purchaseAccount", label: "Purchase account", aliases: ["purchase account", "purchases account"], otherSystem: ["PurchasesAccount"] },
    { key: "purchaseTaxCode", label: "Purchase GST code", aliases: ["purchase gst code", "purchase tax code", "purchases tax rate"], otherSystem: ["PurchasesTaxRate"] },
  ],
  trial_balance: [
    { key: "accountCode", label: "Account code", aliases: ["account code", "code"], otherSystem: ["Account Code"] },
    {
      key: "account",
      label: "Account (name)",
      hint: "Used for the code when there's no code column and the name ends with it in brackets, like \"Sales (200)\".",
      aliases: ["account", "account name", "name"],
      otherSystem: ["Account"],
    },
    { key: "debit", label: "Debit", aliases: ["debit", "dr", "debit ytd", "ytd debit", "debit - year to date"], otherSystem: ["Debit - Year to date"] },
    { key: "credit", label: "Credit", aliases: ["credit", "cr", "credit ytd", "ytd credit", "credit - year to date"], otherSystem: ["Credit - Year to date"] },
    { key: "balance", label: "Balance (debits positive)", hint: "Instead of Debit and Credit.", aliases: ["balance", "net", "amount"] },
  ],
  stock: [
    { key: "itemCode", label: "Item code", required: true, aliases: ["item code", "code", "item"], otherSystem: ["*ItemCode", "Item Code"] },
    { key: "location", label: "Location", hint: "Only when stock is kept by location.", aliases: ["location"] },
    { key: "quantity", label: "Quantity", required: true, aliases: ["quantity", "quantity on hand", "qty", "on hand"], otherSystem: ["Quantity"] },
    { key: "value", label: "Value", required: true, aliases: ["value", "total value", "value on hand", "total cost", "asset value"], otherSystem: ["Total"] },
  ],
  open_invoices: [
    { key: "number", label: "Invoice number", required: true, aliases: ["invoice number", "number", "invoice no", "invoice"], otherSystem: ["*InvoiceNumber", "InvoiceNumber"] },
    { key: "contact", label: "Customer", required: true, aliases: ["customer", "contact", "contact name", "name"], otherSystem: ["*ContactName", "ContactName"] },
    { key: "date", label: "Invoice date", required: true, aliases: ["invoice date", "date"], otherSystem: ["*InvoiceDate", "InvoiceDate"] },
    { key: "dueDate", label: "Due date", required: true, aliases: ["due date", "due"], otherSystem: ["*DueDate", "DueDate"] },
    {
      key: "amount",
      label: "Amount still owed (incl. GST)",
      required: true,
      aliases: ["amount due", "amount outstanding", "outstanding", "balance", "amount owed"],
      otherSystem: ["InvoiceAmountDue", "AmountDue"],
    },
    { key: "reference", label: "Reference", aliases: ["reference", "ref"], otherSystem: ["Reference"] },
    {
      key: "gst",
      label: "GST in the amount owed",
      hint: "Needed on the payments basis (0.00 if none). If you also map the invoice total, this can be the whole invoice's GST: the GST in what's owed is worked out in proportion.",
      aliases: ["gst", "gst amount", "gst owed", "tax", "tax amount", "tax total", "gst total"],
      otherSystem: ["TaxTotal"],
    },
    {
      key: "total",
      label: "Invoice total (incl. GST)",
      hint: "Only needed when the GST column is the whole invoice's GST rather than the GST in what's still owed.",
      aliases: ["invoice total", "total", "original amount"],
      otherSystem: ["Total", "InvoiceTotal"],
    },
    {
      key: "gstCode",
      label: "GST code",
      hint: "Instead of a GST amount: GST, ZERO, EXEMPT or NONE, or names like \"15% GST on Income\". With GST, the GST is 3/23 of what's owed.",
      aliases: ["gst code", "tax code", "tax type", "tax rate"],
    },
  ],
  open_bills: [
    { key: "number", label: "Supplier's invoice number", required: true, aliases: ["invoice number", "number", "bill number", "supplier invoice number"], otherSystem: ["*InvoiceNumber", "InvoiceNumber"] },
    { key: "contact", label: "Supplier", required: true, aliases: ["supplier", "contact", "contact name", "name"], otherSystem: ["*ContactName", "ContactName"] },
    { key: "date", label: "Bill date", required: true, aliases: ["bill date", "invoice date", "date"], otherSystem: ["*InvoiceDate", "InvoiceDate"] },
    { key: "dueDate", label: "Due date", required: true, aliases: ["due date", "due"], otherSystem: ["*DueDate", "DueDate"] },
    {
      key: "amount",
      label: "Amount still owed (incl. GST)",
      required: true,
      aliases: ["amount due", "amount outstanding", "outstanding", "balance", "amount owed"],
      otherSystem: ["InvoiceAmountDue", "AmountDue"],
    },
    {
      key: "gst",
      label: "GST in the amount owed",
      hint: "Needed on the payments basis (0.00 if none). If you also map the bill total, this can be the whole bill's GST: the GST in what's owed is worked out in proportion.",
      aliases: ["gst", "gst amount", "gst owed", "tax", "tax amount", "tax total", "gst total"],
      otherSystem: ["TaxTotal"],
    },
    {
      key: "total",
      label: "Bill total (incl. GST)",
      hint: "Only needed when the GST column is the whole bill's GST rather than the GST in what's still owed.",
      aliases: ["bill total", "total", "original amount"],
      otherSystem: ["Total", "InvoiceTotal"],
    },
    {
      key: "gstCode",
      label: "GST code",
      hint: "Instead of a GST amount: GST, ZERO, EXEMPT or NONE, or names like \"15% GST on Expenses\". With GST, the GST is 3/23 of what's owed.",
      aliases: ["gst code", "tax code", "tax type", "tax rate"],
    },
  ],
};

/** Columns picked for each field (field key -> column headings), plus the kind's options. */
export type ImportMapping = {
  preset: ImportPreset;
  columns: Record<string, string[]>;
  options: ImportOptions;
};

export type ImportOptions = {
  /** How dates are written: day first (New Zealand), month first or year first. */
  dateOrder?: "dmy" | "mdy" | "ymd";
  /** Contacts without customer/supplier columns (another system's export has none). */
  defaultRole?: "customer" | "supplier" | "both" | "neither";
};

/** One mapped row: its row number in the file (headings are row 1 when they're the first row) and its values by field. */
export type ImportRecord = { row: number; values: Record<string, string> };

/** Compares headings ignoring case, spaces, "*" and punctuation: "*ContactName" matches "Contact name". */
export function normaliseHeading(heading: string): string {
  return heading.toLowerCase().replace(/[^a-z0-9%]/g, "");
}

/**
 * The row holding the column headings: the first of the first 20 rows with
 * two or more headings this kind knows (reports often start with a title and
 * a date), else the first row with anything in it.
 */
export function findHeaderRow(kind: ImportKind, rows: readonly string[][], extraHeadings: readonly string[] = []): number {
  const known = new Set(
    [...IMPORT_FIELDS[kind].flatMap((field) => [field.label, ...field.aliases, ...(field.otherSystem ?? [])]), ...extraHeadings].map(normaliseHeading),
  );
  for (let index = 0; index < Math.min(rows.length, 20); index += 1) {
    const hits = rows[index].filter((cell) => cell.trim() && known.has(normaliseHeading(cell))).length;
    if (hits >= 2) return index;
  }
  return Math.max(
    0,
    rows.findIndex((row) => row.some((cell) => cell.trim() !== "")),
  );
}

/** Column headings, with "Column N" for blank ones, so every column can be picked. */
export function headingsOf(rows: readonly string[][], headerRow: number): string[] {
  const width = Math.max(0, ...rows.slice(headerRow, headerRow + 200).map((row) => row.length));
  const header = rows[headerRow] ?? [];
  const seen = new Map<string, number>();
  return Array.from({ length: width }, (_, index) => {
    const text = (header[index] ?? "").trim() || `Column ${index + 1}`;
    const count = (seen.get(text) ?? 0) + 1;
    seen.set(text, count);
    return count === 1 ? text : `${text} (${count})`;
  });
}

/**
 * Matches columns to fields from their headings: another system's headings
 * first when that preset is chosen, then Tohyee's names and common
 * alternatives. Each column is used once, except that multi fields take
 * every one of their columns that's there.
 */
export function autoMap(kind: ImportKind, headings: readonly string[], preset: ImportPreset, extraFields: readonly ImportField[] = []): Record<string, string[]> {
  const byName = new Map<string, string>();
  for (const heading of headings) {
    const key = normaliseHeading(heading);
    if (!byName.has(key)) byName.set(key, heading);
  }
  const used = new Set<string>();
  const columns: Record<string, string[]> = {};
  const fields = [...IMPORT_FIELDS[kind], ...extraFields];
  const pick = (field: ImportField, names: readonly string[]) => {
    const found = names.map((name) => byName.get(normaliseHeading(name))).filter((name): name is string => Boolean(name) && !used.has(name!));
    if (found.length === 0) return false;
    const chosen = field.multi ? found : found.slice(0, 1);
    chosen.forEach((name) => used.add(name));
    columns[field.key] = chosen;
    return true;
  };
  const passes: Array<(field: ImportField) => readonly string[]> =
    preset === "other_system" ? [(field) => field.otherSystem ?? [], (field) => [field.label, ...field.aliases]] : [(field) => [field.label, ...field.aliases], (field) => field.otherSystem ?? []];
  for (const names of passes) {
    for (const field of fields) {
      if (!columns[field.key]) pick(field, names(field));
    }
  }
  return columns;
}

/**
 * Turns the file's rows into records by field, from the row after the
 * headings. Rows with nothing in them are left out. Multi fields join their
 * columns' non-blank values with new lines.
 */
export function applyMapping(rows: readonly string[][], headerRow: number, columns: Record<string, string[]>): ImportRecord[] {
  const headings = headingsOf(rows, headerRow);
  const index = new Map(headings.map((heading, position) => [heading, position]));
  const records: ImportRecord[] = [];
  for (let position = headerRow + 1; position < rows.length; position += 1) {
    const row = rows[position];
    if (!row.some((cell) => cell.trim() !== "")) continue;
    const values: Record<string, string> = {};
    for (const [field, names] of Object.entries(columns)) {
      const parts = names
        .map((name) => index.get(name))
        .filter((column): column is number => column !== undefined)
        .map((column) => (row[column] ?? "").trim())
        .filter((text) => text !== "");
      values[field] = parts.join("\n");
    }
    records.push({ row: position + 1, values });
  }
  return records;
}

/** Fields that are required but not mapped to any column. */
export function missingRequired(kind: ImportKind, columns: Record<string, string[]>): ImportField[] {
  return IMPORT_FIELDS[kind].filter((field) => field.required && !(columns[field.key]?.length));
}

/** The headings the exports write, in order (Tohyee's own columns). */
export function exportHeadings(kind: "accounts" | "contacts" | "items"): string[] {
  return IMPORT_FIELDS[kind].filter((field) => !(kind === "items" && field.key === "inventoryAccount")).map((field) => field.label);
}
