"use client";

import { useState } from "react";
import { DateInput } from "@/components/date-input";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Empty, Field, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { NOTEBOOK_CATEGORIES, NOTEBOOK_CATEGORY_LABELS, type NotebookCategory, type NotebookEntry } from "@/lib/ai-workspace/notebook-labels";
import { api, errorMessage } from "@/lib/client/api";
import { formatDate } from "@/lib/format";

type Draft = { category: NotebookCategory; title: string; body: string; happenedOn: string };
const EMPTY: Draft = { category: "history", title: "", body: "", happenedOn: "" };

function NoteForm({ initial, busy, onSave, onCancel }: { initial: Draft; busy: boolean; onSave: (draft: Draft) => void; onCancel?: () => void }) {
  const [draft, setDraft] = useState(initial);
  return (
    <form
      style={{ display: "grid", gap: 8 }}
      onSubmit={(event) => {
        event.preventDefault();
        onSave(draft);
      }}
    >
      <div className={ui.inlineForm}>
        <Field label="Category">
          <select value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value as NotebookCategory })}>
            {NOTEBOOK_CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {NOTEBOOK_CATEGORY_LABELS[category]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Title">
          <input required maxLength={200} value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
        </Field>
        <Field label="When" hint="Optional: when it happened">
          <DateInput value={draft.happenedOn} onChange={(event) => setDraft({ ...draft, happenedOn: event.target.value })} />
        </Field>
      </div>
      <Field label="Note">
        <textarea required rows={5} maxLength={20000} value={draft.body} onChange={(event) => setDraft({ ...draft, body: event.target.value })} />
      </Field>
      <div className={ui.rowButtons}>
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save note"}
        </Button>
        {onCancel ? (
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  );
}

/** The farm notebook (AIW1, AIW2): the farm's history, goals, people and ways, for people and their AI. */
export function FarmNotebook({ organisationId }: { organisationId: string }) {
  const { can } = useWorkspace();
  const [category, setCategory] = useState<NotebookCategory | "">("");
  const [search, setSearch] = useState("");
  const notes = useApiData<{ notes: NotebookEntry[] }>("/api/farm-notebook", { organisationId, category: category || null, search: search || null });
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editable = can("bookkeeper");

  async function save(draft: Draft, id?: string) {
    setBusy(true);
    setError(null);
    try {
      await api(id ? `/api/farm-notebook/${id}` : "/api/farm-notebook", { method: id ? "PUT" : "POST", body: { organisationId, ...draft, happenedOn: draft.happenedOn || null } });
      setEditing(null);
      setAdding(false);
      notes.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function archive(id: string) {
    setError(null);
    try {
      await api(`/api/farm-notebook/${id}?organisationId=${encodeURIComponent(organisationId)}`, { method: "DELETE" });
      notes.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  return (
    <>
      <Card
        title="Farm notebook"
        description="What's worth knowing about the farm: its history, goals, people and how it's farmed. Your AI reads this to answer questions, and adds to it when it learns something (marked as written by the AI)."
        actions={
          editable && !adding ? (
            <Button onClick={() => setAdding(true)} size="small">
              Add a note
            </Button>
          ) : null
        }
      >
        {error ? <Notice tone="error">{error}</Notice> : null}
        {adding ? <NoteForm initial={EMPTY} busy={busy} onSave={(draft) => void save(draft)} onCancel={() => setAdding(false)} /> : null}
        <div className={ui.inlineForm}>
          <Field label="Show">
            <select value={category} onChange={(event) => setCategory(event.target.value as NotebookCategory | "")}>
              <option value="">Everything</option>
              {NOTEBOOK_CATEGORIES.map((entry) => (
                <option key={entry} value={entry}>
                  {NOTEBOOK_CATEGORY_LABELS[entry]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Search">
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Words in a note" />
          </Field>
        </div>
      </Card>
      {notes.error ? <Notice tone="error">{notes.error}</Notice> : null}
      {notes.data && notes.data.notes.length === 0 ? <Empty>No notes yet. Start with the farm&apos;s history and this season&apos;s goals.</Empty> : null}
      {(notes.data?.notes ?? []).map((note) => (
        <Card
          key={note.id}
          title={note.title}
          description={`${NOTEBOOK_CATEGORY_LABELS[note.category]}${note.happenedOn ? ` · ${formatDate(note.happenedOn)}` : ""} · updated by ${note.updatedByEmail}`}
          actions={
            <span className={ui.rowButtons}>
              {note.writtenBy === "ai" ? <Badge tone="blue">Written by AI</Badge> : null}
              {editable && editing !== note.id ? (
                <>
                  <Button variant="secondary" size="small" onClick={() => setEditing(note.id)}>
                    Edit
                  </Button>
                  <Button variant="secondary" size="small" onClick={() => void archive(note.id)}>
                    Archive
                  </Button>
                </>
              ) : null}
            </span>
          }
        >
          {editing === note.id ? (
            <NoteForm
              initial={{ category: note.category, title: note.title, body: note.body, happenedOn: note.happenedOn ?? "" }}
              busy={busy}
              onSave={(draft) => void save(draft, note.id)}
              onCancel={() => setEditing(null)}
            />
          ) : (
            <p style={{ whiteSpace: "pre-wrap", margin: 0 }}>{note.body}</p>
          )}
        </Card>
      ))}
    </>
  );
}
