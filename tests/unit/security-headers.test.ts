import { unstable_getResponseFromNextConfig } from "next/experimental/testing/server";
import { describe, expect, it } from "vitest";
import { fileResponse } from "@/lib/api/upload";
import nextConfig from "../../next.config";

/** Issue #144: every response says who may frame it, sends no cross-site referrer and isn't content-sniffed. */
describe("security headers", () => {
  async function headersFor(pathname: string): Promise<Headers> {
    return (await unstable_getResponseFromNextConfig({ url: `https://tohyee.test${pathname}`, nextConfig })).headers;
  }

  it.each(["/", "/sign-in", "/sales/invoices", "/crm/companies/42", "/api", "/api/health", "/api/bills/inbox/3/file"])("%s gets the common headers", async (pathname) => {
    const headers = await headersFor(pathname);
    expect(headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(headers.get("referrer-policy")).toBe("same-origin");
    expect(headers.get("x-content-type-options")).toBe("nosniff");
    // #208: HTTPS from then on for an address reached over HTTPS (browsers ignore it on plain HTTP).
    expect(headers.get("strict-transport-security")).toBe("max-age=31536000");
  });

  it.each(["/", "/sign-in", "/sales/invoices", "/crm/companies/42", "/apis", "/api"])("page %s may only be framed by Tohyee", async (pathname) => {
    // 'self', not 'none': the bills inbox shows a PDF in a same-origin iframe.
    expect((await headersFor(pathname)).get("content-security-policy")).toBe(
      "frame-ancestors 'self'; base-uri 'self'; object-src 'none'; form-action 'self'; img-src 'self' data: blob: https://basemaps.linz.govt.nz",
    );
  });

  // #429, decision 839: only the PowerPoint add-in's slide page may be framed by Office.
  it("lets Office frame the PowerPoint add-in's slide page, and nothing else", async () => {
    const slide = await headersFor("/office/powerpoint");
    expect(slide.get("x-frame-options")).toBeNull();
    const policy = slide.get("content-security-policy") ?? "";
    expect(policy).toContain("frame-ancestors 'self' https://*.officeapps.live.com");
    expect(policy).toContain("https://*.sharepoint.com");
    expect(policy).toContain("object-src 'none'");
    // With a query string it's the same page.
    expect((await headersFor("/office/powerpoint?x=1")).get("x-frame-options")).toBeNull();
  });

  it.each([
    "/office/powerpoint/signed-in",
    "/office/powerpoint/help",
    "/office/powerpoint/manifest.xml",
    "/office/powerpointx",
    "/office",
    "/login",
    "/oauth/authorize",
    "/connect/abc",
    "/analytics/dashboards/1",
  ])("%s still can't be framed by Office", async (pathname) => {
    const headers = await headersFor(pathname);
    expect(headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(headers.get("content-security-policy")).toContain("frame-ancestors 'self';");
  });

  it("the Office API is never framed", async () => {
    expect((await headersFor("/api/office/me")).get("x-frame-options")).toBe("SAMEORIGIN");
  });

  it("leaves the CSP of /api/ responses to the route, so a stored file's sandbox isn't replaced", async () => {
    expect((await headersFor("/api/bills/inbox/3/file")).get("content-security-policy")).toBeNull();
    expect((await headersFor("/api/organisations/acme/logo")).get("content-security-policy")).toBeNull();
  });

  it("stored files set their own frame-ancestors (images stay sandboxed)", () => {
    const content = new Uint8Array([1, 2, 3]);
    const pdf = fileResponse({ fileName: "bill.pdf", contentType: "application/pdf", content }, false);
    expect(pdf.headers.get("content-security-policy")).toBe("frame-ancestors 'self'");
    const image = fileResponse({ fileName: "receipt.png", contentType: "image/png", content }, false);
    const policy = image.headers.get("content-security-policy") ?? "";
    expect(policy.split(";").map((part) => part.trim())).toEqual(expect.arrayContaining(["sandbox", "default-src 'none'", "frame-ancestors 'self'"]));
  });
});
