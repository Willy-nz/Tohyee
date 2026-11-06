import { addDays, daysBetween } from "@/lib/farming/farm-words";
import { add, cmp, dec, divide, mul, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";

/*
 * Breeding and rotation planning rules (decisions 1439-1444; BR1-BR6,
 * common NZ practice, not yet reviewed). Browser-safe.
 */

export const BREEDING_TYPES = ["joining", "ai", "scanning", "pregnancy_test"] as const;
export type BreedingType = (typeof BREEDING_TYPES)[number];
export const BREEDING_LABELS: Record<BreedingType, string> = {
  joining: "Mating (joining)",
  ai: "AI",
  scanning: "Scanning",
  pregnancy_test: "Pregnancy test",
};

/**
 * Scanning % (BR2): foetuses scanned for every 100 ewes scanned. 500
 * scanned, 30 empty, 250 singles, 210 twins, 10 triplets: 250 + 420 + 30 =
 * 700 foetuses, 140%. With the ewes joined known it's given per ewe joined
 * too.
 */
export function scanningPercent(result: { head: number; singles: number; twins: number; triplets: number }, per?: number | null): string | null {
  const base = per ?? result.head;
  if (!base) return null;
  const foetuses = result.singles + 2 * result.twins + 3 * result.triplets;
  return toFixedString(divide(dec(String(foetuses * 100)), dec(String(base)), 0), 0);
}

/** In-calf % (BR3): 188 of 200 tested is 94.0%. */
export function inCalfPercent(head: number, inCalf: number): string | null {
  return head ? toFixedString(divide(dec(String(inCalf * 100)), dec(String(head)), 1), 1) : null;
}

/** Days from mating to birth, on average, for the dates a farmer plans around (BR1). */
export const GESTATION_DAYS: Partial<Record<string, number>> = { sheep: 147, beef_cattle: 283, dairy_cattle: 283, deer_red: 233, deer_other: 230, goats_angora: 150, goats_cashmere: 150, goats_dairy: 150 };

/** The first births expected from a mating's start: the kind's average gestation (BR1). */
export function birthsFrom(kind: string, joinedOn: string): string | null {
  const days = GESTATION_DAYS[kind];
  return days ? addDays(joinedOn, days) : null;
}

export type PlannedStop = { paddockId: string; name: string; plannedOn: string; days: number };

/**
 * A round (BR5): the paddocks in order, each for its share of the round by
 * area (rounded to whole days, at least one), the last taking what's left
 * so the round adds up. Round 30 days over A 10 ha, B 5 ha, C 15 ha from 1
 * Nov: A 10 days from 1 Nov, B 5 from 11 Nov, C 15 from 16 Nov.
 */
export function planRound(paddocks: ReadonlyArray<{ paddockId: string; name: string; hectares: string | null }>, startOn: string, roundDays: number): PlannedStop[] {
  if (!paddocks.length) return [];
  const areas = paddocks.map((paddock) => (paddock.hectares && cmp(dec(paddock.hectares), ZERO_DECIMAL) > 0 ? dec(paddock.hectares) : null));
  const known = areas.filter((area) => area !== null);
  // Paddocks with no area get the average area of the rest (or an equal share).
  const average = known.length ? divide(known.reduce((sum, area) => add(sum, area!), ZERO_DECIMAL), dec(String(known.length)), 4) : dec("1");
  const used = areas.map((area) => area ?? average);
  const total = used.reduce((sum, area) => add(sum, area), ZERO_DECIMAL);
  let on = startOn;
  let left = roundDays;
  return paddocks.map((paddock, index) => {
    const last = index === paddocks.length - 1;
    const share = Number(toFixedString(divide(mul(used[index], dec(String(roundDays))), total, 0), 0));
    const days = last ? Math.max(1, left) : Math.max(1, Math.min(share, left - (paddocks.length - index - 1)));
    const stop = { paddockId: paddock.paddockId, name: paddock.name, plannedOn: on, days };
    on = addDays(on, days);
    left -= days;
    return stop;
  });
}

/** Days since grazed against the round (BR6): "18 of 25 days", and how many to go. Facts only. */
export function roundText(lastGrazedOn: string | null, roundDays: number | null, today: string): string | null {
  if (!lastGrazedOn) return null;
  const days = daysBetween(lastGrazedOn, today);
  if (!roundDays) return `${days} days since grazed`;
  return days >= roundDays ? `${days} days since grazed (round ${roundDays})` : `${days} of ${roundDays} days`;
}
