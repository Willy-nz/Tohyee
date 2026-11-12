import { tool } from "@/lib/ai/document-action-tools";
import { type AiTool, DATE } from "@/lib/ai/tools";
import { ID } from "@/lib/ai/write-tools";
import { updatePaymentTerm, createPaymentTerm } from "@/lib/customers/service";
import { deleteExpenseClaim, declineExpenseClaim, getExpenseClaim, submitExpenseClaim, voidExpenseClaim, voidExpenseClaimPayment } from "@/lib/expense-claims/service";
import { disposeFixedAsset, previewDisposal, rollBackDepreciationRun, undoDisposal } from "@/lib/fixed-assets/runs";
import { archiveFixedAsset, getFixedAsset } from "@/lib/fixed-assets/service";
import { postMovement } from "@/lib/inventory/movements";
import { transferStock } from "@/lib/inventory/transfers";
import { addItemUnit } from "@/lib/items/service";
import { postJournal } from "@/lib/ledger/journals";
import { getPeriodControls, updatePeriodControls } from "@/lib/ledger/period-controls";
import { runRepeatingBillNow, setRepeatingBillStatus } from "@/lib/repeating/bills";
import { runRepeatingInvoiceNow, setRepeatingStatus } from "@/lib/repeating/service";
import { updateSalesperson, createSalesperson } from "@/lib/salespeople/service";
import { createTaxCode, updateTaxCode } from "@/lib/tax/codes";
import { renameBudget, setBudgetArchived } from "@/lib/budgets/service";
import {
  addCustomFieldOption,
  createCustomField,
  createCustomFieldSection,
  deleteCustomFieldSection,
  getCustomFieldSetup,
  updateCustomField,
  updateCustomFieldOption,
  updateCustomFieldSection,
} from "@/lib/custom-fields/service";
import { CUSTOM_FIELD_RECORDS, CUSTOM_FIELD_TYPES, CONTACT_USES, DOCUMENT_KINDS } from "@/lib/custom-fields/values";

/**
 * AI tools for screen actions, part 3 (decision 1600): journals, the lock
 * date, tax codes, payment terms, salespeople, expense claims, fixed
 * assets, repeating invoices and bills, stock, item units and budgets. Each
 * calls the screen's own service at the screen's role; voids, rollbacks,
 * deletes, archiving, disposals and the lock date confirm first (decision
 * 1601).
 */

const RECORD = { type: "string", enum: [...CUSTOM_FIELD_RECORDS], description: "What it's on: contact, document (invoices, bills and so on), line (their lines), person or opportunity (CRM)." } as const;
const USED_ON = {
  type: "array",
  items: { type: "string", enum: [...CONTACT_USES, ...DOCUMENT_KINDS] },
  description: "For a contact field: customer, supplier and/or prospect. For a document or line field: invoice, bill, credit_note, supplier_credit_note, spend, receive and/or journal. Left out for people and opportunities.",
} as const;
const MOVE = { type: "string", enum: ["up", "down"], description: "Moves it one place up or down." } as const;
const KIND = { type: "string", enum: ["days_after_invoice", "days_after_month_end", "day_of_next_month"] } as const;
const MONEY = { type: "string", description: "A decimal, e.g. \"120.00\"." } as const;
const JOURNAL_LINE = {
  type: "object",
  properties: {
    accountCode: { type: "string" },
    debitAmount: MONEY,
    creditAmount: MONEY,
    description: { type: "string", maxLength: 500 },
    taxCode: { type: ["string", "null"] },
  },
  required: ["accountCode"],
  additionalProperties: false,
} as const;

export const SETTINGS_ACTION_TOOLS: AiTool[] = [
  tool({
    name: "post_journal",
    title: "Post a manual journal",
    description:
      "Posts a manual journal straight away, as New journal and Post do on the Journals page; no draft. Balanced lines in the base currency unless currencyCode says otherwise. Prefer fixing the transaction itself (recode_bank_transactions, correct_journal) to a journal that only moves an amount between accounts.",
    level: "post",
    input: {
      postingDate: DATE,
      reference: { type: "string", maxLength: 200 },
      description: { type: "string", maxLength: 1000 },
      currencyCode: { type: "string", minLength: 3, maxLength: 3 },
      lines: { type: "array", minItems: 2, maxItems: 500, items: JOURNAL_LINE },
    },
    required: ["postingDate", "reference", "lines"],
    act: (tx, args, command) =>
      postJournal(tx, { ...command, postingDate: args.postingDate, reference: args.reference, description: args.description, currencyCode: args.currencyCode, lines: args.lines }),
  }),
  tool({
    name: "set_lock_date",
    title: "Set the lock date",
    description:
      "Settings › Lock date: nothing can be posted, changed or voided on or before lockDate (null unlocks), with the reason kept in the history. Lock a period once its GST or year is filed.",
    role: "admin",
    level: "full",
    input: { lockDate: { type: ["string", "null"], format: "date", description: "YYYY-MM-DD, or null to unlock." }, reason: { type: "string", maxLength: 500 } },
    required: ["lockDate", "reason"],
    shows: (tx) => getPeriodControls(tx),
    act: (tx, args) => updatePeriodControls(tx, { lockDate: args.lockDate, reason: args.reason }),
  }),
  tool({
    name: "create_tax_code",
    title: "Add a GST code",
    description: "Settings › GST codes: a new code with its rate and category, from effectiveFrom.",
    role: "admin",
    level: "post",
    input: {
      code: { type: "string", maxLength: 20 },
      label: { type: "string", maxLength: 100 },
      category: { type: "string", enum: ["standard", "zero_rated", "exempt", "out_of_scope"] },
      rate: { type: "string", description: "Percent, e.g. \"15\"." },
      effectiveFrom: DATE,
      effectiveTo: DATE,
      availableOn: { type: "array", items: { type: "string", enum: ["sales", "purchases"] } },
    },
    required: ["code", "label", "category", "rate", "effectiveFrom"],
    act: (tx, args, command) =>
      createTaxCode(tx, { ...command, code: args.code, label: args.label, category: args.category, rate: args.rate, effectiveFrom: args.effectiveFrom, effectiveTo: args.effectiveTo, availableOn: args.availableOn }),
  }),
  tool({
    name: "update_tax_code",
    title: "Change where a GST code is offered",
    description: "Settings › GST codes: whether a code is offered on sales, purchases or both. Its rate can't change; add a new code instead.",
    role: "admin",
    level: "post",
    input: { taxCodeId: ID("GST code"), availableOn: { type: "array", items: { type: "string", enum: ["sales", "purchases"] } } },
    required: ["taxCodeId", "availableOn"],
    act: (tx, args) => updateTaxCode(tx, args.taxCodeId, { availableOn: args.availableOn }),
  }),
  tool({
    name: "create_payment_term",
    title: "Add payment terms",
    description: "Settings › Customers › Payment terms: e.g. 20th of the next month (kind day_of_next_month, days 20), 14 days after the invoice (days_after_invoice, 14) or 20 days after the month end (days_after_month_end, 20).",
    role: "admin",
    level: "post",
    input: { name: { type: "string", maxLength: 100 }, kind: KIND, days: { type: "integer", minimum: 0, maximum: 365 } },
    required: ["name", "kind", "days"],
    act: (tx, args) => createPaymentTerm(tx, { name: args.name, kind: args.kind, days: args.days }),
  }),
  tool({
    name: "update_payment_term",
    title: "Change payment terms",
    description: "Settings › Customers › Payment terms: rename, change, or switch off (isActive false) a payment term.",
    role: "admin",
    level: "full",
    input: { termId: ID("payment term"), name: { type: "string", maxLength: 100 }, kind: KIND, days: { type: "integer", minimum: 0, maximum: 365 }, isActive: { type: "boolean" } },
    required: ["termId"],
    act: (tx, args) => updatePaymentTerm(tx, args.termId, { name: args.name, kind: args.kind, days: args.days, isActive: args.isActive }),
  }),
  tool({
    name: "create_salesperson",
    title: "Add a salesperson",
    description: "Settings › Salespeople: someone sales can be credited to.",
    role: "admin",
    level: "post",
    input: { name: { type: "string", maxLength: 200 }, email: { type: "string", maxLength: 320 } },
    required: ["name"],
    act: (tx, args) => createSalesperson(tx, { name: args.name, email: args.email }),
  }),
  tool({
    name: "update_salesperson",
    title: "Change a salesperson",
    description: "Settings › Salespeople: rename, change the email, or switch off (isActive false).",
    role: "admin",
    level: "full",
    input: { salespersonId: ID("salesperson"), name: { type: "string", maxLength: 200 }, email: { type: "string", maxLength: 320 }, isActive: { type: "boolean" } },
    required: ["salespersonId"],
    act: (tx, args) => updateSalesperson(tx, args.salespersonId, { name: args.name, email: args.email, isActive: args.isActive }),
  }),

  // Custom fields: Settings › Custom fields. Values never reach the ledger.
  {
    name: "get_custom_fields",
    title: "Custom fields",
    description: "Settings › Custom fields: every custom field with what it's on, its type, where it's used, its options and sections. Values are filled in on the records themselves (invoices, contacts and so on take customFields).",
    level: "read",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: (tx) => getCustomFieldSetup(tx),
  },
  tool({
    name: "create_custom_field",
    title: "Add a custom field",
    description:
      "Settings › Custom fields › Add: a field of your own on contacts, documents, lines, people or opportunities, e.g. \"Pet's name\" (text) on invoices. A list or multiple select takes options. Only for information and reports: it never changes the accounts.",
    role: "admin",
    level: "post",
    input: {
      record: RECORD,
      label: { type: "string", maxLength: 100 },
      type: { type: "string", enum: [...CUSTOM_FIELD_TYPES] },
      usedOn: USED_ON,
      help: { type: "string", maxLength: 500 },
      isRequired: { type: "boolean" },
      defaultValue: { description: "A value of the field's type." },
      showInList: { type: "boolean", description: "Show it as a column in the record's list." },
      options: { type: "array", maxItems: 200, items: { type: "string", maxLength: 100 }, description: "For a list or multiple select." },
      sectionId: { type: "string", description: "A section from get_custom_fields (contacts, people and opportunities)." },
    },
    required: ["record", "label", "type"],
    act: (tx, args) =>
      createCustomField(tx, {
        record: args.record,
        label: args.label,
        type: args.type,
        usedOn: args.usedOn,
        help: args.help,
        isRequired: args.isRequired,
        defaultValue: args.defaultValue,
        showInList: args.showInList,
        options: args.options,
        sectionId: args.sectionId,
      }),
  }),
  tool({
    name: "update_custom_field",
    title: "Change a custom field",
    description:
      "Settings › Custom fields: rename it, change its help, where it's used, whether it's required, its default, its list column, section or place (move), or switch it off (isActive false, confirmed first since it's hidden from every record). Values already filled in are kept.",
    role: "admin",
    level: "full",
    input: {
      fieldId: ID("custom field"),
      label: { type: "string", maxLength: 100 },
      help: { type: "string", maxLength: 500 },
      usedOn: USED_ON,
      isRequired: { type: "boolean" },
      defaultValue: { description: "A value of the field's type, or null." },
      showInList: { type: "boolean" },
      isActive: { type: "boolean" },
      sectionId: { type: ["string", "null"] },
      move: MOVE,
    },
    required: ["fieldId"],
    act: (tx, args) =>
      updateCustomField(tx, args.fieldId, {
        label: args.label,
        help: args.help,
        usedOn: args.usedOn,
        isRequired: args.isRequired,
        defaultValue: args.defaultValue,
        showInList: args.showInList,
        isActive: args.isActive,
        sectionId: args.sectionId,
        move: args.move,
      }),
  }),
  tool({
    name: "add_custom_field_option",
    title: "Add an option to a list field",
    description: "Settings › Custom fields: another choice on a list or multiple select field.",
    role: "admin",
    level: "post",
    input: { fieldId: ID("custom field"), name: { type: "string", maxLength: 100 } },
    required: ["fieldId", "name"],
    act: (tx, args) => addCustomFieldOption(tx, args.fieldId, { name: args.name }),
  }),
  tool({
    name: "update_custom_field_option",
    title: "Rename or switch off a list option",
    description: "Settings › Custom fields: rename a choice, or switch it off (isActive false) so it's no longer offered; records that have it keep it.",
    role: "admin",
    level: "full",
    input: { optionId: ID("option"), name: { type: "string", maxLength: 100 }, isActive: { type: "boolean" } },
    required: ["optionId"],
    act: (tx, args) => updateCustomFieldOption(tx, args.optionId, { name: args.name, isActive: args.isActive }),
  }),
  tool({
    name: "create_custom_field_section",
    title: "Add a custom field section",
    description: "Settings › Custom fields: a heading grouping fields on contacts, people or opportunities.",
    role: "admin",
    level: "post",
    input: { record: RECORD, name: { type: "string", maxLength: 100 } },
    required: ["record", "name"],
    act: (tx, args) => createCustomFieldSection(tx, { record: args.record, name: args.name }),
  }),
  tool({
    name: "update_custom_field_section",
    title: "Rename or move a custom field section",
    description: "Settings › Custom fields: rename a section, or move it up or down.",
    role: "admin",
    level: "post",
    input: { sectionId: ID("section"), name: { type: "string", maxLength: 100 }, move: MOVE },
    required: ["sectionId"],
    act: (tx, args) => updateCustomFieldSection(tx, args.sectionId, { name: args.name, move: args.move }),
  }),
  tool({
    name: "delete_custom_field_section",
    title: "Delete a custom field section",
    description: "Settings › Custom fields: removes a section heading; its fields stay, without a section.",
    role: "admin",
    level: "full",
    input: { sectionId: ID("section") },
    required: ["sectionId"],
    act: (tx, args) => deleteCustomFieldSection(tx, args.sectionId),
  }),

  // Expense claims.
  tool({
    name: "submit_expense_claim",
    title: "Submit an expense claim",
    description: "Submit on a draft expense claim: it goes for approval (approve_expense_claim) under the approval rules.",
    level: "post",
    input: { claimId: ID("expense claim") },
    required: ["claimId"],
    act: (tx, args) => submitExpenseClaim(tx, args.claimId, { origin: null }),
  }),
  tool({
    name: "decline_expense_claim",
    title: "Decline an expense claim",
    description: "Decline on a submitted expense claim, with the reason kept: it goes back to the claimant.",
    level: "post",
    input: { claimId: ID("expense claim"), reason: { type: "string", maxLength: 1000 } },
    required: ["claimId", "reason"],
    act: (tx, args) => declineExpenseClaim(tx, tx.actor.role ?? "bookkeeper", args.claimId, { reason: args.reason }),
  }),
  tool({
    name: "void_expense_claim",
    title: "Void an expense claim",
    description: "Void on an approved expense claim with no payments: reverses it on voidDate.",
    level: "full",
    input: { claimId: ID("expense claim"), voidDate: DATE },
    required: ["claimId", "voidDate"],
    shows: (tx, args) => getExpenseClaim(tx, args.claimId),
    act: (tx, args, command) => voidExpenseClaim(tx, tx.actor.role ?? "bookkeeper", args.claimId, { ...command, voidDate: args.voidDate }),
  }),
  tool({
    name: "void_expense_claim_payment",
    title: "Void an expense claim payment",
    description: "Void on a payment of an expense claim: reverses it on voidDate; the claim is owing again.",
    level: "full",
    input: { claimId: ID("expense claim"), paymentId: ID("payment"), voidDate: DATE },
    required: ["claimId", "paymentId", "voidDate"],
    shows: (tx, args) => getExpenseClaim(tx, args.claimId),
    act: (tx, args, command) => voidExpenseClaimPayment(tx, tx.actor.role ?? "bookkeeper", args.claimId, args.paymentId, { ...command, voidDate: args.voidDate }),
  }),
  tool({
    name: "delete_draft_expense_claim",
    title: "Delete a draft expense claim",
    description: "Delete on a draft expense claim: it's gone, with nothing posted.",
    level: "full",
    input: { claimId: ID("expense claim") },
    required: ["claimId"],
    shows: (tx, args) => getExpenseClaim(tx, args.claimId),
    act: async (tx, args) => {
      await deleteExpenseClaim(tx, args.claimId);
      return { deleted: true, claimId: String(args.claimId) };
    },
  }),

  // Fixed assets.
  tool({
    name: "dispose_fixed_asset",
    title: "Sell or dispose of a fixed asset",
    description:
      "Dispose on a registered fixed asset: depreciation to disposalDate, then the asset and its accumulated depreciation off the books, with proceeds (to proceedsAccountCode) and the gain or loss (gainLossAccountCode; capitalGainAccountCode for proceeds over cost). The confirmation shows the screen's own preview of the journal.",
    level: "full",
    input: {
      assetId: ID("fixed asset"),
      disposalDate: DATE,
      proceeds: { ...MONEY, description: "What it sold for, \"0.00\" if scrapped." },
      proceedsAccountCode: { type: "string", description: "Where the proceeds went (e.g. the bank account), when there are any." },
      gainLossAccountCode: { type: "string" },
      capitalGainAccountCode: { type: "string" },
    },
    required: ["assetId", "disposalDate", "proceeds"],
    shows: (tx, args) => previewDisposal(tx, args.assetId, args),
    act: (tx, args, command) => disposeFixedAsset(tx, args.assetId, { ...args, ...command }),
  }),
  tool({
    name: "undo_fixed_asset_disposal",
    title: "Undo a disposal",
    description: "Undo disposal: reverses the disposal journal and the asset is registered again.",
    level: "full",
    input: { assetId: ID("fixed asset") },
    required: ["assetId"],
    shows: (tx, args) => getFixedAsset(tx, args.assetId),
    act: (tx, args, command) => undoDisposal(tx, args.assetId, command),
  }),
  tool({
    name: "archive_fixed_asset",
    title: "Archive a draft fixed asset",
    description: "Archive on a fixed asset that was never registered: it's out of the lists. A registered one is disposed of instead.",
    level: "full",
    input: { assetId: ID("fixed asset") },
    required: ["assetId"],
    shows: (tx, args) => getFixedAsset(tx, args.assetId),
    act: (tx, args) => archiveFixedAsset(tx, args.assetId),
  }),
  tool({
    name: "roll_back_depreciation_run",
    title: "Roll back a depreciation run",
    description: "Roll back on the latest depreciation run: its journal is reversed and the assets' book values go back to before it. Only the latest run.",
    level: "full",
    input: { runId: ID("depreciation run") },
    required: ["runId"],
    act: (tx, args, command) => rollBackDepreciationRun(tx, args.runId, command),
  }),

  // Repeating invoices and bills.
  tool({
    name: "run_repeating_invoice",
    title: "Make the next repeating invoice now",
    description: "Run now on a repeating invoice: its next invoice is made now, as the schedule would.",
    level: "post",
    input: { repeatingInvoiceId: ID("repeating invoice") },
    required: ["repeatingInvoiceId"],
    act: (tx, args) => runRepeatingInvoiceNow(tx, args.repeatingInvoiceId),
  }),
  tool({
    name: "set_repeating_invoice_status",
    title: "Pause, resume or end a repeating invoice",
    description: "Pause, Resume or End on a repeating invoice (status paused, active or ended).",
    level: "post",
    input: { repeatingInvoiceId: ID("repeating invoice"), status: { type: "string", enum: ["active", "paused", "ended"] } },
    required: ["repeatingInvoiceId", "status"],
    act: (tx, args) => setRepeatingStatus(tx, args.repeatingInvoiceId, args.status),
  }),
  tool({
    name: "run_repeating_bill",
    title: "Make the next repeating bill now",
    description: "Run now on a repeating bill: its next bill is made now, as the schedule would.",
    level: "post",
    input: { repeatingBillId: ID("repeating bill") },
    required: ["repeatingBillId"],
    act: (tx, args) => runRepeatingBillNow(tx, args.repeatingBillId),
  }),
  tool({
    name: "set_repeating_bill_status",
    title: "Pause, resume or end a repeating bill",
    description: "Pause, Resume or End on a repeating bill (status paused, active or ended).",
    level: "post",
    input: { repeatingBillId: ID("repeating bill"), status: { type: "string", enum: ["active", "paused", "ended"] } },
    required: ["repeatingBillId", "status"],
    act: (tx, args) => setRepeatingBillStatus(tx, args.repeatingBillId, args.status),
  }),

  // Stock and items.
  tool({
    name: "post_stock_movement",
    title: "Post a stock movement",
    description:
      "Stock › New movement: a receipt, issue, adjustment, customer or supplier return, or landed cost for a stock item (itemCode), with its quantity (quantityDelta for an adjustment), unit cost or amount, and the account on the other side.",
    level: "post",
    input: {
      movementType: { type: "string", enum: ["receipt", "issue", "adjustment", "customer_return", "supplier_return", "landed_cost"] },
      movementDate: DATE,
      itemCode: { type: "string" },
      quantity: { type: "string" },
      quantityDelta: { type: "string" },
      unitCost: MONEY,
      amount: MONEY,
      offsetAccountCode: { type: "string" },
      inventoryAccountCode: { type: "string" },
      locationValueId: { type: "string" },
      originalMovementId: { type: "string" },
      reference: { type: "string", maxLength: 200 },
      description: { type: "string", maxLength: 1000 },
    },
    required: ["movementType", "movementDate", "itemCode"],
    act: (tx, args, command) => postMovement(tx, { ...args, ...command }),
  }),
  tool({
    name: "transfer_stock",
    title: "Move stock between locations",
    description: "Stock › Transfer: moves a quantity of an item from one location to another at its cost.",
    level: "post",
    input: {
      transferDate: DATE,
      itemId: ID("item"),
      fromLocationValueId: { type: "string" },
      toLocationValueId: { type: "string" },
      quantity: { type: "string" },
      reference: { type: "string", maxLength: 200 },
      description: { type: "string", maxLength: 1000 },
    },
    required: ["transferDate", "itemId", "fromLocationValueId", "toLocationValueId", "quantity"],
    act: (tx, args, command) =>
      transferStock(tx, {
        ...command,
        transferDate: args.transferDate,
        itemId: args.itemId,
        fromLocationValueId: args.fromLocationValueId,
        toLocationValueId: args.toLocationValueId,
        quantity: args.quantity,
        reference: args.reference ?? "",
        description: args.description,
      }),
  }),
  tool({
    name: "add_item_unit",
    title: "Add a unit to an item",
    description: "Items › Units: another unit the item is sold or bought in, as factor base units (e.g. a box of 12).",
    level: "post",
    input: { itemId: ID("item"), name: { type: "string", maxLength: 50 }, factor: { type: "string" } },
    required: ["itemId", "name", "factor"],
    act: (tx, args) => addItemUnit(tx, args.itemId, { name: args.name, factor: args.factor }),
  }),

  // Budgets.
  tool({
    name: "rename_budget",
    title: "Rename a budget",
    description: "Rename on a budget (version: the budget's version from get_budget).",
    level: "post",
    input: { budgetId: ID("budget"), name: { type: "string", maxLength: 200 }, version: { type: "integer" } },
    required: ["budgetId", "name"],
    act: (tx, args) => renameBudget(tx, args.budgetId, { name: args.name, version: args.version }),
  }),
  tool({
    name: "archive_budget",
    title: "Archive a budget",
    description: "Archive (or, with archived false, restore) a budget: it's out of the lists and reports' choices.",
    level: "full",
    input: { budgetId: ID("budget"), archived: { type: "boolean" } },
    required: ["budgetId", "archived"],
    act: (tx, args) => setBudgetArchived(tx, args.budgetId, args.archived === true),
  }),
];
