import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { updatePaymentTerm } from "@/lib/customers/service";

type Context = { params: Promise<{ termId: string }> };

/** Changes a payment term, or archives or restores it (`isActive`, example RC2). */
export const PATCH = route<Context>(async (request, context) => {
  const { termId } = await context.params;
  const body = await readJson(request);
  const setup = await withOrganisation(request, body.organisationId, "admin", (tx) =>
    updatePaymentTerm(tx, termId, { name: body.name, kind: body.kind, days: body.days, isActive: body.isActive }),
  );
  return json(setup);
});
