import { afterAll, beforeAll, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { postJournal } from "@/lib/ledger/journals";
import { type CashFlowFigures, computeCashFlowLayout, parseCashFlowLayout } from "@/lib/reports/cash-flow-layout";
import { createCustomReport, getCustomReport } from "@/lib/reports/custom";
import { type CashFlowLayout, standardCashFlowLayout } from "@/lib/reports/custom-layout";
import { buildFinancialStatements } from "@/lib/reports/financial-statements";
import { runDefaultCashFlowLayout, setLayoutDefault } from "@/lib/reports/report-layouts";
import { createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "cash-flow-layouts";
const COLUMNS = [{ key: "y2027", kind: "period" as const, label: "2027", from: "2026-04-01", to: "2027-03-31" }];

/** Cash flow layouts (CFL1-CFL4; not yet reviewed). Made-up figures. */
describeWithDatabase("cash flow layouts", () => {
  let server: TestServer;
  let owner: SessionUser;
  const run = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: owner.id, email: owner.email }, work);
  const work = (layout: unknown) => run(async (tx) => computeCashFlowLayout(tx, await parseCashFlowLayout(tx, layout), { columns: COLUMNS }));
  /** [section, [row label, amount]..., total] for each section, then the last lines. */
  const shape = (figures: CashFlowFigures) => ({
    sections: figures.blocks.flatMap((block) =>
      block.kind === "section"
        ? [
            [
              block.title,
              ...block.rows.filter((row) => !row.hidden).map((row) => [row.label, row.values.y2027 ?? null]),
              [block.total.label, block.total.values.y2027],
            ],
          ]
        : [],
    ),
    end: figures.end.map((line) => [line.label, line.values.y2027]),
  });
  const columns = standardCashFlowLayout("2027-03-31").columns;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("cash-flow-layouts-owner@example.com", { serverAdmin: true });
    await createTestOrganisation(owner, ORG);
    const pair = (date: string, debit: string, credit: string, amount: string) =>
      run((tx) =>
        postJournal(tx, {
          idempotencyKey: key("j"),
          postingDate: date,
          reference: "Year",
          lines: [
            { accountCode: debit, debitAmount: amount, creditAmount: "0" },
            { accountCode: credit, debitAmount: "0", creditAmount: amount },
          ],
        }),
      );
    await pair("2026-04-10", "1000", "3000", "3000.00");
    await pair("2026-05-10", "1000", "4000", "8000.00");
    await pair("2026-06-10", "6010", "2400", "1500.00");
    await pair("2026-07-10", "1620", "1000", "2000.00");
    await pair("2026-08-10", "3100", "1000", "1200.00");
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("the standard layout is the standard statement", async () => {
    const figures = await work(standardCashFlowLayout("2027-03-31"));
    expect(shape(figures)).toEqual({
      sections: [
        ["Operating activities", ["Net profit", "6500.00"], ["Credit card", "1500.00"], ["Net cash from operating activities", "8000.00"]],
        ["Investing activities", ["Computer equipment", "-2000.00"], ["Net cash from investing activities", "-2000.00"]],
        ["Financing activities", ["Owner funds introduced", "3000.00"], ["Owner drawings", "-1200.00"], ["Net cash from financing activities", "1800.00"]],
      ],
      end: [
        ["Net increase (decrease) in cash", "7800.00"],
        ["Cash at the start of the period", "0.00"],
        ["Cash at the end of the period", "7800.00"],
      ],
    });
    expect(figures.reconciles).toBe(true);
  });

  it("CFL1: renamed sections and groups, an account moved to another section, lines grouped", async () => {
    const layout: CashFlowLayout = {
      title: "Board cash flows",
      columns,
      blocks: [
        {
          id: "trading",
          kind: "section",
          usual: "operating",
          title: "Trading",
          totalLabel: "Net cash from trading",
          rows: [{ id: "p", kind: "group", label: "Profit for the year", lines: ["profit"], showLines: false }],
        },
        { id: "buying", kind: "section", usual: "investing", title: "Buying equipment", totalLabel: "Spent on equipment", rows: [] },
        {
          id: "funding",
          kind: "section",
          usual: "financing",
          title: "Funding",
          totalLabel: "Net cash from funding",
          rows: [
            { id: "owner", kind: "group", label: "Owner contributions (net)", lines: ["account:3000", "account:3100"], showLines: false },
            { id: "card", kind: "group", label: "Credit card", lines: ["account:2400"], showLines: false },
          ],
        },
      ],
    };
    const figures = await work(layout);
    expect(shape(figures).sections).toEqual([
      ["Trading", ["Profit for the year", "6500.00"], ["Net cash from trading", "6500.00"]],
      ["Buying equipment", ["Computer equipment", "-2000.00"], ["Spent on equipment", "-2000.00"]],
      ["Funding", ["Owner contributions (net)", "1800.00"], ["Credit card", "1500.00"], ["Net cash from funding", "3300.00"]],
    ]);
    expect(shape(figures).end[0]).toEqual(["Net increase (decrease) in cash", "7800.00"]);
    expect(figures.reconciles).toBe(true);
    // Shown with its lines under it.
    const shown = await work({
      ...layout,
      blocks: layout.blocks.map((block) =>
        block.kind === "section" && block.id === "funding" ? { ...block, rows: [{ ...block.rows[0], showLines: true }] } : block,
      ),
    });
    const owner = (shown.blocks.find((block) => block.id === "funding") as Extract<CashFlowFigures["blocks"][number], { kind: "section" }>).rows[0];
    expect(owner.lines.map((line) => [line.label, line.values.y2027])).toEqual([
      ["Owner funds introduced", "3000.00"],
      ["Owner drawings", "-1200.00"],
    ]);
  });

  it("CFL2: lines and sections the layout leaves out stay where they usually are", async () => {
    const figures = await work({
      title: "Just trading",
      columns,
      blocks: [
        {
          id: "trading",
          kind: "section",
          usual: "operating",
          title: "Trading",
          totalLabel: "Net cash from trading",
          rows: [{ id: "p", kind: "group", label: "Profit", lines: ["profit"], showLines: false }],
        },
      ],
    });
    expect(shape(figures).sections).toEqual([
      ["Trading", ["Profit", "6500.00"], ["Credit card", "1500.00"], ["Net cash from trading", "8000.00"]],
      ["Investing activities", ["Computer equipment", "-2000.00"], ["Net cash from investing activities", "-2000.00"]],
      ["Financing activities", ["Owner funds introduced", "3000.00"], ["Owner drawings", "-1200.00"], ["Net cash from financing activities", "1800.00"]],
    ]);
    expect(figures.reconciles).toBe(true);
  });

  it("CFL3: a line placed twice, or an account that doesn't exist, is refused", async () => {
    const twice = {
      title: "Twice",
      columns,
      blocks: [
        {
          id: "a",
          kind: "section",
          usual: "operating",
          title: "A",
          totalLabel: "A total",
          rows: [{ id: "x", kind: "group", label: "X", lines: ["profit"], showLines: false }],
        },
        {
          id: "b",
          kind: "section",
          usual: "financing",
          title: "B",
          totalLabel: "B total",
          rows: [{ id: "y", kind: "group", label: "Y", lines: ["profit"], showLines: false }],
        },
      ],
    };
    await expect(work(twice)).rejects.toThrow("Net profit is in the layout twice");
    const missing = { ...twice, blocks: [{ ...twice.blocks[0], rows: [{ id: "x", kind: "group", label: "X", lines: ["account:9999"], showLines: false }] }] };
    await expect(work(missing)).rejects.toThrow("There's no account 9999.");
  });

  it("CFL4: a hidden group still counts, notes and text, and the last lines renamed", async () => {
    const figures = await work({
      title: "Notes",
      columns,
      blocks: [
        {
          id: "trading",
          kind: "section",
          usual: "operating",
          title: "Trading",
          totalLabel: "Net cash from trading",
          rows: [
            { id: "h", kind: "heading", label: "From the year's trading" },
            { id: "p", kind: "group", label: "Profit", lines: ["profit"], showLines: false, note: "Before tax." },
            { id: "card", kind: "group", label: "Card", lines: ["account:2400"], showLines: false, hidden: true },
          ],
        },
        { id: "said", kind: "text", text: "Made-up figures." },
      ],
      endLabels: { closingCash: "Money in the bank at year end" },
    });
    const trading = figures.blocks[0] as Extract<CashFlowFigures["blocks"][number], { kind: "section" }>;
    expect(trading.rows.map((row) => [row.kind, row.label, row.hidden ?? false])).toEqual([
      ["heading", "From the year's trading", false],
      ["group", "Profit", false],
      ["group", "Card", true],
    ]);
    expect(trading.rows[1].note).toBe("Before tax.");
    expect(trading.total.values.y2027).toBe("8000.00");
    expect(figures.blocks[1]).toEqual({ id: "said", kind: "text", text: "Made-up figures." });
    expect(figures.end.at(-1)).toEqual({ key: "closingCash", label: "Money in the bank at year end", values: { y2027: "7800.00" } });
  });

  it("CFL5: a saved cash flows layout, set as the default, is the cash flows report and the annual statement", async () => {
    const started = (await run((tx) => createCustomReport(tx, { idempotencyKey: key("cf"), base: "cash_flows", periodEnd: "2027-03-31" }))).report;
    expect(started.base).toBe("cash_flows");
    const opened = await run((tx) => getCustomReport(tx, started.id));
    expect((opened.figures as CashFlowFigures).end[0].values).toEqual({ [Object.keys((opened.figures as CashFlowFigures).end[0].values)[0]]: "7800.00" });
    const layout = {
      title: "Funding view",
      columns,
      blocks: [
        {
          id: "trading",
          kind: "section",
          usual: "operating",
          title: "Trading",
          totalLabel: "Net cash from trading",
          rows: [{ id: "p", kind: "group", label: "Profit for the year", lines: ["profit"], showLines: false }],
        },
        {
          id: "funding",
          kind: "section",
          usual: "financing",
          title: "Funding",
          totalLabel: "Net cash from funding",
          rows: [{ id: "card", kind: "group", label: "Credit card", lines: ["account:2400"], showLines: false }],
        },
      ],
    };
    const made = (await run((tx) => createCustomReport(tx, { idempotencyKey: key("cf"), base: "cash_flows", layout }))).report;
    expect(await run((tx) => runDefaultCashFlowLayout(tx, { from: "2026-04-01", to: "2027-03-31" }))).toBeNull();
    await run((tx) => setLayoutDefault(tx, { base: "cash_flows", reportId: made.id }));
    const report = await run((tx) => runDefaultCashFlowLayout(tx, { from: "2026-04-01", to: "2027-03-31" }));
    expect(report?.report.id).toBe(made.id);
    const statements = await run((tx) => buildFinancialStatements(tx, { yearEnd: "2027-03-31" }));
    const cash = statements.statements.find((statement) => statement.key === "cash_flows")!;
    expect(cash.layout).toEqual({ reportId: made.id, title: "Funding view" });
    expect(cash.base).toBe("cash_flows");
    expect(cash.lines.map((line) => [line.kind ?? "line", line.label, line.current, line.prior])).toEqual([
      ["section", "Trading", null, null],
      ["line", "Profit for the year", "6500.00", "0.00"],
      ["subtotal", "Net cash from trading", "6500.00", "0.00"],
      ["section", "Funding", null, null],
      ["line", "Credit card", "1500.00", "0.00"],
      ["line", "Owner funds introduced", "3000.00", "0.00"],
      ["line", "Owner drawings", "-1200.00", "0.00"],
      ["subtotal", "Net cash from funding", "3300.00", "0.00"],
      ["section", "Investing activities", null, null],
      ["line", "Computer equipment", "-2000.00", "0.00"],
      ["subtotal", "Net cash from investing activities", "-2000.00", "0.00"],
      ["subtotal", "Net increase (decrease) in cash", "7800.00", "0.00"],
      ["line", "Cash at the start of the year", "0.00", "0.00"],
      ["total", "Cash at the end of the year", "7800.00", "0.00"],
    ]);
    await run((tx) => setLayoutDefault(tx, { base: "cash_flows", reportId: null }));
  });
});
