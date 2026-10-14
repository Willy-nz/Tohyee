import { PayloadTooLargeError } from "@/lib/errors";

const sizeText = (bytes: number) => (bytes >= 1024 * 1024 ? `${Math.round(bytes / (1024 * 1024))} MB` : `${Math.round(bytes / 1024)} KB`);

/**
 * A request's or response's body, stopping as soon as it's bigger than
 * `maxBytes`, so a huge body can't use up memory first (#133). Reads the
 * stream itself, so a body sent without a Content-Length (chunked) is capped
 * too. `what` names it in the error ("The request", "The bank's answer").
 */
export async function readLimitedBytes(message: Pick<Request, "body" | "headers">, maxBytes: number, what = "The request"): Promise<Buffer> {
  const declared = Number(message.headers.get("content-length"));
  const tooLarge = () => new PayloadTooLargeError(`${what} is too large (at most ${sizeText(maxBytes)}).`);
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge();
  if (!message.body) return Buffer.alloc(0);
  const reader = message.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
