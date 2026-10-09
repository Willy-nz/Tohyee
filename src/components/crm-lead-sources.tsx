"use client";

import { useState } from "react";
import { useConfirm } from "@/components/confirm-dialog";
import { useBusy } from "@/components/crm";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Empty, Field, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import type { MailFolder } from "@/lib/analytics/report-email-providers";
import { api } from "@/lib/client/api";
import type { LeadForm, LeadMailbox, LeadMailCheck } from "@/lib/crm/lead-intake";
import { formatDateTime } from "@/lib/format";

type FormWithSnippet = LeadForm & { snippet: string | null };
type MailAccount = { id: string; userId: string; email: string; provider: "google" | "microsoft"; status: string };
const HOURS = [1, 2, 3, 4, 6, 8, 12, 24];

function WebForms({ organisationId }: { organisationId: string }) {
  const data = useApiData<{ publicAddress: string | null; forms: FormWithSnippet[] }>("/api/crm/lead-forms", { organisationId });
  const [name, setName] = useState("");
  const [thankYouUrl, setThankYouUrl] = useState("");
  const [shown, setShown] = useState<string | null>(null);
  const { busy, error, run } = useBusy();
  const forms = data.data?.forms ?? [];
  return (
    <Card
      title="From your website"
      description="A form on your own website sends enquiries straight in as leads to review. A hidden trap field and a limit per sender keep most spam out."
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      {data.error ? <Notice tone="error">{data.error}</Notice> : null}
      {data.data && !data.data.publicAddress ? (
        <Notice tone="warning">Your website can only reach Tohyee once remote access is on (server settings › Remote access). Forms made now start working then.</Notice>
      ) : null}
      {forms.length === 0 ? <Empty>No forms yet.</Empty> : null}
      {forms.map((form) => (
        <div key={form.id} style={{ borderTop: "1px solid var(--line, #e5e5e5)", padding: "8px 0", display: "grid", gap: 6 }}>
          <span style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
            <span>
              <strong>{form.name}</strong> {form.isActive ? null : <Badge>Off</Badge>}
              <span className={ui.muted}>
                {" "}
                · {form.leadsReceived} lead{form.leadsReceived === 1 ? "" : "s"}
                {form.lastLeadAt ? `, last ${formatDateTime(form.lastLeadAt)}` : ""}
              </span>
            </span>
            <span className={ui.rowButtons}>
              {form.snippet ? (
                <Button size="small" variant="secondary" onClick={() => setShown(shown === form.id ? null : form.id)}>
                  {shown === form.id ? "Hide the HTML" : "Show the HTML"}
                </Button>
              ) : null}
              <Button
                size="small"
                variant="secondary"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await api(`/api/crm/lead-forms/${form.id}`, { method: "PATCH", body: { organisationId, isActive: !form.isActive } });
                    data.reload();
                  })
                }
              >
                {form.isActive ? "Switch off" : "Switch on"}
              </Button>
            </span>
          </span>
          {shown === form.id && form.snippet ? (
            <>
              <p className={ui.muted}>
                Put this on your website (change the labels and add fields as you like; extra fields go into the lead&apos;s notes). Keep the hidden
                website_url field: it catches robots.
              </p>
              <textarea readOnly rows={11} value={form.snippet} onFocus={(event) => event.target.select()} style={{ fontFamily: "monospace", width: "100%" }} />
            </>
          ) : null}
        </div>
      ))}
      <form
        className={ui.inlineForm}
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            await api("/api/crm/lead-forms", { method: "POST", body: { organisationId, name, thankYouUrl: thankYouUrl || null } });
            setName("");
            setThankYouUrl("");
            data.reload();
          });
        }}
      >
        <Field label="New form" hint="e.g. Contact page">
          <input value={name} maxLength={100} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label="Thank-you page (optional)" hint="Where people go after sending; else a plain thank-you.">
          <input value={thankYouUrl} placeholder="https://" onChange={(event) => setThankYouUrl(event.target.value)} />
        </Field>
        <Button type="submit" disabled={busy || name.trim() === ""}>
          Add form
        </Button>
      </form>
    </Card>
  );
}

function AddMailbox({ organisationId, onAdded, onCancel }: { organisationId: string; onAdded: () => void; onCancel: () => void }) {
  const { user } = useWorkspace();
  const mail = useApiData<{ accounts: MailAccount[] }>("/api/crm/mail/accounts", { organisationId });
  const own = (mail.data?.accounts ?? []).filter((entry) => entry.userId === user.id && entry.status === "active");
  const [choice, setChoice] = useState("");
  const [host, setHost] = useState("imap.gmail.com");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [folders, setFolders] = useState<MailFolder[]>([]);
  const [folderId, setFolderId] = useState("");
  const [hours, setHours] = useState(1);
  const { busy, error, run } = useBusy();
  const mailBody = () =>
    choice === "imap" ? { mailKind: "imap", imapHost: host.trim(), imapUsername: username.trim(), imapPassword: password } : { mailKind: "crm", mailAccountId: choice };
  const reset = () => {
    setFolders([]);
    setFolderId("");
  };
  return (
    <div style={{ display: "grid", gap: 12 }}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <p className={ui.muted}>
        Set a rule in the mailbox to file enquiries (for example to sales@) into one folder or label. Each email there becomes a lead to review, from
        its sender, with its subject and the start of its text; an email from someone who&apos;s already an open lead adds a note to their lead. Tohyee
        reads each email once and never moves, marks or deletes it. It reads as you.
      </p>
      <div className={ui.grid3}>
        <Field label="Mailbox">
          <select
            value={choice}
            disabled={busy}
            onChange={(event) => {
              setChoice(event.target.value);
              setPassword("");
              reset();
            }}
          >
            <option value="">Choose a mailbox</option>
            {own.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.email} — {entry.provider === "google" ? "Gmail" : "Microsoft"}
              </option>
            ))}
            <option value="imap">IMAP with an app password</option>
          </select>
        </Field>
        {choice === "imap" ? (
          <>
            <Field label="IMAP host" hint="Port 993, TLS only.">
              <input value={host} disabled={busy} onChange={(event) => (setHost(event.target.value), reset())} />
            </Field>
            <Field label="Username">
              <input value={username} autoComplete="username" disabled={busy} onChange={(event) => (setUsername(event.target.value), reset())} />
            </Field>
            <Field label="App password" hint="Stored encrypted on the server and never shown again.">
              <input type="password" autoComplete="new-password" value={password} disabled={busy} onChange={(event) => (setPassword(event.target.value), reset())} />
            </Field>
          </>
        ) : null}
        <Field label="Check every" hint="Check now reads new emails any time.">
          <select value={hours} disabled={busy} onChange={(event) => setHours(Number(event.target.value))}>
            {HOURS.map((entry) => (
              <option key={entry} value={entry}>
                {entry === 1 ? "hour" : `${entry} hours`}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className={ui.actions} style={{ justifyContent: "flex-start" }}>
        <Button
          variant="secondary"
          disabled={busy || !choice || (choice === "imap" && (!host.trim() || !username.trim() || !password))}
          onClick={() =>
            void run(async () => {
              const result = await api<{ folders: MailFolder[] }>("/api/crm/lead-mailboxes/folders", { method: "POST", body: { organisationId, ...mailBody() } });
              setFolders(result.folders);
              setFolderId(result.folders[0]?.id ?? "");
            })
          }
        >
          List folders / labels
        </Button>
      </div>
      {folders.length ? (
        <Field label="Folder or label">
          <select value={folderId} disabled={busy} onChange={(event) => setFolderId(event.target.value)}>
            {folders.map((folder) => (
              <option key={folder.id} value={folder.id}>
                {folder.name}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      <div className={ui.actions} style={{ justifyContent: "flex-start" }}>
        <Button
          disabled={busy || !folderId}
          onClick={() =>
            void run(async () => {
              await api("/api/crm/lead-mailboxes", {
                method: "POST",
                body: { organisationId, ...mailBody(), mailFolderId: folderId, mailFolderName: folders.find((folder) => folder.id === folderId)?.name ?? "", syncEveryHours: hours },
              });
              onAdded();
            })
          }
        >
          Read this folder
        </Button>
        <Button variant="secondary" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function Mailboxes({ organisationId, onChecked }: { organisationId: string; onChecked: () => void }) {
  const confirm = useConfirm();
  const data = useApiData<{ mailboxes: LeadMailbox[] }>("/api/crm/lead-mailboxes", { organisationId });
  const [adding, setAdding] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const { busy, error, run } = useBusy();
  const mailboxes = data.data?.mailboxes ?? [];
  return (
    <Card
      title="From email"
      description="A mailbox folder or Gmail label whose emails become leads by themselves."
      actions={!adding ? <Button size="small" variant="secondary" onClick={() => setAdding(true)}>Add a mailbox</Button> : null}
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      {message ? <Notice tone="success">{message}</Notice> : null}
      {adding ? (
        <AddMailbox
          organisationId={organisationId}
          onAdded={() => {
            setAdding(false);
            data.reload();
          }}
          onCancel={() => setAdding(false)}
        />
      ) : null}
      {mailboxes.length === 0 && !adding ? <Empty>No mailbox brings in leads.</Empty> : null}
      {mailboxes.map((mailbox) => (
        <div key={mailbox.id} style={{ borderTop: "1px solid var(--line, #e5e5e5)", padding: "8px 0", display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
          <span>
            <strong>{mailbox.mailFolderName}</strong>{" "}
            <span className={ui.muted}>
              {mailbox.mailKind === "imap" ? `${mailbox.imapUsername} (IMAP)` : mailbox.mailAccountEmail ?? "disconnected"} · every{" "}
              {mailbox.syncEveryHours === 1 ? "hour" : `${mailbox.syncEveryHours} hours`}
              {mailbox.lastCheckAt ? ` · checked ${formatDateTime(mailbox.lastCheckAt)}` : ""}
            </span>
            {mailbox.lastStatus === "failed" ? <Notice tone="error">{mailbox.lastError}</Notice> : null}
          </span>
          <span className={ui.rowButtons}>
            <Button
              size="small"
              variant="secondary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const result = await api<{ check: LeadMailCheck }>(`/api/crm/lead-mailboxes/${mailbox.id}/check`, { method: "POST", body: { organisationId } });
                  setMessage(
                    result.check.status === "failed"
                      ? null
                      : `${result.check.leadsAdded} new lead${result.check.leadsAdded === 1 ? "" : "s"}${result.check.notesAdded ? `, ${result.check.notesAdded} added to leads already open` : ""}.`,
                  );
                  data.reload();
                  onChecked();
                })
              }
            >
              Check now
            </Button>
            <Button
              size="small"
              variant="secondary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  if (!(await confirm(`Stop making leads from ${mailbox.mailFolderName}? Leads already made stay.`))) return;
                  await api(`/api/crm/lead-mailboxes/${mailbox.id}`, { method: "DELETE", query: { organisationId } });
                  data.reload();
                })
              }
            >
              Remove
            </Button>
          </span>
        </div>
      ))}
    </Card>
  );
}

/** CRM › Leads › where leads come from (decision 493): web forms and mailboxes. Admins and owners. */
export function LeadSources({ organisationId, onChecked }: { organisationId: string; onChecked: () => void }) {
  const { canCrm } = useWorkspace();
  if (!canCrm("admin")) return null;
  return (
    <>
      <WebForms organisationId={organisationId} />
      <Mailboxes organisationId={organisationId} onChecked={onChecked} />
    </>
  );
}
