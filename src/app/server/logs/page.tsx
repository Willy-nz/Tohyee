"use client";

import { useState } from "react";
import { useApiData } from "@/components/hooks";
import { Button, Card, Notice, Page, PageHeader, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { formatDateTime } from "@/lib/format";
import type { LogFile, LogTail } from "@/lib/server-admin/logs";

const ERROR_LINE = /error|exception|failed|refused|denied|fatal/i;

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Server › Logs (decision 1607): the server's log files, newest part first, read-only. */
export default function LogsPage() {
  const { user } = useWorkspace();
  const [file, setFile] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [applied, setApplied] = useState("");
  const [errorsOnly, setErrorsOnly] = useState(false);
  const logs = useApiData<{ folder: string | null; files: LogFile[]; tail: LogTail | null }>(user.isServerAdmin ? "/api/admin/logs" : null, {
    file,
    search: applied || null,
  });
  if (!user.isServerAdmin) {
    return (
      <Page>
        <PageHeader title="Logs" />
        <Notice tone="warning">Only server admins can see the server&apos;s logs.</Notice>
      </Page>
    );
  }
  const files = logs.data?.files ?? [];
  const chosen = file ?? null;
  const tail = logs.data?.tail ?? null;
  const lines = (tail?.lines ?? []).filter((line) => !errorsOnly || ERROR_LINE.test(line));
  return (
    <Page>
      <PageHeader title="Logs" />
      <Notice tone="info">
        What the Tohyee server writes as it runs, including the details behind &quot;Something went wrong&quot;. Read-only. They can name people, organisations and
        file paths, so share them with care.
      </Notice>
      {logs.error ? <Notice tone="error">{logs.error}</Notice> : null}
      {logs.data && !logs.data.folder ? (
        <Notice tone="warning">This server has no log folder set (TOHYEE_LOG_DIR), so it writes to its console instead.</Notice>
      ) : null}
      <Card title="Log files">
        {logs.data?.folder ? <p className={ui.muted}>In {logs.data.folder}</p> : null}
        {files.length === 0 && logs.data ? <p>No log files yet.</p> : null}
        {files.length > 0 ? (
          <div className={ui.tableWrap}>
            <table className={ui.table}>
              <thead>
                <tr>
                  <th>File</th>
                  <th>Last written</th>
                  <th>Size</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {files.map((entry) => (
                  <tr key={entry.name}>
                    <td>{entry.name}</td>
                    <td>{formatDateTime(entry.modifiedAt)}</td>
                    <td>{size(entry.size)}</td>
                    <td>
                      <Button size="small" variant={chosen === entry.name ? "primary" : "secondary"} onClick={() => setFile(entry.name)}>
                        Show
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </Card>
      {chosen ? (
        <Card title={chosen}>
          <form
            className={ui.actions}
            style={{ justifyContent: "flex-start" }}
            onSubmit={(event) => {
              event.preventDefault();
              setApplied(search);
            }}
          >
            <input aria-label="Search this log" placeholder="permission denied" value={search} onChange={(event) => setSearch(event.target.value)} />
            <Button size="small" variant="secondary" type="submit">
              Search
            </Button>
            <label className={ui.checkbox}>
              <input type="checkbox" checked={errorsOnly} onChange={(event) => setErrorsOnly(event.target.checked)} /> Errors only
            </label>
            <Button size="small" variant="secondary" type="button" onClick={() => logs.reload()}>
              Refresh
            </Button>
          </form>
          {tail?.truncated ? <p className={ui.muted}>The newest {size(tail.size - tail.from)} of {size(tail.size)}.</p> : null}
          <pre style={{ maxHeight: 560, overflow: "auto", fontSize: 12, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
            {lines.length > 0 ? lines.slice().reverse().join("\n") : tail ? "Nothing matches." : "Loading…"}
          </pre>
        </Card>
      ) : null}
    </Page>
  );
}
