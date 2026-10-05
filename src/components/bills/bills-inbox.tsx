"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useConfirm } from "@/components/confirm-dialog";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Empty, Field, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import type { MailFolder } from "@/lib/analytics/report-email-providers";
import type { InboxItem } from "@/lib/bills/inbox";
import type { InboxMailbox, InboxMailCheck } from "@/lib/bills/inbox-mailbox";
import { api, ApiError, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import { formatDateTime, personName } from "@/lib/format";
import { formatFileSize, MAX_ATTACHMENT_BYTES } from "@/lib/records/file-types";

/**
 * The bills inbox (BI1-BI7): supplier bills and receipts waiting to be
 * entered, uploaded here or read from a mailbox label. Making a bill opens a
 * new draft with the file beside it; the organisation's connected AI can
 * read the files and make drafts through its own tools.
 */

type Tab = { status: "waiting" | "made" | "removed"; label: string; empty: string };
const TABS: Tab[] = [
  { status: "waiting", label: "Waiting", empty: "Nothing is waiting. Upload bills here, or have a mailbox label read into the inbox." },
  { status: "made", label: "Made into bills", empty: "No bills have been made from the inbox yet." },
  { status: "removed", label: "Removed", empty: "Nothing has been removed." },
];

const INBOX_ACCEPT = ".pdf,.jpg,.jpeg,.png,.heic,.heif";

function fileHref(organisationId: string, item: InboxItem): string {
  return `/api/bills/inbox/${item.id}/file?organisationId=${encodeURIComponent(organisationId)}`;
}

function arrived(item: InboxItem) {
  if (item.source === "mailbox") {
    return (
      <>
        <div>{item.emailFrom ?? "Unknown sender"}</div>
        <div className={ui.muted}>{item.emailSubject ?? "(no subject)"}</div>
      </>
    );
  }
  return (
    <span className={ui.muted}>
      {item.source === "ai" ? "Added" : "Uploaded"} by {personName(item, "createdBy") ?? item.createdByEmail}
      {item.createdVia ? ` via ${item.createdVia}` : ""}
    </span>
  );
}

function outcome(item: InboxItem) {
  if (item.status === "made" && item.billId) {
    return (
      <>
        <Link href={`/operations/bills/${item.billId}`}>
          {item.billStatus === "draft" ? "Draft bill" : "Bill"} {item.billNumber ?? `#${item.billId}`}
        </Link>
        <div className={ui.muted}>
          {personName(item, "madeBy") ?? item.madeByEmail}
          {item.madeVia ? ` via ${item.madeVia}` : ""}, {formatDateTime(item.madeAt)}
        </div>
      </>
    );
  }
  if (item.status === "removed") {
    return (
      <>
        <div>{item.removedReason}</div>
        <div className={ui.muted}>
          Removed by {personName(item, "removedBy") ?? item.removedByEmail}, {formatDateTime(item.removedAt)}
        </div>
      </>
    );
  }
  return null;
}

function RemoveForm({ organisationId, item, onDone }: { organisationId: string; item: InboxItem; onDone: (message: string) => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!open) {
    return (
      <Button size="small" variant="secondary" onClick={() => setOpen(true)}>
        Remove
      </Button>
    );
  }
  return (
    <form
      className={ui.inlineForm}
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await api(`/api/bills/inbox/${item.id}/remove`, { method: "POST", body: { organisationId, reason } });
          onDone(`Removed ${item.fileName}.`);
        } catch (caught) {
          setError(errorMessage(caught));
          setBusy(false);
        }
      }}
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Field label="Why it isn't a bill">
        <input value={reason} maxLength={500} autoFocus onChange={(event) => setReason(event.target.value)} placeholder="e.g. Email signature" />
      </Field>
      <Button type="submit" size="small" variant="danger" disabled={busy || !reason.trim()}>
        Remove
      </Button>
      <Button size="small" variant="secondary" onClick={() => setOpen(false)} disabled={busy}>
        Cancel
      </Button>
    </form>
  );
}

function Upload({ organisationId, onDone }: { organisationId: string; onDone: (tone: "success" | "error", text: string) => void }) {
  const [busy, setBusy] = useState(false);
  async function send(files: FileList | null) {
    if (!files || files.length === 0) return;
    setBusy(true);
    const added: string[] = [];
    const problems: string[] = [];
    for (const file of Array.from(files)) {
      if (file.size > MAX_ATTACHMENT_BYTES) {
        problems.push(`${file.name} is ${formatFileSize(file.size)}. Files can be at most 10 MB.`);
        continue;
      }
      const form = new FormData();
      form.set("organisationId", organisationId);
      form.set("idempotencyKey", newIdempotencyKey("inbox"));
      form.set("source", "ui");
      form.set("file", file, file.name);
      try {
        const response = await fetch("/api/bills/inbox", { method: "POST", body: form, credentials: "same-origin" });
        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new ApiError(payload?.error ?? `Upload failed (${response.status}).`, response.status);
        }
        added.push(file.name);
      } catch (caught) {
        problems.push(errorMessage(caught));
      }
    }
    setBusy(false);
    onDone(problems.length ? "error" : "success", `${added.length ? `Added ${added.join(", ")}. ` : ""}${problems.join(" ")}`.trim());
  }
  return (
    <label className={ui.actions} style={{ justifyContent: "flex-start" }}>
      <span className={ui.muted}>{busy ? "Uploading…" : "PDF, JPG, PNG or HEIC, up to 10 MB each."}</span>
      <input
        type="file"
        multiple
        accept={INBOX_ACCEPT}
        aria-label="Upload bills"
        disabled={busy}
        onChange={(event) => {
          void send(event.target.files);
          event.target.value = "";
        }}
      />
    </label>
  );
}

export function BillsInbox({ organisationId }: { organisationId: string }) {
  const { can } = useWorkspace();
  const router = useRouter();
  const [tab, setTab] = useState(TABS[0]);
  const list = useApiData<{ items: InboxItem[] }>("/api/bills/inbox", { organisationId, status: tab.status });
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const done = (tone: "success" | "error", text: string) => {
    setMessage({ tone, text });
    list.reload();
  };
  return (
    <>
      <Card
        title="Bills inbox"
        description="Supplier bills and receipts that have arrived but aren't bills yet. Nothing here is posted. Make a bill from each one, or remove it with a reason."
        actions={
          <Link className={ui.muted} href="/operations/bills">
            All bills
          </Link>
        }
      >
        {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
        {can("bookkeeper") ? <Upload organisationId={organisationId} onDone={done} /> : null}
        <div className={ui.tabs} role="tablist" aria-label="Bills inbox">
          {TABS.map((entry) => (
            <button
              key={entry.status}
              type="button"
              role="tab"
              aria-selected={tab === entry}
              className={`${ui.tab} ${tab === entry ? ui.tabActive : ""}`}
              onClick={() => setTab(entry)}
            >
              {entry.label}
            </button>
          ))}
        </div>
        {list.error ? <Notice tone="error">{list.error}</Notice> : null}
        {!list.data && !list.error ? <p className={ui.muted}>Loading…</p> : null}
        {list.data && list.data.items.length === 0 ? <Empty>{tab.empty}</Empty> : null}
        {list.data && list.data.items.length > 0 ? (
          <div className={ui.tableWrap}>
            <table className={`${ui.table} ${ui.stackOnPhone}`}>
              <thead>
                <tr>
                  <th>File</th>
                  <th>From</th>
                  <th>Arrived</th>
                  <th>{tab.status === "waiting" ? "" : tab.status === "made" ? "Bill" : "Why"}</th>
                </tr>
              </thead>
              <tbody>
                {list.data.items.map((item) => (
                  <tr key={item.id}>
                    <td data-label="File">
                      {item.status === "removed" ? (
                        item.fileName
                      ) : (
                        <a href={fileHref(organisationId, item)} target="_blank" rel="noreferrer">
                          {item.fileName}
                        </a>
                      )}
                      <div className={ui.muted}>{formatFileSize(item.byteSize)}</div>
                      {item.sameFile.map((entry) => (
                        <div key={entry.text}>
                          <Badge tone="amber">Possible duplicate</Badge>{" "}
                          {entry.billId ? <Link href={`/operations/bills/${entry.billId}`}>{entry.text}</Link> : entry.text}
                        </div>
                      ))}
                    </td>
                    <td data-label="From">{arrived(item)}</td>
                    <td data-label="Arrived">{formatDateTime(item.emailDate ?? item.createdAt)}</td>
                    <td data-label={tab.status === "waiting" ? "" : tab.status === "made" ? "Bill" : "Why"}>
                      {item.status === "waiting" && can("bookkeeper") ? (
                        <div className={ui.actions} style={{ justifyContent: "flex-start" }}>
                          <Button size="small" onClick={() => router.push(`/operations/bills/new?inboxItem=${item.id}`)}>
                            Make bill
                          </Button>
                          <RemoveForm organisationId={organisationId} item={item} onDone={(text) => done("success", text)} />
                        </div>
                      ) : (
                        outcome(item)
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </Card>
      <InboxMailboxes organisationId={organisationId} onChecked={() => list.reload()} />
    </>
  );
}

type MailAccount = { id: string; userId: string; email: string; provider: "google" | "microsoft"; status: string };
const HOURS = [1, 2, 3, 4, 6, 8, 12, 24];

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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mailBody = () =>
    choice === "imap" ? { mailKind: "imap", imapHost: host.trim(), imapUsername: username.trim(), imapPassword: password } : { mailKind: "crm", mailAccountId: choice };
  const reset = () => {
    setFolders([]);
    setFolderId("");
  };
  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div style={{ display: "grid", gap: 12 }}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <p className={ui.muted}>
        Set a rule in the mailbox to file supplier bills into one folder or label. Tohyee takes their PDF and picture attachments, ignores other
        files, reads each email once, and never moves, marks or deletes emails. It reads as you: your own mailbox connected in the CRM, or IMAP with
        an app password.
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
              const result = await api<{ folders: MailFolder[] }>("/api/bills/inbox/mail-folders", { method: "POST", body: { organisationId, ...mailBody() } });
              setFolders(result.folders);
              setFolderId(result.folders[0]?.id ?? "");
              if (!result.folders.length) setError("No folders or labels were found in this mailbox.");
            })
          }
        >
          List folders / labels
        </Button>
      </div>
      {folders.length ? (
        <div className={ui.grid3}>
          <Field label="Folder or label">
            <select value={folderId} disabled={busy} onChange={(event) => setFolderId(event.target.value)}>
              {folders.map((folder) => (
                <option key={folder.id} value={folder.id}>
                  {folder.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
      ) : null}
      <div className={ui.actions} style={{ justifyContent: "flex-start" }}>
        <Button
          disabled={busy || !folderId}
          onClick={() =>
            void run(async () => {
              await api("/api/bills/inbox/mailboxes", {
                method: "POST",
                body: { organisationId, ...mailBody(), mailFolderId: folderId, mailFolderName: folders.find((folder) => folder.id === folderId)?.name ?? "", syncEveryHours: hours },
              });
              onAdded();
            })
          }
        >
          {busy ? "Saving…" : "Read this folder"}
        </Button>
        <Button variant="secondary" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function InboxMailboxes({ organisationId, onChecked }: { organisationId: string; onChecked: () => void }) {
  const confirm = useConfirm();
  const { can } = useWorkspace();
  const data = useApiData<{ mailboxes: InboxMailbox[] }>("/api/bills/inbox/mailboxes", { organisationId });
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const mailboxes = data.data?.mailboxes ?? [];
  async function check(mailbox: InboxMailbox) {
    setBusy(mailbox.id);
    setMessage(null);
    try {
      const result = await api<{ check: InboxMailCheck }>(`/api/bills/inbox/mailboxes/${mailbox.id}/check`, { method: "POST", body: { organisationId } });
      setMessage(
        result.check.status === "failed"
          ? { tone: "error", text: result.check.error ?? "The check failed." }
          : {
              tone: "success",
              text: `${result.check.filesAdded} ${result.check.filesAdded === 1 ? "file" : "files"} added${result.check.filesSkipped ? `, ${result.check.filesSkipped} skipped (not a real PDF or picture, or over 10 MB)` : ""}.`,
            },
      );
      data.reload();
      onChecked();
    } catch (caught) {
      setMessage({ tone: "error", text: errorMessage(caught) });
    } finally {
      setBusy(null);
    }
  }
  async function remove(mailbox: InboxMailbox) {
    if (!(await confirm(`Stop reading ${mailbox.mailFolderName}? Files already in the inbox stay.`))) return;
    try {
      await api(`/api/bills/inbox/mailboxes/${mailbox.id}`, { method: "DELETE", query: { organisationId } });
      data.reload();
    } catch (caught) {
      setMessage({ tone: "error", text: errorMessage(caught) });
    }
  }
  if (!can("admin") && mailboxes.length === 0) return null;
  return (
    <Card
      title="Bills from email"
      description="A mailbox folder or Gmail label whose bills come into the inbox by themselves."
      actions={can("admin") && !adding ? <Button size="small" variant="secondary" onClick={() => setAdding(true)}>Add a mailbox</Button> : null}
    >
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      {data.error ? <Notice tone="error">{data.error}</Notice> : null}
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
      {mailboxes.length === 0 && !adding ? <Empty>No mailbox is read into the inbox.</Empty> : null}
      {mailboxes.length ? (
        <div className={ui.tableWrap}>
          <table className={`${ui.table} ${ui.stackOnPhone}`}>
            <thead>
              <tr>
                <th>Mailbox</th>
                <th>Last check</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {mailboxes.map((mailbox) => (
                <tr key={mailbox.id}>
                  <td data-label="Mailbox">
                    {mailbox.mailKind === "crm" ? (mailbox.mailAccountEmail ?? "Disconnected mailbox") : `${mailbox.imapUsername} (IMAP)`} · {mailbox.mailFolderName}
                    <div className={ui.muted}>Every {mailbox.syncEveryHours === 1 ? "hour" : `${mailbox.syncEveryHours} hours`}</div>
                  </td>
                  <td data-label="Last check">
                    {mailbox.lastCheckAt ? formatDateTime(mailbox.lastCheckAt) : <span className={ui.muted}>Not checked yet</span>}
                    {mailbox.lastStatus === "failed" ? (
                      <div>
                        <Badge tone="red">Failed</Badge> <span className={ui.muted}>{mailbox.lastError}</span>
                      </div>
                    ) : mailbox.lastCheckAt ? (
                      <div className={ui.muted}>
                        {mailbox.lastFilesAdded ?? 0} added{mailbox.lastFilesSkipped ? `, ${mailbox.lastFilesSkipped} skipped` : ""}
                      </div>
                    ) : null}
                  </td>
                  <td>
                    <div className={ui.actions} style={{ justifyContent: "flex-start" }}>
                      {can("bookkeeper") ? (
                        <Button size="small" variant="secondary" disabled={busy !== null} onClick={() => void check(mailbox)}>
                          {busy === mailbox.id ? "Checking…" : "Check now"}
                        </Button>
                      ) : null}
                      {can("admin") ? (
                        <Button size="small" variant="danger" disabled={busy !== null} onClick={() => void remove(mailbox)}>
                          Remove
                        </Button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Card>
  );
}

/** The item a new bill is being made from, shown beside the editor (BI3). */
export function InboxItemPreview({ organisationId, itemId }: { organisationId: string; itemId: string }) {
  const loaded = useApiData<{ item: InboxItem }>(`/api/bills/inbox/${encodeURIComponent(itemId)}`, { organisationId });
  if (loaded.error) return <Notice tone="error">{loaded.error}</Notice>;
  const item = loaded.data?.item;
  if (!item) return <p className={ui.muted}>Loading…</p>;
  if (item.status !== "waiting") {
    return <Notice tone="warning">This inbox item is {item.status === "made" ? `already bill ${item.billNumber ?? `#${item.billId}`}` : "removed"}.</Notice>;
  }
  const href = fileHref(organisationId, item);
  return (
    <Card title={item.fileName} description="From the bills inbox. It's attached to the bill when you save it.">
      {item.sameFile.map((entry) => (
        <Notice key={entry.text} tone="warning">
          {entry.text}
        </Notice>
      ))}
      {item.source === "mailbox" ? (
        <p className={ui.muted}>
          {item.emailFrom} · {item.emailSubject}
        </p>
      ) : null}
      {item.contentType === "application/pdf" ? (
        <iframe title={item.fileName} src={href} style={{ width: "100%", height: 480, border: "1px solid var(--border)", borderRadius: 8 }} />
      ) : item.contentType === "image/heic" ? (
        <p>
          <a href={`${href}&download=1`}>Download {item.fileName}</a> <span className={ui.muted}>(HEIC pictures don&apos;t show in most browsers)</span>
        </p>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={href} alt={item.fileName} style={{ maxWidth: "100%", maxHeight: 480, borderRadius: 8 }} />
      )}
      <p>
        <a href={href} target="_blank" rel="noreferrer">
          Open in a new tab
        </a>
      </p>
    </Card>
  );
}
