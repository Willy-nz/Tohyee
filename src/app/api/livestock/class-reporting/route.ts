import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { setClassReporting } from "@/lib/livestock/movements";

/** PUT: which classes are current assets (LV27, decision 566). Body: { organisationId, lines: [{ kind, classCode, current }] }. Admins. */
export const PUT = route(async (request) => {
  const body = await readJson(request);
  const settings = await withOrganisation(request, body.organisationId, "admin", (tx) => setClassReporting(tx, { lines: body.lines }));
  return json({ settings });
});
