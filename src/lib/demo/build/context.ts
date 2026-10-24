import { randomUUID } from "node:crypto";
import { type Actor, type OrgTx, withOrganisationTransaction } from "@/lib/db/org-transaction";
import type { OrganisationRecord } from "@/lib/organisations/registry";
import { moneyBetween, seededRandom } from "@/lib/demo/plan";

/**
 * What every part of the demo farm build shares: the organisation, who it's
 * made for (everything is entered as them, as if they'd typed it), a seeded
 * random number source (so the same day gives the same farm) and the dates.
 */
export type DemoContext = {
  organisation: OrganisationRecord;
  actor: Actor;
  /** Today, in New Zealand: nothing is entered after it. */
  today: string;
  /** The first day of the books (1 June, a financial year's start). */
  start: string;
  random: () => number;
  /** Runs one transaction in the demo organisation's database. */
  as<T>(work: (tx: OrgTx) => Promise<T>): Promise<T>;
  key(label: string): string;
  /** Between min and max, two decimal places, as text. */
  money(min: number, max: number): string;
  /** A whole number between min and max (both included). */
  whole(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  /** Ids of what earlier steps made, by name. */
  ids: Map<string, string>;
  id(name: string): string;
};

export function demoContext(organisation: OrganisationRecord, actor: Actor, today: string, start: string, seed: number): DemoContext {
  const random = seededRandom(seed);
  const ids = new Map<string, string>();
  return {
    organisation,
    actor,
    today,
    start,
    random,
    ids,
    as: (work) => withOrganisationTransaction(organisation, actor, work),
    key: (label) => `demo-${label}-${randomUUID()}`,
    money: (min, max) => moneyBetween(random, min, max),
    whole: (min, max) => min + Math.floor(random() * (max - min + 1)),
    pick: (items) => items[Math.floor(random() * items.length)],
    id(name) {
      const value = ids.get(name);
      if (!value) throw new Error(`The demo build has no ${name} yet.`);
      return value;
    },
  };
}
