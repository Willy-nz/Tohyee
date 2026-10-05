"use client";

import { useState } from "react";
import { useConfirm } from "@/components/confirm-dialog";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Empty, Field, Notice, ui } from "@/components/ui";
import { type Commentary, type CommentaryReport, suggestedByText } from "@/lib/commentary/types";
import { api, errorMessage } from "@/lib/client/api";
import { formatDateTime } from "@/lib/format";

/**
 * Commentary on a report (decision 446): the connected AI's suggestions,
 * labelled "Suggested by …, not checked" until a person accepts (as they
 * are or edited) or removes them, and commentary people write themselves.
 * Used on the cash flow forecast and a group's consolidated reports.
 */
export function ReportCommentary({
  path,
  organisationId,
  report,
  periodLabel,
  canEdit,
}: {
  /** "/api/cash-flow/commentary" or "/api/consolidation/groups/{id}/commentary". */
  path: string;
  /** For the forecast: the organisation (sent as organisationId). */
  organisationId?: string;
  report: CommentaryReport;
  /** The period on screen, used for a new commentary. */
  periodLabel: string;
  canEdit: boolean;
}) {
  const confirm = useConfirm();
  const query = organisationId ? { organisationId } : {};
  const loaded = useApiData<{ commentary: Commentary[] }>(path, query);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      loaded.reload();
      return true;
    } catch (caught) {
      setError(errorMessage(caught));
      return false;
    } finally {
      setBusy(false);
    }
  }

  const entries = loaded.data?.commentary.filter((entry) => entry.report === report);
  return (
    <Card title="Commentary" description="What the numbers mean. The connected AI can suggest one; it shows as not checked until a person accepts, edits or removes it.">
      {loaded.error ? <Notice tone="error">{loaded.error}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {entries && entries.length === 0 ? <Empty>No commentary yet.</Empty> : null}
      {entries?.map((entry) => (
        <div key={entry.id} className={ui.fieldSection}>
          <div>
            <strong>{entry.periodLabel}</strong> {entry.status === "suggested" ? <Badge tone="amber">Not checked</Badge> : null}
          </div>
          {editing?.id === entry.id ? (
            <Field label="Commentary">
              <textarea className={ui.noteInput} rows={4} maxLength={5000} value={editing.body} onChange={(event) => setEditing({ id: entry.id, body: event.target.value })} />
            </Field>
          ) : (
            <p className={ui.reportNote}>{entry.body}</p>
          )}
          <p className={ui.muted}>
            {entry.status === "suggested"
              ? `${suggestedByText(entry.writtenByEmail, entry.writtenVia ?? "AI")}, ${formatDateTime(entry.createdAt)}`
              : entry.writtenVia
                ? `Suggested by ${entry.writtenByEmail}'s ${entry.writtenVia.replace(/"/g, "")}; checked by ${entry.acceptedByEmail ?? "unknown"}, ${formatDateTime(entry.acceptedAt)}`
                : `Written by ${entry.writtenByEmail}, ${formatDateTime(entry.createdAt)}`}
          </p>
          {canEdit ? (
            <div className={ui.actions}>
              {editing?.id === entry.id ? (
                <>
                  <Button
                    size="small"
                    disabled={busy || !editing.body.trim()}
                    onClick={async () => {
                      const body = { body: editing.body, ...query };
                      if (await run(() => api(`${path}/${entry.id}`, { method: "PUT", body }))) setEditing(null);
                    }}
                  >
                    {entry.status === "suggested" ? "Accept as edited" : "Save"}
                  </Button>
                  <Button size="small" variant="secondary" onClick={() => setEditing(null)}>
                    Cancel
                  </Button>
                </>
              ) : (
                <>
                  {entry.status === "suggested" ? (
                    <Button size="small" disabled={busy} onClick={() => run(() => api(`${path}/${entry.id}`, { method: "PUT", body: query }))}>
                      Accept
                    </Button>
                  ) : null}
                  <Button size="small" variant="secondary" onClick={() => setEditing({ id: entry.id, body: entry.body })}>
                    Edit
                  </Button>
                  <Button
                    size="small"
                    variant="danger"
                    disabled={busy}
                    onClick={async () => {
                      if (!(await confirm("Remove this commentary?"))) return;
                      await run(() => api(`${path}/${entry.id}`, { method: "DELETE", query }));
                    }}
                  >
                    Remove
                  </Button>
                </>
              )}
            </div>
          ) : null}
        </div>
      ))}
      {canEdit ? (
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            if (await run(() => api(path, { method: "POST", body: { report, periodLabel, body: draft, ...query } }))) setDraft("");
          }}
        >
          <Field label={`Add a commentary on ${periodLabel}`}>
            <textarea className={ui.noteInput} rows={3} maxLength={5000} value={draft} onChange={(event) => setDraft(event.target.value)} />
          </Field>
          <Button type="submit" disabled={busy || !draft.trim()}>
            Add commentary
          </Button>
        </form>
      ) : null}
    </Card>
  );
}
