import { describe, expect, it } from "vitest";
import { MAX_JSON_BYTES, readJson } from "@/lib/api/http";

/** A request whose body arrives in chunks with no Content-Length, as a client streaming it would send. */
function streamed(chunks: string[]): Request {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Request("http://tohyee.test/api/x", { method: "POST", body, duplex: "half" } as RequestInit);
}

describe("readJson's size limit (#133)", () => {
  it("reads an ordinary body", async () => {
    expect(await readJson(streamed(['{"a":', "1}"]))).toEqual({ a: 1 });
  });

  it("stops reading once the body passes the limit, whatever Content-Length says", async () => {
    const chunk = "x".repeat(256 * 1024);
    const big = streamed(['{"a":"', ...Array.from({ length: 12 }, () => chunk), '"}']);
    await expect(readJson(big)).rejects.toMatchObject({ status: 413 });
    expect(MAX_JSON_BYTES).toBe(2 * 1024 * 1024);
  });

  it("refuses a declared length over the limit before reading, and allows a larger limit when asked", async () => {
    const declared = new Request("http://tohyee.test/api/x", { method: "POST", body: "{}", headers: { "content-length": String(MAX_JSON_BYTES + 1) } });
    await expect(readJson(declared)).rejects.toMatchObject({ status: 413 });
    const chunk = "x".repeat(256 * 1024);
    const body = await readJson(streamed(['{"a":"', ...Array.from({ length: 12 }, () => chunk), '"}']), { maxBytes: 4 * 1024 * 1024 });
    expect((body.a as string).length).toBe(12 * 256 * 1024);
  });
});
