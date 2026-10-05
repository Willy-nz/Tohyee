import { afterAll, beforeAll, expect, it } from "vitest";
import * as ratesRoute from "@/app/api/mileage-rates/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { coreQuery } from "@/lib/db/transactions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { listMileageRates } from "@/lib/expense-claims/mileage";
import { saveMileageRates } from "@/lib/expense-claims/mileage-rates";
import {
  approveExpenseClaim,
  createExpenseClaim,
  type ExpenseClaim,
  getExpenseClaim,
  setMileageTier,
  submitExpenseClaim,
  updateExpenseClaim,
} from "@/lib/expense-claims/service";
import { getJournal } from "@/lib/ledger/journals";
import {
  apiRequest,
  createTestOrganisation,
  createTestUser,
  describeWithDatabase,
  inOrganisation,
  key,
  sessionCookieFor,
  startTestServer,
  type TestServer,
} from "../helpers/test-server";

const noContext = undefined as unknown;

/** A mileage line as typed (MI2). */
const trip = (fields: Record<string, unknown> = {}) => ({
  kind: "mileage",
  receiptDate: "2026-10-03",
  fromPlace: "Office",
  toPlace: "Kobe Ltd and back",
  description: "Client meeting",
  km: "123.4",
  vehicleType: "petrol",
  accountCode: "6120",
  ...fields,
});

const RATES_2025_26 = {
  petrol: { tier1Rate: "1.2", tier2Rate: "0.37" },
  diesel: { tier1Rate: "1.3", tier2Rate: "0.38" },
  petrol_hybrid: { tier1Rate: "0.9", tier2Rate: "0.24" },
  electric: { tier1Rate: "1.22", tier2Rate: "0.23" },
};

const mileageOf = (claim: ExpenseClaim) =>
  claim.receipts.map((line) => [line.kind, line.amount, line.taxAmount, line.mileage?.tier1Km, line.mileage?.tier2Km, line.mileage?.rateYearEnding, line.mileage?.rateNote]);

/**
 * Examples MI1-MI7 in docs/ACCOUNTING-EXAMPLES.md ("Mileage on expense
 * claims"). Each test gets its own organisation, which starts with IRD's
 * 2025-26 rates and none for 2026-27. Mere is a bookkeeper; Jess (the owner)
 * approves.
 */
describeWithDatabase("mileage on expense claims (MI1-MI7)", () => {
  let server: TestServer;
  let jess: SessionUser;
  let mere: SessionUser;
  let viewer: SessionUser;
  let organisations = 0;

  beforeAll(async () => {
    server = await startTestServer();
    jess = await createTestUser("mi-jess@example.com", { serverAdmin: true, displayName: "Jess" });
    mere = await createTestUser("mi-mere@example.com", { displayName: "Mere" });
    viewer = await createTestUser("mi-viewer@example.com");
  });

  afterAll(async () => {
    await server?.teardown();
  });

  async function setup() {
    organisations += 1;
    const org = `mi-${organisations}-co`;
    await createTestOrganisation(jess, org);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'bookkeeper'), ($1, $3, 'viewer')", [org, mere.id, viewer.id]);
    const asUser = (user: SessionUser) => <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: user.id, email: user.email }, work);
    const as = asUser(jess);
    const asMere = asUser(mere);
    const draft = async (receipts: unknown[]) => (await asMere((tx) => createExpenseClaim(tx, { idempotencyKey: key("claim"), receipts }))).claim;
    const submitted = async (receipts: unknown[]) => asMere(async (tx) => submitExpenseClaim(tx, (await createExpenseClaim(tx, { idempotencyKey: key("claim"), receipts })).claim.id));
    const approve = async (id: string, claimDate = "2026-10-05") =>
      (await as((tx) => approveExpenseClaim(tx, "owner", id, { idempotencyKey: key("approve"), claimDate }))).claim;
    return { org, as, asMere, draft, submitted, approve };
  }

  it("MI1: admins see the 2025-26 rates, add a year's rates, and can't change a year an approved claim used", async () => {
    const w = await setup();
    const rates = await w.asMere((tx) => listMileageRates(tx));
    expect(rates.map((rate) => [rate.yearLabel, rate.vehicleType, rate.tier1Rate, rate.tier2Rate, rate.used])).toEqual([
      ["2025-26", "petrol", "1.2", "0.37", false],
      ["2025-26", "diesel", "1.3", "0.38", false],
      ["2025-26", "petrol_hybrid", "0.9", "0.24", false],
      ["2025-26", "electric", "1.22", "0.23", false],
    ]);
    // Only admins enter rates; every vehicle type at once.
    await expect(w.asMere((tx) => saveMileageRates(tx, "bookkeeper", { yearEnding: 2027, rates: RATES_2025_26 }))).rejects.toThrow("Only admins");
    await expect(w.as((tx) => saveMileageRates(tx, "owner", { yearEnding: 2027, rates: { petrol: RATES_2025_26.petrol } }))).rejects.toThrow("Diesel 2026-27 tier 1 rate");
    await expect(w.as((tx) => saveMileageRates(tx, "owner", { yearEnding: 2027, rates: { ...RATES_2025_26, petrol: { tier1Rate: "1.23456", tier2Rate: "0.4" } } }))).rejects.toThrow(
      "at most 4 decimal places",
    );
    const response = await ratesRoute.PUT(
      apiRequest("/api/mileage-rates", { method: "PUT", cookie: await sessionCookieFor(mere), body: { organisationId: w.org, yearEnding: 2027, rates: RATES_2025_26 } }),
      noContext,
    );
    expect(response.status).toBe(403);
    const listed = await ratesRoute.GET(apiRequest(`/api/mileage-rates?organisationId=${w.org}`, { cookie: await sessionCookieFor(viewer) }), noContext);
    expect(((await listed.json()) as { rates: unknown[] }).rates).toHaveLength(4);

    // A claim approved at the 2025-26 rates fixes them.
    const claim = await w.submitted([trip({ km: "10" })]);
    await w.approve(claim.id);
    expect((await w.as((tx) => listMileageRates(tx))).every((rate) => rate.used)).toBe(true);
    await expect(w.as((tx) => saveMileageRates(tx, "owner", { yearEnding: 2026, rates: { ...RATES_2025_26, petrol: { tier1Rate: "1.25", tier2Rate: "0.37" } } }))).rejects.toThrow(
      "2025-26 rates were used by an approved expense claim",
    );
    // Saving the same rates again changes nothing.
    expect((await w.as((tx) => saveMileageRates(tx, "owner", { yearEnding: 2026, rates: RATES_2025_26 }))).draftsRecalculated).toBe(0);
  });

  it("MI2: 123.4 km by petrol on 3 Oct 2026 uses the 2025-26 rate, 148.08, and says so; no GST", async () => {
    const w = await setup();
    const claim = await w.draft([trip()]);
    expect(mileageOf(claim)).toEqual([["mileage", "148.08", "0.00", "123.4", "0", 2026, "2025-26 rates (2026-27 not entered)"]]);
    const line = claim.receipts[0];
    expect([line.supplierName, line.description, line.taxCode, line.accountCode, line.mileage?.fromPlace, line.mileage?.toPlace, line.mileage?.km]).toEqual([
      "Mileage",
      "Client meeting",
      null,
      "6120",
      "Office",
      "Kobe Ltd and back",
      "123.4",
    ]);
    expect([claim.total, claim.taxTotal]).toEqual(["148.08", "0.00"]);
    // A tax code or typed amount on a mileage line is ignored: it's kilometres times the rate, no GST.
    const typed = await w.draft([{ ...trip(), taxCode: "GST", amount: "999.00" }]);
    expect([typed.total, typed.taxTotal]).toEqual(["148.08", "0.00"]);
    // A receipt and a mileage line on one claim.
    const both = await w.draft([
      { receiptDate: "2026-10-03", supplierName: "Wilson Parking", description: "Parking", accountCode: "6120", taxCode: "GST", amount: "11.50" },
      trip(),
    ]);
    expect([both.total, both.taxTotal]).toEqual(["159.58", "1.50"]);
  });

  it("MI3: past 14,000 km of Mere's petrol mileage in the year, the rest is at tier 2: 50 x 1.20 + 70 x 0.37 = 85.90; an admin can choose the tier", async () => {
    const w = await setup();
    // 13,950 km already claimed in 2026-27 (submitted claims count; drafts don't).
    const months = ["2026-04-10", "2026-05-10", "2026-06-10", "2026-07-10", "2026-08-10", "2026-09-10"];
    await w.submitted([...months.map((date) => trip({ receiptDate: date, km: "2000" })), trip({ receiptDate: "2026-09-20", km: "1950" })]);
    await w.draft([trip({ km: "500" })]);
    // Last year's kilometres don't count towards this year.
    await w.submitted([trip({ receiptDate: "2026-03-30", km: "2000" })]);
    const claim = await w.draft([trip({ km: "120" })]);
    expect(mileageOf(claim)).toEqual([["mileage", "85.90", "0.00", "50", "70", 2026, "2025-26 rates (2026-27 not entered)"]]);
    // Another vehicle type has its own 14,000 km.
    expect(mileageOf(await w.draft([trip({ km: "120", vehicleType: "diesel" })]))[0].slice(0, 5)).toEqual(["mileage", "156.00", "0.00", "120", "0"]);

    // An admin can put the whole line on tier 1 or tier 2 (question 3); not a bookkeeper.
    await expect(w.asMere((tx) => setMileageTier(tx, "bookkeeper", claim.id, { lineOrder: 1, tier: "tier1" }))).rejects.toThrow("Only admins");
    const tier1 = await w.as((tx) => setMileageTier(tx, "owner", claim.id, { lineOrder: 1, tier: "tier1" }));
    expect([tier1.total, tier1.receipts[0].mileage?.tierOverride, tier1.receipts[0].mileage?.tier1Km]).toEqual(["144.00", "tier1", "120"]);
    // It stays when Mere saves the same line again, and goes when she changes the kilometres.
    const resaved = await w.asMere((tx) => updateExpenseClaim(tx, claim.id, { description: "Kobe visit", receipts: [trip({ km: "120" })] }));
    expect([resaved.total, resaved.receipts[0].mileage?.tierOverride]).toEqual(["144.00", "tier1"]);
    const changed = await w.asMere((tx) => updateExpenseClaim(tx, claim.id, { receipts: [trip({ km: "121" })] }));
    expect([changed.total, changed.receipts[0].mileage?.tierOverride]).toEqual(["86.27", null]);
    const tier2 = await w.as((tx) => setMileageTier(tx, "owner", claim.id, { lineOrder: 1, tier: "tier2" }));
    expect(tier2.total).toBe("44.77");
    expect((await w.as((tx) => setMileageTier(tx, "owner", claim.id, { lineOrder: 1, tier: null }))).total).toBe("86.27");
    // Only on a draft: a submitted claim keeps what was sent.
    const sent = await w.asMere((tx) => submitExpenseClaim(tx, claim.id));
    await expect(w.as((tx) => setMileageTier(tx, "owner", sent.id, { lineOrder: 1, tier: "tier1" }))).rejects.toThrow("only be chosen while the claim is a draft");
  });

  it("MI4: 80 km in an electric car is 80 x 1.22 = 97.60", async () => {
    const w = await setup();
    const claim = await w.draft([trip({ km: "80", vehicleType: "electric" })]);
    expect(mileageOf(claim)).toEqual([["mileage", "97.60", "0.00", "80", "0", 2026, "2025-26 rates (2026-27 not entered)"]]);
    expect((await w.draft([trip({ km: "80", vehicleType: "petrol_hybrid" })])).total).toBe("72.00");
  });

  it("MI5: approving posts the mileage like a receipt: Dr 6120 148.08 / Cr expense claims payable, no GST", async () => {
    const w = await setup();
    const claim = await w.submitted([trip()]);
    expect(claim.total).toBe("148.08");
    const approved = await w.approve(claim.id);
    const journal = await w.as((tx) => getJournal(tx, approved.approvalJournalId!));
    expect(journal.lines.map((line) => [line.accountCode, line.debitAmount, line.creditAmount])).toEqual([
      ["6120", "148.08", "0.00"],
      ["2010", "0.00", "148.08"],
    ]);
    expect(approved.receipts[0].mileage?.rateYearEnding).toBe(2026);
  });

  it("MI6: entering 2026-27 rates later works drafts out again; approved and submitted claims keep their rate", async () => {
    const w = await setup();
    const approved = await w.approve((await w.submitted([trip({ km: "100" })])).id);
    const submitted = await w.submitted([trip({ km: "100", receiptDate: "2026-10-04" })]);
    const draft = await w.draft([trip({ km: "100", receiptDate: "2026-10-05" })]);
    expect([approved.total, submitted.total, draft.total]).toEqual(["120.00", "120.00", "120.00"]);
    // Rates made up for this test: IRD hasn't published 2026-27's.
    const saved = await w.as((tx) =>
      saveMileageRates(tx, "owner", { yearEnding: 2027, rates: { ...RATES_2025_26, petrol: { tier1Rate: "1.25", tier2Rate: "0.38" } } }),
    );
    expect(saved.draftsRecalculated).toBe(1);
    expect(saved.rates.slice(0, 1).map((rate) => [rate.yearLabel, rate.tier1Rate, rate.used])).toEqual([["2026-27", "1.25", false]]);
    const after = async (claim: ExpenseClaim) => w.as((tx) => getExpenseClaim(tx, claim.id));
    expect(mileageOf(await after(approved))).toEqual([["mileage", "120.00", "0.00", "100", "0", 2026, "2025-26 rates (2026-27 not entered)"]]);
    expect(mileageOf(await after(submitted))).toEqual([["mileage", "120.00", "0.00", "100", "0", 2026, "2025-26 rates (2026-27 not entered)"]]);
    expect(mileageOf(await after(draft))).toEqual([["mileage", "125.00", "0.00", "100", "0", 2027, null]]);
    // The submitted claim is approved at the amount it was sent with.
    expect((await w.approve(submitted.id)).total).toBe("120.00");
    // 2026-27's rates aren't used by an approved claim yet, so they can still be corrected.
    await w.as((tx) => saveMileageRates(tx, "owner", { yearEnding: 2027, rates: { ...RATES_2025_26, petrol: { tier1Rate: "1.24", tier2Rate: "0.38" } } }));
    expect((await after(draft)).total).toBe("124.00");
    const history = await w.as((tx) => tx.query<{ event_type: string }>("select event_type from audit_events where entity_type = 'expense_claim' and entity_id = $1 order by id", [draft.id]));
    expect(history.rows.map((row) => row.event_type)).toEqual(["expense_claim.created", "expense_claim.mileage_recalculated", "expense_claim.mileage_recalculated"]);
  });

  it("MI7: kilometres of 0, negative, more than 2,000 or with two decimal places are refused", async () => {
    const w = await setup();
    await expect(w.draft([trip({ km: "0" })])).rejects.toThrow("kilometres must be more than 0");
    await expect(w.draft([trip({ km: "-5" })])).rejects.toThrow("kilometres must be more than 0");
    await expect(w.draft([trip({ km: "2000.1" })])).rejects.toThrow("Split long trips into days");
    await expect(w.draft([trip({ km: "12.34" })])).rejects.toThrow("at most 1 decimal place");
    await expect(w.draft([trip({ vehicleType: "lpg" })])).rejects.toThrow("vehicle type must be");
    await expect(w.draft([trip({ fromPlace: "" })])).rejects.toThrow("from is required");
    expect((await w.draft([trip({ km: "2000" })])).total).toBe("2400.00");
  });
});
