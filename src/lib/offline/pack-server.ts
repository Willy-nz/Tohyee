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
import { GET as paddockPastureGet } from "@/app/api/farming/paddocks/[paddockId]/pasture/route";
import { GET as planGet } from "@/app/api/farming/plans/[planId]/route";
import { GET as productsGet } from "@/app/api/farming/products/route";
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
import { daysAhead, monthsBack, type PackEntry, type SectionKey } from "./pack-inventory";
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

function ids(body: unknown, key: string, idField: string): string[] {
  if (!isRecord(body) || !Array.isArray(body[key])) return [];
  return (body[key] as Item[]).map((item) => item[idField]).filter((value): value is string => typeof value === "string");
}

/**
 * Builds one section for one farm (or for the organisation), as the
 * person asking. `months` of history (12 by default; more on request).
 */
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
      break;
    case "notebook":
      await r.read(notebookGet, "/api/farm-notebook", {}, {});
      break;
    case "map": {
      await r.read(paddocksGet, `/api/farming/farms/${farm}/paddocks`, f, {});
      await r.read(paddockStatusGet, `/api/farming/farms/${farm}/paddock-status`, f, { onDate: today });
      break;
    }
    case "pasture": {
      await r.read(pastureGet, `/api/farming/farms/${farm}/pasture`, f, { onDate: today });
      await r.read(grazingsGet, `/api/farming/farms/${farm}/grazings`, f, { from: since, limit: "1000" });
      await r.read(grazingsGet, `/api/farming/farms/${farm}/grazings`, f, { open: "1" });
      await r.read(supplementsGet, `/api/farming/farms/${farm}/supplements`, f, { from: since, limit: "1000" });
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
      break;
    }
    case "plans": {
      const plans = await r.read(plansGet, `/api/farming/farms/${farm}/plans`, f, {});
      for (const planId of ids(plans, "plans", "id")) await r.read(planGet, `/api/farming/plans/${planId}`, { planId }, {});
      await r.read(productsGet, "/api/farming/products", {}, {});
      break;
    }
    case "soil":
      await r.read(soilSamplesGet, `/api/farming/farms/${farm}/soil-samples`, f, {});
      await r.read(soilTestsGet, `/api/farming/farms/${farm}/soil-tests`, f, {});
      await r.read(soilSummaryGet, `/api/farming/farms/${farm}/soil-summary`, f, {});
      break;
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
      break;
    }
    case "people": {
      const inductions = await r.read(inductionsGet, "/api/farming/safety/inductions", {}, { farmId: farm });
      for (const recordId of ids(inductions, "inductions", "recordId")) await r.read(inductionReadGet, `/api/farming/safety/inductions/${recordId}/read`, { recordId }, { farmId: farm });
      await r.read(trainingGet, "/api/farming/safety/training", {}, {});
      break;
    }
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
