import { afterAll, beforeAll, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { managementReport, setManagementValues } from "@/lib/livestock/management";
import { recordMovement, setOpenings, updateLivestockSettings } from "@/lib/livestock/movements";
import { previewValuation, recordElection } from "@/lib/livestock/valuation";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "livestock-management";

/** Examples LV18-LV20 (approved by Jess 11 Oct 2026), decision 506: monthly management valuations, a report only. */
describeWithDatabase("livestock management valuations (LV18-LV20)", () => {
  let server: TestServer;
  let owner: SessionUser;

  const run = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: owner.id, email: owner.email }, work);
  const move = (fields: Record<string, unknown>) => run((tx) => recordMovement(tx, { idempotencyKey: key("lv"), kind: "dairy_cattle", ...fields }));
  const values = (effectiveMonth: string, ma: string, r2: string, r1: string) =>
    run((tx) =>
      setManagementValues(tx, {
        effectiveMonth,
        lines: [
          { kind: "dairy_cattle", classCode: "ma_cows", amount: ma },
          { kind: "dairy_cattle", classCode: "r2_heifers", amount: r2 },
          { kind: "dairy_cattle", classCode: "r1_heifers", amount: r1 },
        ],
      }),
    );

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("owner@example.com", { serverAdmin: true });
    await createTestOrganisation(owner, ORG);
    await run((tx) => updateOrganisationSettings(tx, { financialYearEndMonth: 5 }));
    await run((tx) => updateLivestockSettings(tx, { enabled: true, firstYearStart: "2025-06-01" }));
    await run((tx) =>
      setOpenings(tx, {
        lines: [
          { kind: "dairy_cattle", classCode: "ma_cows", head: 300, value: "750000.00" },
          { kind: "dairy_cattle", classCode: "r2_heifers", head: 70, value: "154000.00" },
          { kind: "dairy_cattle", classCode: "r1_heifers", head: 75, value: "86250.00" },
        ],
      }),
    );
    await move({ movementType: "birth", movementDate: "2025-08-15", classCode: "r1_heifers", head: 80 });
    await move({ movementType: "purchase", movementDate: "2025-11-01", classCode: "ma_cows", head: 10, amount: "24000.00" });
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("LV18, LV19: stock on hand at the farm's values each month, with the change split into quantity and price", async () => {
    let report = await run((tx) => managementReport(tx, { yearEnd: "2026-05-31" }));
    expect(report.missingValues.map((entry) => entry.classCode)).toEqual(["r1_heifers", "r2_heifers", "ma_cows"]);
    await values("2025-06-01", "2700.00", "2400.00", "1200.00");
    report = await run((tx) => managementReport(tx, { yearEnd: "2026-05-31" }));
    expect(report.missingValues).toEqual([]);
    expect(report.opening).toEqual({ monthEnd: "2025-05-31", head: 445, value: "1068000.00" });
    const month = (monthEnd: string) => report.months.find((entry) => entry.monthEnd === monthEnd)!;
    expect(report.months).toHaveLength(12);
    // June: ageing moves the classes on (quantity, at last month's values).
    expect(month("2025-06-30")).toMatchObject({ head: 445, value: "1179000.00", change: "111000.00", quantityChange: "111000.00", priceChange: "0.00" });
    expect(month("2025-08-31")).toMatchObject({ head: 525, value: "1275000.00", quantityChange: "96000.00" });
    expect(month("2025-11-30")).toMatchObject({ value: "1302000.00", change: "27000.00", quantityChange: "27000.00", priceChange: "0.00" });

    // A new value from January is all price.
    await run((tx) => setManagementValues(tx, { effectiveMonth: "2026-01-15", lines: [{ kind: "dairy_cattle", classCode: "ma_cows", amount: "2800.00" }] }));
    report = await run((tx) => managementReport(tx, { yearEnd: "2026-05-31" }));
    expect(month("2026-01-31")).toMatchObject({ value: "1340000.00", change: "38000.00", quantityChange: "0.00", priceChange: "38000.00" });
  });

  it("LV20: management values never change the tax valuation", async () => {
    await run((tx) => recordElection(tx, { kind: "dairy_cattle", method: "herd_scheme", fromIncomeYear: 2026 }));
    const preview = await run((tx) => previewValuation(tx, { yearEnd: "2026-05-31" }));
    expect(preview.workings.totals).toMatchObject({ openingValue: "990250.00", revaluation: "138260.00", closingValue: "1374050.00" });
  });
});
