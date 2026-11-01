import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";
import { baseName, type MediaKind, SNIFF_BYTES, sniffMedia } from "@/lib/security-cameras/file-names";
import { formatBytes } from "@/lib/security-cameras/shared";

/*
 * The camera upload receiver (#508, decision 1219): a small FTP server, with
 * FTPS (explicit, AUTH TLS), that only takes files in. Written for Tohyee
 * rather than taken from a library: the maintained Node FTP servers we
 * checked were either unmaintained with old dependencies (ftp-srv, last
 * release 2023) or very new single-maintainer forks, and a camera needs
 * only a few commands. See docs/FARM-SECURITY.md.
 *
 * What it does:
 * - Logins are each camera's own upload login (USER/PASS), checked by
 *   `authenticate`. Without TLS the login is refused unless plain FTP is
 *   allowed (for a camera on the same network only).
 * - Passive mode only (PASV, EPSV); the data connection must come from the
 *   same address as the control connection.
 * - STOR writes to the incoming folder, counting, hashing and checking the
 *   first bytes as it goes; over the size limit it stops. Then `receive`
 *   decides. Folders (CWD, MKD) are accepted but only pretend: nothing is
 *   made on disk and file names never become paths.
 * - LIST and NLST answer with an empty list. Reading, deleting, renaming,
 *   appending, SITE and active mode (PORT) are refused.
 * - Ten failed logins from one address in 15 minutes and it's refused for
 *   15 minutes. At most 5 connections per address and 50 in all.
 */

export type ReceiverFile = { name: string; tempPath: string; sizeBytes: number; sha256: string; media: MediaKind; receivedAt: Date };

export type ReceiverOptions<U> = {
  host: string;
  port: number;
  /** Certificate and key for FTPS. Without them only plain FTP, which is refused unless `allowPlain`. */
  tls: { key: Buffer | string; cert: Buffer | string } | null;
  allowPlain: boolean;
  /** The ports offered for passive data connections, inclusive. */
  passivePorts: [number, number];
  /** The IPv4 address cameras reach this server at, for PASV; the control connection's own address when null. */
  publicAddress: string | null;
  maxFileBytes: number;
  incomingFolder: string;
  authenticate: (username: string, password: string, remoteAddress: string) => Promise<U | null>;
  receive: (uploader: U, file: ReceiverFile) => Promise<"saved" | "duplicate" | "refused">;
  log?: (message: string) => void;
  /** For tests: how long a failed login waits before answering. */
  failedLoginDelayMs?: number;
};

const MAX_LINE = 1024;
const IDLE_MS = 120_000;
const DATA_WAIT_MS = 30_000;
const MAX_CONNECTIONS = 50;
const MAX_PER_ADDRESS = 5;
const FAILURE_WINDOW_MS = 15 * 60_000;
const MAX_FAILURES = 10;

type Failures = { count: number; first: number; blockedUntil: number };

export type CameraReceiver = { close: () => Promise<void>; port: number };

function normaliseAddress(address: string | undefined): string {
  if (!address) return "";
  return address.startsWith("::ffff:") ? address.slice(7) : address;
}

/** The virtual folder after a CWD: never touches the disk, never above "/". */
export function changeFolder(current: string, target: string): string {
  const joined = target.startsWith("/") ? target : `${current}/${target}`;
  const parts: string[] = [];
  for (const part of joined.split(/[\\/]+/)) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part.slice(0, 100));
  }
  return `/${parts.slice(0, 20).join("/")}`;
}

export async function startCameraReceiver<U>(options: ReceiverOptions<U>): Promise<CameraReceiver> {
  const log = options.log ?? (() => undefined);
  const secureContext = options.tls ? tls.createSecureContext({ key: options.tls.key, cert: options.tls.cert, minVersion: "TLSv1.2" }) : null;
  const failures = new Map<string, Failures>();
  const perAddress = new Map<string, number>();
  const usedPassivePorts = new Set<number>();
  const sockets = new Set<net.Socket>();
  await mkdir(options.incomingFolder, { recursive: true });

  const blocked = (address: string) => {
    const entry = failures.get(address);
    return !!entry && entry.blockedUntil > Date.now();
  };
  const failed = (address: string) => {
    const now = Date.now();
    const entry = failures.get(address);
    const fresh = !entry || now - entry.first > FAILURE_WINDOW_MS ? { count: 0, first: now, blockedUntil: 0 } : entry;
    fresh.count += 1;
    if (fresh.count >= MAX_FAILURES) fresh.blockedUntil = now + FAILURE_WINDOW_MS;
    failures.set(address, fresh);
    if (failures.size > 10_000) failures.delete(failures.keys().next().value!);
  };

  const server = net.createServer((raw) => {
    const remote = normaliseAddress(raw.remoteAddress);
    sockets.add(raw);
    raw.on("close", () => sockets.delete(raw));
    const count = perAddress.get(remote) ?? 0;
    if (sockets.size > MAX_CONNECTIONS || count >= MAX_PER_ADDRESS || blocked(remote)) {
      raw.end("421 Too many connections. Try again later.\r\n");
      return;
    }
    perAddress.set(remote, count + 1);
    raw.once("close", () => {
      const left = (perAddress.get(remote) ?? 1) - 1;
      if (left > 0) perAddress.set(remote, left);
      else perAddress.delete(remote);
    });
    handleSession(raw, remote);
  });

  function handleSession(raw: net.Socket, remote: string) {
    let socket: net.Socket = raw;
    let secured = false;
    let protectData = false;
    let username: string | null = null;
    let uploader: U | null = null;
    let folder = "/";
    let buffer = "";
    let busy = false;
    const queue: string[] = [];
    let passive: { server: net.Server; port: number; connection: Promise<net.Socket> } | null = null;

    const reply = (text: string) => {
      if (!socket.destroyed) socket.write(`${text}\r\n`);
    };
    const say = (text: string): false => {
      reply(text);
      return false;
    };
    const closePassive = () => {
      if (passive) {
        passive.server.close();
        usedPassivePorts.delete(passive.port);
        passive = null;
      }
    };

    const attach = (target: net.Socket) => {
      target.setTimeout(IDLE_MS, () => {
        reply("421 Idle too long. Goodbye.");
        target.destroy();
      });
      target.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        if (buffer.length > MAX_LINE * 4) {
          target.destroy();
          return;
        }
        let at: number;
        while ((at = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, at).replace(/\r$/, "");
          buffer = buffer.slice(at + 1);
          if (line.length > MAX_LINE) {
            target.destroy();
            return;
          }
          queue.push(line);
        }
        void pump();
      });
      target.on("error", () => target.destroy());
      target.on("close", closePassive);
    };

    const pump = async () => {
      if (busy) return;
      busy = true;
      try {
        while (queue.length && !socket.destroyed) {
          const line = queue.shift()!;
          const stop = await command(line);
          if (stop) return;
        }
      } finally {
        busy = false;
      }
    };

    const openPassive = async (): Promise<number | null> => {
      closePassive();
      const [low, high] = options.passivePorts;
      for (let port = low; port <= high; port += 1) {
        if (usedPassivePorts.has(port)) continue;
        usedPassivePorts.add(port);
        let resolveConnection: (value: net.Socket) => void = () => undefined;
        let rejectConnection: (reason: Error) => void = () => undefined;
        const connection = new Promise<net.Socket>((resolve, reject) => {
          resolveConnection = resolve;
          rejectConnection = reject;
        });
        connection.catch(() => undefined);
        const onConnection = (data: net.Socket) => {
          // Only from the camera that asked: no one else may send (or read) on its data port.
          if (normaliseAddress(data.remoteAddress) !== remote) {
            data.destroy();
            return;
          }
          dataServer.close();
          resolveConnection(data);
        };
        const dataServer: net.Server = protectData && secureContext ? tls.createServer({ key: options.tls!.key, cert: options.tls!.cert, minVersion: "TLSv1.2" }, onConnection) : net.createServer(onConnection);
        dataServer.on("tlsClientError", () => undefined);
        const listening = await new Promise<boolean>((resolve) => {
          dataServer.once("error", () => resolve(false));
          dataServer.listen(port, options.host, () => resolve(true));
        });
        if (!listening) {
          usedPassivePorts.delete(port);
          continue;
        }
        const timer = setTimeout(() => rejectConnection(new Error("no data connection")), DATA_WAIT_MS);
        timer.unref();
        connection.finally(() => clearTimeout(timer)).catch(() => undefined);
        passive = { server: dataServer, port, connection };
        return port;
      }
      return null;
    };

    const takeData = async (): Promise<net.Socket | null> => {
      const current = passive;
      if (!current) return null;
      try {
        return await current.connection;
      } catch {
        return null;
      } finally {
        current.server.close();
        usedPassivePorts.delete(current.port);
        if (passive === current) passive = null;
      }
    };

    const store = async (argument: string) => {
      const name = baseName(argument).slice(0, 255);
      if (!name) return reply("553 A file name is needed.");
      const data = await takeData();
      if (!data) return reply("425 Open a passive data connection first (PASV or EPSV).");
      reply("150 Ready for the file.");
      const tempPath = path.join(options.incomingFolder, `${randomUUID()}.part`);
      const out = createWriteStream(tempPath, { flags: "wx" });
      const hash = createHash("sha256");
      let size = 0;
      let head = Buffer.alloc(0);
      let tooBig = false;
      const finished = await new Promise<boolean>((resolve) => {
        data.setTimeout(IDLE_MS, () => data.destroy(new Error("timeout")));
        data.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > options.maxFileBytes) {
            // Nothing more is kept. The rest is read and thrown away (up to twice the limit) so the camera hears "too big", not a dropped connection.
            tooBig = true;
            if (size > options.maxFileBytes * 2) data.destroy();
            return;
          }
          if (head.length < SNIFF_BYTES) head = Buffer.concat([head, chunk.subarray(0, SNIFF_BYTES - head.length)]);
          hash.update(chunk);
          if (!out.write(chunk)) {
            data.pause();
            out.once("drain", () => data.resume());
          }
        });
        data.on("end", () => resolve(!tooBig));
        data.on("error", () => resolve(false));
        data.on("close", () => resolve(!tooBig && data.readableEnded));
      });
      await new Promise<void>((resolve) => out.end(() => resolve()));
      const media = sniffMedia(head);
      if (!finished || tooBig || !media || size === 0) {
        await rm(tempPath, { force: true });
        if (tooBig) return reply(`552 Files can be at most ${formatBytes(options.maxFileBytes)}.`);
        if (!finished) return reply("426 The upload stopped before the end.");
        return reply("553 Only JPEG photos and MP4 videos are taken.");
      }
      try {
        const result = await options.receive(uploader as U, { name, tempPath, sizeBytes: size, sha256: hash.digest("hex"), media, receivedAt: new Date() });
        if (result === "refused") return reply("550 This camera can't upload now.");
        reply(result === "duplicate" ? "226 Already received." : "226 Received.");
      } catch (error) {
        await rm(tempPath, { force: true });
        log(`Camera upload couldn't be saved: ${error instanceof Error ? error.message : error}`);
        reply("451 Couldn't save the file. Try again later.");
      }
    };

    const command = async (line: string): Promise<boolean> => {
      const space = line.indexOf(" ");
      const verb = (space < 0 ? line : line.slice(0, space)).toUpperCase();
      const argument = space < 0 ? "" : line.slice(space + 1).trim();
      const loggedIn = uploader !== null;
      switch (verb) {
        case "AUTH": {
          if (!secureContext) return say("502 FTPS isn't set up on this server.");
          if (secured) return say("503 Already secured.");
          if (!/^(TLS|TLS-C|SSL)$/i.test(argument)) return say("504 Use AUTH TLS.");
          reply("234 Go ahead with TLS.");
          raw.removeAllListeners("data");
          raw.setTimeout(0);
          const secure = new tls.TLSSocket(raw, { isServer: true, secureContext });
          secure.on("secure", () => {
            secured = true;
          });
          socket = secure;
          buffer = "";
          attach(secure);
          return false;
        }
        case "PBSZ":
          return say(secured ? "200 PBSZ=0" : "503 Secure the connection first (AUTH TLS).");
        case "PROT": {
          const level = argument.toUpperCase();
          if (level === "P" && secured) protectData = true;
          else if (level === "C" && options.allowPlain) protectData = false;
          else return say(level === "P" ? "503 Secure the connection first (AUTH TLS)." : "536 Data must be protected (PROT P).");
          return say("200 OK.");
        }
        case "USER":
          if (!secured && !options.allowPlain) return say("530 Use FTPS: secure the connection first (AUTH TLS).");
          username = argument.slice(0, 100);
          uploader = null;
          return say("331 Password, please.");
        case "PASS": {
          if (!username) return say("503 USER first.");
          if (!secured && !options.allowPlain) return say("530 Use FTPS: secure the connection first (AUTH TLS).");
          const found = blocked(remote) ? null : await options.authenticate(username, argument, remote).catch((error) => {
            log(`Camera login check failed: ${error instanceof Error ? error.message : error}`);
            return null;
          });
          if (!found) {
            failed(remote);
            await new Promise((resolve) => setTimeout(resolve, options.failedLoginDelayMs ?? 1000));
            reply("530 Wrong user name or password.");
            if (blocked(remote)) {
              socket.destroy();
              return true;
            }
            return false;
          }
          uploader = found;
          // An FTPS login also wants its photos and clips protected; cameras send PROT P themselves, but don't rely on it.
          if (secured && !options.allowPlain) protectData = true;
          return say("230 Logged in. Uploads only.");
        }
        case "SYST":
          return say("215 UNIX Type: L8");
        case "FEAT":
          reply("211-Features:");
          if (secureContext) {
            reply(" AUTH TLS");
            reply(" PBSZ");
            reply(" PROT");
          }
          reply(" EPSV");
          reply(" PASV");
          reply(" UTF8");
          return say("211 End");
        case "OPTS":
          return say(/^UTF8 ON$/i.test(argument) ? "200 UTF8 on." : "501 Option not known.");
        case "NOOP":
          return say("200 OK.");
        case "QUIT":
          reply("221 Goodbye.");
          socket.end();
          return true;
        case "TYPE":
        case "MODE":
        case "STRU":
          return say(loggedIn ? "200 OK." : "530 Log in first.");
        case "ALLO":
          return say("202 No need.");
      }
      if (!loggedIn) return say("530 Log in first.");
      switch (verb) {
        case "PWD":
        case "XPWD":
          return say(`257 "${folder.replace(/"/g, '""')}" is the folder.`);
        case "CWD":
        case "XCWD":
          folder = changeFolder(folder, argument || "/");
          return say("250 OK.");
        case "CDUP":
          folder = changeFolder(folder, "..");
          return say("250 OK.");
        case "MKD":
        case "XMKD":
          return say(`257 "${changeFolder(folder, argument).replace(/"/g, '""')}" made.`);
        case "PASV": {
          const port = await openPassive();
          if (port === null) return say("421 No data port free. Try again shortly.");
          const address = options.publicAddress ?? normaliseAddress(socket.localAddress);
          if (!net.isIPv4(address)) {
            closePassive();
            return say("522 Use EPSV.");
          }
          return say(`227 Entering Passive Mode (${address.split(".").join(",")},${port >> 8},${port & 255}).`);
        }
        case "EPSV": {
          if (/^ALL$/i.test(argument)) return say("200 EPSV only.");
          const port = await openPassive();
          if (port === null) return say("421 No data port free. Try again shortly.");
          return say(`229 Entering Extended Passive Mode (|||${port}|).`);
        }
        case "PORT":
        case "EPRT":
          return say("502 Use passive mode (PASV or EPSV).");
        case "LIST":
        case "NLST":
        case "MLSD": {
          const data = await takeData();
          if (!data) return say("425 Open a passive data connection first (PASV or EPSV).");
          reply("150 Here's the list.");
          data.end();
          return say("226 Nothing to list: uploads only.");
        }
        case "STOR":
          await store(argument);
          return false;
        case "SIZE":
        case "MDTM":
          return say("550 Uploads only.");
        default:
          return say("502 Not available: this server only takes uploads from cameras.");
      }
    };

    attach(raw);
    reply("220 Tohyee camera uploads.");
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
