import { createWriteStream, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import packageJson from "../../../package.json";
import { type AdminActor, type ServerAdminAuth, writeAdminAuditEvent } from "@/lib/audit";
import { normaliseEmail } from "@/lib/auth/service";
import { BACKUP_EXTENSION, type BackupHeader, readBackupHeader, readDecrypted, writeEncrypted } from "@/lib/backups/format";
import { startPgTool } from "@/lib/backups/pg-tools";
import { backupsToKeep } from "@/lib/backups/retention";
import { coreDatabaseName } from "@/lib/db/connection";
import { LATEST_TENANT_VERSION } from "@/lib/db/migrations";
import { connectAsAdmin, getAdminPool, getCorePool } from "@/lib/db/pools";
import { quoteSqlIdentifier } from "@/lib/db/sql";
import { coreQuery, withCoreTransaction } from "@/lib/db/transactions";
import { businessTimeZone } from "@/lib/dates";
import { ConflictError, ForbiddenError, NotFoundError, UnavailableError, ValidationError } from "@/lib/errors";
import { databaseNameFor, listAllOrganisations } from "@/lib/organisations/admin";
import { provisionOrganisation } from "@/lib/organisations/provisioning";
import { getOrganisation, parseOrganisationId, type OrganisationRecord } from "@/lib/organisations/registry";
import { secretsAvailable } from "@/lib/secrets";
import { deleteServerSetting, readServerSetting, writeServerSetting } from "@/lib/server-settings";

/**
 * Backups: every night (at a time the server admin picks, 2am by default) the
 * server dumps each organisation's database, and its own, into encrypted
 * files in the backup folder, one sub-folder per organisation. Pointing the
 * folder at a cloud-synced folder (OneDrive, say) gets copies off the
 * computer. Each file is checked after it's written, old ones are pruned
 * (14 daily + 12 monthly), and every attempt is recorded in backup_runs.
 * Restoring makes a copy of the organisation, so nothing is overwritten.
 */

type BackupValue = { enabled: boolean; folder: string | null; time: string };

export type BackupSettings = {
  enabled: boolean;
  folder: string;
  /** The folder used when none is chosen. */
  defaultFolder: string;
  time: string;
  timeZone: string;
  keySet: boolean;
  updatedAt: string | null;
  updatedByEmail: string | null;
};

export type BackupRun = {
  id: string;
  organisationId: string | null;
  trigger: "schedule" | "manual" | "update";
  status: "running" | "ok" | "failed";
  startedAt: string;
  finishedAt: string | null;
  filePath: string | null;
  sizeBytes: number | null;
  error: string | null;
};

export type BackupFile = {
  /** Path relative to the backup folder, e.g. green-island/green-island_2026-09-28_020000.tohyee-backup */
  name: string;
  path: string;
  sizeBytes: number;
  header: BackupHeader | null;
  problem: string | null;
};

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const SERVER_FOLDER = "_server";

export function defaultBackupFolder(): string {
  const configured = process.env.TOHYEE_BACKUP_DIR?.trim();
  if (configured) return configured;
  if (process.platform === "win32") {
    return path.join(process.env.ProgramData || "C:\\ProgramData", "Tohyee", "backups");
  }
  return path.join(process.cwd(), "backups");
}

/** Local date and time parts in the business time zone. */
export function localParts(when: Date): { date: string; time: string; stamp: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: businessTimeZone(),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(when);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  const date = `${get("year")}-${get("month")}-${get("day")}`;
  return { date, time: `${get("hour")}:${get("minute")}`, stamp: `${date}_${get("hour")}${get("minute")}${get("second")}` };
}

// ------------------------------------------------------------------ settings

export async function getBackupSettings(): Promise<BackupSettings> {
  const stored = await readServerSetting<BackupValue, Record<string, never>>("backups");
  const defaultFolder = defaultBackupFolder();
  return {
    enabled: stored.value.enabled ?? true,
    folder: stored.value.folder || defaultFolder,
    defaultFolder,
    time: stored.value.time ?? "02:00",
    timeZone: businessTimeZone(),
    keySet: secretsAvailable(),
    updatedAt: stored.updatedAt,
    updatedByEmail: stored.updatedByEmail,
  };
}

/** Checks the server can make, write and delete files in the folder. */
async function assertWritableFolder(folder: string): Promise<void> {
  const probe = path.join(folder, `.tohyee-write-test-${process.pid}-${Date.now()}`);
  try {
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(probe, "Tohyee checks it can write backups here. This file is deleted straight away.");
    await fs.rm(probe, { force: true });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    let who = "";
    try {
      who = `, running as ${os.userInfo().username}`;
    } catch {
      who = "";
    }
    throw new ValidationError(`Tohyee (the server${who}) can't write to ${folder}: ${reason}`);
  }
}

/** Saves the backup settings: `enabled`, `folder` (blank = the default), `time` (HH:MM, 24-hour). `reset: true` goes back to the defaults. */
export async function updateBackupSettings(
  auth: ServerAdminAuth,
  input: { enabled?: unknown; folder?: unknown; time?: unknown; reset?: unknown },
): Promise<BackupSettings> {
  if (!auth.user.isServerAdmin) throw new ForbiddenError("Only a server admin can change backups.");
  const actor = { userId: auth.user.id, email: auth.user.email };
  if (input.reset === true) {
    await withCoreTransaction(async (client) => {
      await deleteServerSetting(client, "backups");
      await writeAdminAuditEvent(client, actor, { eventType: "server.backups_reset", entityType: "server_setting", entityId: "backups" });
    });
    return getBackupSettings();
  }
  const current = await getBackupSettings();
  const stored = await readServerSetting<BackupValue, Record<string, never>>("backups");
  let enabled = current.enabled;
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== "boolean") throw new ValidationError("enabled must be true or false.");
    enabled = input.enabled;
  }
  let time = current.time;
  if (input.time !== undefined) {
    if (typeof input.time !== "string" || !TIME_PATTERN.test(input.time.trim())) {
      throw new ValidationError("The time is 24-hour HH:MM, e.g. 02:00.");
    }
    time = input.time.trim();
  }
  let folder = stored.value.folder ?? null;
  if (input.folder !== undefined) {
    if (input.folder !== null && typeof input.folder !== "string") throw new ValidationError("folder must be a path.");
    const text = (input.folder ?? "").trim();
    if (!text) {
      folder = null;
    } else {
      if (!path.isAbsolute(text)) throw new ValidationError("The backup folder must be a full path, e.g. C:\\Users\\you\\OneDrive\\Tohyee backups.");
      folder = path.normalize(text);
    }
  }
  await assertWritableFolder(folder ?? current.defaultFolder);
  await withCoreTransaction(async (client) => {
    await writeServerSetting<BackupValue, Record<string, never>>(client, "backups", { enabled, folder, time }, {}, auth.user.email);
    await writeAdminAuditEvent(client, actor, {
      eventType: "server.backups_updated",
      entityType: "server_setting",
      entityId: "backups",
      details: { enabled, folder, time },
    });
  });
  return getBackupSettings();
}

// ------------------------------------------------------------------ making backups

type Target = { organisationId: string | null; displayName: string | null; databaseName: string; schemaVersion: string | null };

function folderFor(root: string, target: Target): string {
  return path.join(root, target.organisationId ?? SERVER_FOLDER);
}

function filePrefix(target: Target): string {
  return target.organisationId ?? "server";
}

async function targets(organisationId?: string): Promise<Target[]> {
  const organisations = (await listAllOrganisations()).filter((o) => o.provisioningStatus === "ready");
  if (organisationId) {
    const one = organisations.find((o) => o.id === organisationId);
    if (!one) throw new NotFoundError(`There's no ready organisation with the ID ${organisationId}.`);
    return [toTarget(one)];
  }
  return [
    { organisationId: null, displayName: null, databaseName: coreDatabaseName(), schemaVersion: null },
    ...organisations.map(toTarget),
  ];
}

function toTarget(o: OrganisationRecord): Target {
  return { organisationId: o.id, displayName: o.displayName, databaseName: o.databaseName, schemaVersion: o.schemaVersion };
}

/** Decrypts a backup into `pg_restore --list`: proves the key opens it, nothing was changed, and PostgreSQL can read it. */
export async function checkBackup(file: string, otherKey?: string): Promise<BackupHeader> {
  const restore = startPgTool("pg_restore", ["--list"], "postgres");
  restore.child.stdout?.resume();
  // pg_restore --list stops reading after the table of contents, but the whole
  // file still has to be decrypted for its tag (the tamper check) to be
  // checked, so keep reading and drop what pg_restore no longer wants.
  const stdin = restore.child.stdin!;
  let open = true;
  stdin.on("error", () => {
    open = false;
  });
  stdin.on("close", () => {
    open = false;
  });
  const feed = new Writable({
    write(chunk, _encoding, callback) {
      if (!open) return callback();
      if (stdin.write(chunk)) return callback();
      const resume = () => {
        stdin.off("drain", resume);
        stdin.off("close", resume);
        callback();
      };
      stdin.on("drain", resume);
      stdin.on("close", resume);
    },
    final(callback) {
      if (open) stdin.end();
      callback();
    },
  });
  const [header] = await Promise.all([readDecrypted(file, feed, otherKey), restore.done]);
  return header;
}

async function backUpTarget(root: string, target: Target, trigger: BackupRun["trigger"], requestedByEmail: string | null): Promise<BackupRun> {
  const run = await coreQuery<{ id: string }>(
    "insert into backup_runs (organisation_id, trigger, requested_by_email) values ($1, $2, $3) returning id::text as id",
    [target.organisationId, trigger, requestedByEmail],
  );
  const runId = run.rows[0].id;
  const folder = folderFor(root, target);
  const finalPath = path.join(folder, `${filePrefix(target)}_${localParts(new Date()).stamp}${BACKUP_EXTENSION}`);
  const partial = `${finalPath}.partial`;
  try {
    await fs.mkdir(folder, { recursive: true });
    const dump = startPgTool("pg_dump", ["--format=custom", "--no-owner", "--no-privileges"], target.databaseName);
    dump.child.stdin?.end();
    const out = createWriteStream(partial, { mode: 0o600 });
    await Promise.all([
      writeEncrypted(dump.child.stdout!, out, {
        kind: target.organisationId ? "organisation" : "server",
        organisationId: target.organisationId,
        displayName: target.displayName,
        databaseName: target.databaseName,
        schemaVersion: target.schemaVersion,
        createdAt: new Date().toISOString(),
        tohyeeVersion: packageJson.version,
      }),
      dump.done,
    ]).catch(async (error) => {
      out.destroy();
      throw error;
    });
    await checkBackup(partial);
    await fs.rename(partial, finalPath);
    const { size } = await fs.stat(finalPath);
    const done = await coreQuery<RunRow>(
      `update backup_runs set status = 'ok', finished_at = now(), file_path = $2, size_bytes = $3
        where id = $1 returning ${RUN_COLUMNS}`,
      [runId, finalPath, size],
    );
    await prune(folder, filePrefix(target));
    return toRun(done.rows[0]);
  } catch (error) {
    await fs.rm(partial, { force: true }).catch(() => undefined);
    const message = error instanceof Error ? error.message : String(error);
    const failed = await coreQuery<RunRow>(
      `update backup_runs set status = 'failed', finished_at = now(), error = $2 where id = $1 returning ${RUN_COLUMNS}`,
      [runId, message.slice(0, 2000)],
    );
    return toRun(failed.rows[0]);
  }
}

const BACKUP_NAME = /^([a-z0-9][a-z0-9-]*)_(\d{4}-\d{2}-\d{2}_\d{6})\.tohyee-backup$/;

/** Deletes old backups in one organisation's folder (only Tohyee backup files with that organisation's prefix). */
async function prune(folder: string, prefix: string): Promise<string[]> {
  const names = await fs.readdir(folder).catch(() => [] as string[]);
  const dated = names
    .map((name) => ({ name, match: BACKUP_NAME.exec(name) }))
    .filter((entry) => entry.match && entry.match[1] === prefix)
    .map((entry) => ({ name: entry.name, stamp: entry.match![2] }));
  const keep = backupsToKeep(dated);
  const removed: string[] = [];
  for (const backup of dated) {
    if (!keep.has(backup.name)) {
      await fs.rm(path.join(folder, backup.name), { force: true });
      removed.push(backup.name);
    }
  }
  return removed;
}

const BACKUP_LOCK = "tohyee:backups";

/**
 * Backs up every organisation and the server's own database (or one
 * organisation). One backup job runs at a time across the server; a second
 * request while one is running is refused.
 */
export async function backUpNow(options: {
  trigger: "schedule" | "manual" | "update";
  requestedByEmail: string | null;
  organisationId?: string;
  /** Only these targets (the scheduler retries the ones that failed). */
  only?: (string | null)[];
}): Promise<BackupRun[]> {
  if (!secretsAvailable()) {
    throw new UnavailableError("Backups are encrypted with TOHYEE_SECRET_KEY, and it isn't set. Set it in the server's environment and restart Tohyee.");
  }
  const organisationId = options.organisationId ? parseOrganisationId(options.organisationId) : undefined;
  const lock = await getCorePool().connect();
  try {
    const locked = await lock.query<{ ok: boolean }>("select pg_try_advisory_lock(hashtext($1)) as ok", [BACKUP_LOCK]);
    if (!locked.rows[0]?.ok) throw new ConflictError("A backup is already running. Try again when it has finished.");
    try {
      const settings = await getBackupSettings();
      let list = await targets(organisationId);
      if (options.only) list = list.filter((t) => options.only!.includes(t.organisationId));
      const runs: BackupRun[] = [];
      for (const target of list) {
        runs.push(await backUpTarget(settings.folder, target, options.trigger, options.requestedByEmail));
      }
      return runs;
    } finally {
      await lock.query("select pg_advisory_unlock(hashtext($1))", [BACKUP_LOCK]);
    }
  } finally {
    lock.release();
  }
}

// ------------------------------------------------------------------ what's there

type RunRow = {
  id: string;
  organisation_id: string | null;
  trigger: BackupRun["trigger"];
  status: BackupRun["status"];
  started_at: Date;
  finished_at: Date | null;
  file_path: string | null;
  size_bytes: string | null;
  error: string | null;
};
const RUN_COLUMNS = "id::text as id, organisation_id, trigger, status, started_at, finished_at, file_path, size_bytes::text as size_bytes, error";

/**
 * Backups cut off by a restart (#137): a run still "running" that began
 * before `processStartedAt` and over an hour ago can't finish, so it's marked
 * failed (and the nightly backup tries again), and the half-written
 * `.partial` files left in the folder are removed.
 */
export async function markInterruptedBackups(processStartedAt: Date, now = new Date()): Promise<BackupRun[]> {
  const cutOff = new Date(Math.min(processStartedAt.getTime(), now.getTime() - 60 * 60 * 1000));
  const marked = await coreQuery<RunRow>(
    `update backup_runs set status = 'failed', finished_at = now(), error = 'Interrupted: the server stopped while this backup ran.'
      where status = 'running' and started_at < $1 returning ${RUN_COLUMNS}`,
    [cutOff],
  );
  if (marked.rowCount) {
    const root = (await getBackupSettings()).folder;
    const folders = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of folders) {
      if (!entry.isDirectory()) continue;
      const folder = path.join(root, entry.name);
      for (const name of await fs.readdir(folder).catch(() => [] as string[])) {
        if (!name.endsWith(`${BACKUP_EXTENSION}.partial`)) continue;
        const file = path.join(folder, name);
        const stat = await fs.stat(file).catch(() => null);
        if (stat && stat.mtime < cutOff) await fs.rm(file, { force: true }).catch(() => undefined);
      }
    }
  }
  return marked.rows.map(toRun);
}

function toRun(row: RunRow): BackupRun {
  return {
    id: row.id,
    organisationId: row.organisation_id,
    trigger: row.trigger,
    status: row.status,
    startedAt: new Date(row.started_at).toISOString(),
    finishedAt: row.finished_at ? new Date(row.finished_at).toISOString() : null,
    filePath: row.file_path,
    sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
    error: row.error,
  };
}

/** The latest backup attempt, and the latest good one, for the server and each organisation. */
export async function backupStatus(): Promise<{ organisationId: string | null; displayName: string | null; latest: BackupRun | null; lastGood: BackupRun | null }[]> {
  const all = await targets();
  const latest = await coreQuery<RunRow>(
    `select distinct on (organisation_id) ${RUN_COLUMNS} from backup_runs order by organisation_id, started_at desc, id desc`,
  );
  const good = await coreQuery<RunRow>(
    `select distinct on (organisation_id) ${RUN_COLUMNS} from backup_runs where status = 'ok' order by organisation_id, started_at desc, id desc`,
  );
  const find = (rows: RunRow[], id: string | null) => {
    const row = rows.find((r) => r.organisation_id === id);
    return row ? toRun(row) : null;
  };
  return all.map((t) => ({
    organisationId: t.organisationId,
    displayName: t.displayName,
    latest: find(latest.rows, t.organisationId),
    lastGood: find(good.rows, t.organisationId),
  }));
}

/** Recent backup attempts, newest first. */
export async function recentBackupRuns(limit = 50): Promise<BackupRun[]> {
  const result = await coreQuery<RunRow>(`select ${RUN_COLUMNS} from backup_runs order by started_at desc, id desc limit $1`, [limit]);
  return result.rows.map(toRun);
}

/** The backup files in the backup folder (one organisation's, or all), newest first. */
export async function listBackupFiles(organisationId?: string): Promise<BackupFile[]> {
  const root = (await getBackupSettings()).folder;
  const folders = organisationId ? [parseOrganisationId(organisationId)] : await fs.readdir(root).catch(() => [] as string[]);
  const files: BackupFile[] = [];
  for (const folder of folders) {
    const names = await fs.readdir(path.join(root, folder)).catch(() => [] as string[]);
    for (const name of names.filter((n) => n.endsWith(BACKUP_EXTENSION))) {
      const full = path.join(root, folder, name);
      const { size } = await fs.stat(full);
      let header: BackupHeader | null = null;
      let problem: string | null = null;
      try {
        header = (await readBackupHeader(full)).header;
      } catch (error) {
        problem = error instanceof Error ? error.message : String(error);
      }
      files.push({ name: path.join(folder, name), path: full, sizeBytes: size, header, problem });
    }
  }
  return files.sort((a, b) => ((a.header?.createdAt ?? "") < (b.header?.createdAt ?? "") ? 1 : -1));
}

/** A backup file named relative to the backup folder, refusing anything outside it. */
export async function backupFileInFolder(name: unknown): Promise<string> {
  if (typeof name !== "string" || !name.trim()) throw new ValidationError("Say which backup file.");
  const root = path.resolve((await getBackupSettings()).folder);
  const full = path.resolve(root, name.trim());
  if (!full.startsWith(root + path.sep) || !full.endsWith(BACKUP_EXTENSION)) {
    throw new ValidationError("That isn't a backup file in the backup folder.");
  }
  return full;
}

// ------------------------------------------------------------------ restoring

/**
 * Restores an organisation's backup as a new organisation (a copy), so the
 * current books are never overwritten. The copy gets the same members as the
 * original (or `ownerEmail`, when the original is gone), is brought up to this
 * server's version, and can be checked before anyone switches to it.
 */
export async function restoreBackupAsCopy(
  actor: AdminActor,
  input: { file: string; id?: unknown; displayName?: unknown; ownerEmail?: unknown; key?: unknown },
): Promise<OrganisationRecord> {
  // The backup key of the server that made it, when that isn't this one.
  const otherKey = typeof input.key === "string" && input.key.trim() ? input.key.trim() : undefined;
  if (!otherKey && !secretsAvailable()) throw new UnavailableError("Restoring needs the backup key the backup was made with.");
  const { header } = await readBackupHeader(input.file);
  if (header.kind !== "organisation" || !header.organisationId) {
    throw new ValidationError("That's a backup of the server's own database (users and settings), not of an organisation. Restoring it is a job for a database administrator (see docs/ARCHITECTURE.md).");
  }
  if (header.schemaVersion && header.schemaVersion > LATEST_TENANT_VERSION) {
    throw new ValidationError(`That backup was made by a newer version of Tohyee (${header.tohyeeVersion}). Update this server first.`);
  }
  // Proves the key is right and the file is whole before anything is created.
  await checkBackup(input.file, otherKey);

  const made = localParts(new Date(header.createdAt));
  const id = parseOrganisationId(
    input.id == null || input.id === "" ? `${header.organisationId}-${made.date.replace(/-/g, "")}`.slice(0, 32) : input.id,
  );
  const displayName =
    typeof input.displayName === "string" && input.displayName.trim()
      ? input.displayName.trim().slice(0, 150)
      : `${header.displayName ?? header.organisationId} (restored from ${made.date})`.slice(0, 150);
  const databaseName = databaseNameFor(id);

  const source = await getOrganisation(header.organisationId);
  await withCoreTransaction(async (client) => {
    const exists = await client.query("select 1 from organisations where id = $1 or database_name = $2", [id, databaseName]);
    if (exists.rowCount) throw new ConflictError(`There's already an organisation with the ID ${id}. Choose another ID for the copy.`);
    // A database by that name that isn't in the registry (another install sharing the server, or one left behind)
    // is never touched: the copy is refused, so the clean-up below can't drop it (#135).
    const taken = await getAdminPool().query("select 1 from pg_database where datname = $1", [databaseName]);
    if (taken.rowCount) {
      throw new ConflictError(`There's already a database called ${databaseName} on this PostgreSQL server. Choose another ID for the copy.`);
    }
    const members = source
      ? (await client.query<{ user_id: string; role: string }>("select user_id, role from organisation_members where organisation_id = $1", [source.id])).rows
      : [];
    if (input.ownerEmail != null && input.ownerEmail !== "") {
      const owner = await client.query<{ id: string }>("select id from users where email = $1 and is_active", [normaliseEmail(input.ownerEmail)]);
      if (!owner.rows[0]) throw new ValidationError(`There's no active user with the email ${normaliseEmail(input.ownerEmail)}.`);
      if (!members.some((m) => m.user_id === owner.rows[0].id)) members.push({ user_id: owner.rows[0].id, role: "owner" });
    } else if (actor.id && !members.some((m) => m.user_id === actor.id)) {
      members.push({ user_id: actor.id, role: "owner" });
    }
    if (!members.some((m) => m.role === "owner")) {
      throw new ValidationError("The original organisation is gone, so say who owns the copy (ownerEmail).");
    }
    await client.query(
      `insert into organisations (id, display_name, database_name, base_currency, created_by)
       values ($1, $2, $3, coalesce($4, 'NZD'), $5)`,
      [id, displayName, databaseName, source?.baseCurrency ?? null, actor.id],
    );
    for (const member of members) {
      await client.query("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, $3)", [id, member.user_id, member.role]);
    }
    await writeAdminAuditEvent(client, { userId: actor.id, email: actor.email }, {
      eventType: "organisation.restored_from_backup",
      entityType: "organisation",
      entityId: id,
      details: { from: header.organisationId, backupMadeAt: header.createdAt, file: path.basename(input.file), displayName },
    });
  });

  // Only a database this call made is dropped if the restore fails (#135).
  let created = false;
  try {
    await getAdminPool().query(`create database ${quoteSqlIdentifier(databaseName)}`);
    created = true;
    const restore = startPgTool("pg_restore", ["--no-owner", "--no-privileges", "--exit-on-error", `--dbname=${databaseName}`], databaseName);
    restore.child.stdout?.resume();
    const [fed, restored] = await Promise.allSettled([readDecrypted(input.file, restore.child.stdin!, otherKey), restore.done]);
    // If pg_restore stopped, its own message says why (feeding it then fails with a broken pipe).
    if (restored.status === "rejected") throw restored.reason;
    if (fed.status === "rejected") throw fed.reason;
    const admin = await connectAsAdmin(databaseName);
    try {
      await admin.query("update organisation_settings set organisation_id = $1, display_name = $2, updated_at = now() where id = true", [id, displayName]);
    } finally {
      await admin.end();
    }
    await provisionOrganisation(id);
  } catch (error) {
    // Leave nothing half-restored behind.
    if (created) await getAdminPool().query(`drop database if exists ${quoteSqlIdentifier(databaseName)} with (force)`).catch(() => undefined);
    await withCoreTransaction(async (client) => {
      await client.query("delete from organisation_members where organisation_id = $1", [id]);
      await client.query("delete from organisations where id = $1", [id]);
      await writeAdminAuditEvent(client, { userId: actor.id, email: actor.email }, {
        eventType: "organisation.restore_failed",
        entityType: "organisation",
        entityId: id,
        details: { error: error instanceof Error ? error.message.slice(0, 500) : String(error) },
      });
    }).catch(() => undefined);
    throw error;
  }
  return (await getOrganisation(id))!;
}

/** Decrypts a backup to a plain pg_dump file, for a database administrator (e.g. restoring the server's own database). */
export async function decryptBackupTo(file: string, outFile: string, otherKey?: string): Promise<BackupHeader> {
  await checkBackup(file, otherKey);
  const out = createWriteStream(outFile, { mode: 0o600, flags: "wx" });
  return readDecrypted(file, out, otherKey);
}
