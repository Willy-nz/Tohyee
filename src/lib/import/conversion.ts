import { conversionClearingAccount } from "@/lib/accounts/service";
import { writeAuditEvent } from "@/lib/audit";
import { createOpeningBill } from "@/lib/bills/service";
import { parseIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, ValidationError } from "@/lib/errors";
import { assertSameRequest, requestHash } from "@/lib/idempotency";
import type { ImportKind, ImportOptions, ImportRecord } from "@/lib/import/fields";
import { isRowProblem, parseOptions, parseRecords, problemMessage, type RowProblem, saveMapping } from "@/lib/import/service";
import { date, money, number } from "@/lib/import/values";
import { loadStockContext } from "@/lib/inventory/stock";
import { postMovement, QUANTITY_SCALE } from "@/lib/inventory/movements";
import { createOpeningInvoice } from "@/lib/invoices/service";
import { parseJournalBody, postJournalBody } from "@/lib/ledger/journals";
import { assertPostingDateAllowed, getPeriodControls } from "@/lib/ledger/period-controls";
import { abs, add, dec, isNegative, isPositive, isZero, neg, sub, toFixedString, ZERO_DECIMAL, type Decimal } from "@/lib/money/decimal";
import { requireIdempotencyKey } from "@/lib/validation";

/**
 * Opening balances as at a conversion date (examples IM5-IM12): the trial
 * balance from the old system, the invoices and bills still owed then, and
 * the stock on hand, brought in together in one transaction, once.
 *
 * - The trial balance is posted as one journal dated the conversion date
 *   (origin `opening_balance`), except for the lines on accounts receivable,
 *   accounts payable and inventory: those are held by the open invoices, open
 *   bills and opening stock, so the journal puts them on the conversion
 *   clearing account instead (IM5).
 * - Each open invoice posts Dr accounts receivable / Cr conversion clearing,
 *   each open bill Dr conversion clearing / Cr accounts payable, and the stock
 *   Dr inventory / Cr conversion clearing, all dated the conversion date. So
 *   the clearing account ends at 0.00 and accounts receivable, accounts
 *   payable and inventory equal their sub-ledgers, never counted twice.
 * - Accounts receivable must equal the open invoices, accounts payable the
 *   open bills and inventory the stock, to the cent; the trial balance must
 *   balance. Any problem refuses the whole thing, naming the file and row.
 * - Opening GST (the trial balance's GST line) is a balance only: journals
 *   never count in a GST return, and opening invoices and bills never do
 *   either (IM8).
 */

export type ConversionFileKind = "trial_balance" | "stock" | "open_invoices" | "open_bills";

export type ConversionLine = {
  row: number;
  accountId: string;
  accountCode: string;
  accountName: string;
  debit: string;
  credit: string;
  /** Where the journal puts it: the account itself, or the conversion clearing account. */
  postedTo: string;
  heldBy: "open invoices" | "open bills" | "stock" | null;
};

export type ConversionTie = {
  label: string;
  accountCode: string;
  /** The trial balance's figure, in the account's natural direction. */
  trialBalance: string;
  /** What the invoices, bills or stock add up to. */
  documents: string;
  difference: string;
};

export type ConversionPlan = {
  conversionDate: string;
  totalDebit: string;
  totalCredit: string;
  difference: string;
  clearingAccountCode: string;
  lines: ConversionLine[];
  ties: ConversionTie[];
  invoices: Array<{ row: number; number: string; contactName: string; date: string; dueDate: string; amount: string }>;
  bills: Array<{ row: number; number: string; contactName: string; date: string; dueDate: string; amount: string }>;
  stock: Array<{ row: number; itemCode: string; location: string | null; locationId?: string; quantity: string; value: string }>;
  /** Rows left out on purpose (headings, totals, nothing owed, the same invoice on several rows). */
  skipped: RowProblem[];
};

export type ConversionResult = {
  /** True when nothing is wrong: a preview can be posted, or it was posted. */
  ok: boolean;
  committed: boolean;
  problems: RowProblem[];
  plan: ConversionPlan;
  journalId: string | null;
};

const money2 = (value: Decimal) => toFixedString(value, 2);

type Parsed = {
  conversionDate: string;
  idempotencyKey: string;
  files: Record<ConversionFileKind, ImportRecord[]>;
  options: ImportOptions;
  hash: string;
};

function parseInput(input: Record<string, unknown>): Parsed {
  const conversionDate = parseIsoDate(input.conversionDate, "conversionDate");
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const files = {
    trial_balance: parseRecords(input.trialBalance ?? [], "trialBalance"),
    stock: parseRecords(input.stock ?? [], "stock"),
    open_invoices: parseRecords(input.openInvoices ?? [], "openInvoices"),
    open_bills: parseRecords(input.openBills ?? [], "openBills"),
  };
  const options = parseOptions(input.options);
  if (files.trial_balance.length === 0) throw new ValidationError("Choose the trial balance file: it's what the opening balances come from.");
  const hash = requestHash("conversion", { conversionDate, files, options });
  return { conversionDate, idempotencyKey, files, options, hash };
}

/** "Sales (200)" -> "200": another system's trial balance often has the code in brackets after the name. */
function codeFromName(text: string | undefined): string | null {
  const match = /\(([A-Za-z0-9][A-Za-z0-9._-]{0,19})\)\s*$/.exec(text ?? "");
  return match ? match[1] : null;
}

const val = (record: ImportRecord, field: string) => (record.values[field] ?? "").trim();

/**
 * Checks everything and works out what would be posted; posts nothing.
 * Problems are collected rather than thrown, so every one is shown at once.
 */
async function plan(tx: OrgTx, parsed: Parsed): Promise<{ plan: ConversionPlan; problems: RowProblem[] }> {
  const { conversionDate, files, options } = parsed;
  const problems: RowProblem[] = [];
  const skipped: RowProblem[] = [];
  const problem = (kind: ConversionFileKind | undefined, row: number, message: string) => problems.push({ kind, row, message });
  const attempt = <T>(kind: ConversionFileKind, row: number, work: () => T): T | undefined => {
    try {
      return work();
    } catch (error) {
      if (!isRowProblem(error)) throw error;
      problem(kind, row, problemMessage(error));
      return undefined;
    }
  };

  // Where things stand.
  try {
    await assertPostingDateAllowed(tx, conversionDate);
  } catch (error) {
    if (!isRowProblem(error)) throw error;
    problem(undefined, 0, `The conversion date is in a locked period: ${problemMessage(error)}`);
  }
  const earlier = await tx.query<{ posting_date: string; reference: string }>(
    "select posting_date::text, reference from ledger_journals where posting_date <= $1 order by posting_date, id limit 1",
    [conversionDate],
  );
  if (earlier.rows[0]) {
    problem(
      undefined,
      0,
      `Something is already posted on or before ${conversionDate} (${earlier.rows[0].reference} on ${earlier.rows[0].posting_date}). Opening balances are the starting point, so nothing can be dated on or before the conversion date; void or correct it first, or use a conversion date before it.`,
    );
  }
  const settings = await tx.query<{ gst_basis: string }>("select gst_basis from organisation_settings where id = true");
  const basis = settings.rows[0]?.gst_basis ?? "invoice";

  const accounts = await tx.query<{
    id: string;
    code: string;
    name: string;
    system_key: string | null;
    currency_code: string | null;
    is_active: boolean;
  }>("select id, code, name, system_key, currency_code, is_active from accounts");
  const byCode = new Map(accounts.rows.map((row) => [row.code.toLowerCase(), row]));
  const system = (key: string) => accounts.rows.find((row) => row.system_key === key) ?? null;
  const receivable = system("accounts_receivable");
  const payable = system("accounts_payable");
  const inventory = system("inventory");
  const clearing = system("conversion_clearing");
  const clearingCode =
    clearing?.code ??
    (Array.from({ length: 10 }, (_, index) => String(2990 + index)).find((code) => !byCode.has(code)) ?? "2990");

  // Trial balance.
  const lines: ConversionLine[] = [];
  const seenAccounts = new Map<string, number>();
  let totalDebit = ZERO_DECIMAL;
  let totalCredit = ZERO_DECIMAL;
  for (const record of files.trial_balance) {
    const name = val(record, "account");
    const code = val(record, "accountCode") || codeFromName(name);
    const amounts = attempt("trial_balance", record.row, () => {
      const debit = money(val(record, "debit"), "Debit");
      const credit = money(val(record, "credit"), "Credit");
      const balance = money(val(record, "balance"), "Balance");
      return balance !== null ? dec(balance) : sub(dec(debit ?? "0"), dec(credit ?? "0"));
    });
    if (amounts === undefined) continue;
    if (!code) {
      if (isZero(amounts) || /^total/i.test(name) || !name) {
        skipped.push({ kind: "trial_balance", row: record.row, message: name ? `"${name}" has no account code (a heading or total)` : "No account" });
      } else {
        problem("trial_balance", record.row, `"${name}" has no account code. Map the code column, or put the code in brackets after the name.`);
      }
      continue;
    }
    if (isZero(amounts)) {
      skipped.push({ kind: "trial_balance", row: record.row, message: `${code} is 0.00` });
      continue;
    }
    const account = byCode.get(code.toLowerCase());
    if (!account) {
      problem("trial_balance", record.row, `There's no account with the code ${code}. Import the chart of accounts first, or add it.`);
      continue;
    }
    if (!account.is_active) {
      problem("trial_balance", record.row, `Account ${account.code} (${account.name}) is archived. Bring it back first.`);
      continue;
    }
    if (account.currency_code !== null && account.currency_code !== tx.baseCurrency) {
      problem(
        "trial_balance",
        record.row,
        `Account ${account.code} (${account.name}) is in ${account.currency_code}. Opening balances on foreign-currency accounts aren't supported yet.`,
      );
      continue;
    }
    if (account.system_key === "conversion_clearing") {
      problem("trial_balance", record.row, `Account ${account.code} (${account.name}) is the conversion clearing account, which opening balances post through; it can't have a balance of its own.`);
      continue;
    }
    const first = seenAccounts.get(account.id);
    if (first !== undefined) {
      problem("trial_balance", record.row, `Account ${account.code} is on row ${first} too. Each account can be in the trial balance once.`);
      continue;
    }
    seenAccounts.set(account.id, record.row);
    const debit = isPositive(amounts) ? amounts : ZERO_DECIMAL;
    const credit = isNegative(amounts) ? neg(amounts) : ZERO_DECIMAL;
    totalDebit = add(totalDebit, debit);
    totalCredit = add(totalCredit, credit);
    const heldBy =
      account.id === receivable?.id ? "open invoices" : account.id === payable?.id ? "open bills" : account.id === inventory?.id ? "stock" : null;
    lines.push({
      row: record.row,
      accountId: account.id,
      accountCode: account.code,
      accountName: account.name,
      debit: money2(debit),
      credit: money2(credit),
      postedTo: heldBy ? clearingCode : account.code,
      heldBy,
    });
  }
  const difference = sub(totalDebit, totalCredit);
  if (!isZero(difference)) {
    problem(
      "trial_balance",
      0,
      `The trial balance doesn't balance: debits ${money2(totalDebit)}, credits ${money2(totalCredit)}, a difference of ${money2(abs(difference))}. Opening balances have to balance exactly.`,
    );
  }
  if (lines.length > 0 && lines.length < 2 && isZero(difference)) {
    problem("trial_balance", 0, "The trial balance needs at least two accounts with balances.");
  }

  // Open invoices and bills.
  const contacts = await tx.query<{ id: string; name: string; is_customer: boolean; is_supplier: boolean }>(
    "select id, name, is_customer, is_supplier from contacts where not is_archived",
  );
  const contactByName = new Map(contacts.rows.map((row) => [row.name.toLowerCase(), row]));
  type OpenDocument = ConversionPlan["invoices"][number] & { contactId: string; reference: string | null };
  const readDocuments = (kind: "open_invoices" | "open_bills"): OpenDocument[] => {
    const documents: OpenDocument[] = [];
    const seen = new Map<string, { row: number; key: string }>();
    const noun = kind === "open_invoices" ? "invoice" : "bill";
    for (const record of files[kind]) {
      const parsedRow = attempt(kind, record.row, () => {
        const numberText = val(record, "number");
        const contactName = val(record, "contact");
        if (!numberText) throw new ValidationError(`The ${noun} number is required.`);
        if (numberText.length > 100) throw new ValidationError(`The ${noun} number can be at most 100 characters.`);
        if (!contactName) throw new ValidationError(`The ${kind === "open_invoices" ? "customer" : "supplier"} is required.`);
        const documentDate = date(val(record, "date"), kind === "open_invoices" ? "Invoice date" : "Bill date", options.dateOrder);
        const dueDate = date(val(record, "dueDate"), "Due date", options.dateOrder);
        const amount = money(val(record, "amount"), "Amount still owed");
        return { numberText, contactName, documentDate, dueDate, amount };
      });
      if (!parsedRow) continue;
      const { numberText, contactName, documentDate, dueDate, amount } = parsedRow;
      // Another system's export has a row per line of each invoice: the same invoice on several rows is one invoice.
      const key = [numberText.toLowerCase(), contactName.toLowerCase(), documentDate, dueDate, amount].join("|");
      const same = seen.get(`${contactName.toLowerCase()}|${numberText.toLowerCase()}`);
      if (same) {
        if (same.key === key) skipped.push({ kind, row: record.row, message: `${noun} ${numberText} again (row ${same.row})` });
        else problem(kind, record.row, `${noun[0].toUpperCase()}${noun.slice(1)} ${numberText} is on row ${same.row} too, with different details.`);
        continue;
      }
      seen.set(`${contactName.toLowerCase()}|${numberText.toLowerCase()}`, { row: record.row, key });
      if (amount === null || isZero(dec(amount))) {
        skipped.push({ kind, row: record.row, message: `${noun} ${numberText} has nothing owed` });
        continue;
      }
      if (isNegative(dec(amount))) {
        problem(kind, record.row, `${noun[0].toUpperCase()}${noun.slice(1)} ${numberText} is negative (a credit). Unused credit notes and overpayments at the conversion date aren't supported yet.`);
        continue;
      }
      const contact = contactByName.get(contactName.toLowerCase());
      if (!contact) {
        problem(kind, record.row, `There's no contact called "${contactName}". Import contacts first.`);
        continue;
      }
      if (kind === "open_invoices" && !contact.is_customer) {
        problem(kind, record.row, `${contact.name} isn't marked as a customer.`);
        continue;
      }
      if (kind === "open_bills" && !contact.is_supplier) {
        problem(kind, record.row, `${contact.name} isn't marked as a supplier.`);
        continue;
      }
      if (documentDate > conversionDate) {
        problem(kind, record.row, `${noun[0].toUpperCase()}${noun.slice(1)} ${numberText} is dated ${documentDate}, after the conversion date. Enter it in Tohyee as a new ${noun} instead.`);
        continue;
      }
      if (dueDate < documentDate) {
        problem(kind, record.row, `${noun[0].toUpperCase()}${noun.slice(1)} ${numberText} is due before its date.`);
        continue;
      }
      const reference = val(record, "reference") || null;
      if (reference && reference.length > 100) {
        problem(kind, record.row, "The reference can be at most 100 characters.");
        continue;
      }
      documents.push({ row: record.row, number: numberText, contactId: contact.id, contactName: contact.name, date: documentDate, dueDate, amount, reference });
    }
    return documents;
  };
  const invoices = readDocuments("open_invoices");
  const bills = readDocuments("open_bills");
  if (invoices.length > 0) {
    const numbers = invoices.map((invoice) => invoice.number);
    const taken = await tx.query<{ invoice_number: string }>("select invoice_number from sales_invoices where invoice_number = any($1::text[])", [numbers]);
    const takenSet = new Set(taken.rows.map((row) => row.invoice_number));
    const inFile = new Map<string, number>();
    for (const invoice of invoices) {
      if (takenSet.has(invoice.number)) problem("open_invoices", invoice.row, `There's already an invoice numbered ${invoice.number} in Tohyee.`);
      const first = inFile.get(invoice.number);
      if (first !== undefined) problem("open_invoices", invoice.row, `Invoice number ${invoice.number} is on row ${first} too (for another customer); invoice numbers must be unique.`);
      else inFile.set(invoice.number, invoice.row);
    }
  }
  for (const bill of bills) {
    const clash = await tx.query(
      `select 1 from bills where contact_id = $1 and status <> 'voided'
          and lower(regexp_replace(supplier_invoice_number, '[[:space:]]', '', 'g')) = lower(regexp_replace($2::text, '[[:space:]]', '', 'g'))`,
      [bill.contactId, bill.number],
    );
    if ((clash.rowCount ?? 0) > 0) problem("open_bills", bill.row, `${bill.contactName} already has a bill numbered ${bill.number} in Tohyee.`);
  }
  // Payments basis: GST on these is returned when they're paid, but Tohyee only has the amount still owed, not its GST (question for Jess, IM9).
  if (invoices.length > 0 && basis === "payments") {
    problem(
      "open_invoices",
      0,
      "This organisation accounts for GST on the payments basis, so GST on these invoices is due when they're paid, but the file only has what's still owed, not its GST. Open invoices can't be brought in on the payments basis yet: enter them as ordinary invoices dated the conversion date instead.",
    );
  }
  if (bills.length > 0 && (basis === "payments" || basis === "hybrid")) {
    problem(
      "open_bills",
      0,
      `This organisation accounts for GST on purchases when they're paid (the ${basis} basis), but the file only has what's still owed, not its GST. Open bills can't be brought in on that basis yet: enter them as ordinary bills dated the conversion date instead.`,
    );
  }

  // Stock.
  const stock: ConversionPlan["stock"] = [];
  if (files.stock.length > 0) {
    const stockCtx = await loadStockContext(tx, "opening stock can't be brought in").catch((error: unknown) => {
      if (!isRowProblem(error)) throw error;
      problem("stock", 0, problemMessage(error));
      return null;
    });
    const items = await tx.query<{ code: string; item_type: string }>("select code, item_type from items");
    const itemByCode = new Map(items.rows.map((row) => [row.code.toLowerCase(), row]));
    const locationByName = new Map([...(stockCtx?.locationNames ?? new Map<string, string>()).entries()].map(([id, name]) => [name.toLowerCase(), { id, name }]));
    const seen = new Map<string, number>();
    for (const record of files.stock) {
      const itemText = val(record, "itemCode");
      const read = attempt("stock", record.row, () => {
        const quantity = number(val(record, "quantity"), "Quantity", QUANTITY_SCALE);
        const value = money(val(record, "value"), "Value");
        return { quantity, value };
      });
      if (!read) continue;
      if (!itemText) {
        problem("stock", record.row, "The item code is required.");
        continue;
      }
      if (isZero(dec(read.quantity)) && (read.value === null || isZero(dec(read.value)))) {
        skipped.push({ kind: "stock", row: record.row, message: `${itemText} has none on hand` });
        continue;
      }
      const item = itemByCode.get(itemText.toLowerCase());
      if (!item) {
        problem("stock", record.row, `There's no item with the code ${itemText}. Import products and services first.`);
        continue;
      }
      if (item.item_type !== "stock") {
        problem("stock", record.row, `${item.code} isn't a stock item, so it has no stock on hand.`);
        continue;
      }
      if (!isPositive(dec(read.quantity)) || read.value === null || !isPositive(dec(read.value))) {
        problem("stock", record.row, `${item.code}: the quantity and value must both be more than 0.`);
        continue;
      }
      const locationText = val(record, "location");
      let location: { id: string; name: string } | null = null;
      if (stockCtx?.locationsInUse) {
        if (!locationText) {
          problem("stock", record.row, `${item.code}: stock is kept by location, so each row needs its Location.`);
          continue;
        }
        location = locationByName.get(locationText.toLowerCase()) ?? null;
        if (!location) {
          problem("stock", record.row, `There's no Location called "${locationText}".`);
          continue;
        }
      } else if (locationText) {
        problem("stock", record.row, "Stock isn't kept by location in this organisation, so leave the location blank.");
        continue;
      }
      const key = `${item.code.toLowerCase()}|${location?.id ?? ""}`;
      const first = seen.get(key);
      if (first !== undefined) {
        problem("stock", record.row, `${item.code}${location ? ` at ${location.name}` : ""} is on row ${first} too.`);
        continue;
      }
      seen.set(key, record.row);
      stock.push({ row: record.row, itemCode: item.code, location: location?.name ?? null, quantity: read.quantity, value: read.value, ...(location ? { locationId: location.id } : {}) });
    }
  }

  // Accounts receivable, accounts payable and inventory must equal what holds them (IM6).
  const ties: ConversionTie[] = [];
  const tie = (label: string, account: { id: string; code: string } | null, sign: 1 | -1, documents: Decimal, file: ConversionFileKind, what: string) => {
    const line = account ? lines.find((entry) => entry.accountId === account.id) : undefined;
    const net = line ? sub(dec(line.debit), dec(line.credit)) : ZERO_DECIMAL;
    const trial = sign === 1 ? net : neg(net);
    if (!line && isZero(documents)) return;
    if (!account) {
      problem(file, 0, `No account is set up for ${label.toLowerCase()}, so ${what} can't be brought in.`);
      return;
    }
    const gap = sub(trial, documents);
    ties.push({ label, accountCode: account.code, trialBalance: money2(trial), documents: money2(documents), difference: money2(gap) });
    if (!isZero(gap)) {
      problem(
        line ? "trial_balance" : file,
        line?.row ?? 0,
        `${label} (${account.code}) is ${money2(trial)} in the trial balance, but the ${what} add up to ${money2(documents)}: a difference of ${money2(abs(gap))}. They have to be equal, since the ${what} are what make up the balance.`,
      );
    }
  };
  const total = (values: string[]) => values.reduce((sum, value) => add(sum, dec(value)), ZERO_DECIMAL);
  tie("Accounts receivable", receivable, 1, total(invoices.map((invoice) => invoice.amount)), "open_invoices", "open invoices");
  tie("Accounts payable", payable, -1, total(bills.map((bill) => bill.amount)), "open_bills", "open bills");
  tie("Inventory", inventory, 1, total(stock.map((entry) => entry.value)), "stock", "stock values");

  problems.sort((a, b) => (a.kind ?? "").localeCompare(b.kind ?? "") || a.row - b.row);
  return {
    plan: {
      conversionDate,
      totalDebit: money2(totalDebit),
      totalCredit: money2(totalCredit),
      difference: money2(abs(difference)),
      clearingAccountCode: clearingCode,
      lines,
      ties,
      invoices: invoices.map(({ row, number: documentNumber, contactName, date: documentDate, dueDate, amount }) => ({ row, number: documentNumber, contactName, date: documentDate, dueDate, amount })),
      bills: bills.map(({ row, number: documentNumber, contactName, date: documentDate, dueDate, amount }) => ({ row, number: documentNumber, contactName, date: documentDate, dueDate, amount })),
      stock,
      skipped,
    },
    problems,
  };
}

async function post(tx: OrgTx, parsed: Parsed, planned: ConversionPlan): Promise<string> {
  const { conversionDate, idempotencyKey } = parsed;
  const clearing = await conversionClearingAccount(tx);
  const contactIds = await tx.query<{ id: string; name: string }>("select id, name from contacts where not is_archived");
  const idOf = new Map(contactIds.rows.map((row) => [row.name, row.id]));
  for (const invoice of planned.invoices) {
    await createOpeningInvoice(tx, {
      idempotencyKey: `${idempotencyKey}:invoice:${invoice.row}`,
      conversionDate,
      clearingAccountCode: clearing.code,
      contactId: idOf.get(invoice.contactName)!,
      contactName: invoice.contactName,
      invoiceNumber: invoice.number,
      invoiceDate: invoice.date,
      dueDate: invoice.dueDate,
      reference: parsed.files.open_invoices.find((record) => record.row === invoice.row)?.values.reference?.trim() || null,
      amount: invoice.amount,
    });
  }
  for (const bill of planned.bills) {
    await createOpeningBill(tx, {
      idempotencyKey: `${idempotencyKey}:bill:${bill.row}`,
      conversionDate,
      clearingAccountCode: clearing.code,
      contactId: idOf.get(bill.contactName)!,
      contactName: bill.contactName,
      supplierInvoiceNumber: bill.number,
      billDate: bill.date,
      dueDate: bill.dueDate,
      amount: bill.amount,
    });
  }
  if (planned.stock.length > 0) {
    const inventory = await tx.query<{ code: string }>("select code from accounts where system_key = 'inventory'");
    for (const entry of planned.stock) {
      await postMovement(
        tx,
        {
          source: "import",
          idempotencyKey: `${idempotencyKey}:stock:${entry.row}`,
          movementType: "receipt",
          movementDate: conversionDate,
          itemCode: entry.itemCode,
          quantity: entry.quantity,
          reference: "Opening balance",
          description: `Opening stock: ${entry.itemCode} at ${conversionDate}`,
          inventoryAccountCode: inventory.rows[0].code,
          offsetAccountCode: clearing.code,
          locationValueId: entry.locationId ?? null,
        },
        { receiptValue: entry.value },
      );
    }
  }
  const heldLabel = { "open invoices": "held by the open invoices", "open bills": "held by the open bills", stock: "held by the opening stock" } as const;
  const journal = await postJournalBody(
    tx,
    "import:conversion",
    idempotencyKey,
    parseJournalBody(
      tx,
      {
        postingDate: conversionDate,
        reference: "OPENING",
        description: `Opening balances as at ${conversionDate}`,
        lines: planned.lines.map((line) => ({
          accountCode: line.heldBy ? clearing.code : line.accountCode,
          debitAmount: line.debit,
          creditAmount: line.credit,
          description: line.heldBy ? `${line.accountCode} ${line.accountName}, ${heldLabel[line.heldBy]}` : "Opening balance",
        })),
      },
      { internal: true },
    ),
    { origin: "opening_balance" },
  );
  await tx.query(
    `insert into conversion_balances (command_source, idempotency_key, request_hash, conversion_date, journal_id, invoice_count, bill_count,
                                      stock_count, created_by_user_id, created_by_email)
     values ('import', $1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [idempotencyKey, parsed.hash, conversionDate, journal.journal.id, planned.invoices.length, planned.bills.length, planned.stock.length, tx.actor.userId, tx.actor.email],
  );
  for (const [index, line] of planned.lines.entries()) {
    await tx.query(
      "insert into conversion_balance_lines (line_order, account_id, debit_amount, credit_amount) values ($1, $2, $3::numeric, $4::numeric)",
      [index + 1, line.accountId, line.debit, line.credit],
    );
  }
  const left = await tx.query<{ balance: string }>(
    "select coalesce(sum(debit_amount - credit_amount), 0)::text as balance from ledger_journal_lines where account_id = $1",
    [clearing.id],
  );
  if (!isZero(dec(left.rows[0].balance))) {
    // Can't happen once the ties above hold; refuse rather than leave a balance behind.
    throw new ValidationError(`The conversion clearing account would be left at ${left.rows[0].balance}, not 0.00.`);
  }
  return journal.journal.id;
}

async function existingConversion(tx: OrgTx) {
  const result = await tx.query<{ idempotency_key: string; request_hash: string; conversion_date: string; journal_id: string }>(
    "select idempotency_key, request_hash, conversion_date::text, journal_id from conversion_balances where id = true",
  );
  return result.rows[0] ?? null;
}

/**
 * Checks (`commit` false) or posts (`commit` true) the opening balances. A
 * check runs the posting too, inside a savepoint it always rolls back, so
 * the database's own rules are part of it. Posting happens once: a retry
 * with the same key and files returns the original; anything else is refused
 * (IM11).
 */
export async function importConversion(tx: OrgTx, input: Record<string, unknown>, commit: boolean): Promise<ConversionResult> {
  const parsed = parseInput(input);
  const done = await existingConversion(tx);
  if (done) {
    if (done.idempotency_key === parsed.idempotencyKey) {
      assertSameRequest(done.request_hash, parsed.hash, "opening balances import");
      const replay = await plan(tx, { ...parsed });
      return { ok: true, committed: true, problems: [], plan: replay.plan, journalId: done.journal_id };
    }
    throw new ConflictError(
      `Opening balances were already brought in as at ${done.conversion_date}. They can't be imported again: correct them with a journal, or void an opening invoice or bill.`,
    );
  }
  const planned = await plan(tx, parsed);
  if (planned.problems.length > 0) return { ok: false, committed: false, problems: planned.problems, plan: planned.plan, journalId: null };

  await tx.query("savepoint conversion");
  let journalId: string | null = null;
  const problems: RowProblem[] = [];
  try {
    journalId = await post(tx, parsed, planned.plan);
    if (!commit) await tx.query("set constraints all immediate");
  } catch (error) {
    if (!isRowProblem(error)) throw error;
    problems.push({ row: 0, message: problemMessage(error) });
  }
  const committed = commit && problems.length === 0;
  if (!committed) {
    await tx.query("rollback to savepoint conversion");
    journalId = null;
  }
  await tx.query("release savepoint conversion");
  if (committed) {
    const mappings = input.mappings && typeof input.mappings === "object" ? (input.mappings as Record<string, unknown>) : {};
    for (const kind of ["trial_balance", "stock", "open_invoices", "open_bills"] as const satisfies readonly ImportKind[]) {
      if (mappings[kind] !== undefined) await saveMapping(tx, kind, mappings[kind]);
    }
    await writeAuditEvent(tx, {
      eventType: "import.conversion",
      entityType: "conversion_balances",
      entityId: "1",
      details: {
        conversionDate: parsed.conversionDate,
        journalId,
        accounts: planned.plan.lines.length,
        invoices: planned.plan.invoices.length,
        bills: planned.plan.bills.length,
        stock: planned.plan.stock.length,
      },
    });
  }
  return { ok: problems.length === 0, committed, problems, plan: planned.plan, journalId };
}

// ---------------------------------------------------------------------------
// The final check (IM12)

export type ConversionCheckLine = {
  accountId: string;
  code: string;
  name: string;
  /** Debits positive, credits negative. */
  imported: string;
  inTohyee: string;
  difference: string;
};

export type ConversionStatus = {
  conversion: {
    conversionDate: string;
    journalId: string;
    invoiceCount: number;
    billCount: number;
    stockCount: number;
    createdByEmail: string | null;
    createdAt: string;
  } | null;
  lines: ConversionCheckLine[];
  /** Every account agrees with the imported trial balance at the conversion date. */
  matches: boolean;
  clearingBalance: string | null;
  lockDate: string | null;
  /** Up to the conversion date is locked. */
  locked: boolean;
};

/**
 * The trial balance at the conversion date, account by account, next to the
 * one imported: every line should match, and the conversion clearing
 * account should be 0.00, before the period up to the conversion date is
 * locked (with the ordinary period lock).
 */
export async function conversionStatus(tx: OrgTx): Promise<ConversionStatus> {
  const controls = await getPeriodControls(tx);
  const found = await tx.query<{
    conversion_date: string;
    journal_id: string;
    invoice_count: number;
    bill_count: number;
    stock_count: number;
    created_by_email: string | null;
    created_at: string;
  }>(
    "select conversion_date::text, journal_id, invoice_count, bill_count, stock_count, created_by_email, created_at from conversion_balances where id = true",
  );
  const row = found.rows[0];
  if (!row) return { conversion: null, lines: [], matches: false, clearingBalance: null, lockDate: controls.lockDate, locked: false };
  const result = await tx.query<{ id: string; code: string; name: string; system_key: string | null; imported: string; ledger: string }>(
    `select a.id, a.code, a.name, a.system_key,
            coalesce((select c.debit_amount - c.credit_amount from conversion_balance_lines c where c.account_id = a.id), 0)::text as imported,
            coalesce((select sum(l.debit_amount - l.credit_amount) from ledger_journal_lines l join ledger_journals j on j.id = l.journal_id
                       where l.account_id = a.id and j.posting_date <= $1), 0)::text as ledger
       from accounts a
      where exists (select 1 from conversion_balance_lines c where c.account_id = a.id)
         or exists (select 1 from ledger_journal_lines l join ledger_journals j on j.id = l.journal_id
                     where l.account_id = a.id and j.posting_date <= $1)
      order by a.code`,
    [row.conversion_date],
  );
  const lines = result.rows.map((entry) => {
      const gap = sub(dec(entry.ledger), dec(entry.imported));
      return {
        accountId: entry.id,
        code: entry.code,
        name: entry.name,
        imported: money2(dec(entry.imported)),
        inTohyee: money2(dec(entry.ledger)),
        difference: money2(gap),
        clearing: entry.system_key === "conversion_clearing",
      };
    });
  const clearing = lines.find((entry) => entry.clearing);
  return {
    conversion: {
      conversionDate: row.conversion_date,
      journalId: row.journal_id,
      invoiceCount: row.invoice_count,
      billCount: row.bill_count,
      stockCount: row.stock_count,
      createdByEmail: row.created_by_email,
      createdAt: row.created_at,
    },
    lines: lines.map((entry) => ({
      accountId: entry.accountId,
      code: entry.code,
      name: entry.name,
      imported: entry.imported,
      inTohyee: entry.inTohyee,
      difference: entry.difference,
    })),
    matches: lines.every((entry) => isZero(dec(entry.difference))),
    clearingBalance: clearing ? clearing.inTohyee : "0.00",
    lockDate: controls.lockDate,
    locked: controls.lockDate !== null && controls.lockDate >= row.conversion_date,
  };
}
