import { timingSafeEqual } from "node:crypto";
import { type ServerAdminAuth, writeAdminAuditEvent } from "@/lib/audit";
import { verifyPassword } from "@/lib/auth/password";
import {
  checkPassphrase,
  formatRecoveryCode,
  makeRecoveryFile,
  openRecoveryFile,
  parseRecoveryCode,
  randomRecoveryFileName,
  recoveryFileName,
  suggestPassphrase,
} from "@/lib/backups/recovery-code";
import { addRecoveryKeyVersion, currentRecoveryKey, recoveryKeyId, recoveryKeyVersions, serverRecoveryKey } from "@/lib/backups/recovery-key";
import { coreQuery, withCoreTransaction } from "@/lib/db/transactions";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { secretsAvailable } from "@/lib/secrets";
import { readServerSetting, writeServerValue } from "@/lib/server-settings";

/**
 * The recovery kit (#389, decisions 735 and 736; docs/BACKUP-RECOVERY.md):
 * the current backup recovery key, as a recovery code or a recovery file
 * encrypted with a passphrase. Nothing else leaves the server: not the
 * environment file, not the PostgreSQL passwords, not the setup token.
 *
 * A server admin gets it on the server computer (the local server settings
 * address), after typing their password again. The export is audited
 * without the key. "Checking" a kit means the server opened what was given
 * and it matched the key it holds for that version; only that is recorded,
 * never a box someone ticks.
 */

/** Wrong passwords for exporting a recovery kit or making a new recovery key: 5 in 15 minutes blocks both. */
const REFUSED_EVENTS = ["server.recovery_kit_export_refused"];

/**
 * A server admin types their password again before a secret leaves the
 * server (a signed-in window left open isn't enough). The command-line tool
 * (no user) runs on the server, where the secrets already are. A wrong
 * password is audited as `refusedEvent`.
 */
async function confirmAdminPassword(auth: ServerAdminAuth, password: unknown, refusedEvent: string, entityId: string): Promise<void> {
  if (!auth.user.id) return;
  const actor = { userId: auth.user.id, email: auth.user.email };
  const recent = await coreQuery<{ n: string }>(
    `select count(*)::text as n from admin_audit_events
      where event_type = any($2::text[]) and actor_user_id = $1 and created_at > now() - interval '15 minutes'`,
    [auth.user.id, REFUSED_EVENTS],
  );
  if (Number(recent.rows[0]?.n ?? 0) >= 5) {
    throw new ForbiddenError("Too many wrong passwords. Wait 15 minutes and try again.");
  }
  const found = await coreQuery<{ password_hash: string }>("select password_hash from users where id = $1 and is_active", [auth.user.id]);
  const ok = typeof password === "string" && found.rows[0] ? await verifyPassword(password, found.rows[0].password_hash) : false;
  if (!ok) {
    await writeAdminAuditEvent({ query: coreQuery }, actor, { eventType: refusedEvent, entityType: "server_setting", entityId });
    throw new ForbiddenError("That password isn't right.");
  }
}

type CheckRecord = { id: string; checkedAt: string; checkedByEmail: string; method: "code" | "file" };
type ChecksValue = { versions: Record<string, CheckRecord> };
const CHECKS_SETTING = "backup_recovery_kit_checks";

export type RecoveryKitStatus = {
  keySet: boolean;
  /** The current recovery key version (null until the first backup or kit makes one). */
  version: number | null;
  id: string | null;
  createdAt: string | null;
  /** The last successful check of a saved kit for the current version. */
  checkedAt: string | null;
  checkedByEmail: string | null;
  checkedMethod: "code" | "file" | null;
  /** Whether server admins should be reminded to save (and check) the kit. */
  needsSaving: boolean;
  /** Earlier versions and when each was last checked. */
  versions: { version: number; id: string; createdAt: string; checkedAt: string | null }[];
};

export async function recoveryKitStatus(): Promise<RecoveryKitStatus> {
  if (!secretsAvailable()) {
    return { keySet: false, version: null, id: null, createdAt: null, checkedAt: null, checkedByEmail: null, checkedMethod: null, needsSaving: false, versions: [] };
  }
  const { current, all } = await recoveryKeyVersions();
  const checks = (await readServerSetting<ChecksValue, Record<string, never>>(CHECKS_SETTING)).value.versions ?? {};
  const checkFor = (version: number, id: string) => {
    const found = checks[String(version)];
    return found && found.id === id ? found : null;
  };
  const currentCheck = current ? checkFor(current.version, current.id) : null;
  return {
    keySet: true,
    version: current?.version ?? null,
    id: current?.id ?? null,
    createdAt: current?.createdAt ?? null,
    checkedAt: currentCheck?.checkedAt ?? null,
    checkedByEmail: currentCheck?.checkedByEmail ?? null,
    checkedMethod: currentCheck?.method ?? null,
    needsSaving: !currentCheck,
    versions: all.map((info) => ({ version: info.version, id: info.id, createdAt: info.createdAt, checkedAt: checkFor(info.version, info.id)?.checkedAt ?? null })),
  };
}

/** Shown to server admins on every page until a saved kit for the current recovery key has been checked. */
export const RECOVERY_KIT_REMINDER =
  "Save the recovery kit. Without it, the backups can't be opened on another computer if this one is lost. On the server, open Backups (in Server settings, or the Tohyee server app's Open in the browser), save the kit somewhere other than the backup folder, such as a password manager, then check your saved copy there.";

export async function recoveryKitNeedsSaving(): Promise<boolean> {
  try {
    const status = await recoveryKitStatus();
    return status.keySet && status.needsSaving;
  } catch {
    return false;
  }
}

export type KitExport =
  | { form: "code"; version: number; id: string; code: string }
  | { form: "file"; version: number; id: string; fileName: string; content: string };

/**
 * The recovery kit for the current recovery key (made now if there's none
 * yet): `form` "code", or "file" with a `passphrase` (14+ characters) and
 * optionally `randomName`. Needs the admin's `password` again.
 */
export async function exportRecoveryKit(
  auth: ServerAdminAuth,
  input: { password?: unknown; form?: unknown; passphrase?: unknown; randomName?: unknown },
): Promise<KitExport> {
  if (!auth.user.isServerAdmin) throw new ForbiddenError("Only a server admin can save the recovery kit.");
  const form = input.form === "file" ? "file" : input.form === "code" || input.form === undefined ? "code" : null;
  if (!form) throw new ValidationError('form is "code" or "file".');
  const passphrase = form === "file" ? checkPassphrase(input.passphrase) : null;
  await confirmAdminPassword(auth, input.password, "server.recovery_kit_export_refused", "backup_recovery_keys");
  const key = await currentRecoveryKey();
  const actor = { userId: auth.user.id, email: auth.user.email };
  let result: KitExport;
  if (form === "code") {
    result = { form, version: key.version, id: key.id, code: formatRecoveryCode(key.version, key.key) };
  } else {
    const fileName = input.randomName === true ? randomRecoveryFileName() : recoveryFileName(key.version);
    result = { form, version: key.version, id: key.id, fileName, content: await makeRecoveryFile(key, passphrase!) };
  }
  await writeAdminAuditEvent({ query: coreQuery }, actor, {
    eventType: "server.recovery_kit_exported",
    entityType: "server_setting",
    entityId: "backup_recovery_keys",
    details: { version: key.version, keyId: key.id, form },
  });
  return result;
}

function sameKey(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Checks a saved kit: the `code`, or the `file` (its text) and its
 * `passphrase`. The server opens it and compares the key with the one it
 * holds for that version, then records that it matched.
 */
export async function checkRecoveryKit(auth: ServerAdminAuth, input: { code?: unknown; file?: unknown; passphrase?: unknown }): Promise<RecoveryKitStatus> {
  if (!auth.user.isServerAdmin) throw new ForbiddenError("Only a server admin can check the recovery kit.");
  const actor = { userId: auth.user.id, email: auth.user.email };
  const method: "code" | "file" = input.file !== undefined && input.file !== null && input.file !== "" ? "file" : "code";
  let given: { version: number; key: Buffer };
  try {
    given = method === "file" ? await openRecoveryFile(input.file, input.passphrase) : parseRecoveryCode(input.code);
  } catch (error) {
    await writeAdminAuditEvent({ query: coreQuery }, actor, { eventType: "server.recovery_kit_check_failed", entityType: "server_setting", entityId: "backup_recovery_keys", details: { method } });
    throw error;
  }
  const held = await serverRecoveryKey(given.version);
  if (!held || !sameKey(held.key, given.key)) {
    await writeAdminAuditEvent({ query: coreQuery }, actor, { eventType: "server.recovery_kit_check_failed", entityType: "server_setting", entityId: "backup_recovery_keys", details: { method, version: given.version } });
    throw new ValidationError(
      held
        ? `That isn't this server's recovery key version ${given.version}. Save the kit again and check the new copy.`
        : `This server has no recovery key version ${given.version}: that kit is from another server (fingerprint ${recoveryKeyId(given.key)}).`,
    );
  }
  await withCoreTransaction(async (client) => {
    const stored = await client.query<{ value: ChecksValue }>("select value from server_settings where key = $1 for update", [CHECKS_SETTING]);
    const versions = { ...(stored.rows[0]?.value?.versions ?? {}) };
    versions[String(held.version)] = { id: held.id, checkedAt: new Date().toISOString(), checkedByEmail: auth.user.email, method };
    await writeServerValue<ChecksValue>(client, CHECKS_SETTING, { versions }, auth.user.email);
    await writeAdminAuditEvent(client, actor, {
      eventType: "server.recovery_kit_checked",
      entityType: "server_setting",
      entityId: "backup_recovery_keys",
      details: { version: held.version, keyId: held.id, method },
    });
  });
  return recoveryKitStatus();
}

/**
 * A new recovery key version for backups from now on (a kit was lost or
 * seen). The older versions stay, so this server's older backups still open
 * here; their kits are still needed on another computer until those backups
 * age out. A new key can't recall copies of older backups already taken.
 */
export async function rotateRecoveryKey(auth: ServerAdminAuth, password: unknown): Promise<RecoveryKitStatus> {
  if (!auth.user.isServerAdmin) throw new ForbiddenError("Only a server admin can make a new recovery key.");
  await confirmAdminPassword(auth, password, "server.recovery_kit_export_refused", "backup_recovery_keys");
  await currentRecoveryKey(); // version 1 first, if there's none yet
  await withCoreTransaction(async (client) => {
    const made = await addRecoveryKeyVersion(client, auth.user.email);
    await writeAdminAuditEvent(client, { userId: auth.user.id, email: auth.user.email }, {
      eventType: "server.recovery_key_rotated",
      entityType: "server_setting",
      entityId: "backup_recovery_keys",
      details: { version: made.version, keyId: made.id },
    });
  });
  return recoveryKitStatus();
}

export { suggestPassphrase };
