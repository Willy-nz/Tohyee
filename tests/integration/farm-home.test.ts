import { afterAll, beforeAll, expect, it } from "vitest";
import { addNotebookEntry } from "@/lib/ai-workspace/notebook";
import type { SessionUser } from "@/lib/auth/sessions";
import { todayIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { setExpenseGroup, setYearFigures } from "@/lib/farming/benchmarks";
import { addCalendarItem, shareCalendarItem } from "@/lib/farming/calendar";
import { createPlan, recordApplication, savePlanVersion, saveProduct } from "@/lib/farming/fertiliser";
import { farmHome } from "@/lib/farming/home";
import { addPaddock, saveFarm, setFarmingEnabled } from "@/lib/farming/paddocks";
import { addReading, addSupplement } from "@/lib/farming/pasture";
import { addDays, financialYearEnd } from "@/lib/financial-year";
import { postJournal } from "@/lib/ledger/journals";
import { recordMovement, setOpenings, updateLivestockSettings } from "@/lib/livestock/movements";
import { suggestLivestockMovements } from "@/lib/livestock/suggestions";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import * as homeRoute from "@/app/api/farming/home/route";
import * as preferencesRoute from "@/app/api/dashboard-preferences/route";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "farm-home";
const EMPTY = "farm-home-empty";
const TODAY = "2026-10-20";

/** The farm Home (#341; FH1-FH8, not yet reviewed). Made-up farm, people and figures. */
describeWithDatabase("the farm Home", () => {
  let server: TestServer;
  let jess: SessionUser;
  let mere: SessionUser;
  const as = <T>(user: SessionUser, work: (tx: OrgTx) => Promise<T>, org = ORG) => inOrganisation(org, { userId: user.id, email: user.email }, work);

  beforeAll(async () => {
    server = await startTestServer();
    jess = await createTestUser("farm-home-jess@example.com", { serverAdmin: true, displayName: "Jess" });
    mere = await createTestUser("farm-home-mere@example.com", { displayName: "Mere" });
    for (const org of [ORG, EMPTY]) {
      await createTestOrganisation(jess, org);
      await as(jess, (tx) => updateOrganisationSettings(tx, { financialYearEndMonth: 3 }), org);
      await as(jess, (tx) => setFarmingEnabled(tx, { enabled: true }), org);
    }
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'admin')", [ORG, mere.id]);
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("FH6 with nothing recorded, every card is empty (hidden), not zeros", async () => {
    await as(jess, (tx) => saveFarm(tx, { name: "Home block" }), EMPTY);
    expect(await as(jess, (tx) => farmHome(tx, { today: TODAY }), EMPTY)).toEqual({
      today: TODAY,
      calendar: null,
      stock: null,
      pasture: null,
      fertiliser: null,
      performance: null,
      notebook: null,
    });
  });

  it("FH1-FH5, FH8 the cards from the farm's records, and the calendar only as each person sees it", async () => {
    const farm = (await as(jess, (tx) => saveFarm(tx, { name: "Home block" })))[0];
    const twelve = await as(jess, (tx) => addPaddock(tx, { farmId: farm.id, name: "12", effectiveHa: "20.0", onDate: "2026-07-01" }));
    const fourteen = await as(jess, (tx) => addPaddock(tx, { farmId: farm.id, name: "14", effectiveHa: "15.0", onDate: "2026-07-01" }));

    // FH2: the calendar, private to each person.
    await as(jess, (tx) => addCalendarItem(tx, { date: "2026-10-21", title: "Drench the calves", kind: "animal_health", startTime: "07:00" }));
    await as(jess, (tx) => addCalendarItem(tx, { date: "2026-11-30", title: "Too far ahead" }));
    const shared = await as(mere, (tx) => addCalendarItem(tx, { date: "2026-10-22", title: "Pick up drench", kind: "delivery" }));
    await as(mere, (tx) => shareCalendarItem(tx, shared.id, true));
    await as(mere, (tx) => addCalendarItem(tx, { date: "2026-10-23", title: "Mere's own errand" }));

    // FH3: stock.
    await as(jess, (tx) => updateLivestockSettings(tx, { enabled: true, firstYearStart: "2026-04-01" }));
    await as(jess, (tx) =>
      setOpenings(tx, {
        lines: [
          { kind: "dairy_cattle", classCode: "ma_cows", head: 300, value: "750000.00" },
          { kind: "dairy_cattle", classCode: "r1_heifers", head: 75, value: "86250.00" },
        ],
      }),
    );
    await as(jess, (tx) => recordMovement(tx, { idempotencyKey: key("lv"), kind: "dairy_cattle", movementType: "death", movementDate: "2026-08-15", classCode: "ma_cows", head: 2 }));
    await as(jess, (tx) => suggestLivestockMovements(tx, { suggestions: [{ movement: { movementType: "sale", movementDate: "2026-10-01", kind: "dairy_cattle", classCode: "ma_cows", head: 10 }, evidence: "Sale note" }] }));

    // FH4: pasture and feed.
    await as(jess, (tx) => addReading(tx, { paddockId: twelve.id, measuredOn: "2026-09-30", cover: 2000, method: "plate_meter" }));
    await as(jess, (tx) => addReading(tx, { paddockId: twelve.id, measuredOn: "2026-10-10", cover: 2600, method: "plate_meter" }));
    await as(jess, (tx) => addReading(tx, { paddockId: fourteen.id, measuredOn: "2026-10-10", cover: 1900, method: "plate_meter" }));
    await as(jess, (tx) => addSupplement(tx, { farmId: farm.id, fedOn: "2026-10-05", feed: "PKE", quantity: "2000", unit: "kg_dm" }));
    await as(jess, (tx) => addSupplement(tx, { farmId: farm.id, fedOn: "2026-06-05", feed: "PKE", quantity: "900", unit: "kg_dm" }));

    // FH5: fertiliser, one plan and one application at the quoted price.
    const urea = (await as(jess, (tx) => saveProduct(tx, { name: "Urea", nPct: "46" })))[0];
    const plan = await as(jess, (tx) => createPlan(tx, { farmId: farm.id, name: "Spring urea 2026" }));
    await as(jess, (tx) => savePlanVersion(tx, plan.id, { spreadingPerHa: "25.00", lines: [{ paddockId: twelve.id, productId: urea.id, rateKgHa: "100", pricePerTonne: "780.00" }] }));
    await as(jess, (tx) => recordApplication(tx, plan.id, { paddockId: twelve.id, productId: urea.id, appliedOn: "2026-09-12", tonnes: "2.0" }));

    // FH8: the notebook.
    await as(jess, (tx) => addNotebookEntry(tx, { category: "goals", title: "Winter 3 t DM/ha covers", body: "By June." }));
    await as(jess, (tx) => addNotebookEntry(tx, { category: "history", title: "Bought the runoff", body: "In 2019.", happenedOn: "2019-05-01" }));

    const home = await as(jess, (tx) => farmHome(tx, { today: TODAY }));
    expect(home.calendar).toMatchObject({ from: "2026-10-20", to: "2026-10-26", needsChecking: 0 });
    expect(home.calendar!.items.map((item) => [item.date, item.title, item.mine])).toEqual([
      ["2026-10-21", "Drench the calves", true],
      ["2026-10-22", "Pick up drench", false],
    ]);
    // Mere sees her own two, not Jess's.
    const mereHome = await as(mere, (tx) => farmHome(tx, { today: TODAY }));
    expect(mereHome.calendar!.items.map((item) => item.title)).toEqual(["Pick up drench", "Mere's own errand"]);

    expect(home.stock).toMatchObject({ yearStart: "2026-04-01", yearEnd: "2027-03-31", total: 373, movements: 1, suggestionsWaiting: 1 });
    expect(home.stock!.classes.map((row) => [row.classCode, row.head])).toEqual([
      ["ma_cows", 298],
      // Openings are last year's closing, aged at the start of the year.
      ["r2_heifers", 75],
    ]);

    expect(home.pasture).toHaveLength(1);
    expect(home.pasture![0]).toMatchObject({
      farmName: "Home block",
      averageKgDmPerHa: 2300,
      totalKgDm: 80500,
      latestReading: "2026-10-10",
      growthKgDmPerHaPerDay: "60.0",
      growthPaddocks: 1,
      highest: { name: "12", cover: 2600 },
      lowest: { name: "14", cover: 1900 },
    });
    // This month's and last month's supplements only.
    expect(home.pasture![0].supplements.map((month) => month.month)).toEqual(["2026-10"]);

    expect(home.fertiliser).toEqual([
      expect.objectContaining({ planName: "Spring urea 2026", plannedTonnes: "2.000", appliedTonnes: "2.000", plannedCost: "2060.00", appliedCost: "1560.00", applications: 1, lastAppliedOn: "2026-09-12" }),
    ]);

    expect(home.notebook!.goals.map((note) => note.title)).toEqual(["Winter 3 t DM/ha covers"]);
    expect(home.notebook!.recent.map((note) => note.title)).toEqual(["Bought the runoff"]);
    // No working expenses grouped yet: no performance card.
    expect(home.performance).toBeNull();
  });

  it("FH5 farm performance: the last finished season's working expenses per unit against the season before", async () => {
    // Relative to the real date, as benchmarks open on the last finished season.
    const lastEnd = financialYearEnd(addDays(financialYearEnd(todayIsoDate(), 3), -366), 3);
    const beforeEnd = financialYearEnd(addDays(lastEnd, -366), 3);
    const pay = (date: string, amount: string) =>
      as(jess, (tx) =>
        postJournal(tx, {
          idempotencyKey: key("j"),
          postingDate: date,
          reference: "Wages",
          lines: [
            { accountCode: "6200", debitAmount: amount, creditAmount: "0" },
            { accountCode: "1000", debitAmount: "0", creditAmount: amount },
          ],
        }),
      );
    await pay(addDays(lastEnd, -30), "120000.00");
    await pay(addDays(beforeEnd, -30), "100000.00");
    await as(jess, (tx) => setExpenseGroup(tx, { accountCode: "6200", group: "wages" }));
    await as(jess, (tx) => setYearFigures(tx, { yearEnd: lastEnd, milkSolidsKg: "240000", effectiveHa: "200" }));
    await as(jess, (tx) => setYearFigures(tx, { yearEnd: beforeEnd, milkSolidsKg: "200000" }));
    const home = await as(jess, (tx) => farmHome(tx, { today: TODAY }));
    expect(home.performance).toMatchObject({
      yearEnd: lastEnd,
      previousYearEnd: beforeEnd,
      workingExpenses: { amount: "120000.00", perKgMs: "0.50", perHa: "600.00" },
      previous: { amount: "100000.00", perKgMs: "0.50", perHa: null },
    });
    // The route needs a signed-in member and Farming on.
    const response = await homeRoute.GET(apiRequest(`/api/farming/home?organisationId=${ORG}`, { cookie: await sessionCookieFor(mere) }), undefined as never);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { calendar: { items: Array<{ title: string }> } | null };
    expect(JSON.stringify(body)).not.toContain("Drench the calves");
    await as(jess, (tx) => setFarmingEnabled(tx, { enabled: false }), EMPTY);
    const off = await homeRoute.GET(apiRequest(`/api/farming/home?organisationId=${EMPTY}`, { cookie: await sessionCookieFor(jess) }), undefined as never);
    expect(off.status).toBeGreaterThanOrEqual(400);
  });

  it("FH7 each person's cards and order on the farm Home, up to 10, while Home keeps 4", async () => {
    const put = async (page: string, tiles: string[]) =>
      preferencesRoute.PUT(apiRequest("/api/dashboard-preferences", { method: "PUT", cookie: await sessionCookieFor(mere), body: { organisationId: ORG, page, hidden: false, tiles } }), undefined as never);
    const mine = ["money", "farm_calendar", "stock", "pasture", "fertiliser", "performance", "notebook"];
    const saved = await put("farm_home", mine);
    expect(saved.status).toBe(200);
    expect(((await saved.json()) as { tiles: string[] }).tiles).toEqual(mine);
    expect((await put("home", ["cash_in_bank", "owed_to_you", "bills_to_pay", "next_gst_return", "cash_in_bank"])).status).toBe(400);
    expect((await put("farm_home", ["no_such_card"])).status).toBe(400);
    // Jess still has the defaults.
    const jessGets = await preferencesRoute.GET(apiRequest(`/api/dashboard-preferences?organisationId=${ORG}&page=farm_home`, { cookie: await sessionCookieFor(jess) }), undefined as never);
    expect(((await jessGets.json()) as { tiles: string[] }).tiles).toEqual(["farm_calendar", "stock", "pasture", "fertiliser", "performance", "money", "notebook"]);
  });
});
