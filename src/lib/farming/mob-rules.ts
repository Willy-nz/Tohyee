import { cmp, dec, divide, sub, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";
import { className, findClass, KIND_NAMES, LIVESTOCK_CLASSES, LIVESTOCK_KINDS, type LivestockKind } from "@/lib/livestock/classes";

/*
 * Mobs' rules and words (decisions 1421-1430; MOB1-MOB10). Browser-safe:
 * no server imports.
 */

export const MOB_EVENT_TYPES = ["created", "moved", "split_out", "split_in", "merged_out", "merged_in", "sold", "died", "born", "bought", "reclass", "weighed", "counted", "closed"] as const;
export type MobEventType = (typeof MOB_EVENT_TYPES)[number];

export const MOB_EVENT_LABELS: Record<MobEventType, string> = {
  created: "Added",
  moved: "Moved",
  split_out: "Split off",
  split_in: "Split from",
  merged_out: "Merged into",
  merged_in: "Merged in",
  sold: "Sold",
  died: "Died",
  born: "Born",
  bought: "Bought",
  reclass: "Class changed",
  weighed: "Weighed",
  counted: "Counted",
  closed: "Closed",
};

/** What can be done to a mob, in the order the screen offers them. */
export const MOB_ACTIONS = ["move", "weigh", "deaths", "births", "split", "merge", "sell", "buy", "reclass", "count"] as const;
export type MobAction = (typeof MOB_ACTIONS)[number];

export const MOB_ACTION_LABELS: Record<MobAction, string> = {
  move: "Move",
  weigh: "Record a weight",
  deaths: "Record deaths",
  births: "Record births",
  split: "Split",
  merge: "Merge",
  sell: "Sell",
  buy: "Add bought stock",
  reclass: "Change class",
  count: "Correct the count",
};

/**
 * Actions that change the books' head count by class (sold, bought, class
 * change) need the bookkeeper role; field work (moves, weights, deaths,
 * births, splits, merges, counts) farm staff can record too (decision 1423).
 */
export const BOOKKEEPER_ACTIONS: readonly MobAction[] = ["sell", "buy", "reclass"];

/** Actions that make a livestock movement when Livestock is on (MOB3-MOB7). */
export const MOVEMENT_FOR_ACTION: Partial<Record<MobAction, "sale" | "purchase" | "death" | "birth" | "reclass">> = {
  sell: "sale",
  buy: "purchase",
  deaths: "death",
  births: "birth",
  reclass: "reclass",
};

/** Actions the phone can keep and send later (the offline queue). */
export const OFFLINE_ACTIONS: readonly MobAction[] = ["move", "weigh", "deaths", "births", "count"];

export const CREATED_HOW = ["on_farm", "bought", "born"] as const;
export type CreatedHow = (typeof CREATED_HOW)[number];
export const CREATED_HOW_LABELS: Record<CreatedHow, string> = {
  on_farm: "Already on the farm",
  bought: "Bought",
  born: "Born here",
};

/** A mob's name on screen: its own name, or its class. */
export function mobName(mob: { name: string | null; kind: string; classCode: string }): string {
  return mob.name ?? className(mob.kind, mob.classCode);
}

export type Gain = { kg: string; days: number; kgPerDay: string | null };

/** Weight change from one weighing to the next: 412.0 → 436.0 kg over 30 days is +24.0 kg, 0.80 kg a day (MOB8). */
export function weightGain(earlier: { date: string; averageKg: string }, later: { date: string; averageKg: string }): Gain {
  const days = Math.round((Date.parse(`${later.date}T00:00:00Z`) - Date.parse(`${earlier.date}T00:00:00Z`)) / 86_400_000);
  const kg = sub(dec(later.averageKg), dec(earlier.averageKg));
  return { kg: toFixedString(kg, 1), days, kgPerDay: days > 0 ? toFixedString(divide(kg, dec(String(days)), 2), 2) : null };
}

/** "+24.0 kg (0.80 kg a day)" */
export function gainText(gain: Gain): string {
  const sign = cmp(dec(gain.kg), ZERO_DECIMAL) > 0 ? "+" : "";
  return `${sign}${gain.kg} kg over ${gain.days} day${gain.days === 1 ? "" : "s"}${gain.kgPerDay ? ` (${sign}${gain.kgPerDay} kg a day)` : ""}`;
}

const norm = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** A kind from a file's words ("Sheep", "beef", "Dairy cows", "red deer"). */
export function kindFrom(text: string): LivestockKind | null {
  const value = norm(text);
  if (!value) return null;
  const exact = LIVESTOCK_KINDS.find((kind) => kind === value.replace(/ /g, "_") || norm(KIND_NAMES[kind]) === value);
  if (exact) return exact;
  if (value.includes("sheep") || value.includes("ewe") || value.includes("lamb")) return "sheep";
  if (value.includes("dairy") && value.includes("goat")) return "goats_dairy";
  if (value.includes("angora")) return "goats_angora";
  if (value.includes("cashmere")) return "goats_cashmere";
  if (value.includes("dairy")) return "dairy_cattle";
  if (value.includes("beef") || value.includes("cattle")) return "beef_cattle";
  if (value.includes("red deer") || value === "deer" || value.includes("wapiti") || value.includes("elk")) return "deer_red";
  if (value.includes("deer")) return "deer_other";
  return null;
}

/** A class of a kind from a file's words: its code, or its name. */
export function classFrom(kind: LivestockKind, text: string): string | null {
  const value = norm(text);
  if (!value) return null;
  const classes = LIVESTOCK_CLASSES.filter((entry) => entry.kind === kind);
  return (classes.find((entry) => norm(entry.code) === value || entry.code === text.trim()) ?? classes.find((entry) => norm(entry.name) === value))?.code ?? null;
}

export function isBirthClass(kind: string, classCode: string): boolean {
  return findClass(kind, classCode)?.birth === true;
}

/** "Paddock 4" for a paddock named by number, else its name ("Back flat"). */
export function paddockLabel(name: string): string {
  return /^\d/.test(name) ? `Paddock ${name}` : name;
}
