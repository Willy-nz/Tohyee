import { writeAuditEvent } from "@/lib/audit";
import { type CrmScope, seesLead } from "@/lib/crm/access";
import { getLead } from "@/lib/crm/leads";
import { type MailProvider, type ProviderApp, refreshAccess } from "@/lib/crm/mail/providers";
import { appForProvider, MICROSOFT_READ_SEND_SCOPES } from "@/lib/crm/mail/service";
import { createActivity, getOpportunity, getPerson } from "@/lib/crm/service";
import { requireCrm } from "@/lib/crm/switch";
import type { OrgTx } from "@/lib/db/org-transaction";
import { GmailSendError, sendViaGmail } from "@/lib/email/google";
import { EmailMaybeSentError, maybeSentMessage } from "@/lib/email/maybe-sent";
import { GraphSendError, sendViaGraph } from "@/lib/email/microsoft";
import { newMessageId, type OutgoingMessage } from "@/lib/email/smtp";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { assertSameRequest, requestHash } from "@/lib/idempotency";
import { listMembers } from "@/lib/organisations/members";
import { decryptSecret, encryptSecret } from "@/lib/secrets";
import { optionalId, optionalSource, requireId, requireIdempotencyKey, requireString } from "@/lib/validation";

/**
 * Sales emails (decision 496, #216 stage 2; Jess 10 Oct 2026: from the rep's
 * own mailbox; nothing goes without a person pressing Send).
 *
 * - **Templates:** admins write them with merge fields such as
 *   {{first_name}}; anyone who can change CRM records uses them.
 * - **Sending:** one email at a time, to a lead, a person, or a deal's
 *   contact, from the sender's own connected mailbox once they've allowed
 *   sending. Plain text; no attachments, tracking pixels or links rewritten.
 *   It's logged as a note on the record.
 * - **Opt-outs:** someone marked "Don't email" is never sent one.
 * - **Once:** each send has an idempotency key. A retry returns what
 *   happened; one that may have gone (no clear answer) is never retried.
 */

export const MERGE_FIELDS = ["first_name", "last_name", "full_name", "company", "deal", "my_name", "my_email"] as const;
export type MergeField = (typeof MERGE_FIELDS)[number];
export const MERGE_FIELD_LABELS: Record<MergeField, string> = {
  first_name: "Their first name",
  last_name: "Their last name",
  full_name: "Their full name",
  company: "Their company",
  deal: "The deal's name",
  my_name: "Your name",
  my_email: "Your email address",
};

const FIELD = /\{\{\s*([a-z_]+)\s*\}\}/g;

/** Refuses merge fields that don't exist, so a typo doesn't go out as "{{frist_name}}". */
export function checkMergeFields(text: string, what: string): void {
  for (const match of text.matchAll(FIELD)) {
    if (!(MERGE_FIELDS as readonly string[]).includes(match[1])) {
      throw new ValidationError(`The ${what} has {{${match[1]}}}, which isn't a merge field. Use one of: ${MERGE_FIELDS.map((field) => `{{${field}}}`).join(", ")}.`);
    }
  }
}

/** Fills in merge fields; one with no value becomes empty. */
export function fillMergeFields(text: string, values: Partial<Record<MergeField, string | null>>): string {
  return text.replace(FIELD, (whole, name: string) => ((MERGE_FIELDS as readonly string[]).includes(name) ? (values[name as MergeField] ?? "") : whole));
}

// ---------------------------------------------------------------------------
// Templates

export type EmailTemplate = { id: string; name: string; subject: string; body: string; isActive: boolean; updatedAt: string };

type TemplateRow = { id: string; name: string; subject: string; body: string; is_active: boolean; updated_at: string };

function toTemplate(row: TemplateRow): EmailTemplate {
  return { id: row.id, name: row.name, subject: row.subject, body: row.body, isActive: row.is_active, updatedAt: new Date(row.updated_at).toISOString() };
}

export async function listEmailTemplates(tx: OrgTx, options: { includeInactive?: boolean } = {}): Promise<EmailTemplate[]> {
  const result = await tx.query<TemplateRow>(
    `select t.id::text, t.name, t.subject, t.body, t.is_active, t.updated_at::text from crm_email_templates t
      where $1::boolean or t.is_active order by lower(t.name), t.id`,
    [options.includeInactive ?? false],
  );
  return result.rows.map(toTemplate);
}

async function getTemplate(tx: OrgTx, id: string): Promise<EmailTemplate> {
  const result = await tx.query<TemplateRow>("select id::text, name, subject, body, is_active, updated_at::text from crm_email_templates where id = $1", [id]);
  if (!result.rows[0]) throw new NotFoundError("Email template not found.");
  return toTemplate(result.rows[0]);
}

type TemplateInput = { name?: unknown; subject?: unknown; body?: unknown; isActive?: unknown };

function templateValues(input: TemplateInput, current: EmailTemplate | null) {
  const name = input.name === undefined && current ? current.name : requireString(input.name, "name", { maxLength: 100 });
  const subject = input.subject === undefined && current ? current.subject : requireString(input.subject, "subject", { maxLength: 200 });
  const body = input.body === undefined && current ? current.body : requireString(input.body, "body", { maxLength: 20000 });
  checkMergeFields(subject, "subject");
  checkMergeFields(body, "body");
  if (input.isActive !== undefined && typeof input.isActive !== "boolean") throw new ValidationError("isActive must be true or false.");
  return { name, subject, body, isActive: (input.isActive as boolean | undefined) ?? current?.isActive ?? true };
}

async function assertNameFree(tx: OrgTx, name: string, id: string | null): Promise<void> {
  const taken = await tx.query("select 1 from crm_email_templates where lower(name) = lower($1) and ($2::bigint is null or id <> $2)", [name, id]);
  if ((taken.rowCount ?? 0) > 0) throw new ConflictError(`There's already a template called ${name}.`);
}

export async function createEmailTemplate(tx: OrgTx, input: TemplateInput): Promise<EmailTemplate> {
  await requireCrm(tx);
  const v = templateValues(input, null);
  await assertNameFree(tx, v.name, null);
  const inserted = await tx.query<{ id: string }>(
    "insert into crm_email_templates (name, subject, body, is_active, created_by_email) values ($1, $2, $3, $4, $5) returning id::text",
    [v.name, v.subject, v.body, v.isActive, tx.actor.email],
  );
  const id = inserted.rows[0].id;
  await writeAuditEvent(tx, { eventType: "crm.email_template_created", entityType: "crm_email_template", entityId: id, details: { name: v.name } });
  return getTemplate(tx, id);
}

export async function updateEmailTemplate(tx: OrgTx, idInput: unknown, input: TemplateInput): Promise<EmailTemplate> {
  await requireCrm(tx);
  const current = await getTemplate(tx, requireId(idInput, "templateId"));
  const v = templateValues(input, current);
  await assertNameFree(tx, v.name, current.id);
  await tx.query("update crm_email_templates set name = $2, subject = $3, body = $4, is_active = $5, updated_at = now() where id = $1", [
    current.id,
    v.name,
    v.subject,
    v.body,
    v.isActive,
  ]);
  await writeAuditEvent(tx, { eventType: "crm.email_template_updated", entityType: "crm_email_template", entityId: current.id, details: { name: v.name, isActive: v.isActive } });
  return getTemplate(tx, current.id);
}

// ---------------------------------------------------------------------------
// Who it's to

export type EmailTarget = { leadId?: unknown; personId?: unknown; opportunityId?: unknown };

type Recipient = {
  to: string | null;
  name: string;
  optOut: boolean;
  values: Partial<Record<MergeField, string | null>>;
  leadId: string | null;
  personId: string | null;
  contactId: string | null;
  opportunityId: string | null;
};

async function recipientFor(tx: OrgTx, target: EmailTarget, scope?: CrmScope): Promise<Recipient> {
  const leadId = optionalId(target.leadId, "leadId");
  const opportunityId = optionalId(target.opportunityId, "opportunityId");
  let personId = optionalId(target.personId, "personId");
  if ([leadId, opportunityId ?? personId].filter(Boolean).length !== 1) throw new ValidationError("Choose a lead, a person or a deal to email.");
  if (leadId) {
    const lead = await getLead(tx, leadId, scope);
    if (!seesLead(scope, lead.ownerUserId)) throw new NotFoundError("Lead not found.");
    if (lead.status === "converted") throw new ConflictError("This lead was converted: email the person it became instead.");
    return {
      to: lead.email,
      name: lead.name,
      optOut: lead.emailOptOut,
      values: { first_name: lead.firstName, last_name: lead.lastName, full_name: [lead.firstName, lead.lastName].filter(Boolean).join(" ") || null, company: lead.companyName },
      leadId,
      personId: null,
      contactId: null,
      opportunityId: null,
    };
  }
  let deal: { name: string; contactId: string; contactName: string } | null = null;
  if (opportunityId) {
    const opportunity = await getOpportunity(tx, opportunityId, scope);
    deal = { name: opportunity.name, contactId: opportunity.contactId, contactName: opportunity.contactName };
    personId ??= opportunity.pointOfContactId;
    if (!personId) throw new ValidationError("This deal has no point of contact to email. Choose the person.");
  }
  const person = await getPerson(tx, personId);
  if (person.isArchived) throw new ConflictError(`${person.fullName} is archived.`);
  if (deal && person.contactId !== deal.contactId) throw new ValidationError(`${person.fullName} isn't at ${deal.contactName}.`);
  return {
    to: person.email,
    name: person.fullName,
    optOut: person.emailOptOut,
    values: { first_name: person.firstName, last_name: person.lastName, full_name: person.fullName, company: person.contactName, deal: deal?.name ?? null },
    leadId: null,
    personId: person.id,
    contactId: person.contactId,
    opportunityId,
  };
}

async function senderValues(tx: OrgTx): Promise<{ my_name: string | null; my_email: string | null }> {
  const me = (await listMembers(tx.organisationId)).find((member) => member.userId === tx.actor.userId);
  return { my_name: me?.displayName ?? null, my_email: me?.email ?? tx.actor.email };
}

export type SendingAccount = { id: string; provider: MailProvider; email: string };

/** The signed-in person's mailboxes that can send (decision 496). */
export async function sendingAccounts(tx: OrgTx): Promise<SendingAccount[]> {
  const result = await tx.query<{ id: string; provider: MailProvider; email: string }>(
    "select a.id::text, a.provider, a.email from crm_connected_accounts a where a.user_id = $1 and a.can_send and a.status = 'active' order by lower(a.email), a.id",
    [tx.actor.userId],
  );
  return result.rows;
}

export type EmailDraft = {
  to: string | null;
  name: string;
  optOut: boolean;
  subject: string;
  body: string;
  accounts: SendingAccount[];
};

/** What an email would say, filled in from a template (or blank), and who it's to; nothing is sent. */
export async function draftSalesEmail(tx: OrgTx, input: EmailTarget & { templateId?: unknown }, scope?: CrmScope): Promise<EmailDraft> {
  await requireCrm(tx);
  const recipient = await recipientFor(tx, input, scope);
  const templateId = optionalId(input.templateId, "templateId");
  const template = templateId ? await getTemplate(tx, templateId) : null;
  if (template && !template.isActive) throw new ConflictError("That template is switched off.");
  const values = { ...recipient.values, ...(await senderValues(tx)) };
  return {
    to: recipient.to,
    name: recipient.name,
    optOut: recipient.optOut,
    subject: template ? fillMergeFields(template.subject, values) : "",
    body: template ? fillMergeFields(template.body, values) : "",
    accounts: await sendingAccounts(tx),
  };
}

/** Marks a lead or person as not to be emailed, or clears it (decision 496). */
export async function setEmailOptOut(tx: OrgTx, input: { leadId?: unknown; personId?: unknown; optOut?: unknown }, scope?: CrmScope): Promise<void> {
  await requireCrm(tx);
  if (typeof input.optOut !== "boolean") throw new ValidationError("optOut must be true or false.");
  const leadId = optionalId(input.leadId, "leadId");
  const personId = optionalId(input.personId, "personId");
  if (Boolean(leadId) === Boolean(personId)) throw new ValidationError("Choose a lead or a person.");
  if (leadId) {
    await getLead(tx, leadId, scope);
    await tx.query("update crm_leads set email_opt_out = $2, updated_at = now() where id = $1", [leadId, input.optOut]);
  } else {
    await getPerson(tx, personId);
    await tx.query("update crm_people set email_opt_out = $2, updated_at = now() where id = $1", [personId, input.optOut]);
  }
  await writeAuditEvent(tx, {
    eventType: "crm.email_opt_out",
    entityType: leadId ? "crm_lead" : "crm_person",
    entityId: (leadId ?? personId)!,
    details: { optOut: input.optOut },
  });
}

// ---------------------------------------------------------------------------
// Sending

export type SentEmailStatus = "sending" | "sent" | "failed" | "maybe_sent";
export type SentEmail = { id: string; status: SentEmailStatus; to: string; subject: string; error: string | null; sentAt: string | null };

type SendInput = EmailTarget & {
  source?: unknown;
  idempotencyKey?: unknown;
  accountId?: unknown;
  templateId?: unknown;
  subject?: unknown;
  body?: unknown;
};

type Prepared =
  | { done: SentEmail }
  | {
      done?: undefined;
      emailId: string;
      account: SendingAccount & { refreshToken: string; refreshCiphertext: string };
      app: ProviderApp;
      fromName: string | null;
      message: OutgoingMessage;
    };

async function sentEmail(tx: OrgTx, id: string): Promise<SentEmail> {
  const row = (
    await tx.query<{ id: string; status: SentEmailStatus; to_email: string; subject: string; error: string | null; sent_at: string | null }>(
      "select id::text, status, to_email, subject, error, sent_at::text from crm_sent_emails where id = $1",
      [id],
    )
  ).rows[0];
  return { id: row.id, status: row.status, to: row.to_email, subject: row.subject, error: row.error, sentAt: row.sent_at ? new Date(row.sent_at).toISOString() : null };
}

/** Checks everything and claims the key; the email itself goes after this transaction. */
async function prepareSend(tx: OrgTx, input: SendInput, scope?: CrmScope): Promise<Prepared> {
  await requireCrm(tx);
  if (!tx.actor.userId) throw new ForbiddenError("Sign in to send email.");
  const source = optionalSource(input.source);
  const key = requireIdempotencyKey(input.idempotencyKey);
  const accountId = requireId(input.accountId, "accountId");
  const templateId = optionalId(input.templateId, "templateId");
  const subject = requireString(input.subject, "subject", { maxLength: 200 });
  const body = requireString(input.body, "body", { maxLength: 20000 });
  if (/\{\{\s*[a-z_]+\s*\}\}/.test(subject + body)) throw new ValidationError("The email still has a merge field like {{first_name}} in it. Fill it in first.");
  const recipient = await recipientFor(tx, input, scope);
  const hash = requestHash("crm_sales_email", {
    accountId,
    leadId: recipient.leadId,
    personId: recipient.personId,
    opportunityId: recipient.opportunityId,
    subject,
    body,
  });
  const existing = (
    await tx.query<{ id: string; request_hash: string; status: SentEmailStatus }>(
      "select id::text, request_hash, status from crm_sent_emails where command_source = $1 and idempotency_key = $2 for update",
      [source, key],
    )
  ).rows[0];
  if (existing) {
    assertSameRequest(existing.request_hash, hash, "email");
    // Only one that clearly failed is tried again; a sent one, or one that may have gone, is returned as it is.
    if (existing.status !== "failed") return { done: await sentEmail(tx, existing.id) };
  }
  if (!recipient.to) throw new ValidationError(`${recipient.name} has no email address.`);
  if (recipient.optOut) throw new ConflictError(`${recipient.name} asked not to be emailed.`);
  const account = (
    await tx.query<{ id: string; provider: MailProvider; email: string; user_id: string; can_send: boolean; status: string; refresh_token_ciphertext: string }>(
      "select id::text, provider, email, user_id, can_send, status, refresh_token_ciphertext from crm_connected_accounts where id = $1",
      [accountId],
    )
  ).rows[0];
  if (!account || account.user_id !== tx.actor.userId) throw new NotFoundError("Choose your own connected mailbox.");
  if (!account.can_send) throw new ConflictError(`Sending isn't allowed from ${account.email} yet. Allow it on CRM › Email and calendar.`);
  if (account.status !== "active") throw new ConflictError(`${account.email} needs connecting again before it can send.`);
  if (templateId) await getTemplate(tx, templateId);
  let emailId: string;
  if (existing) {
    emailId = existing.id;
    await tx.query("update crm_sent_emails set status = 'sending', error = null where id = $1", [emailId]);
  } else {
    emailId = (
      await tx.query<{ id: string }>(
        `insert into crm_sent_emails (command_source, idempotency_key, request_hash, account_id, sent_by_user_id, to_email, subject, body, template_id,
                                      lead_id, person_id, contact_id, opportunity_id, status)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'sending') returning id::text`,
        [source, key, hash, account.id, tx.actor.userId, recipient.to, subject, body, templateId, recipient.leadId, recipient.personId, recipient.contactId, recipient.opportunityId],
      )
    ).rows[0].id;
  }
  const me = await senderValues(tx);
  return {
    emailId,
    account: { id: account.id, provider: account.provider, email: account.email, refreshToken: decryptSecret(account.refresh_token_ciphertext), refreshCiphertext: account.refresh_token_ciphertext },
    app: await appForProvider(tx, account.provider),
    fromName: me.my_name,
    message: {
      to: [recipient.to],
      cc: [],
      subject,
      text: body,
      html: null,
      attachment: null,
      inline: [],
      messageId: newMessageId({ fromAddress: account.email }, tx.organisationId, `crm${emailId}`),
    },
  };
}

type Delivery = { status: "sent" | "failed" | "maybe_sent"; error: string | null; providerMessageId: string | null; newRefreshToken: string | null };

function explain(provider: MailProvider, error: unknown): { status: "failed" | "maybe_sent"; error: string } {
  const who = provider === "google" ? "Google" : "Microsoft";
  if (error instanceof EmailMaybeSentError) return { status: "maybe_sent", error: maybeSentMessage("your mailbox", error.detail) };
  const status = error instanceof GmailSendError || error instanceof GraphSendError ? error.status : null;
  const detail = error instanceof Error ? error.message : String(error);
  if (status === 401 || status === 403) {
    return { status: "failed", error: `${who} didn't let Tohyee send from your mailbox. Allow sending again on CRM › Email and calendar. (${who} said: ${detail})` };
  }
  return { status: "failed", error: `${who} didn't send it: ${detail}` };
}

/** The network part: a fresh access token with sending, then the email. Never inside a transaction. */
async function deliver(prepared: Exclude<Prepared, { done: SentEmail }>): Promise<Delivery> {
  const { account } = prepared;
  let token: string;
  let newRefreshToken: string | null = null;
  try {
    const tokens = await refreshAccess(account.provider, prepared.app, account.refreshToken, MICROSOFT_READ_SEND_SCOPES);
    token = tokens.accessToken;
    newRefreshToken = tokens.refreshToken && tokens.refreshToken !== account.refreshToken ? tokens.refreshToken : null;
  } catch (error) {
    // Nothing was handed to the provider yet, so this one can be tried again.
    return { status: "failed", error: `Couldn't sign in to ${account.email}: ${error instanceof Error ? error.message : String(error)}`, providerMessageId: null, newRefreshToken: null };
  }
  try {
    const result =
      account.provider === "google"
        ? await sendViaGmail(token, { fromName: prepared.fromName ?? "", fromAddress: account.email, replyTo: null }, prepared.message)
        : await sendViaGraph(token, { fromAddress: account.email, replyTo: null }, prepared.message);
    return { status: "sent", error: null, providerMessageId: result.messageId, newRefreshToken };
  } catch (error) {
    return { ...explain(account.provider, error), providerMessageId: null, newRefreshToken };
  }
}

async function finishSend(tx: OrgTx, prepared: Exclude<Prepared, { done: SentEmail }>, delivery: Delivery): Promise<SentEmail> {
  if (delivery.newRefreshToken) {
    // Microsoft can hand out a new refresh token; keep it unless the mailbox was reconnected meanwhile.
    await tx.query("update crm_connected_accounts set refresh_token_ciphertext = $2, updated_at = now() where id = $1 and refresh_token_ciphertext = $3", [
      prepared.account.id,
      encryptSecret(delivery.newRefreshToken),
      prepared.account.refreshCiphertext,
    ]);
  }
  await tx.query(
    `update crm_sent_emails set status = $2, error = $3, provider_message_id = $4, sent_at = case when $2 = 'sent' then now() end where id = $1`,
    [prepared.emailId, delivery.status, delivery.error, delivery.providerMessageId],
  );
  if (delivery.status === "sent") {
    const row = (
      await tx.query<{ to_email: string; subject: string; body: string; lead_id: string | null; person_id: string | null; contact_id: string | null; opportunity_id: string | null }>(
        "select to_email, subject, body, lead_id::text, person_id::text, contact_id::text, opportunity_id::text from crm_sent_emails where id = $1",
        [prepared.emailId],
      )
    ).rows[0];
    const subjectLine = `Email: ${row.subject}`;
    const bodyText = `To ${row.to_email} from ${prepared.account.email}\n\n${row.body}`;
    // The email has gone: logging it must not undo that record, so it's tried in a savepoint.
    await tx.query("savepoint log_sales_email");
    try {
      const activity = await createActivity(tx, {
        kind: "note",
        happenedAt: new Date().toISOString(),
        subject: subjectLine.length > 200 ? `${subjectLine.slice(0, 199)}…` : subjectLine,
        body: bodyText.length > 10000 ? `${bodyText.slice(0, 9999)}…` : bodyText,
        leadId: row.lead_id,
        personId: row.person_id,
        contactId: row.contact_id,
        opportunityId: row.opportunity_id,
      });
      await tx.query("update crm_sent_emails set activity_id = $2 where id = $1", [prepared.emailId, activity.id]);
      await tx.query("release savepoint log_sales_email");
    } catch {
      await tx.query("rollback to savepoint log_sales_email");
    }
  }
  await writeAuditEvent(tx, {
    eventType: delivery.status === "sent" ? "crm.email_sent" : delivery.status === "maybe_sent" ? "crm.email_maybe_sent" : "crm.email_failed",
    entityType: "crm_sent_email",
    entityId: prepared.emailId,
    details: { from: prepared.account.email, to: prepared.message.to[0], subject: prepared.message.subject, error: delivery.error },
  });
  return sentEmail(tx, prepared.emailId);
}

/**
 * Sends one sales email. `run` opens a transaction with the person's CRM
 * scope (the route passes `withCrm`); it's called twice, around the network
 * call, so no transaction is held open while the provider answers.
 */
export async function sendSalesEmail(
  run: <T>(work: (tx: OrgTx, scope: CrmScope | undefined) => Promise<T>) => Promise<T>,
  input: SendInput,
): Promise<SentEmail> {
  const prepared = await run((tx, scope) => prepareSend(tx, input, scope));
  if (prepared.done) return prepared.done;
  const delivery = await deliver(prepared);
  return run((tx) => finishSend(tx, prepared, delivery));
}
