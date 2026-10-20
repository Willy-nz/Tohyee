import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { createTheme, listThemes } from "@/lib/analytics/themes";

/** The organisation's own report themes (#376, decision 668), for choosing one in a report. Viewers and up. */
export const GET = route(async (request) => {
  const themes = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => listThemes(tx));
  return json({ themes });
});

/** Saves a theme for the whole organisation. Bookkeepers and up, as for changing reports. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const theme = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => createTheme(tx, body.theme));
  return json({ theme }, { status: 201 });
});
