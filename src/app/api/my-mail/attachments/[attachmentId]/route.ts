import { route, searchParams, withOrganisation } from "@/lib/api/http";
import { MailOwner } from "@/lib/private-mail/access";
import { myAttachment } from "@/lib/private-mail/store";

type Context = { params: Promise<{ attachmentId: string }> };

/**
 * GET ?organisationId=: one attachment, decrypted, as a download (PM11).
 * The Owner's own only. Always a download, never shown in Tohyee's own
 * pages, so a file can't run as part of Tohyee.
 */
export const GET = route<Context>(async (request, context) => {
  const { attachmentId } = await context.params;
  const file = await withOrganisation(request, searchParams(request).get("organisationId"), "sales_rep", async (tx) => myAttachment(tx, await MailOwner.of(tx), attachmentId));
  const safe = file.name.replace(/[^\x20-\x7e]|["\\]/g, "_") || "attachment";
  return new Response(new Uint8Array(file.content), {
    status: 200,
    headers: {
      "content-type": "application/octet-stream",
      "content-disposition": `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox",
    },
  });
});
