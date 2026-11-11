import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { getAiJournalVoidSettings, saveAiJournalVoidSettings } from "@/lib/ai/journal-void";

/** GET: how long after posting the AI may void its own manual journals (AJV5); null is no limit. Viewers and above. */
export const GET = route(async (request) => {
  const settings = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => getAiJournalVoidSettings(tx));
  return json(settings);
});

/** PUT: sets it (`maxDays`: 1-3650, or null for no limit). Admins and owners. */
export const PUT = route(async (request) => {
  const body = await readJson(request);
  const settings = await withOrganisation(request, body.organisationId, "admin", (tx) => saveAiJournalVoidSettings(tx, { maxDays: body.maxDays }));
  return json(settings);
});
