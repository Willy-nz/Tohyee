"use client";

import { useSearchParams } from "next/navigation";
import { type FormEvent, type RefObject, useEffect, useRef, useState } from "react";
import { useConfirm } from "@/components/confirm-dialog";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Empty, Field, Notice, ui } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import type { MailFolder } from "@/lib/farming/mail-providers";
import { type CopyState, copyExclusions, copyProgress, formatBytes, type MailHit, type MailThread, type MyMail, type MyMailbox } from "@/lib/private-mail/types";
import styles from "./my-mail.module.css";

/*
 * My mail (#250; PM1-PM14): an Owner's private copy of their own mailbox,
 * from the folders they tick (the same choice as the farm calendar's), to
 * search, read and download attachments from. Only its owner ever gets
 * any of it from the server; this screen just shows what they get.
 */

function nzDate(value: string | null): string {
  if (!value) return "";
  return new Date(value).toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric", timeZone: "Pacific/Auckland" });
}

function nzDateTime(value: string | null): string {
  if (!value) return "";
  return new Date(value).toLocaleString("en-NZ", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "Pacific/Auckland" });
}

function person(value: { email: string; name: string | null } | null): string {
  if (!value) return "(no sender)";
  return value.name ? `${value.name} <${value.email}>` : value.email;
}

export function MyMailHome({ organisationId, isOwner }: { organisationId: string; isOwner: boolean }) {
  const search = useSearchParams();
  const mail = useApiData<MyMail>(isOwner ? "/api/my-mail" : null, { organisationId });
  const [picking, setPicking] = useState<string | null>(search.get("folders"));
  const connected = search.get("connected");
  const returnedError = search.get("error");
  if (!isOwner) {
    return (
      <Card title="My mail is for Owners">
        <Empty>Only an Owner of this organisation can keep a private copy of their own mail here. Nobody else can see anyone&apos;s.</Empty>
      </Card>
    );
  }
  const copies = [
    ...(mail.data?.mailboxes ?? []).flatMap((mailbox) => (mailbox.copy ? [{ id: mailbox.copy.id, email: mailbox.email, provider: mailbox.provider }] : [])),
    ...(mail.data?.detached ?? []).map((copy) => ({ id: copy.id, email: copy.email, provider: copy.provider })),
  ];
  return (
    <>
      {connected ? <Notice tone="success">Connected {connected}. Tick the folders to copy: nothing is copied until you do.</Notice> : null}
      {returnedError ? <Notice tone="error">{returnedError}</Notice> : null}
      <Mailboxes organisationId={organisationId} data={mail.data} error={mail.error} onChanged={mail.reload} picking={picking} onPick={setPicking} />
      {copies.length ? <Reader organisationId={organisationId} copies={copies} /> : null}
    </>
  );
}

function ProgressLine({ copy }: { copy: CopyState }) {
  const progress = copyProgress(copy);
  return (
    <div className={styles.progress}>
      <span>{progress.text}</span>
      {progress.percent !== null && !progress.done ? (
        <div className={styles.bar} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percent} aria-label="First copy">
          <div className={styles.barFill} style={{ width: `${progress.percent}%` }} />
        </div>
      ) : null}
    </div>
  );
}

function CopyFacts({ copy, historyFrom }: { copy: CopyState; historyFrom: string | null }) {
  return (
    <dl className={styles.facts}>
      <div>
        <dt>Copied</dt>
        <dd>{copy.oldest ? `${nzDate(copy.oldest)} to ${nzDate(copy.newest)}` : "Nothing yet"}</dd>
      </div>
      {historyFrom ? (
        <div>
          <dt>Reads back to</dt>
          <dd>{nzDate(historyFrom)}</dd>
        </div>
      ) : null}
      <div>
        <dt>Last copied</dt>
        <dd>{copy.lastSuccessAt ? nzDateTime(copy.lastSuccessAt) : "Not yet"}</dd>
      </div>
      <div>
        <dt>Attachments</dt>
        <dd>
          {copy.attachments.toLocaleString("en-NZ")}
          {copy.attachmentsNotKept ? `, ${copy.attachmentsNotKept} not kept (too big or linked)` : ""}
        </dd>
      </div>
      {copy.deletedAtSource ? (
        <div>
          <dt>Deleted in the mailbox, kept here</dt>
          <dd>{copy.deletedAtSource.toLocaleString("en-NZ")}</dd>
        </div>
      ) : null}
    </dl>
  );
}

function Mailboxes({
  organisationId,
  data,
  error,
  onChanged,
  picking,
  onPick,
}: {
  organisationId: string;
  data: MyMail | null;
  error: string | null;
  onChanged: () => void;
  picking: string | null;
  onPick: (id: string | null) => void;
}) {
  const confirm = useConfirm();
  const [provider, setProvider] = useState<"google" | "microsoft">("google");
  const [historyDays, setHistoryDays] = useState("365");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const act = async (work: () => Promise<unknown>, success?: string) => {
    setBusy(true);
    setMessage(null);
    try {
      await work();
      if (success) setMessage({ tone: "success", text: success });
      onChanged();
    } catch (caught) {
      setMessage({ tone: "error", text: errorMessage(caught) });
    } finally {
      setBusy(false);
    }
  };
  const connect = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const { url } = await api<{ url: string }>("/api/my-mail", { method: "POST", body: { organisationId, provider, historyDays: Number(historyDays) } });
      window.location.assign(url);
    } catch (caught) {
      setMessage({ tone: "error", text: errorMessage(caught) });
      setBusy(false);
    }
  };
  const sync = (copyId: string) =>
    act(async () => {
      const result = await api<{ copied: number; removed: number; deletedInMailbox: number }>(`/api/my-mail/copies/${copyId}/sync`, { method: "POST", body: { organisationId } });
      setMessage({ tone: "success", text: `Synced: ${result.copied} copied${result.removed ? `, ${result.removed} moved out and removed` : ""}${result.deletedInMailbox ? `, ${result.deletedInMailbox} deleted in the mailbox (kept here)` : ""}.` });
    });
  const deleteCopy = async (copyId: string, email: string) => {
    if (!(await confirm(`Delete the imported history of ${email}? Every copied email, attachment and search entry is deleted from Tohyee now. Your mailbox isn't touched. Backups made before now still hold it, encrypted, until they're removed (up to about 12 months).`, { confirmLabel: "Delete imported history", danger: true }))) return;
    void act(() => api(`/api/my-mail/copies/${copyId}?organisationId=${encodeURIComponent(organisationId)}`, { method: "DELETE" }), "The imported history was deleted.");
  };
  return (
    <Card
      title="Your mailboxes"
      description="Keep a private copy of your own Gmail or Microsoft mail for you and your AI, from the folders or labels you tick: only those, and nothing until you tick one. Tohyee only reads: nothing is sent, marked, moved or deleted."
    >
      <p className={styles.privacy}>
        Only you can see these mailboxes, their folders and anything copied: nobody else in the organisation, admins and other Owners included. It&apos;s encrypted in the database with this
        server&apos;s key, so someone who runs the server and has its key could still read it.
      </p>
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {!data && !error ? <p className={ui.muted} role="status">Loading…</p> : null}
      {data && !data.mailboxes.length && !data.detached.length ? <p className={ui.muted}>No mailbox connected yet.</p> : null}
      {data?.mailboxes.map((mailbox) => (
        <section key={mailbox.id} className={styles.mailbox} aria-labelledby={`mailbox-${mailbox.id}`}>
          <div className={styles.mailboxHead}>
            <h3 id={`mailbox-${mailbox.id}`} className={styles.address}>{mailbox.email}</h3>
            <span className={styles.meta}>
              {mailbox.provider === "google" ? "Gmail" : "Microsoft"}
              {mailbox.farmCalendar ? " · also read for your farm calendar" : ""}
            </span>
          </div>
          <div>
            {mailbox.folders.length ? (
              <span className={styles.meta}>
                Reads{" "}
                {mailbox.folders
                  .map((folder) => `${folder.name}${folder.includeSubfolders ? " and its subfolders" : ""}${folder.missing ? " (not found in the mailbox)" : ""}`)
                  .join("; ")}
              </span>
            ) : (
              <Badge tone="amber">Not reading: tick folders</Badge>
            )}{" "}
            <Button size="small" variant="secondary" disabled={busy} aria-expanded={picking === mailbox.id} onClick={() => onPick(picking === mailbox.id ? null : mailbox.id)}>
              {mailbox.folders.length ? "Change folders" : "Choose folders"}
            </Button>
            {mailbox.status === "paused" ? <> <Badge tone="red">Sign-in stopped working</Badge> <small>Connect it again to carry on.</small></> : null}
          </div>
          {picking === mailbox.id ? (
            <FolderPicker
              organisationId={organisationId}
              mailbox={mailbox}
              onClose={() => onPick(null)}
              onSaved={(text) => {
                onPick(null);
                setMessage({ tone: "success", text });
                onChanged();
              }}
            />
          ) : null}
          <div className={styles.switchRow}>
            <label className={ui.checkbox}>
              <input
                type="checkbox"
                checked={mailbox.copy?.copying === true}
                disabled={busy}
                onChange={(event) => {
                  const on = event.target.checked;
                  void act(() => api(`/api/my-mail/mailboxes/${mailbox.id}`, { method: "PATCH", body: { organisationId, copying: on } }), on ? "Copying is on." : "Copying is off. What was copied is kept until you delete it.");
                }}
              />
              <span>Keep a private copy of these emails for me and my AI</span>
            </label>
            {mailbox.copy?.paused ? (
              <span>
                <Badge tone="red">Stopped after failed syncs</Badge> <small>Switch it off and on, or connect the mailbox again, to carry on.</small>
              </span>
            ) : null}
          </div>
          {mailbox.copy ? (
            <>
              <ProgressLine copy={mailbox.copy} />
              {mailbox.copy.listingCapped ? <Notice tone="warning">A ticked folder has more than 10,000 emails since the read-back date: only its newest 10,000 are copied.</Notice> : null}
              {mailbox.copy.lastError ? <Notice tone="error">The last sync didn&apos;t finish: {mailbox.copy.lastError} It carries on from where it stopped.</Notice> : null}
              <CopyFacts copy={mailbox.copy} historyFrom={mailbox.historyFrom} />
            </>
          ) : null}
          <details className={styles.excluded}>
            <summary>What isn&apos;t copied</summary>
            <ul>
              {copyExclusions(mailbox.provider).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </details>
          <div className={ui.rowButtons}>
            {mailbox.copy ? (
              <Button size="small" variant="secondary" disabled={busy || !mailbox.copy.copying || mailbox.copy.paused || !mailbox.folders.length} onClick={() => void sync(mailbox.copy!.id)}>
                Sync now
              </Button>
            ) : null}
            <Button
              size="small"
              variant="secondary"
              disabled={busy}
              onClick={async () => {
                const calendar = mailbox.farmCalendar ? " Your farm calendar stops reading it too, and what it read is deleted." : "";
                const kept = mailbox.copy ? " Your imported history is kept, not copying, until you delete it." : "";
                if (!(await confirm(`Disconnect ${mailbox.email}? Tohyee stops reading it.${calendar}${kept} The mailbox itself isn't touched.`, { confirmLabel: "Disconnect", danger: true }))) return;
                void act(() => api(`/api/my-mail/mailboxes/${mailbox.id}?organisationId=${encodeURIComponent(organisationId)}`, { method: "DELETE" }), "Disconnected.");
              }}
            >
              Disconnect
            </Button>
            {mailbox.copy ? (
              <Button size="small" variant="secondary" disabled={busy} onClick={() => void deleteCopy(mailbox.copy!.id, mailbox.email)}>
                Delete imported history
              </Button>
            ) : null}
          </div>
        </section>
      ))}
      {data?.detached.map((copy) => (
        <section key={copy.id} className={styles.mailbox} aria-labelledby={`copy-${copy.id}`}>
          <div className={styles.mailboxHead}>
            <h3 id={`copy-${copy.id}`} className={styles.address}>{copy.email}</h3>
            <Badge tone="neutral">Disconnected: not copying</Badge>
          </div>
          <CopyFacts copy={copy} historyFrom={null} />
          <p className={ui.muted}>Connect this mailbox again to carry on copying into the same history, or delete it.</p>
          <div className={ui.rowButtons}>
            <Button size="small" variant="secondary" disabled={busy} onClick={() => void deleteCopy(copy.id, copy.email)}>
              Delete imported history
            </Button>
          </div>
        </section>
      ))}
      <form className={ui.inlineForm} onSubmit={connect}>
        <Field label="Connect">
          <select value={provider} onChange={(event) => setProvider(event.target.value as "google" | "microsoft")}>
            <option value="google">Gmail</option>
            <option value="microsoft">Microsoft 365 or Outlook</option>
          </select>
        </Field>
        <Field label="Read back (days)" hint="30 to 365">
          <input inputMode="numeric" value={historyDays} onChange={(event) => setHistoryDays(event.target.value)} />
        </Field>
        <Button type="submit" disabled={busy}>
          Connect
        </Button>
      </form>
      <p className={ui.muted}>
        Your copy is an archive: an email you delete in Gmail or Outlook stays here, marked &quot;deleted in the mailbox&quot;. Untick a folder, or move an email out of the ticked
        folders, and it&apos;s taken out of your copy. Disconnecting stops copying and keeps the history; deleting it is a separate step.
      </p>
      <p className={ui.muted}>
        It&apos;s the same connection as the farm calendar&apos;s (one per mailbox, with one choice of folders), using the Google or Microsoft app an admin set up under Settings › Email.
      </p>
    </Card>
  );
}

/** PM2: ticks the folders or labels to copy, from the mailbox now; Gmail's Sent, Drafts, Spam and Trash are for the copy only. */
function FolderPicker({ organisationId, mailbox, onClose, onSaved }: { organisationId: string; mailbox: MyMailbox; onClose: () => void; onSaved: (message: string) => void }) {
  const confirm = useConfirm();
  const list = useApiData<{ folders: MailFolder[] }>(`/api/my-mail/mailboxes/${mailbox.id}/folders`, { organisationId });
  const [chosen, setChosen] = useState<Map<string, boolean>>(() => new Map(mailbox.folders.map((folder) => [folder.externalId, folder.includeSubfolders])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const kind = mailbox.provider === "google" ? "labels" : "folders";
  const folders = list.data?.folders ?? [];
  const usual = folders.filter((folder) => !folder.privateOnly);
  const privateOnly = folders.filter((folder) => folder.privateOnly);
  const hasChildren = (id: string) => folders.some((folder) => folder.parentId === id);
  const toggle = (id: string, on: boolean) => {
    const next = new Map(chosen);
    if (on) next.set(id, next.get(id) ?? false);
    else next.delete(id);
    setChosen(next);
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    const removed = mailbox.folders.filter((folder) => !chosen.has(folder.externalId));
    if (removed.length) {
      const names = removed.map((folder) => folder.name).join(", ");
      const calendar = mailbox.farmCalendar ? " and from your farm calendar" : "";
      if (!(await confirm(`Stop reading ${names}? What was copied only from ${removed.length === 1 ? "it" : "them"} is deleted from your copy${calendar}. Your mailbox isn't touched.`, { confirmLabel: "Stop reading", danger: true }))) return;
    }
    setBusy(true);
    setError(null);
    try {
      await api(`/api/my-mail/mailboxes/${mailbox.id}/folders`, { method: "PUT", body: { organisationId, folders: [...chosen].map(([id, includeSubfolders]) => ({ id, includeSubfolders })) } });
      onSaved(chosen.size ? `Saved. Only the ${kind} you ticked are read; the next sync copies them.` : "Saved. Nothing is read from this mailbox now.");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };
  const row = (folder: MailFolder) => (
    <div key={folder.id} className={styles.folderRow} style={{ paddingLeft: `${folder.depth * 1.25}rem` }}>
      <label className={ui.checkbox}>
        <input type="checkbox" checked={chosen.has(folder.id)} disabled={busy} onChange={(event) => toggle(folder.id, event.target.checked)} />
        <span>{folder.name}</span>
      </label>
      {chosen.has(folder.id) && hasChildren(folder.id) ? (
        <label className={`${ui.checkbox} ${styles.subfolders}`}>
          <input type="checkbox" checked={chosen.get(folder.id) === true} disabled={busy} onChange={(event) => setChosen(new Map(chosen).set(folder.id, event.target.checked))} aria-label={`Include the ${kind} inside ${folder.path}`} />
          <span>and its sub{kind}</span>
        </label>
      ) : null}
    </div>
  );
  return (
    <form className={styles.folderPicker} onSubmit={save} aria-labelledby={`pick-${mailbox.id}`}>
      <h4 id={`pick-${mailbox.id}`} className={styles.folderHeading}>Which {kind} to read in {mailbox.email}</h4>
      <p className={ui.muted}>
        Tohyee reads only the {kind} you tick{mailbox.farmCalendar ? ", for your copy and your farm calendar alike" : ""}. Moving an email out of them takes it out of your copy at the next sync; moving one
        in copies it, if it&apos;s no older than {nzDate(mailbox.historyFrom)}. Only you see these names.
      </p>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {list.error ? (
        <Notice tone="error">
          Couldn&apos;t get the {kind}: {list.error}{" "}
          <Button size="small" variant="secondary" onClick={list.reload}>
            Retry
          </Button>
        </Notice>
      ) : !list.data ? (
        <p className={ui.muted} role="status">Getting the {kind} from your mailbox…</p>
      ) : (
        <fieldset className={styles.folderList}>
          <legend className={styles.visuallyHidden}>{kind === "labels" ? "Labels" : "Folders"}</legend>
          {usual.map(row)}
          {privateOnly.length ? (
            <>
              <p className={styles.folderGroup}>For your private copy only (never read for the farm calendar)</p>
              {privateOnly.map(row)}
            </>
          ) : null}
          {mailbox.folders
            .filter((folder) => !folders.some((entry) => entry.id === folder.externalId))
            .map((folder) => (
              <div key={folder.externalId} className={styles.folderRow}>
                <label className={ui.checkbox}>
                  <input type="checkbox" checked={chosen.has(folder.externalId)} disabled={busy} onChange={(event) => toggle(folder.externalId, event.target.checked)} />
                  <span>{folder.name} (not found in the mailbox: untick it)</span>
                </label>
              </div>
            ))}
        </fieldset>
      )}
      <div className={ui.rowButtons}>
        <Button type="submit" disabled={busy || !list.data || [...chosen.keys()].some((id) => !folders.some((folder) => folder.id === id))}>
          {busy ? "Saving…" : "Save"}
        </Button>
        <Button type="button" variant="secondary" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** PM9-PM11: search the copies, read a conversation, download its attachments. */
function Reader({ organisationId, copies }: { organisationId: string; copies: Array<{ id: string; email: string; provider: "google" | "microsoft" }> }) {
  const [query, setQuery] = useState("");
  const [copyId, setCopyId] = useState("");
  const [asked, setAsked] = useState<{ query: string; copyId: string }>({ query: "", copyId: "" });
  const [hits, setHits] = useState<MailHit[] | null>(null);
  const [more, setMore] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const threadHeading = useRef<HTMLHeadingElement>(null);

  const load = async (next: { query: string; copyId: string }, before: string | null) => {
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ hits: MailHit[]; more: string | null }>("/api/my-mail/search", { method: "POST", body: { organisationId, query: next.query, copyId: next.copyId || null, before } });
      setHits((previous) => (before && previous ? [...previous, ...result.hits] : result.hits));
      setMore(result.more);
      setAsked(next);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };
  // The newest emails to start with.
  useEffect(() => {
    let cancelled = false;
    api<{ hits: MailHit[]; more: string | null }>("/api/my-mail/search", { method: "POST", body: { organisationId } }).then(
      (result) => {
        if (cancelled) return;
        setHits(result.hits);
        setMore(result.more);
      },
      (caught) => {
        if (!cancelled) setError(errorMessage(caught));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [organisationId]);

  return (
    <Card title="Search and read" description="Whole words; every word must be in the email. Use from:address or to:address for a sender or recipient.">
      <form
        className={styles.searchForm}
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          setOpenId(null);
          void load({ query, copyId }, null);
        }}
      >
        <label className={styles.visuallyHidden} htmlFor="my-mail-search">
          Search your mail
        </label>
        <input id="my-mail-search" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search your mail" autoComplete="off" />
        {copies.length > 1 ? (
          <select aria-label="Mailbox" value={copyId} onChange={(event) => setCopyId(event.target.value)}>
            <option value="">All mailboxes</option>
            {copies.map((copy) => (
              <option key={copy.id} value={copy.id}>
                {copy.email}
              </option>
            ))}
          </select>
        ) : null}
        <Button type="submit" disabled={busy}>
          Search
        </Button>
      </form>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={styles.reader}>
        <div>
          {hits === null ? (
            <p className={ui.muted} role="status">Loading…</p>
          ) : hits.length === 0 ? (
            <p className={ui.muted} role="status">{asked.query ? "No emails match." : "Nothing copied yet."}</p>
          ) : (
            <>
              <p className={styles.visuallyHidden} role="status">{`${hits.length} emails shown`}</p>
              <ul className={styles.hits}>
                {hits.map((hit) => (
                  <li key={hit.id} className={`${styles.hit} ${openId === hit.id ? styles.hitSelected : ""}`}>
                    <button
                      type="button"
                      className={styles.hitButton}
                      aria-current={openId === hit.id ? "true" : undefined}
                      onClick={() => {
                        setOpenId(hit.id);
                        setTimeout(() => threadHeading.current?.focus(), 0);
                      }}
                    >
                      <span className={styles.hitTop}>
                        <span className={styles.hitFrom}>{hit.from?.name ?? hit.from?.email ?? "(no sender)"}</span>
                        <span className={styles.hitDate}>{nzDate(hit.sentAt)}</span>
                      </span>
                      <span className={styles.hitSubject}>
                        {hit.subject || "(no subject)"}
                        {hit.attachmentCount ? ` · ${hit.attachmentCount} attachment${hit.attachmentCount === 1 ? "" : "s"}` : ""}
                      </span>
                      <span className={styles.hitSnippet}>{hit.snippet}</span>
                      {hit.deletedInMailbox ? <span className={styles.meta}>Deleted in {copies.find((copy) => copy.id === hit.copyId)?.provider === "microsoft" ? "Outlook" : "Gmail"}; kept here</span> : null}
                    </button>
                  </li>
                ))}
              </ul>
              {more ? (
                <Button variant="secondary" disabled={busy} onClick={() => void load(asked, more)}>
                  More
                </Button>
              ) : null}
            </>
          )}
        </div>
        <div>{openId ? <Thread key={openId} organisationId={organisationId} messageId={openId} headingRef={threadHeading} onClose={() => setOpenId(null)} /> : <p className={ui.muted}>Choose an email to read it.</p>}</div>
      </div>
    </Card>
  );
}

function Thread({ organisationId, messageId, headingRef, onClose }: { organisationId: string; messageId: string; headingRef: RefObject<HTMLHeadingElement | null>; onClose: () => void }) {
  const thread = useApiData<MailThread>(`/api/my-mail/messages/${messageId}`, { organisationId });
  if (thread.error) return <Notice tone="error">{thread.error}</Notice>;
  if (!thread.data) return <p className={ui.muted} role="status">Opening…</p>;
  const first = thread.data.messages[0];
  return (
    <article className={styles.thread} aria-labelledby={`thread-${messageId}`}>
      <div className={styles.threadHead}>
        <h3 id={`thread-${messageId}`} className={styles.threadTitle} tabIndex={-1} ref={headingRef}>
          {first?.subject || "(no subject)"}
        </h3>
        <Button size="small" variant="secondary" onClick={onClose}>
          Close
        </Button>
      </div>
      {thread.data.messages.map((message) => (
        <section key={message.id} className={styles.message} aria-label={`From ${person(message.from)}, ${nzDateTime(message.sentAt)}`}>
          <div className={styles.messageHead}>
            <strong>{person(message.from)}</strong>
            <span className={styles.meta}>{nzDateTime(message.sentAt)}</span>
            {message.to.length ? <span className={styles.meta}>To {message.to.map(person).join(", ")}</span> : null}
            {message.cc.length ? <span className={styles.meta}>Cc {message.cc.map(person).join(", ")}</span> : null}
            {message.bcc.length ? <span className={styles.meta}>Bcc {message.bcc.map(person).join(", ")}</span> : null}
          </div>
          {message.deletedInMailbox ? (
            <span>
              <Badge tone="neutral">Deleted in the mailbox; kept in your copy</Badge>
            </span>
          ) : null}
          <pre className={styles.body}>{message.text || "(no text)"}</pre>
          {message.attachments.length ? (
            <ul className={styles.files} aria-label="Attachments">
              {message.attachments.map((file) => (
                <li key={file.id} className={styles.file}>
                  {file.kept ? (
                    <a href={`/api/my-mail/attachments/${file.id}?organisationId=${encodeURIComponent(organisationId)}`} download={file.name}>
                      {file.name}
                    </a>
                  ) : (
                    <span>{file.name}</span>
                  )}
                  <span className={styles.meta}>
                    {formatBytes(file.size)}
                    {file.notKept === "too_big" ? " · too big to keep: open it in your mailbox" : file.notKept === "linked" ? " · a linked item: open it in Outlook" : ""}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          {message.webLink ? (
            <a href={message.webLink} target="_blank" rel="noreferrer noopener" className={styles.meta}>
              Open in your mailbox
            </a>
          ) : null}
        </section>
      ))}
    </article>
  );
}
