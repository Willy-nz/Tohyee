import { requireAuth } from "@/lib/api/http";
import { ValidationError } from "@/lib/errors";
import { MAX_ATTACHMENT_BYTES, showsInline } from "@/lib/records/file-types";

/** Room for the form fields around a 10 MB file. */
export const MAX_UPLOAD_REQUEST_BYTES = MAX_ATTACHMENT_BYTES + 64 * 1024;

/** Reads a multipart form, stopping as soon as it's more than MAX_UPLOAD_REQUEST_BYTES. */
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
    if (total > MAX_UPLOAD_REQUEST_BYTES) {
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
 * Reads a multipart upload: signed in before the body is read, and never more
 * than 10 MB of it.
 */
export async function readUploadForm(request: Request): Promise<FormData> {
  await requireAuth(request);
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_UPLOAD_REQUEST_BYTES) {
    throw new ValidationError("Files can be at most 10 MB.");
  }
  return readLimitedForm(request);
}

/** The form's `file` field, or null when there isn't one. */
export async function optionalFormFile(form: FormData, field = "file"): Promise<{ fileName: string; content: Uint8Array } | null> {
  const file = form.get(field);
  if (!file || typeof file === "string") return null;
  return { fileName: file.name, content: new Uint8Array(await file.arrayBuffer()) };
}

/** The form's `file` field. */
export async function requireFormFile(form: FormData, field = "file"): Promise<{ fileName: string; content: Uint8Array }> {
  const file = await optionalFormFile(form, field);
  if (!file) throw new ValidationError("Choose a file to attach.");
  return file;
}

/** A file name for Content-Disposition: plain ASCII fallback plus the UTF-8 name. */
function disposition(kind: "inline" | "attachment", fileName: string): string {
  const fallback = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

/**
 * A stored file as a response. PDFs and JPG/PNG images open in the browser
 * (unless `download` is set); everything else downloads. Images are sandboxed
 * so nothing in them can run as Tohyee. PDFs aren't: browsers' PDF viewers
 * refuse sandboxed pages, and they run a PDF apart from the page anyway.
 */
export function fileResponse(file: { fileName: string; contentType: string; content: Uint8Array }, download: boolean): Response {
  const inline = showsInline(file.contentType) && !download;
  return new Response(new Uint8Array(file.content), {
    status: 200,
    headers: {
      "content-type": file.contentType,
      "content-length": String(file.content.length),
      "content-disposition": disposition(inline ? "inline" : "attachment", file.fileName),
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      // frame-ancestors: only Tohyee may frame it (the bills inbox shows PDFs
      // in an iframe; issue #144). next.config.ts leaves /api/ CSPs to routes.
      "content-security-policy":
        file.contentType === "application/pdf"
          ? "frame-ancestors 'self'"
          : "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; frame-ancestors 'self'",
    },
  });
}
