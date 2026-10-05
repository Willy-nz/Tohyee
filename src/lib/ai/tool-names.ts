import type { AiAccessLevel } from "@/lib/ai/access-levels";

/**
 * What a connected AI can do, in plain words, for the AI page: one entry per
 * tool in `@/lib/ai/catalogue` (a test checks they match), with the access
 * level it needs. Browser-safe.
 */
export const AI_TOOL_PLAIN_WORDS: readonly { name: string; level: AiAccessLevel; words: string }[] = [
  { name: "get_organisation", level: "read", words: "The organisation's name, base currency, financial year end and GST settings" },
  { name: "list_accounts", level: "read", words: "The chart of accounts" },
  { name: "profit_and_loss", level: "read", words: "Profit and loss for any dates" },
  { name: "balance_sheet", level: "read", words: "The balance sheet at any date" },
  { name: "trial_balance", level: "read", words: "The trial balance at any date" },
  { name: "aged_receivables", level: "read", words: "What customers owe, and how overdue it is" },
  { name: "aged_payables", level: "read", words: "What you owe suppliers, and how overdue it is" },
  { name: "list_invoices", level: "read", words: "Sales invoices (draft, approved or voided)" },
  { name: "get_invoice", level: "read", words: "One invoice with its lines" },
  { name: "list_bills", level: "read", words: "Bills from suppliers" },
  { name: "get_bill", level: "read", words: "One bill with its lines" },
  { name: "list_contacts", level: "read", words: "Customers and suppliers, with their email, phone and GST number" },
  { name: "account_transactions", level: "read", words: "Every transaction on an account" },
  { name: "gst_return", level: "read", words: "The GST return worked out for a period (it can't file it)" },
  { name: "list_draft_journals", level: "read", words: "Draft journals" },
  { name: "get_draft_journal", level: "read", words: "One draft journal with its lines" },
  { name: "list_bill_inbox", level: "read", words: "The bills inbox: supplier bills and receipts waiting to be entered" },
  { name: "read_bill_inbox_item", level: "read", words: "Read a file in the bills inbox (the PDF or picture itself)" },
  { name: "list_approvals", level: "read", words: "What's waiting for approval, and who it's waiting for" },
  { name: "create_contact", level: "draft", words: "Add a customer or supplier" },
  { name: "update_contact", level: "draft", words: "Edit a contact's details (not archive it)" },
  { name: "create_draft_invoice", level: "draft", words: "Make a draft sales invoice" },
  { name: "update_draft_invoice", level: "draft", words: "Edit a draft sales invoice" },
  { name: "create_draft_bill", level: "draft", words: "Make a draft bill" },
  { name: "update_draft_bill", level: "draft", words: "Edit a draft bill" },
  { name: "create_draft_bill_from_inbox_item", level: "draft", words: "Make a draft bill from a bills inbox file, with the file attached" },
  { name: "add_bill_inbox_item", level: "draft", words: "Add a supplier bill or receipt file to the bills inbox" },
  { name: "create_draft_journal", level: "draft", words: "Make a draft journal" },
  { name: "update_draft_journal", level: "draft", words: "Edit a draft journal" },
  { name: "submit_for_approval", level: "draft", words: "Submit a draft bill, purchase order or expense claim for approval (only people approve it)" },
  { name: "approve_invoice", level: "post", words: "Approve a draft invoice (it's numbered and posted)" },
  { name: "approve_bill", level: "post", words: "Approve a draft bill (it's posted)" },
  { name: "post_draft_journal", level: "post", words: "Post a draft journal" },
  { name: "record_invoice_payment", level: "post", words: "Record money received against an invoice, into a bank account" },
  { name: "record_bill_payment", level: "post", words: "Record money paid against a bill, from a bank account" },
];
