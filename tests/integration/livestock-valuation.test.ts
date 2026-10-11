import { afterAll, beforeAll, expect, it } from "vitest";
import * as valuationRoute from "@/app/api/livestock/valuation/route";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { getJournal, postJournal } from "@/lib/ledger/journals";
import { recordCounts, recordMovement, setAgeingSplit, setOpenings, updateLivestockSettings } from "@/lib/livestock/movements";
import { approveValuation, incomeYearOf, previewValuation, recordElection, replaceValuation, setRate } from "@/lib/livestock/valuation";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import {
  apiRequest,
  createTestOrganisation,
  createTestUser,
  describeWithDatabase,
  inOrganisation,
  key,
  params,
  sessionCookieFor,
  startTestServer,
  type TestServer,
} from "../helpers/test-server";

/** Examples LV4-LV12 (approved by Jess 11 Oct 2026), decisions 503 and 505: the year-end valuation and its journal. */
describeWithDatabase("livestock year-end valuation (LV4-LV12)", () => {
  let server: TestServer;
  let owner: SessionUser;

  const run = <T>(org: string, work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: owner.id, email: owner.email }, work);
  const move = (org: string, fields: Record<string, unknown>) => run(org, (tx) => recordMovement(tx, { idempotencyKey: key("lv"), ...fields }));
  const posted = async (org: string, journalId: string) =>
    (await run(org, (tx) => getJournal(tx, journalId))).lines.map((line) => [line.accountCode, line.debitAmount, line.creditAmount]);

  /** A farm with livestock on, an opening position and the opening balance posted to 1500. */
  async function farm(org: string, yearEndMonth: number, firstYearStart: string, openings: Array<[string, string, number, string]>, openingTotal: string) {
    await createTestOrganisation(owner, org);
    await run(org, (tx) => updateOrganisationSettings(tx, { financialYearEndMonth: yearEndMonth }));
    await run(org, (tx) => updateLivestockSettings(tx, { enabled: true, firstYearStart }));
    await run(org, (tx) => setOpenings(tx, { lines: openings.map(([kind, classCode, head, value]) => ({ kind, classCode, head, value })) }));
    const day = new Date(Date.parse(`${firstYearStart}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    await run(org, (tx) =>
      postJournal(tx, {
        idempotencyKey: key("ob"),
        postingDate: day,
        reference: "Livestock opening",
        lines: [
          { accountCode: "1500", debitAmount: openingTotal, creditAmount: "0" },
          { accountCode: "3900", debitAmount: "0", creditAmount: openingTotal },
        ],
      }),
    );
  }

  /** LV1's year for Kōwhai Dairies. */
  async function kowhaiYear(org: string) {
    const dairy = { kind: "dairy_cattle" };
    await move(org, { ...dairy, movementType: "birth", movementDate: "2025-08-15", classCode: "r1_heifers", head: 80 });
    await move(org, { ...dairy, movementType: "purchase", movementDate: "2025-11-01", classCode: "ma_cows", head: 10, amount: "24000.00" });
    await move(org, { ...dairy, movementType: "death", movementDate: "2026-01-20", classCode: "ma_cows", head: 5 });
    await move(org, { ...dairy, movementType: "sale", movementDate: "2026-03-10", classCode: "ma_cows", head: 60, amount: "66000.00" });
  }

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("owner@example.com", { serverAdmin: true });
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("works out the income year from the balance date", () => {
    expect(incomeYearOf("2026-05-31")).toBe(2026);
    expect(incomeYearOf("2026-06-30")).toBe(2026);
    expect(incomeYearOf("2026-03-31")).toBe(2026);
    expect(incomeYearOf("2025-11-30")).toBe(2026);
  });

  it("LV4, LV9, LV12: Kōwhai's herd scheme year end, approved once, replaced by reversal, then to a reserve", async () => {
    const org = "livestock-kowhai-herd";
    await farm(
      org,
      5,
      "2025-06-01",
      [
        ["dairy_cattle", "ma_cows", 300, "750000.00"],
        ["dairy_cattle", "r2_heifers", 70, "154000.00"],
        ["dairy_cattle", "r1_heifers", 75, "86250.00"],
      ],
      "990250.00",
    );
    await kowhaiYear(org);

    // No election yet, and a count that doesn't add up: both stop approval.
    await run(org, (tx) => recordCounts(tx, { countDate: "2026-05-31", lines: [{ kind: "dairy_cattle", classCode: "ma_cows", head: 312 }] }));
    let preview = await run(org, (tx) => previewValuation(tx, { yearEnd: "2026-05-31" }));
    expect(preview.problems).toEqual([
      "Mixed-age cows: 312 counted but 315 expected (3 not explained, LV2).",
      "Dairy cattle: record which valuation method the farm uses (its election) for the 2026 income year.",
    ]);
    await run(org, (tx) => recordCounts(tx, { countDate: "2026-05-31", lines: [{ kind: "dairy_cattle", classCode: "ma_cows", head: 315 }] }));
    await run(org, (tx) => recordElection(tx, { kind: "dairy_cattle", method: "herd_scheme", fromIncomeYear: 2026, note: "Herd scheme since 2010; IRD letter attached" }));

    preview = await run(org, (tx) => previewValuation(tx, { yearEnd: "2026-05-31" }));
    expect(preview.problems).toEqual([]);
    expect(preview.ledgerOpening).toBe("990250.00");
    const dairy = preview.workings.kinds[0];
    expect(dairy.classes.map((entry) => [entry.classCode, entry.openingHead, entry.openingValue, entry.rate, entry.openingRevalued, entry.closingHead, entry.closingValue])).toEqual([
      ["r1_heifers", 75, "86250.00", "1326.00", "99450.00", 80, "106080.00"],
      ["r2_heifers", 70, "154000.00", "2598.00", "181860.00", 75, "194850.00"],
      ["ma_cows", 300, "750000.00", "2824.00", "847200.00", 315, "889560.00"],
    ]);
    expect(preview.workings.totals).toEqual({
      openingValue: "990250.00",
      revaluation: "138260.00",
      openingRevalued: "1128510.00",
      closingValue: "1190490.00",
      valueChange: "61980.00",
      sales: "66000.00",
      purchases: "24000.00",
      taxableProfit: "103980.00",
    });

    // A bookkeeper can't approve: the accountant (an admin) does.
    const bookkeeper = await createTestUser("bookkeeper@example.com", {});
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'bookkeeper')", [org, bookkeeper.id]);
    const refused = await valuationRoute.POST(
      apiRequest("/api/livestock/valuation", { method: "POST", cookie: await sessionCookieFor(bookkeeper), body: { organisationId: org, yearEnd: "2026-05-31", idempotencyKey: key("v") } }),
      params({}),
    );
    expect(refused.status).toBe(403);

    const approveKey = key("v");
    const approved = await run(org, (tx) => approveValuation(tx, { yearEnd: "2026-05-31", idempotencyKey: approveKey }));
    expect(await posted(org, approved.valuation.journalId!)).toEqual([
      ["1500", "200240.00", "0.00"],
      ["7060", "0.00", "138260.00"],
      ["5210", "0.00", "61980.00"],
    ]);
    // LV9: approving again with the same key is the same valuation; with a new key it's refused; the year can't change.
    expect((await run(org, (tx) => approveValuation(tx, { yearEnd: "2026-05-31", idempotencyKey: approveKey }))).created).toBe(false);
    await expect(run(org, (tx) => approveValuation(tx, { yearEnd: "2026-05-31", idempotencyKey: key("v") }))).rejects.toThrow(/already approved/);
    await expect(move(org, { kind: "dairy_cattle", movementType: "death", movementDate: "2026-02-01", classCode: "ma_cows", head: 1 })).rejects.toThrow(
      /valuation for the year to 2026-05-31 is approved/,
    );
    await expect(run(org, (tx) => setRate(tx, { incomeYear: 2026, rateKind: "namv", kind: "dairy_cattle", category: "ma_cows", amount: "2900", source: "x" }))).rejects.toThrow(
      /Replace it before changing them/,
    );

    // Replaced: the journal is reversed, never edited.
    const replaced = await run(org, (tx) => replaceValuation(tx, { yearEnd: "2026-05-31", reason: "Report the revaluation in a reserve instead" }));
    expect(replaced.status).toBe("replaced");
    expect(await posted(org, replaced.reversalJournalId!)).toEqual([
      ["1500", "0.00", "200240.00"],
      ["7060", "138260.00", "0.00"],
      ["5210", "61980.00", "0.00"],
    ]);

    // LV12: the same year to an equity reserve; the tax workings are the same.
    await run(org, (tx) => updateLivestockSettings(tx, { revaluationTarget: "reserve" }));
    const again = await run(org, (tx) => approveValuation(tx, { yearEnd: "2026-05-31", idempotencyKey: key("v") }));
    expect(again.valuation.workings.totals.taxableProfit).toBe("103980.00");
    expect(await posted(org, again.valuation.journalId!)).toEqual([
      ["1500", "200240.00", "0.00"],
      ["3300", "0.00", "138260.00"],
      ["5210", "0.00", "61980.00"],
    ]);
  });

  it("LV5: a rates-only change is all revaluation, with no taxable profit", async () => {
    const org = "livestock-rates-only";
    await farm(org, 5, "2025-06-01", [["dairy_cattle", "ma_cows", 100, "250000.00"]], "250000.00");
    await run(org, (tx) => recordElection(tx, { kind: "dairy_cattle", method: "herd_scheme", fromIncomeYear: 2026 }));
    const approved = await run(org, (tx) => approveValuation(tx, { yearEnd: "2026-05-31", idempotencyKey: key("v") }));
    expect(approved.valuation.workings.totals).toMatchObject({ revaluation: "32400.00", valueChange: "0.00", taxableProfit: "0.00", closingValue: "282400.00" });
    expect(await posted(org, approved.valuation.journalId!)).toEqual([
      ["1500", "32400.00", "0.00"],
      ["7060", "0.00", "32400.00"],
    ]);
  });

  it("LV6: Kōwhai under national standard cost, averaging the mature group", async () => {
    const org = "livestock-kowhai-nsc";
    await farm(
      org,
      5,
      "2025-06-01",
      [
        ["dairy_cattle", "ma_cows", 300, "357000.00"],
        ["dairy_cattle", "r2_heifers", 70, "83300.00"],
        ["dairy_cattle", "r1_heifers", 75, "53220.00"],
      ],
      "493520.00",
    );
    await kowhaiYear(org);
    await run(org, (tx) => recordElection(tx, { kind: "dairy_cattle", method: "nsc", fromIncomeYear: 2026 }));
    const preview = await run(org, (tx) => previewValuation(tx, { yearEnd: "2026-05-31" }));
    expect(preview.problems).toEqual([]);
    expect(preview.workings.kinds[0].nsc).toEqual({
      risingOneRate: "788.90",
      risingTwoRate: "535.50",
      matureOpeningHead: 370,
      matureOpeningValue: "440300.00",
      matureOut: 65,
      survivorsValue: "362950.00",
      intakeHead: 75,
      intakeValue: "93382.50",
      purchasedHead: 10,
      purchasedCost: "24000.00",
      matureClosingHead: 390,
      matureClosingValue: "480332.50",
      matureAverage: "1231.62",
    });
    expect(preview.workings.totals).toMatchObject({ openingValue: "493520.00", revaluation: "0.00", closingValue: "543444.50", valueChange: "49924.50", taxableProfit: "91924.50" });
    const approved = await run(org, (tx) => approveValuation(tx, { yearEnd: "2026-05-31", idempotencyKey: key("v") }));
    expect(await posted(org, approved.valuation.journalId!)).toEqual([
      ["1500", "49924.50", "0.00"],
      ["5210", "0.00", "49924.50"],
    ]);
    // The mature group's value is shared by head, and adds back exactly, so next year opens with it.
    const classes = approved.valuation.workings.kinds[0].classes;
    expect(classes.filter((entry) => entry.classCode !== "r1_heifers").reduce((total, entry) => total + Number(entry.closingValue) * 100, 0)).toBe(48033250);
  });

  it("LV10, LV11: Tussock's beef herd scheme and sheep NSC in one journal", async () => {
    const org = "livestock-tussock";
    await farm(
      org,
      6,
      "2025-07-01",
      [
        ["beef_cattle", "ma_cows", 100, "200000.00"],
        ["beef_cattle", "r1_heifers", 30, "33000.00"],
        ["beef_cattle", "r1_steers_bulls", 30, "39000.00"],
        ["sheep", "ewe_hoggets", 300, "12990.00"],
        ["sheep", "ma_ewes", 1000, "75000.00"],
      ],
      "359990.00",
    );
    const beef = { kind: "beef_cattle" };
    await move(org, { ...beef, movementType: "birth", movementDate: "2025-09-20", classCode: "r1_heifers", head: 42 });
    await move(org, { ...beef, movementType: "birth", movementDate: "2025-09-20", classCode: "r1_steers_bulls", head: 43 });
    await move(org, { ...beef, movementType: "sale", movementDate: "2026-02-10", classCode: "r2_steers_bulls", head: 30, amount: "57000.00" });
    await move(org, { ...beef, movementType: "sale", movementDate: "2026-02-10", classCode: "r2_heifers", head: 10, amount: "16000.00" });
    await move(org, { ...beef, movementType: "sale", movementDate: "2026-04-15", classCode: "ma_cows", head: 10, amount: "14000.00" });
    await move(org, { ...beef, movementType: "death", movementDate: "2026-05-01", classCode: "ma_cows", head: 2 });
    const sheep = { kind: "sheep" };
    await run(org, (tx) => setAgeingSplit(tx, { yearEnd: "2026-06-30", kind: "sheep", classCode: "ma_ewes", head: 200 }));
    await move(org, { ...sheep, movementType: "birth", movementDate: "2025-09-25", classCode: "ewe_hoggets", head: 760 });
    await move(org, { ...sheep, movementType: "birth", movementDate: "2025-09-25", classCode: "ram_wether_hoggets", head: 760 });
    await move(org, { ...sheep, movementType: "sale", movementDate: "2026-01-15", classCode: "ewe_hoggets", head: 440, amount: "66000.00" });
    await move(org, { ...sheep, movementType: "sale", movementDate: "2026-01-15", classCode: "ram_wether_hoggets", head: 760, amount: "114000.00" });
    await move(org, { ...sheep, movementType: "sale", movementDate: "2026-03-01", classCode: "ma_ewes", head: 250, amount: "30000.00" });
    await move(org, { ...sheep, movementType: "death", movementDate: "2026-04-01", classCode: "ma_ewes", head: 40 });
    await run(org, (tx) => recordElection(tx, { kind: "beef_cattle", method: "herd_scheme", fromIncomeYear: 2026 }));
    await run(org, (tx) => recordElection(tx, { kind: "sheep", method: "nsc", fromIncomeYear: 2026 }));

    const preview = await run(org, (tx) => previewValuation(tx, { yearEnd: "2026-06-30" }));
    expect(preview.problems).toEqual([]);
    const [beefWorking, sheepWorking] = preview.workings.kinds;
    expect(beefWorking).toMatchObject({
      openingValue: "272000.00",
      revaluation: "53740.00",
      openingRevalued: "325740.00",
      closingValue: "373283.00",
      valueChange: "47543.00",
      sales: "87000.00",
      taxableProfit: "134543.00",
    });
    expect(sheepWorking.nsc).toMatchObject({ survivorsValue: "53250.00", intakeValue: "21930.00", matureClosingHead: 1010, matureClosingValue: "75180.00", matureAverage: "74.44" });
    expect(sheepWorking).toMatchObject({ openingValue: "87990.00", closingValue: "88428.00", sales: "210000.00", taxableProfit: "210438.00" });

    const approved = await run(org, (tx) => approveValuation(tx, { yearEnd: "2026-06-30", idempotencyKey: key("v") }));
    expect(await posted(org, approved.valuation.journalId!)).toEqual([
      ["1500", "101283.00", "0.00"],
      ["7060", "0.00", "53740.00"],
      ["5210", "0.00", "47543.00"],
      ["1500", "438.00", "0.00"],
      ["5210", "0.00", "438.00"],
    ]);
  });

  it("refuses what isn't supported or doesn't tie: rates, breeding bulls, a wrong ledger opening, next year before this one", async () => {
    const org = "livestock-refusals";
    await farm(org, 5, "2025-06-01", [["dairy_cattle", "ma_cows", 10, "25000.00"], ["dairy_cattle", "breeding_bulls", 1, "3000.00"]], "27000.00");
    await run(org, (tx) => recordElection(tx, { kind: "dairy_cattle", method: "herd_scheme", fromIncomeYear: 2026 }));
    await run(org, (tx) => recordElection(tx, { kind: "dairy_cattle", method: "nsc", fromIncomeYear: 2027 }));
    const preview = await run(org, (tx) => previewValuation(tx, { yearEnd: "2026-05-31" }));
    expect(preview.problems).toEqual([
      "Dairy cattle: breeding bulls have their own rules, which aren't supported yet.",
      "Account 1500 Livestock on hand shows 27000.00 at 2026-05-31, but the livestock opening value is 28000.00. Post the opening balance (or correct it) first, so the closing value ties to the balance sheet.",
    ]);
    await expect(run(org, (tx) => approveValuation(tx, { yearEnd: "2026-05-31", idempotencyKey: key("v") }))).rejects.toThrow(/can't be approved yet/);
    const next = await run(org, (tx) => previewValuation(tx, { yearEnd: "2027-05-31" }));
    expect(next.problems[0]).toBe("Approve the valuation for the year to 2026-05-31 first: this year opens with its closing values.");
    expect(next.problems).toContain("Dairy cattle: there are no 2027 national standard costs (rising 1 and rising 2 year). Add them from IRD's determination.");
  });
});
