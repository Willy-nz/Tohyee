import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { listFavourites, setFavourite } from "@/lib/reports/report-layouts";

/** GET: the signed-in person's starred reports (decision 1362). */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const favourites = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) => listFavourites(tx));
  return json({ favourites });
});

/** PUT { key, favourite }: stars ("std:pnl", "custom:42") or unstars a report for the signed-in person. */
export const PUT = route(async (request) => {
  const body = await readJson(request);
  const favourites = await withOrganisation(request, body.organisationId, "viewer", (tx) => setFavourite(tx, { key: body.key, favourite: body.favourite }));
  return json({ favourites });
});
