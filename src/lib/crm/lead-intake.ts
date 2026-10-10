import { createHash, randomBytes } from "node:crypto";
import { RequestLimiter } from "@/lib/ai/limits";
import { assertPublicMailHost } from "@/lib/analytics/mail-host";
import { imapReportMessages, reportMessages } from "@/lib/analytics/report-email-providers";
import { writeAuditEvent } from "@/lib/audit";
import { createIntakeLead, optionalCampaign } from "@/lib/crm/leads";
import { reportMailboxToken } from "@/lib/crm/mail/service";
import { crmEnabled, requireCrm } from "@/lib/crm/switch";
import { type Actor, assertOrganisationUsable, type OrgTx, withOrganisationTransaction } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { listAllOrganisations } from "@/lib/organisations/admin";
import { getOrganisation, type OrganisationRecord, parseOrganisationId } from "@/lib/organisations/registry";
import { decryptSecret, encryptSecret, secretsAvailable } from "@/lib/secrets";
import { optionalBoolean, optionalString, requireId, requireString } from "@/lib/validation";

/**
 * Leads from a web form and from email (decision 493, #216; Jess 10 Oct
 * 2026: no outside spam service). Both make leads with nobody owning them
 * yet, marked "to review", for a sales manager or admin to pick up.
 *
 * Web form: a form on the business's own website posts to
 * `/api/lead-forms/<organisation>/<form key>` (the server's remote access
 * address). A hidden trap field that only robots fill in, and limits per
 * sending address and per form, keep spam down; what gets through still
 * waits for review.
 *
 * Email: a mailbox folder or Gmail label (the admin's own CRM mailbox, or
 * IMAP), read like the bills inbox (BI2): each email once, never moved or
 * marked. An email from someone who's already an open lead adds a note to
 * that lead instead of a new one.
 */

/** The hidden field a robot fills in and a person doesn't (it's off screen). */
export const FORM_TRAP_FIELD = "website_url";
const FORM_KEY = /^[0-9a-f]{40}$/;
/** At most this many submissions from one address in 10 minutes, and per form in an hour. */
export const FORM_PER_ADDRESS = 5;
export const FORM_PER_FORM = 60;
const perAddress = new RequestLimiter(FORM_PER_ADDRESS, 10 * 60_000);
const perForm = new RequestLimiter(FORM_PER_FORM, 60 * 60_000);

const FORM_ACTOR: Actor = { userId: null, email: "web-form@tohyee" };
const MAIL_ACTOR: Actor = { userId: null, email: "lead-mailbox@tohyee" };
const MAX_ERROR = 1000;
export const MAX_LEADS_PER_CHECK = 200;

// ---------------------------------------------------------------------------
// Web forms

export type LeadForm = {
  id: string;
  name: string;
  formKey: string;
  isActive: boolean;
  thankYouUrl: string | null;
  /** Leads from it come from this campaign (decision 498). */
  campaignId: string | null;
  leadsReceived: number;
  lastLeadAt: string | null;
  createdAt: string;
};

type FormRow = {
  id: string;
  name: string;
  form_key: string;
  is_active: boolean;
  thank_you_url: string | null;
  campaign_id: string | null;
  leads_received: number;
  last_lead_at: string | null;
  created_at: string;
};

const FORM_SELECT = "select id::text, name, form_key, is_active, thank_you_url, campaign_id::text, leads_received, last_lead_at, created_at from crm_lead_forms";

function toForm(row: FormRow): LeadForm {
  return {
    id: row.id,
    name: row.name,
    formKey: row.form_key,
    isActive: row.is_active,
    thankYouUrl: row.thank_you_url,
    campaignId: row.campaign_id,
    leadsReceived: row.leads_received,
    lastLeadAt: row.last_lead_at,
    createdAt: row.created_at,
  };
}

export async function listLeadForms(tx: OrgTx): Promise<LeadForm[]> {
  return (await tx.query<FormRow>(`${FORM_SELECT} order by lower(name), crm_lead_forms.id`)).rows.map(toForm);
}

function thankYou(input: unknown): string | null {
  const url = optionalString(input, "thank-you page", { maxLength: 500 });
  if (url === null) return null;
  if (!/^https?:\/\/[^\s]+$/.test(url)) throw new ValidationError("The thank-you page must be a web address starting with https://.");
  return url;
}

/** Adds a web form (admins). Its key is random and is the only secret in its address. */
export async function createLeadForm(tx: OrgTx, input: { name?: unknown; thankYouUrl?: unknown; campaignId?: unknown }): Promise<LeadForm> {
  await requireCrm(tx);
  const name = requireString(input.name, "name", { maxLength: 100 });
  const campaignId = await optionalCampaign(tx, input.campaignId);
  try {
    const inserted = await tx.query<FormRow>(
      `insert into crm_lead_forms (name, form_key, thank_you_url, created_by_email, campaign_id) values ($1, $2, $3, $4, $5)
       returning id::text, name, form_key, is_active, thank_you_url, campaign_id::text, leads_received, last_lead_at, created_at`,
      [name, randomBytes(20).toString("hex"), thankYou(input.thankYouUrl), tx.actor.email, campaignId],
    );
    const form = toForm(inserted.rows[0]);
    await writeAuditEvent(tx, { eventType: "crm.lead_form_created", entityType: "crm_lead_form", entityId: form.id, details: { name, thankYouUrl: form.thankYouUrl } });
    return form;
  } catch (error) {
    if ((error as { code?: string }).code === "23505") throw new ConflictError(`There's already a form called ${name}.`);
    throw error;
  }
}

/** Renames a form, changes its thank-you page, or switches it off or on (admins). */
export async function updateLeadForm(
  tx: OrgTx,
  idInput: unknown,
  input: { name?: unknown; thankYouUrl?: unknown; isActive?: unknown; campaignId?: unknown },
): Promise<LeadForm> {
  const id = requireId(idInput, "formId");
  const current = (await tx.query<FormRow>(`${FORM_SELECT} where id = $1 for update`, [id])).rows[0];
  if (!current) throw new NotFoundError("Form not found.");
  const name = input.name === undefined ? current.name : requireString(input.name, "name", { maxLength: 100 });
  const url = input.thankYouUrl === undefined ? current.thank_you_url : thankYou(input.thankYouUrl);
  const isActive = optionalBoolean(input.isActive, "isActive") ?? current.is_active;
  const campaignId = input.campaignId === undefined ? current.campaign_id : await optionalCampaign(tx, input.campaignId);
  try {
    await tx.query("update crm_lead_forms set name = $2, thank_you_url = $3, is_active = $4, campaign_id = $5, updated_at = now() where id = $1", [
      id,
      name,
      url,
      isActive,
      campaignId,
    ]);
  } catch (error) {
    if ((error as { code?: string }).code === "23505") throw new ConflictError(`There's already a form called ${name}.`);
    throw error;
  }
  await writeAuditEvent(tx, { eventType: "crm.lead_form_updated", entityType: "crm_lead_form", entityId: id, details: { name, thankYouUrl: url, isActive, campaignId } });
  return toForm((await tx.query<FormRow>(`${FORM_SELECT} where id = $1`, [id])).rows[0]);
}

export type FormOutcome =
  | { status: "ok"; thankYouUrl: string | null }
  | { status: "invalid"; message: string; thankYouUrl: string | null }
  | { status: "refused" }
  | { status: "limited" };

function first(fields: Record<string, string>, names: string[]): string | null {
  for (const name of names) {
    const value = fields[name]?.trim();
    if (value) return value;
  }
  return null;
}

const KNOWN = new Set([
  "first_name", "firstname", "firstName", "first", "last_name", "lastname", "lastName", "last", "name", "full_name", "fullName",
  "company", "company_name", "companyName", "organisation", "organization", "business", "email", "e-mail", "email_address",
  "phone", "phone_number", "mobile", "telephone", "job_title", "jobTitle", "title", "message", "notes", "description", "enquiry",
  "comments", FORM_TRAP_FIELD,
]);

/**
 * What a web form sent (decision 493): refused unless the form exists and is
 * on; quietly accepted and dropped when the trap field is filled in; limited
 * per sending address and per form; otherwise an unassigned lead to review.
 * Fields: first_name/last_name or name, company, email, phone, job_title and
 * message; anything else is added to the lead's notes as "field: value".
 */
export async function receiveFormLead(
  organisationIdInput: string,
  formKey: string,
  fields: Record<string, string>,
  address: string | null,
): Promise<FormOutcome> {
  let organisationId: string;
  try {
    organisationId = parseOrganisationId(organisationIdInput);
  } catch {
    return { status: "refused" };
  }
  // As the sales platform webhooks: the same answer whether the organisation exists, is usable, or the key is wrong.
  if (!FORM_KEY.test(formKey)) return { status: "refused" };
  const organisation = await getOrganisation(organisationId);
  if (!organisation) return { status: "refused" };
  try {
    assertOrganisationUsable(organisation);
  } catch {
    return { status: "refused" };
  }
  const form = await withOrganisationTransaction(organisation, FORM_ACTOR, async (tx) => {
    if (!(await crmEnabled(tx))) return null;
    return (await tx.query<FormRow>(`${FORM_SELECT} where form_key = $1 and is_active`, [formKey])).rows[0] ?? null;
  });
  if (!form) return { status: "refused" };
  // A robot that filled in the hidden field is told it worked, and nothing is kept.
  if ((fields[FORM_TRAP_FIELD] ?? "").trim() !== "") return { status: "ok", thankYouUrl: form.thank_you_url };
  if (address && !perAddress.take(`${organisationId}:${address}`)) return { status: "limited" };
  if (!perForm.take(`${organisationId}:${form.id}`)) return { status: "limited" };

  let firstName = first(fields, ["first_name", "firstname", "firstName", "first"]);
  let lastName = first(fields, ["last_name", "lastname", "lastName", "last"]);
  const whole = first(fields, ["name", "full_name", "fullName"]);
  if (!firstName && !lastName && whole) {
    const parts = whole.split(/\s+/);
    firstName = parts[0];
    lastName = parts.length > 1 ? parts.slice(1).join(" ") : null;
  }
  const message = first(fields, ["message", "notes", "description", "enquiry", "comments"]);
  const extra = Object.entries(fields)
    .filter(([name, value]) => !KNOWN.has(name) && value.trim() !== "")
    .slice(0, 20)
    .map(([name, value]) => `${name.slice(0, 50)}: ${value.trim().slice(0, 300)}`);
  const description = [message, ...extra].filter(Boolean).join("\n").slice(0, 4000) || null;
  const submission = createHash("sha256")
    .update(JSON.stringify([form.id, Object.entries(fields).sort(), Math.floor(Date.now() / 60_000)]))
    .digest("hex")
    .slice(0, 64);
  try {
    await withOrganisationTransaction(organisation, FORM_ACTOR, async (tx) => {
      const lead = await createIntakeLead(
        tx,
        {
          firstName: firstName?.slice(0, 100) ?? null,
          lastName: lastName?.slice(0, 100) ?? null,
          companyName: first(fields, ["company", "company_name", "companyName", "organisation", "organization", "business"])?.slice(0, 200) ?? null,
          email: first(fields, ["email", "e-mail", "email_address"])?.slice(0, 254) ?? null,
          phone: first(fields, ["phone", "phone_number", "mobile", "telephone"])?.slice(0, 50) ?? null,
          jobTitle: first(fields, ["job_title", "jobTitle", "title"])?.slice(0, 100) ?? null,
          description,
          sourceDetail: form.name,
        },
        // The same submission twice in a minute (a double click) makes one lead.
        { source: "web_form", commandSource: "web-form", idempotencyKey: `form-${form.id}-${submission}`, campaignId: form.campaign_id },
      );
      if (lead) await tx.query("update crm_lead_forms set leads_received = leads_received + 1, last_lead_at = now() where id = $1", [form.id]);
    });
  } catch (error) {
    if (error instanceof ValidationError) return { status: "invalid", message: error.message, thankYouUrl: form.thank_you_url };
    throw error;
  }
  return { status: "ok", thankYouUrl: form.thank_you_url };
}

/** The HTML to put on a website, posting to this server's public address. */
export function formSnippet(publicOrigin: string, organisationId: string, form: Pick<LeadForm, "formKey">): string {
  const action = `${publicOrigin.replace(/\/$/, "")}/api/lead-forms/${organisationId}/${form.formKey}`;
  return [
    `<form method="post" action="${action}">`,
    `  <label>Name <input name="name" required></label>`,
    `  <label>Company <input name="company"></label>`,
    `  <label>Email <input name="email" type="email" required></label>`,
    `  <label>Phone <input name="phone" type="tel"></label>`,
    `  <label>Message <textarea name="message"></textarea></label>`,
    `  <!-- Leave this hidden: only robots fill it in. -->`,
    `  <input name="${FORM_TRAP_FIELD}" tabindex="-1" autocomplete="off" style="position:absolute;left:-9999px" aria-hidden="true">`,
    `  <button type="submit">Send</button>`,
    `</form>`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Mailboxes

export type LeadMailbox = {
  id: string;
  mailKind: "crm" | "imap";
  mailAccountEmail: string | null;
  imapHost: string | null;
  imapUsername: string | null;
  mailFolderName: string;
  ownerUserId: string;
  syncEveryHours: number;
  lastCheckAt: string | null;
  lastStatus: "ok" | "failed" | null;
  lastError: string | null;
  lastLeadsAdded: number | null;
  /** Leads from it come from this campaign (decision 498). */
  campaignId: string | null;
};

type MailboxRow = {
  id: string;
  mail_kind: "crm" | "imap";
  mail_account_id: string | null;
  mail_account_email: string | null;
  imap_host: string | null;
  imap_username: string | null;
  imap_password_ciphertext: string | null;
  mail_folder_id: string;
  mail_folder_name: string;
  owner_user_id: string;
  sync_every_hours: number;
  last_check_at: string | null;
  last_status: "ok" | "failed" | null;
  last_error: string | null;
  last_leads_added: number | null;
  lease_until: string | null;
  campaign_id: string | null;
};

const MAILBOX_SELECT = `
  select m.id::text, m.mail_kind, m.mail_account_id::text, c.email as mail_account_email, m.imap_host, m.imap_username,
         m.imap_password_ciphertext, m.mail_folder_id, m.mail_folder_name, m.owner_user_id::text, m.sync_every_hours,
         m.last_check_at, m.last_status, m.last_error, m.last_leads_added, m.lease_until, m.campaign_id::text
    from crm_lead_mailboxes m
    left join crm_connected_accounts c on c.id = m.mail_account_id`;

function toMailbox(row: MailboxRow): LeadMailbox {
  return {
    id: row.id,
    mailKind: row.mail_kind,
    mailAccountEmail: row.mail_account_email,
    imapHost: row.imap_host,
    imapUsername: row.imap_username,
    mailFolderName: row.mail_folder_name,
    ownerUserId: row.owner_user_id,
    syncEveryHours: row.sync_every_hours,
    lastCheckAt: row.last_check_at ? new Date(row.last_check_at).toISOString() : null,
    lastStatus: row.last_status,
    lastError: row.last_error,
    lastLeadsAdded: row.last_leads_added,
    campaignId: row.campaign_id,
  };
}

function locationOf(row: Pick<MailboxRow, "mail_kind" | "mail_account_id" | "imap_host" | "imap_username" | "mail_folder_id">): string {
  if (row.mail_kind === "crm") return `crm:${row.mail_account_id}:${row.mail_folder_id}`;
  return `imap:${(row.imap_host ?? "").toLowerCase()}:${row.imap_username}:${row.mail_folder_id}`;
}

async function mailboxRow(tx: OrgTx, idInput: unknown, lock = false): Promise<MailboxRow> {
  const id = requireId(idInput, "mailboxId");
  const found = await tx.query<MailboxRow>(`${MAILBOX_SELECT} where m.id = $1 ${lock ? "for update of m" : ""}`, [id]);
  if (!found.rows[0]) throw new NotFoundError("Mailbox not found.");
  return found.rows[0];
}

export async function listLeadMailboxes(tx: OrgTx): Promise<LeadMailbox[]> {
  return (await tx.query<MailboxRow>(`${MAILBOX_SELECT} order by m.id`)).rows.map(toMailbox);
}

function parseHours(input: unknown): number {
  if (input == null || input === "") return 1;
  const hours = Number(input);
  if (!Number.isInteger(hours) || hours < 1 || hours > 24) throw new ValidationError("Check every must be 1 to 24 hours.");
  return hours;
}

/** Reads a mailbox folder or label into leads (admins; it reads as them). */
export async function createLeadMailbox(tx: OrgTx, input: Record<string, unknown>): Promise<LeadMailbox> {
  await requireCrm(tx);
  if (!tx.actor.userId) throw new ForbiddenError("Sign in to set up a mailbox.");
  const mailKind = input.mailKind;
  if (mailKind !== "crm" && mailKind !== "imap") throw new ValidationError("Choose a connected mailbox or IMAP.");
  const folderId = requireString(input.mailFolderId, "mail folder", { maxLength: 500 });
  const folderName = requireString(input.mailFolderName, "mail folder name", { maxLength: 500 });
  let mailAccountId: string | null = null;
  if (mailKind === "crm") {
    mailAccountId = requireId(input.mailAccountId, "mailAccountId");
    const found = await tx.query<{ user_id: string; status: string }>("select user_id::text, status from crm_connected_accounts where id = $1", [mailAccountId]);
    if (!found.rows[0]) throw new NotFoundError("Connected mailbox not found.");
    if (found.rows[0].user_id !== tx.actor.userId) throw new ForbiddenError("Choose your own connected mailbox.");
    if (found.rows[0].status !== "active") throw new ConflictError("Reconnect this mailbox first.");
  }
  let login: { host: string; username: string; password: string } | null = null;
  if (mailKind === "imap") {
    const host = requireString(input.imapHost, "IMAP host", { maxLength: 253 });
    if (!/^[a-zA-Z0-9.-]+$/.test(host) || host.startsWith(".") || host.endsWith(".")) throw new ValidationError("Enter the IMAP server's host name, without a URL or port.");
    const username = requireString(input.imapUsername, "IMAP username", { maxLength: 320 });
    const password = input.imapPassword;
    if (typeof password !== "string" || !password || password.length > 1000 || /[\u0000\r\n]/.test(password)) throw new ValidationError("Enter the mailbox's app password.");
    await assertPublicMailHost(host);
    login = { host, username, password };
  }
  const hours = parseHours(input.syncEveryHours);
  const campaignId = await optionalCampaign(tx, input.campaignId);
  const location = locationOf({ mail_kind: mailKind, mail_account_id: mailAccountId, imap_host: login?.host ?? null, imap_username: login?.username ?? null, mail_folder_id: folderId });
  if ((await tx.query<MailboxRow>(MAILBOX_SELECT)).rows.some((row) => locationOf(row) === location)) throw new ConflictError("Leads already come from that folder.");
  const inserted = await tx.query<{ id: string }>(
    `insert into crm_lead_mailboxes (mail_kind, mail_account_id, imap_host, imap_username, imap_password_ciphertext, mail_folder_id,
                                     mail_folder_name, owner_user_id, sync_every_hours, created_by_email, campaign_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id::text`,
    [mailKind, mailAccountId, login?.host ?? null, login?.username ?? null, login ? encryptSecret(login.password) : null, folderId, folderName, tx.actor.userId, hours, tx.actor.email, campaignId],
  );
  const id = inserted.rows[0].id;
  await writeAuditEvent(tx, { eventType: "crm.lead_mailbox_created", entityType: "crm_lead_mailbox", entityId: id, details: { mailKind, folderName, syncEveryHours: hours } });
  return toMailbox(await mailboxRow(tx, id));
}

/** Stops reading a mailbox into leads. The leads stay, and so does the record of the emails read. */
export async function deleteLeadMailbox(tx: OrgTx, idInput: unknown): Promise<void> {
  const row = await mailboxRow(tx, idInput, true);
  if (row.lease_until && new Date(row.lease_until).getTime() > Date.now()) throw new ConflictError("This mailbox is being checked. Try again in a minute.");
  await tx.query("delete from crm_lead_mailboxes where id = $1", [row.id]);
  await writeAuditEvent(tx, { eventType: "crm.lead_mailbox_deleted", entityType: "crm_lead_mailbox", entityId: row.id, details: { folderName: row.mail_folder_name } });
}

/** "Aroha Ngata <aroha@example.nz>" or "aroha@example.nz" → name and address. */
export function parseSender(from: string | null | undefined): { name: string | null; email: string | null } {
  if (!from) return { name: null, email: null };
  const angled = /^\s*"?([^"<]*?)"?\s*<([^>\s]+@[^>\s]+)>\s*$/.exec(from);
  if (angled) return { name: angled[1].trim() || null, email: angled[2].trim() };
  const bare = /^\s*([^\s<>]+@[^\s<>]+)\s*$/.exec(from);
  return bare ? { name: null, email: bare[1] } : { name: from.trim().slice(0, 200) || null, email: null };
}

export type LeadMailCheck = { mailboxId: string; status: "ok" | "failed"; leadsAdded: number; notesAdded: number; error: string | null };

async function ownerEmail(userId: string): Promise<string | null> {
  return (await coreQuery<{ email: string }>("select email from users where id = $1", [userId])).rows[0]?.email ?? null;
}

/**
 * Checks one lead mailbox now (Check now, or the schedule): every email not
 * yet read, each in its own transaction. The sender becomes the lead (name
 * and email), the subject and the start of the text its notes. An email from
 * someone who's already an open lead adds a note to that lead instead.
 */
export async function checkLeadMailbox(organisation: OrganisationRecord, actor: Actor, idInput: unknown): Promise<LeadMailCheck> {
  const row = await withOrganisationTransaction(organisation, actor, async (tx) => {
    const found = await mailboxRow(tx, idInput, true);
    if (found.lease_until && new Date(found.lease_until).getTime() > Date.now()) throw new ConflictError("This mailbox is already being checked.");
    await tx.query("update crm_lead_mailboxes set lease_until = now() + interval '10 minutes' where id = $1", [found.id]);
    return found;
  });
  const readAs: Actor = { userId: row.owner_user_id, email: (await ownerEmail(row.owner_user_id)) ?? actor.email };
  const location = locationOf(row);
  let leadsAdded = 0;
  let notesAdded = 0;
  let error: string | null = null;
  try {
    const done = new Set(
      (await withOrganisationTransaction(organisation, readAs, (tx) => tx.query<{ message_id: string }>("select message_id from crm_lead_mail_seen where location = $1", [location]))).rows.map(
        (entry) => entry.message_id,
      ),
    );
    const skip = (messageId: string) => done.has(messageId);
    let messages;
    if (row.mail_kind === "crm") {
      if (!row.mail_account_id) throw new ConflictError("The mailbox leads came from has been disconnected. Set it up again.");
      const access = await reportMailboxToken(organisation, readAs, row.mail_account_id);
      messages = reportMessages(access.provider, access.token, row.mail_folder_id, skip);
    } else {
      await assertPublicMailHost(row.imap_host!);
      messages = imapReportMessages(
        { host: row.imap_host!, port: 993, username: row.imap_username!, password: decryptSecret(row.imap_password_ciphertext!) },
        row.mail_folder_id,
        skip,
      );
    }
    let count = 0;
    for await (const message of messages) {
      if (done.has(message.id)) continue;
      if (count >= MAX_LEADS_PER_CHECK) break; // the rest wait for the next check
      count += 1;
      const sender = parseSender(message.from);
      const subject = message.subject ?? "(no subject)";
      const notes = [subject, message.preview].filter(Boolean).join("\n\n").slice(0, 4000);
      const key = `mail-${createHash("sha256").update(`${location}\u0000${message.id}`).digest("hex").slice(0, 64)}`;
      await withOrganisationTransaction(organisation, MAIL_ACTOR, async (tx) => {
        let leadId: string | null = null;
        const open = sender.email
          ? (await tx.query<{ id: string }>("select id::text from crm_leads where lower(email) = lower($1) and status in ('new', 'working') order by crm_leads.id limit 1", [sender.email])).rows[0]
          : undefined;
        if (open) {
          // Someone already being worked: the email goes on their lead.
          await tx.query(
            `insert into crm_activities (kind, happened_at, subject, body, lead_id, created_by_email) values ('note', coalesce($1::timestamptz, now()), $2, $3, $4, $5)`,
            [message.receivedAt, `Email: ${subject}`.slice(0, 200), message.preview ?? null, open.id, MAIL_ACTOR.email],
          );
          leadId = open.id;
          notesAdded += 1;
        } else {
          const words = (sender.name ?? "").split(/\s+/).filter(Boolean);
          try {
            const lead = await createIntakeLead(
              tx,
              {
                firstName: words[0] ?? null,
                lastName: words.length > 1 ? words.slice(1).join(" ").slice(0, 100) : null,
                email: sender.email,
                description: notes || null,
                sourceDetail: row.mail_folder_name.slice(0, 300),
              },
              { source: "email", commandSource: "lead-mailbox", idempotencyKey: key, campaignId: row.campaign_id },
            );
            if (lead) {
              leadId = lead.id;
              leadsAdded += 1;
            }
          } catch (caught) {
            // An email that can't be a lead (no sender at all) is still marked read.
            if (!(caught instanceof ValidationError)) throw caught;
          }
        }
        await tx.query("insert into crm_lead_mail_seen (location, message_id, lead_id) values ($1, $2, $3) on conflict do nothing", [location, message.id, leadId]);
      });
      done.add(message.id);
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message.slice(0, MAX_ERROR) : "The check failed.";
  } finally {
    await withOrganisationTransaction(organisation, actor, (tx) =>
      tx.query("update crm_lead_mailboxes set last_check_at = now(), last_status = $2, last_error = $3, last_leads_added = $4, lease_until = null where id = $1", [
        row.id,
        error ? "failed" : "ok",
        error,
        leadsAdded,
      ]),
    );
  }
  return { mailboxId: row.id, status: error ? "failed" : "ok", leadsAdded, notesAdded, error };
}

let running = false;

/** Checks every lead mailbox on the server that's due, one at a time. */
export async function checkDueLeadMailboxes(): Promise<{ checked: number; failed: number }> {
  if (running) return { checked: 0, failed: 0 };
  running = true;
  let checked = 0;
  let failed = 0;
  try {
    if (!secretsAvailable()) return { checked, failed };
    for (const organisation of await listAllOrganisations()) {
      if (!organisation.isActive || organisation.provisioningStatus !== "ready" || organisation.migrationStatus !== "current") continue;
      let due: string[] = [];
      try {
        due = (
          await withOrganisationTransaction(organisation, MAIL_ACTOR, async (tx) =>
            (await crmEnabled(tx))
              ? (
                  await tx.query<{ id: string }>(
                    `select id::text from crm_lead_mailboxes
                      where (last_check_at is null or last_check_at < now() - make_interval(hours => sync_every_hours))
                        and (lease_until is null or lease_until < now())
                      order by last_check_at nulls first`,
                  )
                ).rows
              : [],
          )
        ).map((entry) => entry.id);
      } catch {
        continue;
      }
      for (const id of due) {
        try {
          const result = await checkLeadMailbox(organisation, MAIL_ACTOR, id);
          if (result.status === "failed") failed += 1;
          checked += 1;
        } catch {
          failed += 1;
        }
      }
    }
    return { checked, failed };
  } finally {
    running = false;
  }
}

let timer: NodeJS.Timeout | null = null;

/** Looks for due lead mailboxes every 15 minutes while the server runs. */
export function startLeadMailboxScheduler(): void {
  if (timer) return;
  const tick = () => {
    checkDueLeadMailboxes().catch((caught) => console.warn("[tohyee] Lead mailboxes:", caught));
  };
  timer = setInterval(tick, 15 * 60 * 1000);
  timer.unref?.();
  setTimeout(tick, 3 * 60 * 1000).unref?.();
}
