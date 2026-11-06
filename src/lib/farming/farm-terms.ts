import { KIND_NAMES, LIVESTOCK_CLASSES, LIVESTOCK_KINDS } from "@/lib/livestock/classes";
import { MOB_ACTION_LABELS, MOB_ACTIONS } from "@/lib/farming/mob-rules";

/*
 * Farm words (decision 1448): an organisation's own names for "mob", the
 * mob actions, kinds of stock and classes, on screens only. What's stored,
 * counted and sent to the books keeps IRD's classes and Tohyee's own
 * words. Browser-safe.
 */

export type FarmTerms = Readonly<Record<string, string>>;

export type TermEntry = { key: string; group: "Words" | "Actions" | "Kinds of stock" | "Classes"; standard: string };

/** Every word a farm can rename, with Tohyee's own. */
export const TERM_ENTRIES: readonly TermEntry[] = [
  { key: "mob", group: "Words", standard: "Mob" },
  { key: "mobs", group: "Words", standard: "Mobs" },
  { key: "paddock", group: "Words", standard: "Paddock" },
  ...MOB_ACTIONS.map((action) => ({ key: `action:${action}`, group: "Actions" as const, standard: MOB_ACTION_LABELS[action] })),
  { key: "action:treat", group: "Actions", standard: "Treat" },
  ...LIVESTOCK_KINDS.map((kind) => ({ key: `kind:${kind}`, group: "Kinds of stock" as const, standard: KIND_NAMES[kind] })),
  ...LIVESTOCK_CLASSES.map((entry) => ({ key: `class:${entry.kind}.${entry.code}`, group: "Classes" as const, standard: entry.name })),
];

export function isTermKey(key: string): boolean {
  return TERM_ENTRIES.some((entry) => entry.key === key);
}

/** A word as this farm says it: its own, or Tohyee's. */
export function term(terms: FarmTerms | null | undefined, key: string, standard?: string): string {
  return terms?.[key] ?? standard ?? TERM_ENTRIES.find((entry) => entry.key === key)?.standard ?? key;
}

/** A class as the farm says it, with IRD's name beside it when renamed: "Milkers (Mixed-age cows)". */
export function classTerm(terms: FarmTerms | null | undefined, kind: string, code: string, standard: string): string {
  const own = terms?.[`class:${kind}.${code}`];
  return own ? `${own} (${standard})` : standard;
}
