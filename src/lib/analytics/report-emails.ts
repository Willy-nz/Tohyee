import { randomUUID } from "node:crypto";
import yauzl from "yauzl";
import { writeAuditEvent } from "@/lib/audit";
import { organisationSourceFolder } from "@/lib/analytics/folders";
import { requireAnalytics } from "@/lib/analytics/sources";
import { extractReportAttachment, MAX_ATTACHMENT_BYTES, MAX_CHECK_BYTES, reportFileKey, saveReportFile } from "@/lib/analytics/report-email-files";
import { imapReportMessages, listImapFolders, listReportFolders, reportMessages, type ImapCredentials } from "@/lib/analytics/report-email-providers";
import { reportMailboxToken } from "@/lib/crm/mail/service";
import { requireCrm } from "@/lib/crm/switch";
import { type Actor, type OrgTx, withOrganisationTransaction } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { getOrganisation, type OrganisationRecord } from "@/lib/organisations/registry";
import { decryptSecret, encryptSecret } from "@/lib/secrets";

export type ReportMailbox = {
  id: string; kind: "crm" | "imap"; accountId: string | null; email: string | null;
  host: string | null; port: number | null; username: string | null;
  folderId: string; folderName: string; replace: boolean; hasPassword: boolean;
};
export type ReportEmailCheck = {
  id: string; mailboxId: string; startedAt: string; finishedAt: string | null;
  filesSaved: number; error: string | null; status: "running" | "ok" | "failed";
};
type MailboxRow = {
  id: string; kind: "crm" | "imap"; account_id: string | null; email: string | null;
  host: string | null; port: number | null; username: string | null; password_ciphertext: string | null;
  folder_id: string; folder_name: string; replace_files: boolean; owner_user_id: string;
  lease_id: string | null; lease_until: Date | null;
  last_check_at: Date | null;
};
type CheckRow = {
  id: string; mailbox_id: string; started_at: Date; finished_at: Date | null;
  files_saved: number; error: string | null; status: ReportEmailCheck["status"];
};
const CHECK_INTERVAL_MS = 15 * 60 * 1000;
const SAFE_CHECK_ERROR = "Some report files could not be saved. Check the mailbox connection, the organisation's source folder, and that attachments are safe data files within the size limits.";
const publicMailbox = (row: MailboxRow): ReportMailbox => ({
  id: row.id, kind: row.kind, accountId: row.account_id, email: row.email,
  host: row.host, port: row.port, username: row.username, folderId: row.folder_id,
  folderName: row.folder_name, replace: row.replace_files, hasPassword: Boolean(row.password_ciphertext),
});
const publicCheck = (row: CheckRow): ReportEmailCheck => ({
  id: row.id, mailboxId: row.mailbox_id, startedAt: new Date(row.started_at).toISOString(),
  finishedAt: row.finished_at ? new Date(row.finished_at).toISOString() : null,
  filesSaved: row.files_saved, error: row.error, status: row.status,
});
function text(value: unknown, name: string, max = 500): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ValidationError(`${name} must be non-empty text of at most ${max} characters.`);
  }
  return value.trim();
}
function id(value: unknown): string {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,18}$/.test(value)) throw new ValidationError("Choose a valid mailbox.");
  return value;
}
async function mailboxRow(tx: OrgTx, mailboxId: unknown, lock = false): Promise<MailboxRow> {
  const result = await tx.query<MailboxRow>(
    `select m.*, m.id::text, m.account_id::text, a.email from analytics_report_mailboxes m
       left join crm_connected_accounts a on a.id = m.account_id where m.id = $1 ${lock ? "for update of m" : ""}`,
    [id(mailboxId)],
  );
  if (!result.rows[0]) throw new NotFoundError("Report mailbox not found.");
  return result.rows[0];
}
function requireOwnMailbox(tx: OrgTx, row: MailboxRow): void {
  if (row.owner_user_id !== tx.actor.userId) throw new ForbiddenError("Only the member who configured this mailbox can change or check it.");
}
async function ownAccount(tx: OrgTx, value: unknown): Promise<string> {
  await requireCrm(tx);
  const accountId = id(value);
  const found = await tx.query<{ user_id: string; status: string }>("select user_id, status from crm_connected_accounts where id = $1", [accountId]);
  if (!found.rows[0]) throw new NotFoundError("Connected mailbox not found.");
  if (found.rows[0].user_id !== tx.actor.userId) throw new ForbiddenError("Choose your own connected mailbox.");
  if (found.rows[0].status !== "active") throw new ConflictError("Reconnect this mailbox first.");
  return accountId;
}
export async function listReportEmails(tx: OrgTx): Promise<{
  mailboxes: ReportMailbox[];
  accounts: Array<{ id: string; email: string; provider: "google" | "microsoft" }>;
  checks: ReportEmailCheck[];
}> {
  await requireAnalytics(tx);
  const mailboxes = await tx.query<MailboxRow>(
    `select m.*, m.id::text, m.account_id::text, a.email from analytics_report_mailboxes m
       left join crm_connected_accounts a on a.id = m.account_id where m.owner_user_id = $1 order by m.id`,
    [tx.actor.userId],
  );
  const accounts = await tx.query<{ id: string; email: string; provider: "google" | "microsoft" }>(
    `select id::text, email, provider from crm_connected_accounts where user_id = $1 and status = 'active'
       and (select crm_enabled from organisation_settings where id = true) order by email`, [tx.actor.userId],
  );
  const checks = await tx.query<CheckRow>(
    `select c.*, c.id::text, c.mailbox_id::text from analytics_report_email_checks c
       join analytics_report_mailboxes m on m.id = c.mailbox_id
       where m.owner_user_id = $1 order by c.started_at desc, c.id desc limit 50`, [tx.actor.userId],
  );
  return { mailboxes: mailboxes.rows.map(publicMailbox), accounts: accounts.rows, checks: checks.rows.map(publicCheck) };
}
export function imapCredentials(input: Record<string, unknown>, savedPassword?: string): ImapCredentials {
  const host = text(input.host, "IMAP host", 253);
  if (!/^[a-zA-Z0-9.-]+$/.test(host) || host.startsWith(".") || host.endsWith(".")) throw new ValidationError("Enter the IMAP server's host name, without a URL or port.");
  if (input.port !== 993) throw new ValidationError("IMAP uses encrypted TLS on port 993 only.");
  const username = text(input.username, "IMAP username", 320);
  const password = input.password === undefined || input.password === "" ? savedPassword : input.password;
  if (typeof password !== "string" || !password || password.length > 1000 || /[\u0000\r\n]/.test(password)) throw new ValidationError("Enter the mailbox's app password.");
  return { host, port: 993, username, password };
}
/** Reserve expansion from bounded metadata, even when extraction later rejects a ZIP. */
export async function reportZipExpansionBytes(bytes: Buffer): Promise<number> {
  if (bytes.length > MAX_ATTACHMENT_BYTES) throw new ValidationError("The report ZIP exceeds the attachment size limit.");
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true, autoClose: false, strictFileNames: true, validateEntrySizes: true }, (error, zip) => {
      if (error || !zip) { reject(new ValidationError("The report ZIP could not be read safely.")); return; }
      let count = 0;
      let total = 0;
      let done = false;
      const fail = () => {
        if (done) return;
        done = true;
        zip.close();
        reject(new ValidationError("The report ZIP exceeds the extraction limits or is damaged."));
      };
      zip.on("error", fail);
      zip.on("end", () => {
        if (done) return;
        done = true;
        zip.close();
        resolve(total);
      });
      zip.on("entry", (entry: yauzl.Entry) => {
        const size = entry.uncompressedSize;
        if (++count > 100 || !Number.isSafeInteger(size) || size < 0 || size > MAX_ATTACHMENT_BYTES || total + size > MAX_CHECK_BYTES) {
          fail();
          return;
        }
        total += size;
        zip.readEntry();
      });
      zip.readEntry();
    });
  });
}
export async function saveReportMailbox(tx: OrgTx, input: Record<string, unknown>): Promise<ReportMailbox> {
  await requireAnalytics(tx);
  if (!tx.actor.userId) throw new ForbiddenError("Sign in to configure a report mailbox.");
  const current = input.id === undefined ? null : await mailboxRow(tx, input.id, true);
  if (current) {
    requireOwnMailbox(tx, current);
    if (current.lease_until && new Date(current.lease_until).getTime() > Date.now()) throw new ConflictError("This mailbox is being checked. Try again after the check finishes.");
  }
  if (input.kind !== "crm" && input.kind !== "imap") throw new ValidationError("Choose a connected CRM mailbox or IMAP.");
  if (typeof input.replace !== "boolean") throw new ValidationError("Choose whether to replace files or keep every report.");
  const folderId = text(input.folderId, "Folder ID");
  const folderName = text(input.folderName, "Folder name");
  const accountId = input.kind === "crm" ? await ownAccount(tx, input.accountId) : null;
  const credentials = input.kind === "imap" ? imapCredentials(input, current?.password_ciphertext ? decryptSecret(current.password_ciphertext) : undefined) : null;
  const changedSource = current && (current.kind !== input.kind || current.account_id !== accountId || current.folder_id !== folderId
    || current.host !== (credentials?.host ?? null) || current.username !== (credentials?.username ?? null));
  if (changedSource) {
    await tx.query("delete from analytics_report_email_messages where mailbox_id = $1", [current.id]);
    await tx.query("delete from analytics_report_email_outputs where mailbox_id = $1", [current.id]);
  }
  const values = [input.kind, accountId, tx.actor.userId, credentials?.host ?? null, credentials?.port ?? null,
    credentials?.username ?? null, credentials ? encryptSecret(credentials.password) : null, folderId, folderName, input.replace, tx.actor.email];
  const saved = current
    ? await tx.query<{ id: string }>(
      `update analytics_report_mailboxes set kind=$1, account_id=$2, owner_user_id=$3, host=$4, port=$5, username=$6,
         password_ciphertext=$7, folder_id=$8, folder_name=$9, replace_files=$10, created_by_email=$11, updated_at=now(), last_check_at=null
       where id=$12 returning id::text`, [...values, current.id])
    : await tx.query<{ id: string }>(
      `insert into analytics_report_mailboxes
       (kind,account_id,owner_user_id,host,port,username,password_ciphertext,folder_id,folder_name,replace_files,created_by_email)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id::text`, values);
  const mailbox = publicMailbox(await mailboxRow(tx, saved.rows[0].id));
  await writeAuditEvent(tx, { eventType: "analytics.report_mailbox_saved", entityType: "analytics_report_mailbox", entityId: mailbox.id,
    details: { kind: mailbox.kind, folderName, replace: mailbox.replace } });
  return mailbox;
}
export async function deleteReportMailbox(tx: OrgTx, mailboxId: unknown): Promise<void> {
  await requireAnalytics(tx);
  const row = await mailboxRow(tx, mailboxId, true);
  requireOwnMailbox(tx, row);
  if (row.lease_until && new Date(row.lease_until).getTime() > Date.now()) throw new ConflictError("This mailbox is being checked. Try again after the check finishes.");
  await tx.query("delete from analytics_report_mailboxes where id = $1", [row.id]);
  await writeAuditEvent(tx, { eventType: "analytics.report_mailbox_deleted", entityType: "analytics_report_mailbox", entityId: row.id, details: {} });
}
export async function reportEmailFolders(
  organisation: OrganisationRecord, actor: Actor, input: Record<string, unknown>,
) {
  const prepared = await withOrganisationTransaction(organisation, actor, async (tx) => {
    await requireAnalytics(tx);
    if (input.accountId !== undefined) return { accountId: await ownAccount(tx, input.accountId), credentials: null };
    const saved = input.mailboxId === undefined ? null : await mailboxRow(tx, input.mailboxId);
    if (saved) requireOwnMailbox(tx, saved);
    return { accountId: null, credentials: imapCredentials(input, saved?.password_ciphertext ? decryptSecret(saved.password_ciphertext) : undefined) };
  });
  try {
    if (prepared.accountId) {
      const access = await reportMailboxToken(organisation, actor, prepared.accountId);
      return await listReportFolders(access.provider, access.token);
    }
    return await listImapFolders(prepared.credentials!);
  } catch {
    throw new ValidationError("Couldn't list mailbox folders. Check the connection, server and app password, then try again.");
  }
}

/** A committed lease spans the network work; only short transactions touch tenant data. */
export async function checkReportMailbox(
  organisation: OrganisationRecord, actor: Actor, mailboxId: unknown, trigger: "manual" | "schedule" = "manual", dueAt = new Date(),
): Promise<ReportEmailCheck> {
  const leaseId = randomUUID();
  const prepared = await withOrganisationTransaction(organisation, actor, async (tx) => {
    await requireAnalytics(tx);
    const mailbox = await mailboxRow(tx, mailboxId, true);
    requireOwnMailbox(tx, mailbox);
    if (mailbox.kind === "crm") await ownAccount(tx, mailbox.account_id);
    if (mailbox.lease_until && new Date(mailbox.lease_until).getTime() > Date.now()) throw new ConflictError("This mailbox is already being checked.");
    if (trigger === "schedule" && mailbox.last_check_at && dueAt.getTime() - new Date(mailbox.last_check_at).getTime() < CHECK_INTERVAL_MS) {
      throw new ConflictError("This mailbox is not due for another scheduled check yet.");
    }
    await tx.query(
      `update analytics_report_email_checks set status='failed', finished_at=now(), error='The previous check stopped. Retrying.'
       where mailbox_id=$1 and status='running'`, [mailbox.id]);
    await tx.query(
      `update analytics_report_mailboxes set lease_id=$2, lease_until=now()+interval '5 minutes', last_check_at=$3 where id=$1`,
      [mailbox.id, leaseId, dueAt.toISOString()]);
    const check = await tx.query<CheckRow>(
      `insert into analytics_report_email_checks (mailbox_id,trigger,requested_by_email) values ($1,$2,$3) returning *, id::text, mailbox_id::text`,
      [mailbox.id, trigger, actor.email]);
    const remembered = await tx.query<{ message_id: string }>("select message_id from analytics_report_email_messages where mailbox_id=$1", [mailbox.id]);
    return { mailbox, check: check.rows[0], remembered: new Set(remembered.rows.map((row) => row.message_id)) };
  });
  const { mailbox } = prepared;
  const run = <T>(work: (tx: OrgTx) => Promise<T>) => withOrganisationTransaction(organisation, actor, work);
  const renew = async (tx: OrgTx) => {
    await requireAnalytics(tx);
    const result = await tx.query(
      `update analytics_report_mailboxes set lease_until=now()+interval '5 minutes'
       where id=$1 and lease_id=$2 and lease_until>now() returning id`, [mailbox.id, leaseId]);
    if (!result.rowCount) throw new ConflictError("This check's lease expired. Try checking again.");
  };
  let lostLease = false;
  let heartbeatRunning = false;
  const heartbeat = setInterval(() => {
    if (heartbeatRunning) return;
    heartbeatRunning = true;
    run(renew).catch(() => { lostLease = true; }).finally(() => { heartbeatRunning = false; });
  }, 60_000);
  heartbeat.unref?.();
  let filesSaved = 0;
  const filenames: string[] = [];
  let failed = false;
  let usedBytes = 0;
  try {
    const folder = await organisationSourceFolder(organisation.id);
    if (!folder) throw new ConflictError("A server admin needs to choose this organisation's analytics folder.");
    const access = mailbox.kind === "crm" ? await reportMailboxToken(organisation, actor, mailbox.account_id!) : null;
    const messages = access ? reportMessages(access.provider, access.token, mailbox.folder_id)
      : imapReportMessages({ host: mailbox.host!, port: 993, username: mailbox.username!, password: decryptSecret(mailbox.password_ciphertext!) }, mailbox.folder_id);
    for await (const message of messages) {
      if (lostLease) throw new ConflictError("The mailbox check stopped.");
      if (prepared.remembered.has(message.id)) continue;
      if (usedBytes >= MAX_CHECK_BYTES) { failed = true; break; }
      if (!Number.isFinite(new Date(message.receivedAt).getTime())) { failed = true; continue; }
      let retry = false;
      for (const attachment of message.attachments) {
        if (!/\.(csv|tsv|txt|zip)$/i.test(attachment.name)) continue;
        if (usedBytes >= MAX_CHECK_BYTES) { failed = true; retry = true; break; }
        try { reportFileKey(attachment.name); } catch { failed = true; continue; }
        if (attachment.size > MAX_ATTACHMENT_BYTES || attachment.size < 0 || !Number.isFinite(attachment.size)) { failed = true; continue; }
        if (usedBytes + attachment.size > MAX_CHECK_BYTES) { failed = true; retry = true; continue; }
        let bytes: Buffer;
        usedBytes += attachment.size;
        try { bytes = await attachment.read(); } catch { failed = true; retry = true; continue; }
        usedBytes += bytes.length - attachment.size;
        if (usedBytes > MAX_CHECK_BYTES) { failed = true; retry = true; break; }
        if (bytes.length > MAX_ATTACHMENT_BYTES) { failed = true; continue; }
        let extracted;
        const archive = /\.zip$/i.test(attachment.name);
        const remaining = MAX_CHECK_BYTES - usedBytes;
        if (archive) {
          let expansion: number;
          try { expansion = await reportZipExpansionBytes(bytes); } catch { failed = true; continue; }
          if (expansion > remaining) { failed = true; retry ||= expansion + bytes.length <= MAX_CHECK_BYTES; continue; }
          usedBytes += expansion;
        }
        try { extracted = await extractReportAttachment(attachment.name, bytes, remaining + (archive ? 0 : bytes.length)); }
        catch { failed = true; continue; }
        for (const file of extracted) {
          if (usedBytes > MAX_CHECK_BYTES) { failed = true; retry = true; break; }
          try {
            const outputName = mailbox.replace_files ? reportFileKey(file.name) : file.name;
            if (mailbox.replace_files) {
              const reserved = await run(async (tx) => {
                await renew(tx);
                return tx.query(
                  `insert into analytics_report_email_outputs (mailbox_id,output_name,received_at,message_id)
                   values ($1,$2,$3,$4) on conflict (mailbox_id,output_name) do update
                     set received_at=excluded.received_at, message_id=excluded.message_id
                   where (analytics_report_email_outputs.received_at,analytics_report_email_outputs.message_id)
                     <= (excluded.received_at,excluded.message_id) returning message_id`,
                  [mailbox.id, outputName, message.receivedAt, message.id]);
              });
              if (!reserved.rowCount) continue;
            }
            await run(async (tx) => {
              await renew(tx);
              const outputFile = mailbox.replace_files ? { ...file, name: outputName } : file;
              const filename = await saveReportFile(folder, mailbox.id, message.id, message.receivedAt, outputFile, mailbox.replace_files);
              filesSaved += 1;
              filenames.push(filename);
              await tx.query("update analytics_report_email_checks set files_saved=$2, files=$3::jsonb where id=$1",
                [prepared.check.id, filesSaved, JSON.stringify(filenames)]);
            });
          } catch { failed = true; retry = true; }
        }
      }
      if (!retry) await run(async (tx) => {
        await renew(tx);
        await tx.query(
          "insert into analytics_report_email_messages (mailbox_id,message_id,received_at) values ($1,$2,$3) on conflict do nothing",
          [mailbox.id, message.id, message.receivedAt]);
      });
    }
  } catch { failed = true; }
  finally { clearInterval(heartbeat); }
  return run(async (tx) => {
    const lease = await tx.query("update analytics_report_mailboxes set lease_id=null, lease_until=null where id=$1 and lease_id=$2 returning id", [mailbox.id, leaseId]);
    if (!lease.rowCount) throw new ConflictError("Another check has replaced this one.");
    const completed = await tx.query<CheckRow>(
      `update analytics_report_email_checks set finished_at=now(), files_saved=$2, status=$3, error=$4, files=$5::jsonb
       where id=$1 returning *, id::text, mailbox_id::text`,
      [prepared.check.id, filesSaved, failed ? "failed" : "ok", failed ? SAFE_CHECK_ERROR : null, JSON.stringify(filenames)]);
    await writeAuditEvent(tx, { eventType: "analytics.report_email_checked", entityType: "analytics_report_mailbox", entityId: mailbox.id,
      details: { checkId: prepared.check.id, filesSaved, status: failed ? "failed" : "ok" } });
    return publicCheck(completed.rows[0]);
  });
}
export async function runDueReportEmailChecks(now = new Date()): Promise<ReportEmailCheck[]> {
  const organisations = await coreQuery<{ id: string }>(
    "select id from organisations where is_active and provisioning_status='ready' and migration_status='current' order by id");
  const made: ReportEmailCheck[] = [];
  for (const { id: organisationId } of organisations.rows) {
    const organisation = await getOrganisation(organisationId);
    if (!organisation) continue;
    const scheduler: Actor = { userId: null, email: "analytics-report-emails@tohyee" };
    try {
      const due = await withOrganisationTransaction(organisation, scheduler, async (tx) => {
        const enabled = await tx.query<{ analytics_enabled: boolean }>("select analytics_enabled from organisation_settings where id=true");
        if (!enabled.rows[0]?.analytics_enabled) return [];
        return (await tx.query<{ id: string; owner_user_id: string; created_by_email: string }>(
          `select id::text, owner_user_id, created_by_email from analytics_report_mailboxes
           where (last_check_at is null or last_check_at <= $1::timestamptz - interval '15 minutes')
             and (lease_until is null or lease_until <= now()) order by id`, [now.toISOString()])).rows;
      });
      for (const mailbox of due) {
        const membership = await coreQuery(
          `select 1 from organisation_members m join users u on u.id=m.user_id
           where m.organisation_id=$1 and m.user_id=$2 and m.role in ('owner','admin') and u.is_active`,
          [organisationId, mailbox.owner_user_id]);
        if (!membership.rowCount) continue;
        try {
          made.push(await checkReportMailbox(organisation, { userId: mailbox.owner_user_id, email: mailbox.created_by_email }, mailbox.id, "schedule", now));
        } catch { /* One unavailable mailbox must not stop other checks. */ }
      }
    } catch { /* An unavailable tenant must not stop the scheduler. */ }
  }
  return made;
}
let schedulerTimer: NodeJS.Timeout | null = null;
export function startReportEmailScheduler(): void {
  if (schedulerTimer) return;
  const tick = () => { runDueReportEmailChecks().catch(() => console.warn("[tohyee] Report email checks could not run.")); };
  schedulerTimer = setInterval(tick, CHECK_INTERVAL_MS);
  schedulerTimer.unref?.();
  setTimeout(tick, 60_000).unref?.();
}
