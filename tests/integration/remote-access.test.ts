import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as remoteRoute from "@/app/api/admin/remote-access/route";
import { publicOrigin } from "@/lib/auth/origin";
import { assertSameOrigin } from "@/lib/auth/guard";
import { sessionCookieHeader } from "@/lib/auth/sessions";
import { parseTunnelToken } from "@/lib/remote/settings";
import { setTunnelCommandForTests, stopTunnel } from "@/lib/remote/tunnel";
import { coreQuery } from "@/lib/db/transactions";
import { apiRequest, createTestUser, describeWithDatabase, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

const noContext = undefined as unknown;
const fake = path.join(process.cwd(), "tests", "fixtures", "fake-cloudflared.mjs");

function token(secret: string): string {
  const json = JSON.stringify({ a: "0123456789abcdef0123456789abcdef", t: "11111111-2222-3333-4444-555555555555", s: secret });
  return Buffer.from(json).toString("base64");
}

async function body(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

describeWithDatabase("remote access through a Cloudflare Tunnel", () => {
  let server: TestServer;
  const originalKey = process.env.TOHYEE_SECRET_KEY;
  let adminCookie = "";
  let bookkeeperCookie = "";

  const put = (cookie: string, payload: unknown) =>
    remoteRoute.PUT(apiRequest("/api/admin/remote-access", { method: "PUT", cookie, body: payload }), noContext);
  const read = async () =>
    (await body(await remoteRoute.GET(apiRequest("/api/admin/remote-access", { cookie: adminCookie }), noContext))).remoteAccess as {
      enabled: boolean;
      hasToken: boolean;
      tunnelId: string | null;
      publicUrl: string | null;
      method: string;
      tunnel: { status: string; message: string | null; log: string[] };
    };

  beforeAll(async () => {
    server = await startTestServer();
    setTunnelCommandForTests({ program: process.execPath, prefix: [fake] });
    adminCookie = await sessionCookieFor(await createTestUser("admin@example.com", { serverAdmin: true }));
    bookkeeperCookie = await sessionCookieFor(await createTestUser("kim@example.com"));
  });

  afterAll(async () => {
    stopTunnel();
    setTunnelCommandForTests(null);
    process.env.TOHYEE_SECRET_KEY = originalKey;
    await server?.teardown();
  });

  it("reads the token out of Cloudflare's install command", () => {
    const pasted = `cloudflared.exe service install ${token("c2VjcmV0")}`;
    expect(parseTunnelToken(pasted)).toEqual({ token: token("c2VjcmV0"), tunnelId: "11111111-2222-3333-4444-555555555555" });
    expect(() => parseTunnelToken("hello")).toThrow(/doesn't look like a Cloudflare Tunnel token/);
    expect(() => parseTunnelToken(`eyJ${"A".repeat(60)}`)).toThrow(/incomplete/);
  });

  it("can't be turned on without TOHYEE_SECRET_KEY (so two-step sign-in is in force), and only by server admins", async () => {
    delete process.env.TOHYEE_SECRET_KEY;
    const refused = await put(adminCookie, { enabled: true, tunnelToken: token("c2VjcmV0") });
    expect(refused.status).toBe(503);
    process.env.TOHYEE_SECRET_KEY = "remote-access-test-key-0123456789abcdef";
    expect((await put(bookkeeperCookie, { enabled: true, tunnelToken: token("c2VjcmV0") })).status).toBe(403);
    expect((await put(adminCookie, { enabled: true, publicUrl: "http://books.example.nz" })).status).toBe(400);
  });

  it("runs the connector, reports it connected, keeps the token secret and restarts with a new one", async () => {
    const saved = await put(adminCookie, { enabled: true, tunnelToken: `  ${token("c2VjcmV0")} `, publicUrl: "books.example.nz" });
    expect(saved.status).toBe(200);
    expect(JSON.stringify(await body(saved))).not.toContain(token("c2VjcmV0"));
    await vi.waitFor(async () => expect((await read()).tunnel.status).toBe("connected"), { timeout: 5000, interval: 100 });
    const state = await read();
    expect(state).toMatchObject({ enabled: true, hasToken: true, publicUrl: "https://books.example.nz", tunnelId: "11111111-2222-3333-4444-555555555555" });
    expect(state.tunnel.log.some((line) => line.includes("Registered tunnel connection"))).toBe(true);
    const stored = await coreQuery<{ secret_ciphertext: string }>("select secret_ciphertext from server_settings where key = 'remote_access'");
    expect(stored.rows[0].secret_ciphertext).not.toContain("eyJ");
    // Emailed links use the public address, not whatever Host a request claims.
    expect(await publicOrigin(apiRequest("/x", { origin: "https://evil.example" }))).toBe("https://books.example.nz");

    // A token Cloudflare refuses shows why.
    await put(adminCookie, { enabled: true, tunnelToken: token("YmFkYmFkYmFk") });
    await vi.waitFor(async () => expect((await read()).tunnel.message).toMatch(/Cloudflare refused the tunnel: .*Unauthorized/), {
      timeout: 5000,
      interval: 100,
    });
  });

  it("turning it off stops the connector; removing it forgets the token", async () => {
    await put(adminCookie, { enabled: false });
    expect((await read()).tunnel.status).toBe("off");
    const cleared = await put(adminCookie, { clear: true });
    expect(cleared.status).toBe(200);
    expect(await read()).toMatchObject({ enabled: false, hasToken: false, publicUrl: null });
  });

  describe("the easy way: Tailscale Funnel (set up by the Windows server app)", () => {
    const address = "https://tohyee-pc.tail1a2b3c.ts.net";

    /** What Tailscale Funnel sends on to 127.0.0.1:<port> (ipn/ipnlocal/serve.go keeps Host and adds X-Forwarded-*). */
    function throughFunnel(path: string, init: { method?: string; origin?: string } = {}): Request {
      const headers: Record<string, string> = {
        host: "tohyee-pc.tail1a2b3c.ts.net",
        "x-forwarded-host": "tohyee-pc.tail1a2b3c.ts.net",
        "x-forwarded-proto": "https",
        "x-forwarded-for": "203.0.113.9",
      };
      if (init.origin) headers.origin = init.origin;
      return new Request(`http://127.0.0.1:3000${path}`, { method: init.method ?? "GET", headers });
    }

    it("needs two-step sign-in in force and a ts.net address, but no Cloudflare token", async () => {
      delete process.env.TOHYEE_SECRET_KEY;
      expect((await put(adminCookie, { method: "tailscale", enabled: true, publicUrl: address })).status).toBe(503);
      process.env.TOHYEE_SECRET_KEY = "remote-access-test-key-0123456789abcdef";
      expect((await put(bookkeeperCookie, { method: "tailscale", enabled: true, publicUrl: address })).status).toBe(403);
      expect((await put(adminCookie, { method: "tailscale", enabled: true, publicUrl: "https://books.example.nz" })).status).toBe(400);
      expect((await put(adminCookie, { method: "tailscale", enabled: true })).status).toBe(400);
      expect((await put(adminCookie, { method: "carrier-pigeon", enabled: true, publicUrl: address })).status).toBe(400);

      const saved = await put(adminCookie, { method: "tailscale", enabled: true, publicUrl: address });
      expect(saved.status).toBe(200);
      expect(await read()).toMatchObject({ method: "tailscale", enabled: true, publicUrl: address, hasToken: false });
      // Emailed links use the Funnel address.
      expect(await publicOrigin(apiRequest("/x", { origin: "https://evil.example" }))).toBe(address);
    });

    it("doesn't run the Cloudflare connector, and keeps a saved token for switching back", async () => {
      await put(adminCookie, { enabled: true, tunnelToken: token("c2VjcmV0"), publicUrl: "books.example.nz" });
      await vi.waitFor(async () => expect((await read()).tunnel.status).toBe("connected"), { timeout: 5000, interval: 100 });
      await put(adminCookie, { method: "tailscale", enabled: true, publicUrl: address });
      const state = await read();
      expect(state).toMatchObject({ method: "tailscale", enabled: true, hasToken: true, publicUrl: address });
      expect(state.tunnel.status).toBe("off");
      // Saving the Cloudflare form (no method) switches back and restarts the connector.
      await put(adminCookie, { enabled: true, publicUrl: "books.example.nz" });
      await vi.waitFor(async () => expect((await read()).tunnel.status).toBe("connected"), { timeout: 5000, interval: 100 });
      expect((await read()).method).toBe("cloudflare");
      // Turning phone access off forgets the Funnel address.
      await put(adminCookie, { method: "tailscale", enabled: false, publicUrl: "" });
      expect(await read()).toMatchObject({ method: "tailscale", enabled: false, publicUrl: null });
      expect((await read()).tunnel.status).toBe("off");
      await put(adminCookie, { clear: true });
    });

    it("accepts sign-ins arriving through Funnel on the ts.net address over https", () => {
      expect(() => assertSameOrigin(throughFunnel("/api/auth/login", { method: "POST", origin: address }))).not.toThrow();
      expect(() => assertSameOrigin(throughFunnel("/api/auth/login", { method: "POST", origin: "https://evil.example" }))).toThrow(
        /Cross-site/,
      );
      expect(sessionCookieHeader(throughFunnel("/api/auth/login", { method: "POST", origin: address }), "abc")).toMatch(/; Secure$/);
    });

    it("never lets server settings through Funnel (it connects to the main port, without the local-only secret)", async () => {
      const request = throughFunnel("/api/admin/remote-access");
      request.headers.set("cookie", adminCookie);
      expect((await remoteRoute.GET(request, noContext)).status).toBe(403);
    });
  });
});
