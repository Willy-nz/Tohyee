import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { getDashboard } from "@/lib/analytics/dashboards";
import { runBuiltQuery } from "@/lib/analytics/engine";
import { combineFreshness, dataThroughSql, reportLoadFacts, tileDateFields } from "@/lib/analytics/freshness";
import { requireAnalytics } from "@/lib/analytics/sources";

type Context = { params: Promise<{ dashboardId: string }> };

/**
 * How fresh a report's data is (decision 698): each source's last good load,
 * a failed or running refresh, and the latest date in the data its tiles go
 * by. Anyone who can open the report (report viewers only if it's shared
 * with them); no error text or file names, only times and dates.
 */
export const GET = route<Context>(async (request, context) => {
  const { dashboardId } = await context.params;
  const { organisationId, dashboard, facts } = await withOrganisation(request, searchParams(request).get("organisationId"), "report_viewer", async (tx, { auth, membership }) => {
    await requireAnalytics(tx);
    const dashboard = await getDashboard(tx, dashboardId, { userId: auth.user.id, reportViewer: membership.role === "report_viewer" });
    return { organisationId: tx.organisationId, dashboard, facts: await reportLoadFacts(tx, dashboard) };
  });
  // The latest dates are read from the analytics file, outside the transaction.
  const through = new Map<string, string | null>();
  for (const table of facts.flatMap((fact) => fact.tables)) {
    const sql = dataThroughSql(table, tileDateFields(dashboard, table));
    if (!sql) continue;
    try {
      through.set(table, (await runBuiltQuery(organisationId, sql, []))[0]?.through ?? null);
    } catch {
      // A table that's gone or changed: its tiles say so themselves.
      through.set(table, null);
    }
  }
  return json(combineFreshness(facts, through));
});
