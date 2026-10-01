import { json, route } from "@/lib/api/http";
import { receiveWebhook } from "@/lib/sales-platforms/service";

type Context = { params: Promise<{ organisationId: string; webhookKey: string }> };

/** Webhook bodies are small (one customer or product); anything bigger is refused before it's read in full. */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

/**
 * Where a sales platform sends its webhooks (examples SPC7, SPC8). The only
 * API route without a signed-in user: it authenticates by the platform's
 * signature over the raw body, with the connection's secret, before
 * anything is read or written.
 */
export const POST = route<Context>(async (request, context) => {
  const { organisationId, webhookKey } = await context.params;
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return json({ error: "Too large." }, { status: 413 });
  const rawBody = await readLimited(request, MAX_BODY_BYTES);
  if (rawBody === null) return json({ error: "Too large." }, { status: 413 });
  const outcome = await receiveWebhook(organisationId, webhookKey, request.headers, rawBody);
  return json({ message: outcome.message }, { status: outcome.status });
});

/**
 * The body, read a piece at a time and given up on once it's over `limit`
 * (null), so a body sent without a Content-Length (chunked) can't fill the
 * server's memory before anyone is authenticated.
 */
async function readLimited(request: Request, limit: number): Promise<Buffer | null> {
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}
