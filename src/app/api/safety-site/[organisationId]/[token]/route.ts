import { errorResponse, readLimitedBytes } from "@/lib/api/http";
import { publicSignIn, publicSignOut, publicSite } from "@/lib/safety/inductions";

type Context = { params: Promise<{ organisationId: string; token: string }> };

const HEADERS = { "content-type": "application/json", "cache-control": "no-store", "x-robots-tag": "noindex", "referrer-policy": "no-referrer" };
const notFound = () => new Response(JSON.stringify({ error: "This sign-in link isn't working. Ask the farm for a new one." }), { status: 404, headers: HEADERS });

/**
 * A farm's sign-in link (#446, decisions 948-952). No Tohyee login: the
 * random token in the address is what lets it in, and every refusal is the
 * same "not found". GET: the farm's emergency details, hazards and visitor
 * and contractor inductions. Never who else is on site, or any report.
 */
export async function GET(_request: Request, context: Context): Promise<Response> {
  const { organisationId, token } = await context.params;
  const site = await publicSite(organisationId, token);
  return site ? new Response(JSON.stringify(site), { status: 200, headers: HEADERS }) : notFound();
}

/** POST `{ action: "sign_in", person, audience, purpose, inductionId, inductionVersion, acknowledged }` or `{ action: "sign_out", signOutToken }`. */
export async function POST(request: Request, context: Context): Promise<Response> {
  const { organisationId, token } = await context.params;
  try {
    const body = JSON.parse((await readLimitedBytes(request, 32 * 1024)).toString("utf8")) as Record<string, unknown>;
    if (!body || typeof body !== "object") return notFound();
    const result = body.action === "sign_out" ? await publicSignOut(organisationId, token, body.signOutToken) : body.action === "sign_in" ? await publicSignIn(organisationId, token, body) : null;
    return result ? new Response(JSON.stringify(result), { status: 200, headers: HEADERS }) : notFound();
  } catch (error) {
    if (error instanceof SyntaxError) return notFound();
    return errorResponse(error);
  }
}
