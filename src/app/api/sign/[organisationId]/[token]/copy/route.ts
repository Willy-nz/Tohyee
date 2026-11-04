import { pdfResponse } from "@/lib/signing/http";
import { signedCopyForLink } from "@/lib/signing/public";

type Context = { params: Promise<{ organisationId: string; token: string }> };

/** GET: the signed copy, from the link in the "everyone has signed" email (30 days). */
export async function GET(_request: Request, context: Context): Promise<Response> {
  const { organisationId, token } = await context.params;
  const file = await signedCopyForLink(organisationId, token);
  if (!file) return new Response("This download link isn't working any more. Ask whoever sent the document for a copy.", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  return pdfResponse(file, true);
}
