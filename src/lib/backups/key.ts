import { timingSafeEqual, createHash } from "node:crypto";
import { type ServerAdminAuth, writeAdminAuditEvent } from "@/lib/audit";
import { verifyPassword } from "@/lib/auth/password";
import { backupKeyId, rawSecretKey } from "@/lib/backups/format";
import { coreQuery, withCoreTransaction } from "@/lib/db/transactions";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { secretsAvailable } from "@/lib/secrets";
import { readServerSetting, writeServerSetting } from "@/lib/server-settings";

/**
 * Keeping the backup key safe. Backups can only be opened with the key of the
 * server that made them (TOHYEE_SECRET_KEY), so if the server is lost, so are
 * the backups, unless someone kept a copy of the key. A server admin can see
 * the key (after typing their password again) and then prove their saved copy
 * is right by pasting it back: the server compares it and records when. Until
 * a saved copy has been checked, server admins see a reminder on every page.
 * The record is of the check the server did, never a box someone ticks.
 */

type KeyCheckValue = { keyId: string; checkedAt: string; checkedByEmail: string };

export type BackupKeyStatus = {
  keySet: boolean;
  /** A fingerprint of the key (not the key), shown so a saved copy can be matched up. */
  keyId: string | null;
  /** When a saved copy of this key was last checked; null if never (or only for an earlier key). */
  savedCopyCheckedAt: string | null;
  savedCopyCheckedByEmail: string | null;
};

export async function backupKeyStatus(): Promise<BackupKeyStatus> {
  if (!secretsAvailable()) return { keySet: false, keyId: null, savedCopyCheckedAt: null, savedCopyCheckedByEmail: null };
  const keyId = backupKeyId();
  const stored = await readServerSetting<KeyCheckValue, Record<string, never>>("backup_key");
  const current = stored.value.keyId === keyId;
  return {
    keySet: true,
    keyId,
    savedCopyCheckedAt: current ? (stored.value.checkedAt ?? null) : null,
    savedCopyCheckedByEmail: current ? (stored.value.checkedByEmail ?? null) : null,
  };
}

/** Shown to server admins on every page until a saved copy of the key has been checked. */
export const BACKUP_KEY_REMINDER =
  "Save a copy of the backup key. Backups can only be opened with it, so if this server is lost without a copy, so are the backups. On the server, open Backups in the Tohyee server app (or run the command-line tool's backups key show), save the key somewhere safe away from the backups, such as a password manager, then check your saved copy there.";

/** True when server admins should be reminded to save (and check) a copy of the key. */
export async function backupKeyNeedsSaving(): Promise<boolean> {
  try {
    const status = await backupKeyStatus();
    return status.keySet && !status.savedCopyCheckedAt;
  } catch {
    return false;
  }
}

/**
 * The key itself, for a server admin to copy somewhere safe. They type their
 * password again first (a signed-in window left open isn't enough). The
 * command-line tool (no user) runs on the server, where the key already is.
 */
export async function revealBackupKey(auth: ServerAdminAuth, password: unknown): Promise<{ key: string; keyId: string }> {
  if (!auth.user.isServerAdmin) throw new ForbiddenError("Only a server admin can see the backup key.");
  const actor = { userId: auth.user.id, email: auth.user.email };
  if (auth.user.id) {
    const recent = await coreQuery<{ n: string }>(
      `select count(*)::text as n from admin_audit_events
        where event_type = 'server.backup_key_show_refused' and actor_user_id = $1 and created_at > now() - interval '15 minutes'`,
      [auth.user.id],
    );
    if (Number(recent.rows[0]?.n ?? 0) >= 5) {
      throw new ForbiddenError("Too many wrong passwords. Wait 15 minutes and try again.");
    }
    const found = await coreQuery<{ password_hash: string }>("select password_hash from users where id = $1 and is_active", [auth.user.id]);
    const ok = typeof password === "string" && found.rows[0] ? await verifyPassword(password, found.rows[0].password_hash) : false;
    if (!ok) {
      await writeAdminAuditEvent({ query: coreQuery }, actor, {
        eventType: "server.backup_key_show_refused",
        entityType: "server_setting",
        entityId: "backup_key",
      });
      throw new ForbiddenError("That password isn't right.");
    }
  }
  const key = rawSecretKey();
  await writeAdminAuditEvent({ query: coreQuery }, actor, {
    eventType: "server.backup_key_shown",
    entityType: "server_setting",
    entityId: "backup_key",
    details: { keyId: backupKeyId() },
  });
  return { key, keyId: backupKeyId() };
}

function sameKey(a: string, b: string): boolean {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
}

/** Checks a saved copy of the key (pasted back) is exactly right, and records that it was. */
export async function checkSavedBackupKey(auth: ServerAdminAuth, pasted: unknown): Promise<BackupKeyStatus> {
  if (!auth.user.isServerAdmin) throw new ForbiddenError("Only a server admin can check the backup key.");
  const text = typeof pasted === "string" ? pasted.trim() : "";
  if (!text) throw new ValidationError("Paste the key from where you saved it.");
  const actor = { userId: auth.user.id, email: auth.user.email };
  if (!sameKey(text, rawSecretKey())) {
    await writeAdminAuditEvent({ query: coreQuery }, actor, {
      eventType: "server.backup_key_check_failed",
      entityType: "server_setting",
      entityId: "backup_key",
    });
    throw new ValidationError("That isn't the same key. Copy it again, all of it, and check once more.");
  }
  const keyId = backupKeyId();
  await withCoreTransaction(async (client) => {
    await writeServerSetting<KeyCheckValue, Record<string, never>>(
      client,
      "backup_key",
      { keyId, checkedAt: new Date().toISOString(), checkedByEmail: auth.user.email },
      {},
      auth.user.email,
    );
    await writeAdminAuditEvent(client, actor, {
      eventType: "server.backup_key_checked",
      entityType: "server_setting",
      entityId: "backup_key",
      details: { keyId },
    });
  });
  return backupKeyStatus();
}
