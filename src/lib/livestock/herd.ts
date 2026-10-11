import { addDays, financialYearEnd } from "@/lib/financial-year";
import { classKey, className, LIVESTOCK_CLASSES, type LivestockKind } from "./classes";

/*
 * The farm's own head count, worked out from the opening position and the
 * movements (LV1). Pure: no database. Ageing isn't stored: at the start of
 * each income year, every class's closing head moves to the next class, so
 * it can't happen twice and a late entry in an earlier year flows through.
 * Mixed-age ewes move in part, by the split given for that year.
 */

export type HerdMovement = {
  movementDate: string;
  movementType: string;
  kind: string;
  classCode: string;
  toClassCode: string | null;
  head: number;
};

export type AgeingStep = { kind: LivestockKind; classCode: string; className: string; toClassCode: string; toClassName: string; head: number };

/** How a movement changes the farm's own head by class; transfers only change where stock is. */
export function deltas(movement: HerdMovement): Array<[string, number]> {
  const key = classKey(movement.kind, movement.classCode);
  switch (movement.movementType) {
    case "birth":
    case "purchase":
    case "found":
      return [[key, movement.head]];
    case "sale":
    case "death":
    case "missing":
      return [[key, -movement.head]];
    case "reclass":
      return [
        [key, -movement.head],
        [classKey(movement.kind, movement.toClassCode ?? ""), movement.head],
      ];
    default:
      return [];
  }
}

/** Ageing at the start of a year, from the head on hand at the end of the year before (LV1). */
export function ageingSteps(balances: ReadonlyMap<string, number>, splits: ReadonlyMap<string, number>): { steps: AgeingStep[]; needsSplit: AgeingStep[] } {
  const steps: AgeingStep[] = [];
  const needsSplit: AgeingStep[] = [];
  for (const definition of LIVESTOCK_CLASSES) {
    const key = classKey(definition.kind, definition.code);
    const onHand = balances.get(key) ?? 0;
    if (!definition.agesTo || onHand <= 0) continue;
    const step = {
      kind: definition.kind,
      classCode: definition.code,
      className: definition.name,
      toClassCode: definition.agesTo,
      toClassName: className(definition.kind, definition.agesTo),
      head: onHand,
    };
    if (definition.agesInPart) {
      const split = splits.get(key);
      if (split === undefined) {
        needsSplit.push(step);
        continue;
      }
      if (split === 0) continue;
      steps.push({ ...step, head: split });
      continue;
    }
    steps.push(step);
  }
  return { steps, needsSplit };
}

export type Negative = { key: string; date: string; balance: number };

export type HerdWalk = {
  /** Head at the end of `until` by class. */
  balances: Map<string, number>;
  /** The first time a class went below zero, if it did. */
  negative: Negative | null;
};

function apply(balances: Map<string, number>, key: string, delta: number) {
  balances.set(key, (balances.get(key) ?? 0) + delta);
}

/**
 * Walks from the first year's opening to the end of `until`: ageing at each
 * year start, then each day's movements netted. Same-day movements are
 * netted, so a purchase and a sale on one day are fine.
 */
export function walkHerd(input: {
  firstYearStart: string;
  yearEndMonth: number;
  openings: ReadonlyMap<string, number>;
  movements: readonly HerdMovement[];
  splits: ReadonlyMap<string, ReadonlyMap<string, number>>;
  until: string;
}): HerdWalk {
  const balances = new Map(input.openings);
  const sorted = [...input.movements].sort((a, b) => a.movementDate.localeCompare(b.movementDate));
  let negative: Negative | null = null;
  const check = (date: string) => {
    if (negative) return;
    for (const [key, balance] of balances) {
      if (balance < 0) {
        negative = { key, date, balance };
        return;
      }
    }
  };
  let index = 0;
  let yearStart = input.firstYearStart;
  while (yearStart <= input.until) {
    const { steps } = ageingSteps(balances, input.splits.get(yearStart) ?? new Map());
    for (const step of steps) {
      apply(balances, classKey(step.kind, step.classCode), -step.head);
      apply(balances, classKey(step.kind, step.toClassCode), step.head);
    }
    check(yearStart);
    const yearEnd = financialYearEnd(yearStart, input.yearEndMonth);
    const stop = yearEnd < input.until ? yearEnd : input.until;
    while (index < sorted.length && sorted[index].movementDate <= stop) {
      const date = sorted[index].movementDate;
      while (index < sorted.length && sorted[index].movementDate === date) {
        for (const [key, delta] of deltas(sorted[index])) apply(balances, key, delta);
        index += 1;
      }
      check(date);
    }
    yearStart = addDays(yearEnd, 1);
  }
  return { balances, negative };
}

/** The last date anything happens, so a negative check covers every later year. */
export function lastDate(movements: readonly HerdMovement[], fallback: string): string {
  return movements.reduce((latest, movement) => (movement.movementDate > latest ? movement.movementDate : latest), fallback);
}
