import { describe, expect, it } from "vitest";
import { oauthAddressesFor } from "@/lib/ai/oauth/config";
import { canonicalResource, resourceIsOurs } from "@/lib/ai/oauth/format";
import { officeAddinId, officeAddressesFor, officeClientMetadata, officeManifestXml } from "@/lib/office/addin";
import { accessStillGood, parseStoredTokens, tokenStorageKey } from "@/lib/office/client/auth";
import { officeApiPath } from "@/lib/office/paths";
import { MAX_SNAPSHOT_CHARACTERS, parseSlideChoice, parseSlideSnapshot, reportAddress } from "@/lib/office/settings";

/** The PowerPoint add-in's pure parts (#429, decisions 830-849). */

const ORIGIN = "https://slides.example.nz";

describe("the add-in's addresses (decision 831)", () => {
  it("only exists on an https remote access address", () => {
    expect(officeAddressesFor(null)).toBeNull();
    expect(officeAddressesFor("http://slides.example.nz")).toBeNull();
    expect(officeAddressesFor("not an address")).toBeNull();
    expect(officeAddressesFor(`${ORIGIN}/`)).toEqual({
      origin: ORIGIN,
      resource: `${ORIGIN}/api/office`,
      clientId: `${ORIGIN}/office/powerpoint/client.json`,
      redirectUri: `${ORIGIN}/office/powerpoint/signed-in`,
      contentUrl: `${ORIGIN}/office/powerpoint`,
      manifestUrl: `${ORIGIN}/office/powerpoint/manifest.xml`,
    });
  });

  it("describes itself as a public client with one redirect address on Tohyee", () => {
    const addresses = officeAddressesFor(ORIGIN)!;
    expect(officeClientMetadata(addresses)).toEqual({
      client_id: `${ORIGIN}/office/powerpoint/client.json`,
      client_name: "Tohyee for PowerPoint",
      client_uri: ORIGIN,
      redirect_uris: [`${ORIGIN}/office/powerpoint/signed-in`],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
  });
});

describe("token audiences (decision 833)", () => {
  it("keeps the Office API and MCP apart", () => {
    const addresses = oauthAddressesFor(ORIGIN)!;
    expect(addresses.resource).toBe(`${ORIGIN}/api/mcp`);
    expect(addresses.officeResource).toBe(`${ORIGIN}/api/office`);
    expect(addresses.officeResourceMetadataUrl).toBe(`${ORIGIN}/.well-known/oauth-protected-resource/api/office`);
    expect(resourceIsOurs(addresses.officeResource, addresses.resource)).toBe(false);
    expect(resourceIsOurs(addresses.resource, addresses.officeResource)).toBe(false);
    expect(canonicalResource(`${ORIGIN}/api/office/`)).toBe(canonicalResource(addresses.officeResource));
  });
});

describe("the manifest (decision 832)", () => {
  const xml = officeManifestXml(officeAddressesFor(ORIGIN)!, "0.12.0");

  it("is a content add-in for PowerPoint on this server", () => {
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('xsi:type="ContentApp"');
    expect(xml).toContain('<Host Name="Presentation"/>');
    expect(xml).toContain(`<SourceLocation DefaultValue="${ORIGIN}/office/powerpoint"/>`);
    expect(xml).toContain(`<AppDomain>${ORIGIN}</AppDomain>`);
    expect(xml).toContain("<Version>0.12.0.0</Version>");
    expect(xml).toContain("<Permissions>Restricted</Permissions>");
    expect(xml).toContain(`<IconUrl DefaultValue="${ORIGIN}/office/icon-32.png"/>`);
    expect(xml).toContain("<RequestedWidth>800</RequestedWidth>");
  });

  it("has its elements in the order Office's schema requires", () => {
    const order = ["Id", "Version", "ProviderName", "DefaultLocale", "DisplayName", "Description", "IconUrl", "HighResolutionIconUrl", "SupportUrl", "AppDomains", "Hosts", "Requirements", "DefaultSettings", "Permissions", "AllowSnapshot"];
    const body = xml.slice(xml.indexOf("<OfficeApp"), xml.indexOf("</OfficeApp>"));
    const top = [...body.matchAll(/^ {2}<([A-Za-z]+)/gm)].map((match) => match[1]);
    expect(top).toEqual(order);
    const settings = body.slice(body.indexOf("<DefaultSettings>"), body.indexOf("</DefaultSettings>"));
    expect([...settings.matchAll(/<(SourceLocation|RequestedWidth|RequestedHeight)/g)].map((match) => match[1])).toEqual(["SourceLocation", "RequestedWidth", "RequestedHeight"]);
  });

  it("gives each server its own add-in id, the same every time", () => {
    const id = officeAddinId(ORIGIN);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(officeAddinId("HTTPS://SLIDES.EXAMPLE.NZ")).toBe(id);
    expect(officeAddinId("https://other.example.nz")).not.toBe(id);
    expect(xml).toContain(`<Id>${id}</Id>`);
  });

  it("escapes the address in attributes and falls back to a valid version", () => {
    const odd = officeManifestXml({ ...officeAddressesFor(ORIGIN)!, contentUrl: `${ORIGIN}/office/powerpoint?a=1&b="2"` }, "dev");
    expect(odd).toContain("?a=1&amp;b=&quot;2&quot;");
    expect(odd).toContain("<Version>1.0.0.0</Version>");
  });
});

describe("what the add-in may ask the Office API for (decision 838)", () => {
  it.each([
    ["/api/analytics/dashboards/12", "GET", "/api/office/reports/12"],
    ["/api/analytics/dashboards/12?organisationId=acme", "GET", "/api/office/reports/12"],
    ["/api/analytics/dashboards/12/freshness", "GET", "/api/office/reports/12/freshness"],
    ["/api/analytics/dashboards/12/images/4f2a-b", "GET", "/api/office/reports/12/images/4f2a-b"],
    ["/api/analytics/query", "POST", "/api/office/query"],
    ["/api/analytics/values", "GET", "/api/office/values"],
  ])("%s (%s) goes to %s", (path, method, expected) => {
    expect(officeApiPath(path, method)).toBe(expected);
  });

  it.each([
    ["/api/analytics/dashboards/12", "PATCH"],
    ["/api/analytics/dashboards/12", "DELETE"],
    ["/api/analytics/dashboards", "POST"],
    ["/api/analytics/dashboards/12/shares", "GET"],
    ["/api/analytics/dashboards/12/images", "POST"],
    ["/api/analytics/tables", "GET"],
    ["/api/analytics/query", "GET"],
    ["/api/dashboard-preferences", "GET"],
    ["/api/reports/export", "POST"],
    ["/api/organisations/acme/settings", "GET"],
    ["/api/analytics/dashboards/abc", "GET"],
    ["https://elsewhere.example.com/api/analytics/query", "POST"],
  ])("%s (%s) is refused", (path, method) => {
    expect(officeApiPath(path, method)).toBeNull();
  });
});

describe("what's kept in the presentation (decision 840)", () => {
  const choice = {
    v: 1,
    server: ORIGIN,
    organisationId: "pasture-demo",
    organisationName: "Pasture Demo",
    dashboardId: "7",
    reportName: "Milk income",
    pageId: "p1",
    tileId: null,
    tileTitle: null,
    showFilters: true,
    keepSnapshot: true,
  };

  it("reads back a choice the add-in wrote, and nothing else", () => {
    expect(parseSlideChoice(choice)).toEqual(choice);
    expect(parseSlideChoice({ ...choice, keepSnapshot: undefined })?.keepSnapshot).toBe(true);
    expect(parseSlideChoice(null)).toBeNull();
    expect(parseSlideChoice({ ...choice, v: 2 })).toBeNull();
    expect(parseSlideChoice({ ...choice, server: "http://slides.example.nz" })).toBeNull();
    expect(parseSlideChoice({ ...choice, server: `${ORIGIN}/path` })).toBeNull();
    expect(parseSlideChoice({ ...choice, dashboardId: "1; drop" })).toBeNull();
    expect(parseSlideChoice({ ...choice, tileId: "../x" })).toBeNull();
  });

  it("never keeps a token: the choice has no place for one", () => {
    const parsed = parseSlideChoice({ ...choice, access: "tohyee_at_x", refresh: "tohyee_rt_x" });
    expect(Object.keys(parsed!)).not.toContain("access");
    expect(JSON.stringify(parsed)).not.toContain("tohyee_");
  });

  it("only shows a saved picture that's an image data address of a sensible size", () => {
    const good = { image: "data:image/svg+xml;base64,PHN2Zy8+", takenAt: "2026-10-23T01:00:00.000Z" };
    expect(parseSlideSnapshot(good)).toEqual(good);
    expect(parseSlideSnapshot({ ...good, image: "https://evil.example.com/x.png" })).toBeNull();
    expect(parseSlideSnapshot({ ...good, image: "data:text/html;base64,PGI+" })).toBeNull();
    expect(parseSlideSnapshot({ ...good, image: `data:image/png;base64,${"A".repeat(MAX_SNAPSHOT_CHARACTERS)}` })).toBeNull();
    expect(parseSlideSnapshot({ ...good, takenAt: "yesterday" })).toBeNull();
  });

  it("opens the report in Tohyee on its own server", () => {
    expect(reportAddress(choice)).toBe(`${ORIGIN}/analytics/dashboards/7?page=p1`);
    expect(reportAddress({ ...choice, pageId: null })).toBe(`${ORIGIN}/analytics/dashboards/7`);
  });
});

describe("tokens on this computer (decision 842)", () => {
  const tokens = { access: `tohyee_at_${"a".repeat(43)}`, refresh: `tohyee_rt_${"b".repeat(43)}`, accessExpiresAt: 1_000_000 };

  it("are kept per Office partition and per server", () => {
    expect(tokenStorageKey(undefined, ORIGIN)).toBe(`tohyee.office.tokens:${ORIGIN}`);
    expect(tokenStorageKey("partition-1", ORIGIN)).toBe(`partition-1tohyee.office.tokens:${ORIGIN}`);
  });

  it("reads back only well-formed tokens", () => {
    expect(parseStoredTokens(JSON.stringify(tokens))).toEqual(tokens);
    expect(parseStoredTokens(null)).toBeNull();
    expect(parseStoredTokens("{not json")).toBeNull();
    expect(parseStoredTokens(JSON.stringify({ ...tokens, access: "tohyee_ai_key" }))).toBeNull();
  });

  it("renews the access token a minute before it runs out", () => {
    expect(accessStillGood(tokens, 1_000_000 - 61_000)).toBe(true);
    expect(accessStillGood(tokens, 1_000_000 - 59_000)).toBe(false);
  });
});
