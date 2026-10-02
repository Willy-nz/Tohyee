"use client";

import { type ChangeEvent, type FormEvent, useId, useRef, useState } from "react";
import { useApiData } from "@/components/hooks";
import { Button, Card, Empty, Field, Notice, ui } from "@/components/ui";
import { api, ApiError, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import { formatDateTime, personName } from "@/lib/format";
import { ALLOWED_EXTENSIONS, fileTypeLabel, formatFileSize, MAX_ATTACHMENT_BYTES } from "@/lib/records/file-types";
import { RECORD_TYPE_SLUGS, type RecordExtras, type RecordNote, type RecordType } from "@/lib/records/types";
import { useConfirm } from "@/components/confirm-dialog";

type Tab = "notes" | "files" | "history";

function NoteItem({
  note,
  base,
  organisationId,
  onChanged,
}: {
  note: RecordNote;
  base: string;
  organisationId: string;
  onChanged: () => void;
}) {
  const confirm = useConfirm();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(note.body);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    try {
      await api(`${base}/notes/${note.id}`, { method: "PATCH", body: { organisationId, body: text, version: note.version } });
      setEditing(false);
      setError(null);
      onChanged();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!(await confirm("Delete this note? The history keeps what it said."))) return;
    setBusy(true);
    try {
      await api(`${base}/notes/${note.id}`, { method: "DELETE", body: { organisationId, version: note.version } });
      onChanged();
    } catch (caught) {
      setError(errorMessage(caught));
      setBusy(false);
    }
  }

  return (
    <li style={{ padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
      {editing ? (
        <form onSubmit={(event) => void save(event)}>
          <Field label="Note">
            <textarea value={text} onChange={(event) => setText(event.target.value)} rows={3} maxLength={5000} required />
          </Field>
          <div className={ui.actions}>
            <Button type="submit" size="small" disabled={busy}>
              Save note
            </Button>
            <Button
              variant="secondary"
              size="small"
              onClick={() => {
                setEditing(false);
                setText(note.body);
                setError(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <p style={{ whiteSpace: "pre-wrap", margin: 0 }}>{note.body}</p>
      )}
      <div className={ui.muted} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 4 }}>
        <span>
          {personName(note, "createdBy")} · {formatDateTime(note.createdAt)}
          {note.updatedAt ? ` · edited by ${personName(note, "updatedBy")} ${formatDateTime(note.updatedAt)}` : ""}
        </span>
        {note.canChange && !editing ? (
          <>
            <Button variant="secondary" size="small" onClick={() => setEditing(true)} disabled={busy}>
              Edit
            </Button>
            <Button variant="secondary" size="small" onClick={() => void remove()} disabled={busy}>
              Delete
            </Button>
          </>
        ) : null}
      </div>
      {error ? <Notice tone="error">{error}</Notice> : null}
    </li>
  );
}

/**
 * Notes, files and history for one record (examples NF1-NF14). Put under a
 * journal, invoice, bill, credit note, supplier credit note or contact.
 */
export function RecordExtrasPanel({
  organisationId,
  recordType,
  recordId,
  title = "Notes, files and history",
}: {
  organisationId: string;
  recordType: RecordType;
  recordId: string;
  title?: string;
}) {
  const confirm = useConfirm();
  const base = `/api/records/${RECORD_TYPE_SLUGS[recordType]}/${encodeURIComponent(recordId)}`;
  const extras = useApiData<RecordExtras>(base, { organisationId });
  const [tab, setTab] = useState<Tab>("notes");
  const [noteText, setNoteText] = useState("");
  const [noteKey, setNoteKey] = useState(() => newIdempotencyKey("note"));
  const [status, setStatus] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const fileId = useId();
  const data = extras.data;

  async function addNote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    try {
      await api(`${base}/notes`, { method: "POST", body: { organisationId, idempotencyKey: noteKey, source: "ui", body: noteText } });
      setNoteText("");
      setNoteKey(newIdempotencyKey("note"));
      setStatus(null);
      extras.reload();
    } catch (caught) {
      setStatus({ tone: "error", text: errorMessage(caught) });
    } finally {
      setBusy(false);
    }
  }

  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (files.length === 0) return;
    setBusy(true);
    const added: string[] = [];
    const problems: string[] = [];
    for (const file of files) {
      if (file.size > MAX_ATTACHMENT_BYTES) {
        problems.push(`${file.name} is ${formatFileSize(file.size)}. Files can be at most 10 MB.`);
        continue;
      }
      const form = new FormData();
      form.set("organisationId", organisationId);
      form.set("idempotencyKey", newIdempotencyKey("file"));
      form.set("source", "ui");
      form.set("file", file, file.name);
      try {
        const response = await fetch(`${base}/attachments`, { method: "POST", body: form, credentials: "same-origin" });
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
    setStatus(
      problems.length > 0
        ? { tone: "error", text: `${added.length > 0 ? `Attached ${added.join(", ")}. ` : ""}${problems.join(" ")}` }
        : { tone: "success", text: `Attached ${added.join(", ")}.` },
    );
    extras.reload();
  }

  async function removeFile(id: string, name: string) {
    if (!(await confirm(`Remove ${name}? The file is deleted; the history keeps its name and who removed it.`))) return;
    setBusy(true);
    try {
      await api(`${base}/attachments/${id}`, { method: "DELETE", body: { organisationId } });
      setStatus({ tone: "success", text: `Removed ${name}.` });
      extras.reload();
    } catch (caught) {
      setStatus({ tone: "error", text: errorMessage(caught) });
    } finally {
      setBusy(false);
    }
  }

  const tabs: { key: Tab; label: string }[] = [
    { key: "notes", label: `Notes${data ? ` (${data.notes.length})` : ""}` },
    { key: "files", label: `Files${data ? ` (${data.attachments.length})` : ""}` },
    { key: "history", label: "History" },
  ];

  return (
    <Card title={title}>
      <div className={ui.tabs} role="tablist">
        {tabs.map((entry) => (
          <button
            key={entry.key}
            type="button"
            role="tab"
            aria-selected={tab === entry.key}
            className={`${ui.tab} ${tab === entry.key ? ui.tabActive : ""}`}
            onClick={() => setTab(entry.key)}
          >
            {entry.label}
          </button>
        ))}
      </div>
      {extras.error ? <Notice tone="error">{extras.error}</Notice> : null}
      {status ? <Notice tone={status.tone}>{status.text}</Notice> : null}
      {!data ? <p className={ui.muted}>Loading…</p> : null}

      {data && tab === "notes" ? (
        <>
          {data.notes.length === 0 ? (
            <Empty>No notes yet.</Empty>
          ) : (
            <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {data.notes.map((note) => (
                <NoteItem key={`${note.id}-${note.version}`} note={note} base={base} organisationId={organisationId} onChanged={extras.reload} />
              ))}
            </ul>
          )}
          {data.canAdd ? (
            <form onSubmit={(event) => void addNote(event)} style={{ marginTop: 12 }}>
              <Field label="Add a note">
                <textarea value={noteText} onChange={(event) => setNoteText(event.target.value)} rows={3} maxLength={5000} required />
              </Field>
              <Button type="submit" disabled={busy || noteText.trim().length === 0}>
                Add note
              </Button>
            </form>
          ) : null}
        </>
      ) : null}

      {data && tab === "files" ? (
        <>
          {data.attachments.length === 0 ? (
            <Empty>No files yet.</Empty>
          ) : (
            <div className={ui.tableWrap}>
              <table className={ui.table}>
                <thead>
                  <tr>
                    <th>File</th>
                    <th>Type</th>
                    <th className={ui.num}>Size</th>
                    <th>Added</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {data.attachments.map((file) => {
                    const href = `${base}/attachments/${file.id}?organisationId=${encodeURIComponent(organisationId)}`;
                    return (
                      <tr key={file.id}>
                        <td>
                          <a href={href} target="_blank" rel="noopener">
                            {file.fileName}
                          </a>
                        </td>
                        <td>{fileTypeLabel(file.contentType)}</td>
                        <td className={ui.num}>{formatFileSize(file.byteSize)}</td>
                        <td className={ui.muted}>
                          {personName(file, "createdBy")} · {formatDateTime(file.createdAt)}
                        </td>
                        <td className={ui.num}>
                          <span className={ui.actions} style={{ justifyContent: "flex-end" }}>
                            <a className={ui.muted} href={`${href}&download=1`} download={file.fileName}>
                              Download
                            </a>
                            {file.canRemove ? (
                              <Button variant="secondary" size="small" disabled={busy} onClick={() => void removeFile(file.id, file.fileName)}>
                                Remove
                              </Button>
                            ) : null}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {data.canAdd ? (
            <div style={{ marginTop: 12 }}>
              <input
                id={fileId}
                ref={fileInput}
                type="file"
                multiple
                accept={ALLOWED_EXTENSIONS.join(",")}
                onChange={(event) => void upload(event)}
                style={{ display: "none" }}
              />
              <Button variant="secondary" disabled={busy} onClick={() => fileInput.current?.click()}>
                {busy ? "Working…" : "Attach files"}
              </Button>{" "}
              <label htmlFor={fileId} className={ui.muted}>
                PDF, JPG, PNG, HEIC, Word, Excel or CSV, up to 10 MB each.
              </label>
            </div>
          ) : null}
        </>
      ) : null}

      {data && tab === "history" ? (
        data.history.length === 0 ? (
          <Empty>Nothing recorded yet.</Empty>
        ) : (
          <div className={ui.tableWrap}>
            <table className={ui.table}>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Who</th>
                  <th>What</th>
                </tr>
              </thead>
              <tbody>
                {data.history.map((entry) => (
                  <tr key={entry.id}>
                    <td className={ui.muted}>{formatDateTime(entry.at)}</td>
                    <td>{personName(entry, "actor") ?? "System"}</td>
                    <td>
                      {entry.summary}
                      {entry.eventType === "note.edited" ? (
                        <div className={ui.muted} style={{ whiteSpace: "pre-wrap" }}>
                          Was: {entry.noteBefore}
                          {"\n"}Now: {entry.noteAfter}
                        </div>
                      ) : entry.noteBefore || entry.noteAfter ? (
                        <div className={ui.muted} style={{ whiteSpace: "pre-wrap" }}>
                          {entry.noteBefore ?? entry.noteAfter}
                        </div>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : null}
    </Card>
  );
}
