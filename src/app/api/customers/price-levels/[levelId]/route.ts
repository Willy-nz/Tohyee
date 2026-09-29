import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { updatePriceLevel } from "@/lib/customers/service";

type Context = { params: Promise<{ levelId: string }> };

/** Changes a price level, or archives or restores it (`isActive`, example RC7). */
export const PATCH = route<Context>(async (request, context) => {
  const { levelId } = await context.params;
  const body = await readJson(request);
  const setup = await withOrganisation(request, body.organisationId, "admin", (tx) =>
    updatePriceLevel(tx, levelId, { name: body.name, markupPercent: body.markupPercent, isActive: body.isActive }),
  );
  return json(setup);
});
