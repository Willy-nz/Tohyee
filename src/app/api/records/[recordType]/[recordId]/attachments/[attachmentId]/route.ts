import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { fileResponse } from "@/lib/api/upload";
import { getAttachmentContent, removeAttachment } from "@/lib/records/extras";

type Context = { params: Promise<{ recordType: string; recordId: string; attachmentId: string }> };

/** GET: the file itself (NF7); see fileResponse for what opens in the browser. */
export const GET = route<Context>(async (request, context) => {
  const { recordType, recordId, attachmentId } = await context.params;
  const params = searchParams(request);
  const file = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) =>
    getAttachmentContent(tx, recordType, recordId, attachmentId),
  );
  return fileResponse(file, params.get("download") === "1");
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
