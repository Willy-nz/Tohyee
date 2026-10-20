import { getDashboardPreference, resetDashboardPreference, saveDashboardPreference } from "@/lib/dashboard/preferences";
import { json, readJson, route, searchParams, withCrm, withOrganisation } from "@/lib/api/http";
import type { AuthContext } from "@/lib/auth/guard";
import { listDashboards } from "@/lib/analytics/dashboards";
import { analyticsTileReference, parseAnalyticsTileReference } from "@/lib/dashboard/analytics-tile-reference";
import { defaultTilesFor, homeKindFor, type HomeContext, type HomeKind } from "@/lib/dashboard/defaults";
import { dashboardCardIds, dashboardPage, type DashboardPage, maxTilesFor } from "@/lib/dashboard/pages";
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
function checkTiles(input: unknown, allowed: readonly string[], analyticsOn: boolean, maxTiles: number) {
  if (!Array.isArray(input)) return;
  if (input.length > maxTiles) throw new ValidationError(`This page shows up to ${maxTiles} tiles.`);
  const allowedSet = new Set(allowed);
  for (const value of input) {
    if (typeof value !== "string" || !value.startsWith("analytics:")) continue;
    if (!parseAnalyticsTileReference(value)) throw new ValidationError("That Analytics tile reference isn't valid.");
    if (!analyticsOn) throw new ConflictError("Analytics is off, so its tiles can't be pinned.");
    // Not shared, deleted, or never existed all read the same, so dashboards can't be probed.
    if (!allowedSet.has(value)) throw new NotFoundError("That Analytics tile wasn't found.");
  }
}

/** What decision 660 goes by: the person's role and the organisation's modules and records. */
async function homeContext(tx: OrgTx, role: Role): Promise<HomeContext> {
  const settings = await tx.query<{ accounting_enabled: boolean; crm_enabled: boolean; gst_registered: boolean; farming_enabled: boolean; has_jobs: boolean }>(
    `select s.accounting_enabled, s.crm_enabled, s.gst_registered,
            coalesce((select enabled from farming_settings where id = true), false) as farming_enabled,
            exists (select 1 from projects where is_job) as has_jobs
       from organisation_settings s where s.id = true`,
  );
  const row = settings.rows[0];
  return {
    role,
    farming: row?.accounting_enabled === true && row.farming_enabled === true,
    crm: row?.crm_enabled === true,
    gstRegistered: row?.gst_registered === true,
    hasJobs: row?.has_jobs === true,
  };
}

/**
 * The page's work in a transaction: the CRM's Home through `withCrm`, so
 * sales reps and managers can keep their own (decision 491); the others need
 * report viewer or up, as before.
 */
function onPage<T>(
  request: Request,
  organisationId: unknown,
  definition: DashboardPage,
  work: (tx: OrgTx, context: { auth: AuthContext; role: Role }) => Promise<T>,
): Promise<T> {
  if (definition.module === "crm") return withCrm(request, organisationId, "read", (tx, { auth, membership }) => work(tx, { auth, role: membership.role }));
  return withOrganisation(request, organisationId, "report_viewer", (tx, { auth, membership }) => work(tx, { auth, role: membership.role }));
}

async function startingTiles(tx: OrgTx, page: DashboardPage, role: Role): Promise<{ defaults: string[]; kind: HomeKind }> {
  const context = await homeContext(tx, role);
  return { defaults: defaultTilesFor(page.id, context), kind: homeKindFor(context) };
}

/** GET ?organisationId=&page=: the person's tiles (their own, or the starting ones for them, decision 660) and whether they're hidden. */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const page = params.get("page") ?? "";
  const definition = dashboardPage(page);
  if (!definition) return json({ error: "Unknown dashboard page." }, { status: 404 });
  const preference = await onPage(request, params.get("organisationId"), definition, async (tx, { auth, role }) => {
    const { defaults, kind } = await startingTiles(tx, definition, role);
    const { allowed } = await allowedTiles(tx, dashboardCardIds(definition), auth.user.id, role);
    const saved = await getDashboardPreference(tx, { userId: auth.user.id, page, defaultTiles: defaults, allowedTiles: allowed, maxTiles: maxTilesFor(definition) });
    return { ...saved, kind, defaultTiles: defaults };
  });
  return json(preference);
});

/** PUT { organisationId, page, hidden, tiles }: saves the person's own choice, which then always wins over the starting cards. */
export const PUT = route(async (request) => {
  const body = await readJson(request);
  const page = typeof body.page === "string" ? body.page : "";
  const definition = dashboardPage(page);
  if (!definition) return json({ error: "Unknown dashboard page." }, { status: 404 });
  const preference = await onPage(request, body.organisationId, definition, async (tx, { auth, role }) => {
    const { defaults, kind } = await startingTiles(tx, definition, role);
    const { allowed, analyticsOn } = await allowedTiles(tx, dashboardCardIds(definition), auth.user.id, role);
    checkTiles(body.tiles, allowed, analyticsOn, maxTilesFor(definition));
    const saved = await saveDashboardPreference(tx, {
      userId: auth.user.id,
      page,
      hidden: body.hidden,
      tiles: body.tiles,
      defaultTiles: defaults,
      allowedTiles: allowed,
      maxTiles: maxTilesFor(definition),
    });
    return { ...saved, kind, defaultTiles: defaults };
  });
  return json(preference);
});

/** DELETE ?organisationId=&page=: back to the starting cards for this person (decision 660). */
export const DELETE = route(async (request) => {
  const params = searchParams(request);
  const page = params.get("page") ?? "";
  const definition = dashboardPage(page);
  if (!definition) return json({ error: "Unknown dashboard page." }, { status: 404 });
  const preference = await onPage(request, params.get("organisationId"), definition, async (tx, { auth, role }) => {
    await resetDashboardPreference(tx, { userId: auth.user.id, page });
    const { defaults, kind } = await startingTiles(tx, definition, role);
    return { hidden: false, tiles: defaults, customised: false, kind, defaultTiles: defaults };
  });
  return json(preference);
});
