"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { useConfirm } from "@/components/confirm-dialog";
import { useApiData } from "@/components/hooks";
import { InfoTip } from "@/components/info-tip";
import { Badge, Button, Card, Field, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage } from "@/lib/client/api";
import { insertPlaceholder, previewTemplate } from "@/lib/email/setup";
import {
  EMAIL_DOCUMENT_KINDS,
  EMAIL_KIND_LABELS,
  type EmailDocumentKind,
  type EmailTemplate,
  MAX_BODY_LENGTH,
  MAX_SUBJECT_LENGTH,
  PLACEHOLDERS,
  unknownPlaceholders,
} from "@/lib/email/templates";
import wizard from "@/components/store-setup.module.css";
import styles from "./email-settings.module.css";

/**
 * Settings › Email › Templates (decision 1395): one line per document type
 * with its subject; each opens on its own, with the placeholders as buttons
 * that insert at the cursor and a preview filled with made-up values.
 */

type Loaded = { templates: EmailTemplate[] };

function TemplateBadge({ template }: { template: EmailTemplate }) {
  return template.isDefault ? <Badge>Tohyee&apos;s template</Badge> : <Badge tone="blue">Customised</Badge>;
}

export function isEmailKind(value: string): value is EmailDocumentKind {
  return (EMAIL_DOCUMENT_KINDS as readonly string[]).includes(value);
}

export function TemplateList({ organisationId }: { organisationId: string }) {
  const loaded = useApiData<Loaded>("/api/email/settings", { organisationId });
  if (loaded.error) return <Notice tone="error">{loaded.error}</Notice>;
  if (!loaded.data) return <p className={ui.muted}>Loading…</p>;
  return (
    <Card
      title="Templates"
      actions={
        <InfoTip label="Templates">
          The subject and message each email starts with. Words in braces are filled in from the document. The person sending can still change them.
        </InfoTip>
      }
    >
      <ul className={styles.list}>
        {loaded.data.templates.map((template) => (
          <li key={template.kind} className={styles.row}>
            <Link href={`/operations/settings/email/templates/${template.kind}`} className={styles.rowLink}>
              <span className={styles.rowName}>{EMAIL_KIND_LABELS[template.kind]}</span>
              <span className={styles.rowSubject}>
                <span className={ui.srOnly}>Subject: </span>
                {template.subject}
              </span>
              <TemplateBadge template={template} />
              <span className={styles.chevron} aria-hidden="true">
                ›
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function TemplateEditor({ organisationId, kind }: { organisationId: string; kind: EmailDocumentKind }) {
  const loaded = useApiData<Loaded>("/api/email/settings", { organisationId });
  const [saved, setSaved] = useState<EmailTemplate | null>(null);
  if (loaded.error) return <Notice tone="error">{loaded.error}</Notice>;
  const template = saved ?? loaded.data?.templates.find((candidate) => candidate.kind === kind) ?? null;
  if (!template) return <p className={ui.muted}>Loading…</p>;
  return <TemplateForm key={`${template.subject}\n${template.body}\n${template.isDefault}`} organisationId={organisationId} template={template} onSaved={setSaved} />;
}

function TemplateForm({ organisationId, template, onSaved }: { organisationId: string; template: EmailTemplate; onSaved: (template: EmailTemplate) => void }) {
  const confirm = useConfirm();
  const { current } = useWorkspace();
  const [subject, setSubject] = useState(template.subject);
  const [body, setBody] = useState(template.body);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const subjectRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  // Where a placeholder goes: the field last typed in (the message to start with).
  const target = useRef<"subject" | "body">("body");
  const label = EMAIL_KIND_LABELS[template.kind];
  const changed = subject !== template.subject || body !== template.body;
  const unknown = [...new Set([...unknownPlaceholders(template.kind, subject), ...unknownPlaceholders(template.kind, body)])];
  const preview = previewTemplate(template.kind, { subject, body }, current?.displayName ?? "");

  function insert(name: string) {
    const field = target.current === "subject" ? subjectRef.current : bodyRef.current;
    const value = target.current === "subject" ? subject : body;
    const start = field?.selectionStart ?? value.length;
    const end = field?.selectionEnd ?? value.length;
    const next = insertPlaceholder(value, start, end, name, target.current === "subject" ? MAX_SUBJECT_LENGTH : MAX_BODY_LENGTH);
    if (target.current === "subject") setSubject(next.text);
    else setBody(next.text);
    setMessage(null);
    // Back to the field, with the cursor after what was inserted.
    requestAnimationFrame(() => {
      field?.focus();
      field?.setSelectionRange(next.cursor, next.cursor);
    });
  }

  async function save(reset: boolean) {
    if (reset && !(await confirm(`Reset ${label.toLowerCase()} to Tohyee's template? Your changes are lost.`, { confirmLabel: "Reset" }))) return;
    setBusy(true);
    setError(null);
    try {
      const { templates } = await api<{ templates: EmailTemplate[] }>("/api/email/templates", {
        method: "PUT",
        body: { organisationId, kind: template.kind, subject, body, reset },
      });
      const after = templates.find((candidate) => candidate.kind === template.kind);
      if (after) onSaved(after);
      setMessage(reset ? "Back to Tohyee's template." : "Saved.");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.stack}>
      <Link href="/operations/settings/email/templates" className={styles.back}>
        <span aria-hidden="true">‹</span> Templates
      </Link>
      <Card title={label} actions={<TemplateBadge template={template} />}>
        {message ? <Notice tone="success">{message}</Notice> : null}
        {error ? <Notice tone="error">{error}</Notice> : null}
        <div className={styles.editor}>
          <div className={styles.stack}>
            <Field label="Subject">
              <input
                ref={subjectRef}
                value={subject}
                onChange={(event) => setSubject(event.target.value)}
                onFocus={() => (target.current = "subject")}
                maxLength={MAX_SUBJECT_LENGTH}
              />
            </Field>
            <div role="group" aria-label="Insert a placeholder">
              <ul className={styles.chips}>
                <li className={styles.chipsLabel}>
                  Insert{" "}
                  <InfoTip label="Placeholders">
                    Each is filled in from the document when it&apos;s emailed. It goes where the cursor was, in the subject or the message.
                  </InfoTip>
                </li>
                {PLACEHOLDERS[template.kind].map((name) => (
                  <li key={name}>
                    <button
                      type="button"
                      className={styles.chip}
                      aria-label={`Insert {${name}}`}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => insert(name)}
                    >
                      {`{${name}}`}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
            <Field label="Message">
              <textarea
                ref={bodyRef}
                rows={12}
                value={body}
                onChange={(event) => setBody(event.target.value)}
                onFocus={() => (target.current = "body")}
                maxLength={MAX_BODY_LENGTH}
              />
            </Field>
            {unknown.length > 0 ? (
              <Notice tone="warning">
                {unknown.join(", ")} can&apos;t be filled in for {label.toLowerCase()}.
              </Notice>
            ) : null}
          </div>
          <section className={styles.preview} aria-label="Preview">
            <p className={styles.previewLabel}>
              Preview{" "}
              <InfoTip label="The preview">Filled with made-up values. Real emails use the document&apos;s own.</InfoTip>
            </p>
            <p className={styles.previewSubject}>{preview.subject || " "}</p>
            <p className={styles.previewBody}>{preview.body}</p>
          </section>
        </div>
        <div className={wizard.footer}>
          <div className={ui.actions}>
            {!template.isDefault ? (
              <Button variant="secondary" onClick={() => void save(true)} disabled={busy}>
                Reset to Tohyee&apos;s template
              </Button>
            ) : null}
          </div>
          <div className={wizard.footerRight}>
            {changed ? <span className={ui.muted} style={{ alignSelf: "center" }}>Not saved yet</span> : null}
            <Button onClick={() => void save(false)} disabled={busy || !changed || unknown.length > 0 || !subject.trim() || !body.trim()}>
              {busy ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
