import { createHash } from "node:crypto";
import { writeAuditEvent } from "@/lib/audit";
import { type Actor, type OrgTx, withOrganisationTransaction } from "@/lib/db/org-transaction";
import { EMAIL_HISTORY_ENTITY, loadEmailSubject, type StatementOptions } from "@/lib/email/documents";
import { emailSummary, renderEmailHtml } from "@/lib/email/html";
import { explainOpenError, openSender, saveSenderTokens, type Sender, type SendingVia } from "@/lib/email/sender";
import { readSendingAccount, type SendingAccount } from "@/lib/email/settings";
import { type InlineImage, newMessageId } from "@/lib/email/smtp";
import type { EmailDocumentKind } from "@/lib/email/templates";
import { HttpError } from "@/lib/errors";
import { formatGstNumber } from "@/lib/format";
import { listAllOrganisations } from "@/lib/organisations/admin";
import { emailLogo, getLogo } from "@/lib/organisations/logo";
import { getOrganisation, type OrganisationRecord } from "@/lib/organisations/registry";
import { getOrganisationSettings } from "@/lib/organisations/settings";
import { getPayslip } from "@/lib/payroll/payslips";
import { renderDocumentPdf, renderStatementPdf } from "@/lib/pdf/documents";
import { renderPayslipPdf } from "@/lib/pdf/payslip";
import { loadMemberNames, type PeopleNames } from "@/lib/people/names";

/**
 * The background job that sends queued document emails. For each email:
 *
 * 1. claim it (one transaction; `for update skip locked`, so two server
 *    processes never send the same email),
 * 2. load the document and check it can still be sent (a transaction),
 *    then write its PDF,
 * 3. send it through the organisation's SMTP account or Microsoft mailbox
 *    (`sender.ts`; no transaction open), as HTML with the logo and a plain-
 *    text version,
 * 4. record what happened (a transaction): `sent` with the SMTP server's
 *    message id and reply (or Microsoft's request id) only when it was
 *    accepted; a problem that
 *    usually passes (busy server, no connection) is tried again after 1, 5
 *    and 30 minutes; anything else, or a fourth failure, is `failed` with
 *    the reason in plain English. Each result goes in the document's history.
 *
 * An email left "sending" for 10 minutes (the server stopped mid-send) is
 * marked failed rather than sent again, since it may already have gone.
 * Each organisation sends at most 100 emails an hour; the rest wait.
 * Off with TOHYEE_EMAIL_OUTBOX=off (the job, and sending straight after
 * someone asks); tests call `processOrganisationOutbox` directly.
 */

export const HOURLY_LIMIT = 100;
const BATCH = 20;
export const MAX_ATTEMPTS = 4;
/** Minutes to wait before attempt 2, 3 and 4. */
const RETRY_MINUTES = [1, 5, 30];
const STALE_MINUTES = 10;

const JOB_ACTOR: Actor = { userId: null, email: "email job" };

type ClaimedRow = {
  id: string;
  document_kind: EmailDocumentKind | "payslip";
  /** For a payslip (PSLIP5), its pay run's id (the history it goes in). */
  document_id: string;
  contact_id: string | null;
  /** Payslips only: whose payslip. */
  employee_id: string | null;
  statement: StatementOptions | null;
  to_addresses: string[];
  cc_addresses: string[];
  subject: string;
  body: string;
  attachment_name: string;
  attempts: number;
  requested_by_user_id: string | null;
  requested_by_email: string;
};

export type OutboxResult = { sent: number; failed: number; retrying: number; waiting: number };

function actorFor(row: Pick<ClaimedRow, "requested_by_user_id" | "requested_by_email">): Actor {
  return { userId: row.requested_by_user_id, email: row.requested_by_email };
}

async function auditEmail(
  tx: OrgTx,
  row: Pick<ClaimedRow, "id" | "document_kind" | "document_id" | "employee_id">,
  eventType: string,
  details: Record<string, unknown>,
): Promise<void> {
  await writeAuditEvent(tx, {
    eventType,
    entityType: EMAIL_HISTORY_ENTITY[row.document_kind],
    entityId: row.document_id,
    // A payslip's history says whose it was, never its figures (PSLIP5).
    details: { emailId: row.id, kind: row.document_kind, ...(row.employee_id ? { employeeId: row.employee_id } : {}), ...details },
  });
}

/** Marks emails stuck in "sending" as failed (the server stopped while sending them). */
async function failStale(tx: OrgTx, now: Date): Promise<void> {
  const stale = await tx.query<ClaimedRow>(
    `update document_emails set status = 'failed', finished_at = now(),
            last_error = 'Tohyee stopped while this email was being sent, so it may or may not have gone. Check with the recipient before sending it again.'
      where status = 'sending' and claimed_at < $1::timestamptz - make_interval(mins => $2)
      returning id::text, document_kind, coalesce(document_id::text, pay_run_id::text) as document_id, employee_id::text,
                requested_by_user_id::text, requested_by_email, to_addresses`,
    [now.toISOString(), STALE_MINUTES],
  );
  for (const row of stale.rows) {
    await auditEmail(tx, row, "document_email.failed", { to: row.to_addresses, error: "The server stopped while sending." });
  }
}

async function claim(tx: OrgTx, now: Date): Promise<ClaimedRow[]> {
  await failStale(tx, now);
  const used = await tx.query<{ count: string }>(
    "select count(*)::text as count from document_emails where claimed_at > $1::timestamptz - interval '1 hour'",
    [now.toISOString()],
  );
  const room = Math.min(BATCH, HOURLY_LIMIT - Number(used.rows[0].count));
  if (room <= 0) return [];
  const claimed = await tx.query<ClaimedRow>(
    `update document_emails set status = 'sending', claimed_at = $1::timestamptz, attempts = attempts + 1
      where id in (select id from document_emails where status = 'queued' and next_attempt_at <= $1::timestamptz
                    order by next_attempt_at, id limit $2 for update skip locked)
      returning id::text, document_kind, coalesce(document_id::text, pay_run_id::text) as document_id, contact_id::text, employee_id::text,
                statement, to_addresses, cc_addresses, subject, body,
                attachment_name, attempts, requested_by_user_id::text, requested_by_email`,
    [now.toISOString(), room],
  );
  return claimed.rows.sort((left, right) => Number(left.id) - Number(right.id));
}

type Outcome =
  | { kind: "sent"; via: SendingVia; messageId: string; response: string; rejected: string[]; sha256: string; bytes: number }
  | { kind: "failed"; error: string; retryable: boolean };

async function record(tx: OrgTx, row: ClaimedRow, outcome: Outcome, now: Date): Promise<"sent" | "failed" | "retrying"> {
  if (outcome.kind === "sent") {
    await tx.query(
      `update document_emails set status = 'sent', finished_at = now(), message_id = $2, smtp_response = $3, attachment_sha256 = $4,
              attachment_bytes = $5, last_error = $6, sent_via = $7
        where id = $1`,
      [
        row.id,
        outcome.messageId,
        outcome.response.slice(0, 1000),
        outcome.sha256,
        outcome.bytes,
        outcome.rejected.length > 0 ? `Refused by the email server: ${outcome.rejected.join(", ")}` : null,
        outcome.via,
      ],
    );
    await auditEmail(tx, row, "document_email.sent", {
      to: row.to_addresses,
      cc: row.cc_addresses,
      subject: row.subject,
      attachmentName: row.attachment_name,
      messageId: outcome.messageId,
      sentVia: outcome.via,
      smtpResponse: outcome.response.slice(0, 300),
      rejected: outcome.rejected,
      requestedByEmail: row.requested_by_email,
    });
    return "sent";
  }
  if (outcome.retryable && row.attempts < MAX_ATTEMPTS) {
    const wait = RETRY_MINUTES[Math.min(row.attempts - 1, RETRY_MINUTES.length - 1)];
    const next = new Date(now.getTime() + wait * 60_000);
    await tx.query(`update document_emails set status = 'queued', next_attempt_at = $2, last_error = $3 where id = $1`, [row.id, next.toISOString(), outcome.error]);
    await auditEmail(tx, row, "document_email.retrying", { to: row.to_addresses, error: outcome.error, attempt: row.attempts, nextAttemptAt: next.toISOString() });
    return "retrying";
  }
  await tx.query(`update document_emails set status = 'failed', finished_at = now(), last_error = $2 where id = $1`, [row.id, outcome.error]);
  await auditEmail(tx, row, "document_email.failed", { to: row.to_addresses, error: outcome.error, attempts: row.attempts });
  return "failed";
}

type Content = { attachment: { fileName: string; bytes: Uint8Array }; html: string; inline: InlineImage[] };

/**
 * What goes in the email besides its text: the PDF (written from the
 * document as it is now, which was checked can still be sent), and the HTML
 * version with the organisation's logo as an inline image.
 */
async function contentFor(organisation: OrganisationRecord, people: PeopleNames, account: SendingAccount, row: ClaimedRow): Promise<Content> {
  if (row.document_kind === "payslip") return payslipContentFor(organisation, people, account, row);
  const kind = row.document_kind as EmailDocumentKind;
  const loaded = await withOrganisationTransaction(
    organisation,
    actorFor(row),
    async (tx) => {
      const subject = await loadEmailSubject(tx, kind, row.document_id, row.statement ?? undefined);
      return { subject, settings: await getOrganisationSettings(tx), logo: await getLogo(tx) };
    },
    { people },
  );
  const { subject, settings, logo } = loaded;
  const pdf = subject.printed
    ? await renderDocumentPdf(subject.printed, { logo })
    : await renderStatementPdf(subject.statementData!, { name: settings.displayName, postalAddress: settings.postalAddress }, { logo });
  const image = emailLogo(logo);
  const html = renderEmailHtml({
    subject: row.subject,
    body: row.body,
    organisation: {
      name: settings.displayName,
      postalAddress: settings.postalAddress,
      gstNumber: settings.gstNumber ? formatGstNumber(settings.gstNumber) : null,
      email: account.replyTo ?? account.fromAddress,
    },
    summary: emailSummary(kind, subject.values),
    logo: image?.html ?? null,
  });
  return {
    // The name shown when it was queued is the one it goes out with.
    attachment: { fileName: row.attachment_name, bytes: pdf.bytes },
    html,
    inline: image ? [image.inline] : [],
  };
}

/**
 * A payslip email (PSLIP5): the payslip is loaded as the person who asked
 * (so it needs their payroll access now, not just when they asked) and its
 * PDF written. The email itself shows no figures.
 */
async function payslipContentFor(organisation: OrganisationRecord, people: PeopleNames, account: SendingAccount, row: ClaimedRow): Promise<Content> {
  const loaded = await withOrganisationTransaction(
    organisation,
    actorFor(row),
    async (tx) => ({ payslip: await getPayslip(tx, row.document_id, row.employee_id), settings: await getOrganisationSettings(tx), logo: await getLogo(tx) }),
    { people },
  );
  const pdf = await renderPayslipPdf(loaded.payslip, { logo: loaded.logo });
  const image = emailLogo(loaded.logo);
  const html = renderEmailHtml({
    subject: row.subject,
    body: row.body,
    organisation: {
      name: loaded.settings.displayName,
      postalAddress: loaded.settings.postalAddress,
      gstNumber: null,
      email: account.replyTo ?? account.fromAddress,
    },
    summary: [],
    logo: image?.html ?? null,
  });
  return { attachment: { fileName: row.attachment_name, bytes: pdf.bytes }, html, inline: image ? [image.inline] : [] };
}

async function sendOne(organisation: OrganisationRecord, people: PeopleNames, account: SendingAccount, sender: Sender, row: ClaimedRow): Promise<Outcome> {
  let content: Content;
  try {
    content = await contentFor(organisation, people, account, row);
  } catch (error) {
    if (error instanceof HttpError) {
      return { kind: "failed", error: `It wasn't sent: ${error.message}`, retryable: false };
    }
    console.warn(`[tohyee] Email ${row.id} for ${organisation.id}: couldn't write the PDF:`, error);
    return { kind: "failed", error: "Tohyee couldn't write the PDF to attach. Check the server logs.", retryable: false };
  }
  try {
    const result = await sender.send({
      to: row.to_addresses,
      cc: row.cc_addresses,
      subject: row.subject,
      text: row.body,
      html: content.html,
      attachment: content.attachment,
      inline: content.inline,
      messageId: newMessageId(account, organisation.id, row.id),
    });
    return {
      kind: "sent",
      via: sender.via,
      ...result,
      sha256: createHash("sha256").update(content.attachment.bytes).digest("hex"),
      bytes: content.attachment.bytes.length,
    };
  } catch (error) {
    const explained = sender.explain(error);
    return { kind: "failed", error: explained.message, retryable: explained.retryable };
  }
}

/** Sends what's due for one organisation. Returns what happened and how many are still waiting. */
export async function processOrganisationOutbox(organisation: OrganisationRecord, options: { now?: Date } = {}): Promise<OutboxResult> {
  const result: OutboxResult = { sent: 0, failed: 0, retrying: 0, waiting: 0 };
  const people = await loadMemberNames(organisation.id);
  for (;;) {
    const now = options.now ?? new Date();
    const { rows, account, accountError } = await withOrganisationTransaction(
      organisation,
      JOB_ACTOR,
      async (tx) => {
        const claimed = await claim(tx, now);
        if (claimed.length === 0) return { rows: claimed, account: null, accountError: null };
        try {
          return { rows: claimed, account: await readSendingAccount(tx), accountError: null };
        } catch (error) {
          return { rows: claimed, account: null, accountError: error instanceof Error ? error.message : String(error) };
        }
      },
      { people },
    );
    if (rows.length === 0) break;
    // Opening a Microsoft or Google sender may renew its sign-in (network, outside any transaction; the new tokens are saved in one of their own).
    let sender: Sender | null = null;
    let openError: { message: string; retryable: boolean } | null = accountError ? { message: `It wasn't sent: ${accountError}`, retryable: false } : null;
    if (account) {
      try {
        sender = await openSender(account, (tokens) =>
          withOrganisationTransaction(organisation, JOB_ACTOR, (tx) => saveSenderTokens(tx, account, tokens), { people }),
        );
      } catch (error) {
        openError = explainOpenError(account, error);
      }
    }
    try {
      for (const row of rows) {
        const outcome: Outcome =
          account && sender ? await sendOne(organisation, people, account, sender, row) : { kind: "failed", error: openError!.message, retryable: openError!.retryable };
        const recorded = await withOrganisationTransaction(organisation, actorFor(row), (tx) => record(tx, row, outcome, now), { people });
        result[recorded] += 1;
      }
    } finally {
      sender?.close();
    }
    if (options.now) break;
  }
  const waiting = await withOrganisationTransaction(
    organisation,
    JOB_ACTOR,
    (tx) => tx.query<{ count: string }>("select count(*)::text as count from document_emails where status in ('queued', 'sending')"),
    { people },
  );
  result.waiting = Number(waiting.rows[0].count);
  return result;
}

// ---------------------------------------------------------------- running it

const pending = new Set<string>();
let running = false;
let again = false;

function outboxOn(): boolean {
  return process.env.TOHYEE_EMAIL_OUTBOX !== "off";
}

async function runPending(): Promise<void> {
  if (running) {
    again = true;
    return;
  }
  running = true;
  try {
    do {
      again = false;
      for (const organisationId of [...pending]) {
        pending.delete(organisationId);
        try {
          const organisation = await getOrganisation(organisationId);
          if (!organisation || !organisation.isActive || organisation.provisioningStatus !== "ready" || organisation.migrationStatus !== "current") continue;
          const result = await processOrganisationOutbox(organisation);
          if (result.waiting > 0) pending.add(organisationId);
        } catch (error) {
          pending.add(organisationId);
          console.warn(`[tohyee] Sending emails for ${organisationId} failed: ${error instanceof Error ? error.message : error}`);
        }
      }
    } while (again);
  } finally {
    running = false;
  }
}

/** Starts sending an organisation's queued emails now, in the background (after someone asks to send). */
export function kickEmailOutbox(organisationId: string): void {
  if (!outboxOn()) return;
  pending.add(organisationId);
  setTimeout(() => void runPending(), 0);
}

/** Finds organisations with emails waiting (after a restart, or retries). */
async function scanAll(): Promise<void> {
  for (const organisation of await listAllOrganisations()) {
    if (!organisation.isActive || organisation.provisioningStatus !== "ready" || organisation.migrationStatus !== "current") continue;
    try {
      const waiting = await withOrganisationTransaction(organisation, JOB_ACTOR, (tx) =>
        tx.query("select 1 from document_emails where status in ('queued', 'sending') limit 1"),
      );
      if ((waiting.rowCount ?? 0) > 0) pending.add(organisation.id);
    } catch (error) {
      console.warn(`[tohyee] Checking emails for ${organisation.id} failed: ${error instanceof Error ? error.message : error}`);
    }
  }
  await runPending();
}

let timers: NodeJS.Timeout[] = [];

/** Every minute: organisations with emails waiting. Every 10 minutes (and 30 seconds after start): a check of every organisation. */
export function startEmailOutbox(): void {
  if (timers.length > 0 || !outboxOn()) return;
  const safe = (work: () => Promise<void>) => () => {
    work().catch((error) => console.warn("[tohyee] Email sending job:", error));
  };
  timers = [setInterval(safe(runPending), 60_000), setInterval(safe(scanAll), 10 * 60_000)];
  for (const timer of timers) timer.unref?.();
  setTimeout(safe(scanAll), 30_000).unref?.();
}
