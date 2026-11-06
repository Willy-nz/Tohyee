import { afterAll, beforeAll, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { postJournal } from "@/lib/ledger/journals";
import { createCustomReport, getCustomReport } from "@/lib/reports/custom";
import { type EquityLayout, standardEquityLayout } from "@/lib/reports/custom-layout";
import { computeEquityLayout, type EquityFigureRow, type EquityFigures, parseEquityLayout } from "@/lib/reports/equity-layout";
import { buildFinancialStatements } from "@/lib/reports/financial-statements";
import { runDefaultEquityLayout, setLayoutDefault } from "@/lib/reports/report-layouts";
import { changesInEquity } from "@/lib/reports/statements";
import { createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "equity-layouts";
const COLUMNS = [{ key: "y2027", kind: "period" as const, label: "2027", from: "2026-04-01", to: "2027-03-31" }];

/** Changes in equity layouts (CEL1-CEL5; not yet reviewed). Made-up figures. */
describeWithDatabase("changes in equity layouts", () => {
  let server: TestServer;
  let owner: SessionUser;
  const run = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: owner.id, email: owner.email }, work);
  const work = (layout: unknown) => run(async (tx) => computeEquityLayout(tx, await parseEquityLayout(tx, layout), { columns: COLUMNS }));
  /** [label, amount] for the start, each shown row (headings null) and the end. */
  const shape = (figures: EquityFigures) => [
    [figures.opening.label, figures.opening.values.y2027],
    ...figures.blocks.flatMap((block) => (block.kind === "text" || block.hidden ? [] : [[block.label, block.kind === "heading" ? null : block.values.y2027]])),
    [figures.closing.label, figures.closing.values.y2027],
  ];
  const columns = standardEquityLayout("2027-03-31").columns;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("equity-layouts-owner@example.com", { serverAdmin: true });
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
    await pair("2025-07-01", "1000", "3000", "500.00");
    await pair("2026-04-10", "1000", "3000", "3000.00");
    await pair("2026-05-10", "1000", "4000", "8000.00");
    await pair("2026-06-10", "6010", "1000", "1500.00");
    await pair("2026-08-10", "3100", "1000", "1200.00");
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("the standard layout is the standard statement", async () => {
    const figures = await work(standardEquityLayout("2027-03-31"));
    expect(shape(figures)).toEqual([
      ["Equity at the start of the period", "500.00"],
      ["Net profit", "6500.00"],
      ["Owner funds introduced", "3000.00"],
      ["Owner drawings", "-1200.00"],
      ["Equity at the end of the period", "8800.00"],
    ]);
    expect(figures.reconciles).toBe(true);
    const standard = await run((tx) => changesInEquity(tx, { from: "2026-04-01", to: "2027-03-31" }));
    expect([standard.openingEquity, standard.closingEquity]).toEqual(["500.00", "8800.00"]);
  });

  it("CEL1: renamed and grouped lines", async () => {
    const layout: EquityLayout = {
      title: "Owner's equity",
      columns,
      blocks: [
        { id: "p", kind: "group", label: "Profit for the year", lines: ["profit"], showLines: false },
        { id: "owner", kind: "group", label: "Owner contributions (net)", lines: ["account:3000", "account:3100"], showLines: false },
      ],
    };
    const figures = await work(layout);
    expect(shape(figures)).toEqual([
      ["Equity at the start of the period", "500.00"],
      ["Profit for the year", "6500.00"],
      ["Owner contributions (net)", "1800.00"],
      ["Equity at the end of the period", "8800.00"],
    ]);
    expect(figures.reconciles).toBe(true);
    const shown = await work({ ...layout, blocks: [layout.blocks[0], { ...layout.blocks[1], showLines: true }] });
    const group = shown.blocks[1] as EquityFigureRow;
    expect(group.lines.map((line) => [line.label, line.values.y2027])).toEqual([
      ["Owner funds introduced", "3000.00"],
      ["Owner drawings", "-1200.00"],
    ]);
  });

  it("CEL2: lines the layout leaves out still show, after its rows", async () => {
    const figures = await work({ title: "Just profit", columns, blocks: [{ id: "p", kind: "group", label: "Profit", lines: ["profit"], showLines: false }] });
    expect(shape(figures)).toEqual([
      ["Equity at the start of the period", "500.00"],
      ["Profit", "6500.00"],
      ["Owner funds introduced", "3000.00"],
      ["Owner drawings", "-1200.00"],
      ["Equity at the end of the period", "8800.00"],
    ]);
    expect(figures.reconciles).toBe(true);
  });

  it("CEL3: a line placed twice, an account that doesn't exist or isn't equity, is refused", async () => {
    const group = (id: string, lines: string[]) => ({ id, kind: "group", label: id.toUpperCase(), lines, showLines: false });
    await expect(work({ title: "Twice", columns, blocks: [group("x", ["profit"]), group("y", ["profit"])] })).rejects.toThrow("Net profit is in the layout twice");
    await expect(work({ title: "Missing", columns, blocks: [group("x", ["account:9999"])] })).rejects.toThrow("There's no account 9999.");
    await expect(work({ title: "Bank", columns, blocks: [group("x", ["account:1000"])] })).rejects.toThrow("Account 1000 isn't an equity account.");
  });

  it("CEL4: a hidden group still counts, notes and text, and the start and end renamed", async () => {
    const figures = await work({
      title: "Notes",
      columns,
      blocks: [
        { id: "h", kind: "heading", label: "Movements" },
        { id: "p", kind: "group", label: "Profit", lines: ["profit"], showLines: false, note: "Before tax." },
        { id: "d", kind: "group", label: "Drawings", lines: ["account:3100"], showLines: false, hidden: true },
        { id: "said", kind: "text", text: "Made-up figures." },
      ],
      endLabels: { opening: "Owner's equity brought forward", closing: "Owner's equity carried forward" },
    });
    expect(shape(figures)).toEqual([
      ["Owner's equity brought forward", "500.00"],
      ["Movements", null],
      ["Profit", "6500.00"],
      ["Owner funds introduced", "3000.00"],
      ["Owner's equity carried forward", "8800.00"],
    ]);
    const profit = figures.blocks[1] as EquityFigureRow;
    expect(profit.note).toBe("Before tax.");
    expect(figures.blocks[2]).toMatchObject({ label: "Drawings", hidden: true, values: { y2027: "-1200.00" } });
    expect(figures.blocks[3]).toEqual({ id: "said", kind: "text", text: "Made-up figures." });
    expect(figures.reconciles).toBe(true);
  });

  it("CEL5: a saved layout, set as the default, is the changes in equity report and the annual statement", async () => {
    const started = (await run((tx) => createCustomReport(tx, { idempotencyKey: key("ce"), base: "changes_in_equity", periodEnd: "2027-03-31" }))).report;
    expect(started.layout).toMatchObject({ title: "Changes in equity", blocks: [{ id: "profit", lines: ["profit"] }] });
    const opened = await run((tx) => getCustomReport(tx, started.id));
    expect(Object.values((opened.figures as EquityFigures).closing.values)).toEqual(["8800.00"]);
    const layout = {
      title: "Owner view",
      columns,
      blocks: [
        { id: "p", kind: "group", label: "Profit for the year", lines: ["profit"], showLines: false },
        { id: "owner", kind: "group", label: "Owner contributions (net)", lines: ["account:3000", "account:3100"], showLines: false },
      ],
    };
    const made = (await run((tx) => createCustomReport(tx, { idempotencyKey: key("ce"), base: "changes_in_equity", layout }))).report;
    expect(await run((tx) => runDefaultEquityLayout(tx, { from: "2026-04-01", to: "2027-03-31" }))).toBeNull();
    // A list-style report (CRS1) can't be the default layout.
    const list = (
      await run((tx) =>
        createCustomReport(tx, {
          idempotencyKey: key("ce"),
          base: "changes_in_equity",
          layout: { title: "List", filters: { from: "2026-04-01", to: "2027-03-31" }, columns: ["item", "amount"] },
        }),
      )
    ).report;
    await expect(run((tx) => setLayoutDefault(tx, { base: "changes_in_equity", reportId: list.id }))).rejects.toThrow("That report is a list");
    await run((tx) => setLayoutDefault(tx, { base: "changes_in_equity", reportId: made.id }));
    const report = await run((tx) => runDefaultEquityLayout(tx, { from: "2026-04-01", to: "2027-03-31" }));
    expect(report?.report.id).toBe(made.id);
    const statements = await run((tx) => buildFinancialStatements(tx, { yearEnd: "2027-03-31" }));
    const equity = statements.statements.find((statement) => statement.key === "equity")!;
    expect(equity.layout).toEqual({ reportId: made.id, title: "Owner view" });
    expect(equity.base).toBe("changes_in_equity");
    expect(equity.lines.map((line) => [line.kind ?? "line", line.label, line.current, line.prior])).toEqual([
      ["subtotal", "Equity at the start of the year", "500.00", "0.00"],
      ["line", "Profit for the year", "6500.00", "0.00"],
      ["line", "Owner contributions (net)", "1800.00", "500.00"],
      ["total", "Equity at the end of the year", "8800.00", "500.00"],
    ]);
    await run((tx) => setLayoutDefault(tx, { base: "changes_in_equity", reportId: null }));
  });
});
