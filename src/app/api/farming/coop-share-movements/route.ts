import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { addMovement } from "@/lib/farming/coop-shares";

/** Adds a share movement from a co-op statement (CSR2-CSR5). Bookkeepers. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const movement = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    addMovement(tx, {
      holdingId: body.holdingId,
      date: body.date,
      kind: body.kind,
      quantity: body.quantity,
      value: body.value,
      sourceReference: body.sourceReference,
      attachmentId: body.attachmentId,
    }),
  );
  return json({ movement }, { status: 201 });
});
