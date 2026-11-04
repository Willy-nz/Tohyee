import { errorResponse, readLimitedBytes } from "@/lib/api/http";
import { kickEmailOutbox } from "@/lib/email/outbox";
import { signMeta } from "@/lib/signing/http";
import { withSigningLink } from "@/lib/signing/public";
import { publicDecline, publicSendCode, publicSign, publicSigningView, publicVerifyCode } from "@/lib/signing/service";

type Context = { params: Promise<{ organisationId: string; token: string }> };

const HEADERS = { "content-type": "application/json", "cache-control": "no-store", "x-robots-tag": "noindex", "referrer-policy": "no-referrer" };
const NOT_FOUND = "This signing link isn't working. It may have been used already, withdrawn or expired. Ask whoever sent it for a new one.";
const notFound = () => new Response(JSON.stringify({ error: NOT_FOUND }), { status: 404, headers: HEADERS });
const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: HEADERS });
const sessionOf = (request: Request) => request.headers.get("x-signing-session");

/**
 * A signer's link (decisions 1396-1410). No Tohyee login: the token in the
 * address is what lets it in, and every refusal is the same "not found".
 * The session from entering the emailed code goes in the
 * `x-signing-session` header, never the address.
 */
export async function GET(request: Request, context: Context): Promise<Response> {
  const { organisationId, token } = await context.params;
  try {
    const meta = await signMeta(request);
    const view = await withSigningLink(organisationId, token, (tx, found) => publicSigningView(tx, found, sessionOf(request), meta));
    return view ? answer(view) : notFound();
  } catch (error) {
    return errorResponse(error);
  }
}

/** POST `{ action: "send_code" | "verify_code" | "sign" | "decline", ... }`. */
export async function POST(request: Request, context: Context): Promise<Response> {
  const { organisationId, token } = await context.params;
  try {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse((await readLimitedBytes(request, 512 * 1024)).toString("utf8")) as Record<string, unknown>;
    } catch {
      return notFound();
    }
    if (!body || typeof body !== "object") return notFound();
    const meta = await signMeta(request);
    const session = sessionOf(request);
    let sentEmail = false;
    const result = await withSigningLink(organisationId, token, async (tx, found) => {
      sentEmail = true;
      if (body.action === "send_code") return publicSendCode(tx, found, meta);
      if (body.action === "verify_code") return publicVerifyCode(tx, found, body.code, meta);
      if (body.action === "sign") return publicSign(tx, found, session, body, meta);
      if (body.action === "decline") return publicDecline(tx, found, session, body.reason, meta);
      sentEmail = false;
      return null;
    });
    if (!result) return notFound();
    if (sentEmail) kickEmailOutbox(organisationId);
    if ("ok" in result && result.ok === false) return answer({ error: result.message }, 400);
    return answer(result);
  } catch (error) {
    return errorResponse(error);
  }
}
