import { expect } from "vitest";
import * as callbackRoute from "@/app/api/auth/google/callback/route";
import * as startRoute from "@/app/api/auth/google/start/route";
import { pkceChallenge } from "@/lib/auth/google-oidc";
import { apiRequest } from "./test-server";

/*
 * A made-up Google for Sign in with Google tests (#424): the token endpoint
 * only, plus the browser's trip through Tohyee's start and callback routes.
 * Install it with setMailFetchForTests(fakeGoogle).
 */

export const noContext = undefined as unknown;
export const CLIENT = "made-up-signin.apps.googleusercontent.com";
export const SECRET = "made-up-google-secret";
export const ORIGIN = "https://tohyee.test";

/** Requests as a browser reaching Tohyee on its https web address. */
export function req(path: string, options: Parameters<typeof apiRequest>[1] = {}): Request {
  return apiRequest(path, { ...options, headers: { "x-forwarded-proto": "https", ...(options.headers ?? {}) } });
}

export async function body(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

export function cookiePart(response: Response, name: string): string {
  return response.headers.getSetCookie().find((cookie) => cookie.startsWith(`${name}=`))?.split(";")[0] ?? "";
}

// ---------------------------------------------------------------------------
// A made-up Google: the token endpoint only. Every call is checked as Google
// would: the one-time code, the client and secret, the redirect URI, and the
// PKCE verifier against the challenge the sign-in address carried.

type Issued = { claims: Record<string, unknown>; challenge: string; redirectUri: string };
const issued = new Map<string, Issued>();
export const tokenCalls: URLSearchParams[] = [];

function idToken(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "RS256", kid: "made-up" })}.${part(claims)}.${Buffer.from("made-up-signature").toString("base64url")}`;
}

/** Google signs someone in on the address Tohyee sent them to, and hands back `code`. */
export function googleSignsIn(startUrl: string, code: string, account: { sub: string; email: string; email_verified?: unknown; [claim: string]: unknown }) {
  const url = new URL(startUrl);
  const now = Math.floor(Date.now() / 1000);
  issued.set(code, {
    claims: { iss: "https://accounts.google.com", aud: CLIENT, azp: CLIENT, nonce: url.searchParams.get("nonce"), iat: now, exp: now + 3600, email_verified: true, ...account },
    challenge: url.searchParams.get("code_challenge") ?? "",
    redirectUri: url.searchParams.get("redirect_uri") ?? "",
  });
}

export async function fakeGoogle(input: string, init?: RequestInit): Promise<Response> {
  const url = new URL(input);
  if (url.host !== "oauth2.googleapis.com" || url.pathname !== "/token") throw new Error(`Unexpected call to ${input}`);
  const form = new URLSearchParams(String(init?.body ?? ""));
  tokenCalls.push(form);
  const entry = issued.get(form.get("code") ?? "");
  const refuse = () => new Response(JSON.stringify({ error: "invalid_grant", error_description: "Bad Request" }), { status: 400 });
  if (!entry) return refuse();
  issued.delete(form.get("code")!);
  if (form.get("grant_type") !== "authorization_code" || form.get("client_id") !== CLIENT || form.get("client_secret") !== SECRET) return refuse();
  if (form.get("redirect_uri") !== entry.redirectUri) return refuse();
  if (pkceChallenge(form.get("code_verifier") ?? "") !== entry.challenge) return refuse();
  return new Response(JSON.stringify({ access_token: "made-up-access", expires_in: 3599, scope: "openid email profile", token_type: "Bearer", id_token: idToken(entry.claims) }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

export async function start(payload: Record<string, unknown>, cookie?: string, headers?: Record<string, string>) {
  const response = await startRoute.POST(req("/api/auth/google/start", { method: "POST", body: payload, cookie, headers }), noContext);
  return { response, url: response.ok ? String((await body(response)).url) : "", browser: cookiePart(response, "tohyee_google_signin") };
}

export async function callback(query: Record<string, string>, cookie: string) {
  const response = await callbackRoute.GET(req(`/api/auth/google/callback?${new URLSearchParams(query)}`, { cookie }));
  expect(response.status).toBe(303);
  return { location: response.headers.get("location") ?? "", session: cookiePart(response, "tohyee_session"), cookies: response.headers.getSetCookie() };
}

let codeCounter = 0;
/** The whole trip: start, Google signs `account` in, and back. */
export async function viaGoogle(payload: Record<string, unknown>, account: { sub: string; email: string; [claim: string]: unknown }, cookie = "") {
  const started = await start(payload, cookie || undefined);
  expect(started.response.status).toBe(200);
  const code = `code-${++codeCounter}`;
  googleSignsIn(started.url, code, account);
  const state = new URL(started.url).searchParams.get("state")!;
  return callback({ state, code }, [started.browser, cookie].filter(Boolean).join("; "));
}
