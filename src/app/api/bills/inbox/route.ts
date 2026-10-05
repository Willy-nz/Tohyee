import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { readUploadForm, requireFormFile } from "@/lib/api/upload";
import { addInboxItem, listInbox } from "@/lib/bills/inbox";

/** GET: the bills inbox (BI1, BI7): `status` waiting (default), made, removed or all. Viewers and above. */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const items = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) =>
    listInbox(tx, { status: params.get("status"), limit: params.get("limit") }),
  );
  return json({ items });
});

/**
 * POST (multipart form): adds one file to the inbox (`organisationId`,
 * `idempotencyKey`, `file`): a PDF, JPG, PNG or HEIC up to 10 MB (BI1).
 * Bookkeepers and above. Nothing is posted.
 */
export const POST = route(async (request) => {
  const form = await readUploadForm(request);
  const file = await requireFormFile(form);
  const result = await withOrganisation(request, form.get("organisationId"), "bookkeeper", (tx) =>
    addInboxItem(tx, {
      source: form.get("source") ?? undefined,
      idempotencyKey: form.get("idempotencyKey"),
      fileName: file.fileName,
      content: file.content,
      via: "upload",
    }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
