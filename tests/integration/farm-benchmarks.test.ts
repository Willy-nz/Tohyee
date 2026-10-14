import { afterAll, beforeAll, expect, it } from "vitest";
import { createAccount } from "@/lib/accounts/service";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { farmBenchmarks, setExpenseGroup, setYearFigures } from "@/lib/farming/benchmarks";
import { setFarmingEnabled } from "@/lib/farming/paddocks";
import { postJournal } from "@/lib/ledger/journals";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "farm-benchmarks";

/** Farm benchmarks (FK1-FK4, #259; not yet reviewed). */
describeWithDatabase("farm benchmarks", () => {
  let server: TestServer;
  let owner: SessionUser;
  const run = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: owner.id, email: owner.email }, work);

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("benchmarks-owner@example.com", { serverAdmin: true });
    await createTestOrganisation(owner, ORG);
    await run((tx) => updateOrganisationSettings(tx, { financialYearEndMonth: 5 }));
    await run((tx) => setFarmingEnabled(tx, { enabled: true }));
    await run((tx) => createAccount(tx, { code: "6400", name: "Animal health", accountType: "expense" }));
    const pair = (debit: string, credit: string, amount: string) =>
      run((tx) =>
        postJournal(tx, {
          idempotencyKey: key("j"),
          postingDate: "2026-01-15",
          reference: "Year",
          lines: [
            { accountCode: debit, debitAmount: amount, creditAmount: "0" },
            { accountCode: credit, debitAmount: "0", creditAmount: amount },
          ],
        }),
      );
    await pair("1000", "4000", "2000000.00");
    await pair("6200", "1000", "120000.00");
    await pair("6400", "1000", "36000.00");
    await pair("6300", "1000", "50000.00");
    await pair("6090", "1000", "30000.00");
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("FK1, FK4: only grouped expense accounts are working expenses; nothing per kgMS without milk solids", async () => {
    await run((tx) => setExpenseGroup(tx, { accountCode: "6200", group: "wages" }));
    await run((tx) => setExpenseGroup(tx, { accountCode: "6400", group: "animal_health" }));
    await expect(run((tx) => setExpenseGroup(tx, { accountCode: "4000", group: "other" }))).rejects.toThrow(/isn't an expense account/);
    const report = await run((tx) => farmBenchmarks(tx, { yearEnd: "2026-05-31" }));
    expect(report.groups.map((group) => [group.key, group.amount, group.perKgMs])).toEqual([
      ["wages", "120000.00", null],
      ["animal_health", "36000.00", null],
    ]);
    expect(report.workingExpenses.amount).toBe("156000.00");
    expect(report.ungrouped).toEqual([
      { code: "6090", name: "Interest expense", amount: "30000.00" },
      { code: "6300", name: "Depreciation", amount: "50000.00" },
    ]);
    await expect(run((tx) => farmBenchmarks(tx, { yearEnd: "2026-05-30" }))).rejects.toThrow(/financial year end/);
  });

  it("FK2, FK3: per kgMS, hectare, cow and stock unit", async () => {
    await run((tx) => setYearFigures(tx, { yearEnd: "2026-05-31", effectiveHa: "200", peakCows: 600, stockUnits: "4800", milkSolidsKg: "240000" }));
    const report = await run((tx) => farmBenchmarks(tx, { yearEnd: "2026-05-31" }));
    const row = (entry: { amount: string; perKgMs: string | null; perHa: string | null; perCow: string | null; perSu: string | null }) => [
      entry.amount,
      entry.perKgMs,
      entry.perHa,
      entry.perCow,
      entry.perSu,
    ];
    expect(row(report.grossFarmRevenue)).toEqual(["2000000.00", "8.33", "10000.00", "3333.33", "416.67"]);
    expect(report.groups.map(row)).toEqual([
      ["120000.00", "0.50", "600.00", "200.00", "25.00"],
      ["36000.00", "0.15", "180.00", "60.00", "7.50"],
    ]);
    expect(row(report.workingExpenses)).toEqual(["156000.00", "0.65", "780.00", "260.00", "32.50"]);
    expect(row(report.operatingSurplus)).toEqual(["1844000.00", "7.68", "9220.00", "3073.33", "384.17"]);
    // Clearing a figure clears its column.
    await run((tx) => setYearFigures(tx, { yearEnd: "2026-05-31", effectiveHa: "200", peakCows: 600, stockUnits: "", milkSolidsKg: "240000" }));
    expect((await run((tx) => farmBenchmarks(tx, { yearEnd: "2026-05-31" }))).workingExpenses.perSu).toBeNull();
    await expect(run((tx) => setYearFigures(tx, { yearEnd: "2026-05-31", peakCows: "6.5" }))).rejects.toThrow(/whole number/);
  });
});
