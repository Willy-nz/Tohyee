import { daysBetween } from "@/lib/farming/farm-words";

/*
 * Colouring the farm map (#447, decision 907). Pure and browser-safe. Two
 * facts, never a judgement (decisions 516 and 559): how many days since a
 * paddock was last grazed, and how old its latest cover reading is. Bands
 * use the chart theme's sequential colours (decisions 599-601), so they
 * follow light and dark; the words say what was recorded, not whether it's
 * good or bad.
 */

export type MapColouring = "grazed" | "cover_age";

export const MAP_COLOURINGS: Array<{ value: MapColouring; label: string }> = [
  { value: "grazed", label: "Days since grazed" },
  { value: "cover_age", label: "Cover reading age" },
];

export type PaddockFacts = { inNow: boolean; lastGrazedOn: string | null; coverOn: string | null };

export type Band = { key: string; label: string; colour: string };

const NONE = "var(--surface-sunken)";
const IN_NOW = "var(--chart-4)";

/** Days-since-grazed bands, newest first: the colour gets stronger as the days go by. */
export const GRAZED_BANDS: Band[] = [
  { key: "in", label: "Mob in now", colour: IN_NOW },
  { key: "0-7", label: "Grazed 0–7 days ago", colour: "var(--chart-seq-1)" },
  { key: "8-14", label: "8–14 days", colour: "var(--chart-seq-3)" },
  { key: "15-21", label: "15–21 days", colour: "var(--chart-seq-5)" },
  { key: "22-30", label: "22–30 days", colour: "var(--chart-seq-6)" },
  { key: "31+", label: "More than 30 days", colour: "var(--chart-seq-7)" },
  { key: "none", label: "No grazing recorded", colour: NONE },
];

/** Cover-reading-age bands. */
export const COVER_AGE_BANDS: Band[] = [
  { key: "0-7", label: "Read 0–7 days ago", colour: "var(--chart-seq-1)" },
  { key: "8-14", label: "8–14 days", colour: "var(--chart-seq-3)" },
  { key: "15-30", label: "15–30 days", colour: "var(--chart-seq-5)" },
  { key: "31+", label: "More than 30 days", colour: "var(--chart-seq-7)" },
  { key: "none", label: "No reading", colour: NONE },
];

const band = (bands: Band[], key: string) => bands.find((entry) => entry.key === key)!;

/** Which band a paddock is in for a colouring, on `today`. */
export function paddockBand(facts: PaddockFacts, colouring: MapColouring, today: string): Band {
  if (colouring === "grazed") {
    if (facts.inNow) return band(GRAZED_BANDS, "in");
    if (!facts.lastGrazedOn) return band(GRAZED_BANDS, "none");
    const days = Math.max(0, daysBetween(facts.lastGrazedOn, today));
    return band(GRAZED_BANDS, days <= 7 ? "0-7" : days <= 14 ? "8-14" : days <= 21 ? "15-21" : days <= 30 ? "22-30" : "31+");
  }
  if (!facts.coverOn) return band(COVER_AGE_BANDS, "none");
  const days = Math.max(0, daysBetween(facts.coverOn, today));
  return band(COVER_AGE_BANDS, days <= 7 ? "0-7" : days <= 14 ? "8-14" : days <= 30 ? "15-30" : "31+");
}

export function bandsFor(colouring: MapColouring): Band[] {
  return colouring === "grazed" ? GRAZED_BANDS : COVER_AGE_BANDS;
}
