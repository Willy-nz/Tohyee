/*
 * Builds offline farm packs on the server (#472 stage 3, decisions
 * 999-1007). A section is the answers to the same reads the farm screens
 * make, got by calling those routes' own handlers with the person's own
 * request, so every permission (role, farm access, farm staff, restricted
 * details) is exactly the screens'. Then what must never leave the server
 * in a pack is taken out, whoever is asking (decision 1001): injury and
 * medical details and restricted photos, and email text behind calendar
 * items. Reads a role isn't allowed are left out and named.
 */

import { GET as calendarGet } from "@/app/api/farming/calendar/route";
import { GET as grazingsGet } from "@/app/api/farming/farms/[farmId]/grazings/route";
import { GET as mobsGet } from "@/app/api/farming/farms/[farmId]/mobs/route";
import { GET as stockingGet } from "@/app/api/farming/farms/[farmId]/stocking/route";
import { GET as timelineGet } from "@/app/api/farming/farms/[farmId]/timeline/route";
import { GET as farmTermsGet } from "@/app/api/farming/farm-terms/route";
import { GET as rotationGet } from "@/app/api/farming/farms/[farmId]/rotation/route";
import { GET as breedingGet } from "@/app/api/farming/mobs/[mobId]/breeding/route";
import { GET as treatmentsGet } from "@/app/api/farming/farms/[farmId]/treatments/route";
import { GET as productStockGet } from "@/app/api/farming/product-stock/route";
import { GET as mobGet } from "@/app/api/farming/mobs/[mobId]/route";
import { GET as paddockStatusGet } from "@/app/api/farming/farms/[farmId]/paddock-status/route";
import { GET as paddocksGet } from "@/app/api/farming/farms/[farmId]/paddocks/route";
import { GET as pastureGet } from "@/app/api/farming/farms/[farmId]/pasture/route";
import { GET as plansGet } from "@/app/api/farming/farms/[farmId]/plans/route";
import { GET as soilSamplesGet } from "@/app/api/farming/farms/[farmId]/soil-samples/route";
import { GET as soilSummaryGet } from "@/app/api/farming/farms/[farmId]/soil-summary/route";
import { GET as soilTestsGet } from "@/app/api/farming/farms/[farmId]/soil-tests/route";
import { GET as supplementsGet } from "@/app/api/farming/farms/[farmId]/supplements/route";
import { GET as farmsGet } from "@/app/api/farming/farms/route";
import { GET as lastFarmGet } from "@/app/api/farming/last-farm/route";
import { GET as launchersGet } from "@/app/api/farming/launchers/route";
import { GET as paddockHistoryGet } from "@/app/api/farming/paddocks/[paddockId]/history/route";
import { GET as paddockPastureGet } from "@/app/api/farming/paddocks/[paddockId]/pasture/route";
import { GET as paddockGet } from "@/app/api/farming/paddocks/[paddockId]/route";
import { GET as readingsGet } from "@/app/api/farming/farms/[farmId]/pasture/readings/route";
import { GET as safetyDueGet } from "@/app/api/farming/safety/due/route";
import { GET as tractorEquipmentGet } from "@/app/api/farming/tractor/equipment/route";
import { GET as tractorJobsGet } from "@/app/api/farming/tractor/jobs/route";
import { GET as planGet } from "@/app/api/farming/plans/[planId]/route";
import { GET as productsGet } from "@/app/api/farming/products/route";
import { GET as rainGaugesGet } from "@/app/api/farming/farms/[farmId]/rain-gauges/route";
import { GET as farmTasksGet } from "@/app/api/farming/farms/[farmId]/tasks/route";
import { GET as mapAssetsGet } from "@/app/api/farming/farms/[farmId]/map-assets/route";
import { GET as farmVegetationGet } from "@/app/api/farming/farms/[farmId]/vegetation/route";
import { GET as paddockVegetationGet } from "@/app/api/farming/paddocks/[paddockId]/vegetation/route";
import { GET as effluentCareGet } from "@/app/api/farming/effluent/care/route";
import { GET as effluentLogGet } from "@/app/api/farming/effluent/log/route";
import { GET as effluentTodayGet } from "@/app/api/farming/effluent/today/route";
import { GET as effluentGet } from "@/app/api/farming/effluent/route";
import { GET as chemicalsGet } from "@/app/api/farming/safety/chemicals/route";
import { GET as equipmentChecksGet } from "@/app/api/farming/safety/equipment/[recordId]/checks/route";
import { GET as equipmentGet } from "@/app/api/farming/safety/equipment/route";
import { GET as inductionReadGet } from "@/app/api/farming/safety/inductions/[recordId]/read/route";
import { GET as inductionsGet } from "@/app/api/farming/safety/inductions/route";
import { GET as reportsGet } from "@/app/api/farming/safety/reports/route";
import { GET as safetyGet } from "@/app/api/farming/safety/route";
import { GET as safetyTodayGet } from "@/app/api/farming/safety/today/route";
import { GET as trainingGet } from "@/app/api/farming/safety/training/route";
import { GET as settingsGet } from "@/app/api/farming/settings/route";
import { GET as notebookGet } from "@/app/api/farm-notebook/route";
import { ValidationError } from "@/lib/errors";
import { daysAhead, HISTORY_DOWNLOAD_MAX, HISTORY_DOWNLOAD_PAGE, type HistoryBounds, monthsBack, type PackEntry, type SectionKey } from "./pack-inventory";
import { fileRefs, isRecord, type Item, type PackFileRef, redact } from "./pack-redact";

/** Any route handler (its context type varies by route; it's given `{ params }`). */
type Handler = (request: Request, context: never) => Promise<Response>;

export type Skipped = { path: string; reason: string };

export type BuiltSection = { section: SectionKey; farmId: string | null; builtAt: string; months: number; entries: PackEntry[]; skipped: Skipped[]; files: PackFileRef[] };


type Reader = {
  /** Calls a route's handler as the person; the answer, or null when it isn't for them (recorded as skipped). */
  read(handler: Handler, path: string, params: Record<string, string>, query: Record<string, string>): Promise<unknown | null>;
  entries: PackEntry[];
  skipped: Skipped[];
};

function reader(request: Request, organisationId: string): Reader {
  const entries: PackEntry[] = [];
  const skipped: Skipped[] = [];
  return {
    entries,
    skipped,
    async read(handler, path, params, query) {
      const url = new URL(path, request.url);
      url.searchParams.set("organisationId", organisationId);
      for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
      // The person's own request (cookie, address, headers), as a read.
      const inner = new Request(url, { method: "GET", headers: request.headers });
      const response = await handler(inner, { params: Promise.resolve(params) } as never);
      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      if (!response.ok) {
        const message = body && typeof body === "object" && "error" in body ? String((body as { error: unknown }).error) : `Refused (${response.status}).`;
        // A sign-in problem stops the whole section; anything else is left out and named.
        if (response.status === 401) throw Object.assign(new Error(message), { status: 401 });
        skipped.push({ path, reason: message });
        return null;
      }
      entries.push({ path, query, body: redact(path, body) });
      return body;
    },
  };
}

/**
 * A farm history (grazings, feed, readings) from `since`, every page of it
 * up to HISTORY_DOWNLOAD_MAX records, kept as one answer that says what it
 * covers (decision 1054). The device pages it as the server would.
 */
async function readHistory(r: Reader, handler: Handler, path: string, params: Record<string, string>, rowsKey: string, since: string): Promise<void> {
  const rows: unknown[] = [];
  let cursor: string | null = null;
  let complete = true;
  for (;;) {
    const before = r.entries.length;
    const page = await r.read(handler, path, params, { from: since, limit: String(HISTORY_DOWNLOAD_PAGE), ...(cursor ? { cursor } : {}) });
    if (page === null) return;
    const kept = r.entries.splice(before, 1)[0];
    const body = isRecord(kept?.body) ? kept.body : {};
    rows.push(...(Array.isArray(body[rowsKey]) ? (body[rowsKey] as unknown[]) : []));
    cursor = typeof body.next === "string" ? body.next : null;
    if (!cursor) break;
    if (rows.length >= HISTORY_DOWNLOAD_MAX) {
      complete = false;
      break;
    }
  }
  const offline: HistoryBounds = { heldFrom: since, complete, count: rows.length };
  r.entries.push({ path, query: {}, body: { [rowsKey]: rows, next: null, offline } });
}

function ids(body: unknown, key: string, idField: string): string[] {
  if (!isRecord(body) || !Array.isArray(body[key])) return [];
  return (body[key] as Item[]).map((item) => item[idField]).filter((value): value is string => typeof value === "string");
}

/**
 * Builds one section for one farm (or for the organisation), as the
 * person asking. `months` of history (12 by default; more on request).
 */
/** At most this many clear dates a farm besides the latest, and this many bytes of them in all (decision 1540). */
export const OFFLINE_VEGETATION_DATES = 3;
export const OFFLINE_VEGETATION_BYTES = 2 * 1024 * 1024;

function entryBytes(entry: PackEntry | undefined): number {
  return entry ? JSON.stringify(entry.body).length : 0;
}

const OVER_CAP = "Left out: over the satellite pictures' size limit for a device.";

/**
 * Keeps a farm's satellite pictures within `cap` bytes of inline answer
 * (decision 1540; issue #619): the latest date first, then earlier dates
 * while they fit. The latest date always keeps its date, quality, legend
 * and attribution; if its pictures alone are over the cap they're left
 * out (pictures.leftOut says so) and no earlier date is kept either.
 */
export function fitVegetationPictures(
  latest: PackEntry,
  earlier: Array<{ sceneId: string; entry: PackEntry }>,
  cap = OFFLINE_VEGETATION_BYTES,
): { entries: PackEntry[]; skipped: Array<{ path: string; reason: string }> } {
  const skipped: Array<{ path: string; reason: string }> = [];
  let first = latest;
  if (entryBytes(first) > cap && isRecord(first.body)) {
    first = { ...first, body: { ...first.body, pictures: { overlay: null, change: null, leftOut: true } } };
    skipped.push({ path: `${latest.path} (latest pictures)`, reason: OVER_CAP });
  }
  const entries = [first];
  let bytes = entryBytes(first);
  for (const [index, { entry }] of earlier.entries()) {
    const size = entryBytes(entry);
    if (first !== latest || bytes + size > cap) {
      for (const rest of earlier.slice(index)) skipped.push({ path: `${rest.entry.path}?sceneId=${rest.sceneId}`, reason: OVER_CAP });
      break;
    }
    entries.push(entry);
    bytes += size;
  }
  return { entries, skipped };
}

/**
 * The satellite part of a farm's map section (decision 1540): only once
 * it's set up for the farm; the latest date (pictures inline, with its
 * date, quality, legend facts and attribution), then earlier mostly clear
 * dates while they fit in OFFLINE_VEGETATION_BYTES, then each paddock's
 * trend (numbers only). A date that doesn't fit is left out and named.
 */
async function readVegetation(r: Reader, farm: string, paddockIds: string[]): Promise<void> {
  const before = r.entries.length;
  const latest = (await r.read(farmVegetationGet, `/api/farming/farms/${farm}/vegetation`, { farmId: farm }, {})) as { vegetation?: { state?: string; scene?: { id: string } | null; scenes?: Array<{ id: string; usable: boolean; hasPicture: boolean }> } } | null;
  if (!latest?.vegetation || latest.vegetation.state === "not_set_up") {
    // Not set up: keep the (small) answer so the map knows, nothing more.
    return;
  }
  const shownId = latest.vegetation.scene?.id;
  const candidates = (latest.vegetation.scenes ?? []).filter((scene) => scene.usable && scene.hasPicture && scene.id !== shownId).slice(0, OFFLINE_VEGETATION_DATES);
  const path = `/api/farming/farms/${farm}/vegetation`;
  // The latest answer comes off the list, and goes back on as it fits.
  const [latestEntry] = r.entries.splice(before, 1);
  const earlier: Array<{ sceneId: string; entry: PackEntry }> = [];
  let bytes = entryBytes(latestEntry);
  for (const scene of candidates) {
    // Not worth reading past the cap.
    if (bytes > OFFLINE_VEGETATION_BYTES) break;
    const at = r.entries.length;
    if ((await r.read(farmVegetationGet, path, { farmId: farm }, { sceneId: scene.id })) === null) continue;
    const [entry] = r.entries.splice(at, 1);
    earlier.push({ sceneId: scene.id, entry });
    bytes += entryBytes(entry);
  }
  const fitted = fitVegetationPictures(latestEntry, earlier);
  r.entries.splice(before, 0, ...fitted.entries);
  r.skipped.push(...fitted.skipped);
  for (const paddockId of paddockIds) await r.read(paddockVegetationGet, `/api/farming/paddocks/${paddockId}/vegetation`, { paddockId }, {});
}

export async function buildSection(request: Request, input: { organisationId: string; farmId: string | null; section: SectionKey; months: number; today: string }): Promise<BuiltSection> {
  const { organisationId, farmId, section, months, today } = input;
  if (section !== "organisation" && section !== "notebook" && !farmId) throw new ValidationError("Choose a farm.");
  const since = monthsBack(today, months);
  const r = reader(request, organisationId);
  const farm = farmId ?? "";
  const f = { farmId: farm };
  switch (section) {
    case "organisation":
      await r.read(farmsGet, "/api/farming/farms", {}, {});
      await r.read(settingsGet, "/api/farming/settings", {}, {});
      await r.read(lastFarmGet, "/api/farming/last-farm", {}, {});
      await r.read(launchersGet, "/api/farming/launchers", {}, {});
      await r.read(farmTermsGet, "/api/farming/farm-terms", {}, {});
      break;
    case "notebook":
      await r.read(notebookGet, "/api/farm-notebook", {}, {});
      break;
    case "map": {
      const paddocks = await r.read(paddocksGet, `/api/farming/farms/${farm}/paddocks`, f, {});
      await r.read(paddockStatusGet, `/api/farming/farms/${farm}/paddock-status`, f, { onDate: today });
      // Each paddock's own page on Farms and paddocks (#477).
      for (const paddockId of ids(paddocks, "paddocks", "id")) await r.read(paddockGet, `/api/farming/paddocks/${paddockId}`, { paddockId }, {});
      // Rain gauges, for the map and the Log's rain reading with no signal (decision 1452).
      await r.read(rainGaugesGet, `/api/farming/farms/${farm}/rain-gauges`, f, {});
      // Farm assets on the map (decision 1462).
      await r.read(mapAssetsGet, `/api/farming/farms/${farm}/map-assets`, f, {});
      // Satellite vegetation (#612, decision 1540): the latest clear picture and a few earlier ones, capped, and each paddock's trend.
      await readVegetation(r, farm, ids(paddocks, "paddocks", "id"));
      break;
    }
    case "pasture": {
      await r.read(pastureGet, `/api/farming/farms/${farm}/pasture`, f, { onDate: today });
      await readHistory(r, grazingsGet, `/api/farming/farms/${farm}/grazings`, f, "grazings", since);
      await r.read(grazingsGet, `/api/farming/farms/${farm}/grazings`, f, { open: "1" });
      // The farm's mobs and each one's card (decision 1428), so moves and weights can be recorded with no signal.
      const mobs = await r.read(mobsGet, `/api/farming/farms/${farm}/mobs`, f, {});
      for (const mobId of ids(mobs, "mobs", "id")) {
        await r.read(mobGet, `/api/farming/mobs/${mobId}`, { mobId }, {});
        await r.read(breedingGet, `/api/farming/mobs/${mobId}/breeding`, { mobId }, {});
      }
      await r.read(rotationGet, `/api/farming/farms/${farm}/rotation`, f, {});
      // The farm timeline as it opens (decision 1446).
      await r.read(timelineGet, `/api/farming/farms/${farm}/timeline`, f, { kinds: "mob,grazing,treatment,breeding,spray" });
      await r.read(stockingGet, `/api/farming/farms/${farm}/stocking`, f, {});
      // Treatments (withholding is on each mob) and product stock (decision 1437).
      await r.read(treatmentsGet, `/api/farming/farms/${farm}/treatments`, f, {});
      await r.read(productStockGet, "/api/farming/product-stock", {}, { farmId: farm });
      await readHistory(r, supplementsGet, `/api/farming/farms/${farm}/supplements`, f, "supplements", since);
      await readHistory(r, readingsGet, `/api/farming/farms/${farm}/pasture/readings`, f, "readings", since);
      // Each paddock's card: its readings and grazings, trimmed to the months kept.
      const paddocks = await r.read(paddocksGet, `/api/farming/farms/${farm}/paddocks`, f, {});
      r.entries.pop(); // the map section keeps the paddocks
      for (const paddockId of ids(paddocks, "paddocks", "id")) {
        const before = r.entries.length;
        await r.read(paddockPastureGet, `/api/farming/paddocks/${paddockId}/pasture`, { paddockId }, {});
        const entry = r.entries[before];
        if (entry && isRecord(entry.body)) {
          const body = entry.body;
          entry.body = {
            ...body,
            readings: Array.isArray(body.readings) ? body.readings.filter((reading: Item) => String(reading.measuredOn ?? "") >= since) : body.readings,
            grazings: Array.isArray(body.grazings) ? body.grazings.filter((grazing: Item) => grazing.outOn === null || String(grazing.inOn ?? "") >= since) : body.grazings,
          };
        }
      }
      break;
    }
    case "calendar": {
      // Two reads (the calendar shows at most a year at a time), kept as one answer.
      const past = await r.read(calendarGet, "/api/farming/calendar", {}, { from: since, to: today, farmId: farm });
      const ahead = await r.read(calendarGet, "/api/farming/calendar", {}, { from: daysAhead(today, 1), to: daysAhead(today, 92), farmId: farm });
      const pastEntry = r.entries.find((entry) => entry.path === "/api/farming/calendar");
      if (pastEntry && isRecord(past) && isRecord(ahead)) {
        r.entries.splice(r.entries.indexOf(pastEntry) + 1, 1);
        const merged = [...(Array.isArray(past.items) ? past.items : []), ...(Array.isArray(ahead.items) ? ahead.items : [])];
        pastEntry.body = redact("/api/farming/calendar", { ...ahead, items: merged });
        pastEntry.query = { from: since, to: daysAhead(today, 92), farmId: farm };
      }
      await r.read(calendarGet, "/api/farming/calendar", {}, { view: "check", farmId: farm });
      // The safety dates shown above the calendar (#477).
      await r.read(safetyDueGet, "/api/farming/safety/due", {}, { from: today, to: daysAhead(today, 92) });
      // The farm's tasks, for Today's Tasks card with no signal (decision 1460).
      await r.read(farmTasksGet, `/api/farming/farms/${farm}/tasks`, f, {});
      break;
    }
    case "plans": {
      const plans = await r.read(plansGet, `/api/farming/farms/${farm}/plans`, f, {});
      for (const planId of ids(plans, "plans", "id")) await r.read(planGet, `/api/farming/plans/${planId}`, { planId }, {});
      await r.read(productsGet, "/api/farming/products", {}, {});
      break;
    }
    case "soil": {
      await r.read(soilSamplesGet, `/api/farming/farms/${farm}/soil-samples`, f, {});
      await r.read(soilTestsGet, `/api/farming/farms/${farm}/soil-tests`, f, {});
      await r.read(soilSummaryGet, `/api/farming/farms/${farm}/soil-summary`, f, {});
      // Each paddock's soil history, opened from the summary (#477).
      const reads = reader(request, organisationId);
      const paddocks = await reads.read(paddocksGet, `/api/farming/farms/${farm}/paddocks`, f, {});
      for (const paddockId of ids(paddocks, "paddocks", "id")) await r.read(paddockHistoryGet, `/api/farming/paddocks/${paddockId}/history`, { paddockId }, {});
      break;
    }
    case "safety": {
      await r.read(safetyGet, "/api/farming/safety", {}, { farmId: farm });
      await r.read(safetyTodayGet, "/api/farming/safety/today", {}, { farmId: farm });
      const before = r.entries.length;
      await r.read(reportsGet, "/api/farming/safety/reports", {}, { farmId: farm });
      const entry = r.entries[before];
      // Reports from the months kept, and every one still open.
      if (entry && isRecord(entry.body) && Array.isArray(entry.body.reports)) {
        entry.body = { ...entry.body, reports: entry.body.reports.filter((report: Item) => report.state !== "closed" || String(report.happenedOn ?? since) >= since) };
      }
      break;
    }
    case "equipment": {
      const equipment = await r.read(equipmentGet, "/api/farming/safety/equipment", {}, { farmId: farm });
      for (const recordId of ids(equipment, "equipment", "recordId")) await r.read(equipmentChecksGet, `/api/farming/safety/equipment/${recordId}/checks`, { recordId }, {});
      await r.read(chemicalsGet, "/api/farming/safety/chemicals", {}, { farmId: farm });
      // Tractor mode: machines with their widths, and the farm's jobs (#474, #477).
      await r.read(tractorEquipmentGet, "/api/farming/tractor/equipment", {}, {});
      await r.read(tractorJobsGet, "/api/farming/tractor/jobs", {}, { farmId: farm });
      break;
    }
    case "people": {
      const inductions = await r.read(inductionsGet, "/api/farming/safety/inductions", {}, { farmId: farm });
      for (const recordId of ids(inductions, "inductions", "recordId")) await r.read(inductionReadGet, `/api/farming/safety/inductions/${recordId}/read`, { recordId }, { farmId: farm });
      await r.read(trainingGet, "/api/farming/safety/training", {}, {});
      break;
    }
    case "effluent":
      // The effluent screens' reads (#487): the setup, and the log's last 30 days.
      await r.read(effluentGet, "/api/farming/effluent", {}, { farmId: farm });
      await r.read(effluentLogGet, "/api/farming/effluent/log", {}, { farmId: farm });
      await r.read(effluentCareGet, "/api/farming/effluent/care", {}, { farmId: farm });
      await r.read(effluentTodayGet, "/api/farming/effluent/today", {}, { farmId: farm });
      break;
    case "photos": {
      // The files named in the farm's safety records; the page fetches each as a small copy.
      const sources = reader(request, organisationId);
      await sources.read(safetyGet, "/api/farming/safety", {}, { farmId: farm });
      await sources.read(reportsGet, "/api/farming/safety/reports", {}, { farmId: farm });
      await sources.read(equipmentGet, "/api/farming/safety/equipment", {}, { farmId: farm });
      await sources.read(chemicalsGet, "/api/farming/safety/chemicals", {}, { farmId: farm });
      return { section, farmId, builtAt: new Date().toISOString(), months, entries: [], skipped: sources.skipped, files: fileRefs(sources.entries) };
    }
  }
  return { section, farmId, builtAt: new Date().toISOString(), months, entries: r.entries, skipped: r.skipped, files: [] };
}
