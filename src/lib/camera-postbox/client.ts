import { createWriteStream } from "node:fs";
import http from "node:http";
import type { Duplex } from "node:stream";
import { pipeline } from "node:stream/promises";
import tls from "node:tls";
import { LIMITS, normaliseFingerprint } from "@/lib/camera-postbox/protocol";

/*
 * Tohyee calling its camera post box (decisions 1228-1229). Every call goes
 * out from Tohyee over HTTPS; nothing at home is opened.
 *
 * The post box usually has its own certificate (no domain needed). Tohyee
 * pins it: the pairing code carries its SHA-256, and every connection
 * checks the certificate before a byte is sent, so a token never goes to a
 * server pretending to be the post box. A different certificate is
 * refused with CertificateChangedError, loudly, until it's paired again.
 * With a domain name and a proper certificate ("public"), the certificate
 * is checked the normal way instead, so renewing it doesn't break anything.
 */

export type BoxTarget = { address: string; port: number; tlsMode: "pinned" | "public"; fingerprint: string | null; token: string | null };

export class CertificateChangedError extends Error {
  constructor(readonly seen: string) {
    super("The post box's security certificate isn't the one Tohyee paired with. Tohyee stopped talking to it.");
  }
}

export class BoxError extends Error {
  constructor(
    message: string,
    readonly kind: "unreachable" | "token_refused" | "box_error",
    readonly status: number | null = null,
  ) {
    super(message);
  }
}

const TIMEOUT_MS = 15_000;
const DOWNLOAD_IDLE_MS = 60_000;

/** A connection to the post box that checks its certificate (pinned or by name) before anything is written. For `http.request`'s createConnection. */
export function connector(target: BoxTarget) {
  return (_options: unknown, done: (error: Error | null, socket?: Duplex) => void) => {
    const socket = tls.connect({
      host: target.address,
      port: target.port,
      servername: /^\d+(\.\d+){3}$/.test(target.address) ? undefined : target.address,
      minVersion: "TLSv1.2",
      // Pinned: the fingerprint is checked below instead of a certificate authority.
      rejectUnauthorized: target.tlsMode === "public",
      ALPNProtocols: ["http/1.1"],
    });
    let settled = false;
    const settle = (error: Error | null) => {
      if (settled) return;
      settled = true;
      if (error) {
        socket.destroy();
        done(error);
      } else done(null, socket);
    };
    socket.setTimeout(TIMEOUT_MS, () => settle(new BoxError(`The post box at ${target.address} didn't answer.`, "unreachable")));
    socket.once("error", (error) => settle(new BoxError(`Couldn't reach the post box at ${target.address}:${target.port} (${(error as NodeJS.ErrnoException).code ?? error.message}).`, "unreachable")));
    socket.once("secureConnect", () => {
      socket.setTimeout(0);
      if (target.tlsMode === "pinned") {
        const seen = normaliseFingerprint(socket.getPeerCertificate().raw ?? Buffer.alloc(0));
        if (!target.fingerprint || seen !== target.fingerprint) return settle(new CertificateChangedError(seen));
      }
      settle(null);
    });
  };
}

type Call = { method: "GET" | "POST" | "PUT"; path: string; body?: unknown; auth?: boolean };

function send(target: BoxTarget, call: Call): Promise<http.IncomingMessage> {
  const body = call.body === undefined ? null : Buffer.from(JSON.stringify(call.body), "utf8");
  if (body && body.length > LIMITS.maxJsonBytes) return Promise.reject(new BoxError("Too much to send to the post box.", "box_error"));
  const headers: Record<string, string> = { accept: "application/json" };
  if (body) {
    headers["content-type"] = "application/json";
    headers["content-length"] = String(body.length);
  }
  if (call.auth !== false) {
    if (!target.token) return Promise.reject(new BoxError("Tohyee isn't paired with a post box.", "token_refused"));
    headers.authorization = `Bearer ${target.token}`;
  }
  return new Promise((resolve, reject) => {
    const request = http.request({ method: call.method, path: call.path, host: target.address, port: target.port, headers, createConnection: connector(target) as never }, resolve);
    request.setTimeout(TIMEOUT_MS, () => request.destroy(new BoxError(`The post box at ${target.address} didn't answer in time.`, "unreachable")));
    request.on("error", reject);
    request.end(body ?? undefined);
  });
}

async function readJson(response: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response) {
    size += (chunk as Buffer).length;
    if (size > LIMITS.maxJsonBytes) {
      response.destroy();
      throw new BoxError("The post box sent too much.", "box_error");
    }
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new BoxError("The post box's answer wasn't readable. Is that address a Tohyee post box?", "box_error", response.statusCode ?? null);
  }
}

/** A JSON call. Errors from the post box become BoxError with its message. */
export async function callBox<T = Record<string, unknown>>(target: BoxTarget, call: Call): Promise<T> {
  const response = await send(target, call);
  const json = await readJson(response);
  const status = response.statusCode ?? 0;
  if (status >= 200 && status < 300) return json as T;
  const message = typeof json.error === "string" ? json.error.slice(0, 300) : `The post box answered ${status}.`;
  throw new BoxError(message, status === 401 ? "token_refused" : "box_error", status);
}

/** Downloads one queued file to `target`, refusing anything bigger than expected. */
export async function downloadFromBox(box: BoxTarget, id: string, expectedBytes: number, targetPath: string): Promise<void> {
  const response = await send(box, { method: "GET", path: `/v1/files/${encodeURIComponent(id)}` });
  if (response.statusCode !== 200) {
    const json = await readJson(response).catch(() => ({}) as Record<string, unknown>);
    throw new BoxError(typeof json.error === "string" ? json.error : `The post box answered ${response.statusCode}.`, response.statusCode === 401 ? "token_refused" : "box_error", response.statusCode ?? null);
  }
  if (Number(response.headers["content-length"]) !== expectedBytes) {
    response.destroy();
    throw new BoxError("The file from the post box isn't the size it said.", "box_error");
  }
  let size = 0;
  response.setTimeout(DOWNLOAD_IDLE_MS, () => response.destroy(new BoxError("The download from the post box stalled.", "unreachable")));
  response.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > expectedBytes) response.destroy(new BoxError("The file from the post box is bigger than it said.", "box_error"));
  });
  await pipeline(response, createWriteStream(targetPath, { flags: "wx", mode: 0o600 }));
  if (size !== expectedBytes) throw new BoxError("The download from the post box stopped before the end.", "unreachable");
}
