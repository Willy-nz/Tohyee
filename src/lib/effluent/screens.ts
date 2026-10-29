/*
 * Effluent's screens and their addresses (#487, decision 1070): Farm ›
 * More › Effluent, with its own address for each screen so a link from
 * Today, the Log, the map or the calendar opens the right one on the right
 * farm, and Back returns to where the person was. Pure; shared by the
 * screens and their tests.
 */

export const EFFLUENT_SCREENS = ["setup", "log", "ponds", "checks", "incidents", "pack"] as const;
export type EffluentScreen = (typeof EFFLUENT_SCREENS)[number];

export const EFFLUENT_SCREEN_TITLES: Record<EffluentScreen, string> = {
  setup: "Systems, map and consent",
  log: "Irrigation log",
  ponds: "Ponds and storage",
  checks: "Checks, faults and servicing",
  incidents: "Incidents",
  pack: "Council pack",
};

export type EffluentLink = { screen: EffluentScreen | null; farmId: string | null; record: string | null };

const FARM = /^[1-9]\d{0,17}$/;
const RECORD = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Reads an Effluent address; anything it doesn't know is ignored (the overview opens). */
export function readEffluentLink(params: { get(name: string): string | null }): EffluentLink {
  const view = params.get("view");
  const farm = params.get("farm");
  const record = params.get("record");
  return {
    screen: (EFFLUENT_SCREENS as readonly string[]).includes(view ?? "") ? (view as EffluentScreen) : null,
    farmId: farm && FARM.test(farm) ? farm : null,
    record: record && RECORD.test(record) ? record.toLowerCase() : null,
  };
}

export function effluentHref(target: { screen?: EffluentScreen | null; farmId?: string | null; record?: string | null } = {}): string {
  const query = new URLSearchParams();
  if (target.farmId) query.set("farm", target.farmId);
  if (target.screen) query.set("view", target.screen);
  if (target.record) query.set("record", target.record);
  const text = query.toString();
  return `/operations/farm/effluent${text ? `?${text}` : ""}`;
}
