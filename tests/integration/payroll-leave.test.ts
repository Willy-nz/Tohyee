import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { add, dec, divide, mul, sum, toFixedString } from "@/lib/money/decimal";
import { setPayrollAccess } from "@/lib/payroll/access";
import { createEmployee } from "@/lib/payroll/employees";
import { createPayGroup } from "@/lib/payroll/groups";
import { addDays } from "@/lib/payroll/leave/dates";
import { addLeaveSettings, updateOrganisationLeaveSettings } from "@/lib/payroll/leave-settings";
import { addUnpaidLeave, cancelLeaveBooking, cancelUnpaidLeave, createCashUp, createLeaveBooking, decidePublicHoliday, exchangeAlternativeHoliday } from "@/lib/payroll/leave-records";
import { exportLeaveLiability, exportLeaveRecord, getLeaveRecord, getLeaveSummary, leaveLiabilityReport } from "@/lib/payroll/leave-reports";
import { makePayRunPaydayFilingFile, updatePaydayFilingSettings } from "@/lib/payroll/payday-filing-service";
import { payslipLayout } from "@/lib/payroll/payslip-layout";
import { getPayslip } from "@/lib/payroll/payslips";
import { approveTimesheet, openTimesheet, saveTimesheetEntries, submitTimesheet } from "@/lib/payroll/timesheets";
import { createPayItem, listPayItems, type PayItem } from "@/lib/payroll/pay-items";
import { addPayRate } from "@/lib/payroll/pay-rates";
import {
  approvePayRun,
  createPayRun,
  getPayRun,
  type PayRun,
  type PayRunEmployee,
  type PayRunLine,
  setPayRunEmployeeLines,
  updatePayRunLeave,
  voidPayRun,
} from "@/lib/payroll/pay-runs";
import * as balancesRoute from "@/app/api/payroll/leave/balances/route";
import * as cancelCashUpRoute from "@/app/api/payroll/leave/cash-ups/[cashUpId]/cancel/route";
import * as cashUpsRoute from "@/app/api/payroll/leave/cash-ups/route";
import * as fileRoute from "@/app/api/payroll/leave/files/[fileId]/route";
import * as liabilityRoute from "@/app/api/payroll/leave/liability/route";
import * as publicHolidaysRoute from "@/app/api/payroll/leave/public-holidays/route";
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

const ORG = "payroll-leave-co";
const REFUSED = "Not supported yet (refused rather than guessed)";
const noContext = undefined as never;

/**
 * Examples HL1-HL42 in docs/ACCOUNTING-EXAMPLES.md ("Holidays Act leave"),
 * the database flows: usual pay from the usual week, leave booked and paid
 * in pay runs, public holidays and the decisions for them, alternative
 * holidays, balances counted from approved pay runs (and not from voided
 * ones), and holiday pay on finishing. Weekly pay, Monday to Sunday,
 * paid the Wednesday after.
 */
describeWithDatabase("Holidays Act leave in pay runs (HL1-HL42)", () => {
  let server: TestServer;
  let jess: SessionUser;
  let mere: SessionUser;
  const previousSecret = process.env.TOHYEE_SECRET_KEY;
  const people: Record<string, string> = {};
  const groups: Record<string, string> = {};
  let items: Record<string, PayItem> = {};
  const approved: Record<string, PayRun> = {};

  const as = <T>(user: SessionUser, work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: user.id, email: user.email }, work);
  const asJess = <T>(work: (tx: OrgTx) => Promise<T>) => as(jess, work);

  const employee = async (overrides: Record<string, unknown>) =>
    (
      await asJess((tx) =>
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
          bankAccount: "03-1234-0123456-00",
          ...overrides,
        }),
      )
    ).employee.id;

  const week = (days: Array<{ hours: string; extras?: unknown[] }>) => ({ kind: "fixed", days: days.map((day) => ({ ordinaryHours: day.hours, extras: day.extras ?? [] })) });
  const draft = (group: string, periodStart: string) =>
    // Paid the Wednesday after, or by 31 Mar 2027, the last pay date Tohyee has IRD's rates for.
    asJess((tx) =>
      createPayRun(tx, { idempotencyKey: key("run"), payGroupId: groups[group], periodStart, payDate: addDays(periodStart, 9) > "2027-03-31" ? "2027-03-31" : addDays(periodStart, 9) }),
    ).then((result) => result.payRun);
  const approve = (runId: string) => asJess((tx) => approvePayRun(tx, runId, { idempotencyKey: key("approve") })).then((result) => result.payRun);
  const of = (run: PayRun, person: string): PayRunEmployee => run.employees.find((entry) => entry.employeeId === people[person])!;
  const lines = (run: PayRun, person: string) => of(run, person).lines.map((line) => [line.payItemName, line.quantity, line.amount, line.source] as const);
  const leaveLines = (run: PayRun, person: string): PayRunLine[] => of(run, person).lines.filter((line) => line.source === "leave");

  /** Pays every week from `from` to `to` (Mondays), approving each; `during` can change a draft first. */
  const payWeeks = async (group: string, from: string, to: string, during?: (run: PayRun) => Promise<PayRun | void>) => {
    let last: PayRun | null = null;
    for (let monday = from; monday <= to; monday = addDays(monday, 7)) {
      let run = await draft(group, monday);
      if (during) run = (await during(run)) ?? run;
      const problems = run.employees.filter((entry) => entry.problem).map((entry) => `${entry.name}: ${entry.problem}`);
      if (problems.length > 0) throw new Error(`${run.reference} (${monday}): ${problems.join(" ")}`);
      last = await approve(run.id);
      approved[`${group}:${monday}`] = last;
    }
    return last!;
  };

  beforeAll(async () => {
    process.env.TOHYEE_SECRET_KEY = "payroll-integration-test-secret-key-32-characters";
    server = await startTestServer();
    jess = await createTestUser("jess@payrollleave.test");
    await createTestOrganisation(jess, ORG);
    mere = await createTestUser("mere@payrollleave.test");
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'bookkeeper')", [ORG, mere.id]);
    await asJess((tx) =>
      setPayrollAccess(
        tx,
        [
          { userId: jess.id, email: jess.email, displayName: "Jess", role: "owner", isActive: true },
          { userId: mere.id, email: mere.email, displayName: "Mere", role: "bookkeeper", isActive: true },
        ],
        { userId: mere.id, hasPayrollAccess: true },
      ),
    );
    await asJess((tx) => updateOrganisationLeaveSettings(tx, { anniversaryRegion: "wellington" }));
    await asJess((tx) => createPayItem(tx, { idempotencyKey: key("item"), name: "Shift allowance", kind: "allowance", accountCode: "6200" }));
    await asJess((tx) => createPayItem(tx, { idempotencyKey: key("item"), name: "Bonus", kind: "extra_pay", accountCode: "6200" }));
    items = Object.fromEntries((await asJess((tx) => listPayItems(tx))).map((item) => [item.name, item]));
    for (const name of ["A", "B", "C"]) {
      groups[name] = (await asJess((tx) => createPayGroup(tx, { idempotencyKey: key("group"), name: `Weekly ${name}`, payFrequency: "weekly" }))).group.id;
    }

    // Ben (HL2, HL6): 28.00 an hour, 30.00 from Mon 15 Jun 2026; 8 hours Monday to Friday, 5 hours' rostered
    // overtime on Thursday and a shift allowance of 10.00 a shift; last day Fri 18 Dec 2026.
    people.ben = await employee({ firstName: "Ben", lastName: "Shift", hourlyRate: "28", ordinaryHoursPerWeek: "40", startDate: "2025-03-03", payGroupId: groups.B });
    const shift = { payItemId: items["Shift allowance"].id, amount: "10", regular: true };
    const overtime = { payItemId: items.Overtime.id, hours: "5", regular: true };
    await asJess((tx) =>
      addLeaveSettings(tx, people.ben, {
        idempotencyKey: key("settings"),
        pattern: week([
          { hours: "8", extras: [shift] },
          { hours: "8", extras: [shift] },
          { hours: "8", extras: [shift] },
          { hours: "8", extras: [overtime, shift] },
          { hours: "8", extras: [shift] },
          { hours: "0" },
          { hours: "0" },
        ]),
        dailyPay: "rdp",
        annualPaidInPeriod: true,
      }),
    );
    await asJess((tx) =>
      addPayRate(tx, people.ben, { idempotencyKey: key("rate"), effectiveFrom: "2026-06-15", payBasis: "hourly", hourlyRate: "30", ordinaryHoursPerWeek: "40", reason: "Pay rise" }),
    );

    // Fiona (HL8, HL30, HL32): 27.00 an hour, Tuesday to Thursday, 6 hours a day.
    people.fiona = await employee({ firstName: "Fiona", lastName: "Parttime", hourlyRate: "27", ordinaryHoursPerWeek: "18", startDate: "2026-09-07", payGroupId: groups.B });
    await asJess((tx) =>
      addLeaveSettings(tx, people.fiona, {
        idempotencyKey: key("settings"),
        pattern: week([{ hours: "0" }, { hours: "6" }, { hours: "6" }, { hours: "6" }, { hours: "0" }, { hours: "0" }, { hours: "0" }]),
        annualPaidInPeriod: true,
      }),
    );

    // Aroha (HL1, HL8, HL10-HL13, HL20, HL22, HL26, HL27, HL42): a salary of 62,400.00, Monday to Friday, 8 hours a day,
    // from Tue 1 Apr 2025; Tohyee pays her from the week of Mon 7 Apr 2025 (a salary can't start part-way through a period, PRUN8).
    people.aroha = await employee({
      firstName: "Aroha",
      lastName: "Salary",
      payBasis: "salary",
      annualSalary: "62400",
      hourlyRate: undefined,
      ordinaryHoursPerWeek: undefined,
      startDate: "2025-04-01",
      payGroupId: groups.A,
    });
    await asJess((tx) => addLeaveSettings(tx, people.aroha, { idempotencyKey: key("settings"), pattern: week(Array.from({ length: 7 }, (_, index) => ({ hours: index < 5 ? "8" : "0" }))), annualPaidInPeriod: true }));
    // Eru (HL14, HL15): 25.00 an hour, Monday to Friday, from Mon 6 Apr 2026 to Fri 26 Feb 2027.
    people.eru = await employee({ firstName: "Eru", lastName: "Advance", hourlyRate: "25", startDate: "2026-04-06", finishDate: "2027-02-26", payGroupId: groups.A });
    await asJess((tx) => addLeaveSettings(tx, people.eru, { idempotencyKey: key("settings"), pattern: week(Array.from({ length: 7 }, (_, index) => ({ hours: index < 5 ? "8" : "0" }))), annualPaidInPeriod: true }));
    // Cara (HL3, HL7, HL24, HL30): permanent, hours and days vary; average daily pay because her daily pay varies (decision 13).
    people.cara = await employee({ firstName: "Cara", lastName: "Varies", hourlyRate: "25", ordinaryHoursPerWeek: "20", startDate: "2026-05-04", payGroupId: groups.C });
    await asJess((tx) =>
      addLeaveSettings(tx, people.cara, {
        idempotencyKey: key("settings"),
        pattern: { kind: "varies", weekHours: "20", weekDays: "3" },
        dailyPay: "adp",
        adpReason: "varies_within_period",
        annualPaidInPeriod: true,
      }),
    );
  });

  afterAll(async () => {
    await server?.teardown();
    if (previousSecret === undefined) delete process.env.TOHYEE_SECRET_KEY;
    else process.env.TOHYEE_SECRET_KEY = previousSecret;
  });

  describe("Ben (HL2, HL6, HL16, HL23, HL32, HL33)", () => {
    it("HL2, decision 148: a draft's usual pay comes from the usual week, regular overtime and allowances included", async () => {
      // IRD's rates in Tohyee start with pay dates from 1 Apr 2025, so Tohyee pays Ben from the week of 24 Mar 2025.
      const run = await draft("B", "2025-03-24");
      expect(lines(run, "ben")).toEqual([
        ["Ordinary time", "40.00", "1120.00", "usual_pay"],
        ["Overtime", "5.00", "210.00", "usual_pay"],
        ["Shift allowance", null, "50.00", "usual_pay"],
      ]);
      expect(of(run, "ben").lines.find((line) => line.payItemName === "Overtime")!.regular).toBe(true);
      expect(of(run, "ben").pay!.gross).toBe("1380.00");
      approved["B:2025-03-24"] = await approve(run.id);
    });

    it("HL31, decision 22: a public holiday is paid at relevant daily pay and comes off the usual pay (Good Friday 18 Apr 2025)", async () => {
      await payWeeks("B", "2025-03-31", "2025-04-07");
      const easter = await draft("B", "2025-04-14");
      expect(lines(easter, "ben")).toEqual([
        ["Ordinary time", "32.00", "896.00", "usual_pay"],
        ["Overtime", "5.00", "210.00", "usual_pay"],
        ["Shift allowance", null, "40.00", "usual_pay"],
        ["Public holiday", null, "234.00", "leave"],
      ]);
      expect(leaveLines(easter, "ben")[0].leave).toMatchObject({ type: "public_holiday", holidayDate: "2025-04-18" });
      expect(of(easter, "ben").pay!.gross).toBe("1380.00");
      approved["B:2025-04-14"] = await approve(easter.id);
    });

    it("pays Ben through to May 2026, public holidays included; he works Labour Day 2025, so an alternative holiday arises", async () => {
      await payWeeks("B", "2025-04-21", "2026-05-04", async (run) => {
        if (run.periodStart !== "2025-10-27") return;
        await asJess((tx) => decidePublicHoliday(tx, { employeeId: people.ben, holidayDate: "2025-10-27", otherwiseWorking: true, hoursWorked: "8" }));
        return asJess((tx) => getPayRun(tx, run.id));
      });
      expect(leaveLines(approved["B:2025-10-27"], "ben").map((line) => [line.payItemName, line.amount])).toEqual([["Public holiday worked", "351.00"]]);
    }, 120_000);

    it("HL13, decision 9: two weeks of annual holidays (90 hours) at the greater of OWP and AWE, after his entitlement on Tue 3 Mar 2026", async () => {
      const booked = await asJess((tx) => createLeaveBooking(tx, { idempotencyKey: key("book"), employeeId: people.ben, leaveType: "annual", startDate: "2026-05-11", endDate: "2026-05-22" }));
      expect(booked.warnings).toEqual([]);
      const first = await draft("B", "2026-05-11");
      const annual = leaveLines(first, "ben");
      expect(annual).toHaveLength(1);
      expect(annual[0].leave).toMatchObject({ type: "annual", from: "2026-05-11", to: "2026-05-15", hours: "45", units: "1", inAdvance: false });
      const basis = annual[0].leave!.basis as Record<string, string>;
      expect(basis.ordinaryWeeklyPay).toBe("1380.000000");
      // The usual pay is all taken off: he's on holiday every working day.
      expect(lines(first, "ben").filter((line) => line[3] === "usual_pay")).toEqual([["Ordinary time", "0.00", "0.00", "usual_pay"]]);
      expect(annual[0].amount).toBe(toFixedString(dec(basis.weeklyRate), 2));
      approved["B:2026-05-11"] = await approve(first.id);
      await payWeeks("B", "2026-05-18", "2026-05-18");
    });

    it("pays Ben to Labour Day", async () => {
      await payWeeks("B", "2026-05-25", "2026-10-19");
    }, 120_000);

    it("HL32, decision 23: working Labour Day pays time and a half (375.00) and gives an alternative holiday", async () => {
      const run = await draft("B", "2026-10-26");
      expect(leaveLines(run, "ben").map((line) => [line.payItemName, line.amount])).toEqual([["Public holiday", "250.00"]]);
      await asJess((tx) => decidePublicHoliday(tx, { employeeId: people.ben, holidayDate: "2026-10-26", otherwiseWorking: true, hoursWorked: "8" }));
      // HL30, HL32: Fiona doesn't work Mondays, so Labour Day pays her nothing; working 6 hours on it pays 6 × 27.00 × 1.5 and no alternative holiday.
      expect(leaveLines(run, "fiona")).toEqual([]);
      await asJess((tx) => decidePublicHoliday(tx, { employeeId: people.fiona, holidayDate: "2026-10-26", otherwiseWorking: false, hoursWorked: "6" }));
      const after = await asJess((tx) => getPayRun(tx, run.id));
      expect(leaveLines(after, "fiona").map((line) => [line.payItemName, line.amount, line.leave!.basis.alternativeHoliday])).toEqual([["Public holiday worked", "243.00", false]]);
      expect(leaveLines(after, "ben").map((line) => [line.payItemName, line.amount, line.description])).toEqual([
        ["Public holiday worked", "375.00", "Labour Day, 26 Oct 2026: worked 8 h; alternative holiday"],
      ]);
      expect(lines(after, "ben").filter((line) => line[3] === "usual_pay")).toEqual([
        ["Ordinary time", "32.00", "960.00", "usual_pay"],
        ["Overtime", "5.00", "225.00", "usual_pay"],
        ["Shift allowance", null, "40.00", "usual_pay"],
      ]);
      approved["B:2026-10-26"] = await approve(run.id);
    });

    it("HL33, decision 24: the alternative holiday from Labour Day 2025 is exchanged for money only after 12 months, at RDP by default", async () => {
      await expect(
        asJess((tx) =>
          exchangeAlternativeHoliday(tx, { idempotencyKey: key("exchange"), employeeId: people.ben, aroseOn: "2025-10-27", requestedOn: "2026-10-20", agreementNote: "Ben asked by email" }),
        ),
      ).rejects.toThrow("only once 12 months have passed since it arose (s 61(2)(a)): from 27 Oct 2026");
      const { exchange } = await asJess((tx) =>
        exchangeAlternativeHoliday(tx, {
          idempotencyKey: key("exchange"),
          employeeId: people.ben,
          aroseOn: "2025-10-27",
          requestedOn: "2026-10-28",
          agreedOn: "2026-10-28",
          agreementNote: "Ben asked in writing on 28 Oct 2026; agreed the same day at his Wednesday's pay",
        }),
      );
      // His Wednesday's relevant daily pay at 30.00 (decision 24).
      expect([exchange.defaultAmount, exchange.amount]).toEqual(["250.00", "250.00"]);
    });

    it("HL23: sick Wed 4 and Thu 5 Nov at RDP 250.00 and 475.00, 2 days off his balance", async () => {
      await asJess((tx) => createLeaveBooking(tx, { idempotencyKey: key("book"), employeeId: people.ben, leaveType: "sick", startDate: "2026-11-04", endDate: "2026-11-05" }));
      const run = await draft("B", "2026-11-02");
      // The exchanged alternative holiday is paid in this pay as an extra pay (decision 151).
      expect(leaveLines(run, "ben").filter((line) => line.leave!.type === "exchange").map((line) => [line.payItemName, line.amount])).toEqual([
        ["Alternative holiday paid out", "250.00"],
      ]);
      expect(leaveLines(run, "ben").filter((line) => line.leave!.type === "sick").map((line) => [line.payItemName, line.amount, line.leave!.units, line.leave!.hours])).toEqual([
        ["Sick leave", "250.00", "1", "8"],
        ["Sick leave", "475.00", "1", "13"],
      ]);
      expect(lines(run, "ben").filter((line) => line[3] === "usual_pay")).toEqual([
        ["Ordinary time", "24.00", "720.00", "usual_pay"],
        ["Shift allowance", null, "30.00", "usual_pay"],
      ]);
      approved["B:2026-11-02"] = await approve(run.id);
    });

    it("HL33, decisions 24, 25: the alternative holiday taken on Thu 12 Nov is paid at that day's RDP, 475.00, 1 day of 13 hours", async () => {
      const booked = await asJess((tx) => createLeaveBooking(tx, { idempotencyKey: key("book"), employeeId: people.ben, leaveType: "alternative", startDate: "2026-11-12" }));
      expect(booked.booking.reference).toMatch(/^LEAVE-\d+$/);
      const run = await draft("B", "2026-11-09");
      const [line] = leaveLines(run, "ben");
      expect([line.payItemName, line.amount, line.leave!.hours, line.leave!.units, line.leave!.basis.arose]).toEqual(["Alternative holiday", "475.00", "13", "1", "2026-10-26"]);
      // A second one is refused: there's no other alternative holiday to take.
      await expect(
        asJess((tx) => createLeaveBooking(tx, { idempotencyKey: key("book"), employeeId: people.ben, leaveType: "alternative", startDate: "2026-11-13" })),
      ).rejects.toThrow(/no alternative holiday/);
      approved["B:2026-11-09"] = await approve(run.id);
    });

    it("HL23, decision 19: going home sick at noon takes a whole day by default, and the day's pay stays RDP 250.00", async () => {
      await asJess((tx) =>
        createLeaveBooking(tx, { idempotencyKey: key("book"), employeeId: people.ben, leaveType: "sick", startDate: "2026-11-18", hoursWorked: "4" }),
      );
      const run = await draft("B", "2026-11-16");
      const [sick] = leaveLines(run, "ben");
      expect([sick.amount, sick.leave!.units, sick.leave!.hours]).toEqual(["120.00", "1", "8"]);
      // The 4 hours worked (120.00) and the shift allowance stay in the usual pay.
      expect(lines(run, "ben").filter((line) => line[3] === "usual_pay")).toEqual([
        ["Ordinary time", "36.00", "1080.00", "usual_pay"],
        ["Overtime", "5.00", "225.00", "usual_pay"],
        ["Shift allowance", null, "50.00", "usual_pay"],
      ]);
      approved["B:2026-11-16"] = await approve(run.id);
    });

    it("decision 141: voiding a pay run takes its leave back off the record; a booking it paid can't be cancelled until then", async () => {
      const paid = approved["B:2026-11-16"];
      const booking = leaveLines(paid, "ben")[0];
      expect(booking.leave?.type).toBe("sick");
      const bookingId = (await asJess((tx) => tx.query<{ leave_booking_id: string }>(
        "select leave_booking_id::text from payroll_pay_run_lines where pay_run_id = $1 and leave_type = 'sick'",
        [paid.id],
      ))).rows[0].leave_booking_id;
      await expect(asJess((tx) => cancelLeaveBooking(tx, bookingId))).rejects.toThrow(/was paid on PAYRUN-\d+, so it can't be cancelled/);
      await asJess((tx) => voidPayRun(tx, paid.id, { idempotencyKey: key("void"), voidDate: paid.payDate }));
      await asJess((tx) => cancelLeaveBooking(tx, bookingId));
      const again = await draft("B", "2026-11-16");
      expect(leaveLines(again, "ben")).toEqual([]);
      approved["B:2026-11-16"] = await approve(again.id);
    });

    it("HL16, decisions 17, 18, 150: Ben's final pay has his untaken 2 weeks, the 4 public holidays they'd have covered, and 8%", async () => {
      await payWeeks("B", "2026-11-23", "2026-12-07");
      await asJess((tx) => tx.query("update payroll_employees set finish_date = '2026-12-18' where id = $1", [people.ben]));
      const run = await draft("B", "2026-12-14");
      const termination = leaveLines(run, "ben");
      expect(termination.map((line) => [line.payItemName, line.leave!.basis.part])).toEqual([
        ["Holiday pay owed on finishing", "untaken_entitlement"],
        ["Holiday pay owed on finishing", "public_holidays"],
        ["Holiday pay owed on finishing", "eight_percent"],
      ]);
      const [untaken, holidays, eight] = termination;
      expect(untaken.leave).toMatchObject({ hours: "90", units: "2" });
      const basis = untaken.leave!.basis as Record<string, string>;
      expect(basis.ordinaryWeeklyPay).toBe("1475.000000");
      const weekly = dec(basis.rateUsed === "awe" ? basis.averageWeeklyEarnings : basis.ordinaryWeeklyPay);
      expect(untaken.amount).toBe(toFixedString(mul(weekly, dec("2")), 2));
      expect(holidays.amount).toBe("1000.00");
      expect(holidays.leave!.basis.dates).toEqual(["2026-12-25", "2026-12-28", "2027-01-01", "2027-01-04"]);
      const eightBasis = eight.leave!.basis as Record<string, string>;
      expect(eightBasis.since).toBe("2026-03-03");
      expect(dec(eightBasis.grossEarnings)).toEqual(dec(eightBasis.grossEarnings));
      expect(eight.amount).toBe(toFixedString(mul(dec(eightBasis.grossEarnings), dec("0.08")), 2));
      // The gross earnings include the untaken entitlement and the public holidays (s 26; decision 17).
      const weekPay = sum(of(run, "ben").lines.filter((line) => line.source === "usual_pay").map((line) => dec(line.amount)));
      // 3 Mar 2026 is a Tuesday: the pay period from Mon 2 Mar counts for its hours from then, 37 of 45 (HL4; decision 10).
      const partial = divide(mul(dec(await grossSince("2026-03-02", "2026-03-08")), dec("37")), dec("45"), 10);
      expect(toFixedString(dec(eightBasis.grossEarnings), 2)).toBe(
        toFixedString(add(add(dec(untaken.amount), dec(holidays.amount)), add(add(weekPay, partial), dec(await grossSince("2026-03-09", "2026-12-13")))), 2),
      );
      expect(of(run, "ben").notes[0]).toBe("Final pay: employment finishes on 18 Dec 2026. Holiday pay owed on finishing is worked out by Tohyee from Ben Shift's leave (decision 150).");
      // Taxed as an extra pay on finishing (spec 5.12; decision 130).
      expect(of(run, "ben").extraPayBasis?.method).toBe("end_of_employment");
      approved["B:2026-12-14"] = await approve(run.id);
    });
  });

  describe("Aroha and Eru (HL10-HL15, HL20, HL22, HL26, HL27, HL42)", () => {
    it("pays Aroha from 7 Apr 2025, with her December 2025 bonus, to the week before her holiday", async () => {
      await payWeeks("A", "2025-04-07", "2026-07-06", async (run) => {
        if (run.periodStart === "2025-12-15") {
          return (await asJess((tx) => setPayRunEmployeeLines(tx, run.id, people.aroha, { lines: [{ payItemId: items.Bonus.id, amount: "2600", description: "Annual bonus (agreement)" }], keepUsualPay: true }))).payRun;
        }
        if (run.periodStart === "2026-03-09") {
          await asJess((tx) => createLeaveBooking(tx, { idempotencyKey: key("book"), employeeId: people.aroha, leaveType: "sick", startDate: "2026-03-10", endDate: "2026-03-11" }));
          return asJess((tx) => getPayRun(tx, run.id));
        }
        if (run.periodStart === "2026-06-01") {
          await asJess((tx) => createLeaveBooking(tx, { idempotencyKey: key("book"), employeeId: people.aroha, leaveType: "sick", startDate: "2026-06-02" }));
          return asJess((tx) => getPayRun(tx, run.id));
        }
      });
      const easter = approved["A:2026-04-06"];
      expect(lines(easter, "aroha")).toEqual([
        ["Ordinary time", null, "960.00", "usual_pay"],
        ["Public holiday", null, "240.00", "leave"],
      ]);
      expect(lines(easter, "eru")).toEqual([
        ["Ordinary time", "32.00", "800.00", "usual_pay"],
        ["Public holiday", null, "200.00", "leave"],
      ]);
    }, 120_000);

    it("HL11 (corrected): a week's annual holiday at AWE 65,000.00 ÷ 52 = 1,250.00, balance 4 → 3 weeks, 40 hours stored", async () => {
      await asJess((tx) => createLeaveBooking(tx, { idempotencyKey: key("book"), employeeId: people.aroha, leaveType: "annual", startDate: "2026-07-13", endDate: "2026-07-17" }));
      const run = await draft("A", "2026-07-13");
      const [annual] = leaveLines(run, "aroha");
      expect([annual.payItemName, annual.amount, annual.leave!.hours, annual.leave!.units]).toEqual(["Annual leave", "1250.00", "40", "1"]);
      expect(annual.leave!.basis).toMatchObject({
        rateUsed: "awe",
        ordinaryWeeklyPay: "1200.000000",
        averageWeeklyEarningsFrom: "2025-07-13",
        averageWeeklyEarningsTo: "2026-07-12",
        grossEarnings: "65000.000000",
        divisor: "52",
      });
      expect(lines(run, "aroha")[0]).toEqual(["Ordinary time", null, "0.00", "usual_pay"]);
      approved["A:2026-07-13"] = await approve(run.id);
      expect((await asJess((tx) => getLeaveSummary(tx, people.aroha, "2026-07-17"))).annual).toMatchObject({ weeks: "3.0000", hours: "120.00", days: "15.00", lastEntitled: "2026-04-01" });
      await payWeeks("A", "2026-07-20", "2026-08-03");
    });

    it("HL12, decision 29: a cash-up needs the written request and answer, pays 1,250.96, and a second one in the year is refused", async () => {
      const letter = (text: string) => ({ fileName: `${text}.pdf`, content: new TextEncoder().encode(`%PDF-1.4\n${text}\n%%EOF`) });
      await expect(
        asJess((tx) => createCashUp(tx, { idempotencyKey: key("cash"), employeeId: people.aroha, requestedOn: "2026-08-10", weeks: "1", request: letter("request") })),
      ).rejects.toThrow("Attach the written answer");
      const { cashUp } = await asJess((tx) =>
        createCashUp(tx, { idempotencyKey: key("cash"), employeeId: people.aroha, requestedOn: "2026-08-10", agreedOn: "2026-08-10", weeks: "1", request: letter("request"), answer: letter("answer") }),
      );
      expect(cashUp).toMatchObject({ weeks: "1", hours: "40", status: "agreed" });
      await expect(
        asJess((tx) =>
          createCashUp(tx, { idempotencyKey: key("cash"), employeeId: people.aroha, requestedOn: "2026-08-11", hours: "24", request: letter("request 2"), answer: letter("answer 2") }),
        ),
      ).rejects.toThrow(`${REFUSED}: more than 1 week cashed up in an entitlement year`);
      const run = await draft("A", "2026-08-10");
      const [line] = leaveLines(run, "aroha");
      expect([line.payItemName, line.amount, line.leave!.basis.averageWeeklyEarningsFrom]).toEqual(["Annual leave cashed up", "1250.96", "2025-08-10"]);
      // A cash-up is an extra pay (decision 151), and isn't gross earnings for holiday pay (s 14(c)(iv)).
      expect(of(run, "aroha").pay!.extraPay).toBe("1250.96");
      approved["A:2026-08-10"] = await approve(run.id);
      expect((await asJess((tx) => getLeaveSummary(tx, people.aroha, "2026-08-16"))).annual).toMatchObject({ weeks: "2.0000", cashedUpThisYear: "1.0000" });
    });

    it("HL22, HL26, HL27, HL30: sick leave carried over, bereavement, family violence leave as Special leave, Labour Day", async () => {
      expect((await asJess((tx) => getLeaveSummary(tx, people.aroha, "2026-09-30"))).sick).toMatchObject({ days: "7.00", lastEntitled: "2025-10-01" });
      await asJess((tx) => createLeaveBooking(tx, { idempotencyKey: key("book"), employeeId: people.aroha, leaveType: "bereavement", bereavementKind: "close_family", startDate: "2026-11-09", endDate: "2026-11-11" }));
      await asJess((tx) => createLeaveBooking(tx, { idempotencyKey: key("book"), employeeId: people.aroha, leaveType: "family_violence", startDate: "2026-12-01", endDate: "2026-12-02" }));
      await payWeeks("A", "2026-08-17", "2027-02-08", async (run) => {
        if (run.periodStart === "2026-12-14") {
          return (await asJess((tx) => setPayRunEmployeeLines(tx, run.id, people.aroha, { lines: [{ payItemId: items.Bonus.id, amount: "2600" }], keepUsualPay: true }))).payRun;
        }
        if (run.periodStart === "2026-12-07") {
          return (await asJess((tx) => setPayRunEmployeeLines(tx, run.id, people.eru, { lines: [{ payItemId: items.Overtime.id, quantity: "40" }], keepUsualPay: true }))).payRun;
        }
      });
      expect((await asJess((tx) => getLeaveSummary(tx, people.aroha, "2026-10-01"))).sick).toMatchObject({ days: "17.00", lastEntitled: "2026-10-01" });
      expect(leaveLines(approved["A:2026-10-26"], "aroha").map((line) => [line.payItemName, line.amount])).toEqual([["Public holiday", "240.00"]]);
      expect(leaveLines(approved["A:2026-11-09"], "aroha").map((line) => [line.payItemName, line.amount])).toEqual([
        ["Bereavement leave", "240.00"],
        ["Bereavement leave", "240.00"],
        ["Bereavement leave", "240.00"],
      ]);
      expect(leaveLines(approved["A:2026-11-30"], "aroha").map((line) => [line.payItemName, line.amount, line.leave!.type])).toEqual([
        ["Special leave", "240.00", "family_violence"],
        ["Special leave", "240.00", "family_violence"],
      ]);
      const summary = await asJess((tx) => getLeaveSummary(tx, people.aroha, "2026-12-31"));
      expect(summary.familyViolence).toEqual({ days: "8.00" });
      expect(summary.sick).toMatchObject({ days: "17.00" });
      // Eru's December overtime isn't regular (it isn't in his usual week; decision 11).
      expect(of(approved["A:2026-12-07"], "eru").lines.find((line) => line.payItemName === "Overtime")).toMatchObject({ amount: "1500.00", regular: false });
    }, 120_000);

    it("HL14, decision 15: Eru's week in advance is paid at AWE since he started, 46,500.00 ÷ 45 = 1,033.33, with a warning to keep the agreement", async () => {
      const booked = await asJess((tx) => createLeaveBooking(tx, { idempotencyKey: key("book"), employeeId: people.eru, leaveType: "annual", startDate: "2027-02-15", endDate: "2027-02-19" }));
      expect(booked.warnings).toEqual([
        "This takes Eru Advance 1.00 weeks into annual holidays in advance (s 20). Keep a written agreement that lets you recover it if they leave (decision 15).",
      ]);
      const run = await draft("A", "2027-02-15");
      const [annual] = leaveLines(run, "eru");
      expect([annual.amount, annual.leave!.inAdvance, annual.leave!.basis.section, annual.leave!.basis.divisor, annual.leave!.basis.grossEarnings]).toEqual([
        "1033.33",
        true,
        "s 22",
        "45",
        "46500.000000",
      ]);
      approved["A:2027-02-15"] = await approve(run.id);
      expect((await asJess((tx) => getLeaveSummary(tx, people.eru, "2027-02-21"))).annual).toMatchObject({ weeks: "-1.0000" });
    });

    it("HL15: Eru leaves before 12 months: 8% of 48,533.33 less the 1,033.33 in advance = 2,849.34 (s 23)", async () => {
      const run = await draft("A", "2027-02-22");
      const termination = leaveLines(run, "eru");
      expect(termination.map((line) => [line.payItemName, line.amount, line.leave!.basis.section])).toEqual([["Holiday pay owed on finishing", "2849.34", "s 23"]]);
      expect(termination[0].leave!.basis).toMatchObject({ grossEarnings: "48533.330000", advancePaid: "1033.33", since: "2026-04-06" });
      approved["A:2027-02-22"] = await approve(run.id);
      await payWeeks("A", "2027-03-01", "2027-03-15");
    });

    it("HL13: 22 Mar to 2 Apr 2027 is 2 public holidays at RDP and 1.6 weeks of annual holidays = 2 × 1,000.77; 4.4 weeks on 1 Apr 2027 (HL42)", async () => {
      await asJess((tx) => createLeaveBooking(tx, { idempotencyKey: key("book"), employeeId: people.aroha, leaveType: "annual", startDate: "2027-03-22", endDate: "2027-04-02" }));
      await payWeeks("A", "2027-03-22", "2027-03-29");
      const first = leaveLines(approved["A:2027-03-22"], "aroha");
      const second = leaveLines(approved["A:2027-03-29"], "aroha");
      expect(first.map((line) => [line.payItemName, line.amount, line.leave!.hours])).toEqual([
        ["Public holiday", "240.00", "8"],
        ["Annual leave", "1000.77", "32"],
      ]);
      expect(second.map((line) => [line.payItemName, line.amount, line.leave!.hours])).toEqual([
        ["Public holiday", "240.00", "8"],
        ["Annual leave", "1000.77", "32"],
      ]);
      expect(first[1].leave!.basis).toMatchObject({ grossEarnings: "65050.000000", averageWeeklyEarningsTo: "2027-03-21", holidayStarts: "2027-03-22" });
      const summary = await asJess((tx) => getLeaveSummary(tx, people.aroha, "2027-04-01"));
      expect(summary.annual).toMatchObject({ weeks: "4.4000", days: "22.00", lastEntitled: "2027-04-01", cashedUpThisYear: "0.0000" });
      expect(summary.sick).toMatchObject({ days: "17.00" });
      expect(summary.familyViolence).toEqual({ days: "8.00" });
      expect(summary.runningEightPercent).toMatchObject({ since: "2027-04-01", amount: "0.00" });
    }, 60_000);
  });

  describe("Cara (HL3, HL7, HL24, HL30)", () => {
    /** Cara's approved timesheet for a week: 6 hours Monday (unless `noMonday`), 8 Wednesday, 6 Friday; nothing on public holidays. */
    const caraWeek = async (monday: string, options: { noMonday?: boolean; off?: string[] } = {}) => {
      const hours: Record<string, string> = {};
      const plan: Array<[number, string]> = [[0, "6"], [2, "8"], [4, "6"]];
      for (const [offset, value] of plan) {
        const date = addDays(monday, offset);
        if (offset === 0 && options.noMonday) continue;
        if (options.off?.includes(date)) continue;
        hours[date] = value;
      }
      const opened = (await asJess((tx) => openTimesheet(tx, "owner", { idempotencyKey: key("sheet"), employeeId: people.cara, weekStart: monday }))).timesheet;
      const saved = (await asJess((tx) => saveTimesheetEntries(tx, "owner", opened.id, { version: opened.version, rows: [{ hours }] }))).timesheet;
      await asJess((tx) => submitTimesheet(tx, "owner", saved.id));
      await asJess((tx) => approveTimesheet(tx, "owner", saved.id));
    };
    const holidays = ["2026-06-01", "2026-07-10", "2026-10-26"];

    it("pays Cara from her approved timesheets, confirming the public holidays (decision 21)", async () => {
      for (let monday = "2026-05-04"; monday <= "2026-10-19"; monday = addDays(monday, 7)) {
        await caraWeek(monday, { noMonday: monday === "2026-10-12", off: holidays });
        let run = await draft("C", monday);
        const problem = of(run, "cara").problem;
        const holiday = holidays.find((date) => date >= monday && date <= addDays(monday, 6));
        if (holiday) {
          expect(problem).toContain(`would otherwise have been a working day for Cara Varies (Tohyee suggests`);
          await asJess((tx) => decidePublicHoliday(tx, { employeeId: people.cara, holidayDate: holiday, otherwiseWorking: true }));
          run = await asJess((tx) => getPayRun(tx, run.id));
        }
        expect(of(run, "cara").problem).toBeNull();
        approved[`C:${monday}`] = await approve(run.id);
      }
      expect(lines(approved["C:2026-05-11"], "cara")).toEqual([["Ordinary time", "20.00", "500.00", "typed"]]);
    }, 60_000);

    it("HL30, HL7, decisions 13, 21: on Labour Day Tohyee suggests from her last 4 Mondays; confirmed, she's paid average daily pay", async () => {
      await caraWeek("2026-10-26", { off: holidays });
      const run = await draft("C", "2026-10-26");
      expect(of(run, "cara").problem).toBe(
        "Confirm whether Labour Day on 26 Oct 2026 would otherwise have been a working day for Cara Varies (Tohyee suggests yes: worked 3 of the last 4 Mondays).",
      );
      await expect(approve(run.id)).rejects.toThrow("can't be approved yet: Confirm whether Labour Day");
      await asJess((tx) => decidePublicHoliday(tx, { employeeId: people.cara, holidayDate: "2026-10-26", otherwiseWorking: true, suggestion: "worked 3 of the last 4 Mondays" }));
      const after = await asJess((tx) => getPayRun(tx, run.id));
      const [holiday] = leaveLines(after, "cara");
      const basis = holiday.leave!.basis as Record<string, string | number>;
      expect([holiday.payItemName, basis.method, basis.from]).toEqual(["Public holiday", "adp", "2025-10-27"]);
      // 25 weeks of 3 days (less the Monday off and the holidays, which were paid) from her start.
      expect(basis.days).toBe(75 - 1);
      expect(holiday.amount).toBe(toFixedString(divide(dec(String(basis.gross)), dec(String(basis.days)), 2), 2));
      approved["C:2026-10-26"] = await approve(after.id);
    });

    it("HL10, decision 14: 3 weeks' unpaid leave moves Cara's anniversary by 21 days, unless a written agreement to count it is attached", async () => {
      expect((await asJess((tx) => getLeaveSummary(tx, people.cara, "2026-12-31"))).annual).toMatchObject({ nextEntitled: "2027-05-04" });
      await expect(
        asJess((tx) => addUnpaidLeave(tx, { idempotencyKey: key("unpaid"), employeeId: people.cara, startDate: "2027-01-04", endDate: "2027-01-24", agreedToCount: true })),
      ).rejects.toThrow("Attach the written agreement");
      const { unpaidLeave } = await asJess((tx) => addUnpaidLeave(tx, { idempotencyKey: key("unpaid"), employeeId: people.cara, startDate: "2027-01-04", endDate: "2027-01-24" }));
      expect(unpaidLeave.movesAnniversary).toBe(true);
      expect((await asJess((tx) => getLeaveSummary(tx, people.cara, "2026-12-31"))).annual).toMatchObject({ nextEntitled: "2027-05-25" });
      await asJess((tx) => cancelUnpaidLeave(tx, unpaidLeave.id));
      const agreement = { fileName: "agreement.pdf", content: new TextEncoder().encode("%PDF-1.4\nagreed\n%%EOF") };
      const agreed = await asJess((tx) =>
        addUnpaidLeave(tx, { idempotencyKey: key("unpaid"), employeeId: people.cara, startDate: "2027-01-04", endDate: "2027-01-24", agreedToCount: true, agreement }),
      );
      expect(agreed.unpaidLeave.movesAnniversary).toBe(false);
      expect((await asJess((tx) => getLeaveSummary(tx, people.cara, "2026-12-31"))).annual).toMatchObject({ nextEntitled: "2027-05-04" });
    });

    it("HL24: Cara's sick day is paid at average daily pay, and her hours vary, so Ordinary time isn't changed (a note says so)", async () => {
      await caraWeek("2026-11-02", { off: ["2026-11-04"] });
      await asJess((tx) =>
        createLeaveBooking(tx, { idempotencyKey: key("book"), employeeId: people.cara, leaveType: "sick", startDate: "2026-11-04", dayHours: { "2026-11-04": "8" } }),
      );
      const run = await draft("C", "2026-11-02");
      const [sick] = leaveLines(run, "cara");
      expect([sick.payItemName, sick.leave!.basis.method, sick.leave!.units, sick.leave!.hours]).toEqual(["Sick leave", "adp", "1", "8"]);
      expect(of(run, "cara").notes).toContain("Hours vary, so Tohyee didn't take leave and public holidays off Ordinary time: enter the hours worked.");
      approved["C:2026-11-02"] = await approve(run.id);
    });
  });

  describe("records, payslips and reports (HL40-HL42; decision 28)", () => {
    it("HL41: Ben's holiday and leave record (s 81(2)), with a CSV export audited without figures", async () => {
      const record = await asJess((tx) => getLeaveRecord(tx, people.ben));
      const entries = record.entries.map((entry) => [entry.date, entry.item, entry.entry, entry.amount]);
      expect(entries[0]).toEqual(["2025-03-03", "(b)", "Employment started", null]);
      expect(entries).toContainEqual(["2026-03-03", "(d), (e)", "Entitled to 4 weeks' annual holidays", null]);
      expect(entries).toContainEqual(["2026-10-26", "(i), (j)", "Worked Labour Day, 8 hours", "375.00"]);
      expect(entries).toContainEqual(["2026-10-26", "(k)", "Alternative holiday arose", null]);
      expect(entries).toContainEqual(["2026-11-04", "(g), (h)", "Sick leave, 1 day", "250.00"]);
      expect(entries).toContainEqual(["2026-11-05", "(g), (h)", "Sick leave, 1 day", "475.00"]);
      expect(entries).toContainEqual(["2026-11-12", "(l)", "Alternative holiday taken, 1 day", "475.00"]);
      expect(entries.at(-1)).toEqual(["2026-12-18", "(o)", "Employment ended", null]);
      const termination = record.entries.filter((entry) => entry.item === "(p)");
      expect(termination).toHaveLength(3);
      // Paid out on finishing, the balance is nothing.
      expect((await asJess((tx) => getLeaveSummary(tx, people.ben, "2026-12-18"))).annual).toMatchObject({ weeks: "0.0000" });
      expect(record.payPeriods[0]).toMatchObject({ periodStart: "2025-03-24", hours: "45.00", gross: "1380.00" });
      const csv = await asJess((tx) => exportLeaveRecord(tx, people.ben));
      expect(csv.csv.split("\r\n")[0]).toBe("Date,To,s 81(2),Entry,Hours,Amount,Pay run");
      const audit = await asJess((tx) => tx.query<{ details: Record<string, unknown> }>("select details from audit_events where event_type = 'payroll_leave_record.exported' order by id desc limit 1"));
      expect(Object.keys(audit.rows[0].details).sort()).toEqual(["rows", "sha256"]);
    });

    it("HL42, decision 28: the leave liability report shows the annual holidays' value and the running 8%, posting nothing", async () => {
      const journals = await asJess((tx) => tx.query<{ count: string }>("select count(*)::text from ledger_journals"));
      const report = await asJess((tx) => leaveLiabilityReport(tx, { asAt: "2026-12-13" }));
      const ben = report.rows.find((row) => row.employeeId === people.ben)!;
      // Ben before his final pay: 2 weeks, and 8% of his gross earnings since 3 Mar 2026.
      expect(ben.annualWeeks).toBe("2.0000");
      expect(ben.eightPercentSince).toBe("2026-03-03");
      const aroha = report.rows.find((row) => row.employeeId === people.aroha)!;
      expect(aroha).toMatchObject({ annualWeeks: "2.0000", eightPercentSince: "2026-04-01", problem: null });
      expect(report.totals.total).toBe(toFixedString(sum(report.rows.map((row) => dec(row.total))), 2));
      expect((await asJess((tx) => tx.query<{ count: string }>("select count(*)::text from ledger_journals"))).rows[0].count).toBe(journals.rows[0].count);
      const exported = await asJess((tx) => exportLeaveLiability(tx, { asAt: "2026-12-13" }));
      expect(exported.csv).toContain("Running 8%");
    });

    it("payslips show leave balances (the gap P5 left), never family violence leave (decision 27)", async () => {
      const payslip = await asJess((tx) => getPayslip(tx, approved["A:2027-03-29"].id, people.aroha));
      expect(payslip.leaveBalances).toEqual({ asAt: "2027-04-04", annualWeeks: "4.4000", annualHours: "176.00", sickDays: "17.00", alternativeHolidays: 0 });
      const layout = payslipLayout(payslip);
      expect(layout.leave).toEqual([
        ["Annual holidays", "4.4 weeks (176.00 hours)"],
        ["Sick leave", "17 days"],
      ]);
      expect(JSON.stringify(layout)).not.toMatch(/family violence/i);
      const special = await asJess((tx) => getPayslip(tx, approved["A:2026-11-30"].id, people.aroha));
      expect(payslipLayout(special).earnings.map((row) => row.label)).toContain("Special leave: Special leave 1 Dec 2026, 1 day");
    });

    it("decision 154: the employment information file's hours paid include leave hours", async () => {
      await asJess((tx) => updatePaydayFilingSettings(tx, { employerIrdNumber: "123123123", contactName: "Jess", contactPhone: "034771234", contactEmail: "payroll@example.co.nz" }));
      const file = await asJess((tx) => makePayRunPaydayFilingFile(tx, approved["A:2026-07-13"].id));
      const aroha = file.content.split("\r\n").find((line) => line.split(",")[2] === "Aroha Salary")!.split(",");
      expect(aroha[9]).toBe("4000");
    });
  });

  describe("refused rather than guessed", () => {
    it("typed holiday pay, typed leave items and typed holiday pay on finishing, for someone whose leave Tohyee keeps", async () => {
      const run = await draft("C", "2026-11-09");
      await expect(
        asJess((tx) => setPayRunEmployeeLines(tx, run.id, people.cara, { lines: [{ payItemId: items["Holiday pay"].id, amount: "100" }] })),
      ).rejects.toThrow("Tohyee keeps Cara Varies's leave, so book it under Payroll › Leave instead of typing holiday pay.");
      await expect(
        asJess((tx) => setPayRunEmployeeLines(tx, run.id, people.cara, { lines: [{ payItemId: items["Annual leave"].id, amount: "100" }] })),
      ).rejects.toThrow("Annual leave is worked out by Tohyee from leave (Payroll › Leave), not typed.");
      await asJess((tx) => updatePayRunLeave(tx, run.id));
    });

    it("leave from 6 Aug 2028 (Employment Leave Act 2026, decision 7), and leave for someone employed before Tohyee's records (opening balances, decision 143)", async () => {
      await expect(
        asJess((tx) => createLeaveBooking(tx, { idempotencyKey: key("book"), employeeId: people.cara, leaveType: "annual", startDate: "2028-08-07", dayHours: { "2028-08-07": "6" } })),
      ).rejects.toThrow(`${REFUSED}: leave from 6 Aug 2028`);
      people.old = await employee({ firstName: "Olive", lastName: "Longserving", startDate: "2019-02-04", payGroupId: groups.C });
      await asJess((tx) => addLeaveSettings(tx, people.old, { idempotencyKey: key("settings"), pattern: week(Array.from({ length: 7 }, (_, index) => ({ hours: index < 5 ? "8" : "0" }))), annualPaidInPeriod: true }));
      await expect(
        asJess((tx) => createLeaveBooking(tx, { idempotencyKey: key("book"), employeeId: people.old, leaveType: "annual", startDate: "2026-11-16" })),
      ).rejects.toThrow(`${REFUSED}: leave for Olive Longserving, whose leave entitlements began before Tohyee's first pay run for them`);
    });

    it("sick leave before 6 months without an agreement for leave in advance (s 63(3)) stops the pay run", async () => {
      people.newbie = await employee({ firstName: "Nina", lastName: "New", startDate: "2026-11-16", payGroupId: groups.C });
      await asJess((tx) => addLeaveSettings(tx, people.newbie, { idempotencyKey: key("settings"), pattern: week(Array.from({ length: 7 }, (_, index) => ({ hours: index < 5 ? "8" : "0" }))), annualPaidInPeriod: false }));
      await asJess((tx) => createLeaveBooking(tx, { idempotencyKey: key("book"), employeeId: people.newbie, leaveType: "sick", startDate: "2026-11-18" }));
      await asJess((tx) => createLeaveBooking(tx, { idempotencyKey: key("book"), employeeId: people.newbie, leaveType: "annual", startDate: "2026-11-20" }));
      const run = await draft("C", "2026-11-16");
      const problem = of(run, "newbie").problem!;
      expect(problem).toContain("isn't entitled to sick leave yet on 18 Nov 2026 (6 months' employment, s 63)");
      // Annual holidays are paid before they're taken unless agreed otherwise (s 27(1)).
      expect(problem).toContain(`${REFUSED}: paying Nina New's annual holidays`);
    });
  });

  describe("API routes (payroll access)", () => {
    it("balances, public holidays and the liability report need payroll access", async () => {
      const vic = await createTestUser("vic@payrollleave.test");
      await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'bookkeeper')", [ORG, vic.id]);
      const get = async (user: SessionUser, path: string, handler: (request: Request) => Promise<Response>) => {
        const response = await handler(apiRequest(`${path}${path.includes("?") ? "&" : "?"}organisationId=${ORG}`, { cookie: await sessionCookieFor(user) }));
        return { status: response.status, body: (await response.json()) as Record<string, unknown> };
      };
      const balances = await get(mere, "/api/payroll/leave/balances?asAt=2027-04-01", (request) => balancesRoute.GET(request, noContext));
      expect(balances.status).toBe(200);
      expect((balances.body.balances as Array<{ name: string; annual: { weeks: string } | null }>).find((row) => row.name === "Aroha Salary")!.annual!.weeks).toBe("4.4000");
      expect((await get(vic, "/api/payroll/leave/balances", (request) => balancesRoute.GET(request, noContext))).status).toBe(403);
      expect((await get(vic, "/api/payroll/leave/liability", (request) => liabilityRoute.GET(request, noContext))).status).toBe(403);
      const holidays = await get(mere, "/api/payroll/leave/public-holidays", (request) => publicHolidaysRoute.GET(request, noContext));
      expect((holidays.body.years as Array<{ year: number }>).map((year) => year.year)).toEqual([2025, 2026, 2027]);
    });

    it("a cash-up through the API is a form with the written request and answer (decision 29)", async () => {
      const form = new FormData();
      form.set("data", JSON.stringify({ organisationId: ORG, idempotencyKey: key("cash"), employeeId: people.aroha, requestedOn: "2027-04-05", weeks: "0.5" }));
      form.set("request", new File([new TextEncoder().encode("%PDF-1.4\nrequest\n%%EOF")], "request.pdf", { type: "application/pdf" }));
      form.set("answer", new File([new TextEncoder().encode("%PDF-1.4\nanswer\n%%EOF")], "answer.pdf", { type: "application/pdf" }));
      const response = await cashUpsRoute.POST(
        new Request("http://tohyee.test/api/payroll/leave/cash-ups", { method: "POST", headers: { cookie: await sessionCookieFor(mere), origin: "http://tohyee.test" }, body: form }),
        noContext,
      );
      expect(response.status).toBe(201);
      const created = (await response.json()) as { cashUp: { id: string; weeks: string; hours: string; requestFileId: string } };
      expect(created.cashUp).toMatchObject({ weeks: "0.5", hours: "20" });
      const file = await fileRoute.GET(
        apiRequest(`/api/payroll/leave/files/${created.cashUp.requestFileId}?organisationId=${ORG}`, { cookie: await sessionCookieFor(mere) }),
        params({ fileId: created.cashUp.requestFileId }) as never,
      );
      expect(file.status).toBe(200);
      expect(file.headers.get("content-type")).toBe("application/pdf");
      const cancelled = await cancelCashUpRoute.POST(
        apiRequest(`/api/payroll/leave/cash-ups/${created.cashUp.id}/cancel`, { method: "POST", cookie: await sessionCookieFor(mere), body: { organisationId: ORG } }),
        params({ cashUpId: created.cashUp.id }) as never,
      );
      expect(cancelled.status).toBe(200);
    });
  });

  /** Gross earnings for holiday pay on approved pay runs for Ben between two dates (whole periods). */
  async function grossSince(from: string, to: string): Promise<string> {
    const result = await asJess((tx) =>
      tx.query<{ total: string }>(
        `select coalesce(sum(l.amount), 0)::text as total from payroll_pay_run_lines l join payroll_pay_runs r on r.id = l.pay_run_id
           join payroll_pay_items p on p.id = l.pay_item_id
          where l.employee_id = $1 and r.status = 'approved' and p.counts_for_holiday_pay and r.period_start >= $2 and r.period_end <= $3`,
        [people.ben, from, to],
      ),
    );
    return result.rows[0].total;
  }

});
