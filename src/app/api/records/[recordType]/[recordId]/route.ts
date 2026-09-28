import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { getRecordExtras } from "@/lib/records/extras";

type Context = { params: Promise<{ recordType: string; recordId: string }> };

/**
 * GET: a record's notes, files (without their contents) and history
 * (examples NF1-NF14). recordType is journal, invoice, bill, credit-note,
 * supplier-credit-note or contact.
 */
export const GET = route<Context>(async (request, context) => {
  const { recordType, recordId } = await context.params;
  const extras = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx, { membership }) =>
    getRecordExtras(tx, membership.role, recordType, recordId),
  );
  return json(extras);
});
