import { NextResponse } from "next/server";
import { route } from "@/lib/api/http";
import { MCP_REQUESTS_PER_MINUTE, RequestLimiter } from "@/lib/ai/limits";
import { handleMcpMessage, JSON_RPC, type JsonRpcResponse, protocolHeaderAccepted, rpcError } from "@/lib/ai/mcp-protocol";
import { mcpServerFor } from "@/lib/ai/mcp-server";
import { bearerAiToken } from "@/lib/ai/token-format";
import { authenticateAiToken } from "@/lib/ai/tokens";

/**
 * The MCP endpoint people connect their own AI to (decisions 339-345).
 *
 * Authenticated only by `Authorization: Bearer tohyee_ai_…` (a personal AI
 * key); session cookies are ignored, so a signed-in browser can't use it.
 * There's no same-origin check because AI services call it from elsewhere;
 * a cross-site browser page can't send the header without a CORS preflight,
 * which this route doesn't answer. Read tools run in a read-only
 * transaction; a key with draft or post access can also use the write tools
 * up to its level, as its owner (src/lib/ai/write-tools.ts). A key stops when
 * revoked, when its owner leaves the organisation, or when its owner's
 * password or two-step sign-in is reset (#132).
 */

const limiter = new RequestLimiter(MCP_REQUESTS_PER_MINUTE);

function reply(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store", ...headers } });
}

function unauthorized(): Response {
  return reply(
    rpcError(null, JSON_RPC.UNAUTHORIZED, "This needs a Tohyee AI key: Authorization: Bearer tohyee_ai_… Make one on the AI page in Tohyee."),
    401,
    { "www-authenticate": 'Bearer realm="tohyee", error="invalid_token"' },
  );
}

export const POST = route(async (request) => {
  const token = bearerAiToken(request.headers.get("authorization"));
  const identity = token ? await authenticateAiToken(token) : null;
  if (!identity) return unauthorized();

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
    message = await request.json();
  } catch {
    return reply(rpcError(null, JSON_RPC.PARSE_ERROR, "The request body must be JSON."), 400);
  }

  const server = mcpServerFor(identity);
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
