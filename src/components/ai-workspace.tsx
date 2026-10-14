"use client";

import { useState } from "react";
import { Chart } from "@/components/analytics/chart";
import { useApiData } from "@/components/hooks";
import { Button, Card, Empty, Field, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import type { AiDashboard, DashboardWithData } from "@/lib/ai-workspace/dashboards";
import type { Dataset, QueryResult } from "@/lib/ai-workspace/datasets";
import type { AiFile } from "@/lib/ai-workspace/files";
import type { ChartKind } from "@/lib/analytics/chart-spec";
import { api, errorMessage } from "@/lib/client/api";
import { formatDateTime } from "@/lib/format";

const TABS = [
  { key: "dashboards", label: "Dashboards" },
  { key: "tables", label: "Tables" },
  { key: "files", label: "Files for the AI" },
] as const;
type Tab = (typeof TABS)[number]["key"];

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function ResultTable({ result }: { result: QueryResult }) {
  if (result.rows.length === 0) return <Empty>No rows.</Empty>;
  return (
    <div className={ui.tableWrap}>
      <table className={ui.table}>
        <thead>
          <tr>
            {result.columns.map((column) => (
              <th key={column}>{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row, index) => (
            <tr key={index}>
              {result.columns.map((column) => (
                <td key={column}>{row[column] === null || row[column] === undefined ? "" : String(row[column])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {result.truncated ? <p className={ui.muted}>Only the first rows are shown.</p> : null}
    </div>
  );
}

function Files({ organisationId }: { organisationId: string }) {
  const { can } = useWorkspace();
  const files = useApiData<{ files: AiFile[] }>("/api/ai-workspace/files", { organisationId });
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  async function upload(list: FileList | null) {
    if (!list || list.length === 0) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      for (const file of Array.from(list)) {
        await api("/api/ai-workspace/files", { method: "POST", body: { organisationId, fileName: file.name, contentBase64: await readBase64(file), note: note || null } });
      }
      setMessage(`Added. Ask your AI to read ${list.length === 1 ? "it" : "them"} and organise what's in ${list.length === 1 ? "it" : "them"}.`);
      setNote("");
      files.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }
  async function archive(id: string) {
    try {
      await api(`/api/ai-workspace/files/${id}?organisationId=${encodeURIComponent(organisationId)}`, { method: "DELETE" });
      files.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }
  return (
    <Card
      title="Files for the AI"
      description="Drop in spreadsheets, exports and notes however they come (CSV, text, JSON or Excel, up to 10 MB). Your AI reads them and organises what it finds into its own tables. Livestock it finds comes to you as suggestions to accept."
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      {message ? <Notice tone="success">{message}</Notice> : null}
      {can("bookkeeper") ? (
        <div className={ui.inlineForm}>
          <Field label="What it is" hint="Optional, to help the AI">
            <input value={note} maxLength={1000} onChange={(event) => setNote(event.target.value)} placeholder="e.g. Calving from the herd app, 2025" />
          </Field>
          <Field label="Files">
            <input type="file" multiple accept=".csv,.tsv,.txt,.json,.md,.xml,.tab,.xlsx" disabled={busy} onChange={(event) => void upload(event.target.files)} />
          </Field>
        </div>
      ) : null}
      {files.data && files.data.files.length === 0 ? <Empty>No files yet.</Empty> : null}
      {files.data && files.data.files.length > 0 ? (
        <div className={ui.tableWrap}>
          <table className={`${ui.table} ${ui.stackOnPhone}`}>
            <thead>
              <tr>
                <th>File</th>
                <th>What it is</th>
                <th>Added</th>
                <th className={ui.num}>Size</th>
                {can("bookkeeper") ? <th /> : null}
              </tr>
            </thead>
            <tbody>
              {files.data.files.map((file) => (
                <tr key={file.id}>
                  <td data-label="File">{file.fileName}</td>
                  <td data-label="What it is">{file.note ?? ""}</td>
                  <td data-label="Added">
                    {formatDateTime(file.uploadedAt)} · {file.uploadedByEmail}
                  </td>
                  <td data-label="Size" className={ui.num}>
                    {Math.max(1, Math.round(file.sizeBytes / 1024)).toLocaleString("en-NZ")} KB
                  </td>
                  {can("bookkeeper") ? (
                    <td>
                      <Button variant="secondary" size="small" onClick={() => void archive(file.id)}>
                        Archive
                      </Button>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Card>
  );
}

function Tables({ organisationId }: { organisationId: string }) {
  const datasets = useApiData<{ datasets: Dataset[] }>("/api/ai-workspace/datasets", { organisationId });
  const [open, setOpen] = useState<string | null>(null);
  const rows = useApiData<{ dataset: Dataset; rows: QueryResult }>(open ? `/api/ai-workspace/datasets/${encodeURIComponent(open)}` : null, { organisationId });
  return (
    <Card title="The AI's tables" description="Tables your AI made from the files, the notebook and the books, laid out however suits the data. It answers questions and builds dashboards from these.">
      {datasets.error ? <Notice tone="error">{datasets.error}</Notice> : null}
      {datasets.data && datasets.data.datasets.length === 0 ? <Empty>No tables yet. Ask your AI to organise a file you&apos;ve added.</Empty> : null}
      {(datasets.data?.datasets ?? []).map((dataset) => (
        <div key={dataset.id} style={{ borderTop: "1px solid var(--border)", padding: "10px 0" }}>
          <div className={ui.rowButtons} style={{ justifyContent: "space-between" }}>
            <div>
              <strong>{dataset.name}</strong> <span className={ui.muted}>· {dataset.rowCount.toLocaleString("en-NZ")} rows · updated {formatDateTime(dataset.updatedAt)}</span>
              <div className={ui.muted}>{dataset.description}</div>
              <div className={ui.muted}>Columns: {dataset.columns.map((column) => `${column.name} (${column.type})`).join(", ")}</div>
            </div>
            <Button variant="secondary" size="small" onClick={() => setOpen(open === dataset.name ? null : dataset.name)}>
              {open === dataset.name ? "Hide rows" : "Show rows"}
            </Button>
          </div>
          {open === dataset.name && rows.data ? <ResultTable result={rows.data.rows} /> : null}
        </div>
      ))}
    </Card>
  );
}

function Tile({ tile, result }: { tile: DashboardWithData["tiles"][number]; result: DashboardWithData["results"][number] }) {
  if ("error" in result) return <Notice tone="error">{result.error}</Notice>;
  if (tile.kind === "table") return <ResultTable result={result} />;
  const measureLabels = result.columns.slice(result.columns.length - tile.measures.length);
  const category = result.columns[0] ?? "";
  return (
    <Chart
      spec={{ kind: tile.kind as ChartKind, category, series: measureLabels.map((label) => ({ field: label, label })), valueFormat: "number", title: tile.title }}
      rows={result.rows as Record<string, string | number | null>[]}
    />
  );
}

function Dashboard({ organisationId, id }: { organisationId: string; id: string }) {
  const dashboard = useApiData<{ dashboard: DashboardWithData }>(`/api/ai-workspace/dashboards/${id}`, { organisationId });
  if (dashboard.error) return <Notice tone="error">{dashboard.error}</Notice>;
  if (!dashboard.data) return <p className={ui.muted}>Loading…</p>;
  const data = dashboard.data.dashboard;
  return (
    <>
      {data.description ? <p className={ui.muted}>{data.description}</p> : null}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 420px), 1fr))", gap: 16 }}>
        {data.tiles.map((tile, index) => (
          <Card key={index} title={tile.kind === "table" ? tile.title : undefined} description={tile.note}>
            <div style={tile.width === 2 ? { gridColumn: "1 / -1" } : undefined}>
              <Tile tile={tile} result={data.results[index]} />
            </div>
          </Card>
        ))}
      </div>
    </>
  );
}

function Dashboards({ organisationId }: { organisationId: string }) {
  const list = useApiData<{ dashboards: AiDashboard[] }>("/api/ai-workspace/dashboards", { organisationId });
  const [chosen, setChosen] = useState<string | null>(null);
  const dashboards = list.data?.dashboards ?? [];
  const current = chosen ?? dashboards[0]?.id ?? null;
  return (
    <>
      <Card
        title="Dashboards"
        description="Dashboards your AI laid out over its tables. Ask it for one (e.g. calving by month, milk per cow), or to change one."
        actions={
          dashboards.length > 1 ? (
            <Field label="Dashboard">
              <select value={current ?? ""} onChange={(event) => setChosen(event.target.value)}>
                {dashboards.map((dashboard) => (
                  <option key={dashboard.id} value={dashboard.id}>
                    {dashboard.name}
                  </option>
                ))}
              </select>
            </Field>
          ) : null
        }
      >
        {list.error ? <Notice tone="error">{list.error}</Notice> : null}
        {list.data && dashboards.length === 0 ? <Empty>No dashboards yet. Ask your AI to make one.</Empty> : null}
        {dashboards.length === 1 ? <h3 className={ui.cardTitle}>{dashboards[0].name}</h3> : null}
      </Card>
      {current ? <Dashboard key={current} organisationId={organisationId} id={current} /> : null}
    </>
  );
}

/** What your AI keeps and makes (AIW3-AIW7): its dashboards and tables, and the files left for it. */
export function AiWorkspace({ organisationId }: { organisationId: string }) {
  const [tab, setTab] = useState<Tab>("dashboards");
  return (
    <>
      <div className={ui.tabs} role="tablist" aria-label="AI workspace">
        {TABS.map((entry) => (
          <button key={entry.key} type="button" role="tab" aria-selected={tab === entry.key} className={`${ui.tab} ${tab === entry.key ? ui.tabActive : ""}`} onClick={() => setTab(entry.key)}>
            {entry.label}
          </button>
        ))}
      </div>
      {tab === "dashboards" ? <Dashboards organisationId={organisationId} /> : null}
      {tab === "tables" ? <Tables organisationId={organisationId} /> : null}
      {tab === "files" ? <Files organisationId={organisationId} /> : null}
    </>
  );
}
