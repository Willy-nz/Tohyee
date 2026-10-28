/*
 * What an offline farm pack holds (#472 stage 3, decisions 999-1007), and
 * how a screen's read is answered from it when Tohyee can't be reached.
 * Browser-safe: the server builds sections from this list
 * (src/lib/offline/pack-server.ts) and the page reads them
 * (src/lib/offline/packs.ts). The inventory in words is in
 * docs/MOBILE-APP.md.
 */

/** Records kept: the last 12 months (Jess, 28 October 2026). More on request. */
export const PACK_MONTHS = 12;
/** "Keep more history" on the storage page. */
export const EXTRA_PACK_MONTHS = 36;
/** A farm's pack is refreshed at most this often while the app is open and online. */
export const PACK_REFRESH_MINUTES = 15;
/** Photos are kept as small copies (longest side, pixels). Originals on request. */
export const PHOTO_COPY_PIXELS = 800;
/** Documents (safety data sheets) are kept when no bigger than this; larger ones on request. */
export const DOCUMENT_LIMIT_BYTES = 2 * 1024 * 1024;

export type SectionKey = "organisation" | "map" | "pasture" | "calendar" | "plans" | "soil" | "notebook" | "safety" | "equipment" | "people" | "photos";

export type SectionInfo = {
  key: SectionKey;
  label: string;
  /** What's in it, for the storage page and the inventory. */
  includes: string;
  /** False: one copy for the organisation, not per farm. */
  perFarm: boolean;
};

/** The sections, in the order they're fetched: the most useful first. */
export const PACK_SECTIONS: SectionInfo[] = [
  { key: "organisation", label: "Farms and settings", includes: "The farms you can see, which farm you were on, map settings and farm app tiles.", perFarm: false },
  { key: "safety", label: "Safety", includes: "Emergency details, hazards and no-go zones, reports and actions (never injury or medical details), what needs doing.", perFarm: true },
  { key: "map", label: "Map and paddocks", includes: "Paddocks with their boundaries and areas, and each paddock's last known cover, mob and grazing.", perFarm: true },
  { key: "pasture", label: "Pasture, grazing and feed", includes: "Farm cover and wedge, cover readings, grazings and feed for the last 12 months, and mobs in now.", perFarm: true },
  { key: "calendar", label: "Calendar and jobs", includes: "Your farm calendar from 12 months back to 3 months ahead (no email text).", perFarm: true },
  { key: "equipment", label: "Equipment and checklists", includes: "Machines, their checklists, last known status and recent checks; chemicals with safety data sheets.", perFarm: true },
  { key: "people", label: "Inductions and training", includes: "Inductions to read and sign, with the farm's hazards and emergency details, and training.", perFarm: true },
  { key: "plans", label: "Fertiliser plans", includes: "The farm's fertiliser plans and their applications, and products.", perFarm: true },
  { key: "soil", label: "Soil tests", includes: "Soil samples, test results and the summary.", perFarm: true },
  { key: "notebook", label: "Farm notebook", includes: "The farm notebook.", perFarm: false },
  { key: "photos", label: "Photos and documents", includes: "Small copies of safety photos, and safety data sheets up to 2 MB.", perFarm: true },
];

/** What's never in a pack, whoever you are (decision 1001). */
export const NEVER_IN_A_PACK = [
  "Injury and medical details, and restricted photos, even for owners",
  "Farm mail, and the email text behind calendar items",
  "The books: invoices, bills, bank, GST, reports",
  "Payroll and people's pay",
];

/** One stored read: the API path, the query it was asked with (no organisationId), and the answer. */
export type PackEntry = { path: string; query: Record<string, string>; body: unknown };

/** Query values that change from day to day (or page to page): ignored when answering from the pack. */
const VOLATILE = new Set(["organisationId", "onDate", "from", "to", "limit", "cursor", "version"]);

/** The query as api() sends it: strings, no empty values; a false flag is the same as none (`includeWithdrawn: false`). */
export function normaliseQuery(query: Record<string, string | number | boolean | null | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) if (value !== null && value !== undefined && value !== "" && value !== false) out[key] = String(value);
  return out;
}

function sameKeys(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)].filter((key) => !VOLATILE.has(key) && !FILTERED.has(key)));
  for (const key of keys) if ((a[key] ?? "") !== (b[key] ?? "")) return false;
  return true;
}

/** Query values answered by filtering what's stored (so they work offline), rather than by a separate stored answer. */
const FILTERED = new Set(["search", "category"]);

type Item = Record<string, unknown>;

/**
 * Answers a read from a pack's entries, or null. Day-to-day values (the
 * date asked about, a page size) are ignored: the answer is the last known
 * one, which the screen labels. A few reads are narrowed to what was asked:
 * the calendar to its dates, the notebook to its search and category.
 */
export function answerFromEntries(entries: PackEntry[], path: string, rawQuery: Record<string, string | number | boolean | null | undefined>): unknown | undefined {
  const query = normaliseQuery(rawQuery);
  const entry = entries.find((candidate) => candidate.path === path && sameKeys(candidate.query, query));
  if (!entry) return undefined;
  if (path === "/api/farming/calendar" && query.from && query.to && entry.body && typeof entry.body === "object") {
    const body = entry.body as { items?: Item[] };
    return { ...body, items: (body.items ?? []).filter((item) => typeof item.date !== "string" || (item.date >= query.from && item.date <= query.to)) };
  }
  if (path === "/api/farm-notebook" && entry.body && typeof entry.body === "object") {
    const body = entry.body as { notes?: Item[] };
    const search = (query.search ?? "").toLowerCase();
    return {
      ...body,
      notes: (body.notes ?? []).filter((note) => (!query.category || note.category === query.category) && (!search || JSON.stringify([note.title, note.body]).toLowerCase().includes(search))),
    };
  }
  return entry.body;
}

/** The ISO date `months` back from `today` (both YYYY-MM-DD). */
export function monthsBack(today: string, months: number): string {
  const date = new Date(`${today}T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() - months);
  return date.toISOString().slice(0, 10);
}

export function daysAhead(today: string, days: number): string {
  return new Date(Date.parse(`${today}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}
