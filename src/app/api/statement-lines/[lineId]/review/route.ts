import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { reviewLine } from "@/lib/bank/mixed-use";

type Context = { params: Promise<{ lineId: string }> };

/**
 * POST: reviews a line on a mixed-use or personal account (#545, MU2-MU8):
 * `decision` business, private, split (with `businessAmount`) or refund
 * (with `refundOfLineId`); for a business part, `contactId` and `lines`
 * (`accountCode`, `taxCode`, `amount`, GST inclusive) and `gstEvidence`
 * "tax_document" when GST is claimed; `notDuplicate` (MU11).
 */
export const POST = route<Context>(async (request, context) => {
  const { lineId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => reviewLine(tx, lineId, body));
  return json(result, { status: result.created ? 201 : 200 });
});
