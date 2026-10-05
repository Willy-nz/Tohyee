import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { addForecastCommentary, listForecastCommentary } from "@/lib/commentary/service";

/** GET: commentary on the cash flow forecast, newest first (decision 446). Viewers and above. */
export const GET = route(async (request) => {
  const commentary = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => listForecastCommentary(tx));
  return json({ commentary });
});

/** POST `{ periodLabel, body }`: a person's commentary (accepted). Bookkeepers. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const commentary = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => addForecastCommentary(tx, body));
  return json({ commentary }, { status: 201 });
});
