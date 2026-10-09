import { addForecastCommentary, addGroupCommentary } from "@/lib/commentary/service";
import { approvalNeededForAi } from "@/lib/approvals/requests";
import { submitForApproval } from "@/lib/approvals/service";
import { configuredOrigin } from "@/lib/auth/origin";
import { kickEmailOutbox } from "@/lib/email/outbox";
import { randomBytes } from "node:crypto";
import { type AiTool, billSummary, DATE, documentLines, inboxItemSummary, invoiceSummary, type JsonSchema, schema } from "@/lib/ai/tools";
import { billDuplicateWarnings } from "@/lib/bills/duplicates";
import { addInboxItem, createBillFromInboxItem } from "@/lib/bills/inbox";
import { ValidationError } from "@/lib/errors";
import { recordSupplierPayment } from "@/lib/bills/payments";
import { approveBill, createBill, getBill, updateBill } from "@/lib/bills/service";
import { createContact, getContact, updateContact } from "@/lib/contacts/service";
import { recordPayment } from "@/lib/invoices/payments";
import { approveInvoice, createInvoice, getInvoice, updateInvoice } from "@/lib/invoices/service";
import { createJournalDraft, postJournalDraft, updateJournalDraft } from "@/lib/ledger/journal-drafts";
import { ConflictError } from "@/lib/errors";
import { requireId, requireIdempotencyKey } from "@/lib/validation";

/**
 * Tools that change the books (decisions 346-348). "draft" tools make and
 * edit contacts and drafts, which post nothing; "post" tools approve, post
 * and record payments. None deletes, voids, archives, rolls back, refunds or
 * removes anything (decision 347). Each calls the same service as the screen
 * does, in a normal transaction, as the key's owner with the key noted
 * (`tx.actor.via`), so the history shows "<person> via AI key <name>".
 * Commands that create something take an idempotency key, kept per AI key
 * (command source "ai-<key id>"), so a retried call doesn't double up.
 */

export const IDEMPOTENCY: JsonSchema = {
  type: "string",
  pattern: "^[A-Za-z0-9._:-]{8,120}$",
  description:
    "8-120 letters, numbers, dots, colons, dashes or underscores. Send the same key if you retry the same call, so it isn't done twice; a new key for a new one. Made up for you if left out (then a retry would do it again).",
};
export const ID = (what: string): JsonSchema => ({ type: "string", description: `The ${what}'s id.` });
export const AMOUNTS_MODE: JsonSchema = {
  type: "string",
  enum: ["exclusive", "inclusive", "no_tax"],
  description: "Whether unit prices exclude GST, include GST, or have no GST.",
};
export const DOCUMENT_LINES: JsonSchema = {
  type: "array",
  minItems: 1,
  maxItems: 200,
  description: "The lines. On an edit, these replace every line.",
  items: {
    type: "object",
    properties: {
      description: { type: "string" },
      quantity: { type: "string", description: "A decimal, e.g. \"2\"." },
      unitPrice: { type: "string", description: "A decimal, e.g. \"50.00\"." },
      accountCode: { type: "string", description: "From list_accounts." },
      taxCode: { type: ["string", "null"], description: "A GST code, e.g. GST, ZERO, EXEMPT, or null for none." },
    },
    required: ["description", "quantity", "unitPrice", "accountCode"],
  },
};
const JOURNAL_LINES: JsonSchema = {
  type: "array",
  minItems: 2,
  maxItems: 500,
  description: "Each line has a debit or a credit (not both); debits must equal credits.",
  items: {
    type: "object",
    properties: {
      accountCode: { type: "string", description: "From list_accounts." },
      debitAmount: { type: "string", description: "A decimal, e.g. \"600.00\"." },
      creditAmount: { type: "string" },
      description: { type: "string" },
    },
    required: ["accountCode"],
  },
};

export function idempotencyKey(input: unknown): string {
  return input === undefined || input === null || input === "" ? `ai-${randomBytes(12).toString("hex")}` : requireIdempotencyKey(input);
}

const CONTACT_FIELDS: Record<string, JsonSchema> = {
  name: { type: "string" },
  isCustomer: { type: "boolean" },
  isSupplier: { type: "boolean" },
  email: { type: "string" },
  phone: { type: "string" },
  postalAddress: { type: "string" },
  gstNumber: { type: "string", description: "8 or 9 digits, e.g. 123-456-789." },
};

function contactInput(args: Record<string, unknown>) {
  const { name, isCustomer, isSupplier, email, phone, postalAddress, gstNumber } = args;
  return { name, isCustomer, isSupplier, email, phone, postalAddress, gstNumber };
}

const INVOICE_FIELDS: Record<string, JsonSchema> = {
  contactId: { type: "string", description: "The customer's id from list_contacts." },
  invoiceDate: DATE,
  dueDate: { ...DATE, description: "Left out, from the customer's or the organisation's payment terms." },
  reference: { type: "string" },
  amountsMode: AMOUNTS_MODE,
  lines: DOCUMENT_LINES,
};

const BILL_FIELDS: Record<string, JsonSchema> = {
  contactId: { type: "string", description: "The supplier's id from list_contacts." },
  billDate: DATE,
  dueDate: { ...DATE, description: "Left out, from the supplier's or the organisation's payment terms." },
  supplierInvoiceNumber: { type: "string", description: "The supplier's own invoice number (needed before it's approved)." },
  amountsMode: AMOUNTS_MODE,
  lines: DOCUMENT_LINES,
};

const JOURNAL_FIELDS: Record<string, JsonSchema> = {
  postingDate: DATE,
  reference: { type: "string", description: "Up to 100 characters." },
  description: { type: "string" },
  lines: JOURNAL_LINES,
};

function journalInput(args: Record<string, unknown>) {
  return { postingDate: args.postingDate, reference: args.reference, description: args.description, lines: args.lines };
}

const invoiceDetail = async (tx: Parameters<AiTool["run"]>[0], id: string) => {
  const invoice = await getInvoice(tx, id);
  return { ...invoiceSummary(invoice), amountsMode: invoice.amountsMode, ...documentLines(invoice.lines) };
};
const billDetail = async (tx: Parameters<AiTool["run"]>[0], id: string) => {
  const bill = await getBill(tx, id);
  return { ...billSummary(bill), amountsMode: bill.amountsMode, ...documentLines(bill.lines) };
};

export const PAYMENT_FIELDS: Record<string, JsonSchema> = {
  paymentDate: DATE,
  amount: { type: "string", description: "A decimal, at most what's still due." },
  bankAccountCode: { type: "string", description: "A bank or credit card account's code from list_accounts." },
  reference: { type: "string" },
  idempotencyKey: IDEMPOTENCY,
};

export const WRITE_TOOLS: readonly AiTool[] = [
  // ---------------------------------------------------------------- draft level
  {
    name: "create_contact",
    title: "Add a contact",
    level: "draft",
    description: "Adds a customer or supplier (or both). Returns the new contact.",
    inputSchema: schema({ ...CONTACT_FIELDS, idempotencyKey: IDEMPOTENCY }, ["name"]),
    async run(tx, args, context) {
      const result = await createContact(
        tx,
        { ...contactInput(args), source: context.source, idempotencyKey: idempotencyKey(args.idempotencyKey) },
        { role: context.role },
      );
      return { created: result.created, contact: result.contact };
    },
  },
  {
    name: "update_contact",
    title: "Edit a contact",
    level: "draft",
    description: "Changes a contact's details. Fields left out stay as they are. It can't archive a contact.",
    inputSchema: schema({ contactId: ID("contact"), ...CONTACT_FIELDS }, ["contactId"]),
    async run(tx, args, context) {
      await getContact(tx, args.contactId);
      return { contact: await updateContact(tx, args.contactId, contactInput(args), { role: context.role }) };
    },
  },
  {
    name: "create_draft_invoice",
    title: "Draft a sales invoice",
    level: "draft",
    description: "Saves a draft sales invoice. A draft posts nothing until it's approved. Returns the draft with its totals.",
    inputSchema: schema({ ...INVOICE_FIELDS, idempotencyKey: IDEMPOTENCY }, ["contactId", "invoiceDate", "amountsMode", "lines"]),
    async run(tx, args, context) {
      const { contactId, invoiceDate, dueDate, reference, amountsMode, lines } = args;
      const result = await createInvoice(
        tx,
        { source: context.source, idempotencyKey: idempotencyKey(args.idempotencyKey), contactId, invoiceDate, dueDate, reference, amountsMode, lines },
        { foreignCurrency: true },
      );
      return { created: result.created, invoice: await invoiceDetail(tx, result.invoice.id) };
    },
  },
  {
    name: "update_draft_invoice",
    title: "Edit a draft invoice",
    level: "draft",
    description: "Changes a draft sales invoice. Fields left out stay as they are; lines, if given, replace every line. Approved invoices can't be edited.",
    inputSchema: schema({ invoiceId: ID("invoice"), ...INVOICE_FIELDS }, ["invoiceId"]),
    async run(tx, args) {
      const { contactId, invoiceDate, dueDate, reference, amountsMode, lines } = args;
      const invoice = await updateInvoice(tx, args.invoiceId, { contactId, invoiceDate, dueDate, reference, amountsMode, lines });
      return { invoice: await invoiceDetail(tx, invoice.id) };
    },
  },
  {
    name: "create_draft_bill",
    title: "Draft a bill",
    level: "draft",
    description: "Saves a draft bill from a supplier. A draft posts nothing until it's approved. Returns the draft with its totals.",
    inputSchema: schema({ ...BILL_FIELDS, idempotencyKey: IDEMPOTENCY }, ["contactId", "billDate", "amountsMode", "lines"]),
    async run(tx, args, context) {
      const { contactId, billDate, dueDate, supplierInvoiceNumber, amountsMode, lines } = args;
      const result = await createBill(
        tx,
        { source: context.source, idempotencyKey: idempotencyKey(args.idempotencyKey), contactId, billDate, dueDate, supplierInvoiceNumber, amountsMode, lines },
        null,
        { foreignCurrency: true },
      );
      return { created: result.created, bill: await billDetail(tx, result.bill.id) };
    },
  },
  {
    name: "create_draft_bill_from_inbox_item",
    title: "Draft a bill from the bills inbox",
    level: "draft",
    description:
      "Saves a draft bill from a bills inbox item you've read (read_bill_inbox_item): the item's file is attached to the draft and the item leaves the waiting list. Use the supplier's contact id (add the supplier with create_contact first if it's new). A person checks the draft against the file and approves it. The answer says if it looks like a bill already entered.",
    inputSchema: schema({ itemId: ID("bills inbox item"), ...BILL_FIELDS, idempotencyKey: IDEMPOTENCY }, ["itemId", "contactId", "billDate", "amountsMode", "lines"]),
    async run(tx, args, context) {
      const { contactId, billDate, dueDate, supplierInvoiceNumber, amountsMode, lines } = args;
      const result = await createBillFromInboxItem(tx, context.role, args.itemId, {
        source: context.source,
        idempotencyKey: idempotencyKey(args.idempotencyKey),
        contactId,
        billDate,
        dueDate,
        supplierInvoiceNumber,
        amountsMode,
        lines,
      });
      // DU5: the AI is told, and can't approve past it.
      const warnings = (await billDuplicateWarnings(tx, result.bill.id)).map((warning) => warning.message);
      return {
        created: result.created,
        bill: await billDetail(tx, result.bill.id),
        item: inboxItemSummary(result.item),
        possibleDuplicates: warnings,
        ...(warnings.length > 0 ? { note: "This may be a bill already entered. Tell the person; only a person can approve it anyway." } : {}),
      };
    },
  },
  {
    name: "add_bill_inbox_item",
    title: "Add a file to the bills inbox",
    level: "draft",
    description: "Adds a supplier bill or receipt (a PDF, JPG, PNG or HEIC file, at most 10 MB) to the bills inbox, for someone to make a bill from. Nothing is posted.",
    inputSchema: schema(
      {
        fileName: { type: "string", description: "The file's name, ending .pdf, .jpg, .png or .heic." },
        contentBase64: { type: "string", description: "The file's bytes, base64 encoded." },
        idempotencyKey: IDEMPOTENCY,
      },
      ["fileName", "contentBase64"],
    ),
    async run(tx, args, context) {
      if (typeof args.contentBase64 !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(args.contentBase64.replace(/\s/g, ""))) {
        throw new ValidationError("contentBase64 must be the file's bytes, base64 encoded.");
      }
      const content = new Uint8Array(Buffer.from(args.contentBase64.replace(/\s/g, ""), "base64"));
      const result = await addInboxItem(tx, {
        source: context.source,
        idempotencyKey: idempotencyKey(args.idempotencyKey),
        fileName: args.fileName,
        content,
        via: "ai",
      });
      return { created: result.created, item: inboxItemSummary(result.item) };
    },
  },
  {
    name: "update_draft_bill",
    title: "Edit a draft bill",
    level: "draft",
    description: "Changes a draft bill. Fields left out stay as they are; lines, if given, replace every line. Approved bills can't be edited.",
    inputSchema: schema({ billId: ID("bill"), ...BILL_FIELDS }, ["billId"]),
    async run(tx, args) {
      const { contactId, billDate, dueDate, supplierInvoiceNumber, amountsMode, lines } = args;
      const bill = await updateBill(tx, args.billId, { contactId, billDate, dueDate, supplierInvoiceNumber, amountsMode, lines });
      return { bill: await billDetail(tx, bill.id) };
    },
  },
  {
    name: "create_draft_journal",
    title: "Draft a journal",
    level: "draft",
    description:
      "Saves a draft manual journal for someone to check and post. It must balance; it posts nothing until it's posted. Returns the draft.",
    inputSchema: schema({ ...JOURNAL_FIELDS, idempotencyKey: IDEMPOTENCY }, ["postingDate", "reference", "lines"]),
    async run(tx, args, context) {
      const result = await createJournalDraft(tx, { source: context.source, idempotencyKey: idempotencyKey(args.idempotencyKey), ...journalInput(args) });
      return { created: result.created, draft: result.draft };
    },
  },
  {
    name: "update_draft_journal",
    title: "Edit a draft journal",
    level: "draft",
    description: "Replaces a draft journal's date, reference, description and lines. Posted drafts can't be changed.",
    inputSchema: schema({ draftId: ID("draft journal"), ...JOURNAL_FIELDS }, ["draftId", "postingDate", "reference", "lines"]),
    async run(tx, args) {
      return { draft: await updateJournalDraft(tx, args.draftId, journalInput(args)) };
    },
  },
  {
    name: "submit_for_approval",
    title: "Submit for approval",
    level: "draft",
    description:
      "Submits a draft bill or purchase order (or an expense claim) for approval under the first approval rule that matches it. It stays a draft, can't be edited until a person withdraws it, and the rule's approvers are asked. Only people approve or decline it.",
    inputSchema: schema(
      {
        documentType: { type: "string", enum: ["bill", "purchase_order", "expense_claim"], description: "What kind of document." },
        documentId: ID("document"),
      },
      ["documentType", "documentId"],
    ),
    async run(tx, args, context) {
      const request = await submitForApproval(tx, { userId: tx.actor.userId, email: tx.actor.email, role: context.role }, args.documentType, args.documentId, {
        origin: await configuredOrigin(),
      });
      kickEmailOutbox(context.organisationId);
      return {
        requestId: request.id,
        document: request.documentLabel,
        rule: request.ruleName,
        step: request.currentStep,
        steps: request.stepCount,
        waitingFor: request.waitingFor,
      };
    },
  },
  {
    name: "suggest_report_commentary",
    title: "Suggest a report commentary",
    level: "draft",
    description:
      "Saves a written commentary on the cash flow forecast or a consolidation group's profit and loss or balance sheet, as a suggestion: it shows as suggested by this AI key and not checked until a person accepts, edits or removes it. Read the report first (cash_flow_forecast or consolidated_report) and say which period it's about.",
    inputSchema: schema(
      {
        report: { type: "string", enum: ["cash_flow_forecast", "consolidated_profit_and_loss", "consolidated_balance_sheet"] },
        groupId: { type: "string", description: "For a consolidated report: the group from list_consolidations." },
        periodLabel: { type: "string", description: 'What it covers, e.g. "Weeks from 5 Oct 2026 to 3 Jan 2027".' },
        text: { type: "string", description: "The commentary, plain text, at most 5,000 characters." },
      },
      ["report", "periodLabel", "text"],
    ),
    async run(tx, args) {
      if (args.report === "cash_flow_forecast") {
        return { commentary: await addForecastCommentary(tx, { periodLabel: args.periodLabel, body: args.text }) };
      }
      if (!tx.actor.userId) throw new ConflictError("This key has no person behind it, so it can't comment on consolidations.");
      return {
        commentary: await addGroupCommentary({ id: tx.actor.userId, email: tx.actor.email, via: tx.actor.via }, args.groupId, { report: args.report, periodLabel: args.periodLabel, body: args.text }),
      };
    },
  },
  // ---------------------------------------------------------------- post level
  {
    name: "approve_invoice",
    title: "Approve an invoice",
    level: "post",
    description: "Approves a draft sales invoice: gives it its number and posts it to the ledger on its date. It can't be undone here (only voided by a person).",
    inputSchema: schema({ invoiceId: ID("invoice"), idempotencyKey: IDEMPOTENCY }, ["invoiceId"]),
    async run(tx, args, context) {
      const result = await approveInvoice(tx, args.invoiceId, { source: context.source, idempotencyKey: idempotencyKey(args.idempotencyKey) });
      return { created: result.created, invoice: await invoiceDetail(tx, result.invoice.id) };
    },
  },
  {
    name: "approve_bill",
    title: "Approve a bill",
    level: "post",
    description:
      "Approves a draft bill: posts it to the ledger on its date. It can't be undone here (only voided by a person). A bill that looks like one already entered is refused: only a person can approve it anyway. So is a bill an approval rule applies to: submit it for approval instead (submit_for_approval).",
    inputSchema: schema({ billId: ID("bill"), idempotencyKey: IDEMPOTENCY }, ["billId"]),
    async run(tx, args, context) {
      // A bill under an approval rule is approved by people only (AW13, question 6).
      const needed = await approvalNeededForAi(tx, "bill", requireId(args.billId, "billId"));
      if (needed) throw new ConflictError(needed);
      // Never past a duplicate warning (DU5): that's for a person.
      const result = await approveBill(tx, args.billId, { source: context.source, idempotencyKey: idempotencyKey(args.idempotencyKey) });
      return { created: result.created, bill: await billDetail(tx, result.bill.id) };
    },
  },
  {
    name: "post_draft_journal",
    title: "Post a draft journal",
    level: "post",
    description: "Posts a draft manual journal to the ledger, once. Refused if its date is in a locked period.",
    inputSchema: schema({ draftId: ID("draft journal") }, ["draftId"]),
    async run(tx, args) {
      const result = await postJournalDraft(tx, args.draftId);
      return { created: result.created, draft: result.draft, journalId: result.journal.id };
    },
  },
  {
    name: "record_invoice_payment",
    title: "Record a customer payment",
    level: "post",
    description: "Records money received against an approved sales invoice, into a bank account: posts Dr the bank / Cr accounts receivable.",
    inputSchema: schema({ invoiceId: ID("invoice"), ...PAYMENT_FIELDS }, ["invoiceId", "paymentDate", "amount", "bankAccountCode"]),
    async run(tx, args, context) {
      const result = await recordPayment(tx, args.invoiceId, {
        source: context.source,
        idempotencyKey: idempotencyKey(args.idempotencyKey),
        paymentDate: args.paymentDate,
        amount: args.amount,
        bankAccountCode: args.bankAccountCode,
        reference: args.reference,
      });
      return { created: result.created, payment: result.payment, invoice: invoiceSummary(await getInvoice(tx, args.invoiceId as string)) };
    },
  },
  {
    name: "record_bill_payment",
    title: "Record a supplier payment",
    level: "post",
    description: "Records money paid against an approved bill, from a bank account: posts Dr accounts payable / Cr the bank.",
    inputSchema: schema({ billId: ID("bill"), ...PAYMENT_FIELDS }, ["billId", "paymentDate", "amount", "bankAccountCode"]),
    async run(tx, args, context) {
      const result = await recordSupplierPayment(tx, args.billId, {
        source: context.source,
        idempotencyKey: idempotencyKey(args.idempotencyKey),
        paymentDate: args.paymentDate,
        amount: args.amount,
        bankAccountCode: args.bankAccountCode,
        reference: args.reference,
      });
      return { created: result.created, payment: result.payment, bill: billSummary(await getBill(tx, args.billId as string)) };
    },
  },
];
