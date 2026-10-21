/** All farms compared (#390, PF9): the figures, without the database, so the screen can share them. */
import { type CoverPaddock, farmCover } from "@/lib/farming/pasture-rules";
import { add, dec, sum, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";

/** A farm walk older than this is "not fresh" (the same 14 days as Home's catch-up list, FH9). */
export const FRESH_PASTURE_DAYS = 14;

export type ComparisonPlan = { planId: string; planName: string; plannedTonnes: string | null; appliedTonnes: string; applications: number; lastAppliedOn: string | null };

export type ComparisonInput = {
  farmId: string;
  farmName: string;
  effectiveHa: string;
  mappedHa: string;
  paddocks: CoverPaddock[];
  plan: ComparisonPlan | null;
};

type Pasture = {
  /** Area-weighted average of the latest readings (PF3); null with none. */
  averageKgDmPerHa: number | null;
  totalKgDm: number;
  /** The hectares those readings cover. */
  measuredHa: string;
  measuredPaddocks: number;
  /** Active paddocks with no reading on or before the date. */
  noReading: number;
  /** Paddocks with a reading but no area, left out of the average. */
  noArea: number;
  estimates: number;
  oldestReading: string | null;
  newestReading: string | null;
  /** Days from the newest reading to the date; null with none. */
  daysSinceNewest: number | null;
  fresh: boolean;
};

export type FarmComparisonRow = { farmId: string; farmName: string; paddocks: number; effectiveHa: string; mappedHa: string; pasture: Pasture; plan: ComparisonPlan | null };

export type FarmComparison = {
  onDate: string;
  farms: FarmComparisonRow[];
  allFarms: {
    farms: number;
    paddocks: number;
    effectiveHa: string;
    mappedHa: string;
    /** Worked from every paddock's area and reading, never from the farms' averages (PF9). */
    pasture: Pasture & { farmsWithReadings: number; farmsNotFresh: number };
    plannedTonnes: string;
    appliedTonnes: string;
    farmsWithoutPlan: number;
  };
};

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

function pastureOf(onDate: string, paddocks: CoverPaddock[]): Pasture {
  const cover = farmCover(onDate, paddocks);
  const dates = paddocks.map((paddock) => paddock.latest?.measuredOn ?? null).filter((date): date is string => date !== null).sort();
  const newest = dates.at(-1) ?? null;
  const days = newest ? daysBetween(newest, onDate) : null;
  return {
    averageKgDmPerHa: cover.averageKgDmPerHa,
    totalKgDm: cover.totalKgDm,
    measuredHa: cover.hectares,
    measuredPaddocks: cover.readings,
    noReading: cover.noReading.length,
    noArea: cover.noArea.length,
    estimates: cover.estimates,
    oldestReading: dates[0] ?? null,
    newestReading: newest,
    daysSinceNewest: days,
    fresh: days !== null && days <= FRESH_PASTURE_DAYS,
  };
}

/** Every active farm side by side, and all of them together (PF9). Pure: tested in tests/unit/farm-comparison.test.ts. */
export function compareFarms(onDate: string, farms: ComparisonInput[]): FarmComparison {
  const rows = farms.map((farm) => ({
    farmId: farm.farmId,
    farmName: farm.farmName,
    paddocks: farm.paddocks.length,
    effectiveHa: farm.effectiveHa,
    mappedHa: farm.mappedHa,
    pasture: pastureOf(onDate, farm.paddocks),
    plan: farm.plan,
  }));
  // Paddock IDs are unique across the organisation's farms, so the merged list is every paddock once.
  const group = pastureOf(onDate, farms.flatMap((farm) => farm.paddocks));
  return {
    onDate,
    farms: rows,
    allFarms: {
      farms: rows.length,
      paddocks: rows.reduce((total, row) => total + row.paddocks, 0),
      effectiveHa: toFixedString(sum(farms.map((farm) => dec(farm.effectiveHa))), 2),
      mappedHa: toFixedString(sum(farms.map((farm) => dec(farm.mappedHa))), 2),
      pasture: { ...group, farmsWithReadings: rows.filter((row) => row.pasture.newestReading !== null).length, farmsNotFresh: rows.filter((row) => !row.pasture.fresh).length },
      plannedTonnes: toFixedString(farms.reduce((total, farm) => (farm.plan?.plannedTonnes ? add(total, dec(farm.plan.plannedTonnes)) : total), ZERO_DECIMAL), 3),
      appliedTonnes: toFixedString(farms.reduce((total, farm) => (farm.plan ? add(total, dec(farm.plan.appliedTonnes)) : total), ZERO_DECIMAL), 3),
      farmsWithoutPlan: rows.filter((row) => !row.plan).length,
    },
  };
}
