import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { removePayment } from "@/lib/tax/income/service";

type Context = { params: Promise<{ paymentId: string }> };

/** DELETE: removes a typed payment; the history keeps it (owners and admins). */
export const DELETE = route<Context>(async (request, context) => {
  const { paymentId } = await context.params;
  await withOrganisation(request, searchParams(request).get("organisationId"), "admin", (tx) => removePayment(tx, paymentId));
  return json({ removed: true });
});
