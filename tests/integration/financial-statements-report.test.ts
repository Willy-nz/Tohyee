import { afterAll, beforeAll, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { postJournal } from "@/lib/ledger/journals";
import { createCustomReport } from "@/lib/reports/custom";
import { buildFinancialStatements, type FinancialStatements, saveStatementNotes } from "@/lib/reports/financial-statements";
import { setLayoutDefault } from "@/lib/reports/report-layouts";
import { createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "statements-report";

/** Annual financial statements as a report (FS4-FS7; not yet reviewed). Made-up figures. */
describeWithDatabase("annual financial statements report", () => {
  let server: TestServer;
  let owner: SessionUser;
  const run = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: owner.id, email: owner.email }, work);
  const build = () => run((tx) => buildFinancialStatements(tx, { yearEnd: "2027-03-31" }, new Date("2027-04-20T00:00:00Z")));
  const statement = (report: FinancialStatements, which: string) => report.statements.find((entry) => entry.key === which)!;
  const line = (report: FinancialStatements, which: string, label: string) => statement(report, which).lines.find((entry) => entry.label === label);
  const shape = (report: FinancialStatements, which: string) =>
    statement(report, which).lines.map((entry) => [entry.kind ?? "line", entry.label, entry.current, entry.prior]);

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("statements-report-owner@example.com", {
      serverAdmin: true,
    });
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
    // FS1's setup (31 March year end).
    await pair("2025-04-01", "1000", "3000", "5000.00");
    await pair("2025-06-01", "1000", "4000", "1000.00");
    await pair("2026-06-01", "1000", "4000", "3000.00");
    await pair("2026-07-01", "6010", "1000", "1350.00");
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("FS4: the four statements and the notes, in order, with this year and last year", async () => {
    const report = await build();
    expect(report.statements.map((entry) => entry.key)).toEqual(["performance", "position", "equity", "cash_flows"]);
    expect(report.statements.map((entry) => entry.title)).toEqual([
      "Statement of financial performance",
      "Statement of financial position",
      "Statement of changes in equity",
      "Statement of cash flows",
    ]);
    expect(report.columns).toEqual({ current: "2027", prior: "2026" });
    expect(report.period).toBe("For the year ended 31 March 2027");
    const sales = statement(report, "performance").lines.find((entry) => entry.kind === undefined && entry.current === "3000.00");
    expect(sales?.prior).toBe("1000.00");
    expect(line(report, "performance", "Net profit")).toMatchObject({
      kind: "total",
      current: "1650.00",
      prior: "1000.00",
    });
    expect(line(report, "position", "Net assets")).toBeTruthy();
    expect(statement(report, "performance").layout).toBeNull();
    expect(statement(report, "performance").base).toBe("profit_and_loss");
    expect(statement(report, "position").base).toBe("balance_sheet");
    expect(statement(report, "equity").base).toBe("changes_in_equity");
    expect(report.notes.saved).toBe(false);
    await expect(run((tx) => buildFinancialStatements(tx, { yearEnd: "2027-03-30" }))).rejects.toThrow(/financial year end/);
  });

  it("FS5: a default profit and loss layout is the statement of financial performance; clearing it goes back", async () => {
    const layout = {
      title: "Board layout",
      columns: {
        periodEnd: "2027-03-31",
        periodLength: "year",
        periodCount: 1,
        difference: false,
        percent: false,
        yearToDate: false,
      },
      blocks: [
        {
          id: "main",
          kind: "table",
          title: "",
          rows: [
            {
              id: "sales",
              kind: "group",
              label: "Sales",
              accountTypes: [],
              accountCodes: ["4000"],
              showAccounts: false,
            },
            {
              id: "costs",
              kind: "group",
              label: "Costs",
              accountTypes: [],
              accountCodes: ["6010"],
              showAccounts: false,
            },
            {
              id: "workings",
              kind: "formula",
              label: "Workings",
              terms: [{ rowId: "sales", sign: 1 }],
              hidden: true,
            },
            {
              id: "result",
              kind: "formula",
              label: "Result",
              terms: [
                { rowId: "sales", sign: 1 },
                { rowId: "costs", sign: -1 },
              ],
            },
          ],
        },
        { id: "said", kind: "text", text: "Made-up figures for a test." },
      ],
    };
    const made = (
      await run((tx) =>
        createCustomReport(tx, {
          idempotencyKey: key("layout"),
          base: "profit_and_loss",
          layout,
        }),
      )
    ).report;
    await run((tx) => setLayoutDefault(tx, { base: "profit_and_loss", reportId: made.id }));
    const report = await build();
    expect(shape(report, "performance")).toEqual([
      ["line", "Sales", "3000.00", "1000.00"],
      ["line", "Costs", "1350.00", "0.00"],
      ["total", "Result", "1650.00", "1000.00"],
    ]);
    expect(statement(report, "performance").paragraphs).toEqual(["Made-up figures for a test."]);
    // FS8: a group's line carries its accounts; a formula row doesn't.
    expect(line(report, "performance", "Sales")?.accountIds).toHaveLength(1);
    expect(line(report, "performance", "Result")?.accountIds).toBeUndefined();
    expect(statement(report, "performance").layout).toEqual({
      reportId: made.id,
      title: "Board layout",
    });
    // The balance sheet has no default layout, so it keeps the standard lines.
    expect(line(report, "position", "Net assets")).toBeTruthy();
    expect(statement(report, "position").layout).toBeNull();

    // Accounts shown under a group: the label, the accounts, then its total.
    const shown = {
      ...layout,
      title: "With accounts",
      blocks: [
        {
          ...layout.blocks[0],
          rows: [{ ...layout.blocks[0].rows![0], showAccounts: true }],
        },
      ],
    };
    const second = (
      await run((tx) =>
        createCustomReport(tx, {
          idempotencyKey: key("layout"),
          base: "profit_and_loss",
          layout: shown,
        }),
      )
    ).report;
    await run((tx) => setLayoutDefault(tx, { base: "profit_and_loss", reportId: second.id }));
    const grouped = shape(await build(), "performance");
    expect(grouped[0]).toEqual(["section", "Sales", null, null]);
    expect(grouped[1].slice(2)).toEqual(["3000.00", "1000.00"]);
    expect(grouped[2]).toEqual(["subtotal", "Total Sales", "3000.00", "1000.00"]);

    await run((tx) => setLayoutDefault(tx, { base: "profit_and_loss", reportId: null }));
    const back = await build();
    expect(statement(back, "performance").layout).toBeNull();
    expect(line(back, "performance", "Net profit")).toMatchObject({
      current: "1650.00",
      prior: "1000.00",
    });
  });

  it("FS8: amounts from accounts carry their accounts and each year's dates; totals and the other statements don't", async () => {
    const report = await build();
    const accountId = await run(async (tx) => (await tx.query<{ id: string }>("select id from accounts where code = '4000'")).rows[0].id);
    const performance = statement(report, "performance");
    expect(performance.drill).toEqual({ current: { from: "2026-04-01", to: "2027-03-31" }, prior: { from: "2025-04-01", to: "2026-03-31" } });
    const sales = performance.lines.find((entry) => entry.current === "3000.00" && !entry.kind)!;
    expect(sales.accountIds).toEqual([accountId]);
    expect(line(report, "performance", "Net profit")?.accountIds).toBeUndefined();
    expect(statement(report, "position").drill).toEqual(performance.drill);
    expect(statement(report, "equity").drill).toBeNull();
    expect(statement(report, "cash_flows").drill).toBeNull();
  });

  it("FS7: saved notes are the report's notes", async () => {
    await run((tx) =>
      saveStatementNotes(tx, {
        notes: [{ title: "Reporting entity", body: "A made-up sole trader." }],
      }),
    );
    const report = await build();
    expect(report.notes).toEqual({
      saved: true,
      notes: [{ title: "Reporting entity", body: "A made-up sole trader." }],
    });
  });
});
