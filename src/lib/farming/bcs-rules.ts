import { ValidationError } from "@/lib/errors";
import { add, cmp, dec, divide, mul, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";

/*
 * Body condition score rules (decisions 1487-1490; examples BCS1-BCS6,
 * common NZ practice, not yet reviewed). Browser-safe: no database.
 *
 * - The scale is per kind of stock: 1-10 for cattle (DairyNZ for dairy
 *   cows, Beef + Lamb New Zealand for beef cows) and 1-5 for sheep, deer
 *   and goats (Beef + Lamb New Zealand for ewes, Deer Industry New Zealand
 *   for deer; no NZ body publishes one for goats, so 1-5 is used and the
 *   farm can change it). A farm can change any kind's scale.
 * - Scores go in half points. A mob's average is to one place.
 * - Targets only where a recognised NZ source gives them, and only on the
 *   source's own scale. The descriptions are Tohyee's own words.
 */

export const BCS_SCALES = ["1_10", "1_5"] as const;
export type BcsScale = (typeof BCS_SCALES)[number];

export const SCALE_LABELS: Record<BcsScale, string> = { "1_10": "1 to 10", "1_5": "1 to 5" };
export const SCALE_MAX: Record<BcsScale, number> = { "1_10": 10, "1_5": 5 };

/** What each whole score looks like, in Tohyee's words (half points sit between). */
export const SCALE_WORDS: Record<BcsScale, Array<{ score: string; words: string }>> = {
  "1_10": [
    { score: "1", words: "Emaciated: every bone sharp, no fat anywhere." },
    { score: "2", words: "Very thin: hip bones, spine and ribs stand out." },
    { score: "3", words: "Thin: ribs and spine easy to see; deep hollows by the tail." },
    { score: "4", words: "Lean: ribs seen, a little cover over the hips and spine." },
    { score: "5", words: "Moderate: ribs only just seen, back fairly smooth." },
    { score: "6", words: "Good: ribs not seen, hips rounded, a little fat by the tail." },
    { score: "7", words: "Well covered: smooth all over, fat building by the tail." },
    { score: "8", words: "Fat: bones hard to find, tail head padded." },
    { score: "9", words: "Very fat: rolls of fat, tail head buried." },
    { score: "10", words: "Obese: bones can't be found, moves heavily." },
  ],
  "1_5": [
    { score: "1", words: "Very thin: spine sharp, no fat or muscle over the loin." },
    { score: "2", words: "Thin: spine easy to feel, little cover over the loin." },
    { score: "3", words: "Moderate: spine felt with some pressure, loin full." },
    { score: "4", words: "Good to fat: spine felt only with firm pressure." },
    { score: "5", words: "Very fat: spine can't be felt, fat over the loin and tail." },
  ],
};

export const BCS_KINDS = ["dairy_cattle", "beef_cattle", "sheep", "deer_red", "deer_other", "goats_angora", "goats_cashmere", "goats_dairy"] as const;

/** The default scale for a kind of stock (decision 1487). */
export function defaultScale(kind: string): BcsScale {
  return kind === "dairy_cattle" || kind === "beef_cattle" ? "1_10" : "1_5";
}

export type BcsTarget = { when: string; score: string; who: string | null };
export type BcsTargets = { source: string; targets: BcsTarget[]; floor: { score: string; words: string } | null };

/** Targets from a recognised NZ source, on its own scale only (decision 1489); null where there are none. */
export function targetsFor(kind: string, scale: BcsScale): BcsTargets | null {
  if (kind === "dairy_cattle" && scale === "1_10") {
    return {
      source: "DairyNZ, Body condition score reference guide (2024)",
      targets: [
        { when: "At calving", score: "5.0", who: "mature cows" },
        { when: "At calving", score: "5.5", who: "first and second calvers" },
        { when: "At mating, at least", score: "4.0", who: "mature cows" },
        { when: "At mating, at least", score: "4.5", who: "first and second calvers" },
      ],
      floor: null,
    };
  }
  if (kind === "beef_cattle" && scale === "1_10") {
    return {
      source: "Beef + Lamb New Zealand, Beef cow BCS",
      targets: [
        { when: "At calving", score: "5.0", who: "mature British-breed cows" },
        { when: "At mating, at least", score: "6.0", who: "mature British-breed cows" },
        { when: "At weaning", score: "7.0", who: "mature British-breed cows" },
      ],
      floor: { score: "4.0", words: "the minimum for all cows" },
    };
  }
  if (kind === "sheep" && scale === "1_5") {
    return { source: "Beef + Lamb New Zealand, Ewe body condition scoring, fact sheet 201 (2022)", targets: [{ when: "All year", score: "3.0", who: "or better, the whole flock" }], floor: { score: "3.0", words: "the year-round target" } };
  }
  if ((kind === "deer_red" || kind === "deer_other") && scale === "1_5") {
    return { source: "Deer Industry New Zealand, Deer Hub: body condition score", targets: [], floor: { score: "2.0", words: "below this needs a vet or action now" } };
  }
  return null;
}

/** A score on a scale, in half points: "4.5" → "4.5", "5" → "5.0". */
export function parseScore(input: unknown, scale: BcsScale, label = "Score"): string {
  const text = typeof input === "number" ? String(input) : typeof input === "string" ? input.trim() : "";
  if (!/^\d{1,2}(\.\d)?$/.test(text)) throw new ValidationError(`${label} must be a number from 1 to ${SCALE_MAX[scale]}, in half points.`);
  const value = dec(text);
  const tenths = Number(toFixedString(mul(value, dec("10")), 0));
  if (tenths % 5 !== 0 || tenths < 10 || tenths > SCALE_MAX[scale] * 10) throw new ValidationError(`${label} must be from 1 to ${SCALE_MAX[scale]}, in half points (such as 4.5).`);
  return toFixedString(value, 1);
}

/** A mob's average to one place, 1 to the scale's top. */
export function parseAverage(input: unknown, scale: BcsScale): string {
  const text = typeof input === "number" ? String(input) : typeof input === "string" ? input.trim() : "";
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(text)) throw new ValidationError(`The average must be a number from 1 to ${SCALE_MAX[scale]}.`);
  const value = dec(text);
  if (cmp(value, dec("1")) < 0 || cmp(value, dec(String(SCALE_MAX[scale]))) > 0) throw new ValidationError(`The average must be from 1 to ${SCALE_MAX[scale]}.`);
  return toFixedString(divide(value, dec("1"), 1), 1);
}

/** The scores a person picks from: 1, 1.5 … the top. */
export function scoreSteps(scale: BcsScale): string[] {
  const steps: string[] = [];
  for (let tenths = 10; tenths <= SCALE_MAX[scale] * 10; tenths += 5) steps.push((tenths / 10).toFixed(1));
  return steps;
}

export type Tally = Record<string, number>;
export type TallySummary = { tally: Tally; head: number; average: string; lowest: string; highest: string; belowFloor: number | null };

/**
 * A mob's quick tally (BCS2): how many at each score. The average is
 * weighted by head, to one place; 12 at 4.0, 30 at 4.5 and 8 at 5.0 is
 * 4.5 (223.0 / 50 = 4.46).
 */
export function tallySummary(input: unknown, scale: BcsScale, floor: string | null = null): TallySummary {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ValidationError("The tally is how many at each score.");
  const tally: Tally = {};
  let head = 0;
  let total = ZERO_DECIMAL;
  let belowFloor = 0;
  for (const [rawScore, rawCount] of Object.entries(input as Record<string, unknown>)) {
    if (rawCount === "" || rawCount === null || rawCount === undefined || rawCount === 0 || rawCount === "0") continue;
    const score = parseScore(rawScore, scale, "A tally score");
    const count = typeof rawCount === "number" ? rawCount : Number(String(rawCount).trim());
    if (!Number.isInteger(count) || count < 0 || count > 100000) throw new ValidationError(`The number at ${score} must be a whole number.`);
    tally[score] = (tally[score] ?? 0) + count;
    head += count;
    total = add(total, mul(dec(score), dec(String(count))));
    if (floor && cmp(dec(score), dec(floor)) < 0) belowFloor += count;
  }
  if (!head) throw new ValidationError("Count at least one animal in the tally.");
  if (head > 100000) throw new ValidationError("A tally can have at most 100,000 head.");
  const scores = Object.keys(tally).sort((a, b) => cmp(dec(a), dec(b)));
  const sorted: Tally = {};
  for (const score of scores) sorted[score] = tally[score];
  return { tally: sorted, head, average: toFixedString(divide(total, dec(String(head)), 1), 1), lowest: scores[0], highest: scores[scores.length - 1], belowFloor: floor ? belowFloor : null };
}

/** The average of animals' own scores on one day, to one place (a mob's trend from its tagged animals). */
export function averageOf(scores: readonly string[]): string | null {
  if (!scores.length) return null;
  let total = ZERO_DECIMAL;
  for (const score of scores) total = add(total, dec(score));
  return toFixedString(divide(total, dec(String(scores.length)), 1), 1);
}

/** "BCS 4.5" or, for a mob, "BCS 4.5 average of 50 (4.0 to 5.0)". */
export function bcsText(record: { score: string; headScored: number | null; tally: Tally | null }): string {
  if (!record.tally && !record.headScored) return `BCS ${record.score}`;
  const scores = record.tally ? Object.keys(record.tally) : [];
  const range = scores.length > 1 ? ` (${scores[0]} to ${scores[scores.length - 1]})` : "";
  return `BCS ${record.score} average${record.headScored ? ` of ${record.headScored}` : ""}${range}`;
}

/** The label an AI suggestion always carries (decision 1491). */
export const AI_ESTIMATE_LABEL = "AI estimate from a photo, not a trained BCS assessment";
