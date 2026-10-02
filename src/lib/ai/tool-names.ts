/**
 * What a connected AI can look at, in plain words, for the AI page. One entry
 * per tool in `@/lib/ai/tools` (a test checks they match). Browser-safe.
 */
export const AI_TOOL_PLAIN_WORDS: readonly { name: string; words: string }[] = [
  { name: "get_organisation", words: "The organisation's name, base currency, financial year end and GST settings" },
  { name: "list_accounts", words: "The chart of accounts" },
  { name: "profit_and_loss", words: "Profit and loss for any dates" },
  { name: "balance_sheet", words: "The balance sheet at any date" },
  { name: "trial_balance", words: "The trial balance at any date" },
  { name: "aged_receivables", words: "What customers owe, and how overdue it is" },
  { name: "aged_payables", words: "What you owe suppliers, and how overdue it is" },
  { name: "list_invoices", words: "Sales invoices (draft, approved or voided)" },
  { name: "get_invoice", words: "One invoice with its lines" },
  { name: "list_bills", words: "Bills from suppliers" },
  { name: "get_bill", words: "One bill with its lines" },
  { name: "list_contacts", words: "Customers and suppliers, with their email, phone and GST number" },
  { name: "account_transactions", words: "Every transaction on an account" },
  { name: "gst_return", words: "The GST return worked out for a period (it can't file it)" },
];
