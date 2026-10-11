import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { replaceValuation } from "@/lib/livestock/valuation";

/** Replaces an approved valuation: its journal is reversed, with the reason (LV9). Admins. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const valuation = await withOrganisation(request, body.organisationId, "admin", (tx) => replaceValuation(tx, { yearEnd: body.yearEnd, reason: body.reason }));
  return json({ valuation });
});
