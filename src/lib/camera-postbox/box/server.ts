import { createReadStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import https from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import { verifyAgainstDummy, verifyPassword } from "@/lib/auth/password";
import type { PostboxConfig } from "@/lib/camera-postbox/box/config";
import { openQueue, type Queue } from "@/lib/camera-postbox/box/queue";
import { type BoxState, currentPairingSecret, ensureCertificate, loadState, paths, saveState, spendPairingSecret } from "@/lib/camera-postbox/box/state";
import { FILE_ID, hashToken, isPublicKey, LIMITS, loginsVersion, parseLogins, POSTBOX_SERVICE, PROTOCOL_VERSION, sameHash } from "@/lib/camera-postbox/protocol";
import { type CameraReceiver, startCameraReceiver } from "@/lib/security-cameras/ftp-receiver";
import packageJson from "../../../../package.json";

/*
 * The camera post box program (decisions 1226-1233). Two parts:
 *
 * - Tohyee's own upload-only FTPS receiver (src/lib/security-cameras/
 *   ftp-receiver.ts: JPEG and MP4 only, size limit, failed-login lockout,
 *   connection limits), checking camera logins against the hashes Tohyee
 *   pushed, and sealing each file to Tohyee's public key into the queue.
 * - A small HTTPS API Tohyee calls: pair, status, push logins, list,
 *   download, and "received" (only then is a file deleted).
 *
 * Every API call but health and pairing needs Tohyee's token; the post box
 * keeps only its SHA-256. Requests are rate limited per address, wrong
 * tokens lock an address out like wrong camera passwords do, and bodies
 * are size limited.
 */

export const POSTBOX_VERSION: string = packageJson.version;

export type Postbox = {
  ftpPort: number;
  apiPort: number;
  close: () => Promise<void>;
  /** For tests and the log: what's happened since it started. */
  counters: { requests: number; authorised: number; refusedAuth: number; uploads: number; duplicates: number; refusedUploads: number; collected: number };
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type Uploader = { username: string; cameraId: string };

function normaliseAddress(address: string | undefined): string {
  if (!address) return "";
  return address.startsWith("::ffff:") ? address.slice(7) : address;
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (!/^application\/json\b/i.test(request.headers["content-type"] ?? "")) throw new HttpError(415, "Send JSON.");
  const declared = Number(request.headers["content-length"] ?? "0");
  if (declared > LIMITS.maxJsonBytes) throw new HttpError(413, "Too big.");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > LIMITS.maxJsonBytes) throw new HttpError(413, "Too big.");
    chunks.push(chunk as Buffer);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw new HttpError(400, "That isn't JSON.");
  }
}

function send(response: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), "cache-control": "no-store" });
  response.end(text);
}

export async function startPostbox(config: PostboxConfig, options: { log?: (message: string) => void; failedLoginDelayMs?: number; requestsPerMinute?: number } = {}): Promise<Postbox> {
  const log = options.log ?? ((message: string) => console.log(`${new Date().toISOString()} ${message}`));
  const files = paths(config.dataDir);
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  await rm(files.incoming, { recursive: true, force: true });
  const tls = await ensureCertificate(config);
  let state: BoxState = await loadState(config.dataDir);
  const queue: Queue = await openQueue(files.queue);
  const counters = { requests: 0, authorised: 0, refusedAuth: 0, uploads: 0, duplicates: 0, refusedUploads: 0, collected: 0 };
  let lowDisk = false;
  const update = async (next: BoxState) => {
    await saveState(config.dataDir, next);
    state = next;
  };

  // Camera uploads --------------------------------------------------------------------------------

  const receiver: CameraReceiver = await startCameraReceiver<Uploader>({
    host: config.host,
    port: config.ftpPort,
    tls,
    allowPlain: false,
    passivePorts: config.passivePorts,
    publicAddress: /^\d+(\.\d+){3}$/.test(config.publicAddress) ? config.publicAddress : null,
    maxFileBytes: config.maxFileBytes,
    incomingFolder: files.incoming,
    failedLoginDelayMs: options.failedLoginDelayMs,
    log,
    authenticate: async (username, password) => {
      const login = state.tokenHash ? state.logins.find((entry) => entry.username === username) : undefined;
      if (!login) {
        await verifyAgainstDummy(password);
        return null;
      }
      return (await verifyPassword(password, login.hash)) ? { username, cameraId: login.cameraId } : null;
    },
    receive: async (uploader, file) => {
      try {
        // The login may have been removed while the camera was connected.
        const login = state.logins.find((entry) => entry.username === uploader.username);
        if (!state.publicKey || !login) {
          counters.refusedUploads += 1;
          return "refused";
        }
        const disk = await queue.disk();
        lowDisk = disk.freeBytes - file.sizeBytes < config.minFreeBytes;
        if (lowDisk) {
          counters.refusedUploads += 1;
          log("Upload refused: the disk is nearly full. Is Tohyee collecting?");
          return "refused";
        }
        const result = await queue.add({ tempPath: file.tempPath, username: uploader.username, cameraId: login.cameraId, fileName: file.name, receivedAt: file.receivedAt, sizeBytes: file.sizeBytes, sha256: file.sha256 }, state.publicKey);
        if (result === "duplicate") counters.duplicates += 1;
        else counters.uploads += 1;
        return result;
      } finally {
        await rm(file.tempPath, { force: true });
      }
    },
  });

  // Tohyee's API ---------------------------------------------------------------------------------

  const failures = new Map<string, { count: number; first: number; blockedUntil: number }>();
  const requests = new Map<string, { count: number; first: number }>();
  const blocked = (address: string) => (failures.get(address)?.blockedUntil ?? 0) > Date.now();
  const failed = async (address: string) => {
    counters.refusedAuth += 1;
    const now = Date.now();
    const entry = failures.get(address);
    const fresh = !entry || now - entry.first > LIMITS.failureWindowMs ? { count: 0, first: now, blockedUntil: 0 } : entry;
    fresh.count += 1;
    if (fresh.count >= LIMITS.maxFailures) fresh.blockedUntil = now + LIMITS.failureWindowMs;
    failures.set(address, fresh);
    if (failures.size > 10_000) failures.delete(failures.keys().next().value!);
    await new Promise((resolve) => setTimeout(resolve, options.failedLoginDelayMs ?? 500));
  };
  const tooMany = (address: string) => {
    const now = Date.now();
    const entry = requests.get(address);
    if (!entry || now - entry.first > 60_000) {
      requests.set(address, { count: 1, first: now });
      if (requests.size > 10_000) requests.delete(requests.keys().next().value!);
      return false;
    }
    entry.count += 1;
    return entry.count > (options.requestsPerMinute ?? LIMITS.requestsPerMinute);
  };
  const authorise = async (request: IncomingMessage, address: string) => {
    const header = request.headers.authorization ?? "";
    const token = /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(header)?.[1];
    if (!state.tokenHash || !token || !sameHash(hashToken(token), state.tokenHash)) {
      await failed(address);
      throw new HttpError(401, state.tokenHash ? "Wrong token." : "This post box isn't paired with Tohyee yet.");
    }
    counters.authorised += 1;
  };

  const ftpInfo = () => ({ address: config.publicName ?? config.publicAddress, port: config.ftpPublicPort, passivePorts: config.passivePorts, ftpsOnly: true, maxFileBytes: config.maxFileBytes });

  async function handle(request: IncomingMessage, response: ServerResponse) {
    const address = normaliseAddress(request.socket.remoteAddress);
    counters.requests += 1;
    if (tooMany(address)) throw new HttpError(429, "Too many requests. Wait a minute.");
    const url = new URL(request.url ?? "/", "https://postbox.invalid");
    const method = request.method ?? "GET";
    const route = url.pathname;

    if (route === "/v1/health" && method === "GET") return send(response, 200, { ok: true, service: POSTBOX_SERVICE, protocol: PROTOCOL_VERSION, paired: state.tokenHash !== null });

    if (blocked(address)) throw new HttpError(429, "Too many wrong tries from this address. Wait 15 minutes.");

    if (route === "/v1/pair" && method === "POST") {
      const body = await readJsonBody(request);
      const expected = await currentPairingSecret(config.dataDir);
      if (typeof body.secret !== "string" || !expected || !sameHash(hashToken(body.secret), expected)) {
        await failed(address);
        throw new HttpError(401, expected ? "That pairing code isn't this post box's current one." : "There's no pairing code waiting, or it's more than a day old. Make a new one on the post box.");
      }
      if (typeof body.tokenHash !== "string" || !/^[0-9a-f]{64}$/.test(body.tokenHash)) throw new HttpError(400, "tokenHash must be a SHA-256.");
      if (!isPublicKey(body.publicKey)) throw new HttpError(400, "publicKey must be an X25519 public key.");
      await update({ tokenHash: body.tokenHash, publicKey: body.publicKey, pairedAt: new Date().toISOString(), logins: [], loginsVersion: loginsVersion([]) });
      await spendPairingSecret(config.dataDir);
      log("Paired with Tohyee.");
      return send(response, 200, { paired: true, version: POSTBOX_VERSION, ftp: ftpInfo() });
    }

    await authorise(request, address);

    if (route === "/v1/status" && method === "GET") {
      return send(response, 200, {
        service: POSTBOX_SERVICE,
        protocol: PROTOCOL_VERSION,
        version: POSTBOX_VERSION,
        pairedAt: state.pairedAt,
        queue: queue.totals(),
        disk: await queue.disk(),
        lowDisk,
        logins: { count: state.logins.length, version: state.loginsVersion },
        ftp: ftpInfo(),
        counters,
      });
    }
    if (route === "/v1/logins" && method === "PUT") {
      const body = await readJsonBody(request);
      let logins;
      try {
        logins = parseLogins(body.logins);
      } catch (error) {
        throw new HttpError(400, error instanceof Error ? error.message : "Those logins can't be used.");
      }
      await update({ ...state, logins, loginsVersion: loginsVersion(logins) });
      log(`Camera logins updated: ${logins.length}.`);
      return send(response, 200, { logins: { count: logins.length, version: state.loginsVersion } });
    }
    if (route === "/v1/unpair" && method === "POST") {
      await update({ tokenHash: null, publicKey: null, pairedAt: null, logins: [], loginsVersion: loginsVersion([]) });
      log("Unpaired by Tohyee. Make a new pairing code to pair again.");
      return send(response, 200, { paired: false });
    }
    if (route === "/v1/files" && method === "GET") {
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), LIMITS.maxList);
      return send(response, 200, { files: queue.list(limit), queue: queue.totals() });
    }
    const fileMatch = /^\/v1\/files\/([^/]+)(\/received)?$/.exec(route);
    if (fileMatch && FILE_ID.test(fileMatch[1])) {
      const file = queue.get(fileMatch[1]);
      if (!fileMatch[2] && method === "GET") {
        if (!file) throw new HttpError(404, "That file isn't waiting.");
        response.writeHead(200, { "content-type": "application/octet-stream", "content-length": file.storedBytes, "cache-control": "no-store" });
        await new Promise<void>((resolve, reject) => {
          const stream = createReadStream(queue.sealedPath(file.id));
          stream.on("error", reject);
          response.on("close", resolve);
          stream.pipe(response);
        });
        return;
      }
      if (fileMatch[2] && method === "POST") {
        const body = await readJsonBody(request);
        if (!file) throw new HttpError(404, "That file isn't waiting (already received?).");
        if (body.sha256 !== file.sha256) throw new HttpError(409, "That isn't the file's SHA-256, so it's kept.");
        await queue.remove(file.id);
        counters.collected += 1;
        return send(response, 200, { deleted: true });
      }
    }
    throw new HttpError(404, "Not found.");
  }

  const api = https.createServer({ key: tls.key, cert: tls.cert, minVersion: "TLSv1.2" }, (request, response) => {
    handle(request, response).catch((error) => {
      if (response.headersSent) return response.destroy();
      if (error instanceof HttpError) return send(response, error.status, { error: error.message });
      log(`API error: ${error instanceof Error ? error.message : error}`);
      send(response, 500, { error: "Something went wrong on the post box." });
    });
  });
  api.headersTimeout = 10_000;
  api.requestTimeout = 30_000;
  api.keepAliveTimeout = 5_000;
  api.maxHeadersCount = 50;
  api.maxConnections = 32;
  api.on("tlsClientError", () => undefined);
  await new Promise<void>((resolve, reject) => {
    api.once("error", reject);
    api.listen(config.apiPort, config.host, () => {
      api.off("error", reject);
      resolve();
    });
  });
  const apiAddress = api.address();

  const sweep = setInterval(() => {
    queue
      .expire(new Date(), config.maxAgeDays)
      .then((removed) => removed && log(`Removed ${removed} file(s) Tohyee hadn't collected in ${config.maxAgeDays} days.`))
      .catch((error) => log(`Clean-up failed: ${error instanceof Error ? error.message : error}`));
  }, 60 * 60_000);
  sweep.unref();

  return {
    ftpPort: receiver.port,
    apiPort: typeof apiAddress === "object" && apiAddress ? apiAddress.port : config.apiPort,
    counters,
    close: async () => {
      clearInterval(sweep);
      await receiver.close();
      api.closeAllConnections();
      await new Promise<void>((resolve) => api.close(() => resolve()));
    },
  };
}
