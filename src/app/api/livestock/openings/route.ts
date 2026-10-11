import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { listOpenings, setOpenings } from "@/lib/livestock/movements";

/** GET: the first year's opening by class (decision 503). */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const openings = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) => listOpenings(tx));
  return json({ openings });
});

/** Replaces the first year's opening: head and value by class, from last year's workpaper. Admins. */
export const PUT = route(async (request) => {
  const body = await readJson(request);
  const openings = await withOrganisation(request, body.organisationId, "admin", (tx) => setOpenings(tx, { lines: body.lines }));
  return json({ openings });
});
