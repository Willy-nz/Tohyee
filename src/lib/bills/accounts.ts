import { ACCOUNT_TYPES, type AccountClass, type AccountType } from "@/lib/accounts/types";

/** What's needed to tell whether an account can take a bill line. */
export type BillLineAccount = {
  accountClass: AccountClass;
  accountType: AccountType;
  systemKey: string | null;
  currencyCode: string | null;
};

export const BILL_LINE_ACCOUNT_RULE =
  "Bill lines go to expense, direct costs or asset accounts, but not bank, accounts receivable, accounts payable or GST.";

const CONTROL_ACCOUNTS: Record<string, string> = {
  accounts_receivable: "the accounts receivable account",
  accounts_payable: "the accounts payable account",
  gst: "the GST account",
};

/**
 * Why an account can't take a bill line, or null if it can. Lines go to
 * expense, direct costs or asset accounts; bank accounts and the accounts
 * receivable, accounts payable and GST accounts are refused, and so are
 * foreign-currency accounts, because bills are in the base currency. The
 * result follows "account 1000 (Business bank account) is ...". Used by the
 * bill service and to filter the accounts the bill editor offers.
 */
export function billLineAccountProblem(account: BillLineAccount): string | null {
  const control = account.systemKey ? CONTROL_ACCOUNTS[account.systemKey] : undefined;
  if (control) {
    return `${control}. ${BILL_LINE_ACCOUNT_RULE}`;
  }
  if (account.accountType === "bank") {
    return `a bank account. ${BILL_LINE_ACCOUNT_RULE}`;
  }
  const allowed =
    account.accountClass === "asset" || account.accountType === "expense" || account.accountType === "direct_costs";
  if (!allowed) {
    const type = ACCOUNT_TYPES[account.accountType].label.toLowerCase();
    return `${/^[aeiou]/.test(type) ? "an" : "a"} ${type} account. ${BILL_LINE_ACCOUNT_RULE}`;
  }
  if (account.currencyCode) {
    return `in ${account.currencyCode}, but bills are in the base currency.`;
  }
  return null;
}
