import { afterAll, beforeAll, expect, it } from "vitest";
import * as incomeTaxRoute from "@/app/api/income-tax/route";
import * as treatmentsRoute from "@/app/api/income-tax/treatments/route";
import { createAccount } from "@/lib/accounts/service";
import type { SessionUser } from "@/lib/auth/sessions";
import { listBudgets, setBudgetAmounts } from "@/lib/budgets/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { postJournal } from "@/lib/ledger/journals";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import {
  addAdjustment,
  addPayment,
  buildIncomeTax,
  getIncomeTaxSettings,
  getIncomeTaxYear,
  removePayment,
  saveIncomeTaxYear,
  setAccountTreatment,
  updateIncomeTaxSettings,
} from "@/lib/tax/income/service";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

const noContext = undefined as unknown;

/** Income tax stage 1 (ITX1-ITX10; from IRD's published rules, not yet reviewed). */
describeWithDatabase("income tax: taxable income, provisional and end-of-year tax", () => {
  let server: TestServer;
  let owner: SessionUser;
  let bookkeeper: SessionUser;
  const org = "kereru-joinery";
  const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: owner.id, email: owner.email }, work);
  const accountId = async (code: string) => (await as((tx) => tx.query<{ id: string }>("select id::text from accounts where code = $1", [code]))).rows[0].id;
  const journal = (date: string, lines: Array<{ accountCode: string; debitAmount?: string; creditAmount?: string }>) =>
    as((tx) => postJournal(tx, { idempotencyKey: key("j"), postingDate: date, reference: "Test", lines }));

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("tax-owner@example.com", { serverAdmin: true });
    bookkeeper = await createTestUser("tax-bookkeeper@example.com");
    await createTestOrganisation(owner, org);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'bookkeeper')", [org, bookkeeper.id]);
    for (const [code, name] of [
      ["6901", "Wages"],
      ["6902", "Entertainment"],
      ["6903", "Fines"],
      ["6904", "Motor vehicle"],
      ["6905", "Purchases"],
    ]) {
      await as((tx) => createAccount(tx, { code, name, accountType: "expense" }));
    }
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("ITX1 says what it needs before it works anything out", async () => {
    const report = await as((tx) => buildIncomeTax(tx, { incomeYear: 2026, today: "2026-10-16" }));
    expect(report.supported).toBe(false);
    if (!report.supported) expect(report.reason).toContain("company or an individual");
    const settings = await as((tx) => getIncomeTaxSettings(tx));
    await as((tx) => updateIncomeTaxSettings(tx, { taxpayerType: "company", agentExtension: false, version: settings.version }));
    await expect(as((tx) => updateIncomeTaxSettings(tx, { taxpayerType: "company", agentExtension: true, version: settings.version }))).rejects.toThrow("Someone else changed");
  });

  it("ITX2 treatments suit the account, and 7040 starts as not taxable", async () => {
    await expect(as(async (tx) => setAccountTreatment(tx, { accountId: await accountId("6903"), treatment: "not_taxable" }))).rejects.toThrow("expense account");
    await expect(as(async (tx) => setAccountTreatment(tx, { accountId: await accountId("4000"), treatment: "not_deductible" }))).rejects.toThrow("income account");
    await expect(as(async (tx) => setAccountTreatment(tx, { accountId: await accountId("1000"), treatment: "full" }))).rejects.toThrow("isn't an income or expense account");
    await expect(as(async (tx) => setAccountTreatment(tx, { accountId: await accountId("6904"), treatment: "business_use", businessUsePercent: "100" }))).rejects.toThrow("under 100");
    await as(async (tx) => setAccountTreatment(tx, { accountId: await accountId("6902"), treatment: "entertainment_50" }));
    await as(async (tx) => setAccountTreatment(tx, { accountId: await accountId("6903"), treatment: "not_deductible" }));
    const vehicle = await as(async (tx) => setAccountTreatment(tx, { accountId: await accountId("6904"), treatment: "business_use", businessUsePercent: "80" }));
    expect(vehicle).toMatchObject({ treatment: "business_use", businessUsePercent: "80", isSet: true });
    const cookie = await sessionCookieFor(owner);
    const response = await treatmentsRoute.GET(apiRequest(`/api/income-tax/treatments?organisationId=${encodeURIComponent(org)}`, { cookie }), noContext);
    const { treatments } = (await response.json()) as { treatments: Array<{ code: string; treatment: string; isSet: boolean }> };
    expect(treatments.find((entry) => entry.code === "7040")).toMatchObject({ treatment: "not_taxable", isSet: false });
    expect(treatments.find((entry) => entry.code === "1000")).toBeUndefined();
    const audit = await as((tx) => tx.query<{ n: string }>("select count(*)::text as n from audit_events where event_type = 'income_tax.treatment_set'"));
    expect(audit.rows[0].n).toBe("3");
  });

  it("ITX3 a company's taxable income, tax and RIT for the 2026 income year", async () => {
    await journal("2026-03-31", [
      { accountCode: "1000", debitAmount: "69250.00" },
      { accountCode: "6905", debitAmount: "180000.00" },
      { accountCode: "6901", debitAmount: "150000.00" },
      { accountCode: "6902", debitAmount: "2400.00" },
      { accountCode: "6903", debitAmount: "350.00" },
      { accountCode: "6904", debitAmount: "9000.00" },
      { accountCode: "6300", debitAmount: "12000.00" },
      { accountCode: "6070", debitAmount: "60000.00" },
      { accountCode: "4000", creditAmount: "480000.00" },
      { accountCode: "7040", creditAmount: "3000.00" },
    ]);
    const created = await as((tx) => addAdjustment(tx, { idempotencyKey: "adj-holiday-pay", incomeYear: 2026, description: "Holiday pay accrued but not paid within 63 days", amount: "4000" }));
    const again = await as((tx) => addAdjustment(tx, { idempotencyKey: "adj-holiday-pay", incomeYear: 2026, description: "Holiday pay accrued but not paid within 63 days", amount: "4000" }));
    expect([created.created, again.created, again.adjustment.id]).toEqual([true, false, created.adjustment.id]);
    await expect(as((tx) => saveIncomeTaxYear(tx, { incomeYear: 2026, assessedRit: "17668", version: 0 }))).rejects.toThrow("or neither");
    await as((tx) => saveIncomeTaxYear(tx, { incomeYear: 2026, lossesBroughtForward: "10000", taxCredits: "140", version: 0 }));

    const report = await as((tx) => buildIncomeTax(tx, { incomeYear: 2026, today: "2026-10-16" }));
    expect(report.supported).toBe(true);
    if (!report.supported) return;
    expect(report.actualsTo).toBe("2026-03-31");
    expect(report.budgetFrom).toBeNull();
    expect(report.workpaper).toMatchObject({
      netProfit: "69250.00",
      beforeLosses: "73600.00",
      lossesUsed: "10000.00",
      taxableIncome: "63600.00",
      tax: "17808.00",
      taxCredits: "140.00",
      rit: "17668.00",
    });
    expect(report.workpaper.adjustments.map((entry) => entry.amount)).toEqual(["1200.00", "350.00", "1800.00", "-3000.00", "4000.00"]);
    expect(report.notes.join(" ")).toContain("shareholding");
    expect(report.notes.join(" ")).toContain("outside the fixed asset register");
    expect(report.reviewNote).toContain("haven't been reviewed");
    // ITX50: the company gets the IR4's tax calculation, not the IR3's.
    expect(report.ir4).toMatchObject({ residual: "debit", outcome: "tax_to_pay" });
    expect(report.ir4!.boxes["30J"]).toBe("17668.00");
    expect(report.ir3).toBeNull();
    // ITX62: next year's provisional tax on the standard option: 17,668.00 + 5%.
    expect(report.ir4!.nextYear).toEqual({ incomeYear: 2027, option: "S", amount: "18551.00" });
    // ITX54: as a sole trader, the IR3's worksheet instead, on individual rates.
    const settings = await as((tx) => getIncomeTaxSettings(tx));
    await as((tx) => updateIncomeTaxSettings(tx, { taxpayerType: "individual", agentExtension: settings.agentExtension, version: settings.version }));
    const asIndividual = await as((tx) => buildIncomeTax(tx, { incomeYear: 2026, today: "2026-10-16" }));
    if (!asIndividual.supported) throw new Error("expected a report");
    expect(asIndividual.ir4).toBeNull();
    expect([asIndividual.ir3!.boxes["32"], asIndividual.ir3!.boxes.W2, asIndividual.ir3!.boxes.W14]).toEqual(["63600.00", asIndividual.workpaper.tax, asIndividual.workpaper.rit]);
    // ITX65: an individual can type excess imputation credits brought forward; ITX64: next year's provisional tax.
    const typedYear = await as((tx) => getIncomeTaxYear(tx, 2026));
    const withForward = await as((tx) => saveIncomeTaxYear(tx, { incomeYear: 2026, lossesBroughtForward: "10000", taxCredits: "140", imputationBroughtForward: "100", version: typedYear.version }));
    const forward = await as((tx) => buildIncomeTax(tx, { incomeYear: 2026, today: "2026-10-16" }));
    if (!forward.supported) throw new Error("expected a report");
    expect([forward.ir3!.boxes.W8, forward.lastYearExcessImputation]).toEqual(["100.00", null]);
    expect(forward.ir3!.nextYear).toEqual({ incomeYear: 2027, option: "S", amount: "11613.00" });
    expect(forward.workpaper.rit).toBe("11060.50");
    await as((tx) => saveIncomeTaxYear(tx, { incomeYear: 2026, lossesBroughtForward: "10000", taxCredits: "140", imputationBroughtForward: "0", version: withForward.version }));
    const back = await as((tx) => getIncomeTaxSettings(tx));
    await as((tx) => updateIncomeTaxSettings(tx, { taxpayerType: "company", agentExtension: back.agentExtension, version: back.version }));

    // ITX58: imputation credits typed apart come off before the other credits; left out of a save, they're kept.
    const year = (await as((tx) => buildIncomeTax(tx, { incomeYear: 2026, today: "2026-10-16" }))) as Extract<Awaited<ReturnType<typeof buildIncomeTax>>, { supported: true }>;
    const saved = await as((tx) => saveIncomeTaxYear(tx, { incomeYear: 2026, lossesBroughtForward: "10000", taxCredits: "140", imputationCredits: "1000", overseasTaxPaid: "0", version: year.typed.version }));
    const kept = await as((tx) => saveIncomeTaxYear(tx, { incomeYear: 2026, lossesBroughtForward: "10000", taxCredits: "140", version: saved.version }));
    expect([kept.imputationCredits, kept.overseasTaxPaid]).toEqual(["1000.00", "0.00"]);
    const withImputation = await as((tx) => buildIncomeTax(tx, { incomeYear: 2026, today: "2026-10-16" }));
    if (!withImputation.supported) throw new Error("expected a report");
    expect([withImputation.workpaper.rit, withImputation.ir4!.boxes["30G"], withImputation.ir4!.boxes["30J"]]).toEqual(["16668.00", "1000.00", "16668.00"]);
    expect(withImputation.notes.join(" ")).toContain("imputation credit account has 0.00");
    await expect(as((tx) => saveIncomeTaxYear(tx, { incomeYear: 2026, imputationBroughtForward: "100", version: kept.version }))).rejects.toThrow("A company doesn't bring excess imputation credits forward");
    await as((tx) => saveIncomeTaxYear(tx, { incomeYear: 2026, lossesBroughtForward: "10000", taxCredits: "140", imputationCredits: "0", version: kept.version }));
  });

  it("ITX5, ITX9, ITX10 the 2027 forecast, standard instalments and end-of-year tax", async () => {
    // IRD's assessment of 2026, typed in; versions guard against two people saving at once.
    await expect(as((tx) => saveIncomeTaxYear(tx, { incomeYear: 2026, assessedRit: "17668", returnFiledOn: "2026-06-20", lossesBroughtForward: "10000", taxCredits: "140", version: 0 }))).rejects.toThrow("Someone else changed");
    const current = await as((tx) => getIncomeTaxYear(tx, 2026));
    await as((tx) => saveIncomeTaxYear(tx, { incomeYear: 2026, assessedRit: "17668", returnFiledOn: "2026-06-20", lossesBroughtForward: "10000", taxCredits: "140", version: current.version }));
    // Actuals to 30 Sep 2026: profit 50,000 with entertainment 1,000.
    await journal("2026-09-30", [
      { accountCode: "1000", debitAmount: "50000.00" },
      { accountCode: "6070", debitAmount: "199000.00" },
      { accountCode: "6902", debitAmount: "1000.00" },
      { accountCode: "4000", creditAmount: "250000.00" },
    ]);
    // The overall budget for Oct 2026 to Mar 2027: profit 70,000 with entertainment 1,200; September's budget is ignored (actuals).
    const overall = (await as((tx) => listBudgets(tx))).find((budget) => budget.isOverall)!;
    await as((tx) =>
      setBudgetAmounts(tx, overall.id, {
        version: overall.version,
        amounts: [
          { accountCode: "4000", month: "2026-09", amount: "99999" },
          { accountCode: "4000", month: "2026-10", amount: "130000" },
          { accountCode: "4000", month: "2027-03", amount: "130000" },
          { accountCode: "6070", month: "2026-12", amount: "188800" },
          { accountCode: "6902", month: "2027-02", amount: "1200" },
        ],
      }),
    );
    const report = await as((tx) => buildIncomeTax(tx, { incomeYear: 2027, today: "2026-10-16" }));
    expect(report.supported).toBe(true);
    if (!report.supported) return;
    expect([report.actualsTo, report.budgetFrom]).toEqual(["2026-09-30", "2026-10-01"]);
    expect(report.workpaper).toMatchObject({ netProfit: "120000.00", taxableIncome: "121100.00", tax: "33908.00", rit: "33908.00" });
    expect(report.accounts.find((entry) => entry.code === "6902")).toMatchObject({ actual: "1000.00", budget: "1200.00", total: "2200.00", adjustment: "1100.00" });
    expect(report.lastYear).toEqual({ incomeYear: 2026, rit: "17668.00", typed: true, filedOn: "2026-06-20" });
    expect(report.provisional.kind === "schedule" && report.provisional.instalments.map((entry) => [entry.dueDate, entry.amount])).toEqual([
      ["2026-08-28", "6183.80"],
      ["2027-01-15", "6183.80"],
      ["2027-05-07", "6183.80"],
    ]);
    expect(report.endOfYear).toMatchObject({ rit: "33908.00", provisional: "18551.40", amount: "15356.60", dueDate: "2028-02-07" });
    // ITX45, ITX47: RIT under 60,000.00, so no interest unless the end-of-year tax is late.
    expect(report.interest).toMatchObject({ rit: "33908.00", ritTyped: false, soFar: { amount: "0.00" }, ifPaidOnTime: "0.00" });
    expect(report.dueDates.map((entry) => [entry.label, entry.dueDate, entry.onTimeBy.date, entry.amount])).toEqual([
      ["Provisional tax instalment 1 for the 2027 income year", "2026-08-28", "2026-08-28", "6183.80"],
      ["Provisional tax instalment 2 for the 2027 income year", "2027-01-15", "2027-01-15", "6183.80"],
      ["End-of-year tax for the 2026 income year", "2027-02-07", "2027-02-09", "17668.00"],
      ["Provisional tax instalment 3 for the 2027 income year", "2027-05-07", "2027-05-07", "6183.80"],
      ["End-of-year tax for the 2027 income year", "2028-02-07", "2028-02-07", "15356.60"],
    ]);
    expect(report.notes.join(" ")).toContain("budget, not actuals");
    expect(report.notes.join(" ")).toContain("only from the day after the end-of-year tax date");

    // Payments typed towards a year reduce what's left; removing one is in the history.
    const paid = await as((tx) => addPayment(tx, { idempotencyKey: key("pay"), incomeYear: 2026, paidOn: "2027-02-08", amount: "17668.00" }));
    const after = await as((tx) => buildIncomeTax(tx, { incomeYear: 2027, today: "2026-10-16" }));
    expect(after.supported && after.dueDates.find((entry) => entry.key === "end-2026")?.amount).toBe("0.00");
    await as((tx) => removePayment(tx, paid.payment.id));
    const audit = await as((tx) => tx.query<{ event_type: string }>("select event_type from audit_events where entity_type = 'income_tax_payment' order by id"));
    expect(audit.rows.map((row) => row.event_type)).toEqual(["income_tax.payment_added", "income_tax.payment_removed"]);

    // A tax agent's extension of time moves end-of-year tax to 7 April.
    const settings = await as((tx) => getIncomeTaxSettings(tx));
    await as((tx) => updateIncomeTaxSettings(tx, { taxpayerType: "company", agentExtension: true, version: settings.version }));
    const extended = await as((tx) => buildIncomeTax(tx, { incomeYear: 2027, today: "2026-10-16" }));
    expect(extended.supported && extended.endOfYear.dueDate).toBe("2028-04-07");
  });

  it("ITX7 six-monthly GST filers get two instalments", async () => {
    await as((tx) => updateOrganisationSettings(tx, { gstPeriodMonths: 6, gstPeriodEndMonth: 3 }));
    const report = await as((tx) => buildIncomeTax(tx, { incomeYear: 2027, today: "2026-10-16" }));
    expect(report.supported && report.provisional.kind === "schedule" && report.provisional.instalments.map((entry) => [entry.dueDate, entry.amount])).toEqual([
      ["2026-10-28", "9275.70"],
      ["2027-05-07", "9275.70"],
    ]);
    await as((tx) => updateOrganisationSettings(tx, { gstPeriodMonths: 2, gstPeriodEndMonth: 3 }));
  });

  it("only owners and admins see income tax, through the API", async () => {
    const bookkeeperCookie = await sessionCookieFor(bookkeeper);
    const refused = await incomeTaxRoute.GET(apiRequest(`/api/income-tax?organisationId=${encodeURIComponent(org)}&incomeYear=2027`, { cookie: bookkeeperCookie }), noContext);
    expect(refused.status).toBe(403);
    const cookie = await sessionCookieFor(owner);
    const allowed = await incomeTaxRoute.GET(apiRequest(`/api/income-tax?organisationId=${encodeURIComponent(org)}&incomeYear=2027`, { cookie }), noContext);
    expect(allowed.status).toBe(200);
    const bad = await incomeTaxRoute.GET(apiRequest(`/api/income-tax?organisationId=${encodeURIComponent(org)}&incomeYear=2024`, { cookie }), noContext);
    expect(bad.status).toBe(400);
  });

  it("ITX41-ITX43 a 30 June balance date: its own income year, instalment dates and end-of-year date", async () => {
    await as((tx) => updateOrganisationSettings(tx, { financialYearEndMonth: 6 }));
    const report = await as((tx) => buildIncomeTax(tx, { incomeYear: 2027, today: "2026-10-16" }));
    expect(report.supported).toBe(true);
    if (!report.supported) return;
    expect([report.start, report.end, report.endMonth]).toEqual(["2026-07-01", "2027-06-30", 6]);
    expect(report.label).toBe("2027 income year (1 Jul 2026 to 30 Jun 2027)");
    expect(report.provisional.kind === "schedule" && report.provisional.instalments.map((entry) => entry.dueDate)).toEqual(["2026-11-28", "2027-03-28", "2027-07-28"]);
    // The 2027 year ends 30 Jun 2027: end-of-year tax is due 7 Apr 2028 with this organisation's tax agent's extension (7 Feb
    // without; Jess, 17 Oct 2026); the 2026 year's on 7 Apr 2027.
    expect(report.endOfYear.dueDate).toBe("2028-04-07");
    expect(report.dueDates.filter((entry) => entry.key.startsWith("end-")).map((entry) => [entry.key, entry.dueDate])).toEqual([
      ["end-2026", "2027-04-07"],
      ["end-2027", "2028-04-07"],
    ]);
  });
});
