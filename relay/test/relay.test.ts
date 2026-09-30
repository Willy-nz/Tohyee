import { env as workerEnv } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/config";
import { cleanUp, handle } from "../src/handler";
import { isLabel, LABEL_ALPHABET, randomLabel, sha256Hex } from "../src/secrets";
import { FakeCloudflare } from "./fake-cloudflare";

const ADMIN = "admin-password-that-is-long-enough";
const baseEnv = workerEnv as unknown as Env;

let cf: FakeCloudflare;
let env: Env;
let now: Date;

function deps() {
  return { fetch: cf.fetch, now: () => now };
}

function call(method: string, path: string, options: { body?: unknown; auth?: string; ip?: string } = {}) {
  const headers: Record<string, string> = { "CF-Connecting-IP": options.ip ?? "203.0.113.5" };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.auth) headers.Authorization = `Bearer ${options.auth}`;
  const request = new Request(`https://api.tohyee.example${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : typeof options.body === "string" ? options.body : JSON.stringify(options.body),
  });
  return handle(request, env, deps());
}

function register(installId = "install-aaaaaaaaaaaaaaaa", port = 3000, ip?: string) {
  return call("POST", "/v1/addresses", { body: { port, installId, version: "0.2.2" }, ip });
}

beforeEach(async () => {
  await baseEnv.DB.batch([
    baseEnv.DB.prepare("DELETE FROM addresses"),
    baseEnv.DB.prepare("DELETE FROM counters"),
    baseEnv.DB.prepare("UPDATE settings SET value = '1' WHERE key = 'registrations_open'"),
  ]);
  cf = new FakeCloudflare();
  now = new Date("2026-10-01T01:00:00Z");
  env = {
    ...baseEnv,
    DOMAIN: "tohyee.example",
    ACCOUNT_ID: "acc1",
    ZONE_ID: "zone1",
    ABUSE_CONTACT: "abuse@tohyee.example",
    CF_API_TOKEN: "cf-token-secret",
    ADMIN_TOKEN: ADMIN,
    NEW_PER_IP_PER_DAY: "3",
    REQUESTS_PER_IP_PER_DAY: "30",
    NEW_PER_DAY: "100",
    MAX_ACTIVE: "900",
  };
});

describe("names", () => {
  it("are 7 random characters without vowels or confusable characters", () => {
    for (let i = 0; i < 200; i++) {
      const label = randomLabel();
      expect(label).toHaveLength(7);
      expect(isLabel(label)).toBe(true);
      expect(label).not.toMatch(/[aeiouy01l]/);
    }
    expect(LABEL_ALPHABET).not.toMatch(/[aeiouy01l]/);
  });
});

describe("GET /v1/health", () => {
  it("says ok and shows the abuse contact", async () => {
    const response = await call("GET", "/v1/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, registrationsOpen: true, abuseContact: "abuse@tohyee.example" });
  });
});

describe("POST /v1/addresses", () => {
  it("creates a tunnel, points it at localhost:<port> and adds a DNS record", async () => {
    const response = await register();
    expect(response.status).toBe(201);
    const body = (await response.json()) as { hostname: string; tunnelToken: string; releaseKey: string };
    expect(body.hostname).toMatch(/^[a-z2-9]{7}\.tohyee\.example$/);
    expect(body.releaseKey.length).toBeGreaterThanOrEqual(40);

    const [tunnelId, tunnel] = [...cf.tunnels.entries()][0];
    expect(body.tunnelToken).toBe(tunnel.token);
    expect(tunnel.name).toBe(`tohyee-${body.hostname.split(".")[0]}`);
    expect(tunnel.config).toEqual({
      ingress: [
        { hostname: body.hostname, service: "http://localhost:3000", originRequest: {} },
        { service: "http_status:404" },
      ],
    });
    const created = cf.calls.find((c) => c.method === "POST" && c.path === "/accounts/acc1/cfd_tunnel");
    expect(created?.body).toEqual({ name: tunnel.name, config_src: "cloudflare" });
    expect([...cf.dns.values()]).toEqual([
      { name: body.hostname, type: "CNAME", proxied: true, content: `${tunnelId}.cfargotunnel.com` },
    ]);
    expect(cf.calls.every((c) => c.auth === "Bearer cf-token-secret")).toBe(true);
  });

  it("stores only hashes, never the install ID, release key or tunnel token", async () => {
    const body = (await (await register()).json()) as { hostname: string; tunnelToken: string; releaseKey: string };
    const row = await env.DB.prepare("SELECT * FROM addresses").first<Record<string, unknown>>();
    const stored = JSON.stringify(row);
    expect(stored).not.toContain("install-aaaaaaaaaaaaaaaa");
    expect(stored).not.toContain(body.releaseKey);
    expect(stored).not.toContain(body.tunnelToken);
    expect(row?.release_hash).toBe(await sha256Hex(`release:${body.releaseKey}`));
    const counters = JSON.stringify((await env.DB.prepare("SELECT * FROM counters").all()).results);
    expect(counters).not.toContain("203.0.113.5");
  });

  it("gives the same install the same address with a new release key, and updates the port", async () => {
    const first = (await (await register()).json()) as { hostname: string; releaseKey: string };
    const again = await register("install-aaaaaaaaaaaaaaaa", 4000);
    expect(again.status).toBe(201);
    const second = (await again.json()) as { hostname: string; tunnelToken: string; releaseKey: string };
    expect(second.hostname).toBe(first.hostname);
    expect(second.releaseKey).not.toBe(first.releaseKey);
    const tunnel = [...cf.tunnels.values()][0];
    expect(cf.tunnels.size).toBe(1);
    expect(second.tunnelToken).toBe(tunnel.token);
    expect((tunnel.config as { ingress: { service: string }[] }).ingress[0].service).toBe("http://localhost:4000");

    // The old key no longer works; the new one does.
    expect((await call("DELETE", `/v1/addresses/${first.hostname}`, { auth: first.releaseKey })).status).toBe(401);
    expect((await call("DELETE", `/v1/addresses/${first.hostname}`, { auth: second.releaseKey })).status).toBe(204);
  });

  it.each([
    [{ port: 0, installId: "install-aaaaaaaaaaaaaaaa" }, "port"],
    [{ port: 65536, installId: "install-aaaaaaaaaaaaaaaa" }, "port"],
    [{ port: 3000.5, installId: "install-aaaaaaaaaaaaaaaa" }, "port"],
    [{ port: "3000", installId: "install-aaaaaaaaaaaaaaaa" }, "port"],
    [{ port: 3000, installId: "short" }, "installId"],
    [{ port: 3000, installId: "has spaces in it but long enough" }, "installId"],
    [{ port: 3000, installId: "install-aaaaaaaaaaaaaaaa", version: "<script>" }, "version"],
  ])("rejects bad input %j", async (body, field) => {
    const response = await call("POST", "/v1/addresses", { body });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain(field);
    expect(cf.calls).toHaveLength(0);
  });

  it("rejects a body that isn't JSON", async () => {
    const response = await call("POST", "/v1/addresses", { body: "not json" });
    expect(response.status).toBe(400);
  });

  it("ignores any host sent with the request: the service is always localhost", async () => {
    const response = await call("POST", "/v1/addresses", {
      body: { port: 3000, installId: "install-aaaaaaaaaaaaaaaa", service: "http://evil.example", hostname: "evil.example" },
    });
    expect(response.status).toBe(201);
    const tunnel = [...cf.tunnels.values()][0];
    expect(JSON.stringify(tunnel.config)).not.toContain("evil");
  });

  it("limits new addresses per network per day, with a friendly 429", async () => {
    for (let i = 0; i < 3; i++) expect((await register(`install-${i}-aaaaaaaaaaaaaaaa`)).status).toBe(201);
    const blocked = await register("install-4-aaaaaaaaaaaaaaaa");
    expect(blocked.status).toBe(429);
    expect(((await blocked.json()) as { error: string }).error).toMatch(/try again tomorrow/);
    // Another network is fine, and so is the next day.
    expect((await register("install-5-aaaaaaaaaaaaaaaa", 3000, "198.51.100.7")).status).toBe(201);
    now = new Date("2026-10-02T01:00:00Z");
    expect((await register("install-4-aaaaaaaaaaaaaaaa")).status).toBe(201);
  });

  it("limits all requests per network per day", async () => {
    env.REQUESTS_PER_IP_PER_DAY = "2";
    expect((await register()).status).toBe(201);
    expect((await register()).status).toBe(201);
    expect((await register()).status).toBe(429);
  });

  it("has a daily cap across everyone", async () => {
    env.NEW_PER_DAY = "2";
    expect((await register("install-1-aaaaaaaaaaaaaaaa", 3000, "198.51.100.1")).status).toBe(201);
    expect((await register("install-2-aaaaaaaaaaaaaaaa", 3000, "198.51.100.2")).status).toBe(201);
    const response = await register("install-3-aaaaaaaaaaaaaaaa", 3000, "198.51.100.3");
    expect(response.status).toBe(429);
  });

  it("stops before Cloudflare's tunnel limit", async () => {
    env.MAX_ACTIVE = "1";
    expect((await register("install-1-aaaaaaaaaaaaaaaa")).status).toBe(201);
    const response = await register("install-2-aaaaaaaaaaaaaaaa");
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: string }).error).toContain("abuse@tohyee.example");
  });

  it("says so (503) when the Worker hasn't been set up", async () => {
    env.CF_API_TOKEN = undefined;
    expect((await register()).status).toBe(503);
    expect(cf.calls).toHaveLength(0);
  });

  it("cleans up if Cloudflare fails part way", async () => {
    cf.failing = [/^POST \/zones\/zone1\/dns_records$/];
    const response = await register();
    expect(response.status).toBe(503);
    expect(cf.tunnels.size).toBe(0);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM addresses").first("n")).toBe(0);
    // And the same install can try again.
    cf.failing = [];
    expect((await register()).status).toBe(201);
  });

  it("doesn't log secrets", async () => {
    const logs: string[] = [];
    const capture = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    const log = vi.spyOn(console, "log").mockImplementation(capture);
    const error = vi.spyOn(console, "error").mockImplementation(capture);
    cf.failing = [/cfd_tunnel\/[^/]+\/configurations/];
    await register();
    cf.failing = [];
    const body = (await (await register()).json()) as { hostname: string; tunnelToken: string; releaseKey: string };
    await call("DELETE", `/v1/addresses/${body.hostname}`, { auth: body.releaseKey });
    log.mockRestore();
    error.mockRestore();
    const all = logs.join("\n");
    expect(all).toContain(body.hostname);
    for (const secret of ["install-aaaaaaaaaaaaaaaa", body.releaseKey, body.tunnelToken, "cf-token-secret", "203.0.113.5", ADMIN]) {
      expect(all).not.toContain(secret);
    }
  });
});

describe("DELETE /v1/addresses/<hostname>", () => {
  it("needs the release key", async () => {
    const body = (await (await register()).json()) as { hostname: string };
    expect((await call("DELETE", `/v1/addresses/${body.hostname}`)).status).toBe(401);
    expect((await call("DELETE", `/v1/addresses/${body.hostname}`, { auth: "wrong-key" })).status).toBe(401);
    expect(cf.dns.size).toBe(1);
  });

  it("removes the DNS record and the tunnel", async () => {
    const body = (await (await register()).json()) as { hostname: string; releaseKey: string };
    const response = await call("DELETE", `/v1/addresses/${body.hostname}`, { auth: body.releaseKey });
    expect(response.status).toBe(204);
    expect(cf.dns.size).toBe(0);
    expect(cf.tunnels.size).toBe(0);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM addresses").first("n")).toBe(0);
    expect((await call("DELETE", `/v1/addresses/${body.hostname}`, { auth: body.releaseKey })).status).toBe(404);
  });

  it("404s for names that aren't ours", async () => {
    expect((await call("DELETE", "/v1/addresses/bcdfghj.other.example", { auth: "x" })).status).toBe(404);
    expect((await call("DELETE", "/v1/addresses/bcdfghj.tohyee.example", { auth: "x" })).status).toBe(404);
  });

  it("finishes deleting a still-connected tunnel in the daily clean-up", async () => {
    const body = (await (await register()).json()) as { hostname: string; releaseKey: string };
    const tunnel = [...cf.tunnels.values()][0];
    tunnel.connected = true;
    cf.connectionsStick = true;
    expect((await call("DELETE", `/v1/addresses/${body.hostname}`, { auth: body.releaseKey })).status).toBe(204);
    expect(cf.dns.size).toBe(0);
    expect(cf.tunnels.size).toBe(1);
    // The install can get a fresh address straight away.
    const fresh = (await (await register()).json()) as { hostname: string };
    expect(fresh.hostname).not.toBe(body.hostname);

    cf.connectionsStick = false;
    await cleanUp(env, deps());
    expect(cf.tunnels.size).toBe(1); // only the fresh one
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM addresses").first("n")).toBe(1);
  });
});

describe("kill switch (admin)", () => {
  it("needs the admin password", async () => {
    expect((await call("GET", "/v1/admin/addresses")).status).toBe(401);
    expect((await call("GET", "/v1/admin/addresses", { auth: "wrong" })).status).toBe(401);
    env.ADMIN_TOKEN = undefined;
    expect((await call("GET", "/v1/admin/addresses", { auth: ADMIN })).status).toBe(401);
  });

  it("switches new addresses off and on without affecting existing ones", async () => {
    const existing = (await (await register()).json()) as { hostname: string };
    const off = await call("PUT", "/v1/admin/registrations", { auth: ADMIN, body: { open: false } });
    expect(await off.json()).toEqual({ open: false });
    const refused = await register("install-2-aaaaaaaaaaaaaaaa");
    expect(refused.status).toBe(503);
    expect(((await refused.json()) as { error: string }).error).toMatch(/switched off/);
    expect(((await (await register()).json()) as { hostname: string }).hostname).toBe(existing.hostname);
    expect(((await (await call("GET", "/v1/health")).json()) as { registrationsOpen: boolean }).registrationsOpen).toBe(false);
    await call("PUT", "/v1/admin/registrations", { auth: ADMIN, body: { open: true } });
    expect((await register("install-2-aaaaaaaaaaaaaaaa")).status).toBe(201);
  });

  it("blocks one address so it stops working and can't come back", async () => {
    const body = (await (await register()).json()) as { hostname: string };
    const blocked = await call("POST", `/v1/admin/addresses/${body.hostname}/block`, { auth: ADMIN });
    expect(blocked.status).toBe(200);
    expect(cf.dns.size).toBe(0);
    expect(cf.tunnels.size).toBe(0);
    const again = await register();
    expect(again.status).toBe(403);
    expect(((await again.json()) as { error: string }).error).toContain("abuse@tohyee.example");

    const list = (await (await call("GET", "/v1/admin/addresses", { auth: ADMIN })).json()) as { addresses: { status: string }[] };
    expect(list.addresses.map((a) => a.status)).toEqual(["blocked"]);

    expect((await call("POST", `/v1/admin/addresses/${body.hostname}/unblock`, { auth: ADMIN })).status).toBe(200);
    expect((await register()).status).toBe(201);
  });
});

it("returns JSON 404 for unknown paths", async () => {
  const response = await call("GET", "/nothing");
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: "Not found." });
});
