"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Money } from "@/components/books";
import { EmailStatusBadge, type StatementQuery } from "@/components/documents/email-document";
import { useApiData } from "@/components/hooks";
import { Button, Card, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import type { StatementRun, StatementRunPreview } from "@/lib/email/documents";
import { formatDate } from "@/lib/format";
import { useConfirm } from "@/components/confirm-dialog";

/**
 * Contacts › Customer statements › "Email statements to every customer with
 * a balance" (bookkeepers and above): a preview of who gets one and at which
 * address (and who doesn't, and why), then one email each with their own
 * statement's PDF, and the result for each customer as the server sends them.
 */
export function StatementRunCard({ organisationId, statement }: { organisationId: string; statement: StatementQuery }) {
  const confirm = useConfirm();
  const { can } = useWorkspace();
  const [previewing, setPreviewing] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState(() => newIdempotencyKey("statement-run"));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const query = { organisationId, statementKind: statement.statementKind, from: statement.from ?? null, to: statement.to ?? null, asAt: statement.asAt ?? null };
  const preview = useApiData<StatementRunPreview>(previewing ? "/api/email/statements" : null, query);
  const run = useApiData<{ run: StatementRun }>(runId ? `/api/email/statements/${runId}` : null, { organisationId });
  const { reload } = run;
  const waiting = (run.data?.run.emails ?? []).some((email) => email.status === "queued" || email.status === "sending");
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(reload, 3000);
    return () => clearInterval(timer);
  }, [waiting, reload]);
  if (!can("bookkeeper")) return null;
  const date = statement.statementKind === "activity" ? statement.to : statement.asAt;
  const sending = (preview.data?.recipients ?? []).filter((recipient) => recipient.to.length > 0);

  async function send() {
    if (!(await confirm(`Email ${sending.length} statement${sending.length === 1 ? "" : "s"} now?`))) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ run: StatementRun }>("/api/email/statements", {
        method: "POST",
        body: { organisationId, idempotencyKey, statement: { statementKind: statement.statementKind, from: statement.from, to: statement.to, asAt: statement.asAt } },
      });
      setRunId(result.run.id);
      setPreviewing(false);
      setIdempotencyKey(newIdempotencyKey("statement-run"));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title="Email statements to every customer with a balance"
      description={`${statement.statementKind === "activity" ? "Activity statements" : "Outstanding statements"} to ${formatDate(date)}, each customer getting their own, from the organisation's email account.`}
      actions={
        !previewing ? (
          <Button
            size="small"
            variant="secondary"
            onClick={() => {
              setPreviewing(true);
              setRunId(null);
            }}
          >
            See who gets one
          </Button>
        ) : null
      }
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      {previewing && preview.error ? <Notice tone="error">{preview.error}</Notice> : null}
      {previewing && preview.loading ? <p className={ui.muted}>Loading…</p> : null}
      {previewing && preview.data ? (
        preview.data.recipients.length === 0 ? (
          <p className={ui.muted}>No customer owes anything on {formatDate(date)}.</p>
        ) : (
          <>
            <div className={ui.tableWrap}>
              <table className={ui.table}>
                <thead>
                  <tr>
                    <th>Customer</th>
                    <th className={ui.num}>Balance</th>
                    <th>Sent to</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.data.recipients.map((recipient) => (
                    <tr key={recipient.contactId}>
                      <td>
                        <Link href={`/operations/customer-statements?contact=${recipient.contactId}`}>{recipient.name}</Link>
                      </td>
                      <td className={ui.num}>
                        <Money value={recipient.balance} />
                      </td>
                      <td>{recipient.skipReason ? <span className={ui.muted}>Not sent: {recipient.skipReason}</span> : recipient.to.join(", ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className={ui.actions}>
              <Button onClick={() => void send()} disabled={busy || sending.length === 0}>
                Email {sending.length} statement{sending.length === 1 ? "" : "s"}
              </Button>
              <Button variant="secondary" onClick={() => setPreviewing(false)}>
                Cancel
              </Button>
            </div>
          </>
        )
      ) : null}
      {run.error ? <Notice tone="error">{run.error}</Notice> : null}
      {run.data ? (
        <div className={ui.tableWrap}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th>Customer</th>
                <th>To</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {run.data.run.emails.map((email) => (
                <tr key={email.id}>
                  <td>{email.contactName}</td>
                  <td>{email.to.join(", ")}</td>
                  <td>
                    <EmailStatusBadge status={email.status} /> {email.status === "failed" || (email.status === "queued" && email.attempts > 0) ? email.lastError : null}
                  </td>
                </tr>
              ))}
              {run.data.run.skipped.map((skipped) => (
                <tr key={`skipped-${skipped.contactId}`}>
                  <td>{skipped.name}</td>
                  <td />
                  <td className={ui.muted}>Not sent: {skipped.skipReason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Card>
  );
}
