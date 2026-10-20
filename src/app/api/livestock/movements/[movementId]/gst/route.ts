import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { assessMovementGst } from "@/lib/livestock/movements";

type Context = { params: Promise<{ movementId: string }> };

/**
 * POST: assesses an owner's rations event for GST (RAT5-RAT9): `outcome` (taxable_supply, change_in_use or
 * no_adjustment), `basis` (the evidence or reason), `gstAmount` (the reviewed adjustment, change in use only) and,
 * when changing an earlier assessment, `reason`. Bookkeepers and above.
 */
export const POST = route<Context>(async (request, context) => {
  const { movementId } = await context.params;
  const body = await readJson(request);
  const movement = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    assessMovementGst(tx, movementId, { outcome: body.outcome, basis: body.basis, gstAmount: body.gstAmount, reason: body.reason }),
  );
  return json({ movement });
});
