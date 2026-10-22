import { describe, expect, it } from "vitest";
import { googleSignInMessage, safeNextPath } from "@/lib/auth/google-messages";
import { googleRedirectUri, googleSignInUrl, pkceChallenge, redirectOriginProblem, verifyGoogleIdToken } from "@/lib/auth/google-oidc";

const CLIENT = "made-up-client.apps.googleusercontent.com";
const NOW = Date.UTC(2026, 9, 22, 1, 0, 0);

function token(claims: Record<string, unknown>, header: Record<string, unknown> = { alg: "RS256", kid: "made-up" }): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part(header)}.${part(claims)}.${Buffer.from("not-a-real-signature").toString("base64url")}`;
}

const good = {
  iss: "https://accounts.google.com",
  aud: CLIENT,
  azp: CLIENT,
  sub: "110248495921238986420",
  email: "Aroha@Example.com",
  email_verified: true,
  name: "Aroha Ngata",
  nonce: "nonce-made-up-0123456789",
  iat: NOW / 1000 - 5,
  exp: NOW / 1000 + 3600,
};
const check = (claims: Record<string, unknown>) => () => verifyGoogleIdToken(token(claims), { clientId: CLIENT, nonce: good.nonce, now: NOW });

describe("Sign in with Google: PKCE and the sign-in address (#424)", () => {
  it("uses S256 PKCE (RFC 7636 appendix B's example)", () => {
    expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("asks only for openid, email and profile, with state, nonce and the PKCE challenge", () => {
    const url = new URL(googleSignInUrl({ clientId: CLIENT, redirectUri: "https://books.example.nz/api/auth/google/callback", state: "s".repeat(43), nonce: "n".repeat(43), codeChallenge: "c".repeat(43), loginHint: "kim@example.com" }));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("scope")).toBe("openid email profile");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe("s".repeat(43));
    expect(url.searchParams.get("nonce")).toBe("n".repeat(43));
    expect(url.searchParams.get("login_hint")).toBe("kim@example.com");
    // No offline access: Tohyee keeps no Google tokens for signing in.
    expect(url.searchParams.has("access_type")).toBe(false);
    expect(url.searchParams.has("include_granted_scopes")).toBe(false);
  });

  it("only offers return addresses Google accepts", () => {
    expect(redirectOriginProblem("https://books.example.nz")).toBeNull();
    expect(redirectOriginProblem("http://localhost:3000")).toBeNull();
    expect(redirectOriginProblem("http://127.0.0.1:3000")).toBeNull();
    expect(redirectOriginProblem("http://192.168.1.20:3000")).toMatch(/network address/);
    expect(redirectOriginProblem("https://10.0.0.5")).toMatch(/network address/);
    expect(redirectOriginProblem("http://tohyee-server:3000")).toMatch(/home-network name/);
    expect(redirectOriginProblem("https://tohyee.local")).toMatch(/home-network name/);
    expect(redirectOriginProblem("http://books.example.nz")).toMatch(/https/);
    expect(googleRedirectUri("https://books.example.nz/")).toBe("https://books.example.nz/api/auth/google/callback");
  });
});

describe("Sign in with Google: the ID token (#424)", () => {
  it("accepts Google's token and gives the account ID and verified address", () => {
    expect(check(good)()).toEqual({ sub: good.sub, email: "aroha@example.com", name: "Aroha Ngata" });
    expect(check({ ...good, iss: "accounts.google.com", email_verified: "true" })().sub).toBe(good.sub);
    expect(check({ ...good, aud: [CLIENT, "other.apps.googleusercontent.com"] })().sub).toBe(good.sub);
  });

  it("refuses another issuer, another app, or an audience list without azp", () => {
    expect(check({ ...good, iss: "https://accounts.example.com" })).toThrow(/wasn't issued by Google/);
    expect(check({ ...good, aud: "other.apps.googleusercontent.com", azp: undefined })).toThrow(/different Google app/);
    expect(check({ ...good, azp: "other.apps.googleusercontent.com" })).toThrow(/different Google app/);
    expect(check({ ...good, aud: [CLIENT, "other"], azp: undefined })).toThrow(/different Google app/);
  });

  it("refuses an expired or old token, and one from the future", () => {
    expect(check({ ...good, exp: NOW / 1000 - 600 })).toThrow(/expired/);
    expect(check({ ...good, exp: undefined })).toThrow(/expired/);
    expect(check({ ...good, iat: NOW / 1000 - 3600 })).toThrow(/isn't from just now/);
    expect(check({ ...good, iat: NOW / 1000 + 3600 })).toThrow(/isn't from just now/);
  });

  it("refuses a different nonce (a replayed or swapped sign-in)", () => {
    expect(check({ ...good, nonce: "someone-elses-nonce-000" })).toThrow(/doesn't match/);
    expect(check({ ...good, nonce: undefined })).toThrow(/doesn't match/);
  });

  it("needs a verified email and Google's account ID", () => {
    expect(check({ ...good, email_verified: false })).toThrow(/isn't verified/);
    expect(check({ ...good, email_verified: undefined })).toThrow(/isn't verified/);
    expect(check({ ...good, email: undefined })).toThrow(/email address/);
    expect(check({ ...good, sub: undefined })).toThrow(/which account/);
    expect(check({ ...good, sub: "../../x y" })).toThrow(/which account/);
  });

  it("refuses something that isn't a token", () => {
    expect(() => verifyGoogleIdToken(undefined, { clientId: CLIENT, nonce: good.nonce, now: NOW })).toThrow(/didn't send/);
    expect(() => verifyGoogleIdToken("a.b", { clientId: CLIENT, nonce: good.nonce, now: NOW })).toThrow(/expected form/);
    expect(() => verifyGoogleIdToken("e30.bm90LWpzb24.c2ln", { clientId: CLIENT, nonce: good.nonce, now: NOW })).toThrow(/couldn't be read/);
  });
});

describe("Sign in with Google: where people are sent back (#424)", () => {
  it("only goes to Tohyee's own pages after signing in", () => {
    expect(safeNextPath("/operations/invoices")).toBe("/operations/invoices");
    expect(safeNextPath("/server")).toBe("/server");
    expect(safeNextPath("https://evil.example/")).toBe("/operations");
    expect(safeNextPath("//evil.example/operations")).toBe("/operations");
    expect(safeNextPath("/\\evil.example")).toBe("/operations");
    expect(safeNextPath("/operations?x=https://evil.example")).toBe("/operations");
    expect(safeNextPath(undefined)).toBe("/operations");
  });

  it("only shows fixed messages for known codes", () => {
    expect(googleSignInMessage("not_linked")).toMatch(/isn't linked/);
    expect(googleSignInMessage("Call 0800 000 000 now")).toBeNull();
    expect(googleSignInMessage("__proto__")).toBeNull();
    expect(googleSignInMessage("toString")).toBeNull();
    expect(googleSignInMessage(null)).toBeNull();
  });
});
