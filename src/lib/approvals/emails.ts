import { type Actor, withOrganisationTransaction } from "@/lib/db/org-transaction";
import { explainOpenError, openSender, saveSenderTokens, type Sender } from "@/lib/email/sender";
import { readSendingAccount, type SendingAccount } from "@/lib/email/settings";
import { newMessageId } from "@/lib/email/smtp";
import type { OrganisationRecord } from "@/lib/organisations/registry";
import type { PeopleNames } from "@/lib/people/names";

/**
 * Sends the emails asking approvers to approve (AW3, AW12), through the
 * organisation's own email, as the document email job does: claimed in one
 * transaction (`skip locked`), sent with no transaction open, and the result
 * recorded in another. A problem that usually passes is tried again after
 * 1, 5 and 30 minutes; anything else (email not set up) is `failed`, and the
 * approval page says so. The approvals page always lists what's waiting, so
 * a failed email never holds anything up. Plain text, with a link that needs
 * signing in; nothing is approved from the email.
 */

const JOB_ACTOR: Actor = { userId: null, email: "email job" };
const BATCH = 20;
const MAX_ATTEMPTS = 4;
const RETRY_MINUTES = [1, 5, 30];
const STALE_MINUTES = 10;

type Row = { id: string; to_email: string; subject: string; body: string; attempts: number };
type Outcome = { kind: "sent" } | { kind: "failed"; error: string; retryable: boolean };

export async function sendApprovalEmails(organisation: OrganisationRecord, people: PeopleNames, now = new Date()): Promise<{ sent: number; failed: number; waiting: number }> {
  const result = { sent: 0, failed: 0, waiting: 0 };
  for (;;) {
    const { rows, account, accountError } = await withOrganisationTransaction(
      organisation,
      JOB_ACTOR,
      async (tx) => {
        await tx.query(
          `update approval_emails set status = 'failed', finished_at = now(),
                  last_error = 'Tohyee stopped while this email was being sent, so it may or may not have gone.'
            where status = 'sending' and claimed_at < $1::timestamptz - make_interval(mins => $2)`,
          [now.toISOString(), STALE_MINUTES],
        );
        const claimed = await tx.query<Row>(
          `update approval_emails set status = 'sending', claimed_at = $1::timestamptz, attempts = attempts + 1
            where id in (select id from approval_emails where status = 'queued' and next_attempt_at <= $1::timestamptz
                          order by next_attempt_at, id limit $2 for update skip locked)
            returning id::text, to_email, subject, body, attempts`,
          [now.toISOString(), BATCH],
        );
        if (claimed.rows.length === 0) return { rows: claimed.rows, account: null, accountError: null };
        try {
          return { rows: claimed.rows, account: await readSendingAccount(tx), accountError: null };
        } catch (error) {
          return { rows: claimed.rows, account: null, accountError: error instanceof Error ? error.message : String(error) };
        }
      },
      { people },
    );
    if (rows.length === 0) break;
    let sender: Sender | null = null;
    let openError: { message: string; retryable: boolean } | null = accountError ? { message: `It wasn't sent: ${accountError}`, retryable: false } : null;
    if (account) {
      try {
        sender = await openSender(account, (tokens) => withOrganisationTransaction(organisation, JOB_ACTOR, (tx) => saveSenderTokens(tx, account, tokens), { people }));
      } catch (error) {
        openError = explainOpenError(account, error);
      }
    }
    try {
      for (const row of rows) {
        const outcome: Outcome =
          account && sender ? await sendOne(organisation, account, sender, row) : { kind: "failed", error: openError!.message, retryable: openError!.retryable };
        await withOrganisationTransaction(
          organisation,
          JOB_ACTOR,
          async (tx) => {
            if (outcome.kind === "sent") {
              await tx.query("update approval_emails set status = 'sent', finished_at = now(), last_error = null where id = $1", [row.id]);
              result.sent += 1;
            } else if (outcome.retryable && row.attempts < MAX_ATTEMPTS) {
              const wait = RETRY_MINUTES[Math.min(row.attempts - 1, RETRY_MINUTES.length - 1)];
              await tx.query("update approval_emails set status = 'queued', next_attempt_at = $2, last_error = $3 where id = $1", [
                row.id,
                new Date(now.getTime() + wait * 60_000).toISOString(),
                outcome.error,
              ]);
            } else {
              await tx.query("update approval_emails set status = 'failed', finished_at = now(), last_error = $2 where id = $1", [row.id, outcome.error]);
              result.failed += 1;
            }
          },
          { people },
        );
      }
    } finally {
      sender?.close();
    }
  }
  const waiting = await withOrganisationTransaction(
    organisation,
    JOB_ACTOR,
    (tx) => tx.query<{ count: string }>("select count(*)::text as count from approval_emails where status in ('queued', 'sending')"),
    { people },
  );
  result.waiting = Number(waiting.rows[0].count);
  return result;
}

async function sendOne(organisation: OrganisationRecord, account: SendingAccount, sender: Sender, row: Row): Promise<Outcome> {
  try {
    await sender.send({
      to: [row.to_email],
      cc: [],
      subject: row.subject,
      text: row.body,
      html: null,
      attachment: null,
      inline: [],
      messageId: newMessageId(account, organisation.id, `approval-${row.id}`),
    });
    return { kind: "sent" };
  } catch (error) {
    const explained = sender.explain(error);
    return { kind: "failed", error: explained.message, retryable: explained.retryable };
  }
}
