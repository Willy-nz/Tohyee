/**
 * The guided store setup (#532 follow-up, decisions 1250-1259; worked
 * examples SPC32-SPC34): suggested accounts for posting, the next free
 * account code, what each step still needs, and the worked example the
 * review step shows. Pure functions, shared with the browser; nothing here
 * saves or posts anything.
 */
import { add, cmp, dec, divide, isPositive, mul, sub, toFixedString } from "@/lib/money/decimal";
import type { AccountClass, AccountType } from "@/lib/accounts/types";
import type { SalesPlatform } from "@/lib/sales-platforms/types";

/** The parts of an account the setup looks at (a subset of the chart's Account). */
export type SetupAccount = {
  code: string;
  name: string;
  accountClass: AccountClass;
  accountType: AccountType;
  currencyCode: string | null;
  systemKey: string | null;
  isActive: boolean;
};

export type SetupTaxCode = { code: string; category: string; rate: string; isActive: boolean; availableOn: string };

/** An account the setup can add for you: its code, name and type. */
export type NewAccountSuggestion = { code: string; name: string; accountType: AccountType };

/** Each account the setup asks for. */
export type PostingAccountRole = "sales" | "shipping" | "clearing" | "payout" | "fees" | "chargebacks" | "reserve";

export type RoleSuggestion = {
  /** An account already in the chart to pre-fill, or null. */
  existing: string | null;
  /** What "Create it for me" adds when there's no account to pre-fill. */
  create: NewAccountSuggestion;
  /** The account types this role takes (for the picker and the "Add account" form). */
  types: readonly AccountType[];
};

export const ROLE_TYPES: Record<PostingAccountRole, readonly AccountType[]> = {
  sales: ["revenue", "other_income"],
  shipping: ["revenue", "other_income"],
  clearing: ["bank"],
  payout: ["bank"],
  fees: ["expense", "direct_costs"],
  chargebacks: ["expense", "direct_costs"],
  reserve: ["bank"],
};

/** Whether an account can be used for a role (the server checks the same: revenue, expense or a base-currency bank account). */
export function fitsRole(account: SetupAccount, role: PostingAccountRole, baseCurrency?: string): boolean {
  if (!account.isActive) return false;
  if (ROLE_TYPES[role][0] === "bank") {
    return account.accountType === "bank" && (account.currencyCode === null || !baseCurrency || account.currencyCode === baseCurrency);
  }
  return ROLE_TYPES[role][0] === "revenue" ? account.accountClass === "revenue" : account.accountClass === "expense";
}

/**
 * The first free code at or after `preferred` (numeric codes count up;
 * others get -2, -3...). Codes are compared without case, as the chart does.
 */
export function nextFreeCode(preferred: string, accounts: readonly Pick<SetupAccount, "code">[]): string {
  const taken = new Set(accounts.map((account) => account.code.toLowerCase()));
  if (!taken.has(preferred.toLowerCase())) return preferred;
  if (/^\d+$/.test(preferred)) {
    let value = BigInt(preferred);
    for (let tries = 0; tries < 1000; tries += 1) {
      value += BigInt(1);
      const code = value.toString().padStart(preferred.length, "0");
      if (!taken.has(code)) return code;
    }
  }
  for (let suffix = 2; ; suffix += 1) {
    const code = `${preferred}-${suffix}`;
    if (!taken.has(code.toLowerCase())) return code;
  }
}

const has = (account: SetupAccount, ...words: RegExp[]) => words.every((word) => word.test(account.name));

/** The platform's own name in account names: "Shopify clearing", "WooCommerce sales". */
function shopName(platform: SalesPlatform): string {
  return platform === "woocommerce" ? "WooCommerce" : "Shopify";
}

/**
 * Suggested accounts for each role (decision 1252, "as Xero does, not yet
 * reviewed"). An account already in the chart is pre-filled when one fits;
 * otherwise "Create it for me" adds the suggested one.
 *
 * - Sales: the revenue account named Sales (4000 in the default chart).
 * - Shipping: the same Sales account (Jess, 2 Nov 2026); a separate
 *   "Shipping income" can be added under More options.
 * - Money held by Shopify (clearing): a bank account with "Shopify" and
 *   "clearing" or "held" in its name; else a new bank account
 *   "Shopify clearing" at 1010.
 * - Payouts: the main bank account (system key bank, 1000).
 * - Fees: an expense named Shopify/merchant fees, else Bank fees (6020).
 * - Chargebacks: an expense named chargebacks, else a new "Shopify
 *   chargebacks" at 6025 (SPC25).
 * - Reserve: a bank account named reserve, else "Shopify reserve" at 1015.
 */
export function suggestAccounts(
  accounts: readonly SetupAccount[],
  platform: SalesPlatform,
  baseCurrency?: string,
): Record<PostingAccountRole, RoleSuggestion> {
  const usable = (role: PostingAccountRole) => accounts.filter((account) => fitsRole(account, role, baseCurrency));
  const first = (role: PostingAccountRole, ...tests: Array<(account: SetupAccount) => boolean>) => {
    const list = usable(role);
    for (const test of tests) {
      const found = list.find(test);
      if (found) return found.code;
    }
    return null;
  };
  const shop = shopName(platform);
  const isShopHolding = (account: SetupAccount) => has(account, /shopify|woocommerce|stripe|paypal/i) || has(account, /clearing|reserve|held/i);
  const make = (code: string, name: string, accountType: AccountType): NewAccountSuggestion => ({ code: nextFreeCode(code, accounts), name, accountType });

  const sales = first("sales", (a) => /^sales$/i.test(a.name.trim()), (a) => has(a, /\bsales\b/i), (a) => a.accountType === "revenue");
  return {
    sales: { existing: sales, create: make("4000", "Sales", "revenue"), types: ROLE_TYPES.sales },
    shipping: {
      existing: first("shipping", (a) => has(a, /shipping|postage|freight/i)) ?? sales,
      create: make("4010", "Shipping income", "revenue"),
      types: ROLE_TYPES.shipping,
    },
    clearing: {
      existing: first("clearing", (a) => has(a, new RegExp(shop, "i"), /clearing|held/i)),
      create: make("1010", `${shop} clearing`, "bank"),
      types: ROLE_TYPES.clearing,
    },
    payout: {
      existing: first("payout", (a) => a.systemKey === "bank", (a) => !isShopHolding(a)),
      create: make("1000", "Bank account", "bank"),
      types: ROLE_TYPES.payout,
    },
    fees: {
      existing: first("fees", (a) => has(a, new RegExp(shop, "i"), /fee/i), (a) => has(a, /merchant/i, /fee/i), (a) => has(a, /bank/i, /fee/i)),
      create: make("6020", "Merchant fees", "expense"),
      types: ROLE_TYPES.fees,
    },
    chargebacks: {
      existing: first("chargebacks", (a) => has(a, /chargeback/i)),
      create: make("6025", `${shop} chargebacks`, "expense"),
      types: ROLE_TYPES.chargebacks,
    },
    reserve: {
      existing: first("reserve", (a) => has(a, new RegExp(shop, "i"), /reserve/i), (a) => has(a, /reserve/i)),
      create: make("1015", `${shop} reserve`, "bank"),
      types: ROLE_TYPES.reserve,
    },
  };
}

/** The tax code for untaxed sales (ZERO, else the first zero-rated or exempt sales code) and Shopify's 15% → GST. */
export function suggestTaxCodes(codes: readonly SetupTaxCode[]): { untaxed: string | null; rates: Array<{ rate: string; taxCode: string }> } {
  const sales = codes.filter((code) => code.isActive && code.availableOn !== "purchases");
  const untaxed =
    sales.find((code) => code.code.toUpperCase() === "ZERO" && code.category === "zero_rated") ??
    sales.find((code) => code.category === "zero_rated") ??
    sales.find((code) => code.category === "exempt");
  const standard = sales.find((code) => code.category === "standard" && cmp(dec(code.rate), dec("0.15")) === 0);
  return { untaxed: untaxed?.code ?? null, rates: standard ? [{ rate: "15", taxCode: standard.code }] : [] };
}

/** The settings the posting steps fill in, before anything is saved. */
export type PostingDraft = {
  startDate: string;
  salesAccountCode: string;
  /** Shipping goes to the sales account unless this is on (decision 1253). */
  separateShipping: boolean;
  shippingAccountCode: string;
  clearingAccountCode: string;
  payoutAccountCode: string;
  feesAccountCode: string;
  chargebacksAccountCode: string;
  reserveAccountCode: string;
  untaxedTaxCode: string;
  guestContactId: string;
  taxCodes: Array<{ rate: string; taxCode: string }>;
  /** WooCommerce: method -> account code, "__owing__" (left owing), or "" (not chosen: orders wait). */
  paymentMethods: Array<{ method: string; title: string | null; choice: string }>;
};

export const LEFT_OWING = "__owing__";

/** What a step still needs before Next, in plain words. Empty: ready. */
export function stepGaps(
  step: "start" | "accounts",
  draft: PostingDraft,
  context: { platform: SalesPlatform; gstRegistered: boolean },
): string[] {
  if (step === "start") return /^\d{4}-\d{2}-\d{2}$/.test(draft.startDate) ? [] : ["Choose the start date."];
  const gaps: string[] = [];
  if (!draft.salesAccountCode) gaps.push("Choose the sales account.");
  if (draft.separateShipping && !draft.shippingAccountCode) gaps.push("Choose the shipping account, or record shipping in sales.");
  if (context.platform === "shopify") {
    if (!draft.clearingAccountCode) gaps.push("Choose or create the account for money held by Shopify.");
    if (!draft.payoutAccountCode) gaps.push("Choose the bank account payouts arrive in.");
    if (!draft.feesAccountCode) gaps.push("Choose the account for Shopify's fees.");
    if (draft.clearingAccountCode && draft.clearingAccountCode === draft.payoutAccountCode) {
      gaps.push("Money held by Shopify and the account payouts arrive in must be different accounts.");
    }
    if (draft.reserveAccountCode && (draft.reserveAccountCode === draft.clearingAccountCode || draft.reserveAccountCode === draft.payoutAccountCode)) {
      gaps.push("The reserve account must be different from money held by Shopify and the payouts account.");
    }
  }
  if (context.gstRegistered && !draft.untaxedTaxCode) gaps.push("Choose the tax code for untaxed sales.");
  return gaps;
}

/** The body the final step sends (PATCH on the connection). Posting is on only when the person chose it. */
export function draftToSettings(draft: PostingDraft, platform: SalesPlatform, turnOn: boolean): Record<string, unknown> {
  const or = (value: string) => value || null;
  return {
    postToAccounts: turnOn,
    startDate: or(draft.startDate),
    salesAccountCode: or(draft.salesAccountCode),
    shippingAccountCode: or(draft.separateShipping ? draft.shippingAccountCode : draft.salesAccountCode),
    ...(platform === "woocommerce"
      ? {
          paymentMethods: draft.paymentMethods.map((entry) => ({
            method: entry.method,
            leftOwing: entry.choice === LEFT_OWING,
            accountCode: entry.choice === LEFT_OWING || entry.choice === "" ? null : entry.choice,
          })),
        }
      : {
          clearingAccountCode: or(draft.clearingAccountCode),
          payoutAccountCode: or(draft.payoutAccountCode),
          feesAccountCode: or(draft.feesAccountCode),
          chargebacksAccountCode: or(draft.chargebacksAccountCode),
          reserveAccountCode: or(draft.reserveAccountCode),
        }),
    untaxedTaxCode: or(draft.untaxedTaxCode),
    guestContactId: or(draft.guestContactId),
    taxCodes: draft.taxCodes.filter((entry) => entry.rate !== "" && entry.taxCode !== ""),
  };
}

export type PreviewLine = { account: string; debit: string | null; credit: string | null };
export type PreviewStep = { title: string; text: string; lines: PreviewLine[] };

/**
 * The review step's worked example (SPC32, SPC33): a sale of `amount`
 * (including any GST) paid through the store, with a fee taken from the
 * payout. GST, when registered, is the tax fraction of the price, as
 * Shopify's tax lines give it on a taxes-included store (SPC11).
 */
export function workedExample(input: {
  platform: SalesPlatform;
  amount: string;
  fee: string;
  gstRegistered: boolean;
  gstRate?: string;
  accounts: { sales: string; clearing: string; payout: string; fees: string; receivable?: string; gst?: string; paidInto?: string };
}): { steps: PreviewStep[]; clearingAfter: string } {
  const money = (value: ReturnType<typeof dec>) => toFixedString(value, 2);
  const amount = dec(input.amount);
  const fee = dec(input.fee);
  const rate = dec(input.gstRate ?? "0.15");
  const gst = input.gstRegistered ? divide(mul(amount, rate), add(dec("1"), rate), 2) : dec("0");
  const net = sub(amount, gst);
  const receivable = input.accounts.receivable ?? "Accounts receivable";
  const shop = shopName(input.platform);
  const sale: PreviewStep = {
    title: "A customer pays",
    text: input.gstRegistered
      ? `The invoice is ${money(amount)}: ${money(net)} of sales and ${money(gst)} GST.`
      : `The invoice is ${money(amount)}, all sales (not GST registered, so no GST).`,
    lines: [
      { account: receivable, debit: money(amount), credit: null },
      { account: input.accounts.sales, debit: null, credit: money(net) },
      ...(isPositive(gst) ? [{ account: input.accounts.gst ?? "GST", debit: null, credit: money(gst) }] : []),
    ],
  };
  if (input.platform === "woocommerce") {
    const into = input.accounts.paidInto ?? "the payment method's account";
    return {
      steps: [
        sale,
        {
          title: "The payment is recorded",
          text: `The ${money(amount)} goes into ${into}, so its bank feed line matches. Fees are recorded when you reconcile that account.`,
          lines: [
            { account: into, debit: money(amount), credit: null },
            { account: receivable, debit: null, credit: money(amount) },
          ],
        },
      ],
      clearingAfter: "0.00",
    };
  }
  const payout = sub(amount, fee);
  return {
    steps: [
      sale,
      {
        title: "The payment is recorded",
        text: `The customer has paid, so the ${money(amount)} sits in ${input.accounts.clearing} until ${shop} pays you.`,
        lines: [
          { account: input.accounts.clearing, debit: money(amount), credit: null },
          { account: receivable, debit: null, credit: money(amount) },
        ],
      },
      {
        title: `${shop} pays you`,
        text: `${shop} keeps its ${money(fee)} fee and pays ${money(payout)} into your bank. The payout matches the bank line.`,
        lines: [
          { account: input.accounts.fees, debit: money(fee), credit: null },
          { account: input.accounts.payout, debit: money(payout), credit: null },
          { account: input.accounts.clearing, debit: null, credit: money(amount) },
        ],
      },
    ],
    clearingAfter: money(sub(sub(amount, fee), payout)),
  };
}
