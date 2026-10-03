import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { dashboardShares, setDashboardShares } from "@/lib/analytics/dashboards";
import { requireAnalytics } from "@/lib/analytics/sources";
import { listMembers } from "@/lib/organisations/members";
import { parseOrganisationId } from "@/lib/organisations/registry";

type Context = { params: Promise<{ dashboardId: string }> };

async function reportViewers(organisationId: unknown) {
  const members = await listMembers(parseOrganisationId(organisationId));
  return members
    .filter((member) => member.role === "report_viewer")
    .map((member) => ({ userId: member.userId, email: member.email, displayName: member.displayName, isActive: member.isActive }));
}

/** Who a dashboard is shared with, and the organisation's report viewers to choose from. Bookkeepers and up. */
export const GET = route<Context>(async (request, context) => {
  const { dashboardId } = await context.params;
  const organisationId = searchParams(request).get("organisationId");
  const shares = await withOrganisation(request, organisationId, "bookkeeper", async (tx) => {
    await requireAnalytics(tx);
    return dashboardShares(tx, dashboardId);
  });
  return json({ shares, reportViewers: await reportViewers(organisationId) });
});

/** Shares the dashboard with exactly these report viewers (`userIds`). Bookkeepers and up. */
export const PUT = route<Context>(async (request, context) => {
  const { dashboardId } = await context.params;
  const body = await readJson(request);
  // The members are in the core database: looked up before the organisation's transaction.
  const people = await reportViewers(body.organisationId);
  const shares = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    setDashboardShares(tx, dashboardId, body.userIds, new Set(people.map((person) => person.userId))),
  );
  return json({ shares, reportViewers: people });
});
