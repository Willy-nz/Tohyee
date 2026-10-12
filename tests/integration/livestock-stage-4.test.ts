import { afterAll, beforeAll, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { getJournal, postJournal } from "@/lib/ledger/journals";
import { recordHighPriced } from "@/lib/livestock/high-priced";
import { recordMovement, setAgeingSplit, setOpenings, updateLivestockSettings } from "@/lib/livestock/movements";
import { approveValuation, previewValuation, recordElection, setRate } from "@/lib/livestock/valuation";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, startTestServer, type TestServer } from "../helpers/test-server";

/** Examples LV21-LV26 (approved by Jess 12 Oct 2026), decision 508, from IRD OS 25/02. */
describeWithDatabase("livestock stage 4 (LV21-LV26)", () => {
  let server: TestServer;
  let owner: SessionUser;

  const run = <T>(org: string, work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: owner.id, email: owner.email }, work);
  const move = (org: string, fields: Record<string, unknown>) => run(org, (tx) => recordMovement(tx, { idempotencyKey: key("lv"), ...fields }));
  const posted = async (org: string, journalId: string) =>
    (await run(org, (tx) => getJournal(tx, journalId))).lines.map((line) => [line.accountCode, line.debitAmount, line.creditAmount]);

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

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("owner@example.com", { serverAdmin: true });
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("LV21, LV22: red deer under the herd scheme, breeding stags at their NAMV", async () => {
    const org = "livestock-deer";
    await farm(
      org,
      6,
      "2025-07-01",
      [
        ["deer_red", "ma_hinds", 200, "110000.00"],
        ["deer_red", "r1_hinds", 60, "16800.00"],
        ["deer_red", "r1_stags", 60, "21000.00"],
        ["deer_red", "breeding_stags", 4, "12000.00"],
      ],
      "159800.00",
    );
    const deer = { kind: "deer_red" };
    await move(org, { ...deer, movementType: "birth", movementDate: "2025-11-20", classCode: "r1_hinds", head: 85 });
    await move(org, { ...deer, movementType: "birth", movementDate: "2025-11-20", classCode: "r1_stags", head: 85 });
    await move(org, { ...deer, movementType: "sale", movementDate: "2026-03-01", classCode: "r2_stags", head: 60, amount: "42000.00" });
    await move(org, { ...deer, movementType: "sale", movementDate: "2026-03-01", classCode: "ma_hinds", head: 20, amount: "8000.00" });
    await move(org, { ...deer, movementType: "death", movementDate: "2026-04-01", classCode: "ma_hinds", head: 5 });
    await run(org, (tx) => recordElection(tx, { kind: "deer_red", method: "herd_scheme", fromIncomeYear: 2026 }));
    const preview = await run(org, (tx) => previewValuation(tx, { yearEnd: "2026-06-30" }));
    expect(preview.problems).toEqual([]);
    expect(preview.workings.kinds[0].classes.map((entry) => [entry.classCode, entry.closingHead, entry.closingValue])).toEqual([
      ["r1_hinds", 85, "25075.00"],
      ["r2_hinds", 60, "31500.00"],
      ["ma_hinds", 175, "107100.00"],
      ["r1_stags", 85, "32555.00"],
      ["breeding_stags", 4, "13480.00"],
    ]);
    expect(preview.workings.totals).toMatchObject({ openingRevalued: "176560.00", revaluation: "16760.00", closingValue: "209710.00", valueChange: "33150.00", taxableProfit: "83150.00" });
    const approved = await run(org, (tx) => approveValuation(tx, { yearEnd: "2026-06-30", idempotencyKey: key("v") }));
    expect(await posted(org, approved.valuation.journalId!)).toEqual([
      ["1500", "49910.00", "0.00"],
      ["7060", "0.00", "16760.00"],
      ["5210", "0.00", "33150.00"],
    ]);
  });

  it("LV23, LV26: sheep under NSC with bought ewe hoggets at cost, and the breeding rams in the herd scheme", async () => {
    const org = "livestock-sheep-mixed";
    await farm(
      org,
      6,
      "2025-07-01",
      [
        ["sheep", "ma_ewes", 1000, "75000.00"],
        ["sheep", "breeding_rams", 10, "4000.00"],
      ],
      "79000.00",
    );
    await run(org, (tx) => setAgeingSplit(tx, { yearEnd: "2026-06-30", kind: "sheep", classCode: "ma_ewes", head: 0 }));
    await move(org, { kind: "sheep", movementType: "birth", movementDate: "2025-09-25", classCode: "ewe_hoggets", head: 1250 });
    await move(org, { kind: "sheep", movementType: "purchase", movementDate: "2025-12-01", classCode: "ewe_hoggets", head: 500, amount: "30000.00" });
    // Under NSC without the herd scheme part of the election, the rams are refused.
    await run(org, (tx) => recordElection(tx, { kind: "sheep", method: "nsc", fromIncomeYear: 2025 }));
    expect((await run(org, (tx) => previewValuation(tx, { yearEnd: "2026-06-30" }))).problems).toEqual([
      "Sheep: breeding rams under national standard cost aren't supported. Elect them into the herd scheme (with the NSC election) instead.",
    ]);
    await run(org, (tx) => recordElection(tx, { kind: "sheep", method: "nsc", fromIncomeYear: 2026, maleBreedingHerdScheme: true }));
    const preview = await run(org, (tx) => previewValuation(tx, { yearEnd: "2026-06-30" }));
    expect(preview.problems).toEqual([]);
    const sheep = preview.workings.kinds[0];
    expect(sheep.maleBreedingHerdScheme).toBe(true);
    expect(sheep.classes.find((entry) => entry.classCode === "ewe_hoggets")).toMatchObject({ closingHead: 1750, closingValue: "81750.00" });
    expect(sheep.classes.find((entry) => entry.classCode === "breeding_rams")).toMatchObject({ rate: "431.00", openingValue: "4000.00", openingRevalued: "4310.00", closingValue: "4310.00" });
    expect(sheep).toMatchObject({ revaluation: "310.00", purchases: "30000.00" });
    const approved = await run(org, (tx) => approveValuation(tx, { yearEnd: "2026-06-30", idempotencyKey: key("v") }));
    const lines = await posted(org, approved.valuation.journalId!);
    expect(lines).toContainEqual(["7060", "0.00", "310.00"]);
  });

  it("LV24: a herd value ratio of 1.1 scales NAMV per head; the Chatham Islands ratio is for sheep and beef only", async () => {
    const org = "livestock-ratio";
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
    const dairy = { kind: "dairy_cattle" };
    await move(org, { ...dairy, movementType: "birth", movementDate: "2025-08-15", classCode: "r1_heifers", head: 80 });
    await move(org, { ...dairy, movementType: "purchase", movementDate: "2025-11-01", classCode: "ma_cows", head: 10, amount: "24000.00" });
    await move(org, { ...dairy, movementType: "death", movementDate: "2026-01-20", classCode: "ma_cows", head: 5 });
    await move(org, { ...dairy, movementType: "sale", movementDate: "2026-03-10", classCode: "ma_cows", head: 60, amount: "66000.00" });
    await expect(run(org, (tx) => recordElection(tx, { kind: "dairy_cattle", method: "herd_scheme", fromIncomeYear: 2026, herdValueRatio: "0.3" }))).rejects.toThrow(/sheep and beef cattle only/);
    await expect(run(org, (tx) => recordElection(tx, { kind: "dairy_cattle", method: "nsc", fromIncomeYear: 2026, herdValueRatio: "1.1" }))).rejects.toThrow(/for the herd scheme/);
    await run(org, (tx) => recordElection(tx, { kind: "dairy_cattle", method: "herd_scheme", fromIncomeYear: 2026, herdValueRatio: "1.1" }));
    const preview = await run(org, (tx) => previewValuation(tx, { yearEnd: "2026-05-31" }));
    expect(preview.problems).toEqual([]);
    expect(preview.workings.kinds[0].classes.map((entry) => [entry.classCode, entry.rate])).toEqual([
      ["r1_heifers", "1458.60"],
      ["r2_heifers", "2857.80"],
      ["ma_cows", "3106.40"],
    ]);
    expect(preview.workings.totals).toMatchObject({
      openingRevalued: "1241361.00",
      revaluation: "251111.00",
      closingValue: "1309539.00",
      valueChange: "68178.00",
      taxableProfit: "110178.00",
    });
    expect(preview.journal.map((line) => [line.accountCode, line.debit, line.credit])).toEqual([
      ["1500", "319289.00", "0.00"],
      ["7060", "0.00", "251111.00"],
      ["5210", "0.00", "68178.00"],
    ]);
  });

  it("LV25: a high-priced bull is at cost in the year bought, then less IRD's rate a year, apart from its class", async () => {
    const org = "livestock-high-priced";
    await farm(org, 6, "2025-07-01", [["beef_cattle", "ma_cows", 100, "200000.00"]], "200000.00");
    await move(org, { kind: "beef_cattle", movementType: "purchase", movementDate: "2025-08-01", classCode: "breeding_bulls", head: 1, amount: "30000.00" });
    const bull = { kind: "beef_cattle", classCode: "breeding_bulls", boughtOn: "2025-08-01", ratePercent: "25", rateSource: "IRD high-priced livestock rate (typed for the test)" };
    // Tohyee has no 2025 NAMV, so last year's is typed; 20,000.00 isn't five times 5,008.00.
    await expect(run(org, (tx) => recordHighPriced(tx, { ...bull, description: "Te Mana", cost: "30000.00" }))).rejects.toThrow(/Type the 2025 NAMV/);
    await expect(run(org, (tx) => recordHighPriced(tx, { ...bull, description: "Cheap", cost: "20000.00", priorYearNamv: "4900.00" }))).rejects.toThrow(/isn't high-priced/);
    await run(org, (tx) => recordHighPriced(tx, { ...bull, description: "Te Mana", cost: "30000.00", priorYearNamv: "4900.00" }));
    await run(org, (tx) => recordElection(tx, { kind: "beef_cattle", method: "herd_scheme", fromIncomeYear: 2026 }));

    const first = await run(org, (tx) => previewValuation(tx, { yearEnd: "2026-06-30" }));
    expect(first.problems).toEqual([]);
    const beef = first.workings.kinds[0];
    expect(beef.highPriced).toEqual([expect.objectContaining({ description: "Te Mana", openingValue: "0.00", closingValue: "30000.00", status: "high_priced" })]);
    // The bull is apart, so the breeding bulls class has no head to value.
    expect(beef.classes.map((entry) => entry.classCode)).toEqual(["ma_cows"]);
    expect(beef).toMatchObject({ closingValue: "267600.00", purchases: "30000.00", taxableProfit: "0.00" });
    await run(org, (tx) => approveValuation(tx, { yearEnd: "2026-06-30", idempotencyKey: key("v") }));

    // 2026-27, with 2027 rates the same as 2026's for the test.
    for (const [category, amount] of [["ma_cows", "2376.00"], ["breeding_bulls", "5008.00"]]) {
      await run(org, (tx) => setRate(tx, { incomeYear: 2027, rateKind: "namv", kind: "beef_cattle", category, amount, source: "Test: 2026's values" }));
    }
    const second = await run(org, (tx) => previewValuation(tx, { yearEnd: "2027-06-30" }));
    expect(second.problems).toEqual([]);
    expect(second.workings.kinds[0].highPriced).toEqual([expect.objectContaining({ openingValue: "30000.00", closingValue: "22500.00", status: "high_priced" })]);
    expect(second.workings.kinds[0]).toMatchObject({ revaluation: "0.00", valueChange: "-7500.00", taxableProfit: "-7500.00" });
    expect(second.journal.map((line) => [line.accountCode, line.debit, line.credit])).toEqual([
      ["1500", "0.00", "7500.00"],
      ["5210", "7500.00", "0.00"],
    ]);
  });
});
