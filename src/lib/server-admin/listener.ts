import { createServer, request as httpRequest, type Server } from "node:http";
import { isIP } from "node:net";
import { LOCAL_ADMIN_HEADER, localAdminPort, localAdminSecret } from "@/lib/server-admin/local";

/**
 * The local-only address for server settings (see local.ts): listens on
 * 127.0.0.1 and passes requests from this computer on to the main server,
 * marked with the secret header. Anything else claiming that header is
 * stripped first, and requests a proxy or tunnel brought are refused.
 */

const holder = globalThis as typeof globalThis & { __tohyeeLocalAdminServer?: Server };

/** Where the main server can be reached from this computer. */
export function mainServerTarget(): { host: string; port: number } {
  // HOSTNAME is the address Tohyee listens on. Only a specific IP address
  // changes where to connect (containers set HOSTNAME to their own name).
  const listen = process.env.HOSTNAME?.trim() ?? "";
  const host = isIP(listen) && listen !== "0.0.0.0" && listen !== "::" ? listen : "127.0.0.1";
  return { host, port: Number(process.env.PORT?.trim() || "3000") };
}

/** Headers a browser can't be trusted to send to the local address, and the proxy's own marker. */
const DROPPED = new Set([LOCAL_ADMIN_HEADER, "x-forwarded-proto", "x-real-ip"]);

/**
 * Headers only a proxy adds: Cloudflare (its tunnel, your own domain or the
 * Tohyee address) and other reverse proxies. A request carrying one came
 * through remote access, even though it arrives on 127.0.0.1, because a tunnel
 * route can be pointed at this port (in Cloudflare's dashboard, say). Such a
 * request is refused, not passed on (#208 item 4).
 */
const PROXIED = ["cf-ray", "cf-connecting-ip", "cf-visitor", "cdn-loop", "x-forwarded-for", "x-forwarded-host", "forwarded", "tailscale-funnel-request"];

/** The names this computer answers to; a tunnel passes the public name on instead (or Tailscale's *.ts.net). */
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Why a request to the local address is refused, or null when it's from this computer. */
export function notFromThisComputer(headers: Record<string, string | string[] | undefined>): string | null {
  const proxied = PROXIED.find((name) => headers[name] !== undefined);
  if (proxied) return `it came through remote access or another proxy (${proxied})`;
  const host = typeof headers.host === "string" ? headers.host.toLowerCase() : "";
  const name = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
  if (!LOCAL_HOSTS.has(name)) return `it was addressed to ${host || "no host"}, not to this computer`;
  return null;
}

export function startLocalAdminListener(): void {
  const port = localAdminPort();
  if (!port || holder.__tohyeeLocalAdminServer) return;
  const target = mainServerTarget();
  if (target.port === port) {
    console.warn("[tohyee] TOHYEE_ADMIN_PORT is the same as PORT; the server settings address is off.");
    return;
  }
  const secret = localAdminSecret();
  const server = createServer((incoming, outgoing) => {
    const refused = notFromThisComputer(incoming.headers);
    if (refused) {
      outgoing.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      outgoing.end(`Server settings only work on the server computer itself. This request was refused because ${refused}.`);
      incoming.resume();
      return;
    }
    const headers: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (value !== undefined && !DROPPED.has(name.toLowerCase())) headers[name] = value;
    }
    headers[LOCAL_ADMIN_HEADER] = secret;
    const upstream = httpRequest(
      { host: target.host, port: target.port, method: incoming.method, path: incoming.url, headers },
      (response) => {
        outgoing.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(outgoing);
      },
    );
    upstream.on("error", () => {
      if (!outgoing.headersSent) outgoing.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      outgoing.end("Tohyee isn't answering yet. Try again in a moment.");
    });
    incoming.pipe(upstream);
  });
  server.on("error", (error: NodeJS.ErrnoException) => {
    console.warn(
      `[tohyee] The server settings address (127.0.0.1:${port}) couldn't start: ${error.code === "EADDRINUSE" ? "that port is in use; set TOHYEE_ADMIN_PORT to another" : error.message}.`,
    );
    holder.__tohyeeLocalAdminServer = undefined;
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`[tohyee] Server settings: http://127.0.0.1:${port}/server (this computer only).`);
  });
  holder.__tohyeeLocalAdminServer = server;
}

export function stopLocalAdminListener(): void {
  holder.__tohyeeLocalAdminServer?.close();
  holder.__tohyeeLocalAdminServer = undefined;
}
