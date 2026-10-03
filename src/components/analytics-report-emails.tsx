"use client";

import { useState } from "react";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Empty, Field, Notice, ui } from "@/components/ui";
import type { ReportMailbox, ReportEmailCheck } from "@/lib/analytics/report-emails";
import type { MailFolder } from "@/lib/analytics/report-email-providers";
import { api, errorMessage } from "@/lib/client/api";
import { formatDateTime } from "@/lib/format";

type Overview = {
  accounts: Array<{ id: string; email: string; provider: "google" | "microsoft" }>;
  mailboxes: ReportMailbox[];
  checks: ReportEmailCheck[];
};

export function imapFolderRequest(host: string, username: string, password: string, mailboxId: string | null) {
  return { host, port: 993, username, password, ...(mailboxId === null ? {} : { mailboxId }) };
}

export function ReportEmailsCard({ organisationId, folderChosen, onChanged }: {
  organisationId: string;
  folderChosen: boolean;
  onChanged: () => void;
}) {
  const base = `/api/organisations/${encodeURIComponent(organisationId)}/analytics/report-emails`;
  const overview = useApiData<Overview>(base);
  const [choice, setChoice] = useState("");
  const [host, setHost] = useState("imap.gmail.com");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [folders, setFolders] = useState<MailFolder[]>([]);
  const [folderId, setFolderId] = useState("");
  const [replace, setReplace] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  function resetFolders() {
    setFolders([]);
    setFolderId("");
  }

  async function action(work: () => Promise<void>) {
    setBusy(true);
    setMessage(null);
    try {
      await work();
    } catch (caught) {
      setMessage({ tone: "error", text: errorMessage(caught) });
    } finally {
      setBusy(false);
    }
  }

  async function findFolders() {
    await action(async () => {
      const result = choice === "imap"
        ? await api<{ folders: MailFolder[] }>(`${base}/folders`, { method: "POST", body: imapFolderRequest(host, username, password, editingId) })
        : await api<{ folders: MailFolder[] }>(`${base}/folders`, { query: { accountId: choice } });
      setFolders(result.folders);
      setFolderId(result.folders[0]?.id ?? "");
      if (!result.folders.length) setMessage({ tone: "error", text: "No folders or labels were found in this mailbox." });
    });
  }

  async function save() {
    await action(async () => {
      const folder = folders.find((item) => item.id === folderId);
      if (!folder) return;
      await api(base, {
        method: "POST",
        body: { id: editingId ?? undefined, kind: choice === "imap" ? "imap" : "crm", accountId: choice === "imap" ? undefined : choice,
          ...(choice === "imap" ? { host, port: 993, username, password } : {}),
          folderId, folderName: folder.name, replace },
      });
      setPassword("");
      setEditingId(null);
      setChoice("");
      resetFolders();
      overview.reload();
      setMessage({ tone: "success", text: "Report mailbox saved. Checks run every 15 minutes while the server is running." });
    });
  }

  return (
    <Card title="Report emails" description="Read one mailbox folder or Gmail label and save its data attachments into this organisation's analytics source folder.">
      <p>Set a rule in your mailbox to file report emails into the folder or label you choose below. Tohyee never moves, marks as read, labels or deletes emails.</p>
      <p className={ui.muted}>Google and Microsoft permissions cover the whole mailbox, even though Tohyee only reads the chosen folder or label here. Use your own mailbox already connected in the CRM, or IMAP with an app password for personal Gmail.</p>
      <p className={ui.muted}>Microsoft 365 has turned off IMAP passwords: connect Microsoft mailboxes through the CRM&apos;s Microsoft connection. Looker Studio sends only PDFs, which cannot be loaded as data. CSV, TSV and TXT attachments, and flat CSV or TSV files inside ZIPs, are accepted. Limits: 25 MB per attachment and 100 MB per check.</p>
      {!folderChosen ? <Notice tone="warning">A server admin must choose this organisation&apos;s analytics source folder before files can be saved.</Notice> : null}
      {overview.error ? <Notice tone="error">{overview.error}</Notice> : null}
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      <div className={ui.grid3}>
        <Field label="Mailbox">
          <select value={choice} disabled={busy || editingId !== null} onChange={(event) => { setChoice(event.target.value); setPassword(""); resetFolders(); }}>
            <option value="">Choose a mailbox</option>
            {(overview.data?.accounts ?? []).map((account) => <option key={account.id} value={account.id}>{account.email} — {account.provider === "google" ? "Gmail" : "Microsoft"}</option>)}
            <option value="imap">IMAP with an app password</option>
          </select>
        </Field>
        {choice === "imap" ? (
          <>
            <Field label="IMAP host"><input value={host} disabled={busy || editingId !== null} onChange={(event) => { setHost(event.target.value); resetFolders(); }} /></Field>
            <Field label="Port" hint="TLS only."><input value="993" readOnly /></Field>
            <Field label="Username"><input value={username} autoComplete="username" disabled={busy || editingId !== null} onChange={(event) => { setUsername(event.target.value); resetFolders(); }} /></Field>
          </>
        ) : null}
        <Field label="App password" hint={choice === "imap" ? `Stored encrypted on the server and never returned.${editingId ? " Leave blank to keep the saved password." : ""} For Gmail, turn on 2-Step Verification and create an app password.` : "Only needed for IMAP."}>
          <input type="password" autoComplete="new-password" value={password} disabled={busy || choice !== "imap"} onChange={(event) => { setPassword(event.target.value); resetFolders(); }} />
        </Field>
      </div>
      <div className={ui.actions}>
        <Button variant="secondary" disabled={busy || !choice || (choice === "imap" && (!host.trim() || !username.trim() || (!password && !editingId)))} onClick={findFolders}>List folders / labels</Button>
        {editingId ? <Button variant="secondary" disabled={busy} onClick={() => { setEditingId(null); setChoice(""); setPassword(""); resetFolders(); }}>Cancel edit</Button> : null}
      </div>
      {folders.length ? (
        <div className={ui.grid3}>
          <Field label="Folder or label"><select value={folderId} disabled={busy} onChange={(event) => setFolderId(event.target.value)}>{folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select></Field>
          <Field label="When the attachment name repeats">
            <select value={replace ? "replace" : "keep"} disabled={busy} onChange={(event) => setReplace(event.target.value === "replace")}>
              <option value="keep">Keep every file (received date and attachment name)</option>
              <option value="replace">Replace with the newest file of the same name</option>
            </select>
          </Field>
          <div className={ui.actions}><Button disabled={busy || !folderId || !folderChosen} onClick={save}>Save report mailbox</Button></div>
        </div>
      ) : null}
      {overview.data?.mailboxes.length ? (
        <div className={ui.tableWrap}>
          <table className={ui.table}>
            <thead><tr><th>Mailbox</th><th>Folder / label</th><th>Files</th><th /></tr></thead>
            <tbody>{overview.data.mailboxes.map((mailbox) => (
              <tr key={mailbox.id}>
                <td>{mailbox.email ?? mailbox.username}<div className={ui.muted}>{mailbox.kind === "imap" ? `${mailbox.host}:993 (TLS)` : "CRM connection"}</div></td>
                <td>{mailbox.folderName}</td>
                <td>{mailbox.replace ? "Newest file" : "Every file"}</td>
                <td><div className={ui.actions}>
                  <Button size="small" variant="secondary" disabled={busy} onClick={() => {
                    setEditingId(mailbox.id);
                    setChoice(mailbox.kind === "imap" ? "imap" : mailbox.accountId ?? "");
                    setHost(mailbox.host ?? "imap.gmail.com");
                    setUsername(mailbox.username ?? "");
                    setPassword("");
                    setFolders([{ id: mailbox.folderId, name: mailbox.folderName }]);
                    setFolderId(mailbox.folderId);
                    setReplace(mailbox.replace);
                    setMessage(null);
                  }}>Edit</Button>
                  <Button size="small" variant="secondary" disabled={busy || !folderChosen} onClick={() => action(async () => {
                    const result = await api<ReportEmailCheck | { check: ReportEmailCheck }>(`${base}/${mailbox.id}/check`, { method: "POST", body: {} });
                    const check = "check" in result ? result.check : result;
                    setMessage({ tone: check.error ? "error" : "success", text: check.error ?? `${check.filesSaved} files saved.` });
                    overview.reload();
                    onChanged();
                  })}>Check now</Button>
                  <Button size="small" variant="danger" disabled={busy} onClick={() => action(async () => {
                    await api(`${base}/${mailbox.id}`, { method: "DELETE" });
                    overview.reload();
                  })}>Remove</Button>
                </div></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      ) : <Empty>No report mailboxes set up yet.</Empty>}
      <h3>Last checks</h3>
      {overview.data?.checks.length ? (
        <div className={ui.tableWrap}>
          <table className={ui.table}>
            <thead><tr><th>Started</th><th>Folder / label</th><th>Files saved</th><th>Result</th></tr></thead>
            <tbody>{overview.data.checks.map((check) => (
              <tr key={check.id}>
                <td>{formatDateTime(check.startedAt)}</td>
                <td>{overview.data?.mailboxes.find((mailbox) => mailbox.id === check.mailboxId)?.folderName ?? "Removed mailbox"}</td>
                <td>{check.filesSaved}</td>
                <td><Badge tone={check.status === "failed" ? "red" : check.status === "running" ? "blue" : "green"}>{check.status === "running" ? "Checking…" : check.status === "failed" ? "Failed" : "Checked"}</Badge>{check.error ? <div className={ui.muted}>{check.error}</div> : null}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      ) : <Empty>No checks yet. Results are recorded by the job.</Empty>}
    </Card>
  );
}
