"use client";

import { useState } from "react";
import { Money } from "@/components/books";
import { useConfirm } from "@/components/confirm-dialog";
import { useApiData } from "@/components/hooks";
import { JournalEditor } from "@/components/journals/journal-editor";
import { Button, Card, Empty, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import type { Account } from "@/lib/accounts/service";
import { api, errorMessage } from "@/lib/client/api";
import { formatDate, formatDateTime, personName } from "@/lib/format";
import type { JournalDraft, JournalDraftWithLines } from "@/lib/ledger/journal-drafts";

/**
 * Draft journals waiting to be posted (examples MJD1-MJD9): saved from the
 * journal editor or by an AI key. Edit, post or delete each one here.
 */
export function JournalDrafts({
  organisationId,
  accounts,
  reloadKey,
  onPosted,
}: {
  organisationId: string;
  accounts: Account[] | null;
  /** Changes when a draft was saved elsewhere on the page, so the list reloads. */
  reloadKey: number;
  onPosted: (journalId: string) => void;
}) {
  const confirm = useConfirm();
  const { can } = useWorkspace();
  const drafts = useApiData<{ drafts: JournalDraft[] }>("/api/ledger/journal-drafts", { organisationId, status: "draft", reloadKey });
  const [editing, setEditing] = useState<JournalDraftWithLines | null>(null);
  const [status, setStatus] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  async function run(action: () => Promise<void>) {
    try {
      await action();
    } catch (caught) {
      setStatus({ tone: "error", text: errorMessage(caught) });
    }
  }

  const list = drafts.data?.drafts ?? [];
  if (drafts.data && list.length === 0 && !status) return null;

  return (
    <Card title="Draft journals" description="Saved but not posted: they aren't in the ledger until someone posts them.">
      {status ? <Notice tone={status.tone}>{status.text}</Notice> : null}
      {drafts.error ? <Notice tone="error">{drafts.error}</Notice> : null}
      {editing && accounts ? (
        <Card title={`Draft journal #${editing.id}`}>
          <JournalEditor
            key={editing.id}
            organisationId={organisationId}
            accounts={accounts}
            mode="draft"
            draft={editing}
            onCancel={() => setEditing(null)}
            onDraftSaved={(id) => {
              setEditing(null);
              setStatus({ tone: "success", text: `Saved draft journal #${id}.` });
              drafts.reload();
            }}
            onDone={(journalId) => {
              setEditing(null);
              setStatus({ tone: "success", text: `Posted the draft as journal #${journalId}.` });
              drafts.reload();
              onPosted(journalId);
            }}
          />
        </Card>
      ) : null}
      {list.length === 0 ? (
        <Empty>No drafts waiting.</Empty>
      ) : (
        <div className={ui.tableWrap}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th>Date</th>
                <th>Reference</th>
                <th>Description</th>
                <th>Saved by</th>
                <th className={ui.num}>Amount</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((draft) => (
                <tr key={draft.id}>
                  <td>{formatDate(draft.postingDate)}</td>
                  <td>{draft.reference}</td>
                  <td className={ui.muted}>{draft.description}</td>
                  <td>
                    {personName(draft, "createdBy") ?? draft.createdByEmail}
                    {draft.createdVia ? <div className={ui.muted}>via {draft.createdVia}</div> : null}
                    <div className={ui.muted}>{formatDateTime(draft.updatedAt)}</div>
                  </td>
                  <td className={ui.num}>
                    <Money value={draft.total} />
                  </td>
                  <td className={ui.num}>
                    {can("bookkeeper") ? (
                      <div className={ui.rowButtons}>
                        <Button
                          variant="secondary"
                          size="small"
                          onClick={() =>
                            void run(async () => {
                              const result = await api<{ draft: JournalDraftWithLines }>(`/api/ledger/journal-drafts/${draft.id}`, {
                                query: { organisationId },
                              });
                              setStatus(null);
                              setEditing(result.draft);
                            })
                          }
                        >
                          Edit
                        </Button>
                        <Button
                          size="small"
                          onClick={async () => {
                            if (!(await confirm(`Post draft journal ${draft.reference} to the ledger?`))) return;
                            await run(async () => {
                              const result = await api<{ journal: { id: string } }>(`/api/ledger/journal-drafts/${draft.id}/post`, {
                                method: "POST",
                                body: { organisationId },
                              });
                              setStatus({ tone: "success", text: `Posted the draft as journal #${result.journal.id}.` });
                              drafts.reload();
                              onPosted(result.journal.id);
                            });
                          }}
                        >
                          Post
                        </Button>
                        <Button
                          variant="danger"
                          size="small"
                          onClick={async () => {
                            if (!(await confirm(`Delete draft journal ${draft.reference}? Nothing was posted, so nothing else changes.`))) return;
                            await run(async () => {
                              await api(`/api/ledger/journal-drafts/${draft.id}`, { method: "DELETE", query: { organisationId } });
                              setStatus({ tone: "success", text: `Deleted draft journal ${draft.reference}.` });
                              if (editing?.id === draft.id) setEditing(null);
                              drafts.reload();
                            });
                          }}
                        >
                          Delete
                        </Button>
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
