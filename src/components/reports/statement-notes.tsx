"use client";

import { useState } from "react";
import { useApiData } from "@/components/hooks";
import { Button, Card, Field, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage } from "@/lib/client/api";
import type { StatementNote, StatementNotes } from "@/lib/reports/financial-statements";

/** The notes to the financial statements, edited where they're shown (FS2, FS7). Bookkeepers edit; others read. */
export function NotesEditor({ organisationId, loaded, onSaved }: { organisationId: string; loaded: StatementNotes; onSaved?: () => void }) {
  const { can } = useWorkspace();
  const [notes, setNotes] = useState<StatementNote[]>(loaded.notes);
  const [saved, setSaved] = useState(loaded.saved);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const edit = (index: number, change: Partial<StatementNote>) => setNotes(notes.map((note, at) => (at === index ? { ...note, ...change } : note)));
  async function save(list: StatementNote[]) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await api<StatementNotes>("/api/reports/financial-statement-notes", { method: "PUT", body: { organisationId, notes: list } });
      setNotes(result.notes);
      setSaved(result.saved);
      setMessage(result.saved ? "Notes saved." : "Back to the drafts.");
      onSaved?.();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }
  const editable = can("bookkeeper");
  return (
    <Card
      title="Notes"
      description={
        saved
          ? "Your notes, shown and printed after the statements."
          : "Drafts to start from: fill in the parts in [square brackets] and have them checked. Until you save them, they're marked as drafts."
      }
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      {message ? <Notice tone="success">{message}</Notice> : null}
      <div style={{ display: "grid", gap: 16 }}>
        {notes.map((note, index) => (
          <div key={index} style={{ display: "grid", gap: 6 }}>
            <Field label={`Note ${index + 1} title`}>
              <input value={note.title} disabled={!editable} maxLength={150} onChange={(event) => edit(index, { title: event.target.value })} />
            </Field>
            <Field label={`Note ${index + 1} text`}>
              <textarea rows={4} value={note.body} disabled={!editable} maxLength={10000} onChange={(event) => edit(index, { body: event.target.value })} />
            </Field>
            {editable ? (
              <div>
                <Button variant="secondary" size="small" onClick={() => setNotes(notes.filter((_, at) => at !== index))}>
                  Remove note {index + 1}
                </Button>
              </div>
            ) : null}
          </div>
        ))}
      </div>
      {editable ? (
        <div className={ui.rowButtons} style={{ marginTop: 16 }}>
          <Button variant="secondary" onClick={() => setNotes([...notes, { title: "", body: "" }])}>
            Add a note
          </Button>
          <Button disabled={busy} onClick={() => void save(notes)}>
            {busy ? "Saving…" : "Save notes"}
          </Button>
          {saved ? (
            <Button variant="secondary" disabled={busy} onClick={() => void save([])}>
              Go back to the drafts
            </Button>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}

export function StatementNotesCard({ organisationId }: { organisationId: string }) {
  const notes = useApiData<StatementNotes>("/api/reports/financial-statement-notes", { organisationId });
  if (notes.error) return <Notice tone="error">{notes.error}</Notice>;
  if (!notes.data) return null;
  return <NotesEditor organisationId={organisationId} loaded={notes.data} />;
}
