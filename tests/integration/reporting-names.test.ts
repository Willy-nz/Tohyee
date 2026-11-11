import { afterAll, beforeAll, expect, it } from "vitest";
import { listAccounts, updateAccount } from "@/lib/accounts/service";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { postJournal } from "@/lib/ledger/journals";
import { createCustomReport, getCustomReport } from "@/lib/reports/custom";
import { balanceSheet, profitAndLoss } from "@/lib/reports/financial";
import { buildFinancialStatements } from "@/lib/reports/financial-statements";
import { createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "reporting-names";

/** RN1-RN3 (decision 1582, not yet reviewed): an account's reporting name on reports. Made-up figures. */
describeWithDatabase("reporting names", () => {
  let server: TestServer;
  let owner: SessionUser;
  const run = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: owner.id, email: owner.email }, work);
  const account = async (code: string) => (await run((tx) => listAccounts(tx))).find((entry) => entry.code === code)!;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("owner@example.com", { serverAdmin: true });
    await createTestOrganisation(owner, ORG);
    await run((tx) =>
      postJournal(tx, {
        idempotencyKey: key("j"),
        postingDate: "2026-06-01",
        reference: "Made-up",
        lines: [
          { accountCode: "1000", debitAmount: "300.00", creditAmount: "0" },
          { accountCode: "4000", debitAmount: "0", creditAmount: "300.00" },
        ],
      }),
    );
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("RN1-RN3: set, shown on the profit and loss, balance sheet, custom reports and statements; blank goes back to the name", async () => {
    const sales = await account("4000");
    const bank = await account("1000");
    const saved = await run((tx) => updateAccount(tx, sales.id, { reportingName: "  Jewellery sales  " }));
    expect(saved.reportingName).toBe("Jewellery sales");
    expect(saved.name).toBe(sales.name);
    await run((tx) => updateAccount(tx, bank.id, { reportingName: "Cash at bank" }));

    const pl = await run((tx) => profitAndLoss(tx, { from: "2026-04-01", to: "2027-03-31" }));
    expect(pl.revenue.sections.flatMap((section) => section.lines.map((line) => [line.code, line.name, line.amount]))).toEqual([["4000", "Jewellery sales", "300.00"]]);
    const bs = await run((tx) => balanceSheet(tx, { asAt: "2027-03-31" }));
    expect(bs.assets.current.sections.flatMap((section) => section.lines.map((line) => line.name))).toContain("Cash at bank");

    const made = await run((tx) => createCustomReport(tx, { idempotencyKey: key("r"), base: "profit_and_loss", periodEnd: "2026-06-30" }));
    const report = await run((tx) => getCustomReport(tx, made.report.id));
    const table = (report.figures as { blocks: Array<{ kind: string; rows: Array<{ lines: Array<{ code: string; name: string }> }> }> }).blocks.find((block) => block.kind === "table")!;
    expect(table.rows.flatMap((row) => row.lines).find((line) => line.code === "4000")?.name).toBe("Jewellery sales");

    const statements = await run((tx) => buildFinancialStatements(tx, { yearEnd: "2027-03-31" }));
    expect(statements.statements.find((entry) => entry.key === "performance")!.lines.map((line) => line.label)).toContain("Jewellery sales");

    // Blank goes back to the account's own name.
    expect((await run((tx) => updateAccount(tx, sales.id, { reportingName: "" }))).reportingName).toBeNull();
    const again = await run((tx) => profitAndLoss(tx, { from: "2026-04-01", to: "2027-03-31" }));
    expect(again.revenue.sections[0].lines[0].name).toBe(sales.name);
    await expect(run((tx) => updateAccount(tx, sales.id, { reportingName: "x".repeat(201) }))).rejects.toThrow(/200/);
  });
});
