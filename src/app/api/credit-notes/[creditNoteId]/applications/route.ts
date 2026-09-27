import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { applyCreditNote, listApplications } from "@/lib/credit-notes/applications";

type Context = { params: Promise<{ creditNoteId: string }> };

/** GET: the credit note's applications, active and removed, oldest first. */
export const GET = route<Context>(async (request, context) => {
  const { creditNoteId } = await context.params;
  const params = searchParams(request);
  const applications = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) =>
    listApplications(tx, creditNoteId),
  );
  return json({ applications });
});

/**
 * Applies credit to one or more approved invoices of the same customer, all
 * or nothing: `applications` is a list of `{ invoiceId, amount }`, dated
 * `applicationDate`. No journal posts.
 */
export const POST = route<Context>(async (request, context) => {
  const { creditNoteId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    applyCreditNote(tx, creditNoteId, {
      source: body.source,
      idempotencyKey: body.idempotencyKey,
      applicationDate: body.applicationDate,
      applications: body.applications,
    }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
