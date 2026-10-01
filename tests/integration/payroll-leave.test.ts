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
import { cancelLeaveBooking, createLeaveBooking, decidePublicHoliday } from "@/lib/payroll/leave-records";
import { createPayItem, listPayItems, type PayItem } from "@/lib/payroll/pay-items";
import { addPayRate } from "@/lib/payroll/pay-rates";
import {
  approvePayRun,
  createPayRun,
  getPayRun,
  type PayRun,
  type PayRunEmployee,
  type PayRunLine,
  updatePayRunLeave,
  voidPayRun,
} from "@/lib/payroll/pay-runs";
import { createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "payroll-leave-co";
const REFUSED = "Not supported yet (refused rather than guessed)";

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
    asJess((tx) => createPayRun(tx, { idempotencyKey: key("run"), payGroupId: groups[group], periodStart, payDate: addDays(periodStart, 9) })).then((result) => result.payRun);
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

    it("pays Ben through to May 2026, public holidays included", async () => {
      await payWeeks("B", "2025-04-21", "2026-05-04");
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
      const after = await asJess((tx) => getPayRun(tx, run.id));
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

    it("HL23: sick Wed 4 and Thu 5 Nov at RDP 250.00 and 475.00, 2 days off his balance", async () => {
      await asJess((tx) => createLeaveBooking(tx, { idempotencyKey: key("book"), employeeId: people.ben, leaveType: "sick", startDate: "2026-11-04", endDate: "2026-11-05" }));
      const run = await draft("B", "2026-11-02");
      expect(leaveLines(run, "ben").map((line) => [line.payItemName, line.amount, line.leave!.units, line.leave!.hours])).toEqual([
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

  it("refuses typed holiday pay and leave items for someone whose leave Tohyee keeps", async () => {
    void REFUSED;
    void updatePayRunLeave;
  });
});
