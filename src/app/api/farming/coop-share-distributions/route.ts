import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { addDistribution } from "@/lib/farming/coop-shares";

/** Adds a dividend, rebate or retention (CSR6, CSR7). Bookkeepers. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const distribution = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    addDistribution(tx, {
      holdingId: body.holdingId,
      date: body.date,
      kind: body.kind,
      amount: body.amount,
      imputationCredits: body.imputationCredits,
      sourceReference: body.sourceReference,
      attachmentId: body.attachmentId,
    }),
  );
  return json({ distribution }, { status: 201 });
});
