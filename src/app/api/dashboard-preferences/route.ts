import { getDashboardPreference, saveDashboardPreference } from "@/lib/dashboard/preferences";
import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";

const HOME_DEFAULT_TILES = ["cash_in_bank", "owed_to_you", "bills_to_pay", "next_gst_return"] as const;

function pageTiles(page: string): readonly string[] {
  if (page === "home") return HOME_DEFAULT_TILES;
  return [];
}

export const GET = route(async (request) => {
  const params = searchParams(request);
  const page = params.get("page") ?? "";
  const defaults = pageTiles(page);
  if (defaults.length === 0) return json({ error: "Unknown dashboard page." }, { status: 404 });
  const preference = await withOrganisation(request, params.get("organisationId"), "viewer", (tx, { auth }) =>
    getDashboardPreference(tx, { userId: auth.user.id, page, defaultTiles: defaults }),
  );
  return json(preference);
});

export const PUT = route(async (request) => {
  const body = await readJson(request);
  const page = typeof body.page === "string" ? body.page : "";
  const defaults = pageTiles(page);
  if (defaults.length === 0) return json({ error: "Unknown dashboard page." }, { status: 404 });
  const preference = await withOrganisation(request, body.organisationId, "viewer", (tx, { auth }) =>
    saveDashboardPreference(tx, {
      userId: auth.user.id,
      page,
      hidden: body.hidden,
      tiles: body.tiles,
      defaultTiles: defaults,
    }),
  );
  return json(preference);
});
