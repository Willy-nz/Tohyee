import { addDays } from "@/lib/financial-year";
import { incomeYearLabel } from "@/lib/rd/amounts";

/**
 * R&D Tax Incentive due dates and reminders (examples RD24, RD25, RD41;
 * decisions 48, 49, 73). Pure and browser-safe.
 *
 * Worked out only for a 31 March balance date (decision 73). Sources:
 * - IRD, "R&D tax incentive due dates" (last updated 1 Apr 2026, read 1 Oct
 *   2026): general approval "due no later than the last day of the 3rd month
 *   following the end of the 1st income year" (31 March: 30 June); criteria
 *   and methodologies "due the last day of the 6th month before the end of
 *   the 1st income year" (31 March: 30 September the year before);
 *   supplementary return "due within 30 days after your income tax return due
 *   date" (31 March: 6 August); "If a due date falls on a weekend or public
 *   holiday, it will be considered on time if we receive your application on
 *   the next business day." Public holidays aren't checked here.
 * - TAA 68CB(2B), (7), (7B); TAA 33E; LY 3(2)(a); IR1240 p 19, p 73, p 103,
 *   p 111, p 119; IR1060 (the income tax return's 7 July date without an
 *   agent), as cited in RD24.
 * Only the no-agent dates are shown (decision 49).
 */

export type RdDeadlineKind =
  | "criteria_methodologies"
  | "exceed_maximum"
  | "general_approval"
  | "material_change_variation"
  | "income_tax_return"
  | "supplementary_return"
  | "following_year_variation"
  | "last_filing";

export type RdDeadline = {
  kind: RdDeadlineKind;
  label: string;
  dueDate: string;
  dueWeekday: string;
  /** The due date, or the Monday after when it falls on a weekend. */
  onTimeBy: string;
  onTimeByWeekday: string;
  source: string;
};

export type RdDeadlines = { supported: true; deadlines: RdDeadline[]; note: string } | { supported: false; note: string };

export const RD_DEADLINES_NOTE =
  "These are the dates without a tax agent. If you have a tax agent or an extension of time, your income tax return, R&D supplementary return and last filing date are later; check with your agent. A date on a weekend is on time on the next business day; public holidays aren't checked.";

const UNSUPPORTED_NOTE = "Tohyee works these dates out only for a 31 March balance date; see IRD's R&D tax incentive due dates page.";

/** Reminders show from this many days before the due date (decision 48). */
export const RD_REMINDER_DAYS = 60;

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function weekday(date: string): number {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function nextBusinessDay(date: string): string {
  const day = weekday(date);
  return day === 6 ? addDays(date, 2) : day === 0 ? addDays(date, 1) : date;
}

/** "Wednesday 30 Jun 2027". */
export function longDate(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return `${WEEKDAYS[weekday(date)]} ${day} ${MONTHS[month - 1]} ${year}`;
}

function lastDayOfMonth(year: number, month: number): string {
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

/** The due dates for an income year (numbered by the year it ends in, e.g. 2027 for 2026-27). */
export function rdDeadlines(incomeYear: number, yearEndMonth: number): RdDeadlines {
  if (yearEndMonth !== 3) return { supported: false, note: UNSUPPORTED_NOTE };
  const y = incomeYear;
  const incomeTaxReturn = `${y}-07-07`;
  const rows: Array<[RdDeadlineKind, string, string, string]> = [
    ["criteria_methodologies", "Criteria and methodologies approval (significant performers only)", lastDayOfMonth(y - 1, 9), "TAA 68CC(3); IR1240 p 19, p 113; IRD due dates page"],
    ["exceed_maximum", "Approval to exceed the $120 million maximum", `${y}-05-07`, "IR1240 p 73"],
    ["general_approval", "General approval application, including supporting activity in the year before", lastDayOfMonth(y, 6), "TAA 68CB(2B); IR1240 p 19, p 108, p 119; IRD due dates page"],
    ["material_change_variation", "Variation for a material change to an approved activity", lastDayOfMonth(y, 6), "TAA 68CB(7); IR1240 p 111"],
    ["income_tax_return", "Income tax return, without a tax agent's extension", incomeTaxReturn, "IR1060"],
    ["supplementary_return", "R&D supplementary return (30 days after the income tax return's due date)", addDays(incomeTaxReturn, 30), "TAA 33E; IR1240 p 9, p 103; IR1060; IRD due dates page"],
    ["following_year_variation", "Variation to add supporting activity done in the following year", lastDayOfMonth(y + 1, 6), "TAA 68CB(7B); IR1240 p 119"],
    ["last_filing", "Latest the income tax return can be filed for the credit to count", `${y + 1}-07-07`, "LY 3(2)(a); IR1240 p 103"],
  ];
  return {
    supported: true,
    note: RD_DEADLINES_NOTE,
    deadlines: rows.map(([kind, label, dueDate, source]) => {
      const onTimeBy = nextBusinessDay(dueDate);
      return { kind, label, dueDate, dueWeekday: WEEKDAYS[weekday(dueDate)], onTimeBy, onTimeByWeekday: WEEKDAYS[weekday(onTimeBy)], source };
    }),
  };
}

export type RdReminder = {
  kind: "general_approval" | "material_change_variation" | "supplementary_return";
  incomeYear: number;
  incomeYearLabel: string;
  dueDate: string;
  onTimeBy: string;
  remindFrom: string;
  text: string;
};

const REMINDER_TEXT: Record<RdReminder["kind"], string> = {
  general_approval: "General approval",
  material_change_variation: "Variation for a material change to an approved activity",
  supplementary_return: "R&D supplementary return",
};

/**
 * The reminders showing on `today` for an income year (RD25, RD41; decision
 * 48): general approval until approval details covering the year are
 * entered, the supplementary return, and the material change variation while
 * an activity has changed since its approval was entered; each from 60 days
 * before its due date until the day it's on time by.
 */
export function dueReminders(input: { incomeYear: number; yearEndMonth: number; today: string; approvalEntered: boolean; materialChange: boolean }): RdReminder[] {
  const dates = rdDeadlines(input.incomeYear, input.yearEndMonth);
  if (!dates.supported) return [];
  const label = incomeYearLabel(input.incomeYear, input.yearEndMonth);
  const wanted: RdReminder["kind"][] = [];
  if (!input.approvalEntered) wanted.push("general_approval");
  if (input.materialChange) wanted.push("material_change_variation");
  wanted.push("supplementary_return");
  return wanted
    .map((kind) => {
      const deadline = dates.deadlines.find((entry) => entry.kind === kind)!;
      const remindFrom = addDays(deadline.dueDate, -RD_REMINDER_DAYS);
      const moved = deadline.onTimeBy !== deadline.dueDate ? ` (on time if received ${longDate(deadline.onTimeBy)})` : "";
      return {
        kind,
        incomeYear: input.incomeYear,
        incomeYearLabel: label,
        dueDate: deadline.dueDate,
        onTimeBy: deadline.onTimeBy,
        remindFrom,
        text: `${REMINDER_TEXT[kind]} for ${label} due ${longDate(deadline.dueDate)}${moved}`,
      };
    })
    .filter((reminder) => input.today >= reminder.remindFrom && input.today <= reminder.onTimeBy);
}
