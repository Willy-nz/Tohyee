import { listBankAccounts } from "@/lib/bank/accounts";
import { farmScope } from "@/lib/farming/access";
import { cashFlowForecast } from "@/lib/cash-flow/forecast";
import { todayIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { listNotebook } from "@/lib/ai-workspace/notebook";
import type { NotebookEntry } from "@/lib/ai-workspace/notebook-labels";
import { type FarmBenchmarks, farmBenchmarks, type PerUnit } from "@/lib/farming/benchmarks";
import { farmCalendar } from "@/lib/farming/calendar";
import type { CalendarItem } from "@/lib/farming/calendar-shared";
import { getPlanReport, listPlans } from "@/lib/farming/fertiliser";
import { listFarms, requireFarming } from "@/lib/farming/paddocks";
import { pastureSummary } from "@/lib/farming/pasture";
import { addDays, financialYearEnd, financialYearStart, monthEndOf, monthStartOf } from "@/lib/financial-year";
import { financialYearEndMonth } from "@/lib/reports/financial";
import { KIND_NAMES } from "@/lib/livestock/classes";
import { getLivestockSettings, headCount, listMovements } from "@/lib/livestock/movements";
import { listLivestockSuggestions } from "@/lib/livestock/suggestions";
import { add, cmp, dec, type Decimal, divide, isNegative, isZero, mul, neg, sum, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";

/*
 * The farm Home (#341; decisions 587-589): what a farmer opens first, from
 * records Tohyee already keeps. Each card is null when there's nothing to
 * show, so the screen hides it rather than showing zeros. Nothing here
 * posts or changes anything. The calendar is the viewer's own (and what
 * others shared), as on the calendar itself (decision 571). Money comes
 * from the business Home's own summary, not here. Records to catch up on
 * and the season's cash (FH9-FH11, decision 663) come with them.
 */

export type FarmHomeCalendar = { from: string; to: string; items: CalendarItem[]; needsChecking: number };

export type FarmHomeStock = {
  yearStart: string;
  yearEnd: string;
  /** Head by class now (the year's closing so far), largest first; classes with none left out. */
  classes: Array<{ kind: string; kindName: string; classCode: string; className: string; head: number }>;
  total: number;
  /** Movements recorded this income year (not voided). */
  movements: number;
  /** Movements the AI suggested that are waiting for a person to accept or decline. */
  suggestionsWaiting: number;
};

export type FarmHomePasture = {
  farmId: string;
  farmName: string;
  onDate: string;
  averageKgDmPerHa: number;
  totalKgDm: number;
  hectares: string;
  oldestReading: string | null;
  latestReading: string | null;
  /** Area-weighted growth (kg DM/ha/day) from paddocks whose latest growth ended in the last 30 days; null with none. */
  growthKgDmPerHaPerDay: string | null;
  growthPaddocks: number;
  /** The highest and lowest covers (the ends of the feed wedge). */
  highest: { name: string; cover: number } | null;
  lowest: { name: string; cover: number } | null;
  /** Supplements fed this month and last month, kg DM. */
  supplements: Array<{ month: string; kgDm: string }>;
};

export type FarmHomeFertiliser = {
  farmId: string;
  farmName: string;
  planId: string;
  planName: string;
  plannedTonnes: string;
  appliedTonnes: string;
  plannedCost: string;
  /** Product applied (at the bills' or quoted price) plus spreading. */
  appliedCost: string;
  applications: number;
  lastAppliedOn: string | null;
};

export type FarmHomePerformance = {
  yearEnd: string;
  previousYearEnd: string;
  workingExpenses: PerUnit;
  previous: PerUnit | null;
  operatingSurplus: PerUnit;
};

export type FarmHomeNotebook = { goals: NotebookEntry[]; recent: NotebookEntry[] };

/** Something missing or out of date, with where to fix it (FH9). */
export type FarmHomeCatchUpItem =
  | { kind: "pasture_stale"; farmId: string; farmName: string; latestReading: string; days: number }
  | { kind: "paddocks_unmeasured"; farmId: string; farmName: string; count: number }
  | { kind: "season_figures"; yearEnd: string }
  | { kind: "bank_lines"; count: number }
  | { kind: "bank_feeds"; count: number }
  | { kind: "livestock_suggestions"; count: number }
  | { kind: "calendar_checking"; count: number };

/** A month of the season (FH10): what went in and out of the bank, and what's expected. */
export type FarmHomeCashMonth = {
  /** YYYY-MM. */
  month: string;
  /** Up to today; null for months still to come. */
  moneyIn: string | null;
  moneyOut: string | null;
  /** In the bank at the month's end, or today for this month; null for months still to come. */
  closing: string | null;
  /** The cash flow forecast's (CF1-CF9) for the rest of this month and those to come; null for past months. */
  forecastIn: string | null;
  forecastOut: string | null;
  forecastClosing: string | null;
};

export type FarmHomeSeasonCash = {
  currencyCode: string;
  yearStart: string;
  yearEnd: string;
  /** In the bank the day before the season started. */
  opening: string;
  months: FarmHomeCashMonth[];
  /** The lowest expected month-end balance from this month on. */
  lowest: { month: string; closing: string } | null;
  /** The first month expected to end below zero. */
  firstBelowZero: string | null;
};

export type FarmHome = {
  today: string;
  calendar: FarmHomeCalendar | null;
  stock: FarmHomeStock | null;
  pasture: FarmHomePasture[] | null;
  fertiliser: FarmHomeFertiliser[] | null;
  performance: FarmHomePerformance | null;
  notebook: FarmHomeNotebook | null;
  catchUp: FarmHomeCatchUpItem[] | null;
  seasonCash: FarmHomeSeasonCash | null;
};

const CALENDAR_DAYS = 7;
const CALENDAR_ITEMS = 8;
const GROWTH_DAYS = 30;
/** A farm walk older than this is out of date (FH9): weekly in spring, so two weeks is generous. */
export const STALE_PASTURE_DAYS = 14;

/** This week on the farm: the viewer's own items and those shared with them, today and the next six days, and their Needs checking. */
async function calendarCard(tx: OrgTx, today: string): Promise<FarmHomeCalendar | null> {
  const to = addDays(today, CALENDAR_DAYS - 1);
  const calendar = await farmCalendar(tx, { from: today, to });
  const items = calendar.items.filter((item) => item.state === "open" || item.state === "cancelled").slice(0, CALENDAR_ITEMS);
  if (!items.length && calendar.needsChecking === 0) return null;
  return { from: today, to, items, needsChecking: calendar.needsChecking };
}

/** Stock: head now by class, this year's movements and AI suggestions waiting. Null with Livestock off or no stock. */
async function stockCard(tx: OrgTx, today: string): Promise<FarmHomeStock | null> {
  const settings = await getLivestockSettings(tx);
  if (!settings.enabled || !settings.firstYearStart) return null;
  const yearEnd = financialYearEnd(today, settings.financialYearEndMonth);
  if (yearEnd < settings.firstYearStart) return null;
  const count = await headCount(tx, { yearEnd });
  const yearStart = financialYearStart(yearEnd, settings.financialYearEndMonth);
  const classes = count.rows
    .filter((row) => row.closing !== 0)
    .map((row) => ({ kind: row.kind, kindName: KIND_NAMES[row.kind] ?? row.kind, classCode: row.classCode, className: row.className, head: row.closing }))
    .sort((a, b) => b.head - a.head || a.className.localeCompare(b.className));
  const movements = (await listMovements(tx, { from: yearStart, to: yearEnd })).length;
  const suggestionsWaiting = (await listLivestockSuggestions(tx, { open: true })).length;
  if (!classes.length && !movements && !suggestionsWaiting) return null;
  return { yearStart, yearEnd, classes, total: classes.reduce((total, row) => total + row.head, 0), movements, suggestionsWaiting };
}

/** Pasture and feed for each active farm with a reading or supplements. */
async function pastureCards(tx: OrgTx, farms: Array<{ id: string; name: string }>, today: string, checks: FarmHomeCatchUpItem[]): Promise<FarmHomePasture[] | null> {
  const cards: FarmHomePasture[] = [];
  const thisMonth = today.slice(0, 7);
  const lastMonth = addDays(`${thisMonth}-01`, -1).slice(0, 7);
  for (const farm of farms) {
    const summary = await pastureSummary(tx, { farmId: farm.id, onDate: today });
    // FH9: only for a farm that does farm walks (has a reading), so a farm that doesn't isn't nagged.
    const measured = summary.paddocks.map((paddock) => paddock.latest?.measuredOn ?? null).filter((date): date is string => date !== null).sort();
    if (measured.length) {
      const newest = measured[measured.length - 1];
      const days = daysBetween(newest, today);
      if (days > STALE_PASTURE_DAYS) checks.push({ kind: "pasture_stale", farmId: farm.id, farmName: farm.name, latestReading: newest, days });
      const unmeasured = summary.paddocks.length - measured.length;
      if (unmeasured > 0) checks.push({ kind: "paddocks_unmeasured", farmId: farm.id, farmName: farm.name, count: unmeasured });
    }
    const supplements = summary.supplementMonths.filter((month) => month.month === thisMonth || month.month === lastMonth).map((month) => ({ month: month.month, kgDm: month.kgDm }));
    if (summary.cover.averageKgDmPerHa === null && !supplements.length) continue;
    // Growth: area-weighted over paddocks with an area whose latest growth ended within the last 30 days.
    let weighted = ZERO_DECIMAL;
    let area = ZERO_DECIMAL;
    let growthPaddocks = 0;
    for (const paddock of summary.paddocks) {
      const growth = paddock.growth;
      if (!growth || growth.kind !== "rate" || !paddock.hectares || growth.to < addDays(today, -GROWTH_DAYS)) continue;
      const hectares = dec(paddock.hectares);
      if (isZero(hectares)) continue;
      weighted = add(weighted, mul(dec(growth.kgDmPerHaPerDay), hectares));
      area = add(area, hectares);
      growthPaddocks += 1;
    }
    const wedge = summary.cover.wedge;
    const latest = summary.paddocks.map((paddock) => paddock.latest?.measuredOn ?? null).filter((date): date is string => date !== null).sort().at(-1) ?? null;
    cards.push({
      farmId: farm.id,
      farmName: farm.name,
      onDate: today,
      averageKgDmPerHa: summary.cover.averageKgDmPerHa ?? 0,
      totalKgDm: summary.cover.totalKgDm,
      hectares: summary.cover.hectares,
      oldestReading: summary.cover.oldestReading,
      latestReading: latest,
      growthKgDmPerHaPerDay: growthPaddocks ? toFixedString(divide(weighted, area, 1), 1) : null,
      growthPaddocks,
      highest: wedge.length ? { name: wedge[0].name, cover: wedge[0].cover } : null,
      lowest: wedge.length ? { name: wedge[wedge.length - 1].name, cover: wedge[wedge.length - 1].cover } : null,
      supplements,
    });
  }
  return cards.length ? cards : null;
}

/** Fertiliser: each active farm's latest plan, planned against applied. */
async function fertiliserCards(tx: OrgTx, farms: Array<{ id: string; name: string }>): Promise<FarmHomeFertiliser[] | null> {
  const cards: FarmHomeFertiliser[] = [];
  for (const farm of farms) {
    const plan = (await listPlans(tx, { farmId: farm.id }))[0];
    if (!plan) continue;
    const report = await getPlanReport(tx, plan.id);
    const version = report.versions.at(-1) ?? null;
    if (!version && !report.applications.length) continue;
    const appliedTonnes = sum(report.products.map((product) => dec(product.appliedTonnes)));
    const appliedCost = add(sum(report.products.map((product) => dec(product.appliedCost))), dec(report.spreadingTotals.actual));
    cards.push({
      farmId: farm.id,
      farmName: farm.name,
      planId: plan.id,
      planName: plan.name,
      plannedTonnes: version ? version.totals.tonnes : "0.000",
      appliedTonnes: toFixedString(appliedTonnes, 3),
      plannedCost: version ? version.totals.total : "0.00",
      appliedCost: toFixedString(appliedCost, 2),
      applications: report.applications.length,
      lastAppliedOn: report.applications.map((application) => application.appliedOn).sort().at(-1) ?? null,
    });
  }
  return cards.length ? cards : null;
}

/** Farm performance: the last finished season's working expenses per unit, against the season before. Null with no FWE grouped. */
async function performanceCard(tx: OrgTx, latest: FarmBenchmarks): Promise<FarmHomePerformance | null> {
  if (cmp(dec(latest.workingExpenses.amount), ZERO_DECIMAL) === 0) return null;
  const previousYearEnd = latest.yearEnds[latest.yearEnds.indexOf(latest.yearEnd) + 1] ?? null;
  const previous = previousYearEnd ? await farmBenchmarks(tx, { yearEnd: previousYearEnd }) : null;
  return {
    yearEnd: latest.yearEnd,
    previousYearEnd: previousYearEnd ?? "",
    workingExpenses: latest.workingExpenses,
    previous: previous && !isZero(dec(previous.workingExpenses.amount)) ? previous.workingExpenses : null,
    operatingSurplus: latest.operatingSurplus,
  };
}

/** The farm notebook: the latest goals, and the latest other notes. */
async function notebookCard(tx: OrgTx): Promise<FarmHomeNotebook | null> {
  if (!(await farmScope(tx)).all) return null;
  const notes = await listNotebook(tx, { limit: 50 });
  if (!notes.length) return null;
  return { goals: notes.filter((note) => note.category === "goals").slice(0, 3), recent: notes.filter((note) => note.category !== "goals").slice(0, 3) };
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * Cash this season (FH10): the financial year month by month. Months gone
 * and this month so far from the ledger: money into and out of the active
 * bank accounts (credit cards left out, as Cash in bank does), each journal
 * netted first so a transfer between two of them is neither, and the
 * balance at each month's end. The rest of this month and the months still
 * to come from the cash flow forecast (CF1-CF9) on the same accounts. Null
 * with no active bank account, or with nothing in the bank, moved or
 * expected (FH6).
 */
export async function seasonCash(tx: OrgTx, today: string): Promise<FarmHomeSeasonCash | null> {
  const accounts = (await listBankAccounts(tx)).filter((account) => account.isActive && account.accountType === "bank");
  if (!accounts.length) return null;
  const yearEndMonth = await financialYearEndMonth(tx);
  const yearEnd = financialYearEnd(today, yearEndMonth);
  const yearStart = financialYearStart(yearEnd, yearEndMonth);
  const ids = accounts.map((account) => account.id);
  const opening = await tx.query<{ balance: string }>(
    `select coalesce(sum(l.debit_amount - l.credit_amount), 0)::text as balance
       from ledger_journal_lines l join ledger_journals j on j.id = l.journal_id
      where l.account_id = any($1::bigint[]) and j.posting_date < $2::date`,
    [ids, yearStart],
  );
  const flows = await tx.query<{ month: string; money_in: string; money_out: string }>(
    `with per_journal as (
       select to_char(j.posting_date, 'YYYY-MM') as month, sum(l.debit_amount - l.credit_amount) as net
         from ledger_journal_lines l join ledger_journals j on j.id = l.journal_id
        where l.account_id = any($1::bigint[]) and j.posting_date between $2::date and $3::date
        group by j.id, to_char(j.posting_date, 'YYYY-MM'))
     select month, coalesce(sum(net) filter (where net > 0), 0)::text as money_in, coalesce(-sum(net) filter (where net < 0), 0)::text as money_out
       from per_journal group by month`,
    [ids, yearStart, today],
  );
  const byMonth = new Map(flows.rows.map((row) => [row.month, row]));
  const months: FarmHomeCashMonth[] = [];
  let balance: Decimal = dec(opening.rows[0]?.balance ?? "0");
  for (let start = monthStartOf(yearStart); start <= monthStartOf(today); start = addDays(monthEndOf(start), 1)) {
    const month = start.slice(0, 7);
    const row = byMonth.get(month);
    const moneyIn = dec(row?.money_in ?? "0");
    const moneyOut = dec(row?.money_out ?? "0");
    balance = add(balance, add(moneyIn, neg(moneyOut)));
    months.push({ month, moneyIn: toFixedString(moneyIn, 2), moneyOut: toFixedString(moneyOut, 2), closing: toFixedString(balance, 2), forecastIn: null, forecastOut: null, forecastClosing: null });
  }
  // The rest of this month and the months to the season's end, from the forecast.
  let count = 0;
  for (let start = monthStartOf(today); start <= yearEnd; start = addDays(monthEndOf(start), 1)) count += 1;
  const forecast = await cashFlowForecast(tx, { today, period: "month", count: Math.min(count, 12), accountIds: ids.join(",") });
  let lowest: FarmHomeSeasonCash["lowest"] = null;
  let firstBelowZero: string | null = null;
  for (const period of forecast.periods) {
    const month = period.start.slice(0, 7);
    let entry = months.find((candidate) => candidate.month === month);
    if (!entry) {
      entry = { month, moneyIn: null, moneyOut: null, closing: null, forecastIn: null, forecastOut: null, forecastClosing: null };
      months.push(entry);
    }
    entry.forecastIn = period.moneyIn;
    entry.forecastOut = period.moneyOut;
    entry.forecastClosing = period.closing;
    if (!lowest || cmp(dec(period.closing), dec(lowest.closing)) < 0) lowest = { month, closing: period.closing };
    if (firstBelowZero === null && isNegative(dec(period.closing))) firstBelowZero = month;
  }
  // FH6: nothing in the bank, nothing moved and nothing expected is an empty card.
  const nil = (value: string | null) => value === null || isZero(dec(value));
  if (nil(opening.rows[0]?.balance ?? null) && months.every((month) => nil(month.moneyIn) && nil(month.moneyOut) && nil(month.forecastIn) && nil(month.forecastOut))) return null;
  return { currencyCode: tx.baseCurrency, yearStart, yearEnd, opening: toFixedString(dec(opening.rows[0]?.balance ?? "0"), 2), months, lowest, firstBelowZero };
}

/** Bank lines to reconcile and feeds to reconnect (FH9): out-of-date books make the season's cash wrong. */
async function bankChecks(tx: OrgTx, checks: FarmHomeCatchUpItem[]): Promise<void> {
  const accounts = (await listBankAccounts(tx)).filter((account) => account.isActive);
  const lines = accounts.reduce((total, account) => total + account.unreconciledCount, 0);
  const feeds = accounts.filter((account) => account.feed.active && account.feed.lastSyncStatus === "failed").length;
  if (lines) checks.push({ kind: "bank_lines", count: lines });
  if (feeds) checks.push({ kind: "bank_feeds", count: feeds });
}

/** The farm Home's cards (FH1-FH11). Farming has to be on. */
export async function farmHome(tx: OrgTx, input: { today?: string } = {}): Promise<FarmHome> {
  await requireFarming(tx);
  const today = input.today ?? todayIsoDate();
  const farms = (await listFarms(tx)).filter((farm) => farm.isActive).map((farm) => ({ id: farm.id, name: farm.name }));
  const checks: FarmHomeCatchUpItem[] = [];
  const calendar = await calendarCard(tx, today);
  const stock = await stockCard(tx, today);
  const pasture = await pastureCards(tx, farms, today, checks);
  const benchmarks = await farmBenchmarks(tx, { yearEnd: undefined });
  const performance = await performanceCard(tx, benchmarks);
  // FH9: a season with working expenses but none of kg MS, hectares, cows or stock units entered.
  const units = benchmarks.workingExpenses;
  if (performance && units.perKgMs === null && units.perHa === null && units.perCow === null && units.perSu === null) checks.push({ kind: "season_figures", yearEnd: benchmarks.yearEnd });
  await bankChecks(tx, checks);
  if (stock?.suggestionsWaiting) checks.push({ kind: "livestock_suggestions", count: stock.suggestionsWaiting });
  // The person's own Needs checking only (decision 571), as on the calendar card.
  if (calendar?.needsChecking) checks.push({ kind: "calendar_checking", count: calendar.needsChecking });
  return {
    today,
    calendar,
    stock,
    pasture,
    fertiliser: await fertiliserCards(tx, farms),
    performance,
    notebook: await notebookCard(tx),
    catchUp: checks.length ? checks : null,
    seasonCash: await seasonCash(tx, today),
  };
}
