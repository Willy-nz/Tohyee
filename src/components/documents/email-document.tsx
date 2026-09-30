"use client";

import Link from "next/link";
import { type FormEvent, useEffect, useState } from "react";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Field, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import type { DocumentEmail, PreparedEmail } from "@/lib/email/documents";
import { EMAIL_KIND_NOUNS, type EmailDocumentKind } from "@/lib/email/templates";
import { formatDateTime, personName } from "@/lib/format";

/**
 * The Email card on invoices, credit notes, quotes, purchase orders and
 * customer statements: the emails sent about this document (who asked, to
 * whom, when, and what the email server said), and for bookkeepers and
 * above an Email button that opens the form (To, Cc, subject and message
 * from the template, the PDF's name). Sending queues the email; the server
 * sends it and the list updates. Nothing shows as sent until the email
 * server has accepted it.
 */

export type StatementQuery = {
  statementKind: "activity" | "outstanding";
  from?: string;
  to?: string;
  asAt?: string;
  includeSubCustomers?: boolean;
};

type Props = {
  organisationId: string;
  kind: EmailDocumentKind;
  /** The document; for a statement, the customer. */
  id: string;
  statement?: StatementQuery;
  /** Whether the document can be emailed now (e.g. an approved invoice); otherwise why not. */
  unavailableReason?: string | null;
};

const STATUS: Record<DocumentEmail["status"], { label: string; tone: "neutral" | "blue" | "green" | "red" }> = {
  queued: { label: "Waiting to send", tone: "blue" },
  sending: { label: "Sending", tone: "blue" },
  sent: { label: "Sent", tone: "green" },
  failed: { label: "Failed", tone: "red" },
};

function statementParams(statement: StatementQuery | undefined): Record<string, string | null> {
  if (!statement) return {};
  return {
    statementKind: statement.statementKind,
    from: statement.from ?? null,
    to: statement.to ?? null,
    asAt: statement.asAt ?? null,
    includeSubCustomers: statement.includeSubCustomers ? "true" : null,
  };
}

/** The PDF the server attaches, as a link that opens it. */
export function pdfHref(organisationId: string, kind: EmailDocumentKind, id: string, statement?: StatementQuery): string {
  const query = new URLSearchParams({ organisationId, kind, id });
  for (const [name, value] of Object.entries(statementParams(statement))) if (value) query.set(name, value);
  return `/api/documents/pdf?${query.toString()}`;
}

export function EmailStatusBadge({ status }: { status: DocumentEmail["status"] }) {
  return <Badge tone={STATUS[status].tone}>{STATUS[status].label}</Badge>;
}

function EmailForm({ organisationId, kind, id, statement, onQueued, onCancel }: Props & { onQueued: () => void; onCancel: () => void }) {
  const { can } = useWorkspace();
  const prepared = useApiData<{ email: PreparedEmail }>("/api/email/prepare", { organisationId, kind, id, ...statementParams(statement) });
  const [edited, setEdited] = useState<{ to: string; cc: string; subject: string; body: string } | null>(null);
  const [idempotencyKey] = useState(() => newIdempotencyKey("email"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (prepared.error) return <Notice tone="error">{prepared.error}</Notice>;
  if (!prepared.data) return <p className={ui.muted}>Loading…</p>;
  const email = prepared.data.email;
  if (!email.configured) {
    return (
      <Notice tone="warning">
        {email.notice}{" "}
        {can("admin") ? <Link href="/operations/settings/email">Set up email</Link> : "Ask an admin of this organisation to set it up."}
      </Notice>
    );
  }
  const values = edited ?? { to: email.to.join(", "), cc: "", subject: email.subject, body: email.body };
  const set = (field: keyof typeof values) => (value: string) => setEdited({ ...values, [field]: value });

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/api/email/documents", {
        method: "POST",
        body: { organisationId, kind, id, statement, to: values.to, cc: values.cc, subject: values.subject, body: values.body, idempotencyKey },
      });
      onQueued();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} style={{ display: "grid", gap: 12 }}>
      {email.warnings.map((warning) => (
        <Notice key={warning} tone="warning">
          {warning}
        </Notice>
      ))}
      {error ? <Notice tone="error">{error}</Notice> : null}
      <p className={ui.muted} style={{ margin: 0 }}>
        From {email.from}. Replies go to {email.replyTo}.
      </p>
      <div className={ui.grid2}>
        <Field label="To" hint="Separate addresses with commas.">
          <input value={values.to} onChange={(event) => set("to")(event.target.value)} required />
        </Field>
        <Field label="Cc" hint="Optional.">
          <input value={values.cc} onChange={(event) => set("cc")(event.target.value)} />
        </Field>
      </div>
      <Field label="Subject">
        <input value={values.subject} onChange={(event) => set("subject")(event.target.value)} maxLength={250} required />
      </Field>
      <Field label="Message">
        <textarea rows={9} value={values.body} onChange={(event) => set("body")(event.target.value)} maxLength={10000} required />
      </Field>
      <div>
        Attachment:{" "}
        <a href={pdfHref(organisationId, kind, id, statement)} target="_blank" rel="noreferrer">
          {email.attachmentName}
        </a>
      </div>
      <div className={ui.actions}>
        <Button type="submit" disabled={busy}>
          {busy ? "Sending…" : "Send"}
        </Button>
        <Button variant="secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function RetryButton({ organisationId, email, onQueued }: { organisationId: string; email: DocumentEmail; onQueued: () => void }) {
  const [idempotencyKey] = useState(() => newIdempotencyKey("email-retry"));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function retry() {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/email/documents/${email.id}/retry`, { method: "POST", body: { organisationId, idempotencyKey } });
      onQueued();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Button size="small" variant="secondary" onClick={() => void retry()} disabled={busy}>
        Send again
      </Button>
      {error ? <Notice tone="error">{error}</Notice> : null}
    </>
  );
}

/** The emails sent about a document; refreshes itself while any are still waiting. */
export function EmailHistory({ organisationId, kind, id, version, onChanged }: { organisationId: string; kind: EmailDocumentKind; id: string; version: number; onChanged: () => void }) {
  const { can } = useWorkspace();
  const emails = useApiData<{ emails: DocumentEmail[] }>("/api/email/documents", { organisationId, kind, id, version });
  const { reload } = emails;
  const waiting = (emails.data?.emails ?? []).some((email) => email.status === "queued" || email.status === "sending");
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(reload, 3000);
    return () => clearInterval(timer);
  }, [waiting, reload]);
  if (emails.error) return <Notice tone="error">{emails.error}</Notice>;
  const list = emails.data?.emails ?? [];
  if (list.length === 0) return <p className={ui.muted}>Not emailed yet.</p>;
  return (
    <div className={ui.tableWrap}>
      <table className={ui.table}>
        <thead>
          <tr>
            <th>Status</th>
            <th>To</th>
            <th>Subject</th>
            <th>Asked by</th>
            <th>What happened</th>
          </tr>
        </thead>
        <tbody>
          {list.map((email) => (
            <tr key={email.id}>
              <td>
                <EmailStatusBadge status={email.status} />
              </td>
              <td>
                {email.to.join(", ")}
                {email.cc.length > 0 ? <div className={ui.muted}>Cc {email.cc.join(", ")}</div> : null}
              </td>
              <td>
                {email.subject}
                <div className={ui.muted}>{email.attachmentName}</div>
              </td>
              <td>
                {personName(email, "requestedBy")}
                <div className={ui.muted}>{formatDateTime(email.createdAt)}</div>
              </td>
              <td>
                {email.status === "sent" ? (
                  <>
                    Accepted by the email server {formatDateTime(email.finishedAt)}.
                    <div className={ui.muted} style={{ wordBreak: "break-all" }}>
                      Message id {email.messageId}
                    </div>
                    {email.lastError ? <div className={ui.muted}>{email.lastError}</div> : null}
                  </>
                ) : null}
                {email.status === "failed" ? (
                  <>
                    <div>{email.lastError}</div>
                    {can("bookkeeper") ? <RetryButton organisationId={organisationId} email={email} onQueued={onChanged} /> : null}
                  </>
                ) : null}
                {email.status === "queued" ? (
                  <>
                    {email.attempts > 0 ? `Not sent yet (tried ${email.attempts} time${email.attempts === 1 ? "" : "s"}): ${email.lastError ?? ""} ` : ""}
                    {email.nextAttemptAt && email.attempts > 0 ? `Trying again ${formatDateTime(email.nextAttemptAt)}.` : "Sending shortly."}
                  </>
                ) : null}
                {email.status === "sending" ? "Sending now." : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Whether a real send of this document has been accepted (quotes show "Sent" from this). */
export function useEmailedStatus(organisationId: string, kind: EmailDocumentKind, id: string, version = 0): boolean {
  const emails = useApiData<{ emails: DocumentEmail[] }>("/api/email/documents", { organisationId, kind, id, version });
  return (emails.data?.emails ?? []).some((email) => email.status === "sent");
}

export function EmailDocumentPanel(props: Props & { title?: string }) {
  const { can } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [version, setVersion] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const noun = EMAIL_KIND_NOUNS[props.kind];
  return (
    <Card
      title={props.title ?? "Email"}
      description={`Emails of this ${noun} with its PDF attached, sent from the organisation's own email account.`}
      actions={
        can("bookkeeper") && !open ? (
          <Button size="small" onClick={() => setOpen(true)} disabled={Boolean(props.unavailableReason)} title={props.unavailableReason ?? undefined}>
            Email {noun}
          </Button>
        ) : null
      }
    >
      {props.unavailableReason && can("bookkeeper") ? <p className={ui.muted}>{props.unavailableReason}</p> : null}
      {message ? <Notice tone="success">{message}</Notice> : null}
      {open ? (
        <EmailForm
          {...props}
          onCancel={() => setOpen(false)}
          onQueued={() => {
            setOpen(false);
            setMessage("Sending now. The email shows as sent below once the email server accepts it.");
            setVersion((value) => value + 1);
          }}
        />
      ) : null}
      <EmailHistory organisationId={props.organisationId} kind={props.kind} id={props.id} version={version} onChanged={() => setVersion((value) => value + 1)} />
    </Card>
  );
}
