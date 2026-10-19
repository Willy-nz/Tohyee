import { todayIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { listNotebook } from "@/lib/ai-workspace/notebook";
import type { NotebookEntry } from "@/lib/ai-workspace/notebook-labels";
import { farmBenchmarks, type PerUnit } from "@/lib/farming/benchmarks";
import { farmCalendar } from "@/lib/farming/calendar";
import type { CalendarItem } from "@/lib/farming/calendar-shared";
import { getPlanReport, listPlans } from "@/lib/farming/fertiliser";
import { listFarms, requireFarming } from "@/lib/farming/paddocks";
import { pastureSummary } from "@/lib/farming/pasture";
import { addDays, financialYearEnd, financialYearStart } from "@/lib/financial-year";
import { KIND_NAMES } from "@/lib/livestock/classes";
import { getLivestockSettings, headCount, listMovements } from "@/lib/livestock/movements";
import { listLivestockSuggestions } from "@/lib/livestock/suggestions";
import { add, cmp, dec, divide, isZero, mul, sum, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";

/*
 * The farm Home (#341; decisions 587-589): what a farmer opens first, from
 * records Tohyee already keeps. Each card is null when there's nothing to
 * show, so the screen hides it rather than showing zeros. Nothing here
 * posts or changes anything. The calendar is the viewer's own (and what
 * others shared), as on the calendar itself (decision 571). Money comes
 * from the business Home's own summary, not here.
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

export type FarmHome = {
  today: string;
  calendar: FarmHomeCalendar | null;
  stock: FarmHomeStock | null;
  pasture: FarmHomePasture[] | null;
  fertiliser: FarmHomeFertiliser[] | null;
  performance: FarmHomePerformance | null;
  notebook: FarmHomeNotebook | null;
};

const CALENDAR_DAYS = 7;
const CALENDAR_ITEMS = 8;
const GROWTH_DAYS = 30;

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
async function pastureCards(tx: OrgTx, farms: Array<{ id: string; name: string }>, today: string): Promise<FarmHomePasture[] | null> {
  const cards: FarmHomePasture[] = [];
  const thisMonth = today.slice(0, 7);
  const lastMonth = addDays(`${thisMonth}-01`, -1).slice(0, 7);
  for (const farm of farms) {
    const summary = await pastureSummary(tx, { farmId: farm.id, onDate: today });
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
async function performanceCard(tx: OrgTx): Promise<FarmHomePerformance | null> {
  const latest = await farmBenchmarks(tx, { yearEnd: undefined });
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
  const notes = await listNotebook(tx, { limit: 50 });
  if (!notes.length) return null;
  return { goals: notes.filter((note) => note.category === "goals").slice(0, 3), recent: notes.filter((note) => note.category !== "goals").slice(0, 3) };
}

/** The farm Home's cards (FH1-FH8). Farming has to be on. */
export async function farmHome(tx: OrgTx, input: { today?: string } = {}): Promise<FarmHome> {
  await requireFarming(tx);
  const today = input.today ?? todayIsoDate();
  const farms = (await listFarms(tx)).filter((farm) => farm.isActive).map((farm) => ({ id: farm.id, name: farm.name }));
  return {
    today,
    calendar: await calendarCard(tx, today),
    stock: await stockCard(tx, today),
    pasture: await pastureCards(tx, farms, today),
    fertiliser: await fertiliserCards(tx, farms),
    performance: await performanceCard(tx),
    notebook: await notebookCard(tx),
  };
}
