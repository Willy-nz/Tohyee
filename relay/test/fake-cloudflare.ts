/**
 * A stand-in for the parts of Cloudflare's API the Worker uses, shaped like the
 * examples in Cloudflare's docs. Records every call so tests can check them.
 */
export type Call = { method: string; path: string; body: unknown; auth: string | null };

export class FakeCloudflare {
  calls: Call[] = [];
  tunnels = new Map<string, { name: string; token: string; config: unknown; connected: boolean }>();
  dns = new Map<string, { name: string; content: string; type: string; proxied: boolean }>();
  /** Paths (method + " " + regex source) that should fail with a 500. */
  failing: RegExp[] = [];
  /** When true, cleaning up connections does nothing (so deleting a connected tunnel fails). */
  connectionsStick = false;
  private next = 1;

  fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const method = init?.method ?? "GET";
    const path = url.pathname.replace(/^\/client\/v4/, "");
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const auth = new Headers(init?.headers).get("Authorization");
    this.calls.push({ method, path, body, auth });
    if (url.origin !== "https://api.cloudflare.com") return this.error(400, "wrong host");
    if (this.failing.some((r) => r.test(`${method} ${path}`))) return this.error(500, "simulated failure");

    let m: RegExpExecArray | null;
    if (method === "POST" && /^\/accounts\/acc1\/cfd_tunnel$/.test(path)) {
      const id = `00000000-0000-4000-8000-${String(this.next++).padStart(12, "0")}`;
      const token = `eyJ-token-${id}`;
      this.tunnels.set(id, { name: body.name, token, config: null, connected: false });
      return this.ok({ id, name: body.name, status: "inactive", token, credentials_file: { TunnelID: id } });
    }
    if ((m = /^\/accounts\/acc1\/cfd_tunnel\/([^/]+)\/configurations$/.exec(path)) && method === "PUT") {
      const tunnel = this.tunnels.get(m[1]);
      if (!tunnel) return this.error(404, "no tunnel");
      tunnel.config = body.config;
      return this.ok({ tunnel_id: m[1], config: body.config });
    }
    if ((m = /^\/accounts\/acc1\/cfd_tunnel\/([^/]+)\/token$/.exec(path)) && method === "GET") {
      const tunnel = this.tunnels.get(m[1]);
      return tunnel ? this.ok(tunnel.token) : this.error(404, "no tunnel");
    }
    if ((m = /^\/accounts\/acc1\/cfd_tunnel\/([^/]+)\/connections$/.exec(path)) && method === "DELETE") {
      const tunnel = this.tunnels.get(m[1]);
      if (!tunnel) return this.error(404, "no tunnel");
      if (!this.connectionsStick) tunnel.connected = false;
      return this.ok(null);
    }
    if ((m = /^\/accounts\/acc1\/cfd_tunnel\/([^/]+)$/.exec(path)) && method === "DELETE") {
      const tunnel = this.tunnels.get(m[1]);
      if (!tunnel) return this.error(404, "no tunnel");
      if (tunnel.connected) return this.error(400, "tunnel has active connections");
      this.tunnels.delete(m[1]);
      return this.ok({ id: m[1] });
    }
    if (method === "POST" && path === "/zones/zone1/dns_records") {
      const id = `dns${this.next++}`;
      this.dns.set(id, { name: body.name, content: body.content, type: body.type, proxied: body.proxied });
      return this.ok({ id, ...body });
    }
    if ((m = /^\/zones\/zone1\/dns_records\/([^/]+)$/.exec(path)) && method === "DELETE") {
      if (!this.dns.delete(m[1])) return this.error(404, "no record");
      return this.ok({ id: m[1] });
    }
    return this.error(404, `unexpected ${method} ${path}`);
  };

  private ok(result: unknown): Response {
    return Response.json({ success: true, errors: [], messages: [], result });
  }

  private error(status: number, message: string): Response {
    return Response.json({ success: false, errors: [{ code: 1000 + status, message }], messages: [], result: null }, { status });
  }
}
