import { unstable_getResponseFromNextConfig } from "next/experimental/testing/server";
import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";

/** Issue #144: security headers on every response. */
describe("security headers", () => {
  async function headersFor(pathname: string): Promise<Headers> {
    const response = await unstable_getResponseFromNextConfig({ url: `https://tohyee.test${pathname}`, nextConfig });
    return response.headers;
  }

  it.each(["/", "/sign-in", "/accounting/invoices/42", "/crm", "/api/health", "/api/files/7"])(
    "%s can only be framed by Tohyee itself, isn't sniffed, and keeps its address to itself",
    async (pathname) => {
      const headers = await headersFor(pathname);
      expect(headers.get("x-frame-options")).toBe("SAMEORIGIN");
      expect(headers.get("x-content-type-options")).toBe("nosniff");
      expect(headers.get("referrer-policy")).toBe("same-origin");
    },
  );

  it.each(["/", "/sign-in", "/accounting/invoices/42", "/apiary", "/crm/companies"])("page %s gets the page policy", async (pathname) => {
    const policy = (await headersFor(pathname)).get("content-security-policy");
    expect(policy).toBe("frame-ancestors 'self'; base-uri 'self'; object-src 'none'");
  });

  it.each(["/api/health", "/api/files/7", "/api/documents/pdf"])(
    "API route %s keeps its own policy (stored files are sandboxed by src/lib/api/upload.ts)",
    async (pathname) => {
      expect((await headersFor(pathname)).get("content-security-policy")).toBeNull();
    },
  );
});
