import { getDashboardPreference, saveDashboardPreference } from "@/lib/dashboard/preferences";
import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { listDashboards } from "@/lib/analytics/dashboards";
import { analyticsTileReference, parseAnalyticsTileReference } from "@/lib/dashboard/analytics-tile-reference";
import { dashboardPage, defaultDashboardTileIds, MAX_DASHBOARD_TILES } from "@/lib/dashboard/pages";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import type { OrgTx } from "@/lib/db/org-transaction";
import type { Role } from "@/lib/auth/roles";

/**
 * The tiles this person may have on the page right now: the page's defaults,
 * plus a reference to every tile of every dashboard they can open (decision
 * 374). Worked out on every read and save, so a dashboard that's deleted,
 * unshared or has lost the tile, or Analytics being switched off, drops the
 * pin without anything being rewritten.
 */
async function allowedTiles(
  tx: OrgTx,
  defaults: readonly string[],
  userId: string,
  role: Role,
): Promise<{ allowed: readonly string[]; analyticsOn: boolean }> {
  const settings = await tx.query<{ analytics_enabled: boolean }>("select analytics_enabled from organisation_settings where id = true");
  if (settings.rows[0]?.analytics_enabled !== true) return { allowed: defaults, analyticsOn: false };
  const dashboards = await listDashboards(tx, { userId, reportViewer: role === "report_viewer" });
  return {
    allowed: [...defaults, ...dashboards.flatMap((dashboard) => dashboard.tiles.map((tile) => analyticsTileReference(dashboard.id, tile.id)))],
    analyticsOn: true,
  };
}

/** A save names only tiles that exist and this person may see; anything else is refused rather than dropped. */
function checkTiles(input: unknown, allowed: readonly string[], analyticsOn: boolean) {
  if (!Array.isArray(input)) return;
  if (input.length > MAX_DASHBOARD_TILES) throw new ValidationError(`A page shows up to ${MAX_DASHBOARD_TILES} tiles.`);
  const allowedSet = new Set(allowed);
  for (const value of input) {
    if (typeof value !== "string" || !value.startsWith("analytics:")) continue;
    if (!parseAnalyticsTileReference(value)) throw new ValidationError("That Analytics tile reference isn't valid.");
    if (!analyticsOn) throw new ConflictError("Analytics is off, so its tiles can't be pinned.");
    // Not shared, deleted, or never existed all read the same, so dashboards can't be probed.
    if (!allowedSet.has(value)) throw new NotFoundError("That Analytics tile wasn't found.");
  }
}

export const GET = route(async (request) => {
  const params = searchParams(request);
  const page = params.get("page") ?? "";
  const definition = dashboardPage(page);
  if (!definition) return json({ error: "Unknown dashboard page." }, { status: 404 });
  const preference = await withOrganisation(request, params.get("organisationId"), "report_viewer", async (tx, { auth, membership }) => {
    const defaults = defaultDashboardTileIds(definition);
    const { allowed } = await allowedTiles(tx, defaults, auth.user.id, membership.role);
    return getDashboardPreference(tx, { userId: auth.user.id, page, defaultTiles: defaults, allowedTiles: allowed });
  });
  return json(preference);
});

export const PUT = route(async (request) => {
  const body = await readJson(request);
  const page = typeof body.page === "string" ? body.page : "";
  const definition = dashboardPage(page);
  if (!definition) return json({ error: "Unknown dashboard page." }, { status: 404 });
  const preference = await withOrganisation(request, body.organisationId, "report_viewer", async (tx, { auth, membership }) => {
    const defaults = defaultDashboardTileIds(definition);
    const { allowed, analyticsOn } = await allowedTiles(tx, defaults, auth.user.id, membership.role);
    checkTiles(body.tiles, allowed, analyticsOn);
    return saveDashboardPreference(tx, {
      userId: auth.user.id,
      page,
      hidden: body.hidden,
      tiles: body.tiles,
      defaultTiles: defaults,
      allowedTiles: allowed,
    });
  });
  return json(preference);
});
