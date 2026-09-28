import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import * as organisationsRoute from "@/app/api/admin/organisations/route";
import * as usersRoute from "@/app/api/admin/users/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { startLocalAdminListener, stopLocalAdminListener } from "@/lib/server-admin/listener";
import { LOCAL_ADMIN_HEADER, localAdminPort, localAdminSecret, localAdminUrl } from "@/lib/server-admin/local";
import {
  apiRequest,
  createTestUser,
  describeWithDatabase,
  sessionCookieFor,
  startTestServer,
  type TestServer,
} from "../helpers/test-server";

const noContext = undefined as unknown;

async function body(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });
}

function get(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, headers }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => (text += chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: text }));
    });
    req.on("error", reject);
    req.end();
  });
}

/**
 * Server settings (organisations, users, remote access, email, updates) work
 * only on the server computer itself, through the local-only address.
 */
describeWithDatabase("server settings: the server computer only", () => {
  let server: TestServer;
  let admin: SessionUser;
  let adminCookie = "";
  const env = { PORT: process.env.PORT, TOHYEE_ADMIN_PORT: process.env.TOHYEE_ADMIN_PORT, HOSTNAME: process.env.HOSTNAME };

  beforeAll(async () => {
    server = await startTestServer();
    admin = await createTestUser("local-admin@example.com", { serverAdmin: true });
    adminCookie = await sessionCookieFor(admin);
  });

  afterEach(() => {
    stopLocalAdminListener();
    for (const [name, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("refuses a server admin's request that didn't come through the local address", async () => {
    const remote = await usersRoute.GET(apiRequest("/api/admin/users", { cookie: adminCookie, local: false }), noContext);
    expect(remote.status).toBe(403);
    expect((await body(remote)).error).toMatch(/only be changed on the server computer itself/);

    const forged = new Request("http://tohyee.test/api/admin/users", {
      headers: { cookie: adminCookie, [LOCAL_ADMIN_HEADER]: "0".repeat(64) },
    });
    expect((await usersRoute.GET(forged, noContext)).status).toBe(403);

    const creating = await organisationsRoute.POST(
      apiRequest("/api/admin/organisations", {
        method: "POST",
        cookie: adminCookie,
        local: false,
        body: { id: "not-here", displayName: "Not Here", baseCurrency: "NZD", ownerEmail: admin.email },
      }),
      noContext,
    );
    expect(creating.status).toBe(403);

    const local = await usersRoute.GET(apiRequest("/api/admin/users", { cookie: adminCookie }), noContext);
    expect(local.status).toBe(200);
  });

  it("the local address listens on 127.0.0.1 and marks what it passes on, replacing any forged marker", async () => {
    const seen: Array<Record<string, string | string[] | undefined>> = [];
    const main: Server = createServer((request, response) => {
      seen.push(request.headers);
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(`main saw ${request.url}`);
    });
    await new Promise<void>((resolve) => main.listen(0, "127.0.0.1", resolve));
    const mainPort = (main.address() as AddressInfo).port;
    const adminPort = await freePort();
    process.env.PORT = String(mainPort);
    process.env.TOHYEE_ADMIN_PORT = String(adminPort);
    delete process.env.HOSTNAME;
    try {
      startLocalAdminListener();
      let reply = { status: 0, body: "" };
      for (let attempt = 0; attempt < 50; attempt += 1) {
        try {
          reply = await get(adminPort, "/server/users?x=1", {
            [LOCAL_ADMIN_HEADER]: "forged",
            "x-forwarded-host": "evil.example",
            "cf-connecting-ip": "203.0.113.9",
          });
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      expect(reply).toEqual({ status: 200, body: "main saw /server/users?x=1" });
      expect(seen[0][LOCAL_ADMIN_HEADER]).toBe(localAdminSecret());
      expect(seen[0]["x-forwarded-host"]).toBeUndefined();
      expect(seen[0]["cf-connecting-ip"]).toBeUndefined();
      expect(seen[0].host).toBe(`127.0.0.1:${adminPort}`);
    } finally {
      await new Promise<void>((resolve) => main.close(() => resolve()));
    }
  });

  it("the local address is the main port + 1 unless TOHYEE_ADMIN_PORT says otherwise, and can be turned off", () => {
    process.env.PORT = "3000";
    delete process.env.TOHYEE_ADMIN_PORT;
    expect(localAdminPort()).toBe(3001);
    expect(localAdminUrl()).toBe("http://127.0.0.1:3001/server");
    process.env.TOHYEE_ADMIN_PORT = "4555";
    expect(localAdminPort()).toBe(4555);
    process.env.TOHYEE_ADMIN_PORT = "off";
    expect(localAdminPort()).toBeNull();
    expect(localAdminUrl()).toBeNull();
    process.env.TOHYEE_ADMIN_PORT = "not-a-port";
    expect(localAdminPort()).toBeNull();
  });
});
