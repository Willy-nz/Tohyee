"use client";

import Link from "next/link";
import { useState } from "react";
import { useApiData } from "@/components/hooks";
import { useModules } from "@/components/modules";
import { Badge, Button, Card, Empty, Field, Notice, ui } from "@/components/ui";
import { useConfirm } from "@/components/confirm-dialog";
import { useWorkspace } from "@/components/workspace";
import type { ColumnKind, InspectedColumn, SourceFile } from "@/lib/analytics/engine";
import type { AnalyticsSource, LoadRun } from "@/lib/analytics/sources";
import { api, errorMessage } from "@/lib/client/api";
import { formatDateTime } from "@/lib/format";

type Run = LoadRun & { requestedByName?: string | null };

type Overview = {
  enabled: boolean;
  canManage: boolean;
  folder: { chosen: boolean; readable: boolean };
  files: SourceFile[];
  sources: AnalyticsSource[];
  books: Run | null;
  loads: Run[];
};

const KINDS: Array<{ value: ColumnKind; label: string }> = [
  { value: "text", label: "Text" },
  { value: "money", label: "Money (2 decimals)" },
  { value: "quantity", label: "Quantity (4 decimals)" },
  { value: "decimal", label: "Number (6 decimals)" },
  { value: "integer", label: "Whole number" },
  { value: "date", label: "Date" },
  { value: "timestamp", label: "Date and time" },
  { value: "boolean", label: "Yes / no" },
];

function fileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}

function duration(ms: number | null): string {
  if (ms === null) return "";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`;
}

function rows(value: string | null): string {
  return value === null ? "" : Number(value).toLocaleString("en-NZ");
}

function LoadBadge({ run }: { run: LoadRun | null }) {
  if (!run) return <Badge>Not loaded yet</Badge>;
  if (run.status === "running") return <Badge tone="blue">Loading…</Badge>;
  if (run.status === "failed") return <Badge tone="red">Failed</Badge>;
  return <Badge tone="green">Loaded</Badge>;
}

/** Analytics › Data sources: the folder's files, the sources set up from them, and every load. */
export function DataSourcesPage({ organisationId }: { organisationId: string }) {
  const modules = useModules(organisationId);
  const { can } = useWorkspace();
  const overview = useApiData<Overview>("/api/analytics", { organisationId });
  const [setUp, setSetUp] = useState<{ file: string; source?: AnalyticsSource } | null>(null);

  if (!modules) return <p className={ui.muted}>Loading…</p>;
  if (!modules.analytics) {
    return (
      <Notice tone="info">
        Analytics is off.{" "}
        {can("admin") ? (
          <>
            Turn it on in <Link href="/operations/settings">Settings › Modules</Link>.
          </>
        ) : (
          "An admin can turn it on in Settings."
        )}
      </Notice>
    );
  }
  if (overview.error) return <Notice tone="error">{overview.error}</Notice>;
  const data = overview.data;
  if (!data) return <p className={ui.muted}>Loading…</p>;

  const usedFiles = new Set(data.sources.map((source) => source.fileName));
  return (
    <>
      {!data.folder.chosen ? (
        <Notice tone="warning">
          This organisation doesn&apos;t have an analytics folder yet. A server admin chooses it on the server computer, in the
          server settings under Analytics folders. Tohyee only reads files in that folder.
        </Notice>
      ) : !data.folder.readable ? (
        <Notice tone="error">Tohyee can&apos;t open this organisation&apos;s analytics folder. A server admin needs to check it still exists.</Notice>
      ) : null}

      {setUp ? (
        <SourceSetup
          organisationId={organisationId}
          file={setUp.file}
          existing={setUp.source}
          takenTables={data.sources.filter((source) => source.id !== setUp.source?.id).map((source) => source.tableName)}
          onDone={() => {
            setSetUp(null);
            overview.reload();
          }}
          onCancel={() => setSetUp(null)}
        />
      ) : null}

      <BooksCard organisationId={organisationId} data={data} onChanged={overview.reload} />

      <SourcesCard organisationId={organisationId} data={data} onEdit={(source) => setSetUp({ file: source.fileName, source })} onChanged={overview.reload} />

      {data.canManage && data.folder.readable ? (
        <Card title="Files in the folder" description="CSV files in this organisation's folder and the folders inside it, newest first. Set one up to load it.">
          {data.files.length === 0 ? (
            <Empty>No CSV files yet. Save or copy exports into the folder and they&apos;ll show here.</Empty>
          ) : (
            <div className={ui.tableWrap}>
              <table className={ui.table}>
                <thead>
                  <tr>
                    <th>File</th>
                    <th className={ui.num}>Size</th>
                    <th>Changed</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {data.files.map((file) => (
                    <tr key={file.name}>
                      <td>{file.name}</td>
                      <td className={ui.num}>{fileSize(file.sizeBytes)}</td>
                      <td>{formatDateTime(file.modifiedAt)}</td>
                      <td className={ui.num}>
                        {usedFiles.has(file.name) ? (
                          <Badge tone="green">In use</Badge>
                        ) : (
                          <Button size="small" variant="secondary" onClick={() => setSetUp({ file: file.name })}>
                            Set up
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      ) : null}

      <Card title="Load history" description="Every load, nightly or by hand, as the loader recorded it.">
        {data.loads.length === 0 ? (
          <Empty>Nothing has been loaded yet.</Empty>
        ) : (
          <div className={ui.tableWrap}>
            <table className={ui.table}>
              <thead>
                <tr>
                  <th>Started</th>
                  <th>Source</th>
                  <th>How</th>
                  <th>Result</th>
                  <th className={ui.num}>Rows</th>
                  <th className={ui.num}>Took</th>
                </tr>
              </thead>
              <tbody>
                {data.loads.map((run) => (
                  <tr key={run.id}>
                    <td>{formatDateTime(run.startedAt)}</td>
                    <td>
                      {run.sourceName}
                      <div className={ui.muted}>{run.fileName}</div>
                    </td>
                    <td>{run.trigger === "schedule" ? "Nightly" : `By ${run.requestedByName ?? run.requestedByEmail ?? "hand"}`}</td>
                    <td>
                      <LoadBadge run={run} />
                      {run.error ? <div className={ui.muted}>{run.error}</div> : null}
                    </td>
                    <td className={ui.num}>{rows(run.rowsLoaded)}</td>
                    <td className={ui.num}>{duration(run.milliseconds)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

/** The copy of this organisation's own books and CRM (analytics step 2, AB1-AB10). */
function BooksCard({ organisationId, data, onChanged }: { organisationId: string; data: Overview; onChanged: () => void }) {
  const tables = useApiData<{ tables: Array<{ name: string; columns: unknown[] }> }>("/api/analytics/tables", { organisationId });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const copied = (tables.data?.tables ?? []).filter((table) => table.name.startsWith("tohyee_"));

  async function refresh() {
    setBusy(true);
    setMessage(null);
    try {
      const { run } = await api<{ run: LoadRun }>("/api/analytics/books", { method: "POST", body: { organisationId } });
      setMessage(
        run.status === "ok"
          ? { tone: "success", text: `Copied ${rows(run.rowsLoaded)} rows in ${duration(run.milliseconds)}.` }
          : { tone: "error", text: `The books weren't copied: ${run.error}. The last copy is still there.` },
      );
      tables.reload();
    } catch (caught) {
      setMessage({ tone: "error", text: errorMessage(caught) });
    } finally {
      setBusy(false);
      onChanged();
    }
  }

  return (
    <Card
      title="Books and CRM"
      description="A copy of this organisation's ledger, invoices, bills, contacts, items and (with the CRM on) opportunities and activities, made every night after 4am. Amounts are as in the ledger (debit less credit); a dashboard value can be shown the other way round. Pay runs are copied without names."
      actions={
        data.canManage ? (
          <Button size="small" onClick={() => void refresh()} disabled={busy}>
            {busy ? "Copying…" : "Refresh now"}
          </Button>
        ) : null
      }
    >
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      <p className={ui.muted}>
        {data.books ? (
          <>
            <LoadBadge run={data.books} /> Last copied {formatDateTime(data.books.startedAt)}
            {data.books.rowsLoaded ? ` · ${rows(data.books.rowsLoaded)} rows` : ""}
            {data.books.error ? ` · ${data.books.error}` : ""}
          </>
        ) : (
          "Not copied yet. It's copied tonight, or now with Refresh now."
        )}
      </p>
      {copied.length ? (
        <p className={ui.muted}>
          Tables:{" "}
          {copied.map((table, index) => (
            <span key={table.name}>
              {index ? ", " : ""}
              <code>{table.name}</code>
            </span>
          ))}
        </p>
      ) : null}
    </Card>
  );
}

function SourcesCard({
  organisationId,
  data,
  onEdit,
  onChanged,
}: {
  organisationId: string;
  data: Overview;
  onEdit: (source: AnalyticsSource) => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const confirm = useConfirm();

  async function load(source: AnalyticsSource) {
    setBusy(source.id);
    setMessage(null);
    try {
      const { run } = await api<{ run: LoadRun }>(`/api/analytics/sources/${source.id}/load`, { method: "POST", body: { organisationId } });
      setMessage(
        run.status === "ok"
          ? { tone: "success", text: `${source.name}: loaded ${rows(run.rowsLoaded)} rows in ${duration(run.milliseconds)}.` }
          : { tone: "error", text: `${source.name} didn't load: ${run.error}. Yesterday's data is still there.` },
      );
    } catch (caught) {
      setMessage({ tone: "error", text: errorMessage(caught) });
    } finally {
      setBusy(null);
      onChanged();
    }
  }

  async function remove(source: AnalyticsSource) {
    const ok = await confirm("Its loaded data is removed too (the file in the folder isn't touched). The load history stays.", {
      title: `Remove ${source.name}?`,
      confirmLabel: "Remove",
      danger: true,
    });
    if (!ok) return;
    setBusy(source.id);
    setMessage(null);
    try {
      await api(`/api/analytics/sources/${source.id}`, { method: "DELETE", query: { organisationId } });
      onChanged();
    } catch (caught) {
      setMessage({ tone: "error", text: errorMessage(caught) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card title="Sources" description="Each source loads one file into one table. Money columns load as exact decimals.">
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      {data.sources.length === 0 ? (
        <Empty>{data.canManage ? "No sources yet. Set one up from the files below." : "No sources yet. An admin sets them up."}</Empty>
      ) : (
        <div className={ui.tableWrap}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th>Source</th>
                <th>Table</th>
                <th>Last load</th>
                <th className={ui.num}>Rows</th>
                {data.canManage ? <th /> : null}
              </tr>
            </thead>
            <tbody>
              {data.sources.map((source) => (
                <tr key={source.id}>
                  <td>
                    <strong>{source.name}</strong>
                    <div className={ui.muted}>
                      {source.fileName} · {source.columns.length} columns · {source.reloadDaily ? "loads nightly" : "loads by hand only"}
                    </div>
                  </td>
                  <td>
                    <code>{source.tableName}</code>
                  </td>
                  <td>
                    <LoadBadge run={source.lastLoad} />
                    {source.lastLoad ? <div className={ui.muted}>{formatDateTime(source.lastLoad.startedAt)}</div> : null}
                  </td>
                  <td className={ui.num}>{rows(source.lastLoad?.rowsLoaded ?? null)}</td>
                  {data.canManage ? (
                    <td className={ui.num}>
                      <div className={ui.rowButtons}>
                        <Button size="small" onClick={() => void load(source)} disabled={busy !== null}>
                          {busy === source.id ? "Loading…" : "Load now"}
                        </Button>
                        <Button size="small" variant="secondary" onClick={() => onEdit(source)} disabled={busy !== null}>
                          Edit
                        </Button>
                        <Button size="small" variant="danger" onClick={() => void remove(source)} disabled={busy !== null}>
                          Remove
                        </Button>
                      </div>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

type Preview = { columns: InspectedColumn[]; rows: string[][]; delimiter: string };
type ColumnChoice = { source: string; name: string; kind: ColumnKind; include: boolean; detected: string; examples: string[] };

function tableNameFor(file: string, taken: string[]): string {
  const base =
    (file.split("/").pop() ?? file)
      .replace(/\.[^.]+$/, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 50) || "data";
  const start = /^[a-z]/.test(base) ? base : `t_${base}`;
  let name = start;
  for (let n = 2; taken.includes(name); n += 1) name = `${start}_${n}`;
  return name;
}

/** Setting up (or changing) a source: the file's columns, what each is called and how it loads. */
function SourceSetup({
  organisationId,
  file,
  existing,
  takenTables,
  onDone,
  onCancel,
}: {
  organisationId: string;
  file: string;
  existing?: AnalyticsSource;
  takenTables: string[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const [delimiter, setDelimiter] = useState(existing?.delimiter ?? "");
  const preview = useApiData<Preview>("/api/analytics/files", { organisationId, file, delimiter: delimiter || undefined });
  const [name, setName] = useState(existing?.name ?? (file.split("/").pop() ?? file).replace(/\.[^.]+$/, ""));
  const [tableName, setTableName] = useState(existing?.tableName ?? tableNameFor(file, takenTables));
  const [reloadDaily, setReloadDaily] = useState(existing?.reloadDaily ?? true);
  const [choices, setChoices] = useState<ColumnChoice[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The columns come from the preview the first time it arrives; after that they're the person's.
  const columns: ColumnChoice[] | null =
    choices ??
    (preview.data
      ? preview.data.columns.map((column) => {
          const saved = existing?.columns.find((entry) => entry.source === column.source);
          return {
            source: column.source,
            name: saved?.name ?? column.name,
            kind: saved?.kind ?? column.kind,
            include: existing ? Boolean(saved) : true,
            detected: column.detected,
            examples: column.examples,
          };
        })
      : null);

  function change(index: number, patch: Partial<ColumnChoice>) {
    if (!columns) return;
    setChoices(columns.map((column, at) => (at === index ? { ...column, ...patch } : column)));
  }

  async function save() {
    if (!columns) return;
    setBusy(true);
    setError(null);
    const body = {
      organisationId,
      name,
      fileName: file,
      delimiter: delimiter || preview.data?.delimiter || ",",
      reloadDaily,
      columns: columns.filter((column) => column.include).map(({ source, name: columnName, kind }) => ({ source, name: columnName, kind })),
    };
    try {
      let sourceId = existing?.id;
      if (existing) {
        await api(`/api/analytics/sources/${existing.id}`, { method: "PATCH", body });
      } else {
        const created = await api<{ source: AnalyticsSource }>("/api/analytics/sources", { method: "POST", body: { ...body, tableName } });
        sourceId = created.source.id;
      }
      // Load it straight away, so there's data to look at.
      await api(`/api/analytics/sources/${sourceId}/load`, { method: "POST", body: { organisationId } });
      onDone();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title={existing ? `Change ${existing.name}` : "Set up a source"}
      description={`From ${file}. Check each column's type: anything that's money should be Money, so totals are exact to the cent.`}
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      {preview.error ? <Notice tone="error">{preview.error}</Notice> : null}
      <div className={ui.grid3}>
        <Field label="Name">
          <input value={name} maxLength={100} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label="Table" hint={existing ? "Reports use this name, so it can't change." : "Lower-case letters, digits and _."}>
          <input value={tableName} disabled={Boolean(existing)} maxLength={63} onChange={(event) => setTableName(event.target.value)} />
        </Field>
        <Field label="Separator" hint={preview.data ? `Found "${preview.data.delimiter === "\t" ? "tab" : preview.data.delimiter}".` : undefined}>
          <select
            value={delimiter}
            onChange={(event) => {
              setDelimiter(event.target.value);
              setChoices(null);
            }}
          >
            <option value="">Work it out</option>
            <option value=",">Comma</option>
            <option value=";">Semicolon</option>
            <option value={"\t"}>Tab</option>
            <option value="|">Bar (|)</option>
          </select>
        </Field>
      </div>
      <label className={ui.checkbox}>
        <input type="checkbox" checked={reloadDaily} onChange={(event) => setReloadDaily(event.target.checked)} /> Load again every night after 4am
      </label>

      {!columns ? (
        <p className={ui.muted}>{preview.loading ? "Reading the file…" : null}</p>
      ) : (
        <div className={ui.tableWrap}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th>Load</th>
                <th>Heading in the file</th>
                <th>Column name</th>
                <th>Type</th>
                <th>First values</th>
              </tr>
            </thead>
            <tbody>
              {columns.map((column, index) => (
                <tr key={column.source}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Load ${column.source}`}
                      checked={column.include}
                      onChange={(event) => change(index, { include: event.target.checked })}
                    />
                  </td>
                  <td>{column.source}</td>
                  <td>
                    <input
                      aria-label={`Name for ${column.source}`}
                      value={column.name}
                      maxLength={63}
                      disabled={!column.include}
                      onChange={(event) => change(index, { name: event.target.value })}
                    />
                  </td>
                  <td>
                    <select
                      aria-label={`Type for ${column.source}`}
                      value={column.kind}
                      disabled={!column.include}
                      onChange={(event) => change(index, { kind: event.target.value as ColumnKind })}
                    >
                      {KINDS.map((kind) => (
                        <option key={kind.value} value={kind.value}>
                          {kind.label}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className={ui.muted}>{column.examples.filter(Boolean).join(", ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className={ui.rowButtons}>
        <Button onClick={() => void save()} disabled={busy || !columns || !columns.some((column) => column.include)}>
          {busy ? "Saving and loading…" : existing ? "Save and load" : "Set up and load"}
        </Button>
        <Button variant="secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}
