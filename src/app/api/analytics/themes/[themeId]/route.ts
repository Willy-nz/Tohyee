import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { deleteTheme, updateTheme } from "@/lib/analytics/themes";

type Context = { params: Promise<{ themeId: string }> };

/** Changes a saved theme (every report using it follows). Bookkeepers and up. */
export const PATCH = route<Context>(async (request, context) => {
  const { themeId } = await context.params;
  const body = await readJson(request);
  const theme = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => updateTheme(tx, themeId, body.theme));
  return json({ theme });
});

/** Removes a theme no report uses. Bookkeepers and up. */
export const DELETE = route<Context>(async (request, context) => {
  const { themeId } = await context.params;
  await withOrganisation(request, searchParams(request).get("organisationId"), "bookkeeper", (tx) => deleteTheme(tx, themeId));
  return json({ ok: true });
});
