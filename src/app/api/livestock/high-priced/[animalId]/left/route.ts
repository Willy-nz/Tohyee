import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { highPricedLeft } from "@/lib/livestock/high-priced";

type Context = { params: Promise<{ animalId: string }> };

/** Records that a high-priced animal was sold or died (`how: sold_or_died`), or stopped breeding (`stopped_breeding`, it reverts). Admins. */
export const POST = route<Context>(async (request, context) => {
  const { animalId } = await context.params;
  const body = await readJson(request);
  const animal = await withOrganisation(request, body.organisationId, "admin", (tx) => highPricedLeft(tx, animalId, { leftOn: body.leftOn, how: body.how, reason: body.reason }));
  return json({ animal });
});
