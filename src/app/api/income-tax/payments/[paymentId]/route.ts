import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { setEffectiveDate } from "@/lib/tax/income/allocations";
import { removePayment } from "@/lib/tax/income/service";

type Context = { params: Promise<{ paymentId: string }> };

/** DELETE: removes a typed payment; the history keeps it (owners and admins). */
export const DELETE = route<Context>(async (request, context) => {
  const { paymentId } = await context.params;
  await withOrganisation(request, searchParams(request).get("organisationId"), "admin", (tx) => removePayment(tx, paymentId));
  return json({ removed: true });
});

/** PATCH: sets or clears a payment's IRD effective date (`irdEffectiveOn`); the bank date stays (owners and admins; ITX6C). */
export const PATCH = route<Context>(async (request, context) => {
  const { paymentId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "admin", (tx) => setEffectiveDate(tx, { paymentId, irdEffectiveOn: body.irdEffectiveOn }));
  return json(result);
});
