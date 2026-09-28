import { json, requireAuth, route, withOrganisation } from "@/lib/api/http";
import { ValidationError } from "@/lib/errors";
import { addAttachment } from "@/lib/records/extras";
import { MAX_ATTACHMENT_BYTES } from "@/lib/records/file-types";

type Context = { params: Promise<{ recordType: string; recordId: string }> };

/** Room for the form fields around a 10 MB file. */
const MAX_REQUEST_BYTES = MAX_ATTACHMENT_BYTES + 64 * 1024;

/** Reads a multipart form, stopping as soon as it's more than MAX_REQUEST_BYTES. */
async function readLimitedForm(request: Request): Promise<FormData> {
  if (!request.body) {
    throw new ValidationError("Choose a file to attach.");
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_REQUEST_BYTES) {
      await reader.cancel();
      throw new ValidationError("Files can be at most 10 MB.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return await new Response(bytes, { headers: { "content-type": request.headers.get("content-type") ?? "" } }).formData();
  } catch {
    throw new ValidationError("The file couldn't be read. Try again.");
  }
}

/**
 * POST (multipart form): attaches a file (`organisationId`, `idempotencyKey`,
 * `file`). Bookkeepers and above; PDF, images, Word, Excel or CSV up to
 * 10 MB (NF7-NF9).
 */
export const POST = route<Context>(async (request, context) => {
  const { recordType, recordId } = await context.params;
  // Signed in before the body is read, and never more than 10 MB of it.
  await requireAuth(request);
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_REQUEST_BYTES) {
    throw new ValidationError("Files can be at most 10 MB.");
  }
  const form = await readLimitedForm(request);
  const file = form.get("file");
  if (!file || typeof file === "string") {
    throw new ValidationError("Choose a file to attach.");
  }
  const content = new Uint8Array(await file.arrayBuffer());
  const result = await withOrganisation(request, form.get("organisationId"), "bookkeeper", (tx, { membership }) =>
    addAttachment(tx, membership.role, recordType, recordId, {
      source: form.get("source") ?? undefined,
      idempotencyKey: form.get("idempotencyKey"),
      fileName: file.name,
      content,
    }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
