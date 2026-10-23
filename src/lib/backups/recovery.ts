import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ServerAdminAuth } from "@/lib/audit";
import { writeAdminAuditEvent } from "@/lib/audit";
import { type BackupCheck } from "@/lib/backups/checks";
import { BACKUP_EXTENSION, type BackupHeader, materialFromText, openBackupKeys, type RecoveryMaterial, readBackupHeader, readDecrypted } from "@/lib/backups/format";
import { startPgTool } from "@/lib/backups/pg-tools";
import { openRecoveryFile } from "@/lib/backups/recovery-code";
import { reEncryptStoredSecrets, type SecretsReport } from "@/lib/backups/rewrap";
import { backupTargets, checkBackup, datedBackupFiles, folderFor, getBackupSettings, suggestedRestoreId, withBackupLock } from "@/lib/backups/service";
import { coreDatabaseName } from "@/lib/db/connection";
import { LATEST_TENANT_VERSION } from "@/lib/db/migrations";
import { connectAsAdmin, getAdminPool } from "@/lib/db/pools";
import { quoteSqlIdentifier } from "@/lib/db/sql";
import { coreQuery, withCoreTransaction } from "@/lib/db/transactions";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { privateMailCopyOwners } from "@/lib/private-mail/store";
import { decryptSecretWithKey, encryptSecret, decryptSecret } from "@/lib/secrets";

/**
 * The restore wizard's server side (#389, decisions 737-739;
 * docs/BACKUP-RECOVERY.md): finding backups in a folder on this computer
 * (the OneDrive folder, a USB drive), working out the recovery material,
 * checking a backup before anything is made, test restores into a scratch
 * database, and recovering the people from a server backup on a
 * replacement computer.
 */

// ------------------------------------------------------------------ finding backups

export type FoundBackup = {
  /** Relative to the folder that was searched. */
  name: string;
  sizeBytes: number;
  header: BackupHeader | null;
  problem: string | null;
  /** Whether this server can restore it (a newer Tohyee's isn't). */
  compatible: boolean;
};

const MAX_FOUND = 500;

function mustBeFolder(folder: unknown): string {
  if (typeof folder !== "string" || !folder.trim()) throw new ValidationError("Say which folder the backups are in.");
  const text = folder.trim();
  if (!path.isAbsolute(text)) throw new ValidationError("The folder must be a full path, e.g. C:\\Users\\you\\OneDrive\\Tohyee backups.");
  return path.resolve(/* turbopackIgnore: true */ text);
}

function compatible(header: BackupHeader): boolean {
  return !(header.schemaVersion && header.schemaVersion > LATEST_TENANT_VERSION);
}

/**
 * The Tohyee backups in a folder on this computer and its sub-folders (two
 * levels: the backup folder, and one sub-folder per organisation). Only
 * `.tohyee-backup` files are looked at, and only their headers (no key).
 * Newest first.
 */
export async function findBackups(folderInput: unknown): Promise<{ folder: string; backups: FoundBackup[] }> {
  const folder = mustBeFolder(folderInput);
  const stat = await fs.stat(/* turbopackIgnore: true */ folder).catch(() => null);
  if (!stat?.isDirectory()) throw new ValidationError(`There's no folder ${folder} on this computer (or Tohyee isn't allowed to read it).`);
  const found: FoundBackup[] = [];
  const visit = async (dir: string, depth: number) => {
    const entries = await fs.readdir(/* turbopackIgnore: true */ dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (found.length >= MAX_FOUND) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && depth < 1) await visit(full, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(BACKUP_EXTENSION)) {
        const { size } = await fs.stat(full);
        let header: BackupHeader | null = null;
        let problem: string | null = null;
        try {
          header = (await readBackupHeader(full)).header;
        } catch (error) {
          problem = error instanceof Error ? error.message.replace(full, entry.name) : String(error);
        }
        found.push({ name: path.relative(folder, full), sizeBytes: size, header, problem, compatible: header ? compatible(header) : false });
      }
    }
  };
  await visit(folder, 0);
  found.sort((a, b) => ((a.header?.createdAt ?? "") < (b.header?.createdAt ?? "") ? 1 : -1));
  return { folder, backups: found };
}

/** A backup file named relative to a folder, refusing anything outside it. */
export function backupFileIn(folderInput: unknown, name: unknown): string {
  const folder = mustBeFolder(folderInput);
  if (typeof name !== "string" || !name.trim()) throw new ValidationError("Say which backup file.");
  const full = path.resolve(/* turbopackIgnore: true */ folder, name.trim());
  if (!full.startsWith(folder + path.sep) || !full.endsWith(BACKUP_EXTENSION)) throw new ValidationError("That isn't a backup file in that folder.");
  return full;
}

/**
 * The recovery material from the wizard: a recovery code or older backup
 * key typed in (`key`), or a recovery file's text and its passphrase.
 * Nothing means this server's own keys.
 */
export async function recoveryMaterial(input: { key?: unknown; kitFile?: unknown; passphrase?: unknown }): Promise<RecoveryMaterial | undefined> {
  if (typeof input.kitFile === "string" && input.kitFile.trim()) {
    const opened = await openRecoveryFile(input.kitFile, input.passphrase);
    return { recoveryKey: { version: opened.version, key: opened.key } };
  }
  return materialFromText(input.key);
}

export type BackupInspection = {
  header: BackupHeader;
  /** The whole file decrypted and read by PostgreSQL. */
  whole: true;
  compatible: boolean;
  /** The ID the restore would use, and whether that's the original's (this server doesn't have it). */
  suggestedId: string | null;
  originalIdFree: boolean;
};

/** Checks a backup fully with the given material, before anything is made: key, integrity and compatibility. */
export async function inspectBackup(file: string, material?: RecoveryMaterial): Promise<BackupInspection> {
  const { header } = await readBackupHeader(file);
  if (!compatible(header)) {
    throw new ValidationError(`That backup was made by a newer version of Tohyee (${header.tohyeeVersion}, database version ${header.schemaVersion}). Update this server first; nothing was changed.`);
  }
  await checkBackup(file, material);
  const suggestedId = header.kind === "organisation" && header.organisationId ? await suggestedRestoreId(header) : null;
  return { header, whole: true, compatible: true, suggestedId, originalIdFree: suggestedId !== null && suggestedId === header.organisationId };
}

// ------------------------------------------------------------------ scratch databases

function scratchName(): string {
  const core = coreDatabaseName().toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 20);
  return `${/^[a-z]/.test(core) ? core : "tohyee"}_scratch_${randomBytes(5).toString("hex")}`;
}

/** Restores a backup into a throwaway database, runs `work` on it, and always drops it. */
async function withScratchRestore<T>(file: string, material: RecoveryMaterial | undefined, work: (client: Awaited<ReturnType<typeof connectAsAdmin>>) => Promise<T>): Promise<T> {
  const name = scratchName();
  await getAdminPool().query(`create database ${quoteSqlIdentifier(name)}`);
  try {
    const restore = startPgTool("pg_restore", ["--no-owner", "--no-privileges", "--exit-on-error", `--dbname=${name}`], name);
    restore.child.stdout?.resume();
    const [fed, restored] = await Promise.allSettled([readDecrypted(file, restore.child.stdin!, material), restore.done]);
    if (restored.status === "rejected") throw restored.reason;
    if (fed.status === "rejected") throw fed.reason;
    const client = await connectAsAdmin(name);
    try {
      return await work(client);
    } finally {
      await client.end();
    }
  } finally {
    await getAdminPool().query(`drop database if exists ${quoteSqlIdentifier(name)} with (force)`).catch(() => undefined);
  }
}

// ------------------------------------------------------------------ test restores

async function count(client: { query: (sql: string) => Promise<{ rows: { n: string }[] }> }, table: string): Promise<number | null> {
  const exists = await client.query(`select (to_regclass('public.${table}') is not null)::text as n`);
  if (exists.rows[0]?.n !== "true") return null;
  return Number((await client.query(`select count(*)::text as n from ${table}`)).rows[0]?.n ?? 0);
}

/**
 * Test restores (decision 739): the newest backup of each database (or one
 * organisation) is restored into a scratch database, checked (its tables,
 * its books, and that every stored secret opens with the key that came with
 * it) and dropped. Nothing real is touched. Each is a `backup_checks` row.
 */
export async function testRestore(options: { requestedByEmail: string | null; organisationId?: string }): Promise<BackupCheck[]> {
  return withBackupLock("A backup or a check of the backups is already running. Try again when it has finished.", async () => {
    const root = (await getBackupSettings()).folder;
    const done: BackupCheck[] = [];
    for (const target of await backupTargets(options.organisationId)) {
      const folder = folderFor(root, target);
      const newest = (await datedBackupFiles(folder, target)).find((file) => file.readable);
      if (!newest) continue;
      const file = path.join(folder, newest.name);
      const fileName = path.join(path.basename(folder), newest.name);
      let status: "ok" | "failed" = "ok";
      let error: string | null = null;
      let details: Record<string, unknown> = {};
      try {
        const { header, sourceLiveKey } = await openBackupKeys(file);
        details = await withScratchRestore(file, undefined, async (client) => {
          const tables = Number((await client.query<{ n: string }>("select count(*)::text as n from information_schema.tables where table_schema = 'public'")).rows[0].n);
          const secrets: SecretsReport = await reEncryptStoredSecrets(client, sourceLiveKey, { dryRun: true });
          const result: Record<string, unknown> = { madeAt: header.createdAt, tables, secretsReadable: secrets.current + secrets.reEncrypted, secretsUnreadable: secrets.unreadable };
          if (header.kind === "organisation") {
            const settings = await client.query<{ organisation_id: string }>("select organisation_id from organisation_settings");
            if (settings.rows[0]?.organisation_id !== header.organisationId) throw new Error("The restored database isn't the organisation its backup says it is.");
            result.journals = await count(client, "ledger_journals");
            result.attachments = await count(client, "record_attachments");
            result.privateMailCopies = (await privateMailCopyOwners(client)).length;
          } else {
            result.users = await count(client, "users");
            result.organisations = await count(client, "organisations");
          }
          return result;
        });
        // A stored secret the backup's own live key doesn't open couldn't be read on the original server either
        // (left over from an earlier key change), so it's reported, not counted as the backup failing.
      } catch (caught) {
        status = "failed";
        error = caught instanceof Error ? caught.message : String(caught);
      }
      const row = await coreQuery<{ id: string }>(
        `insert into backup_checks (kind, organisation_id, status, finished_at, file_name, details, error, requested_by_email)
         values ('test_restore', $1, $2, now(), $3, $4::jsonb, $5, $6) returning id::text as id`,
        [target.organisationId, status, fileName, JSON.stringify(details), error?.slice(0, 2000) ?? null, options.requestedByEmail],
      );
      done.push({
        id: row.rows[0].id,
        kind: "test_restore",
        organisationId: target.organisationId,
        status,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        fileName,
        details,
        error,
        requestedByEmail: options.requestedByEmail,
      });
    }
    return done;
  });
}

// ------------------------------------------------------------------ people (full-server recovery)

type BackupUser = {
  id: string;
  email: string;
  display_name: string;
  password_hash: string;
  is_server_admin: boolean;
  is_active: boolean;
  totp_secret_ciphertext: string | null;
  totp_enabled_at: Date | null;
  password_changed_at: Date;
  created_at: Date;
};

export type PeoplePlan = {
  madeAt: string;
  add: { email: string; displayName: string; serverAdmin: boolean; twoStep: "kept" | "set up again" | "off" }[];
  alreadyHere: string[];
  /**
   * Same email here under another account (often the server admin made when
   * this server was set up): reported and left alone unless `replace` names
   * it; then the backup's account takes its place and its memberships here.
   */
  conflicts: { email: string; organisationsHere: number; replacing: boolean }[];
  memberships: { organisationId: string; email: string; role: string }[];
  /** Organisations in the server backup that aren't on this server: restore each from its own backup, keeping its ID. */
  organisationsNotHere: { id: string; displayName: string }[];
  /** Server settings in the backup that aren't copied (they'd compete with the original, or point at folders that differ here). */
  settingsNotCopied: string[];
  /**
   * Sign in with Google links that can't come back (decision 851): the
   * backup's Google account is linked to a different login here. Left with
   * that login; the person recovered has no Google sign-in (and, if they
   * had only Google, needs a setup link).
   */
  googleNotRestored: { email: string; googleEmail: string; linkedTo: string; needsSetupLink: boolean }[];
  /** Replaced accounts whose Google link here moves to the recovered account, as the backup has none for them (decision 851). */
  googleMoved: string[];
  applied: boolean;
};

/**
 * Recovering the people from a server backup (decision 738), for a
 * replacement computer: each user who isn't on this server comes back with
 * the same ID (so their private mail and history stay theirs), password and
 * two-step sign-in (its secret re-encrypted with this server's key), and
 * their memberships of organisations restored here with the same ID. A
 * person already here under the same email with another ID is reported and
 * left alone, unless `replace` names them: then the backup's account takes
 * the place of the one here, with its memberships here. A Google sign-in link
 * comes back too, unless that Google account is linked to a different login
 * here (reported, decision 851). Sessions, AI and app keys and server settings aren't
 * copied. With `apply` false it only says what it would do. It can be run
 * again after more organisations are restored.
 */
export async function recoverPeople(
  auth: ServerAdminAuth,
  input: { file: string; material?: RecoveryMaterial; apply?: boolean; replace?: unknown },
): Promise<PeoplePlan> {
  if (!auth.user.isServerAdmin) throw new ForbiddenError("Only a server admin can recover people from a backup.");
  const { header } = await readBackupHeader(input.file);
  if (header.kind !== "server") throw new ValidationError("That's an organisation's backup. People come from a backup of the server's own database (in the _server folder).");
  await checkBackup(input.file, input.material);
  const { sourceLiveKey } = await openBackupKeys(input.file, input.material);
  const replace = new Set(Array.isArray(input.replace) ? input.replace.filter((e): e is string => typeof e === "string").map((e) => e.trim().toLowerCase()) : []);

  const fromBackup = await withScratchRestore(input.file, input.material, async (client) => ({
    users: (
      await client.query<BackupUser>(
        "select id::text, email, display_name, password_hash, is_server_admin, is_active, totp_secret_ciphertext, totp_enabled_at, password_changed_at, created_at from users order by email",
      )
    ).rows,
    codes: (await client.query<{ user_id: string; code_hash: string; created_at: Date }>("select user_id::text, code_hash, created_at from user_backup_codes where used_at is null")).rows,
    members: (await client.query<{ organisation_id: string; user_id: string; role: string }>("select organisation_id, user_id::text, role from organisation_members")).rows,
    organisations: (await client.query<{ id: string; display_name: string }>("select id, display_name from organisations order by display_name, organisations.id")).rows,
    settings: (await client.query<{ key: string }>("select key from server_settings order by key")).rows.map((row) => row.key),
    // Sign in with Google links (#424), in backups made since it was added.
    google: (await client.query<{ present: boolean }>("select to_regclass('public.user_google_identities') is not null as present")).rows[0]?.present
      ? (
          await client.query<{ user_id: string; google_sub: string; email: string; linked_at: Date; google_only: boolean }>(
            "select g.user_id::text, g.google_sub, g.email, g.linked_at, u.google_only from user_google_identities g join users u on u.id = g.user_id",
          )
        ).rows
      : [],
  }));

  const here = (await coreQuery<{ id: string; email: string; memberships: string }>(
    "select u.id::text, u.email, (select count(*) from organisation_members m where m.user_id = u.id)::text as memberships from users u",
  )).rows;
  const hereById = new Map(here.map((u) => [u.id, u]));
  const hereByEmail = new Map(here.map((u) => [u.email, u]));
  const hereGoogle = (await coreQuery<{ user_id: string; google_sub: string; email: string }>("select user_id::text, google_sub, email from user_google_identities")).rows;
  const emailHere = (id: string) => here.find((u) => u.id === id)?.email ?? id;
  const orgsHere = new Set((await coreQuery<{ id: string }>("select id from organisations")).rows.map((row) => row.id));

  const plan: PeoplePlan = {
    madeAt: header.createdAt,
    add: [],
    alreadyHere: [],
    conflicts: [],
    memberships: [],
    organisationsNotHere: fromBackup.organisations.filter((o) => !orgsHere.has(o.id)).map((o) => ({ id: o.id, displayName: o.display_name })),
    settingsNotCopied: fromBackup.settings.filter((key) => !["backup_recovery_keys", "backup_recovery_kit_checks", "backup_key", "backups"].includes(key)),
    googleNotRestored: [],
    googleMoved: [],
    applied: false,
  };
  const toAdd: (BackupUser & { totp: string | null; replacesId: string | null })[] = [];
  for (const user of fromBackup.users) {
    if (hereById.has(user.id)) {
      plan.alreadyHere.push(user.email);
      continue;
    }
    const sameEmail = hereByEmail.get(user.email);
    let replacesId: string | null = null;
    if (sameEmail) {
      const replacing = replace.has(user.email);
      plan.conflicts.push({ email: user.email, organisationsHere: Number(sameEmail.memberships), replacing });
      if (!replacing) continue;
      replacesId = sameEmail.id;
    }
    let totp: string | null = null;
    let twoStep: "kept" | "set up again" | "off" = "off";
    if (user.totp_secret_ciphertext) {
      try {
        const plain = (() => {
          try {
            return decryptSecret(user.totp_secret_ciphertext!);
          } catch {
            return decryptSecretWithKey(user.totp_secret_ciphertext!, sourceLiveKey);
          }
        })();
        totp = encryptSecret(plain);
        twoStep = "kept";
      } catch {
        twoStep = "set up again";
      }
    }
    toAdd.push({ ...user, totp, replacesId });
    // Its Google link (decision 851): a link here on the account it replaces steps aside; one on another login stays there and is reported.
    const google = fromBackup.google.find((g) => g.user_id === user.id);
    const holder = google ? hereGoogle.find((g) => g.google_sub === google.google_sub) : undefined;
    if (google && holder && holder.user_id !== replacesId) {
      plan.googleNotRestored.push({ email: user.email, googleEmail: google.email, linkedTo: emailHere(holder.user_id), needsSetupLink: google.google_only });
    } else if (!google && replacesId && hereGoogle.some((g) => g.user_id === replacesId)) {
      plan.googleMoved.push(user.email);
    }
    plan.add.push({ email: user.email, displayName: user.display_name, serverAdmin: user.is_server_admin, twoStep });
  }
  const usersAfter = new Set([...here.map((u) => u.id).filter((id) => !toAdd.some((u) => u.replacesId === id)), ...toAdd.map((u) => u.id)]);
  const existingMembers = new Set((await coreQuery<{ k: string }>("select organisation_id || ':' || user_id::text as k from organisation_members")).rows.map((row) => row.k));
  for (const member of fromBackup.members) {
    if (!orgsHere.has(member.organisation_id) || !usersAfter.has(member.user_id) || existingMembers.has(`${member.organisation_id}:${member.user_id}`)) continue;
    const email = fromBackup.users.find((u) => u.id === member.user_id)?.email ?? member.user_id;
    plan.memberships.push({ organisationId: member.organisation_id, email, role: member.role });
  }
  // Never leave the server without an active server admin.
  const adminsAfter = [
    ...(await coreQuery<{ id: string }>("select id::text from users where is_server_admin and is_active")).rows.map((r) => r.id).filter((id) => !toAdd.some((u) => u.replacesId === id)),
    ...toAdd.filter((u) => u.is_server_admin && u.is_active).map((u) => u.id),
  ];
  if (adminsAfter.length === 0) throw new ValidationError("That would leave this server with no active server admin. Don't replace your own account, or make a server admin in the backup first.");
  if (!input.apply) return plan;

  // What happens to Google links is worked out again inside the transaction, from what's here then.
  plan.googleNotRestored = [];
  plan.googleMoved = [];
  await withCoreTransaction(async (client) => {
    for (const user of toAdd) {
      // The account here steps aside for the backup's (same person, same email), handing over its memberships.
      if (user.replacesId) await client.query("update users set email = $2 where id = $1", [user.replacesId, `replaced-${user.replacesId}@invalid.example`]);
      await client.query(
        `insert into users (id, email, display_name, password_hash, is_server_admin, is_active, password_changed_at, created_at, totp_secret_ciphertext, totp_enabled_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [user.id, user.email, user.display_name, user.password_hash, user.is_server_admin, user.is_active, user.password_changed_at, user.created_at, user.totp, user.totp ? user.totp_enabled_at : null],
      );
      // The replaced account's Google link comes off first, so the backup's (often the same Google account) can go on (decision 851).
      const replacedGoogle = user.replacesId
        ? (
            await client.query<{ google_sub: string; email: string; linked_at: Date; last_used_at: Date | null }>(
              "delete from user_google_identities where user_id = $1 returning google_sub, email, linked_at, last_used_at",
              [user.replacesId],
            )
          ).rows[0]
        : undefined;
      const google = fromBackup.google.find((g) => g.user_id === user.id);
      if (google) {
        const restored = await client.query(
          "insert into user_google_identities (user_id, google_sub, email, linked_at) values ($1, $2, $3, $4) on conflict do nothing returning user_id",
          [user.id, google.google_sub, google.email, google.linked_at],
        );
        if (restored.rowCount) {
          // Google only just when its Google link is really back: otherwise they'd have no way in that anyone could see.
          if (google.google_only) await client.query("update users set google_only = true where id = $1", [user.id]);
        } else {
          const holder = await client.query<{ email: string }>("select u.email from user_google_identities g join users u on u.id = g.user_id where g.google_sub = $1", [google.google_sub]);
          plan.googleNotRestored.push({ email: user.email, googleEmail: google.email, linkedTo: holder.rows[0]?.email ?? "another login", needsSetupLink: google.google_only });
        }
      } else if (replacedGoogle) {
        // The backup has no Google link for them: the one they made here comes with them, as the same person.
        await client.query(
          "insert into user_google_identities (user_id, google_sub, email, linked_at, last_used_at) values ($1, $2, $3, $4, $5)",
          [user.id, replacedGoogle.google_sub, replacedGoogle.email, replacedGoogle.linked_at, replacedGoogle.last_used_at],
        );
        plan.googleMoved.push(user.email);
      }
      for (const code of fromBackup.codes.filter((c) => c.user_id === user.id)) {
        await client.query("insert into user_backup_codes (user_id, code_hash, created_at) values ($1, $2, $3)", [user.id, code.code_hash, code.created_at]);
      }
      if (user.replacesId) {
        await client.query(
          "insert into organisation_members (organisation_id, user_id, role) select organisation_id, $2, role from organisation_members where user_id = $1 on conflict do nothing",
          [user.replacesId, user.id],
        );
        await client.query("delete from users where id = $1", [user.replacesId]);
      }
    }
    for (const member of fromBackup.members) {
      if (!plan.memberships.some((m) => m.organisationId === member.organisation_id && m.email === (fromBackup.users.find((u) => u.id === member.user_id)?.email ?? member.user_id))) continue;
      await client.query("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, $3) on conflict do nothing", [member.organisation_id, member.user_id, member.role]);
    }
    await writeAdminAuditEvent(client, { userId: auth.user.id, email: auth.user.email }, {
      eventType: "server.people_recovered",
      entityType: "server_setting",
      entityId: "users",
      details: {
        backupMadeAt: header.createdAt,
        added: plan.add.length,
        replaced: toAdd.filter((u) => u.replacesId).length,
        memberships: plan.memberships.length,
        conflicts: plan.conflicts.length,
        googleNotRestored: plan.googleNotRestored.map((g) => g.email),
        googleMoved: plan.googleMoved,
      },
    });
  });
  plan.applied = true;
  return plan;
}

export { mustBeFolder };
