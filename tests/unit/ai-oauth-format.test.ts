import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { consentLevels } from "@/components/auth/connect-consent";
import { authorizationServerMetadata, oauthAddressesFor, protectedResourceMetadata } from "@/lib/ai/oauth/config";
import {
  bearerToken,
  canonicalResource,
  cleanClientName,
  isLoopbackRedirect,
  isMetadataDocumentClientId,
  looksLikeAccessToken,
  metadataCacheSeconds,
  pkceMatches,
  randomToken,
  redirectHost,
  redirectUriMatches,
  redirectUriProblem,
  redirectWith,
  resourceIsOurs,
  resourceMetadataUrlFor,
  wwwAuthenticate,
} from "@/lib/ai/oauth/format";
import { connectProblemMessage, CONNECT_PROBLEMS } from "@/lib/ai/oauth/messages";
import { safeNextPath } from "@/lib/auth/google-messages";

describe("AI apps signing in: the pure parts (#427)", () => {
  it("checks PKCE S256 as RFC 7636 appendix B does", () => {
    // RFC 7636 appendix B's own example.
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(pkceMatches(verifier, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")).toBe(true);
    expect(pkceMatches(verifier, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cN")).toBe(false);
    // "plain" (the challenge is the verifier) is never accepted.
    expect(pkceMatches(verifier, verifier)).toBe(false);
    expect(pkceMatches("short", createHash("sha256").update("short").digest("base64url"))).toBe(false);
    expect(pkceMatches(undefined, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")).toBe(false);
  });

  it("accepts https redirect addresses and http only on this computer", () => {
    expect(redirectUriProblem("https://claude.ai/api/mcp/auth_callback")).toBeNull();
    expect(redirectUriProblem("https://chatgpt.com/connector_platform_oauth_redirect")).toBeNull();
    expect(redirectUriProblem("http://localhost:3118/callback")).toBeNull();
    expect(redirectUriProblem("http://127.0.0.1/callback")).toBeNull();
    expect(redirectUriProblem("http://[::1]:9000/cb")).toBeNull();
    expect(redirectUriProblem("http://evil.example/callback")).not.toBeNull();
    expect(redirectUriProblem("http://localhost.evil.example/callback")).not.toBeNull();
    expect(redirectUriProblem("cursor://anysphere.cursor/callback")).not.toBeNull();
    expect(redirectUriProblem("javascript:alert(1)")).not.toBeNull();
    expect(redirectUriProblem("https://claude.ai/cb#frag")).not.toBeNull();
    expect(redirectUriProblem("https://user:pass@claude.ai/cb")).not.toBeNull();
    expect(redirectUriProblem(`https://claude.ai/${"a".repeat(500)}`)).not.toBeNull();
    expect(redirectUriProblem("/relative")).not.toBeNull();
  });

  it("matches redirect addresses exactly, except the port on this computer", () => {
    const claude = ["https://claude.ai/api/mcp/auth_callback"];
    expect(redirectUriMatches("https://claude.ai/api/mcp/auth_callback", claude)).toBe(true);
    // No prefix, case, trailing-slash, query or look-alike tricks.
    expect(redirectUriMatches("https://claude.ai/api/mcp/auth_callback/", claude)).toBe(false);
    expect(redirectUriMatches("https://claude.ai/api/mcp/auth_callback?x=1", claude)).toBe(false);
    expect(redirectUriMatches("https://Claude.ai/api/mcp/auth_callback", claude)).toBe(false);
    expect(redirectUriMatches("https://claude.ai.evil.example/api/mcp/auth_callback", claude)).toBe(false);
    expect(redirectUriMatches("https://claude.ai@evil.example/api/mcp/auth_callback", claude)).toBe(false);
    // Claude Code's loopback redirect on any port (RFC 8252 section 7.3).
    const code = ["http://localhost/callback", "http://127.0.0.1/callback"];
    expect(redirectUriMatches("http://localhost:51234/callback", code)).toBe(true);
    expect(redirectUriMatches("http://127.0.0.1:3118/callback", code)).toBe(true);
    expect(redirectUriMatches("http://localhost:51234/other", code)).toBe(false);
    expect(redirectUriMatches("http://[::1]:51234/callback", code)).toBe(false);
    expect(redirectUriMatches("https://localhost:51234/callback", code)).toBe(false);
    // A registered https address never matches a loopback one, or the other way.
    expect(redirectUriMatches("http://localhost:3000/cb", ["https://localhost/cb"])).toBe(false);
    expect(isLoopbackRedirect("http://127.0.0.1:1/x")).toBe(true);
    expect(isLoopbackRedirect("https://127.0.0.1/x")).toBe(false);
    expect(redirectHost("https://claude.ai/api/mcp/auth_callback")).toBe("claude.ai");
  });

  it("binds tokens to the MCP address (RFC 8707)", () => {
    const ours = "https://books.example.nz/api/mcp";
    expect(resourceIsOurs("https://books.example.nz/api/mcp", ours)).toBe(true);
    expect(resourceIsOurs("https://BOOKS.example.nz/api/mcp/", ours)).toBe(true);
    expect(resourceIsOurs("https://books.example.nz:443/api/mcp", ours)).toBe(true);
    expect(resourceIsOurs("https://books.example.nz", ours)).toBe(true);
    expect(resourceIsOurs("https://books.example.nz/", ours)).toBe(true);
    expect(resourceIsOurs("https://other.example.nz/api/mcp", ours)).toBe(false);
    expect(resourceIsOurs("https://books.example.nz/api/other", ours)).toBe(false);
    expect(resourceIsOurs("http://books.example.nz/api/mcp", ours)).toBe(false);
    expect(resourceIsOurs("https://books.example.nz/api/mcp#x", ours)).toBe(false);
    expect(canonicalResource("not a url")).toBeNull();
    expect(resourceMetadataUrlFor(ours)).toBe("https://books.example.nz/.well-known/oauth-protected-resource/api/mcp");
  });

  it("only signs in on an https remote access address", () => {
    expect(oauthAddressesFor(null)).toBeNull();
    expect(oauthAddressesFor("http://books.example.nz")).toBeNull();
    expect(oauthAddressesFor("not a url")).toBeNull();
    const addresses = oauthAddressesFor("https://books.example.nz/");
    expect(addresses).toEqual({
      issuer: "https://books.example.nz",
      resource: "https://books.example.nz/api/mcp",
      resourceMetadataUrl: "https://books.example.nz/.well-known/oauth-protected-resource/api/mcp",
      // The PowerPoint add-in's separate audience (#429, decision 833).
      officeResource: "https://books.example.nz/api/office",
      officeResourceMetadataUrl: "https://books.example.nz/.well-known/oauth-protected-resource/api/office",
    });
    const resource = protectedResourceMetadata(addresses!);
    expect(resource.resource).toBe("https://books.example.nz/api/mcp");
    expect(resource.authorization_servers).toEqual(["https://books.example.nz"]);
    const server = authorizationServerMetadata(addresses!);
    expect(server.issuer).toBe("https://books.example.nz");
    expect(server.code_challenge_methods_supported).toEqual(["S256"]);
    // Claude only uses a client ID metadata document when both of these are there.
    expect(server.client_id_metadata_document_supported).toBe(true);
    expect(server.token_endpoint_auth_methods_supported).toEqual(["none"]);
    expect(server.authorization_response_iss_parameter_supported).toBe(true);
    expect(server.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
    expect(server).not.toHaveProperty("scopes_supported");
  });

  it("challenges with the resource metadata address", () => {
    expect(wwwAuthenticate("https://b.example/.well-known/oauth-protected-resource/api/mcp", false)).toBe(
      'Bearer resource_metadata="https://b.example/.well-known/oauth-protected-resource/api/mcp"',
    );
    expect(wwwAuthenticate("https://b.example/x", true)).toBe('Bearer resource_metadata="https://b.example/x", error="invalid_token"');
    expect(wwwAuthenticate(null, true)).toBe('Bearer realm="tohyee", error="invalid_token"');
  });

  it("cleans app names so they can't hide or reorder text", () => {
    expect(cleanClientName("  Claude  ")).toBe("Claude");
    expect(cleanClientName("Clau‮de")).toBe("Claude");
    expect(cleanClientName("Chat​GPT\n\tBeta")).toBe("ChatGPT Beta");
    expect(cleanClientName("")).toBeNull();
    expect(cleanClientName(42)).toBeNull();
    expect(cleanClientName("x".repeat(80))).toHaveLength(60);
  });

  it("knows a metadata document client ID when it sees one", () => {
    expect(isMetadataDocumentClientId("https://chatgpt.com/oauth/client.json")).toBe(true);
    expect(isMetadataDocumentClientId("https://claude.ai/oauth/claude-code-client-metadata")).toBe(true);
    expect(isMetadataDocumentClientId("https://app.example.com/")).toBe(false);
    expect(isMetadataDocumentClientId("https://app.example.com")).toBe(false);
    expect(isMetadataDocumentClientId("http://app.example.com/client.json")).toBe(false);
    expect(isMetadataDocumentClientId("https://app.example.com/a/../client.json")).toBe(false);
    expect(isMetadataDocumentClientId("https://app.example.com/./client.json")).toBe(false);
    expect(isMetadataDocumentClientId("https://u:p@app.example.com/client.json")).toBe(false);
    expect(isMetadataDocumentClientId("https://app.example.com/client.json#x")).toBe(false);
    expect(isMetadataDocumentClientId("tohyee_client_abc")).toBe(false);
    expect(metadataCacheSeconds(null)).toBe(3600);
    expect(metadataCacheSeconds("public, max-age=60")).toBe(300);
    expect(metadataCacheSeconds("max-age=999999")).toBe(86_400);
    expect(metadataCacheSeconds("no-store")).toBe(300);
  });

  it("builds the address back to the app with iss and state, and reads bearer tokens", () => {
    const back = new URL(redirectWith("https://claude.ai/api/mcp/auth_callback", { code: "abc", state: "s&1", iss: "https://books.example.nz", error: null }));
    expect(back.searchParams.get("code")).toBe("abc");
    expect(back.searchParams.get("state")).toBe("s&1");
    expect(back.searchParams.get("iss")).toBe("https://books.example.nz");
    expect(back.searchParams.has("error")).toBe(false);
    expect(bearerToken("Bearer abc")).toBe("abc");
    expect(bearerToken("Basic abc")).toBeNull();
    expect(looksLikeAccessToken(randomToken("tohyee_at_"))).toBe(true);
    expect(looksLikeAccessToken(randomToken("tohyee_rt_"))).toBe(false);
  });

  it("offers only levels up to the role's ceiling on the consent screen", () => {
    expect(consentLevels("read")).toEqual(["read"]);
    expect(consentLevels("post")).toEqual(["read", "draft", "post"]);
    expect(consentLevels("full")).toEqual(["read", "draft", "post", "full"]);
  });

  it("sends sign-in back to the consent screen, and nowhere else new", () => {
    const handle = "a".repeat(43);
    expect(safeNextPath(`/connect/${handle}`)).toBe(`/connect/${handle}`);
    expect(safeNextPath("/connect/short")).toBe("/operations");
    expect(safeNextPath(`/connect/${handle}/../../evil`)).toBe("/operations");
    expect(safeNextPath(`//connect/${handle}`)).toBe("/operations");
  });

  it("shows only fixed problem messages", () => {
    expect(connectProblemMessage("redirect")).toBe(CONNECT_PROBLEMS.redirect);
    expect(connectProblemMessage("<script>")).toBe(CONNECT_PROBLEMS.bad_request);
    expect(connectProblemMessage(["off"])).toBe(CONNECT_PROBLEMS.bad_request);
    expect(connectProblemMessage("toString")).toBe(CONNECT_PROBLEMS.bad_request);
  });
});
