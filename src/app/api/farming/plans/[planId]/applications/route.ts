import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { recordApplication } from "@/lib/farming/fertiliser";

type Context = { params: Promise<{ planId: string }> };

/** Records fertiliser applied to a paddock (`paddockId`, `productId`, `appliedOn`, `tonnes`, `treatedHa`). Posts nothing. */
export const POST = route<Context>(async (request, context) => {
  const { planId } = await context.params;
  const body = await readJson(request);
  const report = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    recordApplication(tx, planId, { paddockId: body.paddockId, productId: body.productId, appliedOn: body.appliedOn, tonnes: body.tonnes, treatedHa: body.treatedHa }),
  );
  return json({ report }, { status: 201 });
});
