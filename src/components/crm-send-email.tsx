"use client";

import Link from "next/link";
import { useState } from "react";
import { useBusy } from "@/components/crm";
import { useApiData } from "@/components/hooks";
import { Button, Field, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, newIdempotencyKey } from "@/lib/client/api";
import type { EmailDraft, EmailTemplate, SentEmail } from "@/lib/crm/sales-email";

type Target = { leadId: string } | { personId: string } | { opportunityId: string };

/**
 * "Send email" on a lead, person or deal (decision 496): pick a template or
 * start blank, check and edit the words, and send from your own mailbox.
 * Nothing goes until Send is pressed, and a retry never sends it twice.
 */
export function SendEmail({ organisationId, target, onSent }: { organisationId: string; target: Target; onSent?: () => void }) {
  const { canCrm } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<EmailDraft | null>(null);
  const [templateId, setTemplateId] = useState("");
  const [accountId, setAccountId] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState(() => newIdempotencyKey("email"));
  const [result, setResult] = useState<SentEmail | null>(null);
  const templates = useApiData<{ templates: EmailTemplate[] }>(open ? "/api/crm/email-templates" : null, { organisationId });
  const { busy, error, run } = useBusy();
  if (!canCrm("write")) return null;

  const load = (template: string) =>
    void run(async () => {
      const { draft: next } = await api<{ draft: EmailDraft }>("/api/crm/emails/draft", { method: "POST", body: { organisationId, ...target, templateId: template || null } });
      setDraft(next);
      setSubject(next.subject);
      setBody(next.body);
      setAccountId((now) => now || next.accounts[0]?.id || "");
    });

  if (!open) {
    return (
      <Button
        size="small"
        variant="secondary"
        onClick={() => {
          setOpen(true);
          setResult(null);
          setIdempotencyKey(newIdempotencyKey("email"));
          load("");
        }}
      >
        Send email
      </Button>
    );
  }

  const close = () => {
    setOpen(false);
    setDraft(null);
    setTemplateId("");
    setSubject("");
    setBody("");
  };
  const cannot = !draft
    ? null
    : !draft.to
      ? `${draft.name} has no email address.`
      : draft.optOut
        ? `${draft.name} asked not to be emailed.`
        : draft.accounts.length === 0
          ? "none"
          : null;

  return (
    <div style={{ display: "grid", gap: 10, padding: 12, border: "1px solid var(--line, #e5e5e5)", borderRadius: 8 }}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {result?.status === "sent" ? <Notice tone="success">Sent to {result.to}. It&apos;s logged as a note here.</Notice> : null}
      {result && result.status !== "sent" ? <Notice tone={result.status === "maybe_sent" || result.status === "sending" ? "warning" : "error"}>{result.error ?? "It isn't clear whether it went. Check your Sent folder."}</Notice> : null}
      {cannot === "none" ? (
        <Notice tone="warning">
          None of your mailboxes can send yet. Connect yours and choose Allow sending on <Link href="/crm/mail">Email and calendar</Link>.
        </Notice>
      ) : cannot ? (
        <Notice tone="warning">{cannot}</Notice>
      ) : null}
      {draft && !cannot && result?.status !== "sent" ? (
        <>
          <div className={ui.inlineForm}>
            <Field label="To">
              <input value={`${draft.name} <${draft.to}>`} readOnly />
            </Field>
            <Field label="From">
              <select value={accountId} onChange={(event) => setAccountId(event.target.value)}>
                {draft.accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.email}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Template">
              <select
                value={templateId}
                disabled={busy}
                onChange={(event) => {
                  setTemplateId(event.target.value);
                  load(event.target.value);
                }}
              >
                <option value="">None</option>
                {(templates.data?.templates ?? [])
                  .filter((template) => template.isActive)
                  .map((template) => (
                    <option key={template.id} value={template.id}>
                      {template.name}
                    </option>
                  ))}
              </select>
            </Field>
          </div>
          <Field label="Subject">
            <input value={subject} maxLength={200} onChange={(event) => setSubject(event.target.value)} />
          </Field>
          <Field label="Message" hint="Plain text. Check anything a template filled in before sending.">
            <textarea rows={10} value={body} maxLength={20000} onChange={(event) => setBody(event.target.value)} />
          </Field>
        </>
      ) : null}
      <span className={ui.rowButtons}>
        {draft && !cannot && result?.status !== "sent" && result?.status !== "maybe_sent" ? (
          <Button
            disabled={busy || !subject.trim() || !body.trim() || !accountId}
            onClick={() =>
              void run(async () => {
                const sent = await api<{ email: SentEmail }>("/api/crm/emails", {
                  method: "POST",
                  body: { organisationId, source: "ui", idempotencyKey, accountId, templateId: templateId || null, ...target, subject, body },
                });
                setResult(sent.email);
                // A clear failure wasn't sent, so a fresh try (perhaps with changed words) gets a new key.
                if (sent.email.status === "failed") setIdempotencyKey(newIdempotencyKey("email"));
                if (sent.email.status === "sent") onSent?.();
              })
            }
          >
            {busy ? "Sending…" : result?.status === "failed" ? "Try again" : "Send"}
          </Button>
        ) : null}
        <Button variant="secondary" onClick={close} disabled={busy}>
          {result?.status === "sent" ? "Done" : "Cancel"}
        </Button>
      </span>
    </div>
  );
}

/** "Don't email" on a lead or person (decision 496). */
export function EmailOptOut({ organisationId, target, optOut, onChanged }: { organisationId: string; target: { leadId: string } | { personId: string }; optOut: boolean; onChanged: () => void }) {
  const { canCrm } = useWorkspace();
  const { busy, error, run } = useBusy();
  return (
    <span>
      <label title="Tohyee won't send sales emails to someone who asked not to be emailed.">
        <input
          type="checkbox"
          checked={optOut}
          disabled={busy || !canCrm("write")}
          onChange={(event) =>
            void run(async () => {
              await api("/api/crm/email-opt-out", { method: "POST", body: { organisationId, ...target, optOut: event.target.checked } });
              onChanged();
            })
          }
        />{" "}
        Don&apos;t email
      </label>
      {error ? <Notice tone="error">{error}</Notice> : null}
    </span>
  );
}
