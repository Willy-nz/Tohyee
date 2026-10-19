import { afterAll, beforeAll, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { getJournal, postJournal } from "@/lib/ledger/journals";
import { recordCounts, recordMovement, setClassReporting, setOpenings, updateLivestockSettings } from "@/lib/livestock/movements";
import { approveValuation, previewValuation, recordElection, replaceValuation } from "@/lib/livestock/valuation";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { draftNotes } from "@/lib/reports/financial-statements";
import { createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, startTestServer, type TestServer } from "../helpers/test-server";

/** Examples LV27 and LV28 (#310 items 2 and 3; decisions 566 and 567, not yet reviewed): current classes and the reporting basis. */
describeWithDatabase("livestock and the reporting basis (LV27, LV28)", () => {
  let server: TestServer;
  let owner: SessionUser;

  const run = <T>(org: string, work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: owner.id, email: owner.email }, work);
  const move = (org: string, fields: Record<string, unknown>) => run(org, (tx) => recordMovement(tx, { idempotencyKey: key("lv"), ...fields }));
  const balance = async (org: string, code: string) =>
    (
      await run(org, (tx) =>
        tx.query<{ balance: string }>(
          "select coalesce(sum(l.debit_amount - l.credit_amount), 0)::numeric(18,2)::text as balance from ledger_journal_lines l join accounts a on a.id = l.account_id where a.code = $1",
          [code],
        ),
      )
    ).rows[0].balance;

  /** LV4's Kōwhai Dairies: openings, the opening balance on 1500, and LV1's year. */
  async function kowhai(org: string) {
    await createTestOrganisation(owner, org);
    await run(org, (tx) => updateOrganisationSettings(tx, { financialYearEndMonth: 5 }));
    await run(org, (tx) => updateLivestockSettings(tx, { enabled: true, firstYearStart: "2025-06-01" }));
    await run(org, (tx) =>
      setOpenings(tx, {
        lines: [
          { kind: "dairy_cattle", classCode: "ma_cows", head: 300, value: "750000.00" },
          { kind: "dairy_cattle", classCode: "r2_heifers", head: 70, value: "154000.00" },
          { kind: "dairy_cattle", classCode: "r1_heifers", head: 75, value: "86250.00" },
        ],
      }),
    );
    await run(org, (tx) =>
      postJournal(tx, {
        idempotencyKey: key("ob"),
        postingDate: "2025-05-31",
        reference: "Livestock opening",
        lines: [
          { accountCode: "1500", debitAmount: "990250.00", creditAmount: "0" },
          { accountCode: "3900", debitAmount: "0", creditAmount: "990250.00" },
        ],
      }),
    );
    const dairy = { kind: "dairy_cattle" };
    await move(org, { ...dairy, movementType: "birth", movementDate: "2025-08-15", classCode: "r1_heifers", head: 80 });
    await move(org, { ...dairy, movementType: "purchase", movementDate: "2025-11-01", classCode: "ma_cows", head: 10, amount: "24000.00" });
    await move(org, { ...dairy, movementType: "death", movementDate: "2026-01-20", classCode: "ma_cows", head: 5 });
    await move(org, { ...dairy, movementType: "sale", movementDate: "2026-03-10", classCode: "ma_cows", head: 60, amount: "66000.00" });
    await run(org, (tx) => recordCounts(tx, { countDate: "2026-05-31", lines: [{ kind: "dairy_cattle", classCode: "ma_cows", head: 315 }] }));
    await run(org, (tx) => recordElection(tx, { kind: "dairy_cattle", method: "herd_scheme", fromIncomeYear: 2026, note: "Herd scheme since 2010" }));
  }

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("owner@example.com", { serverAdmin: true });
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("LV27: rising one-year heifers held for sale are current; the valuation moves them to 1490", async () => {
    const org = "livestock-reporting-current";
    await kowhai(org);
    // Unless chosen, everything is non-current, as before.
    const before = await run(org, (tx) => previewValuation(tx, { yearEnd: "2026-05-31" }));
    expect(before.journal.map((line) => line.accountCode)).toEqual(["1500", "7060", "5210"]);

    await expect(run(org, (tx) => setClassReporting(tx, { lines: [{ kind: "dairy_cattle", classCode: "lambs", current: true }] }))).rejects.toThrow("There's no livestock class dairy_cattle lambs.");
    const settings = await run(org, (tx) => setClassReporting(tx, { lines: [{ kind: "dairy_cattle", classCode: "r1_heifers", current: true }] }));
    expect([settings.currentClasses, settings.accounts.currentAsset]).toEqual([["dairy_cattle.r1_heifers"], { code: "1490", name: "Livestock on hand (current)" }]);
    await expect(run(org, (tx) => updateLivestockSettings(tx, { currentAssetAccount: "1500" }))).rejects.toThrow("Account 1500 has to be a current asset account.");

    const preview = await run(org, (tx) => previewValuation(tx, { yearEnd: "2026-05-31" }));
    expect([preview.problems, preview.ledgerOpening, preview.workings.current]).toEqual([
      [],
      "990250.00",
      { classes: ["dairy_cattle.r1_heifers"], closingValue: "106080.00", transfer: "106080.00" },
    ]);
    expect(preview.journal.map((line) => [line.accountCode, line.debit, line.credit])).toEqual([
      ["1500", "200240.00", "0.00"],
      ["7060", "0.00", "138260.00"],
      ["5210", "0.00", "61980.00"],
      ["1490", "106080.00", "0.00"],
      ["1500", "0.00", "106080.00"],
    ]);
    // The tax workings don't change.
    expect(preview.workings.totals).toMatchObject({ closingValue: "1190490.00", taxableProfit: "103980.00" });
    const approved = await run(org, (tx) => approveValuation(tx, { yearEnd: "2026-05-31", idempotencyKey: key("v") }));
    expect((await run(org, (tx) => getJournal(tx, approved.valuation.journalId!))).lines.length).toBe(5);
    expect([await balance(org, "1500"), await balance(org, "1490")]).toEqual(["1084410.00", "106080.00"]);
    // The approved valuation shows the same journal.
    expect((await run(org, (tx) => previewValuation(tx, { yearEnd: "2026-05-31" }))).journal).toEqual(preview.journal);

    // Making them non-current again changes nothing approved; replaced and approved again, nothing is moved.
    await run(org, (tx) => setClassReporting(tx, { lines: [{ kind: "dairy_cattle", classCode: "r1_heifers", current: false }] }));
    expect([await balance(org, "1500"), await balance(org, "1490")]).toEqual(["1084410.00", "106080.00"]);
    await run(org, (tx) => replaceValuation(tx, { yearEnd: "2026-05-31", reason: "Heifers kept as replacements" }));
    const again = await run(org, (tx) => previewValuation(tx, { yearEnd: "2026-05-31" }));
    expect([again.workings.current, again.journal.map((line) => line.accountCode)]).toEqual([{ classes: [], closingValue: "0.00", transfer: "0.00" }, ["1500", "7060", "5210"]]);
  });

  it("LV28: the reporting basis decides where the revaluation can go, and the draft note states the policy", async () => {
    const org = "livestock-reporting-basis";
    await kowhai(org);
    expect((await run(org, (tx) => previewValuation(tx, { yearEnd: "2026-05-31" }))).notices).toEqual([]);
    // Special purpose: the farm's choice, stated as its policy.
    await run(org, (tx) => updateLivestockSettings(tx, { revaluationTarget: "reserve" }));
    const livestockNote = async () => (await run(org, (tx) => draftNotes(tx))).find((note) => note.title === "Livestock")!.body;
    expect(await livestockNote()).toContain("The herd scheme revaluation of opening stock is taken to the herd scheme revaluation reserve in equity.");
    expect(await livestockNote()).toContain("All livestock is shown as a non-current asset.");
    // General purpose: profit and loss only.
    await expect(run(org, (tx) => updateLivestockSettings(tx, { reportingBasis: "general_purpose" }))).rejects.toThrow(
      "Under general purpose reporting (NZ IFRS or PBE Standards) changes in livestock values go through profit or loss (NZ IAS 41 para 26), so the herd scheme revaluation can't go to a reserve. Choose profit and loss.",
    );
    const general = await run(org, (tx) => updateLivestockSettings(tx, { reportingBasis: "general_purpose", revaluationTarget: "profit_and_loss" }));
    expect([general.reportingBasis, general.revaluationTarget]).toEqual(["general_purpose", "profit_and_loss"]);
    await expect(run(org, (tx) => updateLivestockSettings(tx, { revaluationTarget: "reserve" }))).rejects.toThrow("can't go to a reserve");
    const preview = await run(org, (tx) => previewValuation(tx, { yearEnd: "2026-05-31" }));
    expect(preview.notices).toEqual([
      "These are tax values (herd scheme and national standard cost). For general purpose financial statements, NZ IAS 41 measures livestock at fair value less costs to sell, with changes in profit or loss: your accountant adjusts for any difference. Tohyee doesn't work out fair value.",
    ]);
    // It's a notice, not a problem: the tax valuation is still worked out and can be approved.
    expect(preview.problems).toEqual([]);
    expect(preview.journal.map((line) => [line.accountCode, line.debit, line.credit])).toEqual([
      ["1500", "200240.00", "0.00"],
      ["7060", "0.00", "138260.00"],
      ["5210", "0.00", "61980.00"],
    ]);
  });
});
