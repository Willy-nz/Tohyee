import { NextResponse } from "next/server";
import { MAX_JSON_BYTES, readLimitedBytes, route } from "@/lib/api/http";
import { MCP_FAILED_KEYS_PER_MINUTE, MCP_REQUESTS_PER_MINUTE, RequestLimiter } from "@/lib/ai/limits";
import { handleMcpMessage, JSON_RPC, type JsonRpcResponse, protocolHeaderAccepted, rpcError } from "@/lib/ai/mcp-protocol";
import { mcpServerFor } from "@/lib/ai/mcp-server";
import { oauthAddresses } from "@/lib/ai/oauth/config";
import { bearerToken, wwwAuthenticate } from "@/lib/ai/oauth/format";
import { authenticateAccessToken } from "@/lib/ai/oauth/tokens";
import { looksLikeAiToken } from "@/lib/ai/token-format";
import { authenticateAiToken, type AiTokenIdentity } from "@/lib/ai/tokens";
import { keyCanReadMail } from "@/lib/private-mail/ai";
import { sessionMetaFrom } from "@/lib/auth/sessions";
import { PayloadTooLargeError } from "@/lib/errors";

/**
 * The MCP endpoint people connect their own AI to (decisions 339-345).
 *
 * Authenticated only by `Authorization: Bearer …`: a personal AI key
 * (`tohyee_ai_…`), or an access token an AI app got by signing in
 * (`tohyee_at_…`, #427, decisions 810-829). Session cookies are ignored, so
 * a signed-in browser can't use it. Without a working token the answer is
 * 401 with `WWW-Authenticate: Bearer resource_metadata="…"` (RFC 9728), so
 * an AI app knows where to sign in, when remote access is on.
 * There's no same-origin check because AI services call it from elsewhere;
 * a cross-site browser page can't send the header without a CORS preflight,
 * which this route doesn't answer. Read tools run in a read-only
 * transaction; a key with draft or post access can also use the write tools
 * up to its level, as its owner (src/lib/ai/write-tools.ts). A key stops when
 * revoked, when its owner leaves the organisation, or when its owner's
 * password or two-step sign-in is reset (#132).
 */

const limiter = new RequestLimiter(MCP_REQUESTS_PER_MINUTE);
/** Wrong keys from one address (like sign-in tries); with no address known, it doesn't apply. */
const failedKeys = new RequestLimiter(MCP_FAILED_KEYS_PER_MINUTE);

function tooManyFailures(): Response {
  return reply(rpcError(null, JSON_RPC.UNAUTHORIZED, "Too many wrong AI keys from this address. Wait a minute and try again."), 429, { "retry-after": "60" });
}

function reply(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store", ...headers } });
}

async function unauthorized(tokenSent: boolean): Promise<Response> {
  const addresses = await oauthAddresses();
  return reply(
    rpcError(
      null,
      JSON_RPC.UNAUTHORIZED,
      addresses
        ? "Sign in to Tohyee to connect (your AI app should offer this), or use a Tohyee AI key: Authorization: Bearer tohyee_ai_…"
        : "This needs a Tohyee AI key: Authorization: Bearer tohyee_ai_… Make one on the AI page in Tohyee.",
    ),
    401,
    { "www-authenticate": wwwAuthenticate(addresses?.resourceMetadataUrl ?? null, tokenSent) },
  );
}

async function identify(token: string | null): Promise<AiTokenIdentity | null> {
  if (!token) return null;
  if (looksLikeAiToken(token)) return authenticateAiToken(token);
  return authenticateAccessToken(token);
}

export const POST = route(async (request) => {
  const address = sessionMetaFrom(request).ipAddress;
  if (address && failedKeys.spent(address)) return tooManyFailures();
  const token = bearerToken(request.headers.get("authorization"));
  const identity = await identify(token);
  if (!identity) {
    if (token && address && !failedKeys.take(address)) return tooManyFailures();
    return unauthorized(token !== null);
  }

  if (!limiter.take(identity.tokenId)) {
    return reply(rpcError(null, JSON_RPC.INTERNAL_ERROR, "Too many requests with this key. Wait a minute and try again."), 429, {
      "retry-after": "60",
    });
  }
  if (!protocolHeaderAccepted(request.headers.get("mcp-protocol-version"))) {
    return reply(rpcError(null, JSON_RPC.INVALID_REQUEST, "Unsupported MCP-Protocol-Version."), 400);
  }

  let message: unknown;
  try {
    message = JSON.parse((await readLimitedBytes(request, MAX_JSON_BYTES)).toString("utf8"));
  } catch (error) {
    if (error instanceof PayloadTooLargeError) return reply(rpcError(null, JSON_RPC.INVALID_REQUEST, error.message), 413);
    return reply(rpcError(null, JSON_RPC.PARSE_ERROR, "The request body must be JSON."), 400);
  }

  // The mail tools only for a Look only key its Owner gave the private-mail scope (#250, decision 618).
  const server = mcpServerFor(identity, { privateMail: await keyCanReadMail(identity) });
  if (Array.isArray(message)) {
    // JSON-RPC batches (MCP 2025-03-26 allowed them; later versions don't send them).
    if (message.length === 0 || message.length > 20) {
      return reply(rpcError(null, JSON_RPC.INVALID_REQUEST, "A batch must have 1 to 20 messages."), 400);
    }
    const answers: JsonRpcResponse[] = [];
    for (const entry of message) {
      const answer = await handleMcpMessage(entry, server);
      if (answer) answers.push(answer);
    }
    return answers.length === 0 ? new Response(null, { status: 202 }) : reply(answers);
  }
  const answer = await handleMcpMessage(message, server);
  return answer ? reply(answer) : new Response(null, { status: 202 });
});

/** No server-sent event stream and no sessions: only POST. */
function methodNotAllowed(): Response {
  return new Response(null, { status: 405, headers: { allow: "POST" } });
}

export const GET = route(async () => methodNotAllowed());
export const DELETE = route(async () => methodNotAllowed());
