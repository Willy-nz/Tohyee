import { describe, expect, it } from "vitest";
import { type BankRule, firstFittingRule, normaliseRuleText, ruleAmountsMode, ruleLinesFor, ruleMatches } from "@/lib/bank/rules";
import { defaultsCheckers, withContactDefaults } from "@/lib/contacts/line-defaults";

const rule = (overrides: Partial<BankRule>): BankRule => ({
  id: "1",
  name: "Rule",
  isActive: true,
  priority: 100,
  accountId: null,
  accountCode: null,
  direction: "out",
  matchMode: "all",
  conditions: [{ field: "payee", operator: "contains", text: "SPARK" }],
  contactMode: "chosen",
  contactId: "7",
  contactName: "Spark",
  lines: [{ accountId: "1", accountCode: "6170", accountName: "Telephone", taxCode: "GST", description: null, tracking: {}, fixedAmount: null, percentage: "100.00" }],
  ...overrides,
});

const line = (amount: string, payee: string | null, reference: string | null = null) => ({
  accountId: "10",
  amount,
  description: payee ?? "LINE",
  payee,
  particulars: null,
  code: null,
  reference,
});

const share = (accountCode: string, percentage: string, tag?: string): BankRule["lines"][number] => ({
  accountId: "1",
  accountCode,
  accountName: accountCode,
  taxCode: "GST",
  description: null,
  tracking: tag ? { "1": tag } : ({} as Record<string, string>),
  fixedAmount: null,
  percentage,
});

describe("bank rule conditions (BR1-BR3, BR7)", () => {
  it("ignores case, extra spaces and spaces at either end", () => {
    expect(normaliseRuleText("  CALTEX   Dunedin ")).toBe("caltex dunedin");
  });

  it("joins conditions with all or any, and compares amounts without their sign", () => {
    const a = rule({
      conditions: [
        { field: "payee", operator: "contains", text: "SPARK" },
        { field: "amount", operator: "at_most", amount: "200.00", amountTo: null },
      ],
    });
    expect(ruleMatches(a, line("-115.00", "SPARK"))).toBe(true);
    expect(ruleMatches(a, line("-230.00", "SPARK"))).toBe(false);
    const b = rule({
      matchMode: "any",
      conditions: [
        { field: "payee", operator: "contains", text: "CALTEX" },
        { field: "payee", operator: "contains", text: "Z ENERGY" },
      ],
    });
    expect(ruleMatches(b, line("-69.00", "CALTEX "))).toBe(true);
    expect(ruleMatches(b, line("-11.50", "z  energy"))).toBe(true);
    expect(ruleMatches(b, line("-11.50", "BP"))).toBe(false);
  });

  it("equals, starts with and between", () => {
    const rent = rule({
      conditions: [
        { field: "reference", operator: "equals", text: "RENT" },
        { field: "amount", operator: "between", amount: "2000.00", amountTo: "2300.00" },
      ],
    });
    expect(ruleMatches(rent, line("-2300.00", "HARBOUR", "rent"))).toBe(true);
    expect(ruleMatches(rent, line("-2300.01", "HARBOUR", "rent"))).toBe(false);
    expect(ruleMatches(rent, line("-2300.00", "HARBOUR", "RENT JUNE"))).toBe(false);
    const mobile = rule({ conditions: [{ field: "payee", operator: "starts_with", text: "SPARK MOBILE" }] });
    expect(ruleMatches(mobile, line("-46.01", "SPARK MOBILE NZ"))).toBe(true);
    expect(ruleMatches(mobile, line("-46.01", "MY SPARK MOBILE"))).toBe(false);
  });

  it("respects direction, the rule's account and whether it's on", () => {
    expect(ruleMatches(rule({ direction: "in" }), line("-1.00", "SPARK"))).toBe(false);
    expect(ruleMatches(rule({ accountId: "99" }), line("-1.00", "SPARK"))).toBe(false);
    expect(ruleMatches(rule({ isActive: false }), line("-1.00", "SPARK"))).toBe(false);
    expect(ruleMatches(rule({ conditions: [] }), line("-1.00", "SPARK"))).toBe(false);
  });
});

describe("bank rule lines (BR4-BR6)", () => {
  it("splits 60/40 in cents, the leftover cent to the share that lost most", () => {
    const d = rule({ lines: [share("6170", "60.00", "retail"), share("6170", "40.00", "wholesale")] });
    expect(ruleLinesFor(d, line("-46.01", "SPARK MOBILE"))?.map((entry) => [entry.amount, entry.tracking["1"]])).toEqual([
      ["27.61", "retail"],
      ["18.40", "wholesale"],
    ]);
    expect(ruleLinesFor(d, line("-115.00", "SPARK MOBILE"))?.map((entry) => entry.amount)).toEqual(["69.00", "46.00"]);
    expect(ruleLinesFor(rule({ lines: [share("a", "33.33"), share("b", "33.33"), share("c", "33.34")] }), line("-0.10", "X"))?.map((e) => e.amount)).toEqual([
      "0.03",
      "0.03",
      "0.04",
    ]);
  });

  it("takes fixed amounts first; doesn't fit when they're more than the line; leaves out a 0.00 share", () => {
    const anz = [{ field: "payee" as const, operator: "equals" as const, text: "ANZ" }];
    const e = rule({
      conditions: anz,
      lines: [
        { ...share("6020", "0"), taxCode: null, fixedAmount: "5.00", percentage: null },
        { ...share("2800", "100.00"), taxCode: null },
      ],
    });
    expect(ruleLinesFor(e, line("-505.00", "ANZ"))?.map((entry) => [entry.accountCode, entry.amount])).toEqual([
      ["6020", "5.00"],
      ["2800", "500.00"],
    ]);
    expect(ruleLinesFor(e, line("-3.00", "ANZ"))).toBeNull();
    expect(ruleLinesFor(e, line("-5.00", "ANZ"))?.map((entry) => [entry.accountCode, entry.amount])).toEqual([["6020", "5.00"]]);
    const f = rule({ id: "2", conditions: anz, lines: [{ ...share("6020", "100.00"), taxCode: null }] });
    expect(firstFittingRule([e, f], line("-3.00", "ANZ"))?.rule.id).toBe("2");
    expect(ruleAmountsMode(ruleLinesFor(e, line("-505.00", "ANZ"))!)).toBe("no_tax");
  });

  it("describes lines as the statement line unless the rule says otherwise", () => {
    const r = rule({ lines: [{ ...share("6170", "100.00"), description: "Broadband" }] });
    expect(ruleLinesFor(r, line("-115.00", "SPARK"))?.[0].description).toBe("Broadband");
    expect(ruleLinesFor(rule({}), line("-115.00", "SPARK"))?.[0].description).toBe("SPARK");
  });
});

describe("a contact's defaults on new lines (SD1, SD3)", () => {
  const spark = {
    defaultPurchaseAccountCode: "6170",
    defaultSalesAccountCode: null,
    defaultPurchaseTracking: { "1": "retail" },
    defaultSalesTracking: {},
  };
  const accounts = [
    { code: "6170", isActive: true },
    { code: "6120", isActive: true },
  ];
  const setup = { advancedFeatures: true, categories: [{ isActive: true, values: [{ id: "retail", isActive: true }, { id: "wholesale", isActive: true }] }] };

  it("fills an empty line and leaves a coded one alone", () => {
    const { accountUsable, valueUsable } = defaultsCheckers(accounts, setup);
    const lines: Array<{ accountCode: string; tracking: Record<string, string> }> = [
      { accountCode: "", tracking: {} },
      { accountCode: "6120", tracking: { "1": "wholesale" } },
    ];
    expect(withContactDefaults(lines, spark, "purchase", accountUsable, valueUsable)).toEqual([
      { accountCode: "6170", tracking: { "1": "retail" } },
      { accountCode: "6120", tracking: { "1": "wholesale" } },
    ]);
    expect(withContactDefaults(lines, spark, "sales", accountUsable, valueUsable)).toEqual(lines);
  });

  it("doesn't use an archived default account or tracking value", () => {
    const archived = defaultsCheckers([{ code: "6170", isActive: false }], setup);
    expect(withContactDefaults([{ accountCode: "", tracking: {} }], spark, "purchase", archived.accountUsable, archived.valueUsable)).toEqual([
      { accountCode: "", tracking: {} },
    ]);
    const valueGone = defaultsCheckers(accounts, { advancedFeatures: true, categories: [{ isActive: true, values: [{ id: "retail", isActive: false }] }] });
    expect(withContactDefaults([{ accountCode: "", tracking: {} }], spark, "purchase", valueGone.accountUsable, valueGone.valueUsable)).toEqual([
      { accountCode: "6170", tracking: {} },
    ]);
  });

  it("can treat an untouched sales line as fresh though it has a starting account", () => {
    const customer = { ...spark, defaultSalesAccountCode: "4100", defaultSalesTracking: {} };
    const { accountUsable, valueUsable } = defaultsCheckers([{ code: "4100", isActive: true }], setup);
    const untouched = (entry: { description: string }) => !entry.description;
    const lines = [
      { accountCode: "4000", tracking: {}, description: "" },
      { accountCode: "4000", tracking: {}, description: "Consulting" },
    ];
    expect(withContactDefaults(lines, customer, "sales", accountUsable, valueUsable, untouched).map((entry) => entry.accountCode)).toEqual(["4100", "4000"]);
  });
});
