import { json, readJson, route, searchParams, withFarmWork, withOrganisation } from "@/lib/api/http";
import { ValidationError } from "@/lib/errors";
import { inlinePicture } from "@/lib/farming/vegetation/http";
import { kickVegetation } from "@/lib/farming/vegetation/jobs";
import { getFarmVegetation, requestCheck, scenePicture, setFarmVegetation } from "@/lib/farming/vegetation/service";

type Context = { params: Promise<{ farmId: string }> };

/**
 * GET: a farm's satellite vegetation for the map (`sceneId` for another
 * date): its state, dates, paddock numbers, the attribution, and the map
 * pictures inline, so an offline pack has them too (decision 1538).
 */
export const GET = route<Context>(async (request, context) => {
  const { farmId } = await context.params;
  const query = searchParams(request);
  const { organisationId, vegetation, paths } = await withFarmWork(request, query.get("organisationId"), "read", async (tx, { membership }) => {
    const vegetation = await getFarmVegetation(tx, farmId, { sceneId: query.get("sceneId") });
    const overlay = vegetation.scene?.hasPicture ? await scenePicture(tx, vegetation.scene.id, "overlay") : null;
    const change = vegetation.scene?.hasChange ? await scenePicture(tx, vegetation.scene.id, "change") : null;
    return { organisationId: membership.organisation.id, vegetation, paths: { overlay: overlay?.path ?? null, change: change?.path ?? null } };
  });
  return json({ vegetation, pictures: { overlay: await inlinePicture(organisationId, paths.overlay), change: await inlinePicture(organisationId, paths.change) } });
});

/**
 * `action: "setup"` turns pictures on or off for the farm, confirming its
 * boundaries (owners and admins); `action: "check"` asks for a check now,
 * at most every 15 minutes (farm staff and up).
 */
export const POST = route<Context>(async (request, context) => {
  const { farmId } = await context.params;
  const body = await readJson(request);
  if (body.action === "setup") {
    const setup = await withOrganisation(request, body.organisationId, "admin", (tx) => setFarmVegetation(tx, farmId, { enabled: body.enabled }));
    return json({ setup });
  }
  if (body.action === "check") {
    const { organisation, check } = await withFarmWork(request, body.organisationId, "record", async (tx, { membership }) => ({ organisation: membership.organisation, check: await requestCheck(tx, farmId) }));
    kickVegetation(organisation);
    return json(check, { status: 202 });
  }
  throw new ValidationError("Choose setup or check.");
});
