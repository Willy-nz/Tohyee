import { writeAuditEvent } from "@/lib/audit";
import { getContact } from "@/lib/contacts/service";
import { parseIsoDate, parseOptionalIsoDate, todayIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { type PrintedDocument, printedDocument } from "@/lib/documents/print";
import type { PrintKind } from "@/lib/documents/tax-invoice";
import { headerText, requireAddresses, splitAddresses } from "@/lib/email/addresses";
import { getEmailTemplate, getOrganisationEmailSettings, NOT_SET_UP } from "@/lib/email/settings";
import {
  EMAIL_DOCUMENT_KINDS,
  EMAIL_KIND_NOUNS,
  type EmailDocumentKind,
  fillTemplate,
  MAX_BODY_LENGTH,
  MAX_SUBJECT_LENGTH,
} from "@/lib/email/templates";
import { ConflictError, NotFoundError, TooManyRequestsError, UnavailableError, ValidationError } from "@/lib/errors";
import { formatDate, formatMoney } from "@/lib/format";
import { assertSameRequest, requestHash } from "@/lib/idempotency";
import { cmp, dec, ZERO_DECIMAL } from "@/lib/money/decimal";
import { getOrganisationSettings } from "@/lib/organisations/settings";
import { documentFileName, statementFileName } from "@/lib/pdf/documents";
import { agedReceivables } from "@/lib/reports/aged-receivables";
import { type ActivityStatement, activityStatement, type OutstandingStatement, outstandingStatement } from "@/lib/reports/customer-statements";
import { optionalSource, requireId, requireIdempotencyKey, requireOneOf } from "@/lib/validation";

/**
 * Emailing invoices, credit notes, quotes, purchase orders and customer
 * statements from the organisation's own account. Asking to send only
 * queues the email (`document_emails`, with who asked); the background job
 * (`outbox.ts`) writes the PDF, sends it and records what the SMTP server
 * said. Nothing here changes a document or its accounting status: a quote
 * shows "Sent" only because a send was accepted by the SMTP server.
 */

/** Most emails one organisation can queue in 24 hours (Gmail's own limit for a personal account is about 500 a day). */
export const MAX_EMAILS_PER_DAY = 500;

/** The record history each kind's email events belong to (audit entity type). */
export const EMAIL_HISTORY_ENTITY: Record<EmailDocumentKind | "payslip", string> = {
  invoice: "sales_invoice",
  credit_note: "sales_credit_note",
  quote: "quote",
  purchase_order: "purchase_order",
  statement: "contact",
  // Payslip emails (PSLIP5) go in the pay run's history.
  payslip: "payroll_pay_run",
};

const DOCUMENT_TABLES: Record<PrintKind, string> = {
  invoice: "sales_invoices",
  credit_note: "sales_credit_notes",
  quote: "quotes",
  purchase_order: "purchase_orders",
};

export type StatementOptions = {
  statementKind: "activity" | "outstanding";
  from: string | null;
  to: string | null;
  asAt: string | null;
  includeSubCustomers: boolean;
};

export function parseStatementOptions(input: unknown): StatementOptions {
  const value = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const statementKind = requireOneOf(value.statementKind ?? "activity", "statementKind", ["activity", "outstanding"] as const);
  const includeSubCustomers = value.includeSubCustomers === true || value.includeSubCustomers === "true";
  if (statementKind === "activity") {
    const to = parseOptionalIsoDate(value.to, "to") ?? todayIsoDate();
    const from = parseIsoDate(value.from, "from");
    if (from > to) throw new ValidationError("The start date must be on or before the end date.");
    return { statementKind, from, to, asAt: null, includeSubCustomers };
  }
  return { statementKind, from: null, to: null, asAt: parseOptionalIsoDate(value.asAt, "asAt") ?? todayIsoDate(), includeSubCustomers };
}

export async function loadStatement(tx: OrgTx, contactId: string, options: StatementOptions): Promise<ActivityStatement | OutstandingStatement> {
  return options.statementKind === "activity"
    ? activityStatement(tx, { contactId, from: options.from, to: options.to, includeSubCustomers: options.includeSubCustomers })
    : outstandingStatement(tx, { contactId, asAt: options.asAt, includeSubCustomers: options.includeSubCustomers });
}

/** What the email is about: loaded, checked that it can be sent, with the template's values. */
export type EmailSubject = {
  kind: EmailDocumentKind;
  documentId: string;
  contactId: string;
  contactName: string;
  /** e.g. "invoice INV-0001", "statement". */
  label: string;
  attachmentName: string;
  defaultTo: string[];
  values: Record<string, string | null>;
  statement: StatementOptions | null;
  /** Loaded for the PDF, so it's written from exactly what was checked. */
  printed: PrintedDocument | null;
  statementData: ActivityStatement | OutstandingStatement | null;
};

async function contactAddresses(tx: OrgTx, contactId: string): Promise<{ name: string; to: string[]; isCustomer: boolean }> {
  const contact = await getContact(tx, contactId);
  const to = splitAddresses([contact.email ?? "", contact.primaryPerson?.email ?? ""]).addresses;
  return { name: contact.name, to, isCustomer: contact.isCustomer };
}

/** Why a document can't be emailed yet, or null when it can. */
function notEmailable(doc: PrintedDocument): string | null {
  switch (doc.kind) {
    case "invoice":
      return doc.status === "approved" ? null : doc.status === "draft" ? "Approve the invoice before emailing it." : "A voided invoice can't be emailed.";
    case "credit_note":
      return doc.status === "approved" ? null : doc.status === "draft" ? "Approve the credit note before emailing it." : "A voided credit note can't be emailed.";
    case "quote":
      return doc.status === "draft" ? "Finalise the quote before emailing it, so it has its number." : null;
    case "purchase_order":
      return doc.status === "approved" || doc.status === "billed"
        ? null
        : doc.status === "draft"
          ? "Approve the purchase order before emailing it."
          : "A cancelled purchase order can't be emailed.";
  }
}

export async function loadEmailSubject(
  tx: OrgTx,
  kindInput: unknown,
  idInput: unknown,
  statementInput?: unknown,
): Promise<EmailSubject> {
  const kind = requireOneOf(kindInput, "kind", EMAIL_DOCUMENT_KINDS);
  const documentId = requireId(idInput, kind === "statement" ? "contactId" : "id");
  const settings = await getOrganisationSettings(tx);
  if (kind === "statement") {
    const statement = parseStatementOptions(statementInput);
    const contact = await contactAddresses(tx, documentId);
    const data = await loadStatement(tx, documentId, statement);
    const date = data.kind === "activity" ? data.to : data.asAt;
    return {
      kind,
      documentId,
      contactId: documentId,
      contactName: contact.name,
      label: "statement",
      attachmentName: statementFileName(data),
      defaultTo: contact.to,
      values: {
        contact: contact.name,
        organisation: settings.displayName,
        "statement date": formatDate(date),
        balance: formatMoney(data.kind === "activity" ? data.closing : data.balance),
      },
      statement,
      printed: null,
      statementData: data,
    };
  }
  const printed = await printedDocument(tx, kind, documentId);
  const problem = notEmailable(printed);
  if (problem) throw new ValidationError(problem);
  const row = await tx.query<{ contact_id: string }>(`select contact_id::text from ${DOCUMENT_TABLES[kind]} where id = $1`, [documentId]);
  if (!row.rows[0]) throw new NotFoundError("Document not found.");
  const contact = await contactAddresses(tx, row.rows[0].contact_id);
  return {
    kind,
    documentId,
    contactId: row.rows[0].contact_id,
    contactName: contact.name,
    label: `${EMAIL_KIND_NOUNS[kind]} ${printed.number ?? ""}`.trim(),
    attachmentName: documentFileName(printed),
    defaultTo: contact.to,
    values: {
      contact: contact.name,
      organisation: settings.displayName,
      number: printed.number,
      date: formatDate(printed.date),
      "due date": printed.dueDate ? formatDate(printed.dueDate) : null,
      "expiry date": printed.expiryDate ? formatDate(printed.expiryDate) : null,
      "delivery date": printed.deliveryDate ? formatDate(printed.deliveryDate) : null,
      total: formatMoney(printed.total),
      "amount due": printed.amountDue === null ? null : formatMoney(printed.amountDue),
      reference: printed.reference,
      "payment link": printed.payNowUrl,
      "paypal link": printed.payPalUrl,
    },
    statement: null,
    printed,
    statementData: null,
  };
}

export type PreparedEmail = {
  configured: boolean;
  /** Why email can't be sent yet (not set up); the dialog shows it instead of the form. */
  notice: string | null;
  from: string | null;
  replyTo: string | null;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  attachmentName: string;
  label: string;
  contactName: string;
  /** e.g. "Kobe Cafe has no email address; add one to the contact or type one in." */
  warnings: string[];
};

/** The invoice's Pay now link (PN2), added to the message unless the template already has it. */
function withPayNow(body: string, url: string | null, payPalUrl: string | null): string {
  const lines = [
    url && !body.includes(url) ? `Pay now by card: ${url}` : null,
    payPalUrl && !body.includes(payPalUrl) ? `Pay with PayPal: ${payPalUrl}` : null,
  ].filter(Boolean);
  return lines.length ? `${body.trimEnd()}\n\n${lines.join("\n")}` : body;
}

/** What the email dialog starts with: the contact's address and the filled-in template. */
export async function prepareDocumentEmail(tx: OrgTx, input: { kind?: unknown; id?: unknown; statement?: unknown }): Promise<PreparedEmail> {
  const subject = await loadEmailSubject(tx, input.kind, input.id, input.statement);
  const account = await getOrganisationEmailSettings(tx);
  const template = await getEmailTemplate(tx, subject.kind);
  const warnings: string[] = [];
  if (subject.defaultTo.length === 0) {
    warnings.push(`${subject.contactName} has no email address. Type one in below, or add it to the contact so it's filled in next time.`);
  }
  return {
    configured: account.configured,
    notice: account.configured
      ? null
      : account.sendingMethod === "microsoft"
        ? account.microsoft?.tokensReadable
          ? "The organisation's Microsoft app isn't set up. An admin needs to enter it in Settings > Email."
          : "The Microsoft mailbox's sign-in can't be read on this server any more (was TOHYEE_SECRET_KEY changed?). An admin needs to connect it again in Settings > Email."
        : account.sendingMethod === "google"
          ? account.google?.tokensReadable
            ? "The organisation's Google app isn't set up. An admin needs to enter it in Settings > Email."
            : "The Google mailbox's sign-in can't be read on this server any more (was TOHYEE_SECRET_KEY changed?). An admin needs to connect it again in Settings > Email."
          : account.hasPassword
          ? "The saved email password can't be read on this server any more (was TOHYEE_SECRET_KEY changed?). An admin needs to enter it again in Settings > Email."
          : NOT_SET_UP,
    from: account.configured ? `${account.fromName} <${account.fromAddress}>` : null,
    replyTo: account.configured ? (account.replyTo ?? account.fromAddress) : null,
    to: subject.defaultTo,
    cc: [],
    subject: headerText(fillTemplate(template.subject, subject.values), MAX_SUBJECT_LENGTH),
    body: withPayNow(fillTemplate(template.body, subject.values), subject.printed?.payNowUrl ?? null, subject.printed?.payPalUrl ?? null),
    attachmentName: subject.attachmentName,
    label: subject.label,
    contactName: subject.contactName,
    warnings,
  };
}

export type DocumentEmail = {
  id: string;
  kind: EmailDocumentKind;
  documentId: string;
  contactId: string;
  batchId: string | null;
  status: "queued" | "sending" | "sent" | "failed";
  to: string[];
  cc: string[];
  subject: string;
  attachmentName: string;
  attempts: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  messageId: string | null;
  smtpResponse: string | null;
  /** How it was sent: through SMTP or the Microsoft mailbox (null until sent). */
  sentVia: "smtp" | "microsoft" | "google" | null;
  requestedByEmail: string;
  createdAt: string;
  finishedAt: string | null;
};

type EmailRow = {
  id: string;
  request_hash: string;
  document_kind: EmailDocumentKind;
  document_id: string;
  contact_id: string;
  batch_id: string | null;
  status: DocumentEmail["status"];
  to_addresses: string[];
  cc_addresses: string[];
  subject: string;
  attachment_name: string;
  attempts: number;
  next_attempt_at: string;
  last_error: string | null;
  message_id: string | null;
  smtp_response: string | null;
  sent_via: "smtp" | "microsoft" | "google" | null;
  requested_by_email: string;
  created_at: string;
  finished_at: string | null;
};

function emailColumns(prefix = ""): string {
  const p = prefix ? `${prefix}.` : "";
  return `${p}id::text as id, ${p}request_hash, ${p}document_kind, ${p}document_id::text as document_id, ${p}contact_id::text as contact_id,
    ${p}batch_id::text as batch_id, ${p}status, ${p}to_addresses, ${p}cc_addresses, ${p}subject, ${p}attachment_name, ${p}attempts,
    ${p}next_attempt_at, ${p}last_error, ${p}message_id, ${p}smtp_response, ${p}sent_via, ${p}requested_by_email, ${p}created_at, ${p}finished_at`;
}
const EMAIL_COLUMNS = emailColumns();

function toEmail(row: EmailRow): DocumentEmail {
  return {
    id: row.id,
    kind: row.document_kind,
    documentId: row.document_id,
    contactId: row.contact_id,
    batchId: row.batch_id,
    status: row.status,
    to: row.to_addresses,
    cc: row.cc_addresses,
    subject: row.subject,
    attachmentName: row.attachment_name,
    attempts: row.attempts,
    nextAttemptAt: row.status === "queued" ? row.next_attempt_at : null,
    lastError: row.last_error,
    messageId: row.message_id,
    smtpResponse: row.smtp_response,
    sentVia: row.sent_via,
    requestedByEmail: row.requested_by_email,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

/** Refuses queueing more than an organisation's daily limit of emails (payslips use it too). */
export async function checkDailyLimit(tx: OrgTx, adding: number): Promise<void> {
  const recent = await tx.query<{ count: string }>("select count(*)::text as count from document_emails where created_at > now() - interval '24 hours'");
  if (Number(recent.rows[0].count) + adding > MAX_EMAILS_PER_DAY) {
    throw new TooManyRequestsError(
      `This organisation has asked for ${recent.rows[0].count} emails in the last 24 hours. Tohyee sends at most ${MAX_EMAILS_PER_DAY} a day for one organisation, so email providers don't block the account. Try again later.`,
    );
  }
}

/** Refuses (503) when the organisation's email account isn't set up (payslips use it too). */
export async function requireAccount(tx: OrgTx): Promise<void> {
  const account = await getOrganisationEmailSettings(tx);
  if (!account.configured) {
    throw new UnavailableError(account.hasPassword ? "The saved email password can't be read on this server any more. An admin needs to enter it again in Settings > Email." : NOT_SET_UP);
  }
}

async function insertEmail(
  tx: OrgTx,
  values: {
    source: string;
    idempotencyKey: string;
    hash: string;
    subject: EmailSubject;
    batchId: string | null;
    to: string[];
    cc: string[];
    subjectLine: string;
    body: string;
  },
): Promise<DocumentEmail> {
  const inserted = await tx.query<EmailRow>(
    `insert into document_emails (command_source, idempotency_key, request_hash, document_kind, document_id, contact_id, statement, batch_id,
                                  to_addresses, cc_addresses, subject, body, attachment_name, requested_by_user_id, requested_by_email)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13, $14, $15)
     returning ${EMAIL_COLUMNS}`,
    [
      values.source,
      values.idempotencyKey,
      values.hash,
      values.subject.kind,
      values.subject.documentId,
      values.subject.contactId,
      values.subject.statement ? JSON.stringify(values.subject.statement) : null,
      values.batchId,
      values.to,
      values.cc,
      values.subjectLine,
      values.body,
      values.subject.attachmentName,
      tx.actor.userId,
      tx.actor.email,
    ],
  );
  const email = toEmail(inserted.rows[0]);
  await writeAuditEvent(tx, {
    eventType: "document_email.queued",
    entityType: EMAIL_HISTORY_ENTITY[values.subject.kind],
    entityId: values.subject.documentId,
    details: { emailId: email.id, kind: email.kind, to: email.to, cc: email.cc, subject: email.subject, attachmentName: email.attachmentName, batchId: values.batchId },
  });
  return email;
}

/**
 * Queues one email (bookkeepers and above). The To and Cc addresses, subject
 * and message are what the person sending typed (checked, with line breaks
 * taken out of the subject); the attachment is always the document's own
 * PDF, written when it's sent. Idempotent.
 */
export async function queueDocumentEmail(
  tx: OrgTx,
  input: { kind?: unknown; id?: unknown; statement?: unknown; to?: unknown; cc?: unknown; subject?: unknown; body?: unknown; idempotencyKey?: unknown; source?: unknown },
): Promise<{ created: boolean; email: DocumentEmail }> {
  const source = optionalSource(input.source);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const to = requireAddresses(input.to, "To", { required: true });
  const cc = requireAddresses(input.cc, "Cc", { required: false }).filter((address) => !to.includes(address));
  const subjectLine = headerText(typeof input.subject === "string" ? input.subject : "", MAX_SUBJECT_LENGTH + 1);
  if (!subjectLine) throw new ValidationError("Enter a subject.");
  if (subjectLine.length > MAX_SUBJECT_LENGTH) throw new ValidationError(`The subject can be at most ${MAX_SUBJECT_LENGTH} characters.`);
  const body = typeof input.body === "string" ? input.body.replace(/\r\n?/g, "\n").trim() : "";
  if (!body) throw new ValidationError("Enter a message.");
  if (body.length > MAX_BODY_LENGTH) throw new ValidationError(`The message can be at most ${MAX_BODY_LENGTH.toLocaleString("en-NZ")} characters.`);
  const kind = requireOneOf(input.kind, "kind", EMAIL_DOCUMENT_KINDS);
  const documentId = requireId(input.id, kind === "statement" ? "contactId" : "id");
  const statement = kind === "statement" ? parseStatementOptions(input.statement) : null;
  const hash = requestHash("document_email", { kind, documentId, statement, to, cc, subject: subjectLine, body });
  const earlier = await tx.query<EmailRow>(`select ${EMAIL_COLUMNS} from document_emails where command_source = $1 and idempotency_key = $2`, [
    source,
    idempotencyKey,
  ]);
  if (earlier.rows[0]) {
    assertSameRequest(earlier.rows[0].request_hash, hash, "email");
    return { created: false, email: toEmail(earlier.rows[0]) };
  }
  await requireAccount(tx);
  await checkDailyLimit(tx, 1);
  const subject = await loadEmailSubject(tx, kind, documentId, statement ?? undefined);
  const email = await insertEmail(tx, { source, idempotencyKey, hash, subject, batchId: null, to, cc, subjectLine, body });
  return { created: true, email };
}

/** Emails asked for about one document (or, for statements, one customer), newest first. */
export async function listDocumentEmails(tx: OrgTx, kindInput: unknown, idInput: unknown): Promise<DocumentEmail[]> {
  const kind = requireOneOf(kindInput, "kind", EMAIL_DOCUMENT_KINDS);
  const documentId = requireId(idInput, "id");
  const result = await tx.query<EmailRow>(
    `select ${EMAIL_COLUMNS} from document_emails where document_kind = $1 and document_id = $2 order by id desc limit 100`,
    [kind, documentId],
  );
  return result.rows.map(toEmail);
}

/**
 * Sends a failed email again, exactly as it was (a new email in the history).
 * Only failed ones: a sent email is sent again from the dialog.
 */
export async function retryDocumentEmail(tx: OrgTx, emailIdInput: unknown, input: { idempotencyKey?: unknown; source?: unknown }): Promise<{ created: boolean; email: DocumentEmail }> {
  const emailId = requireId(emailIdInput, "emailId");
  const found = await tx.query<EmailRow & { body: string; statement: StatementOptions | null }>(
    `select ${EMAIL_COLUMNS}, body, statement from document_emails where id = $1`,
    [emailId],
  );
  const original = found.rows[0];
  if (!original) throw new NotFoundError("Email not found.");
  if (original.status !== "failed") throw new ConflictError("Only an email that failed can be tried again.");
  return queueDocumentEmail(tx, {
    kind: original.document_kind,
    id: original.document_id,
    statement: original.statement ?? undefined,
    to: original.to_addresses,
    cc: original.cc_addresses,
    subject: original.subject,
    body: original.body,
    idempotencyKey: input.idempotencyKey,
    source: input.source,
  });
}

// ---------------------------------------------------------------- statements to every customer with a balance

export type StatementRecipient = {
  contactId: string;
  name: string;
  /** What they owe on the statement's date (from aged receivables). */
  balance: string;
  to: string[];
  /** Why they won't get one, e.g. no email address. */
  skipReason: string | null;
};

export type StatementRunPreview = { options: StatementOptions; date: string; recipients: StatementRecipient[] };

/** Everyone who owes money on the statement's date, and the address each statement would go to. */
export async function previewStatementRun(tx: OrgTx, input: { statement?: unknown }): Promise<StatementRunPreview> {
  const options = parseStatementOptions(input.statement);
  if (options.includeSubCustomers) throw new ValidationError("Statements for everyone go to each customer separately, so sub-customers can't be included.");
  const date = options.statementKind === "activity" ? options.to! : options.asAt!;
  const aged = await agedReceivables(tx, { asAt: date });
  const recipients: StatementRecipient[] = [];
  for (const row of aged.rows) {
    if (cmp(dec(row.amounts.total), ZERO_DECIMAL) <= 0) continue;
    const contact = await contactAddresses(tx, row.contactId);
    recipients.push({
      contactId: row.contactId,
      name: row.name,
      balance: row.amounts.total,
      to: contact.to,
      skipReason: contact.to.length === 0 ? "No email address on the contact" : null,
    });
  }
  recipients.sort((left, right) => left.name.localeCompare(right.name, "en-NZ"));
  return { options, date, recipients };
}

export type StatementRun = {
  id: string;
  options: StatementOptions;
  requestedByEmail: string;
  createdAt: string;
  emails: Array<DocumentEmail & { contactName: string }>;
  skipped: StatementRecipient[];
};

/**
 * Queues a statement to every customer with a balance and an email address,
 * each filled from the statement template (bookkeepers and above).
 */
export async function queueStatementRun(
  tx: OrgTx,
  input: { statement?: unknown; idempotencyKey?: unknown; source?: unknown },
): Promise<{ created: boolean; run: StatementRun }> {
  const source = optionalSource(input.source);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const options = parseStatementOptions(input.statement);
  const hash = requestHash("statement_email_run", { options });
  const earlier = await tx.query<{ id: string; request_hash: string }>(
    "select id::text, request_hash from document_email_batches where command_source = $1 and idempotency_key = $2",
    [source, idempotencyKey],
  );
  if (earlier.rows[0]) {
    assertSameRequest(earlier.rows[0].request_hash, hash, "statement run");
    return { created: false, run: await getStatementRun(tx, earlier.rows[0].id) };
  }
  await requireAccount(tx);
  const preview = await previewStatementRun(tx, { statement: options });
  const sending = preview.recipients.filter((recipient) => recipient.to.length > 0);
  if (sending.length === 0) throw new ValidationError("No customer with a balance on that date has an email address, so there's nothing to send.");
  await checkDailyLimit(tx, sending.length);
  const batch = await tx.query<{ id: string }>(
    `insert into document_email_batches (command_source, idempotency_key, request_hash, statement, requested_by_user_id, requested_by_email)
     values ($1, $2, $3, $4::jsonb, $5, $6) returning id::text`,
    [source, idempotencyKey, hash, JSON.stringify({ ...options, skipped: preview.recipients.filter((recipient) => recipient.skipReason) }), tx.actor.userId, tx.actor.email],
  );
  const batchId = batch.rows[0].id;
  const template = await getEmailTemplate(tx, "statement");
  for (const recipient of sending) {
    const subject = await loadEmailSubject(tx, "statement", recipient.contactId, options);
    const subjectLine = headerText(fillTemplate(template.subject, subject.values), MAX_SUBJECT_LENGTH);
    const body = fillTemplate(template.body, subject.values);
    await insertEmail(tx, {
      source,
      idempotencyKey: `${idempotencyKey}:${recipient.contactId}`.slice(0, 120),
      hash: requestHash("document_email", { batchId, contactId: recipient.contactId }),
      subject,
      batchId,
      to: recipient.to,
      cc: [],
      subjectLine,
      body,
    });
  }
  return { created: true, run: await getStatementRun(tx, batchId) };
}

export async function getStatementRun(tx: OrgTx, batchIdInput: unknown): Promise<StatementRun> {
  const batchId = requireId(batchIdInput, "batchId");
  const batch = await tx.query<{ id: string; statement: StatementOptions & { skipped?: StatementRecipient[] }; requested_by_email: string; created_at: string }>(
    "select id::text, statement, requested_by_email, created_at from document_email_batches where id = $1",
    [batchId],
  );
  if (!batch.rows[0]) throw new NotFoundError("Statement run not found.");
  const emails = await tx.query<EmailRow & { contact_name: string }>(
    `select ${emailColumns("e")}, c.name as contact_name
       from document_emails e join contacts c on c.id = e.contact_id
      where e.batch_id = $1 order by lower(c.name), e.id`,
    [batchId],
  );
  const { skipped, ...options } = batch.rows[0].statement;
  return {
    id: batch.rows[0].id,
    options,
    requestedByEmail: batch.rows[0].requested_by_email,
    createdAt: batch.rows[0].created_at,
    emails: emails.rows.map((row) => ({ ...toEmail(row), contactName: row.contact_name })),
    skipped: skipped ?? [],
  };
}
