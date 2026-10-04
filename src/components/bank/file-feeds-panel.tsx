"use client";

import { Fragment, useState } from "react";
import { useConfirm } from "@/components/confirm-dialog";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Empty, Field, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import type { MailFolder } from "@/lib/analytics/report-email-providers";
import type { BankAccount } from "@/lib/bank/accounts";
import type { BankFileFeed, FeedCheck, FeedFileResult } from "@/lib/bank/file-feeds";
import { api, errorMessage } from "@/lib/client/api";
import { formatDateTime } from "@/lib/format";

type FeedsData = { feeds: BankFileFeed[]; folder: { chosen: boolean; readable: boolean; subfolders: string[] } };
type MailAccount = { id: string; userId: string; email: string; provider: "google" | "microsoft"; status: string };

const HOURS = [1, 2, 3, 4, 6, 8, 12, 24];

function place(feed: BankFileFeed): string {
  if (feed.kind === "folder") return `Folder · ${feed.subfolder}`;
  const mailbox = feed.mailKind === "crm" ? (feed.mailAccountEmail ?? "Disconnected mailbox") : `${feed.imapUsername} (IMAP)`;
  return `${mailbox} · ${feed.mailFolderName}`;
}

function lastCheck(feed: BankFileFeed) {
  if (!feed.lastCheckAt) return <span className={ui.muted}>Not checked yet</span>;
  return (
    <>
      {formatDateTime(feed.lastCheckAt)}
      <div>
        {feed.lastStatus === "failed" ? (
          <Badge tone="red">Failed</Badge>
        ) : (
          <span className={ui.muted}>
            {feed.lastFilesRead ?? 0} {feed.lastFilesRead === 1 ? "file" : "files"} read, {feed.lastLinesAdded ?? 0}{" "}
            {feed.lastLinesAdded === 1 ? "line" : "lines"} added
          </span>
        )}
      </div>
    </>
  );
}

const RESULT_LABELS: Record<FeedFileResult["result"], string> = { imported: "Imported", no_new: "Nothing new", failed: "Waiting for you" };

function FeedFiles({ organisationId, account, feed }: { organisationId: string; account: BankAccount; feed: BankFileFeed }) {
  const files = useApiData<{ files: FeedFileResult[] }>(`/api/bank-accounts/${account.id}/file-feeds/${feed.id}/files`, { organisationId });
  if (files.error) return <Notice tone="error">{files.error}</Notice>;
  if (!files.data) return <p className={ui.muted}>Loading…</p>;
  if (!files.data.files.length) return <p className={ui.muted}>This feed hasn&apos;t read any files yet.</p>;
  return (
    <div className={ui.tableWrap}>
      <table className={ui.table} style={{ minWidth: 520 }}>
        <thead>
          <tr>
            <th>File</th>
            <th>Read</th>
            <th>Result</th>
          </tr>
        </thead>
        <tbody>
          {files.data.files.map((file, index) => (
            <tr key={`${file.name}:${file.seenAt}:${index}`}>
              <td>{file.name}</td>
              <td>{formatDateTime(file.seenAt)}</td>
              <td>
                <Badge tone={file.result === "failed" ? "red" : file.result === "imported" ? "green" : "neutral"}>{RESULT_LABELS[file.result]}</Badge>
                {file.result === "imported" ? (
                  <span className={ui.muted}>
                    {" "}
                    {file.linesAdded} {file.linesAdded === 1 ? "line" : "lines"}
                  </span>
                ) : null}
                {file.reason ? <div className={ui.muted}>{file.reason}</div> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AddFeedForm({
  organisationId,
  account,
  data,
  onAdded,
  onCancel,
}: {
  organisationId: string;
  account: BankAccount;
  data: FeedsData;
  onAdded: () => void;
  onCancel: () => void;
}) {
  const { user } = useWorkspace();
  const [kind, setKind] = useState<"folder" | "mailbox">("folder");
  const [subfolder, setSubfolder] = useState("");
  const [hours, setHours] = useState(6);
  const mail = useApiData<{ accounts: MailAccount[] }>(kind === "mailbox" ? "/api/crm/mail/accounts" : null, { organisationId });
  const own = (mail.data?.accounts ?? []).filter((entry) => entry.userId === user.id && entry.status === "active");
  const [choice, setChoice] = useState("");
  const [host, setHost] = useState("imap.gmail.com");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [folders, setFolders] = useState<MailFolder[]>([]);
  const [folderId, setFolderId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function resetFolders() {
    setFolders([]);
    setFolderId("");
  }

  function mailBody() {
    return choice === "imap"
      ? { mailKind: "imap", imapHost: host.trim(), imapUsername: username.trim(), imapPassword: password }
      : { mailKind: "crm", mailAccountId: choice };
  }

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

  const findFolders = () =>
    run(async () => {
      const result = await api<{ folders: MailFolder[] }>("/api/bank-file-feeds/mail-folders", {
        method: "POST",
        body: { organisationId, ...mailBody() },
      });
      setFolders(result.folders);
      setFolderId(result.folders[0]?.id ?? "");
      if (!result.folders.length) setError("No folders or labels were found in this mailbox.");
    });

  const save = () =>
    run(async () => {
      const body =
        kind === "folder"
          ? { organisationId, kind, subfolder, syncEveryHours: hours }
          : {
              organisationId,
              kind,
              ...mailBody(),
              mailFolderId: folderId,
              mailFolderName: folders.find((folder) => folder.id === folderId)?.name ?? "",
              syncEveryHours: hours,
            };
      await api(`/api/bank-accounts/${account.id}/file-feeds`, { method: "POST", body });
      setSubfolder("");
      setPassword("");
      setChoice("");
      resetFolders();
      onAdded();
    });

  const folderReady = data.folder.chosen && data.folder.readable;
  return (
    <div style={{ display: "grid", gap: 12 }}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.grid3}>
        <Field label="Read files from">
          <select
            value={kind}
            disabled={busy}
            onChange={(event) => {
              setKind(event.target.value as "folder" | "mailbox");
              setError(null);
            }}
          >
            <option value="folder">A folder on the server</option>
            <option value="mailbox">A mailbox folder or Gmail label</option>
          </select>
        </Field>
        <Field label="Check every" hint="Check now reads new files any time.">
          <select value={hours} disabled={busy} onChange={(event) => setHours(Number(event.target.value))}>
            {HOURS.map((entry) => (
              <option key={entry} value={entry}>
                {entry === 1 ? "hour" : `${entry} hours`}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {kind === "folder" ? (
        !data.folder.chosen ? (
          <Notice tone="warning">
            A server admin needs to choose this organisation&apos;s bank files folder first (server settings, Bank files folders).
          </Notice>
        ) : !data.folder.readable ? (
          <Notice tone="warning">Tohyee can&apos;t open this organisation&apos;s bank files folder. Ask a server admin to check it.</Notice>
        ) : data.folder.subfolders.length === 0 ? (
          <Notice tone="info">
            The bank files folder has no folders inside it yet. Make one for this account (e.g. &ldquo;{account.name}&rdquo;) and have your
            bank&apos;s export or scanner save files there.
          </Notice>
        ) : (
          <div className={ui.grid3}>
            <Field label="Folder" hint="A folder inside the organisation's bank files folder.">
              <select value={subfolder} disabled={busy} onChange={(event) => setSubfolder(event.target.value)}>
                <option value="">Choose a folder</option>
                {data.folder.subfolders.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        )
      ) : (
        <>
          <p className={ui.muted}>
            Set a rule in the mailbox to file your bank&apos;s statement emails into one folder or label. Tohyee reads their CSV, Excel, OFX, QIF and
            other statement attachments, and never moves, marks or deletes emails. It reads as you: your own mailbox connected in the CRM, or IMAP
            with an app password.
          </p>
          <div className={ui.grid3}>
            <Field label="Mailbox">
              <select
                value={choice}
                disabled={busy}
                onChange={(event) => {
                  setChoice(event.target.value);
                  setPassword("");
                  resetFolders();
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
                  <input
                    value={host}
                    disabled={busy}
                    onChange={(event) => {
                      setHost(event.target.value);
                      resetFolders();
                    }}
                  />
                </Field>
                <Field label="Username">
                  <input
                    value={username}
                    autoComplete="username"
                    disabled={busy}
                    onChange={(event) => {
                      setUsername(event.target.value);
                      resetFolders();
                    }}
                  />
                </Field>
                <Field label="App password" hint="Stored encrypted on the server and never shown again.">
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={password}
                    disabled={busy}
                    onChange={(event) => {
                      setPassword(event.target.value);
                      resetFolders();
                    }}
                  />
                </Field>
              </>
            ) : null}
          </div>
          <div className={ui.actions} style={{ justifyContent: "flex-start" }}>
            <Button
              variant="secondary"
              disabled={busy || !choice || (choice === "imap" && (!host.trim() || !username.trim() || !password))}
              onClick={() => void findFolders()}
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
        </>
      )}
      <div className={ui.actions} style={{ justifyContent: "flex-start" }}>
        <Button disabled={busy || (kind === "folder" ? !folderReady || !subfolder : !folderId)} onClick={() => void save()}>
          {busy ? "Saving…" : "Add feed"}
        </Button>
        <Button variant="secondary" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/**
 * Automatic statement files (BF1-BF10): folders and mailboxes this account's
 * statement files are read from by themselves, with when each was last
 * checked, Check now, and (admins) add and remove.
 */
export function FileFeedsPanel({ organisationId, account, onChanged }: { organisationId: string; account: BankAccount; onChanged: () => void }) {
  const confirm = useConfirm();
  const { can } = useWorkspace();
  const data = useApiData<FeedsData>(`/api/bank-accounts/${account.id}/file-feeds`, { organisationId });
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  async function check(feed: BankFileFeed) {
    setBusyId(feed.id);
    setMessage(null);
    try {
      const { check: result } = await api<{ check: FeedCheck }>(`/api/bank-accounts/${account.id}/file-feeds/${feed.id}/check`, {
        method: "POST",
        body: { organisationId },
      });
      setMessage(
        result.status === "failed"
          ? { tone: "error", text: `The check failed: ${result.error}` }
          : {
              tone: "success",
              text: result.filesRead
                ? `Read ${result.filesRead} ${result.filesRead === 1 ? "file" : "files"}: ${result.linesAdded} ${result.linesAdded === 1 ? "line" : "lines"} added. Open Files to see each one.`
                : "No new files.",
            },
      );
      data.reload();
      onChanged();
    } catch (caught) {
      setMessage({ tone: "error", text: errorMessage(caught) });
    } finally {
      setBusyId(null);
    }
  }

  async function changeHours(feed: BankFileFeed, hours: number) {
    setBusyId(feed.id);
    setMessage(null);
    try {
      await api(`/api/bank-accounts/${account.id}/file-feeds/${feed.id}`, { method: "PATCH", body: { organisationId, syncEveryHours: hours } });
      data.reload();
    } catch (caught) {
      setMessage({ tone: "error", text: errorMessage(caught) });
    } finally {
      setBusyId(null);
    }
  }

  async function remove(feed: BankFileFeed) {
    if (!(await confirm("Remove this feed? Statements it already imported stay, and Tohyee remembers the files it read."))) return;
    setBusyId(feed.id);
    setMessage(null);
    try {
      await api(`/api/bank-accounts/${account.id}/file-feeds/${feed.id}`, { method: "DELETE", query: { organisationId } });
      data.reload();
    } catch (caught) {
      setMessage({ tone: "error", text: errorMessage(caught) });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section style={{ display: "grid", gap: 12, marginTop: 24 }} aria-labelledby="file-feeds-title">
      <h3 id="file-feeds-title" style={{ margin: 0 }}>
        Automatic statement files
      </h3>
      <p className={ui.muted}>
        For banks without a feed: Tohyee reads new statement files from a folder or a mailbox by itself and imports them, as if you had imported them
        by hand. Duplicates are skipped or flagged in the same way. CSV and Excel files use the columns of the last file of that kind you imported by
        hand; a file whose columns differ waits for you.
      </p>
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      {data.error ? <Notice tone="error">{data.error}</Notice> : null}
      {!data.data ? (
        data.error ? null : (
          <p className={ui.muted}>Loading…</p>
        )
      ) : data.data.feeds.length === 0 ? (
        <Empty>No automatic statement files.{can("admin") ? "" : " An organisation admin can add a folder or mailbox."}</Empty>
      ) : (
        <div className={ui.tableWrap}>
          <table className={ui.table} style={{ minWidth: 640 }}>
            <thead>
              <tr>
                <th>Reads from</th>
                <th>Check every</th>
                <th>Last checked</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.data.feeds.map((feed) => (
                <Fragment key={feed.id}>
                  <tr>
                    <td>
                      {place(feed)}
                      {feed.lastStatus === "failed" && feed.lastError ? (
                        <div style={{ color: "var(--danger, #b42318)" }}>{feed.lastError}</div>
                      ) : null}
                    </td>
                    <td>
                      {can("admin") ? (
                        <select
                          aria-label="Check every"
                          value={feed.syncEveryHours}
                          disabled={busyId !== null}
                          onChange={(event) => void changeHours(feed, Number(event.target.value))}
                        >
                          {HOURS.includes(feed.syncEveryHours) ? null : <option value={feed.syncEveryHours}>{feed.syncEveryHours} hours</option>}
                          {HOURS.map((entry) => (
                            <option key={entry} value={entry}>
                              {entry === 1 ? "hour" : `${entry} hours`}
                            </option>
                          ))}
                        </select>
                      ) : feed.syncEveryHours === 1 ? (
                        "hour"
                      ) : (
                        `${feed.syncEveryHours} hours`
                      )}
                    </td>
                    <td>{lastCheck(feed)}</td>
                    <td>
                      <div className={ui.actions}>
                        <Button variant="secondary" size="small" onClick={() => setOpenId(openId === feed.id ? null : feed.id)}>
                          {openId === feed.id ? "Hide files" : "Files"}
                        </Button>
                        {can("bookkeeper") ? (
                          <Button size="small" disabled={busyId !== null} onClick={() => void check(feed)}>
                            {busyId === feed.id ? "Checking…" : "Check now"}
                          </Button>
                        ) : null}
                        {can("admin") ? (
                          <Button variant="secondary" size="small" disabled={busyId !== null} onClick={() => void remove(feed)}>
                            Remove
                          </Button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                  {openId === feed.id ? (
                    <tr>
                      <td colSpan={4}>
                        <FeedFiles organisationId={organisationId} account={account} feed={feed} />
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {can("admin") && data.data ? (
        adding ? (
          <AddFeedForm
            organisationId={organisationId}
            account={account}
            data={data.data}
            onAdded={() => {
              setAdding(false);
              data.reload();
            }}
            onCancel={() => setAdding(false)}
          />
        ) : (
          <div className={ui.actions} style={{ justifyContent: "flex-start" }}>
            <Button variant="secondary" onClick={() => setAdding(true)}>
              Add a folder or mailbox
            </Button>
          </div>
        )
      ) : null}
    </section>
  );
}
