/**
 * Server settings from the command line, run on the server itself, straight
 * against the database (no web login needed). It covers everything the
 * Windows server app does, for Docker and Linux servers, plus the break-glass
 * commands for a locked-out admin. Run `npm run admin -- help` for the list.
 *
 * Passwords and tokens are read from environment variables or asked for
 * (without showing what you type), so they don't end up in shell history.
 * Every change is recorded in the server's audit trail as "cli".
 */
import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";
import { COMMAND_LINE_ADMIN } from "@/lib/audit";
import { hashPassword, validateNewPassword } from "@/lib/auth/password";
import { normaliseEmail, parseDisplayName } from "@/lib/auth/service";
import { resetTwoStep } from "@/lib/auth/two-step";
import { closeAllPools } from "@/lib/db/pools";
import { coreQuery, withCoreTransaction } from "@/lib/db/transactions";
import { getEmailSettings, sendEmail, updateEmailSettings } from "@/lib/email/mailer";
import {
  createOrganisation,
  listAllOrganisations,
  retryProvisioning,
  updateOrganisation,
} from "@/lib/organisations/admin";
import { getRemoteAccess, updateRemoteAccess } from "@/lib/remote/settings";
import { getLatestReleaseCheck } from "@/lib/updates/server-updates";
import { backupKeyStatus, checkSavedBackupKey, revealBackupKey } from "@/lib/backups/key";
import {
  backUpNow,
  backupStatus,
  checkBackup,
  decryptBackupTo,
  getBackupSettings,
  listBackupFiles,
  restoreBackupAsCopy,
  updateBackupSettings,
} from "@/lib/backups/service";
import { listUsers, updateUser } from "@/lib/users/admin";

const actor = COMMAND_LINE_ADMIN.user;

const HELP = `Tohyee server settings from the command line.

  npm run admin -- <area> <command> [options]
  (Docker: docker compose exec tohyee node tohyee-admin.cjs <area> <command> [options])

Organisations
  organisations list [--json]
  organisations create --id ID --name NAME [--currency NZD] [--owner EMAIL]
  organisations rename --id ID --name NAME
  organisations take-out-of-use --id ID
  organisations put-back --id ID
  organisations repair --id ID              retry a failed set-up or upgrade

Users
  users list [--json]
  users create --email EMAIL --name NAME [--server-admin]   password: TOHYEE_PASSWORD or asked
  users rename --email EMAIL --name NAME
  users set-password --email EMAIL          password: TOHYEE_PASSWORD or asked
  users login --email EMAIL --on|--off      allow or stop them signing in
  users server-admin --email EMAIL --on|--off
  users reset-two-step --email EMAIL        lost phone: they set it up again at next sign-in

Remote access (Cloudflare Tunnel)
  remote-access show [--json]
  remote-access set --on|--off [--token] [--url https://books.example.nz]
                                            --token: TOHYEE_TUNNEL_TOKEN or asked
  remote-access clear
  (Restart Tohyee afterwards: the running server starts or stops the tunnel when it starts.)

Email (for security alerts and two-step reset links)
  email show [--json]
  email set --host HOST --port 465|587 --username USER [--from ADDRESS] [--from-name NAME]
                                            password: TOHYEE_EMAIL_PASSWORD or asked (blank keeps the saved one)
  email test --to EMAIL
  email clear

Backups (encrypted with TOHYEE_SECRET_KEY: keep a copy of that key somewhere safe)
  backups status [--json]                   each database's latest and last good backup
  backups set [--on|--off] [--folder PATH] [--time 02:00]
                                            --folder "" goes back to the default folder
  backups run [--id ORGANISATION]           back up now (everything, or one organisation)
  backups list [--id ORGANISATION] [--json]
  backups check --file FILE                 prove a backup opens and PostgreSQL can read it
  backups restore --file FILE [--id NEW-ID] [--name NAME] [--owner EMAIL] [--other-key]
                                            restores as a new organisation (a copy); nothing is overwritten
  backups decrypt --file FILE --out DUMP [--other-key]
                                            a plain pg_dump file, for a database administrator
                                            --other-key: the backup was made on another server; its key
                                            from TOHYEE_BACKUP_KEY or asked
  backups key show                          the backup key, to save somewhere safe (not with the backups)
  backups key check                         checks your saved copy (TOHYEE_BACKUP_KEY or asked)

Updates
  updates check [--json]

The older forms still work: create-user, set-password, reset-two-step.`;

// ------------------------------------------------------------------ input

class UsageError extends Error {}

function option(args: string[], name: string): string | null {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return null;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new UsageError(`--${name} needs a value.`);
  return value;
}

function required(args: string[], name: string): string {
  const value = option(args, name);
  if (value === null) throw new UsageError(`--${name} is required.`);
  return value;
}

function flag(args: string[], name: string): boolean {
  return args.includes(`--${name}`);
}

/** --on or --off, exactly one. */
function onOff(args: string[]): boolean {
  const on = flag(args, "on");
  const off = flag(args, "off");
  if (on === off) throw new UsageError("Say --on or --off.");
  return on;
}

/** Asks for a secret without showing what's typed (when it's a terminal). */
async function askSecret(prompt: string): Promise<string> {
  if (!stdin.isTTY) {
    throw new UsageError(`${prompt.replace(/:\s*$/, "")}: set it in an environment variable (see help); there's no terminal to ask in.`);
  }
  const rl = createInterface({ input: stdin, output: stdout, terminal: true });
  const writer = rl as unknown as { _writeToOutput: (text: string) => void };
  let muted = false;
  writer._writeToOutput = (text: string) => {
    if (!muted || text.includes("\n")) stdout.write(muted ? "\n" : text);
  };
  try {
    return await new Promise<string>((resolve) => {
      rl.question(prompt, (answer) => resolve(answer));
      muted = true;
    });
  } finally {
    rl.close();
  }
}

async function secret(envName: string, prompt: string): Promise<string> {
  const fromEnv = process.env[envName];
  if (fromEnv !== undefined) return fromEnv;
  return askSecret(prompt);
}

const readPassword = () => secret("TOHYEE_PASSWORD", "New password (10+ characters): ");

// ------------------------------------------------------------------ output

function table(rows: Record<string, string>[]): void {
  if (rows.length === 0) {
    console.log("(none)");
    return;
  }
  const headers = Object.keys(rows[0]);
  const widths = headers.map((h) => Math.max(h.length, ...rows.map((r) => r[h].length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
  console.log(line(headers));
  console.log(line(widths.map((w) => "-".repeat(w))));
  for (const row of rows) console.log(line(headers.map((h) => row[h])));
}

function show(args: string[], value: unknown, print: () => void): void {
  if (flag(args, "json")) console.log(JSON.stringify(value, null, 2));
  else print();
}

// ------------------------------------------------------------------ helpers

async function audit(eventType: string, userId: string, details: Record<string, unknown>) {
  await coreQuery(
    `insert into admin_audit_events (event_type, entity_type, entity_id, actor_email, details)
     values ($1, 'user', $2, 'cli', $3::jsonb)`,
    [eventType, userId, JSON.stringify(details)],
  );
}

async function userIdFor(emailInput: string): Promise<string> {
  const email = normaliseEmail(emailInput);
  const found = await coreQuery<{ id: string }>("select id from users where email = $1", [email]);
  const id = found.rows[0]?.id;
  if (!id) throw new Error(`No user with the email ${email}.`);
  return id;
}

function organisationStatus(o: { isActive: boolean; provisioningStatus: string; migrationStatus: string }): string {
  if (o.provisioningStatus === "failed") return "set-up failed (run repair)";
  if (o.migrationStatus === "failed") return "upgrade failed (run repair)";
  if (o.provisioningStatus !== "ready") return "being set up";
  return o.isActive ? "in use" : "out of use";
}

// ------------------------------------------------------------------ commands

async function organisations(command: string | undefined, args: string[]) {
  if (command === "list") {
    const list = await listAllOrganisations();
    show(args, list, () =>
      table(
        list.map((o) => ({
          ID: o.id,
          Name: o.displayName,
          Currency: o.baseCurrency,
          Members: String(o.memberCount),
          Status: organisationStatus(o),
          Database: o.databaseName,
        })),
      ),
    );
    return;
  }
  if (command === "create") {
    const ownerEmail = option(args, "owner");
    if (!ownerEmail) throw new UsageError("--owner EMAIL is required: the command-line tool isn't a user, so say who owns the new organisation.");
    const organisation = await createOrganisation(actor, {
      id: required(args, "id"),
      displayName: required(args, "name"),
      baseCurrency: option(args, "currency") ?? undefined,
      ownerEmail,
    });
    if (organisation.provisioningStatus === "ready") {
      console.log(`Created ${organisation.displayName} (${organisation.id}), owned by ${normaliseEmail(ownerEmail)}.`);
    } else {
      console.log(`Registered ${organisation.id}, but setting up its database failed: ${organisation.provisioningError ?? "see the server log"}. Run "organisations repair --id ${organisation.id}" to try again.`);
      process.exitCode = 1;
    }
    return;
  }
  if (command === "rename") {
    const organisation = await updateOrganisation(actor, required(args, "id"), { displayName: required(args, "name") });
    console.log(`Renamed ${organisation.id} to ${organisation.displayName}.`);
    return;
  }
  if (command === "take-out-of-use" || command === "put-back") {
    const isActive = command === "put-back";
    const organisation = await updateOrganisation(actor, required(args, "id"), { isActive });
    console.log(isActive ? `${organisation.displayName} is back in use.` : `${organisation.displayName} is out of use: nobody can open its books until it's put back.`);
    return;
  }
  if (command === "repair") {
    const organisation = await retryProvisioning(actor, required(args, "id"));
    console.log(`${organisation.displayName}: ${organisationStatus(organisation)}.`);
    if (organisation.provisioningStatus !== "ready" || organisation.migrationStatus !== "current") process.exitCode = 1;
    return;
  }
  throw new UsageError(`Unknown organisations command${command ? ` "${command}"` : ""}.`);
}

async function createUserCommand(args: string[]) {
  const email = normaliseEmail(required(args, "email"));
  const displayName = parseDisplayName(required(args, "name"));
  const isServerAdmin = flag(args, "server-admin");
  const passwordHash = await hashPassword(validateNewPassword(await readPassword()));
  const inserted = await coreQuery<{ id: string }>(
    `insert into users (email, display_name, password_hash, is_server_admin)
     values ($1, $2, $3, $4)
     on conflict (email) do nothing
     returning id`,
    [email, displayName, passwordHash, isServerAdmin],
  );
  if (!inserted.rows[0]) throw new Error(`There's already a user with the email ${email}.`);
  await audit("user.created_via_cli", inserted.rows[0].id, { email, isServerAdmin });
  console.log(`Created ${email}${isServerAdmin ? " (server admin)" : ""}.`);
}

async function setPasswordCommand(args: string[]) {
  const email = normaliseEmail(required(args, "email"));
  const passwordHash = await hashPassword(validateNewPassword(await readPassword()));
  const updated = await coreQuery<{ id: string }>(
    `update users
        set password_hash = $2, password_changed_at = now(), failed_login_count = 0,
            locked_until = null, is_active = true, updated_at = now()
      where email = $1
      returning id`,
    [email, passwordHash],
  );
  const userId = updated.rows[0]?.id;
  if (!userId) throw new Error(`No user with the email ${email}.`);
  await coreQuery("delete from sessions where user_id = $1", [userId]);
  await audit("user.password_set_via_cli", userId, { email });
  console.log(`Password updated for ${email}; their other sessions were signed out.`);
}

async function resetTwoStepCommand(args: string[]) {
  // For someone who has lost their phone and backup codes and can't use an
  // emailed reset link (e.g. the only server admin, with no email set up).
  const email = normaliseEmail(required(args, "email"));
  const userId = await userIdFor(email);
  await withCoreTransaction((client) => resetTwoStep(client, userId, { userId: null, email: "admin-cli" }, "command_line"));
  console.log(`Two-step sign-in reset for ${email}; they set it up again at their next sign-in.`);
}

async function users(command: string | undefined, args: string[]) {
  if (command === "list") {
    const list = await listUsers();
    show(args, list, () =>
      table(
        list.map((u) => ({
          Email: u.email,
          Name: u.displayName,
          Login: u.isActive ? "on" : "off",
          "Server admin": u.isServerAdmin ? "yes" : "",
          "Two-step": u.twoStepEnabled ? "set up" : "not yet",
          Organisations: String(u.organisationCount),
          "Last sign-in": u.lastLoginAt ? new Date(u.lastLoginAt).toISOString().slice(0, 16).replace("T", " ") : "never",
        })),
      ),
    );
    return;
  }
  if (command === "create") return createUserCommand(args);
  if (command === "set-password") return setPasswordCommand(args);
  if (command === "reset-two-step") return resetTwoStepCommand(args);
  if (command === "rename") {
    const user = await updateUser(actor, await userIdFor(required(args, "email")), { displayName: required(args, "name") });
    console.log(`${user.email} is now called ${user.displayName}.`);
    return;
  }
  if (command === "login") {
    const isActive = onOff(args);
    const user = await updateUser(actor, await userIdFor(required(args, "email")), { isActive });
    console.log(isActive ? `${user.email} can sign in.` : `${user.email} can't sign in any more, and was signed out.`);
    return;
  }
  if (command === "server-admin") {
    const isServerAdmin = onOff(args);
    const user = await updateUser(actor, await userIdFor(required(args, "email")), { isServerAdmin });
    console.log(isServerAdmin ? `${user.email} is a server admin.` : `${user.email} is no longer a server admin.`);
    return;
  }
  throw new UsageError(`Unknown users command${command ? ` "${command}"` : ""}.`);
}

async function remoteAccess(command: string | undefined, args: string[]) {
  if (command === "show") {
    const remote = await getRemoteAccess();
    // The tunnel itself runs inside the Tohyee server, not this command, so
    // its live state isn't known here.
    show(args, { ...remote, tunnel: undefined }, () => {
      console.log(`Remote access: ${remote.enabled ? "on" : "off"}`);
      console.log(`Public address: ${remote.publicUrl ?? "(not set)"}`);
      console.log(`Tunnel token: ${remote.hasToken ? `saved (tunnel ${remote.tunnelId ?? "unknown"})` : "not saved"}`);
      console.log(`Give Cloudflare this service address: ${remote.localService}`);
      if (!remote.twoStepRequired) console.log("Two-step sign-in isn't in force (TOHYEE_SECRET_KEY isn't set), so the tunnel won't start.");
      console.log("Whether the tunnel is connected right now shows in the server's log.");
    });
    return;
  }
  if (command === "set") {
    const enabled = onOff(args);
    const tunnelToken = flag(args, "token") ? await secret("TOHYEE_TUNNEL_TOKEN", "Tunnel token (the eyJ… code from Cloudflare): ") : undefined;
    const url = option(args, "url");
    const remote = await updateRemoteAccess(COMMAND_LINE_ADMIN, {
      enabled,
      tunnelToken,
      ...(url !== null ? { publicUrl: url } : {}),
    }, { apply: false });
    console.log(`Remote access saved: ${remote.enabled ? "on" : "off"}${remote.publicUrl ? `, ${remote.publicUrl}` : ""}. Restart Tohyee for the tunnel to ${remote.enabled ? "start" : "stop"}.`);
    return;
  }
  if (command === "clear") {
    await updateRemoteAccess(COMMAND_LINE_ADMIN, { clear: true }, { apply: false });
    console.log("Remote access removed (token and address). Restart Tohyee to stop a running tunnel.");
    return;
  }
  throw new UsageError(`Unknown remote-access command${command ? ` "${command}"` : ""}.`);
}

async function email(command: string | undefined, args: string[]) {
  if (command === "show") {
    const settings = await getEmailSettings();
    show(args, settings, () => {
      if (!settings.configured) {
        console.log("Email isn't set up.");
        return;
      }
      console.log(`SMTP server: ${settings.host}:${settings.port}${settings.secure ? " (SSL)" : " (STARTTLS)"}`);
      console.log(`Username: ${settings.username}`);
      console.log(`From: "${settings.fromName}" <${settings.fromAddress}>`);
      console.log(`Password: ${settings.hasPassword ? "saved" : "not saved"}`);
    });
    return;
  }
  if (command === "set") {
    const password = await secret("TOHYEE_EMAIL_PASSWORD", "Email password (for Gmail, an app password; blank keeps the saved one): ");
    const settings = await updateEmailSettings(COMMAND_LINE_ADMIN, {
      host: required(args, "host"),
      port: required(args, "port"),
      username: required(args, "username"),
      password,
      fromAddress: option(args, "from") ?? undefined,
      fromName: option(args, "from-name") ?? undefined,
    });
    console.log(`Email saved: sending from ${settings.fromAddress} through ${settings.host}. Try it with "email test --to you@example.com".`);
    return;
  }
  if (command === "test") {
    const to = normaliseEmail(required(args, "to"));
    await sendEmail({
      to,
      subject: "Tohyee: test email",
      text: "This is a test email from your Tohyee server. Email is working: security alerts and two-step sign-in reset links will be sent from this address.",
    });
    console.log(`Sent a test email to ${to}.`);
    return;
  }
  if (command === "clear") {
    await updateEmailSettings(COMMAND_LINE_ADMIN, { clear: true });
    console.log("Email settings removed.");
    return;
  }
  throw new UsageError(`Unknown email command${command ? ` "${command}"` : ""}.`);
}

/** With --other-key: the backup key of the server that made the backup. */
async function otherKey(args: string[]): Promise<string | undefined> {
  if (!flag(args, "other-key")) return undefined;
  return secret("TOHYEE_BACKUP_KEY", "The backup key of the server that made this backup: ");
}

function megabytes(bytes: number | null): string {
  return bytes === null ? "" : `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function when(iso: string | null): string {
  return iso ? new Date(iso).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "";
}

async function backups(command: string | undefined, args: string[]) {
  if (command === "status") {
    const settings = await getBackupSettings();
    const status = await backupStatus();
    const keyStatus = await backupKeyStatus();
    show(args, { settings, keyStatus, status }, () => {
      console.log(`Nightly backups: ${settings.enabled ? `on, at ${settings.time} (${settings.timeZone})` : "off"}`);
      console.log(`Folder: ${settings.folder}${settings.folder === settings.defaultFolder ? " (the default)" : ""}`);
      if (!settings.keySet) console.log("TOHYEE_SECRET_KEY isn't set, so backups can't be made (they're encrypted with it).");
      else if (!keyStatus.savedCopyCheckedAt) console.log("Nobody has checked a saved copy of the backup key yet. Without a copy, backups can't be opened if this server is lost: run backups key show.");
      console.log("");
      table(
        status.map((s) => ({
          Database: s.organisationId ?? "(server: users and settings)",
          "Last good backup": s.lastGood ? when(s.lastGood.finishedAt) : "never",
          Size: megabytes(s.lastGood?.sizeBytes ?? null),
          "Latest attempt": s.latest ? `${s.latest.status}${s.latest.status === "failed" ? `: ${s.latest.error}` : ""}` : "",
        })),
      );
    });
    return;
  }
  if (command === "set") {
    const input: { enabled?: boolean; folder?: string; time?: string } = {};
    if (flag(args, "on") || flag(args, "off")) input.enabled = onOff(args);
    const folderIndex = args.indexOf("--folder");
    if (folderIndex !== -1) {
      const value = args[folderIndex + 1];
      if (value === undefined) throw new UsageError("--folder needs a path (or \"\" for the default).");
      input.folder = value;
    }
    const time = option(args, "time");
    if (time !== null) input.time = time;
    if (Object.keys(input).length === 0) throw new UsageError("Say what to change: --on/--off, --folder or --time.");
    const settings = await updateBackupSettings(COMMAND_LINE_ADMIN, input);
    console.log(`Backups saved: ${settings.enabled ? `nightly at ${settings.time}` : "off"}, into ${settings.folder}.`);
    return;
  }
  if (command === "run") {
    const organisationId = option(args, "id") ?? undefined;
    const runs = await backUpNow({ trigger: "manual", requestedByEmail: "cli", organisationId });
    for (const run of runs) {
      const name = run.organisationId ?? "server";
      console.log(run.status === "ok" ? `${name}: backed up to ${run.filePath} (${megabytes(run.sizeBytes)})` : `${name}: FAILED: ${run.error}`);
    }
    if (runs.some((run) => run.status !== "ok")) process.exitCode = 1;
    return;
  }
  if (command === "list") {
    const files = await listBackupFiles(option(args, "id") ?? undefined);
    show(args, files, () =>
      table(
        files.map((f) => ({
          File: f.path,
          Organisation: f.header ? (f.header.organisationId ?? "(server)") : "",
          Made: f.header ? when(f.header.createdAt) : "",
          Size: megabytes(f.sizeBytes),
          Problem: f.problem ?? "",
        })),
      ),
    );
    return;
  }
  if (command === "check") {
    const file = required(args, "file");
    const header = await checkBackup(file);
    console.log(`OK: ${header.organisationId ?? "the server's own database"}, made ${when(header.createdAt)} by Tohyee ${header.tohyeeVersion}. It opens with this server's key and PostgreSQL can read it.`);
    return;
  }
  if (command === "restore") {
    const file = required(args, "file");
    const key = await otherKey(args);
    const organisation = await restoreBackupAsCopy(COMMAND_LINE_ADMIN.user, {
      file,
      key,
      id: option(args, "id") ?? undefined,
      displayName: option(args, "name") ?? undefined,
      ownerEmail: option(args, "owner") ?? undefined,
    });
    console.log(`Restored as ${organisation.displayName} (${organisation.id}). Check it in the books; the original hasn't been touched.`);
    return;
  }
  if (command === "decrypt") {
    const out = required(args, "out");
    const file = required(args, "file");
    const header = await decryptBackupTo(file, out, await otherKey(args));
    console.log(`Wrote ${out}: a pg_dump (custom format) of ${header.databaseName}. Restore it with pg_restore. It isn't encrypted, so delete it when you're done.`);
    return;
  }
  if (command === "key") {
    const [what] = args;
    if (what === "show") {
      const { key, keyId } = await revealBackupKey(COMMAND_LINE_ADMIN, undefined);
      console.log("The backup key (this server's TOHYEE_SECRET_KEY). Backups can only be opened with it.");
      console.log("Save it somewhere safe that isn't the backup folder (a password manager), then run: backups key check");
      console.log("");
      console.log(key);
      console.log("");
      console.log(`Fingerprint: ${keyId}`);
      return;
    }
    if (what === "check") {
      const status = await checkSavedBackupKey(COMMAND_LINE_ADMIN, await secret("TOHYEE_BACKUP_KEY", "Paste your saved copy of the key: "));
      console.log(`That's the right key (fingerprint ${status.keyId}). The reminder is off until the key changes.`);
      return;
    }
    const status = await backupKeyStatus();
    if (!status.keySet) console.log("TOHYEE_SECRET_KEY isn't set, so there's no backup key yet.");
    else console.log(status.savedCopyCheckedAt ? `A saved copy was checked ${when(status.savedCopyCheckedAt)} by ${status.savedCopyCheckedByEmail}.` : "Nobody has checked a saved copy of this key yet: run backups key show, save it, then backups key check.");
    return;
  }
  throw new UsageError(`Unknown backups command${command ? ` "${command}"` : ""}.`);
}

async function updates(command: string | undefined, args: string[]) {
  if (command !== "check") throw new UsageError(`Unknown updates command${command ? ` "${command}"` : ""}.`);
  const check = await getLatestReleaseCheck();
  show(args, check, () => {
    console.log(`This server runs v${check.currentVersion}. The latest release is v${check.latestVersion}${check.updateAvailable ? " (update available)" : " (up to date)"}.`);
    console.log(`Release notes: ${check.release.htmlUrl}`);
    if (check.release.preferredAsset) console.log(`Download: ${check.release.preferredAsset.downloadUrl}`);
  });
}

async function main(argv: string[]): Promise<void> {
  const [area, command, ...rest] = argv;
  // The older one-word commands.
  if (area === "create-user") return createUserCommand([command, ...rest].filter((a) => a !== undefined));
  if (area === "set-password") return setPasswordCommand([command, ...rest].filter((a) => a !== undefined));
  if (area === "reset-two-step") return resetTwoStepCommand([command, ...rest].filter((a) => a !== undefined));

  if (area === "organisations") return organisations(command, rest);
  if (area === "users") return users(command, rest);
  if (area === "remote-access") return remoteAccess(command, rest);
  if (area === "email") return email(command, rest);
  if (area === "updates") return updates(command, rest);
  if (area === "backups") return backups(command, rest);
  if (area === undefined || area === "help" || area === "--help" || area === "-h") {
    console.log(HELP);
    if (area === undefined) process.exitCode = 1;
    return;
  }
  throw new UsageError(`Unknown area "${area}".`);
}

main(process.argv.slice(2))
  .catch((error) => {
    if (error instanceof UsageError) {
      console.error(`${error.message}\nRun with "help" to see the commands.`);
    } else {
      console.error(error instanceof Error ? error.message : error);
    }
    process.exitCode = 1;
  })
  .finally(() => closeAllPools());
