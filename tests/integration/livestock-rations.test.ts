import { afterAll, beforeAll, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { getJournal } from "@/lib/ledger/journals";
import { assessMovementGst, headCount, recordMovement, setOpenings, updateLivestockSettings, voidMovement } from "@/lib/livestock/movements";
import { calculateGstReturn, fileGstReturn, getGstReturn } from "@/lib/reports/gst-return";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { cashFlowStatement } from "@/lib/reports/statements";
import { createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "livestock-rations";
const WHO = { rationsRecipient: "Sam (shareholder)", rationsEntity: "Made-up Farm Ltd" };

/** Killed for rations (RAT1-RAT4, #259; RAT5-RAT10 GST, as delegated, not yet reviewed by an accountant). */
describeWithDatabase("livestock killed for rations", () => {
  let server: TestServer;
  let owner: SessionUser;
  const run = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: owner.id, email: owner.email }, work);
  const move = (fields: Record<string, unknown>) =>
    run((tx) => recordMovement(tx, { idempotencyKey: key("lv"), kind: "dairy_cattle", classCode: "ma_cows", ...fields })).then((result) => result.movement);
  const cows = async () => (await run((tx) => headCount(tx, { yearEnd: "2026-05-31" }))).rows.find((row) => row.classCode === "ma_cows")!;
  const journalLines = async (id: string) =>
    (await run((tx) => getJournal(tx, id))).lines.map((line) => [line.accountCode, line.debitAmount, line.creditAmount]);
  let rat1 = "";
  let gstCode = "";
  /** What a rations event has posted overall, by account: debits less credits, across every journal for it. */
  const net = async (movementId: string) => {
    const rows = await run((tx) =>
      tx.query<{ code: string; net: string }>(
        `select a.code, sum(l.debit_amount - l.credit_amount)::text as net
           from ledger_journal_lines l join ledger_journals j on j.id = l.journal_id join accounts a on a.id = l.account_id
          where j.reference = $1 group by a.code order by a.code`,
        [`RATIONS-${movementId}`],
      ),
    );
    return Object.fromEntries(rows.rows.map((row) => [row.code, row.net]));
  };
  const gstReturn = (periodStart: string, periodEnd: string) => run((tx) => calculateGstReturn(tx, { periodStart, periodEnd }));

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("rations-owner@example.com", { serverAdmin: true });
    await createTestOrganisation(owner, ORG);
    await run((tx) => updateOrganisationSettings(tx, { financialYearEndMonth: 5 }));
    await run((tx) => updateLivestockSettings(tx, { enabled: true, firstYearStart: "2025-06-01" }));
    await run((tx) => setOpenings(tx, { lines: [{ kind: "dairy_cattle", classCode: "ma_cows", head: 300, value: "750000.00" }] }));
    gstCode = (await run((tx) => tx.query<{ code: string }>("select code from accounts where system_key = 'gst'"))).rows[0].code;
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("RAT1: the owner's rations are income at market value, Dr drawings, Cr rations income; GST unresolved until assessed", async () => {
    await expect(move({ movementType: "rations", movementDate: "2026-03-10", head: 1 })).rejects.toThrow(/Whose rations/);
    await expect(move({ movementType: "rations", rationsFor: "owner", movementDate: "2026-03-10", head: 1, ...WHO })).rejects.toThrow(/market value/);
    await expect(move({ movementType: "rations", rationsFor: "owner", movementDate: "2026-03-10", head: 1, amount: "1100.00" })).rejects.toThrow(/Who the rations went to/);
    await expect(move({ movementType: "rations", rationsFor: "owner", movementDate: "2026-03-10", head: 1, amount: "1100.00", rationsRecipient: "Sam (shareholder)" })).rejects.toThrow(/legal entity/);
    const rations = await move({ movementType: "rations", rationsFor: "owner", movementDate: "2026-03-10", head: 1, amount: "1100.00", ...WHO });
    expect(rations).toMatchObject({ movementType: "rations", rationsFor: "owner", amount: "1100.00", rationsRecipient: "Sam (shareholder)", rationsEntity: "Made-up Farm Ltd", amountIncludesGst: false });
    // A GST-registered farm: not a verified nil, just not assessed yet (RAT10).
    expect(rations.gst).toMatchObject({ status: "unresolved", assessmentId: null, gstAmount: null });
    rat1 = rations.id;
    expect(rations.journalId).not.toBeNull();
    const journal = await run((tx) => getJournal(tx, rations.journalId!));
    expect(journal).toMatchObject({ origin: "livestock_rations", postingDate: "2026-03-10" });
    expect(await journalLines(rations.journalId!)).toEqual([
      ["3100", "1100.00", "0.00"],
      ["7070", "0.00", "1100.00"],
    ]);
    const accounts = await run((tx) => tx.query<{ code: string; name: string; account_type: string }>("select code, name, account_type from accounts where code = '7070'"));
    expect(accounts.rows[0]).toEqual({ code: "7070", name: "Livestock rations (private use)", account_type: "other_income" });
  });

  it("RAT2: staff rations post nothing and take no value", async () => {
    await expect(move({ movementType: "rations", rationsFor: "staff", movementDate: "2026-03-12", head: 2, amount: "500.00" })).rejects.toThrow(/Staff rations have no value/);
    const staff = await move({ movementType: "rations", rationsFor: "staff", movementDate: "2026-03-12", head: 2 });
    expect(staff).toMatchObject({ rationsFor: "staff", amount: null, journalId: null, gst: null });
    // Unchanged by the owner's GST workflow: staff rations need their own analysis.
    await expect(move({ movementType: "rations", rationsFor: "staff", movementDate: "2026-03-12", head: 1, gstAssessment: { outcome: "no_adjustment", basis: "x" } })).rejects.toThrow(/Staff rations need their own analysis/);
    await expect(run((tx) => assessMovementGst(tx, staff.id, { outcome: "no_adjustment", basis: "x" }))).rejects.toThrow(/Staff rations need their own analysis/);
    await expect(move({ movementType: "death", rationsFor: "staff", movementDate: "2026-03-12", head: 1 })).rejects.toThrow(/Only rations/);
  });

  it("RAT4: rations have their own head count column; the owner's rations are non-cash in the cash flow statement", async () => {
    const row = await cows();
    expect(row).toMatchObject({ opening: 300, rations: 3, died: 0, closing: 297 });
    const cf = await run((tx) => cashFlowStatement(tx, { from: "2025-06-01", to: "2026-05-31" }));
    expect(cf.operating.profit).toBe("1100.00");
    expect(cf.operating.adjustments.map((entry) => [entry.label, entry.amount])).toEqual([["Owner's rations (no cash)", "-1100.00"]]);
    expect([cf.operating.total, cf.financing.total, cf.netChange, cf.reconciles]).toEqual(["0.00", "0.00", "0.00", true]);
  });

  it("RAT3: voiding the owner's rations reverses the journal on the same date; can't go below zero", async () => {
    const rations = await move({ movementType: "rations", rationsFor: "owner", movementDate: "2026-04-01", head: 1, amount: "900.00", ...WHO });
    await run((tx) => voidMovement(tx, rations.id, { reason: "Entered twice" }));
    const reversal = await run((tx) =>
      tx.query<{ id: string; posting_date: string; correction_kind: string }>(
        "select id::text, posting_date::text, correction_kind from ledger_journals where related_journal_id = $1",
        [rations.journalId],
      ),
    );
    expect(reversal.rows).toHaveLength(1);
    expect(reversal.rows[0]).toMatchObject({ posting_date: "2026-04-01", correction_kind: "reversal" });
    expect(await journalLines(reversal.rows[0].id)).toEqual([
      ["3100", "0.00", "900.00"],
      ["7070", "900.00", "0.00"],
    ]);
    expect((await cows()).closing).toBe(297);
    await expect(move({ movementType: "rations", rationsFor: "staff", movementDate: "2026-04-02", head: 298 })).rejects.toThrow(/below zero/);
  });

  it("RAT5: a confirmed taxable supply at 1,100.00 excluding GST: Dr drawings 1,265.00, Cr rations income 1,100.00, Cr GST 165.00", async () => {
    await expect(run((tx) => assessMovementGst(tx, rat1, { outcome: "taxable_supply", basis: "Supplied to a shareholder" , gstAmount: "165" }))).rejects.toThrow(/don't type it/);
    const assessed = await run((tx) => assessMovementGst(tx, rat1, { outcome: "taxable_supply", basis: "Supplied to a shareholder (an associated person) who can't claim the GST" }));
    expect(assessed.gst).toMatchObject({ status: "taxable_supply", gstAmount: "165.00" });
    // The first journal is reversed and the whole posting made again on 10 Mar 2026.
    expect(await net(rat1)).toEqual({ "3100": "1265.00", "7070": "-1100.00", [gstCode]: "-165.00" });
    const current = await run((tx) => tx.query<{ id: string }>("select journal_id::text as id from livestock_rations_gst where movement_id = $1 and replaced_at is null", [rat1]));
    expect(await journalLines(current.rows[0].id)).toEqual([
      ["3100", "1265.00", "0.00"],
      ["7070", "0.00", "1100.00"],
      [gstCode, "0.00", "165.00"],
    ]);
    // In the GST return for its period, as a sale on its date: 1,265.00 in Box 5 and 165.00 of GST.
    const march = await gstReturn("2026-03-01", "2026-04-30");
    const line = march.lines.find((entry) => entry.documentType === "livestock_rations")!;
    expect(line).toMatchObject({ eventType: "rations_supply", eventDate: "2026-03-10", amount: "1265.00", gst: "165.00", boxes: ["5"], contactName: "Sam (shareholder)", documentNumber: `RATIONS-${rat1}` });
    expect(march.rations.unresolved.map((entry) => entry.movementId)).not.toContain(rat1);
    // Changing it needs a reason.
    await expect(run((tx) => assessMovementGst(tx, rat1, { outcome: "no_adjustment", basis: "x" }))).rejects.toThrow(/Say why/);
  });

  let rat6 = "";
  it("RAT6: 1,100.00 including GST, assessed as it's recorded: one journal, GST 143.48 and income 956.52", async () => {
    const rations = await move({ movementType: "rations", rationsFor: "owner", movementDate: "2026-04-05", head: 1, amount: "1100.00", amountIncludesGst: true, ...WHO, gstAssessment: { outcome: "taxable_supply", basis: "Supplied to a shareholder at market value" } });
    rat6 = rations.id;
    expect(rations.gst).toMatchObject({ status: "taxable_supply", gstAmount: "143.48" });
    expect(await journalLines(rations.journalId!)).toEqual([
      ["3100", "1100.00", "0.00"],
      ["7070", "0.00", "956.52"],
      [gstCode, "0.00", "143.48"],
    ]);
    const march = await gstReturn("2026-03-01", "2026-04-30");
    expect(march.lines.filter((entry) => entry.documentType === "livestock_rations").map((entry) => [entry.amount, entry.gst])).toEqual([["1265.00", "165.00"], ["1100.00", "143.48"]]);
  });

  let rat7 = "";
  it("RAT7: a change-in-use adjustment is a reviewed GST amount in Box 9, with its basis", async () => {
    const rations = await move({ movementType: "rations", rationsFor: "owner", movementDate: "2026-04-10", head: 1, amount: "800.00", ...WHO });
    rat7 = rations.id;
    await expect(run((tx) => assessMovementGst(tx, rat7, { outcome: "change_in_use", basis: "Reviewed" }))).rejects.toThrow(/reviewed GST adjustment/);
    const assessed = await run((tx) => assessMovementGst(tx, rat7, { outcome: "change_in_use", basis: "Reviewed by the accountant on cost, 15 Apr 2026", gstAmount: "120.00" }));
    expect(assessed.gst).toMatchObject({ status: "change_in_use", gstAmount: "120.00", basis: "Reviewed by the accountant on cost, 15 Apr 2026" });
    expect(await net(rat7)).toEqual({ "3100": "920.00", "7070": "-800.00", [gstCode]: "-120.00" });
    const march = await gstReturn("2026-03-01", "2026-04-30");
    expect(march.rationsAdjustments).toEqual([{ box: "9", description: `Livestock rations change in use: 1 mixed-age cows, 2026-04-10 (RATIONS-${rat7})`, amount: "120.00" }]);
    expect(march.adjustments).toEqual([]);
    expect(march.boxes).toMatchObject({ box5: "2365.00", box9: "120.00" });
    // No input GST is ever claimed for the owner's private use: no rations journal debits GST.
    const debits = await run((tx) =>
      tx.query("select 1 from ledger_journal_lines l join ledger_journals j on j.id = l.journal_id join accounts a on a.id = l.account_id where j.origin = 'livestock_rations' and a.code = $1 and l.debit_amount > 0 and j.correction_kind is distinct from 'reversal'", [gstCode]),
    );
    expect(debits.rows).toHaveLength(0);
  });

  it("RAT9: each event counts once; filing records what it took, and later changes are caught up in the next return, not the filed one", async () => {
    const filed = await run((tx) => fileGstReturn(tx, { idempotencyKey: key("gst"), periodStart: "2026-03-01", periodEnd: "2026-04-30" }));
    expect(filed.gstReturn.boxes).toMatchObject({ box5: "2365.00", box9: "120.00" });
    expect(filed.gstReturn.adjustments.map((entry) => [entry.box, entry.amount])).toEqual([["9", "120.00"]]);
    // The next return doesn't count them again.
    let may = await gstReturn("2026-05-01", "2026-06-30");
    expect(may.rationsAdjustments).toEqual([]);
    expect(may.lines.filter((entry) => entry.documentType === "livestock_rations")).toEqual([]);
    expect(may.lateClaims).toEqual([]);
    // RAT8: changing a filed adjustment needs a reason, posts again on its own date, and the next return takes it back off.
    await run((tx) => assessMovementGst(tx, rat7, { outcome: "no_adjustment", basis: "Accountant: no change-in-use adjustment applies", reason: "Reviewed again after filing" }));
    expect(await net(rat7)).toEqual({ "3100": "800.00", "7070": "-800.00", [gstCode]: "0.00" });
    may = await gstReturn("2026-05-01", "2026-06-30");
    expect(may.rationsAdjustments).toEqual([{ box: "9", description: `Taken back off (changed after filing): Livestock rations change in use: 1 mixed-age cows, 2026-04-10 (RATIONS-${rat7})`, amount: "-120.00" }]);
    // The filed return is as it was filed.
    expect((await run((tx) => getGstReturn(tx, filed.gstReturn.id))).boxes.box9).toBe("120.00");
    const history = await run((tx) => tx.query<{ outcome: string; replaced_reason: string | null }>("select outcome, replaced_reason from livestock_rations_gst where movement_id = $1 order by id", [rat7]));
    expect(history.rows).toEqual([{ outcome: "change_in_use", replaced_reason: "Reviewed again after filing" }, { outcome: "no_adjustment", replaced_reason: null }]);
    // Voiding a supply in the filed period: it's taken back off as a late claim in the next return.
    await run((tx) => voidMovement(tx, rat6, { reason: "Recorded twice" }));
    expect(await net(rat6)).toEqual({ "3100": "0.00", "7070": "0.00", [gstCode]: "0.00" });
    may = await gstReturn("2026-05-01", "2026-06-30");
    expect(may.lateClaims.map((claim) => [claim.documentNumber, claim.reversal, claim.gst])).toEqual([[`RATIONS-${rat6}`, true, "-143.48"]]);
  });

  it("RAT10: an unresolved event is listed for GST, never a nil; not registered on the date means no GST to assess", async () => {
    const pending = await move({ movementType: "rations", rationsFor: "owner", movementDate: "2026-05-02", head: 1, amount: "1000.00", ...WHO });
    const may = await gstReturn("2026-05-01", "2026-06-30");
    expect(may.rations.unresolved.map((entry) => [entry.movementId, entry.date, entry.value, entry.inPeriod])).toEqual([[pending.id, "2026-05-02", "1000.00", true]]);
    // Nothing counted for it: only the earlier voided supply, taken back off as a late claim.
    expect(may.lines.filter((entry) => entry.documentType === "livestock_rations").map((entry) => [entry.documentNumber, entry.amount, entry.lateFrom ? "late" : "own"])).toEqual([[`RATIONS-${rat6}`, "-1100.00", "late"]]);
    await run((tx) => tx.query("update organisation_settings set gst_registered_until = '2026-05-15' where id = true"));
    const after = await move({ movementType: "rations", rationsFor: "owner", movementDate: "2026-05-20", head: 1, amount: "1000.00", ...WHO });
    expect(after.gst?.status).toBe("not_registered");
    await expect(run((tx) => assessMovementGst(tx, after.id, { outcome: "no_adjustment", basis: "x" }))).rejects.toThrow(/wasn't GST-registered/);
    expect((await gstReturn("2026-05-01", "2026-06-30")).rations.unresolved.map((entry) => entry.movementId)).toEqual([pending.id]);
    await run((tx) => tx.query("update organisation_settings set gst_registered_until = null where id = true"));
  });
});
