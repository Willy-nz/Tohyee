import { describe, expect, it } from "vitest";
import { assertSameOrigin } from "@/lib/auth/guard";

const post = (headers: Record<string, string>) => new Request("http://tohyee.test/api/invoices", { method: "POST", headers: { host: "tohyee.test", ...headers } });
const signedIn = { cookie: "tohyee_session=abc" };

describe("writes from other sites are refused", () => {
  it("allows the same origin, and scripts without a session", () => {
    expect(() => assertSameOrigin(post({ ...signedIn, origin: "http://tohyee.test" }))).not.toThrow();
    expect(() => assertSameOrigin(post({ ...signedIn, "sec-fetch-site": "same-origin" }))).not.toThrow();
    expect(() => assertSameOrigin(post({}))).not.toThrow();
    expect(() => assertSameOrigin(post({ cookie: "other=1" }))).not.toThrow();
  });
  it("refuses another site, and a signed-in write that says neither where it's from nor that it's same-site", () => {
    expect(() => assertSameOrigin(post({ ...signedIn, origin: "https://evil.example" }))).toThrow("Cross-site request blocked.");
    expect(() => assertSameOrigin(post({ ...signedIn, "sec-fetch-site": "same-site" }))).toThrow("Cross-site request blocked.");
    expect(() => assertSameOrigin(post({ ...signedIn }))).toThrow("Cross-site request blocked.");
  });
  it("leaves reads alone", () => {
    expect(() => assertSameOrigin(new Request("http://tohyee.test/api/invoices", { headers: signedIn }))).not.toThrow();
  });
});
