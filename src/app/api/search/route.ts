import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { searchEverything } from "@/lib/search/service";

/** Ctrl+K search for records (and report-viewer dashboards). */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const result = await withOrganisation(request, params.get("organisationId"), "report_viewer", (tx, { auth, membership }) =>
    searchEverything(tx, {
      query: params.get("q") ?? "",
      filter: params.get("kind") ?? "all",
      onlyDashboards: membership.role === "report_viewer",
      userId: auth.user.id,
    }),
  );
  return json(result);
});

