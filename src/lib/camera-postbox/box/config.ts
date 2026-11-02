import path from "node:path";
import { isHost } from "@/lib/camera-postbox/protocol";

/*
 * The post box's settings, from its environment (the install script writes
 * them to /opt/tohyee-postbox/.env). Pure given `env`; tested in
 * tests/unit/camera-postbox-box.test.ts.
 */

export type PostboxConfig = {
  dataDir: string;
  /** The address cameras and Tohyee reach this server at (its public IPv4, or a name). */
  publicAddress: string;
  /** A domain name with a proper certificate (POSTBOX_TLS_CERT and _KEY); null for the post box's own certificate, which Tohyee pins. */
  publicName: string | null;
  host: string;
  ftpPort: number;
  /** The port cameras are told to use (Docker may map 21 to the container's 2121). */
  ftpPublicPort: number;
  passivePorts: [number, number];
  apiPort: number;
  /** The port Tohyee is told to use. */
  apiPublicPort: number;
  certPath: string | null;
  keyPath: string | null;
  maxFileBytes: number;
  /** Uploads are refused when less than this is free on the disk. */
  minFreeBytes: number;
  /** Files Tohyee hasn't collected in this many days are deleted. */
  maxAgeDays: number;
};

function port(value: string | undefined, fallback: number, name: string): number {
  const text = value?.trim() || String(fallback);
  const number = Number(text);
  if (!Number.isInteger(number) || number < 1 || number > 65535) throw new Error(`${name} isn't a port number.`);
  return number;
}

function whole(value: string | undefined, fallback: number, min: number, max: number, name: string): number {
  const number = Number(value?.trim() || String(fallback));
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${name} must be a whole number from ${min} to ${max}.`);
  return number;
}

export function postboxConfig(env: Record<string, string | undefined>): PostboxConfig {
  const publicAddress = env.POSTBOX_PUBLIC_ADDRESS?.trim() ?? "";
  if (!publicAddress || !isHost(publicAddress)) throw new Error("Set POSTBOX_PUBLIC_ADDRESS to this server's public IPv4 address (or its name).");
  const publicName = env.POSTBOX_PUBLIC_NAME?.trim().toLowerCase() || null;
  if (publicName && (!isHost(publicName) || /^\d+(\.\d+){3}$/.test(publicName))) throw new Error("POSTBOX_PUBLIC_NAME must be a domain name, like cameras.example.nz.");
  const certPath = env.POSTBOX_TLS_CERT?.trim() || null;
  const keyPath = env.POSTBOX_TLS_KEY?.trim() || null;
  if ((certPath === null) !== (keyPath === null)) throw new Error("Set both POSTBOX_TLS_CERT and POSTBOX_TLS_KEY, or neither.");
  if (publicName && !certPath) throw new Error("POSTBOX_PUBLIC_NAME needs a proper certificate for it in POSTBOX_TLS_CERT and POSTBOX_TLS_KEY.");
  const range = (env.POSTBOX_PASSIVE_PORTS?.trim() || "50000-50019").split("-").map(Number);
  if (range.length !== 2 || !range.every((value) => Number.isInteger(value) && value > 0 && value <= 65535) || range[0] > range[1] || range[1] - range[0] > 1000) {
    throw new Error("POSTBOX_PASSIVE_PORTS must be a range like 50000-50019.");
  }
  const ftpPort = port(env.POSTBOX_FTP_PORT, 2121, "POSTBOX_FTP_PORT");
  const apiPort = port(env.POSTBOX_API_PORT, 8443, "POSTBOX_API_PORT");
  return {
    dataDir: path.resolve(env.POSTBOX_DATA_DIR?.trim() || "/data"),
    publicAddress,
    publicName,
    host: env.POSTBOX_HOST?.trim() || "0.0.0.0",
    ftpPort,
    ftpPublicPort: port(env.POSTBOX_FTP_PUBLIC_PORT, ftpPort, "POSTBOX_FTP_PUBLIC_PORT"),
    passivePorts: [range[0], range[1]],
    apiPort,
    apiPublicPort: port(env.POSTBOX_API_PUBLIC_PORT, apiPort, "POSTBOX_API_PUBLIC_PORT"),
    certPath,
    keyPath,
    maxFileBytes: whole(env.POSTBOX_MAX_FILE_MB, 200, 1, 2048, "POSTBOX_MAX_FILE_MB") * 1024 * 1024,
    minFreeBytes: whole(env.POSTBOX_MIN_FREE_MB, 1024, 0, 1_000_000, "POSTBOX_MIN_FREE_MB") * 1024 * 1024,
    maxAgeDays: whole(env.POSTBOX_MAX_AGE_DAYS, 30, 1, 365, "POSTBOX_MAX_AGE_DAYS"),
  };
}
