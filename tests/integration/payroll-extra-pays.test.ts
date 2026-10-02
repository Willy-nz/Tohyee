import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as backPayRoute from "@/app/api/payroll/pay-runs/[payRunId]/employees/[employeeId]/back-pay/route";
import * as payItemsRoute from "@/app/api/payroll/pay-items/route";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { getJournal } from "@/lib/ledger/journals";
import { setPayrollAccess } from "@/lib/payroll/access";
import { createEmployee } from "@/lib/payroll/employees";
import { createPayGroup } from "@/lib/payroll/groups";
import { listPayItems, type PayItem } from "@/lib/payroll/pay-items";
import { addPayRate } from "@/lib/payroll/pay-rates";
import { approvePayRun, createPayRun, deletePayRun, getPayRun, type PayRun, type PayRunEmployee, setPayRunEmployeeLines } from "@/lib/payroll/pay-runs";
import { makePayRunPaydayFilingFile, updatePaydayFilingSettings } from "@/lib/payroll/payday-filing-service";
import { payslipLayout } from "@/lib/payroll/payslip-layout";
import { getPayslip } from "@/lib/payroll/payslips";
import { labourCostReport, payrollSummaryReport } from "@/lib/payroll/reports";
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

const ORG = "payroll-extra-pays-co";
const NOT_SUPPORTED = "Not supported yet (refused rather than guessed)";
const noContext = undefined as never;

/**
 * Examples XP8-XP14 in docs/ACCOUNTING-EXAMPLES.md ("Extra pays, back pay
 * and final pays"). Weekly wages: week 1 (5-11 Oct 2026, paid 14 Oct) is
 * PAYRUN-1, week 2 PAYRUN-2, week 3 PAYRUN-3; week 4 (26 Oct-1 Nov, paid
 * 4 Nov) has the extra pays, back pay and final pays.
 */
describeWithDatabase("extra pays, back pay and final pays (XP8-XP14)", () => {
  let server: TestServer;
  let jess: SessionUser; // first owner, payroll access
  let mere: SessionUser; // admin, payroll access
  let ben: SessionUser; // bookkeeper, payroll access
  const previousSecret = process.env.TOHYEE_SECRET_KEY;
  const people: Record<string, string> = {};
  const runs: Record<string, PayRun> = {};
  let items: Record<string, PayItem> = {};
  let weekly = "";
  let rawiriRate = "";

  const asUser = <T>(user: SessionUser, work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: user.id, email: user.email }, work);

  const employee = async (overrides: Record<string, unknown>) =>
    (
      await asUser(jess, (tx) =>
        createEmployee(tx, {
          idempotencyKey: key("employee"),
          taxCode: "M",
          irdNumber: "123456789",
          kiwiSaverStatus: "not_enrolled",
          kiwiSaverEmployeeRate: "3.5",
          kiwiSaverEmployerRate: "3.5",
          studentLoan: false,
          payBasis: "hourly",
          hourlyRate: "25",
          ordinaryHoursPerWeek: "40",
          payFrequency: "weekly",
          startDate: "2026-04-01",
          bankAccount: "03-1234-0123456-00",
          payGroupId: weekly,
          ...overrides,
        }),
      )
    ).employee.id;

  const draft = (payGroupId: string, periodStart: string, payDate: string) =>
    asUser(ben, (tx) => createPayRun(tx, { idempotencyKey: key("payrun"), payGroupId, periodStart, payDate })).then((result) => result.payRun);
  const setLines = (runId: string, employeeId: string, lines: unknown[]) =>
    asUser(ben, (tx) => setPayRunEmployeeLines(tx, runId, employeeId, { lines })).then((result) => result.payRun);
  const approve = (runId: string) => asUser(ben, (tx) => approvePayRun(tx, runId, { idempotencyKey: key("approve") })).then((result) => result.payRun);
  const pay = (run: PayRun, employeeId: string): PayRunEmployee => run.employees.find((entry) => entry.employeeId === employeeId)!;
  const ordinary = (quantity: string) => ({ payItemId: items["Ordinary time"].id, quantity });

  const backPay = async (method: "POST" | "DELETE", runId: string, employeeId: string, body?: Record<string, unknown>) => {
    const path = `/api/payroll/pay-runs/${runId}/employees/${employeeId}/back-pay`;
    const handler = method === "POST" ? backPayRoute.POST : backPayRoute.DELETE;
    const response = await handler(
      apiRequest(method === "DELETE" ? `${path}?organisationId=${ORG}` : path, {
        method,
        cookie: await sessionCookieFor(ben),
        body: body ? { organisationId: ORG, ...body } : undefined,
      }),
      params({ payRunId: runId, employeeId }) as never,
    );
    return { status: response.status, body: (await response.json()) as { payRun?: PayRun; error?: string } };
  };

  beforeAll(async () => {
    process.env.TOHYEE_SECRET_KEY = "payroll-integration-test-secret-key-32-characters";
    server = await startTestServer();
    jess = await createTestUser("jess@payrollextra.test");
    await createTestOrganisation(jess, ORG);
    mere = await createTestUser("mere@payrollextra.test");
    ben = await createTestUser("ben@payrollextra.test");
    const members = [
      [mere, "admin"],
      [ben, "bookkeeper"],
    ] as const;
    for (const [user, role] of members) {
      await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, $3)", [ORG, user.id, role]);
    }
    const memberList = [
      { userId: jess.id, email: jess.email, displayName: "Jess", role: "owner" as const, isActive: true },
      ...members.map(([user, role]) => ({ userId: user.id, email: user.email, displayName: user.email, role, isActive: true })),
    ];
    for (const user of [mere, ben]) await asUser(jess, (tx) => setPayrollAccess(tx, memberList, { userId: user.id, hasPayrollAccess: true }));
    await asUser(jess, (tx) =>
      updatePaydayFilingSettings(tx, {
        employerIrdNumber: "123123123",
        contactName: "Mere Tipene",
        contactPhone: "034771234",
        contactEmail: "payroll@harbourcafe.co.nz",
      }),
    );

    // XP pay items, added by Mere (admin) through the API.
    for (const [name, kind] of [
      ["Bonus", "extra_pay"],
      ["Back pay", "back_pay"],
      ["Holiday pay on finishing", "termination_holiday_pay"],
      ["Redundancy", "redundancy"],
    ]) {
      const response = await payItemsRoute.POST(
        apiRequest("/api/payroll/pay-items", {
          method: "POST",
          cookie: await sessionCookieFor(mere),
          body: { organisationId: ORG, idempotencyKey: key("item"), name, kind, accountCode: "6200" },
        }),
        noContext,
      );
      expect(response.status).toBe(201);
    }
    items = Object.fromEntries((await asUser(jess, (tx) => listPayItems(tx))).map((item) => [item.name, item]));

    weekly = (await asUser(jess, (tx) => createPayGroup(tx, { idempotencyKey: key("group"), name: "Weekly wages", payFrequency: "weekly" }))).group.id;
    people.heidi = await employee({
      firstName: "Heidi",
      lastName: "Bonus",
      payBasis: "salary",
      hourlyRate: undefined,
      ordinaryHoursPerWeek: undefined,
      annualSalary: "79950",
      kiwiSaverStatus: "enrolled",
      esctRate: "30",
    });
    people.rawiri = await employee({ firstName: "Rāwiri", lastName: "Backpay", hourlyRate: "30" });
    people.tama = await employee({ firstName: "Tama", lastName: "Finishing", finishDate: "2026-11-01" });
    people.connor = await employee({ firstName: "Connor", lastName: "Redundant", finishDate: "2026-10-28", kiwiSaverStatus: "enrolled", esctRate: "17.5" });
    people.kelvin = await employee({ firstName: "Kelvin", lastName: "Unpaid", finishDate: "2026-11-01" });
    people.sam = await employee({ firstName: "Sam", lastName: "Signing", hourlyRate: "30", startDate: "2026-10-26" });

    const hours: Record<string, [string, string, string]> = {
      connor: ["22", "22", "26"],
      kelvin: ["24", "20", "0"],
    };
    for (const [index, [periodStart, payDate]] of [
      ["2026-10-05", "2026-10-14"],
      ["2026-10-12", "2026-10-21"],
      ["2026-10-19", "2026-10-28"],
    ].entries()) {
      const run = await draft(weekly, periodStart, payDate);
      for (const [person, perWeek] of Object.entries(hours)) await setLines(run.id, people[person], [ordinary(perWeek[index])]);
      runs[`week${index + 1}`] = await approve(run.id);
    }
    // Rāwiri's new rate from week 2, added after week 3 was approved (XP10).
    rawiriRate = (
      await asUser(jess, (tx) =>
        addPayRate(tx, people.rawiri, {
          idempotencyKey: key("rate"),
          effectiveFrom: "2026-10-12",
          payBasis: "hourly",
          hourlyRate: "32",
          ordinaryHoursPerWeek: "40",
          reason: "Collective agreement backdated",
        }),
      )
    ).payRate.id;
  });

  afterAll(async () => {
    await server?.teardown();
    if (previousSecret === undefined) delete process.env.TOHYEE_SECRET_KEY;
    else process.env.TOHYEE_SECRET_KEY = previousSecret;
  });

  it("weeks 1-3 were paid as usual", () => {
    expect(pay(runs.week1, people.heidi).pay).toMatchObject({ gross: "1537.50", paye: "339.61", extraPay: "0.00" });
    expect(pay(runs.week3, people.kelvin).pay).toMatchObject({ gross: "0.00", paye: "0.00" });
    expect(pay(runs.week3, people.rawiri).pay).toMatchObject({ gross: "1200.00", paye: "231.39" });
  });

  describe("week 4", () => {
    let week4: PayRun;

    it("XP12, XP13: the draft includes people finishing in the period; an hourly leaver before the period's end starts at 0 hours", async () => {
      week4 = await draft(weekly, "2026-10-26", "2026-11-04");
      expect(pay(week4, people.connor).lines).toMatchObject([{ quantity: "0.00", amount: "0.00", description: "Final pay: enter the hours worked to 28 Oct 2026" }]);
      expect(pay(week4, people.tama).lines).toMatchObject([{ quantity: "40.00", amount: "1000.00", description: null }]);
      expect(pay(week4, people.tama).finishDate).toBe("2026-11-01");
      expect(pay(week4, people.tama).notes).toEqual([
        // Since P8, only when Tohyee doesn't keep the employee's leave (decision 150).
        "Final pay: employment finishes on 1 Nov 2026. Tohyee doesn't keep Tama Finishing's leave, so holiday pay owed on finishing isn't calculated by Tohyee; work it out outside Tohyee and add it as Holiday pay on finishing.",
      ]);
      expect(pay(week4, people.heidi)).toMatchObject({ finishDate: null, notes: [], extraPayBasis: null });
      expect(pay(week4, people.rawiri).lines).toMatchObject([{ quantity: "40.00", rate: "32.00", amount: "1280.00" }]);
    });

    it("XP8: Heidi's bonus is taxed against four weeks' pay annualised", async () => {
      week4 = await setLines(week4.id, people.heidi, [
        { payItemId: items["Ordinary time"].id, amount: "1537.50" },
        { payItemId: items.Bonus.id, amount: "1000.00" },
      ]);
      const heidi = pay(week4, people.heidi);
      expect(heidi.problem).toBeNull();
      expect(heidi.extraPayBasis).toEqual({ method: "four_weeks", annualised: "79950.00" });
      expect(heidi.pay).toMatchObject({
        gross: "2537.50",
        paye: "687.11",
        kiwiSaverEmployee: "88.81",
        netPay: "1761.58",
        kiwiSaverEmployer: "88.81",
        esct: "26.40",
        kiwiSaverEmployerNet: "62.41",
        extraPay: "1000.00",
        extraPayTax: "347.50",
        extraPayTaxRate: "33",
        lumpSumLowestRate: false,
      });
      expect(heidi.notes).toEqual(["Extra pay $1,000.00 taxed at 33% (IRD's extra pay rules, four weeks' pay annualised: $79,950.00)."]);
    });

    it("XP9: Sam's signing bonus, with no pay before it, is at the lowest rate", async () => {
      week4 = await setLines(week4.id, people.sam, [{ payItemId: items.Bonus.id, amount: "10000.00", description: "Signing bonus" }]);
      const sam = pay(week4, people.sam);
      expect(sam.extraPayBasis).toEqual({ method: "four_weeks", annualised: "0.00" });
      expect(sam.pay).toMatchObject({ paye: "1225.00", netPay: "8775.00", lumpSumLowestRate: true, extraPayTaxRate: "10.5" });
    });

    it("XP10: back pay from Rāwiri's pay rate history, one line per period paid at less", async () => {
      const added = await backPay("POST", week4.id, people.rawiri, { payItemId: items["Back pay"].id, payRateId: rawiriRate });
      expect(added.status).toBe(200);
      week4 = added.body.payRun!;
      const rawiri = pay(week4, people.rawiri);
      expect(rawiri.lines).toMatchObject([
        { payItemName: "Ordinary time", amount: "1280.00", backPayForPayRunId: null },
        {
          payItemName: "Back pay",
          amount: "80.00",
          description: `Back pay for ${runs.week2.reference} (12 Oct 2026 to 18 Oct 2026): 40.00 h at $32.00 instead of $30.00`,
          backPayForPayRunId: runs.week2.id,
        },
        { payItemName: "Back pay", amount: "80.00", backPayForPayRunId: runs.week3.id },
      ]);
      expect(rawiri.extraPayBasis).toEqual({ method: "four_weeks", annualised: "63440.00" });
      expect(rawiri.pay).toMatchObject({ gross: "1440.00", paye: "307.59", netPay: "1132.41", extraPayTax: "50.80", extraPayTaxRate: "30" });

      const again = await backPay("POST", week4.id, people.rawiri, { payItemId: items["Back pay"].id, payRateId: rawiriRate });
      expect(again.body.error).toBe(
        `${NOT_SUPPORTED}: a second back pay for ${runs.week2.reference}: Rāwiri Backpay already has back pay for it on ${week4.reference}.`,
      );
      // Editing his other lines keeps the back pay, after the typed lines.
      week4 = await setLines(week4.id, people.rawiri, [ordinary("40")]);
      expect(pay(week4, people.rawiri).lines.map((line) => [line.lineNumber, line.payItemName, line.amount])).toEqual([
        [1, "Ordinary time", "1280.00"],
        [2, "Back pay", "80.00"],
        [3, "Back pay", "80.00"],
      ]);
      // Remove and add again.
      const removed = await backPay("DELETE", week4.id, people.rawiri);
      expect(pay(removed.body.payRun!, people.rawiri).lines).toHaveLength(1);
      week4 = (await backPay("POST", week4.id, people.rawiri, { payItemId: items["Back pay"].id, payRateId: rawiriRate })).body.payRun!;
      expect(pay(week4, people.rawiri).pay?.paye).toBe("307.59");
      // A rate that starts in this period owes nothing; another item kind is refused.
      const wrongItem = await backPay("POST", week4.id, people.rawiri, { payItemId: items.Bonus.id, payRateId: rawiriRate });
      expect(wrongItem.body.error).toBe("Choose a pay item of the kind Back pay.");
    });

    it("XP12: Tama's holiday pay on finishing uses his last two paid periods", async () => {
      week4 = await setLines(week4.id, people.tama, [ordinary("40"), { payItemId: items["Holiday pay on finishing"].id, amount: "400.00" }]);
      const tama = pay(week4, people.tama);
      expect(tama.extraPayBasis).toEqual({ method: "end_of_employment", annualised: "52000.00" });
      expect(tama.pay).toMatchObject({ gross: "1400.00", paye: "248.50", netPay: "1151.50", extraPayTax: "77.00", extraPayTaxRate: "17.5" });
      expect(tama.notes[1]).toBe("Extra pay $400.00 taxed at 17.5% (IRD's extra pay rules, the last 2 paid pay periods annualised: $52,000.00).");
    });

    it("XP13: Connor's redundancy has no levy and no KiwiSaver", async () => {
      week4 = await setLines(week4.id, people.connor, [ordinary("10"), { payItemId: items.Redundancy.id, amount: "1000.00" }]);
      expect(pay(week4, people.connor).extraPayBasis).toEqual({ method: "end_of_employment", annualised: "31200.00" });
      expect(pay(week4, people.connor).pay).toMatchObject({
        gross: "1250.00",
        kiwiSaverEarnings: "250.00",
        paye: "205.62",
        kiwiSaverEmployee: "8.75",
        netPay: "1035.63",
        kiwiSaverEmployer: "8.75",
        esct: "1.40",
        kiwiSaverEmployerNet: "7.35",
        extraPayTax: "175.00",
      });
    });

    it("XP14: Kelvin's unpaid week is skipped", async () => {
      week4 = await setLines(week4.id, people.kelvin, [ordinary("22"), { payItemId: items["Holiday pay on finishing"].id, amount: "2000.00" }]);
      expect(pay(week4, people.kelvin).extraPayBasis).toEqual({ method: "end_of_employment", annualised: "28600.00" });
      expect(pay(week4, people.kelvin).pay).toMatchObject({ paye: "469.87", extraPayTax: "385.00" });
    });

    it("approving keeps the figures; the journal, EI file, payslips and reports show the new pay items", async () => {
      expect(week4.problemCount).toBe(0);
      const approved = await approve(week4.id);
      expect(pay(approved, people.heidi).pay).toMatchObject({ paye: "687.11", extraPayTax: "347.50", extraPayTaxRate: "33" });
      expect(pay(approved, people.heidi).extraPayBasis).toEqual({ method: "four_weeks", annualised: "79950.00" });
      expect(pay(approved, people.sam).pay?.lumpSumLowestRate).toBe(true);
      expect(pay(approved, people.tama).finishDate).toBe("2026-11-01");
      expect(pay(approved, people.tama).notes[0]).toContain("Final pay: employment finishes on 1 Nov 2026.");
      const again = await asUser(ben, (tx) => getPayRun(tx, week4.id));
      expect(pay(again, people.rawiri).pay).toMatchObject({ paye: "307.59", extraPay: "160.00" });

      const journal = await asUser(jess, (tx) => getJournal(tx, approved.approvalJournalId!));
      const debit = (description: string) => journal.lines.find((line) => line.description === description)?.debitAmount;
      expect(debit("Bonus")).toBe("11000.00");
      expect(debit("Back pay")).toBe("160.00");
      expect(debit("Holiday pay on finishing")).toBe("2400.00");
      expect(debit("Redundancy")).toBe("1000.00");
      expect(journal.lines.some((line) => /Heidi|Sam|Tama|Connor|Kelvin|Rāwiri/.test(line.description ?? ""))).toBe(false);

      // EI file: field 6 finish date, field 13 redundancy, field 14 lump sum indicator.
      const file = await asUser(ben, (tx) => makePayRunPaydayFilingFile(tx, week4.id));
      const dei = (name: string) => file.content.split("\r\n").find((line) => line.split(",")[2] === name)!.split(",");
      expect(dei("Sam Signing").slice(10, 15)).toEqual(["1000000", "0", "0", "1", "122500"]);
      expect(dei("Heidi Bonus")[13]).toBe("0");
      expect(dei("Connor Redundant").slice(5, 6)).toEqual(["20261028"]);
      expect(dei("Connor Redundant").slice(10, 15)).toEqual(["125000", "0", "100000", "0", "20562"]);
      expect(dei("Tama Finishing")[5]).toBe("20261101");
      expect(dei("Heidi Bonus")[5]).toBe("");
      expect(file.content.split("\r\n")[0].split(",")[12]).toBe("100000");

      const tamaSlip = payslipLayout(await asUser(ben, (tx) => getPayslip(tx, week4.id, people.tama)));
      expect(tamaSlip.notes).toEqual([
        `Pay run ${week4.reference}.`,
        "Extra pay of $400.00 taxed at 17.5% under IRD's extra pay rules.",
        "Final pay: employment finished on 1 Nov 2026.",
        "Holiday pay on finishing was worked out outside Tohyee.",
      ]);
      const heidiSlip = payslipLayout(await asUser(ben, (tx) => getPayslip(tx, week4.id, people.heidi)));
      expect(heidiSlip.notes).toEqual([`Pay run ${week4.reference}.`, "Extra pay of $1,000.00 taxed at 33% under IRD's extra pay rules."]);
      expect(heidiSlip.earnings.map((row) => [row.label, row.amount])).toEqual([
        ["Ordinary time", "1,537.50"],
        ["Bonus", "1,000.00"],
      ]);

      const summary = await asUser(ben, (tx) => payrollSummaryReport(tx, { from: "2026-11-04", to: "2026-11-04" }));
      const byItem = Object.fromEntries(summary.payItems.map((item) => [item.name, item.amount]));
      expect(byItem).toMatchObject({ Bonus: "11000.00", "Back pay": "160.00", "Holiday pay on finishing": "2400.00", Redundancy: "1000.00" });
      // 687.11 + 1,225.00 + 307.59 + 248.50 + 205.62 + 469.87
      expect(summary.totals.paye).toBe("3143.69");
      const labour = await asUser(ben, (tx) => labourCostReport(tx, { from: "2026-11-04", to: "2026-11-04", groupBy: "pay_item" }));
      const labourByItem = Object.fromEntries(labour.groups.map((group) => [group.label, group.total]));
      expect(labourByItem).toMatchObject({ Bonus: "11000.00", "Back pay": "160.00", "Holiday pay on finishing": "2400.00", Redundancy: "1000.00" });
      runs.week4 = approved;
    });

    it("XP10: back pay already paid on an approved pay run isn't paid again", async () => {
      const week5 = await draft(weekly, "2026-11-02", "2026-11-11");
      expect(week5.employees.map((entry) => entry.employeeId).sort()).toEqual([people.heidi, people.rawiri, people.sam].sort());
      const refused = await backPay("POST", week5.id, people.rawiri, { payItemId: items["Back pay"].id, payRateId: rawiriRate });
      expect(refused.body.error).toBe(
        `${NOT_SUPPORTED}: a second back pay for ${runs.week2.reference}: Rāwiri Backpay already has back pay for it on ${runs.week4.reference}.`,
      );
      await asUser(ben, (tx) => deletePayRun(tx, week5.id));
    });
  });

  describe("XP11 and the refusals", () => {
    let refusals = "";
    let hanaWeek3 = "";
    const refused: Record<string, string> = {};

    beforeAll(async () => {
      refusals = (await asUser(jess, (tx) => createPayGroup(tx, { idempotencyKey: key("group"), name: "Refusals", payFrequency: "weekly" }))).group.id;
      refused.nia = await employee({ firstName: "Nia", lastName: "New", startDate: "2026-10-19", payGroupId: refusals });
      refused.lou = await employee({ firstName: "Lou", lastName: "Leaver", finishDate: "2026-11-01", payGroupId: refusals });
      refused.hana = await employee({ firstName: "Hana", lastName: "Holiday", payGroupId: refusals });
      const week3 = await draft(refusals, "2026-10-19", "2026-10-28");
      await setLines(week3.id, refused.hana, [ordinary("32"), { payItemId: items["Holiday pay"].id, amount: "200.00" }]);
      hanaWeek3 = (await approve(week3.id)).reference;
    });

    it("refuses extra pays IRD's rules don't clearly answer, as the employee's problem", async () => {
      const week4 = await draft(refusals, "2026-10-26", "2026-11-04");
      let run = await setLines(week4.id, refused.nia, [ordinary("40"), { payItemId: items.Bonus.id, amount: "500.00" }]);
      // XP15: two weekly pays in the four weeks, "other circumstances": (1,000.00 + 1,000.00) x 13 (decision 213).
      expect(pay(run, refused.nia)).toMatchObject({
        problem: null,
        extraPayBasis: { method: "four_weeks", annualised: "26000.00" },
        pay: { extraPay: "500.00", extraPayTax: "96.25", extraPayTaxRate: "17.5" },
      });
      run = await setLines(week4.id, refused.nia, [ordinary("40"), { payItemId: items.Redundancy.id, amount: "500.00" }]);
      expect(pay(run, refused.nia).problem).toBe(
        `${NOT_SUPPORTED}: holiday pay on finishing or redundancy on a pay that isn't Nia New's final pay (their finish date isn't in this pay period).`,
      );
      run = await setLines(week4.id, refused.lou, [ordinary("40"), { payItemId: items.Bonus.id, amount: "500.00" }]);
      expect(pay(run, refused.lou).problem).toBe(
        `${NOT_SUPPORTED}: an extra pay or back pay on Lou Leaver's final pay without holiday pay on finishing or redundancy (whether it arises from the employment ending decides IRD's method).`,
      );
      run = await setLines(week4.id, refused.lou, [ordinary("40"), { payItemId: items["Holiday pay on finishing"].id, amount: "500.00" }]);
      expect(pay(run, refused.lou).problem).toBe(
        `${NOT_SUPPORTED}: an extra pay on leaving with 1 paid pay period before the final pay (IRD's rule annualises the last 2) for Lou Leaver.`,
      );
      await expect(approve(week4.id)).rejects.toThrow("can't be approved yet");

      // XP11: back pay for a period with holiday pay, and for a rate starting part-way through a paid period.
      const fromWeek3 = (
        await asUser(jess, (tx) =>
          addPayRate(tx, refused.hana, { idempotencyKey: key("rate"), effectiveFrom: "2026-10-19", payBasis: "hourly", hourlyRate: "27", ordinaryHoursPerWeek: "40" }),
        )
      ).payRate.id;
      const holiday = await backPay("POST", week4.id, refused.hana, { payItemId: items["Back pay"].id, payRateId: fromWeek3 });
      expect(holiday.body.error).toBe(
        `${NOT_SUPPORTED}: back pay for a pay period with holiday pay or leave in it: back pay changes the ordinary weekly pay that leave was paid at and the gross earnings later holiday pay uses, which needs its own worked example (decision 152) (${hanaWeek3}).`,
      );
      const midWeek = (
        await asUser(jess, (tx) =>
          addPayRate(tx, refused.hana, { idempotencyKey: key("rate"), effectiveFrom: "2026-10-21", payBasis: "hourly", hourlyRate: "28", ordinaryHoursPerWeek: "40" }),
        )
      ).payRate.id;
      const partWay = await backPay("POST", week4.id, refused.hana, { payItemId: items["Back pay"].id, payRateId: midWeek });
      expect(partWay.body.error).toBe(
        `${NOT_SUPPORTED}: back pay for a pay rate that starts part-way through a paid period (${hanaWeek3} pays 2026-10-19 to 2026-10-25; the rate starts on 2026-10-21).`,
      );
      const current = (
        await asUser(jess, (tx) =>
          addPayRate(tx, refused.hana, { idempotencyKey: key("rate"), effectiveFrom: "2026-11-02", payBasis: "hourly", hourlyRate: "29", ordinaryHoursPerWeek: "40" }),
        )
      ).payRate.id;
      const none = await backPay("POST", week4.id, refused.hana, { payItemId: items["Back pay"].id, payRateId: current });
      expect(none.body.error).toBe("No back pay is owed for that pay rate: it starts on 2 Nov 2026, not before this pay period.");
      await asUser(ben, (tx) => deletePayRun(tx, week4.id));
    });
  });
});
