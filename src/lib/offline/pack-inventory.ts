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

export type SectionKey = "organisation" | "map" | "pasture" | "calendar" | "plans" | "soil" | "notebook" | "safety" | "equipment" | "people" | "effluent" | "photos";

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
  { key: "effluent", label: "Effluent", includes: "Effluent systems, ponds, blocks, no-apply zones and consent conditions, the last 30 days of runs, pond readings and days not applied, checks, servicing, incidents and what's due.", perFarm: true },
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

/** Query values that never change an answer (the organisation is the scope's; a version only reloads). */
const IGNORED = new Set(["organisationId", "version"]);

/** The query as api() sends it: strings, no empty values; a false flag is the same as none (`includeWithdrawn: false`). */
export function normaliseQuery(query: Record<string, string | number | boolean | null | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) if (value !== null && value !== undefined && value !== "" && value !== false) out[key] = String(value);
  return out;
}

/** A downloaded history (grazings, feed, cover readings): every record from `heldFrom`, paged on the device (decision 1054). */
export type HistoryRead = { pattern: RegExp; rows: string; date: string };

export const HISTORY_READS: HistoryRead[] = [
  { pattern: /^\/api\/farming\/farms\/[^/]+\/grazings$/, rows: "grazings", date: "inOn" },
  { pattern: /^\/api\/farming\/farms\/[^/]+\/supplements$/, rows: "supplements", date: "fedOn" },
  { pattern: /^\/api\/farming\/farms\/[^/]+\/pasture\/readings$/, rows: "readings", date: "measuredOn" },
];

/** What a downloaded history covers, kept with it: from this date, and whether every record since then is there. */
export type HistoryBounds = { heldFrom: string; complete: boolean; count: number };

/** A history page's size when none is asked for: the server's (decision 901). */
export const HISTORY_PAGE_SIZE = 25;
/** Records per read when a pack downloads a history: the server's most. */
export const HISTORY_DOWNLOAD_PAGE = 1000;
/** A pack keeps at most this many of one history; more is said, never implied (decision 1054). */
export const HISTORY_DOWNLOAD_MAX = 20_000;

/** Query values a history answers on the device: dates, paddock and paging. */
const HISTORY_LOCAL = new Set(["from", "to", "paddockId", "cursor", "limit"]);
/** Query values the calendar and notebook answer by filtering what's stored. */
const FILTERED: Record<string, Set<string>> = {
  "/api/farming/calendar": new Set(["from", "to"]),
  "/api/farming/safety/due": new Set(["from", "to"]),
  "/api/farm-notebook": new Set(["search", "category"]),
};

function historyRead(path: string): HistoryRead | null {
  return HISTORY_READS.find((read) => read.pattern.test(path)) ?? null;
}

/** Whether a stored read answers this query: every value must match, bar those answered on the device and a summary's date. */
function matches(entry: PackEntry, path: string, query: Record<string, string>, local: Set<string>): boolean {
  const keys = new Set([...Object.keys(entry.query), ...Object.keys(query)].filter((key) => !IGNORED.has(key) && !local.has(key) && key !== "onDate"));
  for (const key of keys) if ((entry.query[key] ?? "") !== (query[key] ?? "")) return false;
  // A summary for a date (the farm's cover on a day) is only the saved one's day or later: an earlier day was never worked out here (decision 1055).
  if (query.onDate && entry.query.onDate && query.onDate < entry.query.onDate) return false;
  return true;
}

type Item = Record<string, unknown>;

/** Newest first by date, then id (ids are whole numbers as text). */
function before(a: { date: string; id: string }, b: { date: string; id: string }): boolean {
  if (a.date !== b.date) return a.date < b.date;
  if (a.id.length !== b.id.length) return a.id.length < b.id.length;
  return a.id < b.id;
}

const CURSOR = /^(\d{4}-\d{2}-\d{2})_([1-9]\d{0,17})$/;

/**
 * A page of a downloaded history, as the server would give it for the
 * records on the device: dates, paddock, cursor and page size honoured,
 * newest first, ending with `next: null` (decision 1054). Undefined for a
 * cursor that isn't one.
 */
export function historyPage(body: Item, read: HistoryRead, query: Record<string, string>): Item | undefined {
  const rows = (Array.isArray(body[read.rows]) ? (body[read.rows] as Item[]) : []).map((row) => ({ row, date: String(row[read.date] ?? ""), id: String(row.id ?? "") }));
  rows.sort((a, b) => (before(a, b) ? 1 : before(b, a) ? -1 : 0));
  let after: { date: string; id: string } | null = null;
  if (query.cursor) {
    const match = CURSOR.exec(query.cursor);
    if (!match) return undefined;
    after = { date: match[1], id: match[2] };
  }
  const limit = query.limit && /^\d+$/.test(query.limit) ? Math.max(1, Math.min(Number(query.limit), HISTORY_DOWNLOAD_PAGE)) : HISTORY_PAGE_SIZE;
  const chosen = rows.filter(
    (entry) => (!query.paddockId || String(entry.row.paddockId ?? "") === query.paddockId) && (!query.from || entry.date >= query.from) && (!query.to || entry.date <= query.to) && (!after || before(entry, after)),
  );
  const page = chosen.slice(0, limit);
  const last = page[page.length - 1];
  const next = chosen.length > limit && last ? `${last.date}_${last.id}` : null;
  const bounds = (body.offline as HistoryBounds | undefined) ?? null;
  return { ...body, [read.rows]: page.map((entry) => entry.row), next, offline: bounds };
}

/**
 * Answers a read from a pack's entries, or null. Downloaded histories are
 * paged on the device (decision 1054); the calendar is narrowed to its
 * dates, the notebook to its search and category. A summary for a date is
 * answered only for the saved day or later, as the last known one, which
 * the screen labels (decision 1055). Anything else must match exactly.
 */
export function answerFromEntries(entries: PackEntry[], path: string, rawQuery: Record<string, string | number | boolean | null | undefined>): unknown | undefined {
  const query = normaliseQuery(rawQuery);
  const history = query.open ? null : historyRead(path);
  const local = history ? HISTORY_LOCAL : (FILTERED[path] ?? new Set<string>());
  const entry = entries.find((candidate) => candidate.path === path && matches(candidate, path, query, local));
  if (!entry) return undefined;
  if (history && entry.body && typeof entry.body === "object") return historyPage(entry.body as Item, history, query);
  if ((path === "/api/farming/calendar" || path === "/api/farming/safety/due") && entry.body && typeof entry.body === "object") {
    const body = entry.body as { items?: Item[] };
    return { ...body, items: (body.items ?? []).filter((item) => typeof item.date !== "string" || ((!query.from || item.date >= query.from) && (!query.to || item.date <= query.to))) };
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

/** What a history answered from the device covers, in words (decision 1054). Null when it came from Tohyee. */
export function offlineHistoryNote(bounds: HistoryBounds | null | undefined): string | null {
  if (!bounds || typeof bounds.heldFrom !== "string") return null;
  const from = new Date(`${bounds.heldFrom}T00:00:00Z`).toLocaleDateString("en-NZ", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  return bounds.complete
    ? `From this device: records from ${from} on. Older ones need a connection.`
    : `From this device: only the newest ${bounds.count.toLocaleString("en-NZ")} records since ${from} are kept here. The rest need a connection.`;
}
