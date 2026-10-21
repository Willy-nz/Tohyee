import { afterAll, beforeAll, expect, it } from "vitest";
import * as byFarmRoute from "@/app/api/farming/benchmarks/by-farm/route";
import * as setupRoute from "@/app/api/farming/farm-reporting/route";
import { createAccount } from "@/lib/accounts/service";
import type { SessionUser } from "@/lib/auth/sessions";
import { coreQuery } from "@/lib/db/transactions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { farmBenchmarks, setExpenseGroup, setYearFigures } from "@/lib/farming/benchmarks";
import { farmBenchmarksByFarm, getFarmReportingSetup, linkFarmTrackingValue, setFarmTrackingCategory, setFarmYearFigures } from "@/lib/farming/farm-reporting";
import { saveFarm, setFarmingEnabled } from "@/lib/farming/paddocks";
import { postJournal } from "@/lib/ledger/journals";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { createTrackingCategory, createTrackingValue, getTrackingSetup, updateTrackingValue } from "@/lib/tracking/service";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "farm-reporting";

/** Farm-level reporting (#390; FR1-FR7, as Xero tracking categories do it, not yet reviewed). */
describeWithDatabase("farm-level reporting", () => {
  let server: TestServer;
  let owner: SessionUser;
  let viewer: SessionUser;
  const run = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: owner.id, email: owner.email }, work);
  const ids = { category: "", location: "", home: "", runoff: "", hill: "", office: "", oldValue: "", farmHome: "", farmRunoff: "", farmOld: "" };

  const post = (lines: Array<{ code: string; debit?: string; credit?: string; tag?: string }>, date = "2026-01-15") =>
    run((tx) =>
      postJournal(tx, {
        idempotencyKey: key("j"),
        postingDate: date,
        reference: "Year",
        lines: lines.map((line) => ({ accountCode: line.code, debitAmount: line.debit ?? "0", creditAmount: line.credit ?? "0", tracking: line.tag ? { [ids.category]: line.tag } : undefined })),
      }),
    );

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("farm-reporting-owner@example.com", { serverAdmin: true });
    viewer = await createTestUser("farm-reporting-viewer@example.com");
    await createTestOrganisation(owner, ORG);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'viewer')", [ORG, viewer.id]);
    await run((tx) => updateOrganisationSettings(tx, { financialYearEndMonth: 5, advancedFeatures: true }));
    await run((tx) => setFarmingEnabled(tx, { enabled: true }));
    await run((tx) => createAccount(tx, { code: "6400", name: "Animal health", accountType: "expense" }));
    await run((tx) => createAccount(tx, { code: "6500", name: "Grazing", accountType: "expense" }));
    let setup = await run((tx) => createTrackingCategory(tx, { name: "Farm" }));
    ids.category = setup.categories.find((category) => category.name === "Farm")!.id;
    ids.location = setup.categories.find((category) => category.kind === "location")!.id;
    for (const name of ["Home farm", "Runoff", "Head office", "Old block"]) setup = await run((tx) => createTrackingValue(tx, { categoryId: ids.category, name }));
    const value = (path: string) => setup.categories.find((category) => category.id === ids.category)!.values.find((entry) => entry.path === path)!.id;
    ids.home = value("Home farm");
    ids.runoff = value("Runoff");
    ids.office = value("Head office");
    ids.oldValue = value("Old block");
    setup = await run((tx) => createTrackingValue(tx, { categoryId: ids.category, name: "Hill block", parentId: ids.runoff }));
    ids.hill = setup.categories.find((category) => category.id === ids.category)!.values.find((entry) => entry.path === "Runoff › Hill block")!.id;
    const farms = await run((tx) => saveFarm(tx, { name: "Home farm" }));
    ids.farmHome = farms[0].id;
    ids.farmRunoff = (await run((tx) => saveFarm(tx, { name: "Runoff" }))).find((farm) => farm.name === "Runoff")!.id;
    ids.farmOld = (await run((tx) => saveFarm(tx, { name: "Old block" }))).find((farm) => farm.name === "Old block")!.id;
    for (const [code, group] of [["6200", "wages"], ["6400", "animal_health"], ["6500", "grazing"]]) await run((tx) => setExpenseGroup(tx, { accountCode: code, group }));
    // FK's year, tagged by farm (FR2): Hill block counts for Runoff; Head office is no farm's.
    await post([{ code: "1000", debit: "2000000.00" }, { code: "4000", credit: "1500000.00", tag: ids.home }, { code: "4000", credit: "500000.00", tag: ids.runoff }]);
    await post([{ code: "6200", debit: "80000.00", tag: ids.home }, { code: "6200", debit: "30000.00", tag: ids.runoff }, { code: "6200", debit: "10000.00", tag: ids.office }, { code: "1000", credit: "120000.00" }]);
    await post([{ code: "6400", debit: "24000.00", tag: ids.home }, { code: "6400", debit: "10000.00", tag: ids.runoff }, { code: "6400", debit: "2000.00", tag: ids.hill }, { code: "1000", credit: "36000.00" }]);
    await post([{ code: "6300", debit: "50000.00" }, { code: "6090", debit: "30000.00" }, { code: "1000", credit: "80000.00" }]);
    // Outside the year: not counted.
    await post([{ code: "6200", debit: "999.00", tag: ids.home }, { code: "1000", credit: "999.00" }], "2026-06-01");
    await run((tx) => setYearFigures(tx, { yearEnd: "2026-05-31", effectiveHa: "200", peakCows: 600, stockUnits: "4800", milkSolidsKg: "240000" }));
  });

  afterAll(async () => {
    await server?.teardown();
  });

  const amounts = (report: Awaited<ReturnType<typeof farmBenchmarksByFarm>>, key: string) =>
    Object.fromEntries(Object.entries(report.rows.find((row) => row.key === key)!.cells).map(([column, cell]) => [column, cell.amount]));

  it("FR1 with no category chosen, everything is Not allocated and the total is FK3's", async () => {
    const report = await run((tx) => farmBenchmarksByFarm(tx, { yearEnd: "2026-05-31" }));
    expect(report.category).toBeNull();
    expect(report.columns.map((column) => column.key)).toEqual(["none", "total"]);
    expect(amounts(report, "fwe")).toEqual({ none: "156000.00", total: "156000.00" });
    expect(report.unlinkedFarms).toEqual(["Home farm", "Old block", "Runoff"]);
  });

  it("FR1 choosing the category and linking farms, and what's refused", async () => {
    await expect(run((tx) => linkFarmTrackingValue(tx, { farmId: ids.farmHome, valueId: ids.home }))).rejects.toThrow("Choose the tracking category");
    await run((tx) => setFarmTrackingCategory(tx, { categoryId: ids.category }));
    await run((tx) => linkFarmTrackingValue(tx, { farmId: ids.farmHome, valueId: ids.home }));
    await run((tx) => linkFarmTrackingValue(tx, { farmId: ids.farmRunoff, valueId: ids.runoff }));
    await expect(run((tx) => linkFarmTrackingValue(tx, { farmId: ids.farmOld, valueId: ids.home }))).rejects.toThrow("Home farm already counts for Home farm");
    await expect(run((tx) => linkFarmTrackingValue(tx, { farmId: ids.farmOld, valueId: ids.hill }))).rejects.toThrow("Runoff › Hill block already counts for Runoff");
    const location = (await run((tx) => createTrackingValue(tx, { categoryId: ids.location, name: "Otago" }))).categories.find((category) => category.id === ids.location)!.values[0].id;
    await expect(run((tx) => linkFarmTrackingValue(tx, { farmId: ids.farmOld, valueId: location }))).rejects.toThrow("That value isn't in Farm");
    await run((tx) => updateTrackingValue(tx, ids.oldValue, { name: "Old block", isActive: false }));
    await expect(run((tx) => linkFarmTrackingValue(tx, { farmId: ids.farmOld, valueId: ids.oldValue }))).rejects.toThrow("Old block is archived");
    const setup = await run((tx) => getFarmReportingSetup(tx));
    expect(setup.farms.map((farm) => [farm.name, farm.valuePath])).toEqual([["Home farm", "Home farm"], ["Old block", null], ["Runoff", "Runoff"]]);
  });

  it("FR2-FR4 splits by farm; Not allocated stays visible; farms and Not allocated add up to the books", async () => {
    await run((tx) => setFarmYearFigures(tx, { farmId: ids.farmHome, yearEnd: "2026-05-31", effectiveHa: "150", peakCows: 450, stockUnits: "3600", milkSolidsKg: "180000" }));
    await run((tx) => setFarmYearFigures(tx, { farmId: ids.farmRunoff, yearEnd: "2026-05-31", effectiveHa: "50", peakCows: 150, stockUnits: "1200", milkSolidsKg: "60000" }));
    const report = await run((tx) => farmBenchmarksByFarm(tx, { yearEnd: "2026-05-31" }));
    expect(report.columns.map((column) => column.label)).toEqual(["Home farm", "Runoff", "Not allocated", "Total"]);
    expect(amounts(report, "revenue")).toEqual({ [ids.farmHome]: "1500000.00", [ids.farmRunoff]: "500000.00", none: "0.00", total: "2000000.00" });
    expect(amounts(report, "wages")).toEqual({ [ids.farmHome]: "80000.00", [ids.farmRunoff]: "30000.00", none: "10000.00", total: "120000.00" });
    expect(amounts(report, "animal_health")).toEqual({ [ids.farmHome]: "24000.00", [ids.farmRunoff]: "12000.00", none: "0.00", total: "36000.00" });
    expect(report.rows.find((row) => row.key === "surplus")!.cells[ids.farmRunoff]).toEqual({ amount: "458000.00", perKgMs: "7.63", perHa: "9160.00", perCow: "3053.33", perSu: "381.67" });
    expect(report.rows.find((row) => row.key === "fwe")!.cells.none).toEqual({ amount: "10000.00", perKgMs: null, perHa: null, perCow: null, perSu: null });
    // The total is the unsplit benchmarks, per unit and all.
    const whole = await run((tx) => farmBenchmarks(tx, { yearEnd: "2026-05-31" }));
    expect(report.rows.find((row) => row.key === "fwe")!.cells.total).toEqual(whole.workingExpenses);
    expect(report.rows.find((row) => row.key === "surplus")!.cells.total).toEqual(whole.operatingSurplus);
    expect(report.unlinkedFarms).toEqual(["Old block"]);
  });

  it("FR5 and FR6 journals moving shared costs and charging between farms leave the total alone", async () => {
    await post([{ code: "6200", credit: "10000.00", tag: ids.office }, { code: "6200", debit: "7500.00", tag: ids.home }, { code: "6200", debit: "2500.00", tag: ids.runoff }], "2026-05-31");
    await post([{ code: "6500", debit: "20000.00", tag: ids.home }, { code: "6500", credit: "20000.00", tag: ids.runoff }], "2026-05-31");
    const report = await run((tx) => farmBenchmarksByFarm(tx, { yearEnd: "2026-05-31" }));
    expect(amounts(report, "wages")).toEqual({ [ids.farmHome]: "87500.00", [ids.farmRunoff]: "32500.00", none: "0.00", total: "120000.00" });
    expect(amounts(report, "grazing")).toEqual({ [ids.farmHome]: "20000.00", [ids.farmRunoff]: "-20000.00", none: "0.00", total: "0.00" });
    expect(amounts(report, "surplus")).toEqual({ [ids.farmHome]: "1368500.00", [ids.farmRunoff]: "475500.00", none: "0.00", total: "1844000.00" });
  });

  it("FR1 changing the category unlinks the farms; anyone may look, only bookkeepers may change it", async () => {
    const ask = async (method: "GET" | "PUT", body?: unknown) =>
      method === "GET"
        ? byFarmRoute.GET(apiRequest(`/api/farming/benchmarks/by-farm?organisationId=${ORG}&yearEnd=2026-05-31`, { cookie: await sessionCookieFor(viewer) }), undefined as never)
        : setupRoute.PUT(apiRequest("/api/farming/farm-reporting", { method: "PUT", cookie: await sessionCookieFor(viewer), body }), undefined as never);
    expect((await ask("GET")).status).toBe(200);
    expect((await ask("PUT", { organisationId: ORG, categoryId: ids.location })).status).toBe(403);
    const setup = await run((tx) => setFarmTrackingCategory(tx, { categoryId: ids.location }));
    expect(setup.farms.every((farm) => farm.trackingValueId === null)).toBe(true);
    const report = await run((tx) => farmBenchmarksByFarm(tx, { yearEnd: "2026-05-31" }));
    expect(amounts(report, "surplus")).toEqual({ none: "1844000.00", total: "1844000.00" });
    expect((await run((tx) => getTrackingSetup(tx))).advancedFeatures).toBe(true);
  });
});
