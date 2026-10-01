import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { optionalFormFile, readUploadForm } from "@/lib/api/upload";
import { createApproval, listApprovals } from "@/lib/rd/register";

/** GET: the approvals entered (viewers and above). */
export const GET = route(async (request) => {
  const approvals = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => listApprovals(tx));
  return json({ approvals });
});

/**
 * POST (multipart form): enters a general approval from IRD's letter, with
 * the letter as `file` (bookkeepers and above; RD3, decision 40). Fields:
 * `organisationId`, `idempotencyKey`, `reference`, `letterDate`,
 * `firstIncomeYear`, `lastIncomeYear`, `activityIds` (comma-separated), `note`.
 */
export const POST = route(async (request) => {
  const form = await readUploadForm(request);
  const letter = await optionalFormFile(form);
  const field = (name: string) => form.get(name) ?? undefined;
  const result = await withOrganisation(request, form.get("organisationId"), "bookkeeper", (tx) =>
    createApproval(tx, {
      idempotencyKey: field("idempotencyKey"),
      kind: field("kind"),
      reference: field("reference"),
      letterDate: field("letterDate"),
      firstIncomeYear: field("firstIncomeYear"),
      lastIncomeYear: field("lastIncomeYear") || undefined,
      activityIds: field("activityIds") ?? "",
      note: field("note") || undefined,
      letter,
    }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
