"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card, Notice, Page, PageHeader, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage } from "@/lib/client/api";

type FolderRow = { organisationId: string; displayName: string; folder: string | null; readable: boolean };

/**
 * Each organisation's bank files folder (decision 386): the folder on this
 * computer its folder feeds read statement files from, one subfolder per bank
 * account. Chosen here, by a server admin, so an organisation can't point
 * Tohyee at other folders.
 */
export default function ServerBankFilesPage() {
  const { user } = useWorkspace();
  const [rows, setRows] = useState<FolderRow[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  const show = useCallback((folders: FolderRow[]) => {
    setRows(folders);
    setDrafts(Object.fromEntries(folders.map((row) => [row.organisationId, row.folder ?? ""])));
  }, []);
  const load = useCallback(async () => show((await api<{ folders: FolderRow[] }>("/api/admin/bank-file-folders")).folders), [show]);

  useEffect(() => {
    if (!user.isServerAdmin) return;
    let cancelled = false;
    api<{ folders: FolderRow[] }>("/api/admin/bank-file-folders").then(
      (result) => {
        if (!cancelled) show(result.folders);
      },
      (caught) => {
        if (!cancelled) setMessage({ tone: "error", text: errorMessage(caught) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [user.isServerAdmin, show]);

  async function save(row: FolderRow, folder: string) {
    setBusy(row.organisationId);
    setMessage(null);
    try {
      await api("/api/admin/bank-file-folders", { method: "PUT", body: { organisationId: row.organisationId, folder } });
      await load();
      setMessage({ tone: "success", text: folder ? `${row.displayName} now reads bank files from ${folder}.` : `${row.displayName} has no bank files folder now.` });
    } catch (caught) {
      setMessage({ tone: "error", text: errorMessage(caught) });
    } finally {
      setBusy(null);
    }
  }

  if (!user.isServerAdmin) {
    return (
      <Page>
        <PageHeader title="Bank files folders" />
        <Notice tone="warning">Only server admins can choose bank files folders.</Notice>
      </Page>
    );
  }

  return (
    <Page>
      <PageHeader
        title="Bank files folders"
        description="The folder on this computer each organisation's automatic statement files come from. An organisation admin links each bank account to a folder inside it. Tohyee only reads files there; it never changes or deletes them."
      />
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      <Card title="Organisations" description="Use a full path, e.g. D:\BankFiles\Glimmers. The Tohyee service needs to be able to read it. Leave blank for none.">
        {!rows ? (
          <p className={ui.muted}>Loading…</p>
        ) : (
          <div className={ui.tableWrap}>
            <table className={ui.table}>
              <thead>
                <tr>
                  <th>Organisation</th>
                  <th>Folder</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const draft = drafts[row.organisationId] ?? "";
                  const changed = draft.trim() !== (row.folder ?? "");
                  return (
                    <tr key={row.organisationId}>
                      <td>
                        <strong>{row.displayName}</strong>
                        <div className={ui.muted}>{row.organisationId}</div>
                      </td>
                      <td style={{ minWidth: 280 }}>
                        <input
                          aria-label={`Bank files folder for ${row.displayName}`}
                          value={draft}
                          placeholder="No folder"
                          style={{ width: "100%" }}
                          onChange={(event) => setDrafts({ ...drafts, [row.organisationId]: event.target.value })}
                        />
                        <div style={{ marginTop: 4 }}>
                          {!row.folder ? <Badge>None</Badge> : row.readable ? <Badge tone="green">Readable</Badge> : <Badge tone="red">Can&apos;t open it</Badge>}
                        </div>
                      </td>
                      <td className={ui.num}>
                        <Button size="small" disabled={!changed || busy !== null} onClick={() => void save(row, draft.trim())}>
                          {busy === row.organisationId ? "Saving…" : "Save"}
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </Page>
  );
}
