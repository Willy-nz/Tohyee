import { json, route, withOrganisation } from "@/lib/api/http";
import { readUploadForm, requireFormFile } from "@/lib/api/upload";
import { replaceRdFile } from "@/lib/rd/files";

type Context = { params: Promise<{ fileId: string }> };

/** POST (multipart form): replaces a file with a new version; the old one is kept (bookkeepers and above; decision 45). */
export const POST = route<Context>(async (request, context) => {
  const { fileId } = await context.params;
  const form = await readUploadForm(request);
  const file = await requireFormFile(form);
  const result = await withOrganisation(request, form.get("organisationId"), "bookkeeper", (tx) =>
    replaceRdFile(tx, fileId, { idempotencyKey: form.get("idempotencyKey"), fileName: file.fileName, content: file.content }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
