import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { getLivestockSettings, updateLivestockSettings } from "@/lib/livestock/movements";

/** GET: whether livestock is on and its first income year (#221). */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const settings = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) => getLivestockSettings(tx));
  return json({ settings });
});

/** Turns livestock on or off, sets the first income year, where the herd scheme revaluation goes and the accounts (LV12). Admins. */
export const PATCH = route(async (request) => {
  const body = await readJson(request);
  const settings = await withOrganisation(request, body.organisationId, "admin", (tx) =>
    updateLivestockSettings(tx, {
      enabled: body.enabled,
      firstYearStart: body.firstYearStart,
      revaluationTarget: body.revaluationTarget,
      assetAccount: body.assetAccount,
      valueChangeAccount: body.valueChangeAccount,
      revaluationAccount: body.revaluationAccount,
      reserveAccount: body.reserveAccount,
    }),
  );
  return json({ settings });
});
