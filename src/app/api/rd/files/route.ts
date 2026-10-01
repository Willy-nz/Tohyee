import { json, route, withOrganisation } from "@/lib/api/http";
import { readUploadForm, requireFormFile } from "@/lib/api/upload";
import { addRdFile } from "@/lib/rd/files";

/**
 * POST (multipart form): attaches a file to an R&D record (`recordType`
 * activity, approval, tag or asset; `recordId`; `purpose`; `file`).
 * Bookkeepers and above. R&D files can't be deleted, only replaced
 * (decision 45).
 */
export const POST = route(async (request) => {
  const form = await readUploadForm(request);
  const file = await requireFormFile(form);
  const result = await withOrganisation(request, form.get("organisationId"), "bookkeeper", (tx) =>
    addRdFile(tx, {
      idempotencyKey: form.get("idempotencyKey"),
      recordType: form.get("recordType"),
      recordId: form.get("recordId"),
      purpose: form.get("purpose") ?? undefined,
      fileName: file.fileName,
      content: file.content,
    }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
