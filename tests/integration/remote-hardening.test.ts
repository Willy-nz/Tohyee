import { createHash, randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import * as loginRoute from "@/app/api/auth/login/route";
import * as sessionRoute from "@/app/api/auth/session/route";
import * as resetRoute from "@/app/api/auth/two-step/reset/route";
import { SIGN_IN_TRIES_PER_MINUTE } from "@/lib/auth/rate-limit";
import { cameThroughRemoteAccess } from "@/lib/auth/remote";
import { clientAddress } from "@/lib/auth/sessions";
import { coreQuery } from "@/lib/db/transactions";
import { apiRequest, createTestUser, describeWithDatabase, sessionCookieFor, startTestServer, TEST_PASSWORD, type TestServer } from "../helpers/test-server";

const noContext = undefined as unknown;
const KEY = "remote-hardening-key-0123456789abcdefghij";

async function body(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

/** Issue #208, items 3, 5 and 6 (item 4 is in server-computer-only.test.ts, item 6 in tests/unit/security-headers.test.ts). */
describeWithDatabase("remote access hardening (#208)", () => {
  let server: TestServer;
  const originalKey = process.env.TOHYEE_SECRET_KEY;
  const login = (email: string, headers: Record<string, string> = {}, password = TEST_PASSWORD) =>
    loginRoute.POST(apiRequest("/api/auth/login", { method: "POST", body: { email, password }, headers }), noContext);

  beforeAll(async () => {
    process.env.TOHYEE_SECRET_KEY = KEY;
    server = await startTestServer();
  });

  afterEach(() => {
    process.env.TOHYEE_SECRET_KEY = KEY;
  });

  afterAll(async () => {
    process.env.TOHYEE_SECRET_KEY = originalKey;
    await server?.teardown();
  });

  it("item 3: the address is the one the nearest proxy added, not the first one the visitor typed", () => {
    const at = (forwarded: string | null, realIp?: string) => {
      const headers = new Headers();
      if (forwarded !== null) headers.set("x-forwarded-for", forwarded);
      if (realIp) headers.set("x-real-ip", realIp);
      return clientAddress(headers);
    };
    // Cloudflare appends the visitor's address to whatever they sent.
    expect(at("1.2.3.4, 203.0.113.9")).toBe("203.0.113.9");
    expect(at("203.0.113.9")).toBe("203.0.113.9");
    // A proxy on this computer adding itself is skipped.
    expect(at("203.0.113.9, 127.0.0.1")).toBe("203.0.113.9");
    expect(at("127.0.0.1")).toBe("127.0.0.1");
    expect(at(null, "198.51.100.7")).toBe("198.51.100.7");
    expect(at(null)).toBeNull();
  });

  it("item 3: changing the first X-Forwarded-For entry on every try no longer gets past the per-address limit", async () => {
    let limited = false;
    for (let attempt = 0; attempt <= SIGN_IN_TRIES_PER_MINUTE; attempt += 1) {
      // A different unknown email each time, so only the per-address limit can stop it.
      const response = await login(`nobody-${attempt}@example.com`, { "x-forwarded-for": `10.9.${attempt}.1, 198.51.100.200` });
      if (response.status === 429) {
        limited = true;
        expect((await body(response)).error).toContain("Too many sign-in attempts from this address");
        break;
      }
    }
    expect(limited).toBe(true);
  });

  it("item 3: wrong passwords on an emailed two-step reset link count towards the account's lockout", async () => {
    const user = await createTestUser("reset-lock@example.com");
    const token = randomBytes(24).toString("base64url");
    await coreQuery("insert into two_step_reset_tokens (token_hash, user_id, expires_at) values ($1, $2, now() + interval '1 hour')", [
      createHash("sha256").update(token).digest("hex"),
      user.id,
    ]);
    const reset = (password: string) =>
      resetRoute.POST(apiRequest("/api/auth/two-step/reset", { method: "POST", body: { token, password }, headers: { "x-forwarded-for": "198.51.100.31" } }), noContext);
    for (let attempt = 0; attempt < 5; attempt += 1) expect((await reset("not-the-password")).status).toBe(401);
    // Locked now: even the right password waits, here and at sign-in.
    expect((await reset(TEST_PASSWORD)).status).toBe(429);
    expect((await login("reset-lock@example.com", { "x-forwarded-for": "198.51.100.32" })).status).toBe(429);
  });

  it("item 5: knows a request that came through remote access", () => {
    const remote = (headers: Record<string, string>) => cameThroughRemoteAccess(new Headers(headers));
    expect(remote({ "cf-ray": "8c1f-AKL" })).toBe(true);
    expect(remote({ "cf-connecting-ip": "203.0.113.9" })).toBe(true);
    expect(remote({ host: "tohyee-pc.tail1a2b3c.ts.net" })).toBe(true);
    expect(remote({ "x-forwarded-host": "TOHYEE-PC.tail1a2b3c.ts.net:443" })).toBe(true);
    expect(remote({ host: "192.168.1.20:3000" })).toBe(false);
    expect(remote({ host: "localhost:3000", "x-forwarded-for": "192.168.1.30" })).toBe(false);
  });

  it("item 5: without the secret key (so no two-step), sign-ins and sessions through remote access are refused; on the local network they work", async () => {
    const user = await createTestUser("no-key@example.com", { twoStep: false });
    const cookie = await sessionCookieFor(user);
    delete process.env.TOHYEE_SECRET_KEY;

    const remoteHeaders: Array<Record<string, string>> = [{ "cf-ray": "8c1f-AKL", "x-forwarded-for": "203.0.113.9" }, { "x-forwarded-host": "tohyee-pc.tail1a2b3c.ts.net" }];
    for (const headers of remoteHeaders) {
      const refused = await login("no-key@example.com", headers);
      expect(refused.status).toBe(403);
      expect((await body(refused)).error).toContain("Signing in through remote access needs two-step sign-in");
      const session = await sessionRoute.GET(apiRequest("/api/auth/session", { cookie, headers }), noContext);
      expect(session.status).toBe(403);
    }

    const local = await login("no-key@example.com", { "x-forwarded-for": "192.168.1.30" });
    expect(local.status).toBe(200);
    expect((await body(local)).stage).toBe("full");
    expect((await sessionRoute.GET(apiRequest("/api/auth/session", { cookie }), noContext)).status).toBe(200);

    // With the key back, remote sign-in gets past this check again; this login then needs its setup link (item 2).
    process.env.TOHYEE_SECRET_KEY = KEY;
    const remote = await login("no-key@example.com", { "cf-ray": "8c1f-AKL", "x-forwarded-for": "203.0.113.10" });
    expect(remote.status).toBe(403);
    expect((await body(remote)).error).toContain("hasn't been set up yet");
  });
});
