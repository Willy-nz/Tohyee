import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { fileGstReturn, listGstReturns } from "@/lib/reports/gst-return";

/** GET: filed GST returns, latest period first. */
export const GET = route(async (request) => {
  const result = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) =>
    listGstReturns(tx),
  );
  return json(result);
});

/**
 * Marks a GST return as filed (admins only): stores its period, basis,
 * adjustments, boxes and counted lines as they are now. Idempotent.
 */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "admin", (tx) =>
    fileGstReturn(tx, {
      source: body.source,
      idempotencyKey: body.idempotencyKey,
      periodStart: body.periodStart,
      periodEnd: body.periodEnd,
      adjustments: body.adjustments,
    }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
