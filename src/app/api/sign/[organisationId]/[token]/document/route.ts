import { errorResponse } from "@/lib/api/http";
import { pdfResponse, signMeta } from "@/lib/signing/http";
import { withSigningLink } from "@/lib/signing/public";
import { publicDocument } from "@/lib/signing/service";

type Context = { params: Promise<{ organisationId: string; token: string }> };

/** GET: the document's exact bytes, for a signer who has entered their emailed code (session in `x-signing-session`). */
export async function GET(request: Request, context: Context): Promise<Response> {
  const { organisationId, token } = await context.params;
  try {
    const meta = await signMeta(request);
    const file = await withSigningLink(organisationId, token, (tx, found) => publicDocument(tx, found, request.headers.get("x-signing-session"), meta));
    if (!file) return new Response(JSON.stringify({ error: "This signing link isn't working." }), { status: 404, headers: { "content-type": "application/json", "cache-control": "no-store" } });
    return pdfResponse(file, new URL(request.url).searchParams.get("download") === "true");
  } catch (error) {
    return errorResponse(error);
  }
}
