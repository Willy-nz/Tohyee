import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { listLivestockSuggestions } from "@/lib/livestock/suggestions";

/** Livestock movements the AI suggested (AIW8); `open=true` for those waiting. */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const suggestions = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) => listLivestockSuggestions(tx, { open: params.get("open") === "true" }));
  return json({ suggestions });
});
