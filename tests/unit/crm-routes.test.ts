import { existsSync } from "node:fs";
import path from "node:path";
import { getRedirectUrl, unstable_getResponseFromNextConfig } from "next/experimental/testing/server";
import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";

const APP = path.resolve(import.meta.dirname, "../../src/app");

/** The page file a path is served by (dynamic segments like companies/[contactId]). */
function pageFor(pathname: string): string | null {
  const segments = pathname.split("/").filter(Boolean);
  let dir = APP;
  for (const segment of segments) {
    if (existsSync(path.join(dir, segment))) {
      dir = path.join(dir, segment);
      continue;
    }
    const dynamic = ["[contactId]", "[personId]", "[opportunityId]"].find((name) => existsSync(path.join(dir, name)));
    if (!dynamic) return null;
    dir = path.join(dir, dynamic);
  }
  const page = path.join(dir, "page.tsx");
  return existsSync(page) ? page : null;
}

/** The CRM moved from /operations/crm to its own app at /crm; old links still reach the same pages. */
describe("old CRM URLs", () => {
  const cases: Array<[string, string]> = [
    ["/operations/crm", "/crm/companies"],
    ["/operations/crm/companies", "/crm/companies"],
    ["/operations/crm/companies/42", "/crm/companies/42"],
    ["/operations/crm/people", "/crm/people"],
    ["/operations/crm/people/7", "/crm/people/7"],
    ["/operations/crm/opportunities/9", "/crm/opportunities/9"],
    ["/operations/crm/pipeline", "/crm/pipeline"],
    ["/operations/crm/tasks", "/crm/tasks"],
    ["/operations/crm/mail?connected=google", "/crm/mail?connected=google"],
  ];

  it.each(cases)("%s redirects to %s, which is a page", async (from, to) => {
    const response = await unstable_getResponseFromNextConfig({ url: `https://tohyee.test${from}`, nextConfig });
    expect(response.status).toBe(307);
    expect(getRedirectUrl(response)).toBe(`https://tohyee.test${to}`);
    expect(pageFor(new URL(to, "https://tohyee.test").pathname)).not.toBeNull();
  });

  it("the CRM's Home and tabs are pages, and nothing else under /operations is redirected", async () => {
    for (const tab of ["/crm", "/crm/companies", "/crm/people", "/crm/pipeline", "/crm/tasks", "/crm/mail", "/crm/record-types", "/crm/stages", "/crm/forecasts"]) {
      expect(pageFor(tab), tab).not.toBeNull();
    }
    expect(existsSync(path.join(APP, "crm/layout.tsx"))).toBe(true);
    expect(existsSync(path.join(APP, "operations/crm"))).toBe(false);
    for (const url of ["/operations", "/operations/contacts", "/operations/crmx", "/crm"]) {
      const response = await unstable_getResponseFromNextConfig({ url: `https://tohyee.test${url}`, nextConfig });
      expect(getRedirectUrl(response), url).toBeNull();
    }
  });
});
