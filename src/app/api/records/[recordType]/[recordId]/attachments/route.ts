import { json, route, withRecord } from "@/lib/api/http";
import { readUploadForm, requireFormFile } from "@/lib/api/upload";
import { addAttachment } from "@/lib/records/extras";

type Context = { params: Promise<{ recordType: string; recordId: string }> };

/**
 * POST (multipart form): attaches a file (`organisationId`, `idempotencyKey`,
 * `file`). Bookkeepers and above; PDF, images, Word, Excel or CSV up to
 * 10 MB (NF7-NF9).
 */
export const POST = route<Context>(async (request, context) => {
  const { recordType, recordId } = await context.params;
  const form = await readUploadForm(request);
  const file = await requireFormFile(form);
  const result = await withRecord(request, form.get("organisationId"), recordType, "write", (tx, { membership }) =>
    addAttachment(tx, membership.role, recordType, recordId, {
      source: form.get("source") ?? undefined,
      idempotencyKey: form.get("idempotencyKey"),
      fileName: file.fileName,
      content: file.content,
    }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
