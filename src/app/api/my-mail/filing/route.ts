import { json, route, readJson, searchParams, withOrganisation } from "@/lib/api/http";
import { MailOwner } from "@/lib/private-mail/access";
import { fileAttachment, filingOverview, previewFiling } from "@/lib/private-mail/filing";

/**
 * GET ?organisationId=: My mail's Filing card (PM25-PM27): where an
 * attachment can be filed, what the Owner has filed, their rules and what's
 * waiting in "To file". The Owner's own only; everyone else gets "not found".
 */
export const GET = route(async (request) => {
  const result = await withOrganisation(request, searchParams(request).get("organisationId"), "sales_rep", async (tx) => filingOverview(tx, await MailOwner.of(tx)));
  return json(result);
});

/**
 * POST: files a copy of one of the Owner's own attachments into shared data
 * (PM20-PM25). Body: { organisationId, attachmentId, destination, fileName?,
 * note?, preview?: true, confirmation?, toFileId? }. With `preview: true`
 * it only shows exactly what others would see; otherwise `confirmation`
 * from that preview is required, and anything changed since is refused.
 */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const input = { attachmentId: body.attachmentId, destination: body.destination, fileName: body.fileName, note: body.note };
  if (body.preview === true) {
    const preview = await withOrganisation(request, body.organisationId, "sales_rep", async (tx) => previewFiling(tx, await MailOwner.of(tx), input));
    return json({ preview });
  }
  const filed = await withOrganisation(request, body.organisationId, "sales_rep", async (tx) =>
    fileAttachment(tx, await MailOwner.of(tx), { ...input, confirmation: body.confirmation, toFileId: body.toFileId }),
  );
  return json({ filed }, { status: 201 });
});
