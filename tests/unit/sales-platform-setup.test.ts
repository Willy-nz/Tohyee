import { describe, expect, it } from "vitest";
import { NZ_DEFAULT_CHART } from "@/lib/accounts/default-chart";
import { ACCOUNT_TYPES } from "@/lib/accounts/types";
import { NZ_DEFAULT_TAX_CODES } from "@/lib/tax/default-codes";
import {
  customerChoiceOf,
  customerChoiceSettings,
  draftToSettings,
  fitsRole,
  LEFT_OWING,
  nextFreeCode,
  type PostingDraft,
  type SetupAccount,
  skuNote,
  stepGaps,
  suggestAccounts,
  suggestTaxCodes,
  workedExample,
} from "@/lib/sales-platforms/setup";

/** The guided store setup's suggestions and worked example (SPC32-SPC34, decisions 1250-1259). */
const chart: SetupAccount[] = NZ_DEFAULT_CHART.map((account) => ({
  code: account.code,
  name: account.name,
  accountType: account.type,
  accountClass: ACCOUNT_TYPES[account.type].accountClass,
  currencyCode: null,
  systemKey: account.systemKey ?? null,
  isActive: true,
}));
const taxCodes = NZ_DEFAULT_TAX_CODES.map((code) => ({ ...code, isActive: true, availableOn: "both" }));

const draft = (overrides: Partial<PostingDraft> = {}): PostingDraft => ({
  startDate: "2026-11-01",
  salesAccountCode: "4000",
  separateShipping: false,
  shippingAccountCode: "",
  clearingAccountCode: "1010",
  payoutAccountCode: "1000",
  feesAccountCode: "6020",
  chargebacksAccountCode: "",
  reserveAccountCode: "",
  untaxedTaxCode: "ZERO",
  guestContactId: "",
  taxCodes: [{ rate: "15", taxCode: "GST" }],
  paymentMethods: [],
  ...overrides,
});

describe("SPC32: suggested accounts on the default chart", () => {
  it("pre-fills sales, payouts and fees, and offers to create money held by Shopify, chargebacks and reserve", () => {
    const suggested = suggestAccounts(chart, "shopify");
    expect(suggested.sales.existing).toBe("4000");
    // Shipping goes to sales unless chosen otherwise (Jess, 2 Nov 2026).
    expect(suggested.shipping.existing).toBe("4000");
    expect(suggested.payout.existing).toBe("1000");
    expect(suggested.fees.existing).toBe("6020");
    expect(suggested.clearing).toMatchObject({ existing: null, create: { code: "1010", name: "Shopify clearing", accountType: "bank" } });
    expect(suggested.chargebacks).toMatchObject({ existing: null, create: { code: "6025", name: "Shopify chargebacks", accountType: "expense" } });
    expect(suggested.reserve).toMatchObject({ existing: null, create: { code: "1015", name: "Shopify reserve", accountType: "bank" } });
    expect(suggested.shipping.create).toEqual({ code: "4010", name: "Shipping income", accountType: "revenue" });
  });

  it("finds accounts already added, and never suggests a holding account for payouts", () => {
    const withShop: SetupAccount[] = [
      { code: "1001", name: "Shopify clearing", accountType: "bank", accountClass: "asset", currencyCode: null, systemKey: null, isActive: true },
      { code: "6026", name: "Chargebacks", accountType: "expense", accountClass: "expense", currencyCode: null, systemKey: null, isActive: true },
      ...chart.map((account) => (account.code === "1000" ? { ...account, systemKey: null } : account)),
    ];
    const suggested = suggestAccounts(withShop, "shopify");
    expect(suggested.clearing.existing).toBe("1001");
    expect(suggested.chargebacks.existing).toBe("6026");
    expect(suggested.payout.existing).toBe("1000");
  });

  it("skips codes already taken", () => {
    expect(nextFreeCode("1010", chart)).toBe("1010");
    expect(nextFreeCode("6020", chart)).toBe("6021");
    expect(nextFreeCode("SHOP", [{ code: "shop" }, { code: "SHOP-2" }])).toBe("SHOP-3");
    const taken = [...chart, { ...chart[0], code: "1010", name: "Something else" }];
    expect(suggestAccounts(taken, "shopify").clearing.create.code).toBe("1011");
  });

  it("only offers accounts the server will take for each role", () => {
    const byCode = (code: string) => chart.find((account) => account.code === code)!;
    expect(fitsRole(byCode("1000"), "clearing")).toBe(true);
    expect(fitsRole(byCode("1100"), "clearing")).toBe(false);
    expect(fitsRole(byCode("4000"), "sales")).toBe(true);
    expect(fitsRole(byCode("6020"), "fees")).toBe(true);
    expect(fitsRole(byCode("4000"), "chargebacks")).toBe(false);
    expect(fitsRole({ ...byCode("1000"), currencyCode: "AUD" }, "payout", "NZD")).toBe(false);
    expect(fitsRole({ ...byCode("4000"), isActive: false }, "sales")).toBe(false);
  });

  it("suggests ZERO for untaxed sales and Shopify's 15% as GST", () => {
    expect(suggestTaxCodes(taxCodes)).toEqual({ untaxed: "ZERO", rates: [{ rate: "15", taxCode: "GST" }] });
    expect(suggestTaxCodes([])).toEqual({ untaxed: null, rates: [] });
  });
});

describe("SPC33: the review step's worked example", () => {
  const accounts = { sales: "4000 Sales", clearing: "1010 Shopify clearing", payout: "1000 Business bank account", fees: "6020 Bank fees" };

  it("a $100 sale with a $3 fee, GST registered", () => {
    const example = workedExample({ platform: "shopify", amount: "100.00", fee: "3.00", gstRegistered: true, accounts });
    expect(example.steps.map((step) => step.lines)).toEqual([
      [
        { account: "Accounts receivable", debit: "100.00", credit: null },
        { account: "4000 Sales", debit: null, credit: "86.96" },
        { account: "GST", debit: null, credit: "13.04" },
      ],
      [
        { account: "1010 Shopify clearing", debit: "100.00", credit: null },
        { account: "Accounts receivable", debit: null, credit: "100.00" },
      ],
      [
        { account: "6020 Bank fees", debit: "3.00", credit: null },
        { account: "1000 Business bank account", debit: "97.00", credit: null },
        { account: "1010 Shopify clearing", debit: null, credit: "100.00" },
      ],
    ]);
    expect(example.clearingAfter).toBe("0.00");
  });

  it("not GST registered: all $100 is sales", () => {
    const example = workedExample({ platform: "shopify", amount: "100.00", fee: "3.00", gstRegistered: false, accounts });
    expect(example.steps[0].lines).toEqual([
      { account: "Accounts receivable", debit: "100.00", credit: null },
      { account: "4000 Sales", debit: null, credit: "100.00" },
    ]);
    expect(example.steps[0].text).toContain("not GST registered");
  });

  it("WooCommerce: the payment goes into the payment method's account", () => {
    const example = workedExample({ platform: "woocommerce", amount: "100.00", fee: "3.00", gstRegistered: true, accounts: { ...accounts, paidInto: "1020 Stripe" } });
    expect(example.steps).toHaveLength(2);
    expect(example.steps[1].lines[0]).toEqual({ account: "1020 Stripe", debit: "100.00", credit: null });
  });

  it("every step balances", () => {
    for (const gstRegistered of [true, false]) {
      for (const step of workedExample({ platform: "shopify", amount: "57.50", fee: "1.97", gstRegistered, accounts }).steps) {
        const cents = (side: "debit" | "credit") => step.lines.reduce((total, line) => total + Math.round(Number(line[side] ?? "0") * 100), 0);
        expect(cents("debit")).toBe(cents("credit"));
      }
    }
  });
});

describe("SPC34: the posting steps save nothing until the end, and never turn posting on by themselves", () => {
  it("says what each step still needs", () => {
    const shop = { platform: "shopify" as const, gstRegistered: true };
    expect(stepGaps("start", draft({ startDate: "" }), shop)).toEqual(["Choose the start date."]);
    expect(stepGaps("start", draft(), shop)).toEqual([]);
    expect(stepGaps("accounts", draft(), shop)).toEqual([]);
    expect(stepGaps("accounts", draft({ clearingAccountCode: "", untaxedTaxCode: "" }), shop)).toEqual([
      "Choose or create the account for money held by Shopify.",
      "Choose the tax code for untaxed sales.",
    ]);
    expect(stepGaps("accounts", draft({ clearingAccountCode: "1000" }), shop)).toContain(
      "Money held by Shopify and the account payouts arrive in must be different accounts.",
    );
    expect(stepGaps("accounts", draft({ separateShipping: true }), shop)).toEqual(["Choose the shipping account, or record shipping in sales."]);
    // WooCommerce has no clearing, payout or fees account (WC2); not GST registered needs no untaxed code.
    expect(stepGaps("accounts", draft({ clearingAccountCode: "", payoutAccountCode: "", feesAccountCode: "", untaxedTaxCode: "" }), { platform: "woocommerce", gstRegistered: false })).toEqual([]);
  });

  it("sends shipping to sales unless a separate account is chosen, and posting is on only when asked", () => {
    expect(draftToSettings(draft(), "shopify", false)).toMatchObject({ postToAccounts: false, salesAccountCode: "4000", shippingAccountCode: "4000", clearingAccountCode: "1010" });
    expect(draftToSettings(draft({ separateShipping: true, shippingAccountCode: "4010" }), "shopify", true)).toMatchObject({
      postToAccounts: true,
      shippingAccountCode: "4010",
    });
    const woo = draftToSettings(draft({ paymentMethods: [{ method: "bacs", title: "Bank transfer", choice: LEFT_OWING }, { method: "stripe", title: null, choice: "1020" }] }), "woocommerce", false);
    expect(woo).not.toHaveProperty("clearingAccountCode");
    expect(woo.paymentMethods).toEqual([
      { method: "bacs", leftOwing: true, accountCode: null },
      { method: "stripe", leftOwing: false, accountCode: "1020" },
    ]);
  });
});

/** Decisions 1334 and 1338: what comes in. */
describe("customers and SKUs in the setup", () => {
  it("maps the customers choice to the connection's settings and back", () => {
    expect(customerChoiceSettings("buyers")).toEqual({ syncCustomers: true, customerScope: "buyers" });
    expect(customerChoiceSettings("all")).toEqual({ syncCustomers: true, customerScope: "all" });
    expect(customerChoiceSettings("off")).toEqual({ syncCustomers: false });
    expect(customerChoiceOf({ syncCustomers: true, customerScope: "buyers" })).toBe("buyers");
    expect(customerChoiceOf({ syncCustomers: true, customerScope: "all" })).toBe("all");
    expect(customerChoiceOf({ syncCustomers: false, customerScope: "all" })).toBe("off");
  });

  it("warns when many variants have no SKU", () => {
    expect(skuNote("Shopify", { linked: 30, withoutSku: 0 })).toBeNull();
    expect(skuNote("Shopify", { linked: 40, withoutSku: 2 })).toMatchObject({ tone: "info" });
    expect(skuNote("Shopify", { linked: 40, withoutSku: 1 })!.text).toMatch(/^1 of 40 Shopify variants has no SKU\. It came in as an item/);
    expect(skuNote("Shopify", { linked: 8, withoutSku: 2 })).toMatchObject({ tone: "warning" });
    const many = skuNote("Shopify", { linked: 200, withoutSku: 12 })!;
    expect(many.tone).toBe("warning");
    expect(many.text).toContain("12 of 200 Shopify variants have no SKU");
    expect(many.text).toContain("add SKUs in Shopify: the items stay linked");
  });
});
