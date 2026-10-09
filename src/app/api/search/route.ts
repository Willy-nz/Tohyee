import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { isSalesRole } from "@/lib/auth/roles";
import { crmScope } from "@/lib/crm/access";
import { searchEverything } from "@/lib/search/service";

/** Ctrl+K search for records (report viewers: their dashboards; sales reps and managers: CRM records in their scope, decision 491). */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const result = await withOrganisation(request, params.get("organisationId"), "sales_rep", async (tx, { auth, membership }) =>
    searchEverything(tx, {
      query: params.get("q") ?? "",
      filter: params.get("kind") ?? "all",
      onlyDashboards: membership.role === "report_viewer",
      userId: auth.user.id,
      ...(isSalesRole(membership.role)
        ? { salesOwners: (await crmScope(tx, membership.role, auth.user.id)).owners ?? [], salesManager: membership.role === "sales_manager" }
        : {}),
    }),
  );
  return json(result);
});

