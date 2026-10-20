import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { addAllocation } from "@/lib/tax/income/allocations";
import { addPayment } from "@/lib/tax/income/service";

/**
 * POST: a payment made to IRD towards an income year, typed in (owners and admins; ITX6, ITX9), with its bank date
 * (`paidOn`) and optionally IRD's effective date (`irdEffectiveOn`). An optional `allocation` (`appliesTo`, `status`,
 * `basis`, `irdDocumentId`) allocates all of it in the same step; without one it's awaiting reconciliation (ITX6E).
 */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "admin", async (tx) => {
    const added = await addPayment(tx, { idempotencyKey: body.idempotencyKey, incomeYear: body.incomeYear, paidOn: body.paidOn, amount: body.amount, note: body.note, irdEffectiveOn: body.irdEffectiveOn });
    const allocation = body.allocation && typeof body.allocation === "object" ? (body.allocation as Record<string, unknown>) : null;
    if (allocation && added.created) {
      await addAllocation(tx, {
        idempotencyKey: `${String(body.idempotencyKey)}-allocation`,
        paymentId: added.payment.id,
        appliesTo: allocation.appliesTo,
        amount: added.payment.amount,
        status: allocation.status,
        basis: allocation.basis,
        irdDocumentId: allocation.irdDocumentId,
      });
    }
    return added;
  });
  return json(result, { status: result.created ? 201 : 200 });
});
