import { afterAll, beforeAll, expect, it } from "vitest";
import * as adjustmentsRoute from "@/app/api/livestock/rations-adjustments/route";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { getJournal, postJournal } from "@/lib/ledger/journals";
import { headCount, recordMovement, setOpenings, updateLivestockSettings, voidMovement } from "@/lib/livestock/movements";
import { addRationsAdjustment, getRationsYear, voidRationsAdjustment } from "@/lib/livestock/rations-adjustments";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { calculateGstReturn, fileGstReturn } from "@/lib/reports/gst-return";
import { cashFlowStatement } from "@/lib/reports/statements";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "livestock-rations";
const YEAR = "2026-05-31";

/** Killed for rations (RAT1-RAT4, #259) and the yearly homekill adjustment (RAT5-RAT10; Jess, 20 October 2026, not yet reviewed). */
describeWithDatabase("livestock killed for rations", () => {
  let server: TestServer;
  let owner: SessionUser;
  let viewer: SessionUser;
  let gstCode = "";
  const run = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: owner.id, email: owner.email }, work);
  const move = (fields: Record<string, unknown>) =>
    run((tx) => recordMovement(tx, { idempotencyKey: key("lv"), kind: "dairy_cattle", classCode: "ma_cows", ...fields })).then((result) => result.movement);
  const cows = async () => (await run((tx) => headCount(tx, { yearEnd: YEAR }))).rows.find((row) => row.classCode === "ma_cows")!;
  const journalLines = async (id: string) => (await run((tx) => getJournal(tx, id))).lines.map((line) => [line.accountCode, line.debitAmount, line.creditAmount]);
  const adjust = (fields: Record<string, unknown>) => run((tx) => addRationsAdjustment(tx, { idempotencyKey: key("hk"), yearEnd: YEAR, ...fields } as Parameters<typeof addRationsAdjustment>[1])).then((result) => result.adjustment);
  const gstReturn = (periodStart: string, periodEnd: string) => run((tx) => calculateGstReturn(tx, { periodStart, periodEnd }));

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("rations-owner@example.com", { serverAdmin: true });
    viewer = await createTestUser("rations-viewer@example.com");
    await createTestOrganisation(owner, ORG);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'viewer')", [ORG, viewer.id]);
    await run((tx) => updateOrganisationSettings(tx, { financialYearEndMonth: 5 }));
    await run((tx) => updateLivestockSettings(tx, { enabled: true, firstYearStart: "2025-06-01" }));
    await run((tx) => setOpenings(tx, { lines: [{ kind: "dairy_cattle", classCode: "ma_cows", head: 300, value: "750000.00" }] }));
    gstCode = (await run((tx) => tx.query<{ code: string }>("select code from accounts where system_key = 'gst'"))).rows[0].code;
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("RAT1: homekill for the owner is a head count only; nothing is posted and no value is entered", async () => {
    await expect(move({ movementType: "rations", movementDate: "2026-03-10", head: 1 })).rejects.toThrow(/Whose rations/);
    await expect(move({ movementType: "rations", rationsFor: "owner", movementDate: "2026-03-10", head: 1, amount: "1100.00" })).rejects.toThrow(/one homekill adjustment for the year/);
    const rations = await move({ movementType: "rations", rationsFor: "owner", movementDate: "2026-03-10", head: 1 });
    expect(rations).toMatchObject({ movementType: "rations", rationsFor: "owner", amount: null, journalId: null });
  });

  it("RAT2: staff rations post nothing and take no value", async () => {
    await expect(move({ movementType: "rations", rationsFor: "staff", movementDate: "2026-03-12", head: 2, amount: "500.00" })).rejects.toThrow(/Staff rations have no value/);
    const staff = await move({ movementType: "rations", rationsFor: "staff", movementDate: "2026-03-12", head: 2 });
    expect(staff).toMatchObject({ rationsFor: "staff", amount: null, journalId: null });
    await expect(move({ movementType: "death", rationsFor: "staff", movementDate: "2026-03-12", head: 1 })).rejects.toThrow(/Only rations/);
  });

  it("RAT4: rations have their own head count column", async () => {
    expect(await cows()).toMatchObject({ opening: 300, rations: 3, died: 0, closing: 297 });
  });

  it("RAT3: voiding a homekill movement puts the cow back and posts nothing; can't go below zero", async () => {
    const rations = await move({ movementType: "rations", rationsFor: "owner", movementDate: "2026-04-01", head: 1 });
    const voided = await run((tx) => voidMovement(tx, rations.id, { reason: "Entered twice" }));
    expect(voided).toMatchObject({ voided: true, journalId: null });
    expect((await cows()).closing).toBe(297);
    await expect(move({ movementType: "rations", rationsFor: "staff", movementDate: "2026-04-02", head: 298 })).rejects.toThrow(/below zero/);
  });

  it("RAT5: one adjustment for the year, the accountant's amount: 500.00, Dr drawings, Cr rations income, on the balance date; non-cash", async () => {
    const year = await run((tx) => getRationsYear(tx, { yearEnd: YEAR }));
    // The year's homekill head count is shown beside it, for information only.
    expect(year).toMatchObject({ yearStart: "2025-06-01", yearEnd: YEAR, ownerHead: 1, staffHead: 2, postedPerEvent: "0.00", gstRegistered: true, current: null });
    await expect(adjust({ amount: "500.00", reason: "" })).rejects.toThrow(/basis/);
    await expect(adjust({ amount: "500.00", reason: "x", adjustmentDate: "2026-06-01" })).rejects.toThrow(/in the year/);
    await expect(adjust({ amount: "500.00", reason: "x", gstApplies: true })).rejects.toThrow(/includes GST/);
    const adjustment = await adjust({ amount: "500.00", reason: "Homekill for the house, as the accountant's estimate" });
    expect(adjustment).toMatchObject({ adjustmentDate: YEAR, amount: "500.00", gstApplies: false, gstAmount: "0.00" });
    expect(await journalLines(adjustment.journalId)).toEqual([
      ["3100", "500.00", "0.00"],
      ["7070", "0.00", "500.00"],
    ]);
    await expect(adjust({ amount: "600.00", reason: "Again" })).rejects.toThrow(/already a homekill adjustment/);
    const cf = await run((tx) => cashFlowStatement(tx, { from: "2025-06-01", to: YEAR }));
    expect(cf.operating.profit).toBe("500.00");
    expect(cf.operating.adjustments.map((entry) => [entry.label, entry.amount])).toEqual([["Owner's rations (no cash)", "-500.00"]]);
    expect(cf.reconciles).toBe(true);
    // Viewers can't enter or see it.
    const cookie = await sessionCookieFor(viewer);
    expect((await adjustmentsRoute.GET(apiRequest(`/api/livestock/rations-adjustments?organisationId=${ORG}&yearEnd=${YEAR}`, { cookie }), undefined as unknown)).status).toBe(403);
  });

  it("RAT8: a different amount means voiding the year's adjustment with a reason; it's reversed on its own date", async () => {
    const { current } = await run((tx) => getRationsYear(tx, { yearEnd: YEAR }));
    await expect(run((tx) => voidRationsAdjustment(tx, current!.id, { reason: "" }))).rejects.toThrow(/reason/);
    const voided = await run((tx) => voidRationsAdjustment(tx, current!.id, { reason: "Accountant revised it" }));
    expect(voided.voided?.reason).toBe("Accountant revised it");
    const reversal = await run((tx) => tx.query<{ id: string; posting_date: string }>("select id::text, posting_date::text from ledger_journals where related_journal_id = $1", [current!.journalId]));
    expect(reversal.rows[0].posting_date).toBe(YEAR);
    expect(await journalLines(reversal.rows[0].id)).toEqual([
      ["3100", "0.00", "500.00"],
      ["7070", "500.00", "0.00"],
    ]);
    expect((await run((tx) => getRationsYear(tx, { yearEnd: YEAR }))).voided).toHaveLength(1);
  });

  it("RAT6: with GST on 1,100.00 excluding GST: Dr drawings 1,265.00, Cr rations income 1,100.00, Cr GST 165.00, in that date's GST return", async () => {
    const adjustment = await adjust({ amount: "1100.00", reason: "Homekill for the year, GST as a supply to the shareholder", adjustmentDate: "2026-04-30", gstApplies: true, amountIncludesGst: false });
    expect(adjustment).toMatchObject({ netAmount: "1100.00", gstAmount: "165.00" });
    expect(await journalLines(adjustment.journalId)).toEqual([
      ["3100", "1265.00", "0.00"],
      ["7070", "0.00", "1100.00"],
      [gstCode, "0.00", "165.00"],
    ]);
    const march = await gstReturn("2026-03-01", "2026-04-30");
    expect(march.lines.filter((line) => line.documentType === "livestock_rations").map((line) => [line.eventType, line.eventDate, line.amount, line.gst, line.boxes, line.documentNumber])).toEqual([
      ["rations_adjustment", "2026-04-30", "1265.00", "165.00", ["5"], `HOMEKILL-${YEAR}`],
    ]);
    expect(march.boxes.box5).toBe("1265.00");
    // Filed, then voided: the filed return keeps it and the next return takes it back off as a late claim.
    await run((tx) => fileGstReturn(tx, { idempotencyKey: key("gst"), periodStart: "2026-03-01", periodEnd: "2026-04-30" }));
    await run((tx) => voidRationsAdjustment(tx, adjustment.id, { reason: "Should have included GST in the amount" }));
    const may = await gstReturn("2026-05-01", "2026-06-30");
    expect(may.lateClaims.map((claim) => [claim.documentNumber, claim.reversal, claim.amount, claim.gst])).toEqual([[`HOMEKILL-${YEAR}`, true, "-1265.00", "-165.00"]]);
  });

  it("RAT7: 1,100.00 including GST: GST 143.48 and income 956.52", async () => {
    const adjustment = await adjust({ amount: "1100.00", reason: "Homekill for the year, GST included", gstApplies: true, amountIncludesGst: true });
    expect(await journalLines(adjustment.journalId)).toEqual([
      ["3100", "1100.00", "0.00"],
      ["7070", "0.00", "956.52"],
      [gstCode, "0.00", "143.48"],
    ]);
    const may = await gstReturn("2026-05-01", "2026-06-30");
    expect(may.lines.filter((line) => line.documentType === "livestock_rations" && !line.lateFrom).map((line) => [line.eventDate, line.amount, line.gst])).toEqual([[YEAR, "1100.00", "143.48"]]);
  });

  it("RAT10: GST only applies on a GST-registered date", async () => {
    await run((tx) => tx.query("update organisation_settings set gst_registered_until = '2026-05-15' where id = true"));
    const next = { yearEnd: "2027-05-31", adjustmentDate: "2026-06-15" };
    expect((await run((tx) => getRationsYear(tx, { yearEnd: "2027-05-31" }))).gstRegistered).toBe(false);
    await expect(adjust({ ...next, amount: "500.00", reason: "x", gstApplies: true, amountIncludesGst: false })).rejects.toThrow(/wasn't GST-registered/);
    expect(await adjust({ ...next, amount: "500.00", reason: "Homekill, after deregistering" })).toMatchObject({ gstApplies: false, gstAmount: "0.00" });
    await run((tx) => tx.query("update organisation_settings set gst_registered_until = null where id = true"));
  });

  it("RAT9: rations journals posted per event before 20 Oct 2026 stay; they're shown beside the year so they aren't counted twice, and voiding still reverses them", async () => {
    const old = await move({ movementType: "rations", rationsFor: "owner", movementDate: "2026-02-01", head: 1 });
    // Made-up old data: what RAT1 used to post for each event.
    const posted = await run((tx) =>
      postJournal(tx, { idempotencyKey: key("old"), postingDate: "2026-02-01", reference: `RATIONS-${old.id}`, lines: [{ accountCode: "3100", debitAmount: "900.00" }, { accountCode: "7070", creditAmount: "900.00" }] }),
    );
    await run((tx) => tx.query("update livestock_movements set amount = 900.00, journal_id = $2 where id = $1", [old.id, posted.journal.id]));
    expect((await run((tx) => getRationsYear(tx, { yearEnd: YEAR }))).postedPerEvent).toBe("900.00");
    const voided = await run((tx) => voidMovement(tx, old.id, { reason: "Wrong cow" }));
    expect(voided.voided).toBe(true);
    const reversal = await run((tx) => tx.query<{ id: string }>("select id::text from ledger_journals where related_journal_id = $1 and correction_kind = 'reversal'", [posted.journal.id]));
    expect(await journalLines(reversal.rows[0].id)).toEqual([
      ["3100", "0.00", "900.00"],
      ["7070", "900.00", "0.00"],
    ]);
    expect((await run((tx) => getRationsYear(tx, { yearEnd: YEAR }))).postedPerEvent).toBe("0.00");
  });
});
