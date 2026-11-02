import { writeAuditEvent } from "@/lib/audit";
import { BoxError, type BoxTarget, callBox, CertificateChangedError } from "@/lib/camera-postbox/client";
import { decodePairingCode, displayFingerprint, hashToken, loginsVersion, newKeyPair, type PairingCode, type PushedLogin, randomToken } from "@/lib/camera-postbox/protocol";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, UnavailableError, ValidationError } from "@/lib/errors";
import { decryptSecret, encryptSecret } from "@/lib/secrets";
import { requireSecurity } from "@/lib/security-cameras/access";
import packageJson from "../../../package.json";

/*
 * The camera post box, Tohyee's side (decisions 1226-1233). Pairing, the
 * status the Security › Post box screen shows, and unpairing. Only owners
 * and admins (camera "set up" access). Pairing and unpairing are audited.
 *
 * Network calls never happen inside a transaction: the routes read in one,
 * call the post box, and save in another.
 */

type Row = {
  public_key: string;
  private_key_ciphertext: string;
  address: string | null;
  https_port: number | null;
  tls_mode: "pinned" | "public" | null;
  fingerprint: string | null;
  token_ciphertext: string | null;
  paired_at: Date | null;
  paired_by_email: string | null;
  ftp_address: string | null;
  ftp_port: number | null;
  passive_ports: string | null;
  box_version: string | null;
  last_contact_at: Date | null;
  last_collected_at: Date | null;
  collected_total: string;
  files_waiting: number | null;
  bytes_waiting: string | null;
  disk_free_bytes: string | null;
  disk_total_bytes: string | null;
  low_disk: boolean;
  logins_version: string | null;
  logins_pushed_at: Date | null;
  last_error: string | null;
  last_error_kind: ErrorKind | null;
  last_error_at: Date | null;
};

export type ErrorKind = "unreachable" | "certificate_changed" | "token_refused" | "box_error" | "file_failed";

export type PostboxStatus = {
  paired: boolean;
  address: string | null;
  httpsPort: number | null;
  tlsMode: "pinned" | "public" | null;
  fingerprint: string | null;
  pairedAt: string | null;
  pairedByEmail: string | null;
  ftp: { address: string; port: number; passivePorts: string | null } | null;
  boxVersion: string | null;
  connected: boolean;
  lastContactAt: string | null;
  lastCollectedAt: string | null;
  collectedTotal: number;
  filesWaiting: number | null;
  bytesWaiting: number | null;
  diskFreeBytes: number | null;
  diskTotalBytes: number | null;
  lowDisk: boolean;
  loginsPushedAt: string | null;
  loginsInSync: boolean;
  error: { kind: ErrorKind; text: string; at: string } | null;
  /** The command to paste on a fresh Ubuntu server. */
  installCommand: string;
};

/** If Tohyee hasn't heard from the post box in this long, it isn't "connected". */
export const CONNECTED_WITHIN_MS = 5 * 60_000;

const iso = (value: Date | null) => (value ? new Date(value).toISOString() : null);
const num = (value: string | number | null) => (value === null ? null : Number(value));

/** The install command for this version of Tohyee: the script and image from the same release. */
export function installCommand(version = packageJson.version): string {
  return `curl -fsSL https://raw.githubusercontent.com/Willy-nz/Tohyee/v${version}/postbox/install.sh | sudo bash -s -- --version ${version}`;
}

async function loadRow(tx: OrgTx): Promise<Row | null> {
  const row = await tx.query<Row>("select * from security_postbox where id = 1");
  return row.rows[0] ?? null;
}

/** The camera logins to push: every active camera's user name and scrypt hash (never a password). */
export async function currentLogins(tx: OrgTx): Promise<PushedLogin[]> {
  const rows = await tx.query<{ username: string; hash: string; camera_id: string }>(
    "select upload_username as username, upload_password_hash as hash, id::text as camera_id from security_cameras where is_active and upload_username is not null order by security_cameras.id",
  );
  return rows.rows.map((row) => ({ username: row.username, hash: row.hash, cameraId: row.camera_id }));
}

export function statusFrom(row: Row | null, localLoginsVersion: string, now = new Date()): PostboxStatus {
  const paired = !!row?.token_ciphertext;
  const lastContact = row?.last_contact_at ? new Date(row.last_contact_at) : null;
  const blocking = row?.last_error_kind && row.last_error_kind !== "file_failed";
  return {
    paired,
    address: paired ? row!.address : null,
    httpsPort: paired ? row!.https_port : null,
    tlsMode: paired ? row!.tls_mode : null,
    fingerprint: paired && row!.fingerprint ? displayFingerprint(row!.fingerprint) : null,
    pairedAt: paired ? iso(row!.paired_at) : null,
    pairedByEmail: paired ? row!.paired_by_email : null,
    ftp: paired && row!.ftp_address && row!.ftp_port ? { address: row!.ftp_address, port: row!.ftp_port, passivePorts: row!.passive_ports } : null,
    boxVersion: paired ? row!.box_version : null,
    connected: paired && !!lastContact && now.getTime() - lastContact.getTime() < CONNECTED_WITHIN_MS && !blocking,
    lastContactAt: paired ? iso(row!.last_contact_at) : null,
    lastCollectedAt: paired ? iso(row!.last_collected_at) : null,
    collectedTotal: paired ? Number(row!.collected_total) : 0,
    filesWaiting: paired ? row!.files_waiting : null,
    bytesWaiting: paired ? num(row!.bytes_waiting) : null,
    diskFreeBytes: paired ? num(row!.disk_free_bytes) : null,
    diskTotalBytes: paired ? num(row!.disk_total_bytes) : null,
    lowDisk: paired ? row!.low_disk : false,
    loginsPushedAt: paired ? iso(row!.logins_pushed_at) : null,
    loginsInSync: paired && row!.logins_version === localLoginsVersion,
    error: paired && row!.last_error && row!.last_error_kind && row!.last_error_at ? { kind: row!.last_error_kind, text: row!.last_error, at: iso(row!.last_error_at)! } : null,
    installCommand: installCommand(),
  };
}

export async function postboxStatus(tx: OrgTx): Promise<PostboxStatus> {
  await requireSecurity(tx, "configure");
  return statusFrom(await loadRow(tx), loginsVersion(await currentLogins(tx)));
}

/** What the collector needs to call the post box: the target (with the token) and the key files are opened with. Null when not paired. Tohyee's own work only. */
export async function postboxConnection(tx: OrgTx): Promise<{ target: BoxTarget; keys: { publicKey: string; privateKey: string }; loginsVersion: string | null } | null> {
  const row = await loadRow(tx);
  if (!row?.token_ciphertext || !row.address || !row.https_port || !row.tls_mode) return null;
  return {
    target: { address: row.address, port: row.https_port, tlsMode: row.tls_mode, fingerprint: row.fingerprint, token: decryptSecret(row.token_ciphertext) },
    keys: { publicKey: row.public_key, privateKey: decryptSecret(row.private_key_ciphertext) },
    loginsVersion: row.logins_version,
  };
}

/** Where cameras upload when a post box is paired (for the Cameras screen), or null. No permission check: the caller has one. */
export async function postboxUploadTarget(tx: OrgTx): Promise<{ address: string; port: number } | null> {
  const row = await tx.query<{ ftp_address: string; ftp_port: number }>("select ftp_address, ftp_port from security_postbox where id = 1 and token_ciphertext is not null and ftp_address is not null");
  return row.rows[0] ? { address: row.rows[0].ftp_address, port: row.rows[0].ftp_port } : null;
}

// Pairing --------------------------------------------------------------------------------------

/**
 * Step one (in a transaction): checks the person may, reads the code, and
 * makes Tohyee's key pair if there isn't one yet. The key pair is kept
 * across re-pairing, so files already waiting on the post box still open.
 */
export async function preparePairing(tx: OrgTx, codeInput: unknown): Promise<{ code: PairingCode; publicKey: string }> {
  await requireSecurity(tx, "configure");
  const code = typeof codeInput === "string" ? decodePairingCode(codeInput) : null;
  if (!code) throw new ValidationError("That isn't a post box pairing code. It starts with TPB1- and is shown by the install script (or by the post box's pairing-code command).");
  let row = await loadRow(tx);
  if (!row) {
    const keys = newKeyPair();
    await tx.query("insert into security_postbox (id, public_key, private_key_ciphertext) values (1, $1, $2) on conflict (id) do nothing", [keys.publicKey, encryptSecret(keys.privateKey)]);
    row = await loadRow(tx);
  }
  return { code, publicKey: row!.public_key };
}

export type PairingAnswer = { token: string; version: string | null; ftp: { address: string; port: number; passivePorts: [number, number] } };

/** Step two (no transaction): checks the certificate against the code, then pairs. Tohyee makes the token; the post box gets only its hash. */
export async function pairWithBox(code: PairingCode, publicKey: string): Promise<PairingAnswer> {
  const token = randomToken(32);
  const target: BoxTarget = { address: code.name ?? code.address, port: code.port, tlsMode: code.name ? "public" : "pinned", fingerprint: code.fingerprint, token: null };
  try {
    const answer = await callBox<{ paired: boolean; version?: string; ftp?: { address?: string; port?: number; passivePorts?: [number, number] } }>(target, { method: "POST", path: "/v1/pair", auth: false, body: { secret: code.secret, tokenHash: hashToken(token), publicKey } });
    const ftp = answer.ftp;
    if (!answer.paired || !ftp || typeof ftp.address !== "string" || typeof ftp.port !== "number" || !Array.isArray(ftp.passivePorts)) throw new BoxError("The post box didn't say how cameras reach it.", "box_error");
    // The token works: check before saving it.
    await callBox({ ...target, token }, { method: "GET", path: "/v1/status" });
    return { token, version: typeof answer.version === "string" ? answer.version.slice(0, 40) : null, ftp: { address: ftp.address.slice(0, 253), port: ftp.port, passivePorts: ftp.passivePorts } };
  } catch (error) {
    if (error instanceof CertificateChangedError) {
      throw new ConflictError(`The post box's certificate doesn't match the pairing code (it has ${displayFingerprint(error.seen).slice(0, 23)}…). Nothing was sent. Check the address, and paste the code again from the post box itself.`);
    }
    if (error instanceof BoxError) throw new UnavailableError(error.kind === "token_refused" ? `The post box refused the pairing code: ${error.message}` : error.message);
    throw error;
  }
}

/** Step three (in a transaction): saves the pairing (the token encrypted) and audits it. */
export async function savePairing(tx: OrgTx, code: PairingCode, answer: PairingAnswer): Promise<PostboxStatus> {
  await requireSecurity(tx, "configure");
  const tlsMode = code.name ? "public" : "pinned";
  await tx.query(
    `update security_postbox set address = $1, https_port = $2, tls_mode = $3, fingerprint = $4, token_ciphertext = $5, paired_at = now(), paired_by_email = $6,
       ftp_address = $7, ftp_port = $8, passive_ports = $9, box_version = $10, last_contact_at = now(), logins_version = null, logins_pushed_at = null,
       last_error = null, last_error_kind = null, last_error_at = null, files_waiting = null, bytes_waiting = null, disk_free_bytes = null, disk_total_bytes = null, low_disk = false
     where id = 1`,
    [code.name ?? code.address, code.port, tlsMode, tlsMode === "pinned" ? code.fingerprint : null, encryptSecret(answer.token), tx.actor.email, answer.ftp.address, answer.ftp.port, answer.ftp.passivePorts.join("-"), answer.version],
  );
  await writeAuditEvent(tx, {
    eventType: "security.postbox_paired",
    entityType: "security_postbox",
    entityId: "1",
    details: { address: code.name ?? code.address, port: code.port, certificate: tlsMode === "pinned" ? `pinned ${displayFingerprint(code.fingerprint)}` : "checked by name" },
  });
  return statusFrom(await loadRow(tx), loginsVersion(await currentLogins(tx)));
}

/** Forgets the post box (the token goes; the key pair stays, for re-pairing). Audited. Returns the old connection so the route can tell the post box, after the transaction. */
export async function unpairPostbox(tx: OrgTx): Promise<BoxTarget | null> {
  await requireSecurity(tx, "configure");
  const connection = await postboxConnection(tx).catch(() => null);
  const row = await loadRow(tx);
  if (!row?.token_ciphertext) return null;
  await tx.query(
    `update security_postbox set address = null, https_port = null, tls_mode = null, fingerprint = null, token_ciphertext = null, paired_at = null, paired_by_email = null,
       ftp_address = null, ftp_port = null, passive_ports = null, box_version = null, last_contact_at = null, logins_version = null, logins_pushed_at = null,
       last_error = null, last_error_kind = null, last_error_at = null, files_waiting = null, bytes_waiting = null, disk_free_bytes = null, disk_total_bytes = null, low_disk = false
     where id = 1`,
  );
  await writeAuditEvent(tx, { eventType: "security.postbox_unpaired", entityType: "security_postbox", entityId: "1", details: { address: row.address } });
  return connection?.target ?? null;
}

// What the collector saw -----------------------------------------------------------------------

export type ContactReport = {
  boxVersion?: string | null;
  filesWaiting?: number;
  bytesWaiting?: number;
  diskFreeBytes?: number;
  diskTotalBytes?: number;
  lowDisk?: boolean;
  collected?: number;
  loginsPushedVersion?: string;
  error?: { kind: ErrorKind; text: string } | null;
};

/** Saves what the post box said. Only for the token that's paired now, so a slow run can't overwrite a new pairing. */
export async function recordContact(tx: OrgTx, token: string, report: ContactReport): Promise<void> {
  const row = await loadRow(tx);
  if (!row?.token_ciphertext || decryptSecret(row.token_ciphertext) !== token) return;
  const reached = !report.error || report.error.kind === "file_failed";
  await tx.query(
    `update security_postbox set
       last_contact_at = case when $1 then now() else last_contact_at end,
       box_version = coalesce($2, box_version),
       files_waiting = coalesce($3, files_waiting),
       bytes_waiting = coalesce($4, bytes_waiting),
       disk_free_bytes = coalesce($5, disk_free_bytes),
       disk_total_bytes = coalesce($6, disk_total_bytes),
       low_disk = coalesce($7, low_disk),
       collected_total = collected_total + $8,
       last_collected_at = case when $8 > 0 then now() else last_collected_at end,
       logins_version = coalesce($9, logins_version),
       logins_pushed_at = case when $9::text is not null then now() else logins_pushed_at end,
       last_error = $10, last_error_kind = $11, last_error_at = case when $10::text is null then null else now() end
     where id = 1`,
    [
      reached,
      report.boxVersion ?? null,
      report.filesWaiting ?? null,
      report.bytesWaiting ?? null,
      report.diskFreeBytes ?? null,
      report.diskTotalBytes ?? null,
      report.lowDisk ?? null,
      report.collected ?? 0,
      report.loginsPushedVersion ?? null,
      report.error ? report.error.text.slice(0, 500) : null,
      report.error?.kind ?? null,
    ],
  );
}
