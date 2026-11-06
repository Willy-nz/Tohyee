/*
 * Animal register rules (decisions 1481-1486; examples AN1-AN8, common NZ
 * practice, not yet reviewed). Browser-safe: no database.
 */

export const ANIMAL_SEXES = ["female", "male", "castrated"] as const;
export type AnimalSex = (typeof ANIMAL_SEXES)[number];
export const SEX_LABELS: Record<AnimalSex, string> = { female: "Female", male: "Male (entire)", castrated: "Castrated" };

export const ANIMAL_STATUSES = ["on_farm", "sold", "dead", "missing"] as const;
export type AnimalStatus = (typeof ANIMAL_STATUSES)[number];
export const STATUS_LABELS: Record<AnimalStatus, string> = { on_farm: "On farm", sold: "Sold", dead: "Dead", missing: "Missing" };

export const HOW_IN_LABELS: Record<string, string> = { tagged: "Tagged into", moved: "Moved into", split: "Split into", merged: "Merged into" };
export const HOW_OUT_LABELS: Record<string, string> = { moved: "moved out", split: "split out", merged: "merged out", sold: "sold", died: "died", corrected: "taken out (a correction)" };

/** Tags compared as people type them: case and spaces don't matter ("YB 123" is "yb123"). */
export function tagKey(tag: string): string {
  return tag.toLowerCase().replace(/\s+/g, "");
}

/**
 * The tags typed on a treatment's "animals" ("214, 233 and 301"; "YB12/YB13"):
 * each word that has a digit in it, as a tag key. Words like "lame cows"
 * aren't tags.
 */
export function tagsInText(text: string | null): string[] {
  if (!text) return [];
  return [...new Set(text.split(/[\s,;/&+]+|\band\b/i).map((word) => word.trim().replace(/^#/, "")).filter((word) => /\d/.test(word)).map(tagKey))];
}

/** "N of M head tagged" for a mob with animal records (decision 1482). */
export function taggedText(tagged: number, head: number): string | null {
  if (!tagged) return null;
  return `${tagged.toLocaleString("en-NZ")} of ${head.toLocaleString("en-NZ")} head tagged`;
}

/** Age in plain words from a birth date: "2 years 3 months", "7 months", "3 weeks". */
export function ageText(birthOn: string | null, today: string): string | null {
  if (!birthOn || birthOn > today) return null;
  const [by, bm, bd] = birthOn.split("-").map(Number);
  const [ty, tm, td] = today.split("-").map(Number);
  let months = (ty - by) * 12 + (tm - bm) - (td < bd ? 1 : 0);
  if (months < 1) {
    const days = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${birthOn}T00:00:00Z`)) / 86_400_000);
    const weeks = Math.floor(days / 7);
    return weeks >= 1 ? `${weeks} week${weeks === 1 ? "" : "s"}` : `${days} day${days === 1 ? "" : "s"}`;
  }
  const years = Math.floor(months / 12);
  months -= years * 12;
  return [years ? `${years} year${years === 1 ? "" : "s"}` : "", months ? `${months} month${months === 1 ? "" : "s"}` : ""].filter(Boolean).join(" ");
}

/** A sex from a file's words: F, female, cow, ewe, heifer; M, bull, ram; steer, wether, castrated. */
export function sexFrom(text: string): AnimalSex | null {
  const value = text.trim().toLowerCase();
  if (!value) return null;
  if (["f", "female", "cow", "ewe", "heifer", "hind", "doe", "nanny", "hogget ewe"].includes(value)) return "female";
  if (["m", "male", "bull", "ram", "stag", "buck", "billy", "entire"].includes(value)) return "male";
  if (["c", "castrated", "steer", "wether", "bullock", "s", "w"].includes(value)) return "castrated";
  return null;
}

/** The animal a typed tag or EID is (quick entry): the visual tag first, then the EID; case and spaces don't matter. */
export function findAnimal<T extends { tag: string; eid: string | null }>(animals: readonly T[], typed: string): T | null {
  const key = tagKey(typed);
  if (!key) return null;
  return animals.find((animal) => tagKey(animal.tag) === key) ?? animals.find((animal) => animal.eid !== null && tagKey(animal.eid) === key) ?? null;
}
