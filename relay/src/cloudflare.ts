/**
 * The few Cloudflare API calls the Worker makes, with Jess's API token.
 * `fetch` is passed in so tests can stand in for Cloudflare.
 *
 * Endpoints are from Cloudflare's "Create a tunnel (API)" guide and API reference:
 * https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel-api/
 */
export const API_BASE = "https://api.cloudflare.com/client/v4";

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export class CloudflareError extends Error {
  constructor(
    readonly action: string,
    readonly status: number,
    readonly codes: number[],
  ) {
    super(`Cloudflare API: ${action} failed (HTTP ${status}${codes.length ? `, codes ${codes.join(",")}` : ""})`);
  }
}

type Envelope<T> = { success?: boolean; errors?: { code?: number; message?: string }[]; result?: T };

export class CloudflareApi {
  constructor(
    private readonly token: string,
    private readonly accountId: string,
    private readonly zoneId: string,
    private readonly fetchImpl: Fetch,
  ) {}

  private async call<T>(action: string, method: string, path: string, body?: unknown, okIfMissing = false): Promise<T | null> {
    const response = await this.fetchImpl(`${API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (okIfMissing && response.status === 404) return null;
    let parsed: Envelope<T> = {};
    try {
      parsed = (await response.json()) as Envelope<T>;
    } catch {
      // Not JSON; treat as a failure below.
    }
    if (!response.ok || parsed.success === false) {
      const codes = (parsed.errors ?? []).map((e) => e.code).filter((c): c is number => typeof c === "number");
      throw new CloudflareError(action, response.status, codes);
    }
    return (parsed.result ?? null) as T | null;
  }

  private account(path: string): string {
    return `/accounts/${encodeURIComponent(this.accountId)}${path}`;
  }

  /** POST /accounts/{account_id}/cfd_tunnel with config_src "cloudflare" (a remotely-managed tunnel). */
  async createTunnel(name: string): Promise<{ id: string; token: string }> {
    const result = await this.call<{ id?: string; token?: string }>("create tunnel", "POST", this.account("/cfd_tunnel"), {
      name,
      config_src: "cloudflare",
    });
    if (!result?.id || !result.token) throw new CloudflareError("create tunnel (no id or token returned)", 200, []);
    return { id: result.id, token: result.token };
  }

  /**
   * PUT /accounts/{account_id}/cfd_tunnel/{tunnel_id}/configurations.
   * The service is always http://localhost:<port>; nothing from the request
   * except the (checked) port number goes into it. Anything else gets a 404.
   */
  async setIngress(tunnelId: string, hostname: string, port: number): Promise<void> {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Port out of range");
    await this.call("set tunnel ingress", "PUT", this.account(`/cfd_tunnel/${encodeURIComponent(tunnelId)}/configurations`), {
      config: {
        ingress: [
          { hostname, service: `http://localhost:${port}`, originRequest: {} },
          { service: "http_status:404" },
        ],
      },
    });
  }

  /** POST /zones/{zone_id}/dns_records: a proxied CNAME to <tunnel id>.cfargotunnel.com. */
  async createDnsRecord(hostname: string, tunnelId: string): Promise<string> {
    const result = await this.call<{ id?: string }>("create DNS record", "POST", `/zones/${encodeURIComponent(this.zoneId)}/dns_records`, {
      type: "CNAME",
      proxied: true,
      name: hostname,
      content: `${tunnelId}.cfargotunnel.com`,
    });
    if (!result?.id) throw new CloudflareError("create DNS record (no id returned)", 200, []);
    return result.id;
  }

  /** DELETE /zones/{zone_id}/dns_records/{dns_record_id}. Already gone counts as done. */
  async deleteDnsRecord(recordId: string): Promise<void> {
    await this.call("delete DNS record", "DELETE", `/zones/${encodeURIComponent(this.zoneId)}/dns_records/${encodeURIComponent(recordId)}`, undefined, true);
  }

  /**
   * GET /accounts/{account_id}/cfd_tunnel/{tunnel_id}/token.
   * The guide names this path; Cloudflare's own cloudflared client
   * (cfapi/tunnel.go, GetTunnelToken) reads `result` as the token string.
   */
  async getTunnelToken(tunnelId: string): Promise<string> {
    const result = await this.call<unknown>("get tunnel token", "GET", this.account(`/cfd_tunnel/${encodeURIComponent(tunnelId)}/token`));
    if (typeof result !== "string" || !result) throw new CloudflareError("get tunnel token (no token returned)", 200, []);
    return result;
  }

  /**
   * Disconnects any running connectors so the tunnel can be deleted
   * (Cloudflare refuses to delete a tunnel with active connections).
   * TO VERIFY: the public API reference only shows DELETE .../connections/{connection_id}.
   * This calls DELETE .../connections (all of them), which is what Cloudflare's own
   * cloudflared client does (cfapi/tunnel.go, CleanupConnections). If it stops
   * working, releases still succeed: the daily clean-up retries the tunnel.
   */
  async cleanUpConnections(tunnelId: string): Promise<void> {
    await this.call("clean up tunnel connections", "DELETE", this.account(`/cfd_tunnel/${encodeURIComponent(tunnelId)}/connections`), undefined, true);
  }

  /** DELETE /accounts/{account_id}/cfd_tunnel/{tunnel_id}. Already gone counts as done. */
  async deleteTunnel(tunnelId: string): Promise<void> {
    await this.call("delete tunnel", "DELETE", this.account(`/cfd_tunnel/${encodeURIComponent(tunnelId)}`), undefined, true);
  }
}
