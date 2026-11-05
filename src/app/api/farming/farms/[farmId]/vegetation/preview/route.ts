import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { providerCall } from "@/lib/farming/vegetation/http";
import { defaultProviderFactory } from "@/lib/farming/vegetation/jobs";
import { farmGrid, gridLonLatBox } from "@/lib/farming/vegetation/raster";
import { estimateUnits, SKIP_SCENE_CLOUD_PCT } from "@/lib/farming/vegetation/rules";
import { currentBoundaries, providerCredentials, requireVegetationFarm } from "@/lib/farming/vegetation/service";
import { ConflictError } from "@/lib/errors";

type Context = { params: Promise<{ farmId: string }> };

/**
 * GET: the dates the satellite passed over the farm in the last 60 days and
 * how cloudy each was over the wider area, without fetching any pictures,
 * and what one picture of this farm is estimated to cost. Owners and admins.
 */
export const GET = route<Context>(async (request, context) => {
  const { farmId } = await context.params;
  const prepared = await withOrganisation(request, searchParams(request).get("organisationId"), "admin", async (tx) => {
    const farm = await requireVegetationFarm(tx, farmId);
    const grid = farmGrid((await currentBoundaries(tx, farm.id)).map((boundary) => boundary.geometry));
    return { farm, grid, credentials: await providerCredentials(tx) };
  });
  if (!prepared.credentials) throw new ConflictError("Connect an imagery account first.");
  const now = new Date();
  const dates = await providerCall(() =>
    defaultProviderFactory(prepared.credentials!).search({ box: gridLonLatBox(prepared.grid), from: new Date(now.getTime() - 60 * 86_400_000).toISOString(), to: now.toISOString(), maxSceneCloudPct: 100 }),
  );
  return json({
    farmId: prepared.farm.id,
    width: prepared.grid.width,
    height: prepared.grid.height,
    unitsPerPicture: estimateUnits(prepared.grid.width, prepared.grid.height),
    skipOverCloudPct: SKIP_SCENE_CLOUD_PCT,
    dates: dates.map((date) => ({ acquiredAt: date.acquiredAt, sceneCloudPct: date.sceneCloudPct })).reverse(),
  });
});
