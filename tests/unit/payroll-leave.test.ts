import { describe, expect, it } from "vitest";
import { dec, mul, sum, toFixedString, toPlainString } from "@/lib/money/decimal";
import {
  annualEntitlement,
  annualEntitlementDates,
  annualHolidayPay,
  checkCashUp,
  divisorReduction,
  earnedTowardsNext,
  employedTwelveMonths,
  entitlementYear,
  terminationHolidayPay,
  unpaidLeaveCounts,
} from "@/lib/payroll/leave/annual";
import { addDays, daysBetween, eachDay } from "@/lib/payroll/leave/dates";
import {
  averageDailyPay,
  averageWeeklyEarnings,
  averageWeeklyEarningsSinceStart,
  type DayWeight,
  fourWeekOrdinaryPay,
  greaterOf,
  type PeriodEarnings,
  twelveMonthsTo,
} from "@/lib/payroll/leave/earnings";
import {
  holidaysInUntakenLeave,
  observedHolidays,
  publicHolidayWorkedPay,
  suggestOtherwiseWorkingDay,
  wouldWorkFromPattern,
} from "@/lib/payroll/leave/public-holidays";
import { addLeave, compareLeave, leaveHours, leaveUnits, NO_LEAVE, subtractLeave, unitsOf } from "@/lib/payroll/leave/quantity";
import { assertHolidaysAct, holidaysActApplies } from "@/lib/payroll/leave/rules";
import {
  BEREAVEMENT_DAYS,
  dayLeaveTaken,
  days,
  familyViolenceLeaveBalance,
  hoursTestMet,
  partDaySickPay,
  sickEntitlementDates,
  sickLeaveBalance,
} from "@/lib/payroll/leave/sick";
import {
  mondayToFriday,
  ordinaryWeeklyPay,
  type PatternExtra,
  payForTimeWorked,
  relevantDailyPay,
  usualHoursOn,
  weekDays,
  weekHours,
  type WorkPattern,
} from "@/lib/payroll/leave/work-pattern";

const REFUSED = "Not supported yet (refused rather than guessed)";
const money = (value: ReturnType<typeof dec>) => toFixedString(value, 2);
const four = (value: ReturnType<typeof dec>) => toFixedString(value, 4);

/**
 * Examples HL1-HL42 in docs/ACCOUNTING-EXAMPLES.md ("Holidays Act leave"),
 * the pure calculations, with decisions 7-29 they cite. The database flows
 * are in tests/integration/payroll-leave.test.ts.
 */

// The people (weekly pay, Monday to Sunday periods).
const aroha = mondayToFriday("8");
const arohaRate = { payBasis: "salary" as const, annualSalary: "62400", hourlyRate: null };
const overtime = (regular: boolean): PatternExtra => ({
  payItemId: "ot",
  name: "Overtime",
  kind: "overtime",
  hours: "5",
  multiplier: "1.5",
  amount: null,
  regular,
});
const shift: PatternExtra = { payItemId: "shift", name: "Shift allowance", kind: "allowance", hours: null, multiplier: null, amount: "10", regular: true };
const benPattern = (regularOvertime = true): WorkPattern => ({
  kind: "fixed",
  days: [0, 1, 2, 3, 4, 5, 6].map((index) => ({
    ordinaryHours: index < 5 ? "8" : "0",
    extras: index < 5 ? (index === 3 ? [overtime(regularOvertime), shift] : [shift]) : [],
  })),
});
const ben = benPattern();
const benRate = { payBasis: "hourly" as const, annualSalary: null, hourlyRate: "30" };
const fiona: WorkPattern = { kind: "fixed", days: [0, 1, 2, 3, 4, 5, 6].map((index) => ({ ordinaryHours: index >= 1 && index <= 3 ? "6" : "0", extras: [] })) };
const cara: WorkPattern = { kind: "varies", weekHours: "40", weekDays: "5" };

/** Weekly pay periods (Monday to Sunday) from `firstMonday`, `count` of them, each with its gross. */
function weeks(firstMonday: string, grosses: readonly string[], irregular: readonly string[] = []): PeriodEarnings[] {
  return grosses.map((gross, index) => ({
    periodStart: addDays(firstMonday, 7 * index),
    periodEnd: addDays(firstMonday, 7 * index + 6),
    gross,
    irregular: irregular[index] ?? "0",
  }));
}
const weightFrom = (pattern: WorkPattern): DayWeight => (date) => (pattern.kind === "fixed" ? usualHoursOn(pattern, date) : null);

describe("which law (decision 7)", () => {
  it("the Holidays Act 2003 applies to pay periods starting before 6 Aug 2028, and the Employment Leave Act 2026 is refused", () => {
    expect(holidaysActApplies("2028-08-05")).toBe(true);
    expect(holidaysActApplies("2028-08-06")).toBe(false);
    expect(() => assertHolidaysAct("2028-08-07")).toThrow(`${REFUSED}: leave in a pay period starting on or after 6 Aug 2028`);
  });
});

describe("the pay rates (HL1-HL8)", () => {
  it("HL1: Aroha's ordinary weekly pay is her salary for a week; her bonus and employer KiwiSaver aren't in it", () => {
    expect(money(ordinaryWeeklyPay(aroha, arohaRate))).toBe("1200.00");
  });

  it("HL2: Ben's regular overtime and shift allowance are in his ordinary weekly pay; occasional overtime isn't (decision 11)", () => {
    expect(money(ordinaryWeeklyPay(ben, benRate))).toBe("1475.00");
    expect(money(ordinaryWeeklyPay(benPattern(false), benRate))).toBe("1250.00");
  });

  it("HL3: Cara's ordinary weekly pay by the four-week formula: (3,600.00 − 320.00) ÷ 4 (s 8(2); decision 12)", () => {
    const periods = weeks("2026-06-08", ["900", "900", "900", "900"], ["0", "200", "120", "0"]);
    const result = fourWeekOrdinaryPay({ periods, windowEnd: "2026-07-05", weight: weightFrom(cara) });
    expect(money(result.gross)).toBe("3600.00");
    expect(money(result.irregular)).toBe("320.00");
    expect(money(result.weekly)).toBe("820.00");
  });

  it("HL4: Ben's average weekly earnings over the 12 calendar months to Sun 13 Dec 2026, a partial pay period counted by its hours (decision 10)", () => {
    expect(twelveMonthsTo("2026-12-13")).toEqual({ from: "2025-12-14", to: "2026-12-13" });
    // 26 weeks at 28.00 (1,120.00 + overtime 210.00) then 26 at 30.00 (1,200.00 + 225.00); 245 shifts; the bonus.
    const grosses = Array.from({ length: 52 }, (_, index) => (index < 26 ? "1330" : "1425"));
    const periods = weeks("2025-12-15", grosses);
    periods[10] = { ...periods[10], gross: "4330" }; // the 3,000.00 bonus his agreement binds the employer to pay
    periods[20] = { ...periods[20], gross: "3780" }; // 2,450.00 of shift allowances, as one figure
    // The pay period 8-14 Dec 2025 is only partly inside: its Sunday, which Ben doesn't work.
    const before: PeriodEarnings = { periodStart: "2025-12-08", periodEnd: "2025-12-14", gross: "1380", irregular: "0" };
    const result = averageWeeklyEarnings({ periods: [before, ...periods], windowEnd: "2026-12-13", weight: weightFrom(ben) });
    expect(money(result.gross)).toBe("77080.00");
    expect(four(result.weekly)).toBe("1482.3077");
    expect(money(result.weekly)).toBe("1482.31");
  });

  it("HL5: a pay rise just before leave: ordinary weekly pay 1,280.00 beats average weekly earnings 1,021.54 (s 21(2)(b))", () => {
    const grosses = [...Array.from({ length: 48 }, () => "1000"), "1280", "1280", "1280", "1280"];
    const awe = averageWeeklyEarnings({ periods: weeks("2025-07-07", grosses), windowEnd: "2026-07-05", weight: weightFrom(aroha) });
    expect(money(awe.gross)).toBe("53120.00");
    expect(money(awe.weekly)).toBe("1021.54");
    const owp = dec("1280");
    expect(greaterOf(owp, awe.weekly)).toEqual({ rate: owp, source: "owp" });
    expect(annualHolidayPay({ hours: "40", weekHours: "40", weeklyRate: owp }).amount).toBe("1280.00");
  });

  it("HL6: relevant daily pay includes the day's overtime and allowances; a Saturday isn't a working day (s 9)", () => {
    expect(money(relevantDailyPay(ben, benRate, "2026-11-04")!)).toBe("250.00"); // Wednesday
    expect(money(relevantDailyPay(ben, benRate, "2026-11-05")!)).toBe("475.00"); // Thursday
    expect(relevantDailyPay(ben, benRate, "2026-11-07")).toBeNull(); // Saturday
    expect(money(relevantDailyPay(aroha, arohaRate, "2026-07-08")!)).toBe("240.00");
  });

  it("HL7: Cara's average daily pay, 41,600.00 ÷ 208 days (s 9A(2))", () => {
    expect(money(averageDailyPay({ gross: "41600", days: 208 })!)).toBe("200.00");
    expect(averageDailyPay({ gross: "0", days: 0 })).toBeNull();
  });

  it("HL8: entitlements in the Act's units with hours stored: Aroha's 4 weeks are 20 days or 160 hours, Fiona's 12 days or 72 hours (decision 8)", () => {
    expect(toPlainString(weekHours(aroha))).toBe("40");
    expect(toPlainString(weekDays(aroha))).toBe("5");
    expect(toPlainString(weekHours(fiona))).toBe("18");
    expect(toPlainString(weekDays(fiona))).toBe("3");
    const arohaFour = annualEntitlement("40");
    expect(toPlainString(unitsOf(arohaFour, 4))).toBe("4");
    expect([...arohaFour.values()].map(toPlainString)).toEqual(["160"]);
    expect([...annualEntitlement("18").values()].map(toPlainString)).toEqual(["72"]);
    expect(toPlainString(weekHours(ben))).toBe("45");
  });
});

describe("annual holidays (HL10-HL16)", () => {
  const unpaid = { start: "2026-02-02", end: "2026-02-22", statutory: false, agreedToCount: false };

  it("HL10: 4 weeks after each 12 months; 3 weeks' unpaid leave moves the anniversary by the whole 21 days (decision 14)", () => {
    expect(annualEntitlementDates("2025-04-01", [], "2027-12-31")).toEqual(["2026-04-01", "2027-04-01"]);
    expect(unpaidLeaveCounts(unpaid)).toBe(false);
    expect(annualEntitlementDates("2025-04-01", [unpaid], "2027-12-31")).toEqual(["2026-04-22", "2027-04-22"]);
    // A week or less counts (s 16(2)(a)(vi)), and so does unpaid sick leave (s 16(2)(a)(v)).
    expect(annualEntitlementDates("2025-04-01", [{ ...unpaid, end: "2026-02-08" }], "2026-12-31")).toEqual(["2026-04-01"]);
    expect(annualEntitlementDates("2025-04-01", [{ ...unpaid, statutory: true }], "2026-12-31")).toEqual(["2026-04-01"]);
    // Without an agreement the AWE divisor stays 52; with one, the anniversary stays and the divisor drops to 50 (s 16(3)).
    const window = { from: "2025-07-06", to: "2026-07-05" };
    expect(divisorReduction([unpaid], window)).toBe(0);
    const agreed = { ...unpaid, agreedToCount: true };
    expect(annualEntitlementDates("2025-04-01", [agreed], "2026-12-31")).toEqual(["2026-04-01"]);
    expect(divisorReduction([agreed], window)).toBe(2);
    const awe = averageWeeklyEarnings({ periods: weeks("2025-07-07", Array(52).fill("1200")), windowEnd: "2026-07-05", weight: weightFrom(aroha), divisorReduction: "2" });
    expect(toPlainString(awe.divisor)).toBe("50");
  });

  it("HL11: a week's holiday paid at the greater of OWP 1,200.00 and AWE 65,000.00 ÷ 52 = 1,250.00; balance 4 → 3 weeks, 40 hours stored", () => {
    const grosses = Array(52).fill("1200");
    grosses[24] = "3800"; // her December 2025 bonus, 2,600.00
    const awe = averageWeeklyEarnings({ periods: weeks("2025-07-07", grosses), windowEnd: "2026-07-05", weight: weightFrom(aroha) });
    expect(awe.from).toBe("2025-07-06");
    expect(money(awe.gross)).toBe("65000.00");
    const rate = greaterOf(ordinaryWeeklyPay(aroha, arohaRate), awe.weekly);
    expect(rate.source).toBe("awe");
    const pay = annualHolidayPay({ hours: "40", weekHours: "40", weeklyRate: rate.rate });
    expect(pay.amount).toBe("1250.00");
    expect(toPlainString(pay.weeks)).toBe("1");
    const balance = subtractLeave(annualEntitlement("40"), pay.quantity);
    expect(toPlainString(unitsOf(balance, 4))).toBe("3");
  });

  it("HL12: a cash-up paid at the s 21(2) rate (65,050.00 ÷ 52 = 1,250.96), at most 1 week a year, never in advance or against a policy (decision 29)", () => {
    const weekly = averageWeeklyEarnings({
      periods: [{ periodStart: "2025-08-11", periodEnd: "2026-08-09", gross: "65050", irregular: "0" }],
      windowEnd: "2026-08-09",
      weight: weightFrom(aroha),
    });
    expect(four(weekly.weekly)).toBe("1250.9615");
    expect(annualHolidayPay({ hours: "40", weekHours: "40", weeklyRate: weekly.weekly }).amount).toBe("1250.96");
    // Part of a week: 3 days (24 of 40 hours) = 0.6 week = 750.58.
    const part = annualHolidayPay({ hours: "24", weekHours: "40", weeklyRate: weekly.weekly });
    expect(part.amount).toBe("750.58");
    expect(toPlainString(part.weeks)).toBe("0.6");
    expect(money(weekly.gross)).toBe("65050.00");
    const balance = leaveUnits("3", "40");
    const base = { weeks: "1", cashedUpThisYear: "0", entitledBalance: balance, weekHours: "40", noCashUpPolicy: false, hasEntitlement: true };
    expect(() => checkCashUp(base)).not.toThrow();
    expect(() => checkCashUp({ ...base, cashedUpThisYear: "1" })).toThrow(`${REFUSED}: more than 1 week cashed up in an entitlement year`);
    expect(() => checkCashUp({ ...base, weeks: "0.4", cashedUpThisYear: "0.6" })).not.toThrow();
    expect(() => checkCashUp({ ...base, noCashUpPolicy: true })).toThrow("s 28E");
    expect(() => checkCashUp({ ...base, hasEntitlement: false })).toThrow("s 28A(1)");
    expect(() => checkCashUp({ ...base, entitledBalance: leaveUnits("0.5", "40") })).toThrow("holidays in advance can't be cashed up");
    expect(entitlementYear(["2026-04-01", "2027-04-01"], "2026-08-10")).toEqual({ from: "2026-04-01", to: "2027-03-31" });
  });

  it("HL13: public holidays in annual holidays are public holidays; the other 8 days are 1.6 weeks = 2,001.54; part weeks by hours (decision 9)", () => {
    const { holidays } = observedHolidays({ from: "2027-03-22", to: "2027-04-02", region: "wellington", wouldWork: wouldWorkFromPattern(aroha) });
    expect(holidays.map((holiday) => holiday.date)).toEqual(["2027-03-26", "2027-03-29"]);
    const holidayPay = holidays.map((holiday) => relevantDailyPay(aroha, arohaRate, holiday.date)!);
    expect(money(sum(holidayPay))).toBe("480.00");
    expect(holidayPay.map(money)).toEqual(["240.00", "240.00"]);
    const days = eachDay("2027-03-22", "2027-04-02").filter((date) => usualHoursOn(aroha, date).units > BigInt(0) && !holidays.some((holiday) => holiday.date === date));
    expect(days).toHaveLength(8);
    const pay = annualHolidayPay({ hours: "64", weekHours: "40", weeklyRate: averageWeeklyEarnings({ periods: [{ periodStart: "2026-03-23", periodEnd: "2027-03-21", gross: "65050", irregular: "0" }], windowEnd: "2027-03-21", weight: weightFrom(aroha) }).weekly });
    expect(toPlainString(pay.weeks)).toBe("1.6");
    expect(pay.amount).toBe("2001.54");
    // Balance 2 → 0.4 weeks, then 4.4 weeks when the next 4 arise on Thu 1 Apr 2027.
    const after = subtractLeave(leaveUnits("2", "40"), pay.quantity);
    expect(toPlainString(unitsOf(after, 4))).toBe("0.4");
    expect(toPlainString(unitsOf(addLeave(after, annualEntitlement("40")), 4))).toBe("4.4");
    // Ben's Thursday (13 hours) and Wednesday (8 hours) at AWE 77,080.00 ÷ 52.
    const rate = averageWeeklyEarnings({ periods: [{ periodStart: "2025-12-15", periodEnd: "2026-12-13", gross: "77080", irregular: "0" }], windowEnd: "2026-12-13", weight: weightFrom(ben) }).weekly;
    const thursday = annualHolidayPay({ hours: "13", weekHours: "45", weeklyRate: rate });
    const wednesday = annualHolidayPay({ hours: "8", weekHours: "45", weeklyRate: rate });
    expect(thursday.amount).toBe("428.22");
    expect(four(thursday.weeks)).toBe("0.2889");
    expect(wednesday.amount).toBe("263.52");
    expect(four(wednesday.weeks)).toBe("0.1778");
    // Four Wednesdays and a Thursday are exactly one week.
    const week = addLeave(wednesday.quantity, wednesday.quantity, wednesday.quantity, wednesday.quantity, thursday.quantity);
    expect(compareLeave(week, leaveUnits("1", "45"))).toBe(0);
    // Counting days instead (÷ 5) would pay 296.46 each.
    expect(toFixedString(dec(toFixedString(rate, 10)), 2)).toBe("1482.31");
    expect(money(mul(rate, dec("0.2")))).toBe("296.46");
  });

  it("HL14: holidays in advance before 12 months: AWE since the start ÷ 45 weeks = 1,033.33; a warning only above 3.45 weeks earned (decision 15)", () => {
    expect(daysBetween("2026-04-06", "2027-02-15")).toBe(315);
    expect(employedTwelveMonths("2026-04-06", "2027-02-15")).toBe(false);
    const grosses = Array(45).fill("1000");
    grosses[36] = "2500"; // 1,500.00 occasional overtime in December 2026
    const awe = averageWeeklyEarningsSinceStart({ periods: weeks("2026-04-06", grosses), startDate: "2026-04-06", windowEnd: "2027-02-14", weight: weightFrom(aroha) });
    expect(toPlainString(awe.divisor)).toBe("45");
    expect(money(awe.gross)).toBe("46500.00");
    expect(money(awe.weekly)).toBe("1033.33");
    const pay = annualHolidayPay({ hours: "40", weekHours: "40", weeklyRate: greaterOf(dec("1000"), awe.weekly).rate });
    expect(pay.amount).toBe("1033.33");
    expect(toFixedString(earnedTowardsNext("2026-04-06", "2027-02-15"), 2)).toBe("3.45");
    const balance = subtractLeave(NO_LEAVE, pay.quantity);
    expect(toPlainString(unitsOf(balance, 4))).toBe("-1");
  });

  it("HL15: leaving before 12 months: 8% of 48,533.33 less 1,033.33 in advance = 2,849.34 (s 23); more advance than 8% isn't deducted without consent (decision 16)", () => {
    const result = terminationHolidayPay({
      entitled: false,
      untaken: NO_LEAVE,
      weekHours: "40",
      owp: dec("1000"),
      awe: dec("0"),
      publicHolidays: [],
      grossSince: dec("48533.33"),
      grossSinceDate: "2026-04-06",
      advancePaid: dec("1033.33"),
      alternativeHolidays: [],
    });
    expect(result.parts.map((part) => [part.kind, part.amount])).toEqual([["eight_percent", "2849.34"]]);
    expect(result.total).toBe("2849.34");
    expect(result.advanceExcess).toBeNull();
    const over = terminationHolidayPay({
      entitled: false,
      untaken: NO_LEAVE,
      weekHours: "40",
      owp: dec("1000"),
      awe: dec("0"),
      publicHolidays: [],
      grossSince: dec("5000"),
      grossSinceDate: "2026-04-06",
      advancePaid: dec("1033.33"),
      alternativeHolidays: [],
    });
    expect(over.total).toBe("0.00");
    expect(over.advanceExcess).toBe("633.33");
  });

  it("HL16: leaving after an entitlement: 2 weeks untaken 2,964.62 (s 24) + 4 public holidays 1,000.00 (s 40(3)) + 8% 5,291.57 (s 25, s 26) = 9,256.19 (decisions 17, 18)", () => {
    const untaken = leaveUnits("2", "45");
    expect([...untaken.values()].map(toPlainString)).toEqual(["90"]);
    const walk = holidaysInUntakenLeave({ finishDate: "2026-12-18", hours: dec("90"), pattern: ben, region: "wellington" });
    expect(walk.holidays.map((holiday) => holiday.date)).toEqual(["2026-12-25", "2026-12-28", "2027-01-01", "2027-01-04"]);
    expect(walk.lastDay).toBe("2027-01-07");
    const holidayPays = walk.holidays.map((holiday) => ({ date: holiday.date, name: holiday.name, pay: relevantDailyPay(ben, benRate, holiday.date)! }));
    expect(holidayPays.map((holiday) => money(holiday.pay))).toEqual(["250.00", "250.00", "250.00", "250.00"]);
    const awe = averageWeeklyEarnings({ periods: [{ periodStart: "2025-12-15", periodEnd: "2026-12-13", gross: "77080", irregular: "0" }], windowEnd: "2026-12-13", weight: weightFrom(ben) });
    const result = terminationHolidayPay({
      entitled: true,
      untaken,
      weekHours: "45",
      owp: ordinaryWeeklyPay(ben, benRate),
      awe: awe.weekly,
      publicHolidays: holidayPays,
      grossSince: dec("62180"),
      grossSinceDate: "2026-03-03",
      advancePaid: dec("0"),
      alternativeHolidays: [],
    });
    expect(result.parts.map((part) => [part.kind, part.amount])).toEqual([
      ["untaken_entitlement", "2964.62"],
      ["public_holidays", "1000.00"],
      ["eight_percent", "5291.57"],
    ]);
    expect(result.total).toBe("9256.19");
    expect(result.parts[0].basis.rateUsed).toBe("awe");
    // Leaving the public holidays out would have given 5,211.57.
    expect(money(mul(dec("65144.62"), dec("0.08")))).toBe("5211.57");
  });
});

describe("sick, bereavement and family violence leave (HL20-HL27)", () => {
  it("HL20: 10 days after 6 months (Wed 1 Oct 2025), then every 12 months", () => {
    expect(sickEntitlementDates("2025-04-01", "2027-12-31")).toEqual(["2025-10-01", "2026-10-01", "2027-10-01"]);
  });

  it("HL21: the hours test for someone without 6 months' continuous employment, by calendar months (decision 20)", () => {
    const from = "2026-01-01";
    // Some work in every 7-day block from 1 Jan, 12+ hours a week on average.
    const weekly: Record<string, string> = {};
    for (let index = 0; index < 26; index += 1) weekly[addDays(from, index * 7 + 2)] = "12";
    expect(hoursTestMet(weekly, from)).toMatchObject({ met: true });
    // A week with no work: the monthly test decides.
    const gap = { ...weekly };
    delete gap[addDays(from, 2)];
    gap[addDays(from, 9)] = "24";
    expect(hoursTestMet(gap, from)).toMatchObject({ met: true, reason: expect.stringContaining("every calendar month") });
    const short = { ...gap };
    for (const date of Object.keys(short)) if (date.startsWith("2026-02")) short[date] = "8";
    expect(hoursTestMet(short, from).met).toBe(false);
    expect(hoursTestMet({}, from)).toMatchObject({ met: false, reason: expect.stringContaining("at least 10 needed") });
  });

  it("HL22: 3 days used leaves 7 to carry: 17 days; unused, up to 10 carry to at most 20 and 7 lapse", () => {
    const dates = sickEntitlementDates("2025-04-01", "2027-12-31");
    const taken = ["2026-03-10", "2026-03-11", "2026-06-02"].map((date) => ({ date, quantity: days("1") }));
    const in2026 = sickLeaveBalance(dates, taken, "2026-10-01");
    expect(toPlainString(unitsOf(in2026.balance, 4))).toBe("17");
    const in2027 = sickLeaveBalance(dates, taken, "2027-10-01");
    expect(toPlainString(unitsOf(in2027.balance, 4))).toBe("20");
    const last = in2027.events.at(-1)!;
    expect(last.kind === "entitled" && toPlainString(unitsOf(last.lapsed, 4))).toBe("7");
  });

  it("HL23: two sick days at RDP 250.00 + 475.00; a part day takes a whole day unless a part-day agreement is recorded (decision 19)", () => {
    const pay = ["2026-11-04", "2026-11-05"].map((date) => relevantDailyPay(ben, benRate, date)!);
    expect(money(pay[0])).toBe("250.00");
    expect(money(pay[1])).toBe("475.00");
    expect(toPlainString(unitsOf(dayLeaveTaken({ hoursOff: "4", dayHours: "8", partDayAgreed: false }), 4))).toBe("1");
    const half = dayLeaveTaken({ hoursOff: "4", dayHours: "8", partDayAgreed: true });
    expect(toPlainString(unitsOf(half, 4))).toBe("0.5");
    // His pay that day is still RDP 250.00: 4 hours worked (120.00), the shift allowance (10.00), and 120.00 sick leave.
    const worked = payForTimeWorked(ben, benRate, "2026-11-18", "4");
    expect(money(worked)).toBe("130.00");
    expect(money(partDaySickPay(relevantDailyPay(ben, benRate, "2026-11-18")!, worked))).toBe("120.00");
  });

  it("HL24: Cara's sick day at ADP 200.00 (decision 13)", () => {
    expect(money(averageDailyPay({ gross: "41600", days: 208 })!)).toBe("200.00");
  });

  it("HL26: bereavement: 3 days for close family or a pregnancy loss, 1 for anyone else; at RDP 3 × 240.00 = 720.00", () => {
    expect(BEREAVEMENT_DAYS).toEqual({ close_family: 3, pregnancy_loss: 3, other: 1 });
    const pay = eachDay("2026-11-09", "2026-11-11").map((date) => relevantDailyPay(aroha, arohaRate, date)!);
    expect(money(sum(pay))).toBe("720.00");
  });

  it("HL27: family violence leave is its own balance of 10 days, not carried over; 2 days taken leave 8 (decision 27)", () => {
    const dates = sickEntitlementDates("2025-04-01", "2027-12-31");
    const taken = [{ date: "2026-12-01", quantity: days("1") }, { date: "2026-12-02", quantity: days("1") }];
    expect(toPlainString(unitsOf(familyViolenceLeaveBalance(dates, taken, "2027-04-01").balance, 4))).toBe("8");
    expect(toPlainString(unitsOf(familyViolenceLeaveBalance(dates, taken, "2027-10-01").balance, 4))).toBe("10");
    expect(toPlainString(unitsOf(sickLeaveBalance(dates, [], "2027-04-01").balance, 4))).toBe("20");
    expect(money(relevantDailyPay(aroha, arohaRate, "2026-12-01")!)).toBe("240.00");
  });
});

describe("public holidays and alternative holidays (HL30-HL33)", () => {
  it("HL30: Labour Day 2026 is paid for Aroha, not for Fiona; for Cara Tohyee suggests from her recent Mondays and the person running pay confirms (decision 21)", () => {
    const labourDay = "2026-10-26";
    const aroha30 = observedHolidays({ from: labourDay, to: labourDay, region: null, wouldWork: wouldWorkFromPattern(aroha) });
    expect(aroha30.holidays.map((holiday) => holiday.name)).toEqual(["Labour Day"]);
    expect(wouldWorkFromPattern(aroha)(labourDay)).toBe(true);
    expect(wouldWorkFromPattern(fiona)(labourDay)).toBe(false);
    expect(wouldWorkFromPattern(cara)(labourDay)).toBeNull();
    const hours: Record<string, string> = { "2026-09-28": "6", "2026-10-05": "7", "2026-10-19": "5" };
    expect(suggestOtherwiseWorkingDay(labourDay, hours)).toEqual({ suggested: true, basis: "worked 3 of the last 4 Mondays" });
    expect(suggestOtherwiseWorkingDay(labourDay, { "2026-10-19": "5" })).toEqual({ suggested: false, basis: "worked 1 of the last 4 Mondays" });
  });

  it("HL31: holidays falling on a weekend move for someone who doesn't work weekends (s 45, s 45A), not for George, who works Saturdays", () => {
    const { holidays } = observedHolidays({ from: "2026-12-01", to: "2027-06-30", region: null, wouldWork: wouldWorkFromPattern(aroha) });
    expect(holidays.map((holiday) => `${holiday.date} ${holiday.name}`)).toEqual([
      "2026-12-25 Christmas Day",
      "2026-12-28 Boxing Day",
      "2027-01-01 New Year's Day",
      "2027-01-04 Day after New Year's Day",
      "2027-02-08 Waitangi Day",
      "2027-03-26 Good Friday",
      "2027-03-29 Easter Monday",
      "2027-04-26 ANZAC Day",
      "2027-06-07 King's Birthday",
      "2027-06-25 Matariki",
    ]);
    const george = observedHolidays({ from: "2026-12-26", to: "2026-12-26", region: null, wouldWork: (date) => date === "2026-12-26" });
    expect(george.holidays.map((holiday) => holiday.date)).toEqual(["2026-12-26"]);
    // Christmas 2027 falls on a Saturday and Boxing Day on a Sunday: Monday 27 and Tuesday 28 Dec (s 45(1)(b), (d)).
    const christmas2027 = observedHolidays({ from: "2027-12-20", to: "2027-12-31", region: null, wouldWork: wouldWorkFromPattern(aroha) });
    expect(christmas2027.holidays.map((holiday) => holiday.date)).toEqual(["2027-12-27", "2027-12-28"]);
    // Someone whose days vary: the move is for the person running pay to decide.
    const varies = observedHolidays({ from: "2026-12-21", to: "2027-01-10", region: null, wouldWork: () => null });
    expect(varies.uncertain.map((holiday) => holiday.date)).toEqual(["2026-12-26", "2026-12-28", "2027-01-02", "2027-01-04"]);
    // The anniversary day comes from the region (decision 22), and years Tohyee doesn't have are refused.
    expect(observedHolidays({ from: "2027-01-25", to: "2027-01-25", region: "wellington", wouldWork: wouldWorkFromPattern(aroha) }).holidays.map((holiday) => holiday.name)).toEqual([
      "Wellington Anniversary Day",
    ]);
    expect(() => observedHolidays({ from: "2028-01-03", to: "2028-01-09", region: null, wouldWork: wouldWorkFromPattern(aroha) })).toThrow(`${REFUSED}: public holidays in 2028`);
  });

  it("HL32: working a public holiday pays the greater of time and a half and the penal rate (s 50; decision 23)", () => {
    const labourDay = "2026-10-26";
    const full = payForTimeWorked(ben, benRate, labourDay, "8");
    expect(money(full)).toBe("250.00");
    expect(money(publicHolidayWorkedPay({ payForTime: full, hoursWorked: "8" }).amount)).toBe("375.00");
    // Double time in his agreement (a penal rate of 30.00 an hour): (b) 8 × 60.00 + 10.00 = 490.00 wins.
    expect(money(publicHolidayWorkedPay({ payForTime: full, hoursWorked: "8", penalHourlyRate: "30" }).amount)).toBe("490.00");
    // Fiona, 6 hours on a day that isn't otherwise a working day for her: 6 × 27.00 × 1.5.
    const fionaRate = { payBasis: "hourly" as const, annualSalary: null, hourlyRate: "27" };
    expect(money(publicHolidayWorkedPay({ payForTime: payForTimeWorked(fiona, fionaRate, labourDay, "6"), hoursWorked: "6" }).amount)).toBe("243.00");
    // Ben works 4 of his 8 hours: (4 × 30.00 + 10.00) × 1.5; nothing automatic for the rest of the day.
    expect(money(publicHolidayWorkedPay({ payForTime: payForTimeWorked(ben, benRate, labourDay, "4"), hoursWorked: "4" }).amount)).toBe("195.00");
  });

  it("HL33: an alternative holiday is paid at RDP for the day taken (Thursday 475.00), counted in days with the day's hours stored (decisions 24, 25)", () => {
    expect(money(relevantDailyPay(ben, benRate, "2026-11-12")!)).toBe("475.00");
    expect(money(relevantDailyPay(ben, benRate, "2026-11-11")!)).toBe("250.00");
    const thursday = leaveHours("13", "13");
    expect(toPlainString(unitsOf(thursday, 4))).toBe("1");
    expect([...thursday.values()].map(toPlainString)).toEqual(["13"]);
    // Untaken when he leaves on Friday 18 Dec 2026: RDP for his last day, 250.00 (s 60(2)(b)).
    expect(money(relevantDailyPay(ben, benRate, "2026-12-18")!)).toBe("250.00");
    // Exchanged for money only from 12 months after it arose (s 61(2)(a)); the default is RDP for the exchange date.
    expect(addDays("2026-10-26", 365)).toBe("2027-10-26");
    expect(money(relevantDailyPay(ben, benRate, "2027-10-27")!)).toBe("250.00");
  });
});

describe("records and balances (HL40-HL42)", () => {
  it("HL42: the running 8% since the last anniversary (Ben, before his final pay: 8% × 62,180.00 = 4,974.40)", () => {
    expect(money(mul(dec("62180"), dec("0.08")))).toBe("4974.40");
    expect(toPlainString(unitsOf(addLeave(leaveUnits("0.4", "40"), annualEntitlement("40")), 4))).toBe("4.4");
    expect(unitsOf(NO_LEAVE).units).toBe(BigInt(0));
  });
});
