import { execFile } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { PostboxConfig } from "@/lib/camera-postbox/box/config";
import { encodePairingCode, hashToken, LIMITS, loginsVersion, normaliseFingerprint, parseLogins, type PushedLogin, randomToken } from "@/lib/camera-postbox/protocol";

/*
 * What the post box keeps on its disk besides the queue: its certificate,
 * who it's paired with (a hash of Tohyee's token and Tohyee's public key,
 * never the token itself), the camera logins Tohyee pushed (scrypt hashes)
 * and the current pairing secret (a hash). Files are written whole and
 * renamed into place, readable only by the post box.
 */

export type BoxState = {
  tokenHash: string | null;
  publicKey: string | null;
  pairedAt: string | null;
  logins: PushedLogin[];
  loginsVersion: string;
};

const EMPTY: BoxState = { tokenHash: null, publicKey: null, pairedAt: null, logins: [], loginsVersion: loginsVersion([]) };

export const paths = (dataDir: string) => ({
  state: path.join(dataDir, "state.json"),
  pairing: path.join(dataDir, "pairing.json"),
  tlsDir: path.join(dataDir, "tls"),
  cert: path.join(dataDir, "tls", "cert.pem"),
  key: path.join(dataDir, "tls", "key.pem"),
  queue: path.join(dataDir, "queue"),
  incoming: path.join(dataDir, "incoming"),
});

async function writeWhole(file: string, text: string): Promise<void> {
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, text, { mode: 0o600 });
  await rename(temp, file);
}

export async function loadState(dataDir: string): Promise<BoxState> {
  try {
    const raw = JSON.parse(await readFile(paths(dataDir).state, "utf8")) as Partial<BoxState>;
    const logins = parseLogins(raw.logins ?? []);
    return { tokenHash: raw.tokenHash ?? null, publicKey: raw.publicKey ?? null, pairedAt: raw.pairedAt ?? null, logins, loginsVersion: loginsVersion(logins) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...EMPTY };
    throw new Error(`The post box's state file can't be read: ${error instanceof Error ? error.message : error}`);
  }
}

export async function saveState(dataDir: string, state: BoxState): Promise<void> {
  await writeWhole(paths(dataDir).state, JSON.stringify(state));
}

// Pairing secret ---------------------------------------------------------------------------------

type PairingFile = { secretHash: string; madeAt: string };

/** Makes a new one-time pairing secret (the old one stops working) and returns the pairing code to paste into Tohyee. */
export async function newPairingCode(config: PostboxConfig, now = new Date()): Promise<string> {
  const secret = randomToken(32);
  const file: PairingFile = { secretHash: hashToken(secret), madeAt: now.toISOString() };
  await mkdir(config.dataDir, { recursive: true });
  await writeWhole(paths(config.dataDir).pairing, JSON.stringify(file));
  return encodePairingCode({ address: config.publicName ?? config.publicAddress, port: config.apiPublicPort, fingerprint: await certificateFingerprint(config), secret, name: config.publicName });
}

/** The current pairing secret's hash, if there is one and it's less than a day old. */
export async function currentPairingSecret(dataDir: string, now = new Date()): Promise<string | null> {
  try {
    const file = JSON.parse(await readFile(paths(dataDir).pairing, "utf8")) as PairingFile;
    if (typeof file.secretHash !== "string" || now.getTime() - Date.parse(file.madeAt) > LIMITS.pairingSecretMs) return null;
    return file.secretHash;
  } catch {
    return null;
  }
}

export async function spendPairingSecret(dataDir: string): Promise<void> {
  await rm(paths(dataDir).pairing, { force: true });
}

// Certificate ------------------------------------------------------------------------------------

const exec = promisify(execFile);

/**
 * The certificate cameras (FTPS) and Tohyee (HTTPS) see. A proper one when
 * POSTBOX_TLS_CERT is set; otherwise the post box makes its own on first
 * start (RSA 2048, since a camera's TLS may not take newer kinds; ten
 * years) and Tohyee pins its fingerprint, from the pairing code.
 */
export async function ensureCertificate(config: PostboxConfig): Promise<{ cert: Buffer; key: Buffer }> {
  if (config.certPath && config.keyPath) return { cert: await readFile(config.certPath), key: await readFile(config.keyPath) };
  const files = paths(config.dataDir);
  if (!existsSync(files.cert) || !existsSync(files.key)) {
    await mkdir(files.tlsDir, { recursive: true, mode: 0o700 });
    const ip = /^\d+(\.\d+){3}$/.test(config.publicAddress);
    await exec("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "3650",
      "-subj", "/CN=Tohyee camera post box",
      "-addext", `subjectAltName=${ip ? "IP" : "DNS"}:${config.publicAddress}`,
      "-keyout", `${files.key}.tmp`, "-out", `${files.cert}.tmp`,
    ]);
    await rename(`${files.key}.tmp`, files.key);
    await rename(`${files.cert}.tmp`, files.cert);
  }
  return { cert: await readFile(files.cert), key: await readFile(files.key) };
}

export async function certificateFingerprint(config: PostboxConfig): Promise<string> {
  const { cert } = await ensureCertificate(config);
  return normaliseFingerprint(new X509Certificate(cert).raw);
}
