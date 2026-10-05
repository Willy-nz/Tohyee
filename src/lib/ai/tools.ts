import { listApprovalRequests } from "@/lib/approvals/requests";
import { listAccounts } from "@/lib/accounts/service";
import { boundedLimit, firstRows } from "@/lib/ai/limits";
import type { AiAccessLevel } from "@/lib/ai/access-levels";
import type { Role } from "@/lib/auth/roles";
import { getInboxItem, getInboxItemContent, type InboxItem, listInbox } from "@/lib/bills/inbox";
import { getBill, listBills, type BillSummary } from "@/lib/bills/service";
import { listContacts } from "@/lib/contacts/service";
import { todayIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { MONTH_NAMES } from "@/lib/financial-year";
import { formatGstNumber } from "@/lib/format";
import { getInvoice, listInvoices, type InvoiceSummary } from "@/lib/invoices/service";
import { getJournalDraft, listJournalDrafts } from "@/lib/ledger/journal-drafts";
import { getOrganisationSettings } from "@/lib/organisations/settings";
import { accountTransactions } from "@/lib/reports/account-transactions";
import { agedPayables } from "@/lib/reports/aged-payables";
import { agedReceivables } from "@/lib/reports/aged-receivables";
import { balanceSheet, profitAndLoss, trialBalance } from "@/lib/reports/financial";
import { calculateGstReturn } from "@/lib/reports/gst-return";
import { optionalString } from "@/lib/validation";

/**
 * The tools an AI connected over MCP can use to look things up (decision
 * 342). Every one only reads, through the same service functions the screens
 * use, inside a read-only transaction on the organisation's own database. No
 * payroll. Lists are capped so one answer stays small. The tools that make
 * drafts and post are in `@/lib/ai/write-tools` (decisions 346-348); the
 * whole list is `@/lib/ai/catalogue`.
 */

export type ToolContext = {
  role: Role;
  organisationId: string;
  /** The command source for idempotency keys, one per AI key (e.g. "ai-12"). */
  source: string;
};

export type JsonSchema = Record<string, unknown>;

/**
 * An answer with a file attached (BI4): the MCP server sends `answer` as
 * JSON text and the file's bytes after it, so the person's AI can read it.
 */
export class ToolFileAnswer {
  constructor(
    readonly answer: unknown,
    readonly file: { uri: string; fileName: string; contentType: string; content: Buffer },
  ) {}
}

export type AiTool = {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  /** The access level a key needs for this tool (decision 346). Only "read" tools run read-only. */
  level: AiAccessLevel;
  run(tx: OrgTx, args: Record<string, unknown>, context: ToolContext): Promise<unknown>;
};

export const DATE = { type: "string", format: "date", description: "A date as YYYY-MM-DD." } as const;

export function schema(properties: Record<string, JsonSchema> = {}, required: string[] = []): JsonSchema {
  return { type: "object", properties, required, additionalProperties: false };
}

const MAX_LIST = 200;
const MAX_LINES = 1000;
const MAX_CONTACTS = 500;
const MAX_AGED_ROWS = 300;
const MAX_DOCUMENTS_PER_ROW = 50;
const MAX_DOCUMENT_LINES = 300;

export function invoiceSummary(invoice: InvoiceSummary) {
  return {
    id: invoice.id,
    number: invoice.invoiceNumber,
    status: invoice.status,
    contactId: invoice.contactId,
    contactName: invoice.contactName,
    invoiceDate: invoice.invoiceDate,
    dueDate: invoice.dueDate,
    reference: invoice.reference,
    currencyCode: invoice.currencyCode,
    subtotal: invoice.subtotal,
    gst: invoice.taxTotal,
    total: invoice.total,
    amountPaid: invoice.amountPaid,
    amountCredited: invoice.amountCredited,
    amountDue: invoice.amountDue,
    paidStatus: invoice.paidStatus,
  };
}

export function billSummary(bill: BillSummary) {
  return {
    id: bill.id,
    supplierInvoiceNumber: bill.supplierInvoiceNumber,
    status: bill.status,
    contactId: bill.contactId,
    contactName: bill.contactName,
    billDate: bill.billDate,
    dueDate: bill.dueDate,
    currencyCode: bill.currencyCode,
    subtotal: bill.subtotal,
    gst: bill.taxTotal,
    total: bill.total,
    amountPaid: bill.amountPaid,
    amountCredited: bill.amountCredited,
    amountDue: bill.amountDue,
    paidStatus: bill.paidStatus,
  };
}

type DocumentLine = {
  lineOrder: number;
  description: string;
  quantity: string;
  unitPrice: string;
  accountCode: string;
  accountName: string;
  taxCode: string | null;
  lineAmount: string;
  netAmount: string;
  taxAmount: string;
};

/** A bills inbox item for the AI: no file, just what it is and where it came from. */
export function inboxItemSummary(item: InboxItem) {
  return {
    id: item.id,
    status: item.status,
    fileName: item.fileName,
    fileType: item.contentType,
    arrived: item.createdAt,
    source: item.source,
    emailFrom: item.emailFrom,
    emailSubject: item.emailSubject,
    billId: item.billId,
    billNumber: item.billNumber,
    removedReason: item.removedReason,
    sameFile: item.sameFile.map((entry) => entry.text),
  };
}

export function documentLines(lines: readonly DocumentLine[]) {
  const kept = firstRows(lines, MAX_DOCUMENT_LINES);
  return {
    lines: kept.rows.map((line) => ({
      line: line.lineOrder,
      description: line.description,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      account: `${line.accountCode} ${line.accountName}`,
      taxCode: line.taxCode,
      amount: line.lineAmount,
      net: line.netAmount,
      gst: line.taxAmount,
    })),
    ...(kept.truncated ? { linesNote: `Showing the first ${MAX_DOCUMENT_LINES} of ${kept.total} lines.` } : {}),
  };
}

/** A document's id from `id`, or null when a number is given instead. */
function idOrNull(input: unknown): string | null {
  if (input === undefined || input === null || input === "") return null;
  const text = String(input).trim();
  if (!/^[1-9]\d{0,17}$/.test(text)) throw new ValidationError("id must be a positive whole number.");
  return text;
}

function capRows<T, R>(rows: readonly T[], max: number, map: (row: T) => R, what: string) {
  const kept = firstRows(rows, max);
  return {
    rows: kept.rows.map(map),
    ...(kept.truncated ? { note: `Showing the first ${max} of ${kept.total} ${what}. Ask a narrower question to see the rest.` } : {}),
  };
}

const LAST_DAY = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** "31 March", "30 June", "28 February (29 in a leap year)". */
export function financialYearEndLabel(month: number): string {
  const label = `${LAST_DAY[month - 1]} ${MONTH_NAMES[month - 1]}`;
  return month === 2 ? `${label} (29 in a leap year)` : label;
}

export const READ_TOOLS: readonly AiTool[] = (
  [
  {
    name: "get_organisation",
    title: "Organisation",
    description:
      "The organisation these books are for: name, base currency, financial year end, GST basis, GST filing period and GST number (registered when Tohyee has one), your role, and today's date. Call this first.",
    inputSchema: schema(),
    async run(tx, _args, context) {
      const settings = await getOrganisationSettings(tx);
      return {
        organisationId: settings.organisationId,
        name: settings.displayName,
        baseCurrency: settings.baseCurrency,
        financialYearEnd: financialYearEndLabel(settings.financialYearEndMonth),
        financialYearEndMonth: settings.financialYearEndMonth,
        gstBasis: settings.gstBasis,
        gstPeriod: settings.gstPeriod,
        gstRegistered: settings.gstNumber !== null,
        gstNumber: settings.gstNumber ? formatGstNumber(settings.gstNumber) : null,
        modules: {
          advancedReporting: settings.advancedFeatures,
          crm: settings.crmEnabled,
          notForProfit: settings.notForProfitEnabled,
        },
        yourRole: context.role,
        access: "read-only",
        today: todayIsoDate(),
        amounts: "Amounts are decimal strings in the base currency unless a currencyCode says otherwise.",
      };
    },
  },
  {
    name: "list_accounts",
    title: "Chart of accounts",
    description: "The chart of accounts: code, name, type, class (asset, liability, equity, revenue, expense), currency and whether it's archived.",
    inputSchema: schema({ includeArchived: { type: "boolean", description: "Also list archived accounts. Default false." } }),
    async run(tx, args) {
      const accounts = await listAccounts(tx, { includeArchived: args.includeArchived === true });
      return capRows(
        accounts,
        MAX_LINES,
        (account) => ({
          code: account.code,
          name: account.name,
          type: account.accountType,
          class: account.accountClass,
          currencyCode: account.currencyCode,
          defaultTaxCode: account.defaultTaxCode,
          archived: !account.isActive,
        }),
        "accounts",
      );
    },
  },
  {
    name: "profit_and_loss",
    title: "Profit and loss",
    description:
      "Profit and loss (income statement) between two dates, inclusive, by section and account. Without `from` it starts at the beginning of the financial year containing `to`; without `to` it ends today.",
    inputSchema: schema({ from: DATE, to: DATE }),
    run: (tx, args) => profitAndLoss(tx, { from: args.from, to: args.to }),
  },
  {
    name: "balance_sheet",
    title: "Balance sheet",
    description: "Balance sheet as at a date (default today): assets, liabilities and equity by account, with retained earnings.",
    inputSchema: schema({ asAt: DATE }),
    run: (tx, args) => balanceSheet(tx, { asAt: args.asAt }),
  },
  {
    name: "trial_balance",
    title: "Trial balance",
    description: "Trial balance as at a date (default today): each account's debit or credit balance.",
    inputSchema: schema({ asAt: DATE }),
    run: (tx, args) => trialBalance(tx, { asAt: args.asAt }),
  },
  {
    name: "aged_receivables",
    title: "Aged receivables",
    description: "What customers owe as at a date (default today), by customer and days past due, with each open invoice.",
    inputSchema: schema({ asAt: DATE }),
    async run(tx, args) {
      const report = await agedReceivables(tx, { asAt: args.asAt });
      const rows = capRows(
        report.rows,
        MAX_AGED_ROWS,
        (row) => ({ ...row, invoices: row.invoices.slice(0, MAX_DOCUMENTS_PER_ROW), invoiceCount: row.invoices.length }),
        "customers",
      );
      return { ...report, rows: rows.rows, ...(rows.note ? { note: rows.note } : {}) };
    },
  },
  {
    name: "aged_payables",
    title: "Aged payables",
    description: "What's owed to suppliers as at a date (default today), by supplier and days past due, with each open bill and unused supplier credit.",
    inputSchema: schema({ asAt: DATE }),
    async run(tx, args) {
      const report = await agedPayables(tx, { asAt: args.asAt });
      const rows = capRows(
        report.rows,
        MAX_AGED_ROWS,
        (row) => ({
          ...row,
          bills: row.bills.slice(0, MAX_DOCUMENTS_PER_ROW),
          billCount: row.bills.length,
          credits: row.credits.slice(0, MAX_DOCUMENTS_PER_ROW),
        }),
        "suppliers",
      );
      return { ...report, rows: rows.rows, ...(rows.note ? { note: rows.note } : {}) };
    },
  },
  {
    name: "list_invoices",
    title: "Sales invoices",
    description:
      "Sales invoices, newest first. Filter by status (draft, approved, voided), by customer (contactId from list_contacts), or awaitingPayment to see only approved invoices with something still due.",
    inputSchema: schema({
      status: { type: "string", enum: ["draft", "approved", "voided"] },
      contactId: { type: "string", description: "A contact id from list_contacts." },
      awaitingPayment: { type: "boolean" },
      limit: { type: "integer", minimum: 1, maximum: MAX_LIST, description: `Default 50, at most ${MAX_LIST}.` },
    }),
    async run(tx, args) {
      const result = await listInvoices(tx, {
        status: args.status,
        contactId: args.contactId,
        awaitingPayment: args.awaitingPayment,
        limit: boundedLimit(args.limit, 50, MAX_LIST),
      });
      return { invoices: result.invoices.map(invoiceSummary), more: result.nextBeforeId !== null };
    },
  },
  {
    name: "get_invoice",
    title: "One sales invoice",
    description: "One sales invoice with its lines, by id or by its number (e.g. INV-0012).",
    inputSchema: schema({
      id: { type: "string", description: "The invoice id from list_invoices." },
      number: { type: "string", description: "The invoice number, e.g. INV-0012." },
    }),
    async run(tx, args) {
      let id = idOrNull(args.id);
      if (!id) {
        const number = optionalString(args.number, "number", { maxLength: 40 });
        if (!number) throw new ValidationError("Give the invoice's id or number.");
        // The one lookup the screens don't need: an invoice by its number.
        const found = await tx.query<{ id: string }>("select id::text from sales_invoices where upper(invoice_number) = upper($1)", [number]);
        if (!found.rows[0]) throw new NotFoundError(`There's no invoice numbered ${number}.`);
        id = found.rows[0].id;
      }
      const invoice = await getInvoice(tx, id);
      return { ...invoiceSummary(invoice), amountsMode: invoice.amountsMode, exchangeRate: invoice.exchangeRate, ...documentLines(invoice.lines) };
    },
  },
  {
    name: "list_bills",
    title: "Bills",
    description:
      "Bills from suppliers, newest first. Filter by status (draft, approved, voided), by supplier (contactId from list_contacts), or awaitingPayment to see only approved bills with something still due.",
    inputSchema: schema({
      status: { type: "string", enum: ["draft", "approved", "voided"] },
      contactId: { type: "string", description: "A contact id from list_contacts." },
      awaitingPayment: { type: "boolean" },
      limit: { type: "integer", minimum: 1, maximum: MAX_LIST, description: `Default 50, at most ${MAX_LIST}.` },
    }),
    async run(tx, args) {
      const result = await listBills(tx, {
        status: args.status,
        contactId: args.contactId,
        awaitingPayment: args.awaitingPayment,
        limit: boundedLimit(args.limit, 50, MAX_LIST),
      });
      return { bills: result.bills.map(billSummary), more: result.nextBeforeId !== null };
    },
  },
  {
    name: "get_bill",
    title: "One bill",
    description:
      "One bill with its lines, by id, or by the supplier's invoice number (several suppliers can use the same number; then the matches are listed and you can ask again by id).",
    inputSchema: schema({
      id: { type: "string", description: "The bill id from list_bills." },
      supplierInvoiceNumber: { type: "string" },
    }),
    async run(tx, args) {
      let id = idOrNull(args.id);
      if (!id) {
        const number = optionalString(args.supplierInvoiceNumber, "supplierInvoiceNumber", { maxLength: 60 });
        if (!number) throw new ValidationError("Give the bill's id or the supplier's invoice number.");
        const found = await tx.query<{ id: string }>(
          "select id::text from bills where upper(supplier_invoice_number) = upper($1) order by id desc limit 20",
          [number],
        );
        if (found.rows.length === 0) throw new NotFoundError(`There's no bill with the supplier invoice number ${number}.`);
        if (found.rows.length > 1) {
          const matches = [];
          for (const row of found.rows) matches.push(billSummary(await getBill(tx, row.id)));
          return { note: `${found.rows.length} bills have that number. Ask again with one of these ids.`, matches };
        }
        id = found.rows[0].id;
      }
      const bill = await getBill(tx, id);
      return { ...billSummary(bill), amountsMode: bill.amountsMode, exchangeRate: bill.exchangeRate, ...documentLines(bill.lines) };
    },
  },
  {
    name: "list_contacts",
    title: "Contacts",
    description: "Customers and suppliers, in name order. Search by name or email; type narrows to customers or suppliers.",
    inputSchema: schema({
      search: { type: "string", description: "Part of a name or email." },
      type: { type: "string", enum: ["customer", "supplier", "all"], description: "Default all." },
      includeArchived: { type: "boolean" },
      limit: { type: "integer", minimum: 1, maximum: MAX_CONTACTS, description: `Default 100, at most ${MAX_CONTACTS}.` },
    }),
    async run(tx, args) {
      const type = args.type ?? "all";
      if (type !== "customer" && type !== "supplier" && type !== "all") {
        throw new ValidationError("type must be customer, supplier or all.");
      }
      const contacts = (await listContacts(tx, { search: args.search, includeArchived: args.includeArchived === true })).filter(
        (contact) => type === "all" || (type === "customer" ? contact.isCustomer : contact.isSupplier),
      );
      return capRows(
        contacts,
        boundedLimit(args.limit, 100, MAX_CONTACTS),
        (contact) => ({
          id: contact.id,
          name: contact.name,
          customer: contact.isCustomer,
          supplier: contact.isSupplier,
          email: contact.email,
          phone: contact.phone,
          gstNumber: contact.gstNumber ? formatGstNumber(contact.gstNumber) : null,
          currencyCode: contact.currencyCode,
          archived: contact.isArchived,
        }),
        "contacts",
      );
    },
  },
  {
    name: "account_transactions",
    title: "Account transactions",
    description:
      "Every ledger line on one account between two dates (general ledger detail), with the opening balance, running balance and closing balance. Without `from` it starts at the beginning of the financial year containing `to`.",
    inputSchema: schema(
      {
        accountCode: { type: "string", description: "The account code from list_accounts, e.g. 200." },
        from: DATE,
        to: DATE,
        limit: { type: "integer", minimum: 1, maximum: MAX_LINES, description: `Lines to show; default 200, at most ${MAX_LINES}.` },
      },
      ["accountCode"],
    ),
    async run(tx, args) {
      const code = optionalString(args.accountCode, "accountCode", { maxLength: 20 });
      if (!code) throw new ValidationError("accountCode is required.");
      const account = (await listAccounts(tx, { includeArchived: true })).find((entry) => entry.code.toLowerCase() === code.toLowerCase());
      if (!account) throw new NotFoundError(`There's no account with the code ${code}.`);
      const report = await accountTransactions(tx, { accountId: account.id, from: args.from, to: args.to });
      const limit = boundedLimit(args.limit, 200, MAX_LINES);
      const detail = report.accounts[0];
      if (!detail) return { from: report.from, to: report.to, account: { code: account.code, name: account.name }, lines: [] };
      const kept = firstRows(detail.lines, limit);
      return {
        from: report.from,
        to: report.to,
        currencyCode: report.currencyCode,
        account: { code: detail.code, name: detail.name, class: detail.accountClass },
        opening: detail.opening,
        totalDebit: detail.totalDebit,
        totalCredit: detail.totalCredit,
        closing: detail.closing,
        lines: kept.rows.map((line) => ({
          date: line.date,
          reference: line.reference,
          description: line.description,
          source: line.source,
          debit: line.debit,
          credit: line.credit,
          balance: line.balance,
        })),
        ...(kept.truncated ? { note: `Showing the first ${limit} of ${kept.total} lines; the totals cover them all.` } : {}),
      };
    },
  },
  {
    name: "gst_return",
    title: "GST return",
    description:
      "Works out the GST return (GST101A boxes 5 to 15) for a period, on the organisation's GST basis, as Tohyee would. Nothing is filed or saved. Also lists filed returns that overlap the period.",
    inputSchema: schema({ periodStart: DATE, periodEnd: DATE }, ["periodStart", "periodEnd"]),
    async run(tx, args) {
      const report = await calculateGstReturn(tx, { periodStart: args.periodStart, periodEnd: args.periodEnd });
      const { lines, ...rest } = report;
      return { ...rest, transactionLineCount: lines.length, note: "Worked out now; nothing was filed or saved." };
    },
  },
  {
    name: "list_draft_journals",
    title: "Draft journals",
    description: "Draft manual journals, newest first: ones still to post (status draft) or already posted (status posted, with the journal's id).",
    inputSchema: schema({
      status: { type: "string", enum: ["draft", "posted"] },
      limit: { type: "integer", minimum: 1, maximum: MAX_LIST, description: `Default 50, at most ${MAX_LIST}.` },
    }),
    async run(tx, args) {
      return { drafts: await listJournalDrafts(tx, { status: args.status, limit: boundedLimit(args.limit, 50, MAX_LIST) }) };
    },
  },
  {
    name: "get_draft_journal",
    title: "One draft journal",
    description: "One draft manual journal with its lines.",
    inputSchema: schema({ draftId: { type: "string", description: "The draft's id from list_draft_journals." } }, ["draftId"]),
    run: (tx, args) => getJournalDraft(tx, args.draftId),
  },
  {
    name: "list_bill_inbox",
    title: "Bills inbox",
    description:
      "Supplier bills and receipts that arrived but aren't bills yet (the bills inbox): file name, where it came from (uploaded, or an email's sender and subject), and whether the same file arrived before. Waiting items by default.",
    inputSchema: schema({
      status: { type: "string", enum: ["waiting", "made", "removed", "all"], description: "Default waiting." },
      limit: { type: "integer", minimum: 1, maximum: MAX_LIST, description: `Default 50, at most ${MAX_LIST}.` },
    }),
    async run(tx, args) {
      const items = await listInbox(tx, { status: args.status, limit: boundedLimit(args.limit, 50, MAX_LIST) });
      return { items: items.map(inboxItemSummary) };
    },
  },
  {
    name: "read_bill_inbox_item",
    title: "Read a bills inbox file",
    description:
      "One bills inbox item with its file (a PDF, or a picture), so you can read the supplier, invoice number, dates, lines and GST from it. Then make a draft bill from it with create_draft_bill_from_inbox_item.",
    inputSchema: schema({ itemId: { type: "string", description: "The item's id from list_bill_inbox." } }, ["itemId"]),
    async run(tx, args) {
      const item = await getInboxItem(tx, args.itemId);
      const file = await getInboxItemContent(tx, item.id);
      return new ToolFileAnswer({ item: inboxItemSummary(item) }, { uri: `tohyee://bills-inbox/${item.id}/${encodeURIComponent(file.fileName)}`, ...file });
    },
  },
  {
    name: "list_approvals",
    title: "Waiting for approval",
    description:
      "Bills, purchase orders and expense claims waiting for approval under an approval rule: the document, its total, the rule, the step it's at and who it's waiting for. Only people approve or decline them, in Tohyee.",
    inputSchema: schema({}),
    async run(tx, _args, context) {
      const requests = await listApprovalRequests(tx, { userId: tx.actor.userId, email: tx.actor.email, role: context.role });
      return {
        requests: requests.map((request) => ({
          requestId: request.id,
          documentType: request.documentType,
          documentId: request.documentId,
          document: request.documentLabel,
          total: request.total,
          currencyCode: request.currencyCode,
          rule: request.ruleName,
          step: request.currentStep,
          steps: request.stepCount,
          waitingFor: request.waitingFor,
          submittedBy: request.submittedByEmail,
          submittedAt: request.submittedAt,
          lastError: request.lastError,
        })),
      };
    },
  },
  ] satisfies Omit<AiTool, "level">[]
).map((tool) => ({ ...tool, level: "read" as const }));
