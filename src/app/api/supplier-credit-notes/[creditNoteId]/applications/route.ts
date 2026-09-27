import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import {
  applySupplierCreditNote,
  listSupplierCreditNoteApplications,
} from "@/lib/supplier-credit-notes/applications";

type Context = { params: Promise<{ creditNoteId: string }> };

/** GET: the supplier credit note's applications, active and removed, oldest first. */
export const GET = route<Context>(async (request, context) => {
  const { creditNoteId } = await context.params;
  const params = searchParams(request);
  const applications = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) =>
    listSupplierCreditNoteApplications(tx, creditNoteId),
  );
  return json({ applications });
});

/**
 * Applies credit to one or more approved bills of the same supplier, all or
 * nothing: `applications` is a list of `{ billId, amount }`, dated
 * `applicationDate`. No journal posts.
 */
export const POST = route<Context>(async (request, context) => {
  const { creditNoteId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    applySupplierCreditNote(tx, creditNoteId, {
      source: body.source,
      idempotencyKey: body.idempotencyKey,
      applicationDate: body.applicationDate,
      applications: body.applications,
    }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
