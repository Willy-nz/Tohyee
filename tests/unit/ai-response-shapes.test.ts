import { describe, expect, it } from "vitest";
import { AI_TOOLS } from "@/lib/ai/catalogue";
import { boundedJson, isoUtc, pageByPosition } from "@/lib/ai/limits";
import { budgetTable, customTable, reportTableProblems, splitTable } from "@/lib/ai/report-table";
import { payoutPage, shareNotes } from "@/lib/ai/sales-platform-tools";
import type { BudgetVsActual } from "@/lib/reports/budget-vs-actual";
import type { AnyCustomReportFigures } from "@/lib/reports/custom";
import type { ProfitAndLossSplit } from "@/lib/reports/financial";

type Schema = { properties?: Record<string, unknown>; required?: string[] };

/** The list tools (#574): every list_ tool, and account_transactions. */
const LIST_TOOLS = AI_TOOLS.filter((tool) => tool.name.startsWith("list_") || tool.name === "account_transactions");

describe("AI list tools page one way (#574, decision 1377)", () => {
  it("there are list tools to check", () => {
    expect(LIST_TOOLS.length).toBeGreaterThan(40);
  });

  it.each(LIST_TOOLS.map((tool) => [tool.name, tool] as const))("%s takes cursor and limit, and needs neither", (_name, tool) => {
    const input = tool.inputSchema as Schema;
    expect(input.properties?.cursor).toMatchObject({ type: "string" });
    expect(input.properties?.limit).toMatchObject({ type: "integer", minimum: 1 });
    expect(input.required ?? []).not.toContain("cursor");
    // The old paging names are only aliases now.
    for (const old of ["offset", "beforeId"]) {
      if (input.properties?.[old]) expect(String((input.properties[old] as { description?: string }).description)).toMatch(/Old name for cursor/);
    }
  });

  it("no list tool's description still tells the AI to page with offset or beforeId", () => {
    for (const tool of LIST_TOOLS) expect(tool.description, tool.name).not.toMatch(/nextBeforeId|use offset|pass offset/);
  });

  it("following position cursors returns every row once, and the last page says there's no more", () => {
    const rows = Array.from({ length: 23 }, (_, index) => `r${index}`);
    for (const limit of [1, 5, 7, 23, 50]) {
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let pages = 0; pages < 30; pages += 1) {
        const page = pageByPosition(rows, cursor, limit);
        seen.push(...page.rows);
        expect(page.more).toBe(page.nextCursor !== null);
        if (!page.more) break;
        cursor = page.nextCursor!;
      }
      expect(seen).toEqual(rows);
    }
    expect(pageByPosition([], undefined, 10)).toEqual({ rows: [], more: false, nextCursor: null });
    expect(() => pageByPosition(rows, "abc", 5)).toThrow(/Start again without a cursor/);
  });
});

describe("account ids and codes (#573, decision 1378)", () => {
  it("every tool that asks for one account takes accountId or accountCode", () => {
    for (const name of ["account_transactions", "list_bank_lines", "list_bank_coding_proposals", "list_mixed_use_lines", "propose_bank_coding"]) {
      const input = AI_TOOLS.find((tool) => tool.name === name)!.inputSchema as Schema;
      expect(Object.keys(input.properties ?? {}), name).toEqual(expect.arrayContaining(["accountId", "accountCode"]));
      expect(input.required ?? [], name).not.toContain("accountId");
      expect(input.required ?? [], name).not.toContain("accountCode");
    }
  });
});

describe("timestamps are ISO 8601 UTC (#579, decision 1381)", () => {
  it("turns Postgres text and Dates into ISO UTC, and leaves anything else", () => {
    expect(isoUtc("2026-11-04 22:30:05.123456+13")).toBe("2026-11-04T09:30:05.123Z");
    expect(isoUtc("2026-06-30 12:00:00+12:00")).toBe("2026-06-30T00:00:00.000Z");
    expect(isoUtc("2026-06-30T00:00:00Z")).toBe("2026-06-30T00:00:00.000Z");
    expect(isoUtc("2026-06-30 08:15:00-0530")).toBe("2026-06-30T13:45:00.000Z");
    expect(isoUtc(new Date(Date.UTC(2026, 5, 30, 1, 2, 3)))).toBe("2026-06-30T01:02:03.000Z");
    expect(isoUtc("2026-06-30")).toBe("2026-06-30");
    expect(isoUtc("Paw print pendant")).toBe("Paw print pendant");
    expect(isoUtc(null)).toBeNull();
  });

  it("every ...At field of a tool answer, however deep, is ISO UTC; other fields aren't touched", () => {
    const answer = {
      batches: [{ createdAt: "2026-11-04 22:30:05.123456+13", lastRunAt: null, note: "2026-11-04 22:30:05+13" }],
      nested: { changedAt: new Date(Date.UTC(2026, 0, 2)), list: [{ loggedAt: "2026-01-02 03:04:05+00" }] },
    };
    expect(JSON.parse(boundedJson(answer)!)).toEqual({
      batches: [{ createdAt: "2026-11-04T09:30:05.123Z", lastRunAt: null, note: "2026-11-04 22:30:05+13" }],
      nested: { changedAt: "2026-01-02T00:00:00.000Z", list: [{ loggedAt: "2026-01-02T03:04:05.000Z" }] },
    });
  });
});

describe("notes given once (#579, decision 1382)", () => {
  it("a note that's the same on every item moves to notes; one that differs stays", () => {
    const items: Array<Record<string, unknown>> = [
      { id: 1, whyNotInAccounts: "Posting payouts is off.", ordersNote: "a" },
      { id: 2, whyNotInAccounts: "Posting payouts is off.", ordersNote: "b" },
      { id: 3 },
    ];
    const notes: Record<string, unknown> = {};
    const field = (key: string) => (item: Record<string, unknown>): [unknown, (item: Record<string, unknown>) => void] | null =>
      key in item ? [item[key], (target) => delete target[key]] : null;
    shareNotes(items, { whyNotInAccounts: field("whyNotInAccounts"), orders: field("ordersNote") }, notes);
    expect(notes).toEqual({ whyNotInAccounts: "Posting payouts is off." });
    expect(items).toEqual([{ id: 1, ordersNote: "a" }, { id: 2, ordersNote: "b" }, { id: 3 }]);
  });
});

describe("payout matches give shared notes once and page (#579, #574)", () => {
  const gstNote = "Registered: GST on the sales came from the orders.";
  const payout = (id: number) => ({
    payoutId: `p${id}`,
    settlement: { note: "Settlement detail wasn't read for this payout." },
    inAccounts: false,
    whyNotInAccounts: "Posting payouts is off for this store.",
    gst: { status: "registered", note: gstNote },
  });
  const report = () => ({
    from: "2026-10-01",
    to: "2026-10-31",
    payouts: Array.from({ length: 5 }, (_, index) => payout(index)),
    deposits: Array.from({ length: 3 }, (_, index) => ({ lineId: `l${index}`, suggestion: { command: "match", note: "For a person to review." } })),
    clearingBalances: [{ accountCode: "1250", balance: "0.00", note: "What the platform still holds." }],
  });

  it("each repeated note is given once, and the answer is smaller", () => {
    const before = JSON.stringify(report()).length;
    const answer = payoutPage(report(), { limit: 50 });
    expect(answer.notes).toEqual({
      gstByStatus: { registered: gstNote },
      whyNotInAccounts: "Posting payouts is off for this store.",
      noSettlement: "Settlement detail wasn't read for this payout.",
      suggestion: "For a person to review.",
      clearingBalance: "What the platform still holds.",
    });
    expect(answer.payouts[0]).toEqual({ payoutId: "p0", settlement: null, inAccounts: false, gst: { status: "registered" } });
    expect(JSON.stringify(answer).length).toBeLessThan(before * 0.7);
  });

  it("pages payouts and deposits together, every one once", () => {
    const payouts: unknown[] = [];
    const deposits: unknown[] = [];
    let cursor: string | null = null;
    for (let pages = 0; pages < 10; pages += 1) {
      const answer = payoutPage(report(), { limit: 2, ...(cursor ? { cursor } : {}) });
      payouts.push(...answer.payouts.map((entry) => (entry as { payoutId: string }).payoutId));
      deposits.push(...answer.deposits.map((entry) => (entry as { lineId: string }).lineId));
      cursor = answer.nextCursor;
      expect(answer.more).toBe(cursor !== null);
      if (!answer.more) break;
    }
    expect(payouts).toEqual(["p0", "p1", "p2", "p3", "p4"]);
    expect(deposits).toEqual(["l0", "l1", "l2"]);
  });
});

describe("one shape for profit and loss style reports (#575, decision 1380)", () => {
  const figures = { actual: "100.00", budget: "80.00", variance: "20.00", variancePercent: "25.0" };
  const line = { accountId: "7", code: "4000", name: "Sales", ...figures };

  it("budget vs actual: actual, budget, variance and % columns, with the profit and loss's labels", () => {
    const report = {
      budget: { id: "1", name: "Plan", trackingLabel: null, version: 1 },
      filter: null,
      from: "2026-04-01",
      to: "2026-06-30",
      currencyCode: "NZD",
      revenue: { sections: [{ key: "revenue", label: "Revenue", lines: [line], total: figures }], total: figures },
      costOfSales: { sections: [], total: { actual: "0.00", budget: "0.00", variance: "0.00", variancePercent: null } },
      grossProfit: figures,
      otherIncome: { sections: [], total: { actual: "0.00", budget: "0.00", variance: "0.00", variancePercent: null } },
      expenses: { sections: [], total: { actual: "0.00", budget: "0.00", variance: "0.00", variancePercent: null } },
      netProfit: figures,
    } as unknown as BudgetVsActual;
    const table = budgetTable(report);
    expect(reportTableProblems(table)).toEqual([]);
    expect(table.columns.map((column) => column.key)).toEqual(["actual", "budget", "variance", "variance_pct"]);
    expect(table.rows.map((row) => row.label)).toEqual(["Trading income", "4000 · Sales", "Total trading income", "Gross profit", "Net profit"]);
    expect(table.rows[1]).toMatchObject({ kind: "account", accountId: "7", code: "4000", values: { actual: "100.00", variance_pct: "25.0" } });
  });

  it("split by tracking: a column per value, Not set and Total", () => {
    const amounts = { "11": "60.00", none: "40.00", total: "100.00" };
    const report = {
      from: "2026-04-01",
      to: "2026-06-30",
      currencyCode: "NZD",
      category: { id: "3", name: "Region" },
      filter: null,
      columns: [
        { key: "11", label: "Otago", valueId: "11" },
        { key: "none", label: "Not set", valueId: null },
        { key: "total", label: "Total", valueId: null },
      ],
      revenue: { sections: [{ key: "revenue", label: "Revenue", lines: [{ accountId: "7", code: "4000", name: "Sales", amounts }], totals: amounts }], totals: amounts },
      costOfSales: { sections: [], totals: {} },
      grossProfit: amounts,
      otherIncome: { sections: [], totals: {} },
      expenses: { sections: [], totals: {} },
      netProfit: amounts,
    } as unknown as ProfitAndLossSplit;
    const table = splitTable(report);
    expect(reportTableProblems(table)).toEqual([]);
    expect(table.columns.map((column) => [column.key, column.kind])).toEqual([["11", "split"], ["none", "split"], ["total", "total"]]);
    expect(table.rows.find((row) => row.label === "Net profit")?.values).toEqual(amounts);
  });

  it("a custom report: table titles as headings, shown accounts before their group, text blocks as text", () => {
    const values = { p0: "100.00" };
    const custom = {
      title: "Board pack",
      base: "profit_and_loss",
      currencyCode: "NZD",
      columns: [{ key: "p0", kind: "period", label: "Jun 2026", from: "2026-06-01", to: "2026-06-30" }],
      blocks: [
        {
          id: "t1",
          kind: "table",
          title: "Income",
          rows: [
            { id: "g1", kind: "group", label: "Sales", values, showAccounts: true, lines: [{ code: "4000", name: "Sales", values, accountId: "7" }] },
            { id: "f1", kind: "formula", label: "Margin", values: { p0: null }, format: "percent", showAccounts: false, lines: [] },
          ],
        },
        { id: "x1", kind: "text", text: "Made-up figures." },
      ],
      notInReport: [],
      inSeveralGroups: [],
      computedAt: "2026-07-01T00:00:00.000Z",
    } as unknown as AnyCustomReportFigures;
    const table = customTable({ id: "9", title: "Board pack", kind: "draft", publishedAt: null }, custom);
    expect(reportTableProblems(table)).toEqual([]);
    expect(table.rows.map((row) => [row.kind, row.label])).toEqual([
      ["heading", "Income"],
      ["account", "4000 · Sales"],
      ["group", "Sales"],
      ["formula", "Margin"],
      ["text", "Made-up figures."],
    ]);
    expect(table).toMatchObject({ report: "custom_report", from: "2026-06-01", to: "2026-06-30" });
  });

  it("the shared check finds a value for a column that isn't there, and a number that isn't a decimal string", () => {
    const bad = {
      report: "profit_and_loss",
      from: null,
      to: "2026-06-30",
      currencyCode: "NZD",
      columns: [{ key: "p0", kind: "period", label: "Jun" }],
      rows: [{ key: "net", kind: "grand", label: "Net profit", values: { p1: "1.00", p0: 5 } }],
    };
    expect(reportTableProblems(bad)).toEqual(["row net has a value for column p1, which isn't a column", "row net p0 is 5"]);
  });
});
