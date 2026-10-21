import { dec, isZero } from "@/lib/money/decimal";
import type { DueDate, IncomeTaxReport } from "@/lib/tax/income/service";

/**
 * The income tax workspace's Overview (#375, decision 702): what's due
 * next, whether the forecast has anything to work from, and what needs
 * doing. Presentation only: every amount comes from buildIncomeTax as it
 * is; nothing here works tax out.
 */

type Supported = Extract<IncomeTaxReport, { supported: true }>;

/**
 * True when this year's forecast has nothing to work from: no income or
 * expense from the books or the overall budget, no adjustments, no tax
 * depreciation and none of IRD's figures typed for the year. Its $0.00 is
 * then an empty input, not a worked-out zero. A year with any of those has
 * real inputs, so a zero it comes to is shown as a zero.
 */
export function forecastIncomplete(report: Pick<Supported, "accounts" | "adjustments" | "taxAssets" | "typed">): boolean {
  return report.accounts.length === 0 && report.adjustments.length === 0 && report.taxAssets.length === 0 && report.typed.version === 0;
}

/** The due date row whose amount comes from this year's forecast (end-of-year tax for this income year). */
export function dependsOnForecast(entry: Pick<DueDate, "key">, incomeYear: number): boolean {
  return entry.key === `end-${incomeYear}`;
}

/** The first payment still to come: on or after today, counting the next-business-day rule. */
export function nextDue(dueDates: DueDate[], today: string): DueDate | null {
  return dueDates.find((entry) => entry.onTimeBy.date >= today) ?? null;
}

export type TaxTask = { key: string; text: string; view: "forecast" | "calculation" | "payments" | "returns" | "settings" };

/** What needs doing, from the report's own figures; empty when nothing does. */
export function taxTasks(report: Supported): TaxTask[] {
  const tasks: TaxTask[] = [];
  if (forecastIncomplete(report)) {
    tasks.push({ key: "forecast", text: "No income or expenses were found for this year, in the books or the overall budget. Add them, or a budget, before relying on the forecast.", view: "forecast" });
  }
  const awaiting = report.payments.filter((payment) => !payment.reversed && !isZero(dec(payment.awaiting)));
  if (awaiting.length > 0) {
    tasks.push({ key: "allocate", text: `${awaiting.length === 1 ? "1 payment to IRD isn't" : `${awaiting.length} payments to IRD aren't`} allocated to an instalment or end-of-year tax yet.`, view: "payments" });
  }
  if (!report.lastYear.typed && report.lastYear.rit !== null) {
    tasks.push({ key: "last-year", text: `Last year's residual income tax is Tohyee's estimate. Type IRD's assessed figure once you have it, because it sets this year's provisional tax.`, view: "payments" });
  }
  if (report.ir10 || report.ir4 || report.ir3) {
    tasks.push({ key: "returns", text: `The ${report.incomeYear} income year has ended: its return figures are ready to check.`, view: "returns" });
  }
  return tasks;
}
