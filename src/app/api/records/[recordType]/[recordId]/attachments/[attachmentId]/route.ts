import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { getAttachmentContent, removeAttachment } from "@/lib/records/extras";
import { showsInline } from "@/lib/records/file-types";

type Context = { params: Promise<{ recordType: string; recordId: string; attachmentId: string }> };

/** A file name for Content-Disposition: plain ASCII fallback plus the UTF-8 name. */
function disposition(kind: "inline" | "attachment", fileName: string): string {
  const fallback = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

/**
 * GET: the file itself (NF7). PDFs and JPG/PNG images open in the browser;
 * everything else downloads. Images are sandboxed so nothing in them can run
 * as Tohyee. PDFs aren't: browsers' PDF viewers refuse sandboxed pages, and
 * they run a PDF apart from the page anyway.
 */
export const GET = route<Context>(async (request, context) => {
  const { recordType, recordId, attachmentId } = await context.params;
  const params = searchParams(request);
  const file = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) =>
    getAttachmentContent(tx, recordType, recordId, attachmentId),
  );
  const inline = showsInline(file.contentType) && params.get("download") !== "1";
  return new Response(new Uint8Array(file.content), {
    status: 200,
    headers: {
      "content-type": file.contentType,
      "content-length": String(file.content.length),
      "content-disposition": disposition(inline ? "inline" : "attachment", file.fileName),
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      ...(file.contentType === "application/pdf"
        ? {}
        : { "content-security-policy": "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'" }),
    },
  });
});

/** DELETE: removes a file (NF10). Who added it, or an admin. */
export const DELETE = route<Context>(async (request, context) => {
  const { recordType, recordId, attachmentId } = await context.params;
  const body = await readJson(request);
  await withOrganisation(request, body.organisationId, "bookkeeper", (tx, { membership }) =>
    removeAttachment(tx, membership.role, recordType, recordId, attachmentId),
  );
  return json({ removed: true });
});
