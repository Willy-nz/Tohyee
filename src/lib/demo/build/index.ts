import { createBudget, fillBudget } from "@/lib/budgets/service";
import type { Actor } from "@/lib/db/org-transaction";
import type { OrganisationRecord } from "@/lib/organisations/registry";
import { dec } from "@/lib/money/decimal";
import { setUpAnalytics } from "@/lib/demo/build/analytics";
import { bankStatement, fileGst, openBooks, setUpBooks, tradeMonth } from "@/lib/demo/build/books";
import { demoContext, type DemoContext } from "@/lib/demo/build/context";
import { calendarAndNotebook, farmMonth, seasonFigures, setUpCoopShares, setUpFarm } from "@/lib/demo/build/farm";
import { countHerd, livestockMonth, openingHerdValue, setUpLivestock } from "@/lib/demo/build/livestock";
import { payrollMonth, setUpPayroll } from "@/lib/demo/build/payroll";
import { farmSafety } from "@/lib/demo/build/safety";
import { farmWorkspace, tractorJobs } from "@/lib/demo/build/workspace";
import { demoMonths, demoStart, lastDayOf, seasonEnd, seedFor } from "@/lib/demo/plan";

/** Progress as the build goes: a short description and how far through (0-100). */
export type DemoProgress = (step: string, percent: number) => Promise<void>;

/**
 * Fills a new, empty organisation with the demo farm (#437), entered month
 * by month through Tohyee's own services as `actor`, up to `today`.
 */
export async function buildDemoFarm(organisation: OrganisationRecord, actor: Actor, today: string, progress: DemoProgress): Promise<void> {
  const start = demoStart(today);
  const ctx = demoContext(organisation, actor, today, start, seedFor(today));
  const months = demoMonths(start, today);

  await progress("Setting up the organisation, accounts and contacts", 2);
  await setUpBooks(ctx);
  const farm = await setUpFarm(ctx);
  await setUpLivestock(ctx);
  const books = await openBooks(ctx, openingHerdValue());
  await setUpPayroll(ctx);
  await setUpCoopShares(ctx);

  const balance = { value: dec("85000.00") };
  for (const [index, month] of months.entries()) {
    await progress(`Entering ${monthName(month)}`, 5 + Math.round((index / months.length) * 80));
    await livestockMonth(ctx, books, month);
    await payrollMonth(ctx, books, month);
    await farmMonth(ctx, books, farm, month);
    await tradeMonth(ctx, books, month);
    await bankStatement(ctx, books, month, balance);
    await fileGst(ctx, books, month);
    const monthEnd = lastDayOf(month);
    if (monthEnd < today && month.endsWith("-05")) {
      await countHerd(ctx, monthEnd);
      await seasonFigures(ctx, monthEnd);
    }
  }

  await progress("Adding the budget, calendar and notebook", 86);
  await seasonBudget(ctx);
  await calendarAndNotebook(ctx);
  await progress("Adding farm safety, this week's farm work and tractor jobs", 87);
  await farmSafety(ctx, farm);
  await farmWorkspace(ctx, farm);
  await tractorJobs(ctx);
  await progress("Copying the books into Analytics and making the reports", 90);
  await setUpAnalytics(ctx);
  await progress("Done", 100);
}

function monthName(month: string): string {
  const [year, number] = month.split("-").map(Number);
  return `${new Date(Date.UTC(year, number - 1, 1)).toLocaleString("en-NZ", { month: "long", timeZone: "UTC" })} ${year}`;
}

/** This season's budget: last season's actuals plus 4%, for income and spending. */
async function seasonBudget(ctx: DemoContext): Promise<void> {
  const thisSeasonEnd = seasonEnd(ctx.today);
  const from = `${Number(thisSeasonEnd.slice(0, 4)) - 1}-06`;
  await ctx.as(async (tx) => {
    const { budget } = await createBudget(tx, { idempotencyKey: ctx.key("budget"), name: `Season ${from.slice(0, 4)}-${thisSeasonEnd.slice(2, 4)}` });
    const codes = await tx.query<{ code: string }>("select code from accounts where account_class in ('revenue', 'expense') and is_active and system_key is null order by code");
    await fillBudget(tx, budget.id, { version: budget.version, accountCodes: codes.rows.map((row) => row.code), from, months: 12, method: "actuals", percent: "4" });
  });
}
