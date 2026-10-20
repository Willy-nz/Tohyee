import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { addRationsAdjustment, getRationsYear } from "@/lib/livestock/rations-adjustments";

/** GET: the year's homekill head count and its adjustment (`yearEnd`; bookkeepers and above; RAT5, RAT9). */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const year = await withOrganisation(request, params.get("organisationId"), "bookkeeper", (tx) => getRationsYear(tx, { yearEnd: params.get("yearEnd") }));
  return json({ year });
});

/**
 * POST: enters the year's homekill adjustment (bookkeepers and above; RAT5-RAT8): `idempotencyKey`, `yearEnd`,
 * optional `adjustmentDate` (the balance date if left out), `amount`, `reason`, `gstApplies` and, when it does,
 * `amountIncludesGst`.
 */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    addRationsAdjustment(tx, {
      idempotencyKey: body.idempotencyKey,
      yearEnd: body.yearEnd,
      adjustmentDate: body.adjustmentDate,
      amount: body.amount,
      reason: body.reason,
      gstApplies: body.gstApplies,
      amountIncludesGst: body.amountIncludesGst,
    }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
