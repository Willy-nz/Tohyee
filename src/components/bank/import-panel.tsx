"use client";

import { type FormEvent, useState } from "react";
import { InOutCells, readFileAsBase64 } from "@/components/bank/common";
import { Money } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Empty, Field, Notice, Stat, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import type { BankAccount } from "@/lib/bank/accounts";
import { STATEMENT_FORMAT_LABELS } from "@/lib/bank/formats/common";
import { LAYOUT_FIELD_LABELS, LAYOUT_FIELDS, type TableLayout } from "@/lib/bank/formats/table";
import type { ImportPreview, StatementImport } from "@/lib/bank/imports";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import { formatDate, formatDateTime, personName } from "@/lib/format";

const MAX_BYTES = 10 * 1024 * 1024;
const ACCEPT = ".csv,.txt,.xlsx,.ofx,.qfx,.qbo,.qif,.xml,.sta,.mt940,.940";

type Upload = { fileName: string; fileBase64: string };

function LayoutEditor({ layout, headers, onChange }: { layout: TableLayout; headers: string[]; onChange: (layout: TableLayout) => void }) {
  return (
    <div style={{ display: "grid", gap: 10 }}>
      <p className={ui.muted}>
        Which column is which. Use either one amount column, or separate money in and money out columns. The layout is saved on this
        account, so the next file from this bank is read the same way.
      </p>
      <div className={ui.grid4}>
        <Field label="Heading row" hint="Row number of the headings; 0 if the file has none.">
          <input
            type="number"
            min={0}
            value={layout.headerRow + 1}
            onChange={(event) => onChange({ ...layout, headerRow: Math.max(-1, Number(event.target.value) - 1) })}
          />
        </Field>
        <Field label="Dates are written">
          <select value={layout.dateOrder} onChange={(event) => onChange({ ...layout, dateOrder: event.target.value as TableLayout["dateOrder"] })}>
            <option value="dmy">Day first (31/05/2026)</option>
            <option value="mdy">Month first (05/31/2026)</option>
            <option value="ymd">Year first (2026-05-31)</option>
          </select>
        </Field>
        {LAYOUT_FIELDS.map((field) => (
          <Field key={field} label={LAYOUT_FIELD_LABELS[field]}>
            <select
              value={layout.columns[field] ?? ""}
              onChange={(event) => {
                const columns = { ...layout.columns };
                if (event.target.value) columns[field] = event.target.value;
                else delete columns[field];
                onChange({ ...layout, columns });
              }}
            >
              <option value="">Not used</option>
              {headers.map((header) => (
                <option key={header} value={header}>
                  {header}
                </option>
              ))}
            </select>
          </Field>
        ))}
      </div>
      <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input type="checkbox" checked={layout.invertAmounts} onChange={(event) => onChange({ ...layout, invertAmounts: event.target.checked })} />
        Flip every amount (the file shows spending as positive, as some credit card exports do)
      </label>
    </div>
  );
}

function PreviewView({ preview }: { preview: ImportPreview }) {
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div className={ui.statRow}>
        <Stat label="Format" value={STATEMENT_FORMAT_LABELS[preview.format]} />
        <Stat label="Lines in the file" value={preview.lineCount} />
        <Stat label="New lines to add" value={preview.newCount} />
        <Stat label="Already here (skipped)" value={preview.duplicateCount} />
      </div>
      <p>
        {preview.firstDate ? (
          <>
            {formatDate(preview.firstDate)} to {formatDate(preview.lastDate)} · money in <Money value={preview.moneyIn} /> · money out{" "}
            <Money value={preview.moneyOut} />
          </>
        ) : (
          "No transactions found."
        )}
        {preview.closingBalance ? (
          <>
            {" "}
            · closing balance <Money value={preview.closingBalance.amount} />
            {preview.closingBalance.date ? ` on ${formatDate(preview.closingBalance.date)}` : ""}
          </>
        ) : null}
        {preview.accountNumber ? <span className={ui.muted}> · account {preview.accountNumber}</span> : null}
      </p>
      {preview.possibleDuplicateCount > 0 ? (
        <Notice tone="warning">
          {preview.possibleDuplicateCount} {preview.possibleDuplicateCount === 1 ? "line has" : "lines have"} the same date and amount as a
          line from another source (such as the bank feed). {preview.possibleDuplicateCount === 1 ? "It'll" : "They'll"} be added and
          flagged as possible duplicates, so you can exclude them if they are.
        </Notice>
      ) : null}
      {preview.errors.length > 0 ? (
        <Notice tone="error">
          {preview.errors.length} {preview.errors.length === 1 ? "problem" : "problems"}, so this file can&apos;t be imported yet:
          <ul style={{ margin: "6px 0 0 18px" }}>
            {preview.errors.slice(0, 10).map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
          {preview.errors.length > 10 ? `…and ${preview.errors.length - 10} more.` : null}
        </Notice>
      ) : null}
      {preview.sample.length > 0 ? (
        <div className={ui.tableWrap}>
          <table className={ui.table}>
            <caption className={ui.muted} style={{ textAlign: "left" }}>
              The first {preview.sample.length} lines as they&apos;ll be read
            </caption>
            <thead>
              <tr>
                <th>Date</th>
                <th>Description</th>
                <th className={ui.num}>Money in</th>
                <th className={ui.num}>Money out</th>
                <th className={ui.num}>Balance</th>
              </tr>
            </thead>
            <tbody>
              {preview.sample.map((line, index) => (
                <tr key={`${line.date}-${index}`}>
                  <td style={{ whiteSpace: "nowrap" }}>{formatDate(line.date)}</td>
                  <td>{line.description}</td>
                  <InOutCells amount={line.amount} />
                  <td className={ui.num}>{line.balance !== null ? <Money value={line.balance} /> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

function ImportHistory({
  organisationId,
  imports,
  onChanged,
}: {
  organisationId: string;
  imports: StatementImport[];
  onChanged: () => void;
}) {
  const { can } = useWorkspace();
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function remove(entry: StatementImport) {
    if (!window.confirm(`Delete this import? Its ${entry.lineCount} lines are marked deleted and stop counting. Nothing posted changes.`)) return;
    setBusyId(entry.id);
    setError(null);
    try {
      await api(`/api/statement-imports/${entry.id}`, { method: "DELETE", query: { organisationId } });
      onChanged();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusyId(null);
    }
  }

  if (imports.length === 0) return <Empty>No imports or bank feed syncs yet.</Empty>;
  return (
    <>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.tableWrap}>
        <table className={ui.table}>
          <thead>
            <tr>
              <th>When</th>
              <th>From</th>
              <th>Dates</th>
              <th className={ui.num}>Lines added</th>
              <th className={ui.num}>Skipped</th>
              <th>Status</th>
              {can("bookkeeper") ? <th /> : null}
            </tr>
          </thead>
          <tbody>
            {imports.map((entry) => (
              <tr key={entry.id}>
                <td>
                  {formatDateTime(entry.createdAt)}
                  <div className={ui.muted}>{personName(entry, "createdBy")}</div>
                </td>
                <td>
                  {entry.fileName ?? STATEMENT_FORMAT_LABELS[entry.fileFormat]}
                  {entry.fileName ? <div className={ui.muted}>{STATEMENT_FORMAT_LABELS[entry.fileFormat]}</div> : null}
                </td>
                <td>{entry.firstDate ? `${formatDate(entry.firstDate)} – ${formatDate(entry.lastDate)}` : <span className={ui.muted}>—</span>}</td>
                <td className={ui.num}>
                  {entry.lineCount}
                  {entry.possibleDuplicateCount > 0 ? (
                    <div>
                      <Badge tone="amber">{entry.possibleDuplicateCount} possible duplicates</Badge>
                    </div>
                  ) : null}
                </td>
                <td className={ui.num}>{entry.duplicateCount}</td>
                <td>
                  {entry.status === "deleted" ? (
                    <Badge tone="red">Deleted</Badge>
                  ) : entry.reconciledCount > 0 ? (
                    <Badge tone="green">{entry.reconciledCount} reconciled</Badge>
                  ) : (
                    <Badge>Active</Badge>
                  )}
                </td>
                {can("bookkeeper") ? (
                  <td>
                    {entry.status === "active" && entry.source === "file" ? (
                      <Button
                        variant="secondary"
                        size="small"
                        disabled={busyId === entry.id || entry.reconciledCount > 0}
                        title={entry.reconciledCount > 0 ? "Unreconcile its lines first." : undefined}
                        onClick={() => void remove(entry)}
                      >
                        Delete
                      </Button>
                    ) : null}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** Upload a statement file, check what it holds, then import it. */
export function ImportPanel({ organisationId, account, onChanged }: { organisationId: string; account: BankAccount; onChanged: () => void }) {
  const { can } = useWorkspace();
  const history = useApiData<{ imports: StatementImport[] }>(`/api/bank-accounts/${account.id}/imports`, { organisationId });
  const [upload, setUpload] = useState<Upload | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [layout, setLayout] = useState<TableLayout | null>(null);
  const [layoutChanged, setLayoutChanged] = useState(false);
  const [key, setKey] = useState(() => newIdempotencyKey("statement-import"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<StatementImport | null>(null);

  async function runPreview(next: Upload, nextLayout: TableLayout | null) {
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ preview: ImportPreview }>(`/api/bank-accounts/${account.id}/imports/preview`, {
        method: "POST",
        body: { organisationId, ...next, layout: nextLayout ?? undefined },
      });
      setPreview(result.preview);
      setLayout(result.preview.table?.layout ?? null);
      setLayoutChanged(false);
    } catch (caught) {
      setPreview(null);
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function choose(file: File | undefined) {
    setDone(null);
    setPreview(null);
    setLayout(null);
    setError(null);
    if (!file) return;
    if (file.size > MAX_BYTES) {
      setError("That file is over 10 MB. Export a shorter date range.");
      return;
    }
    try {
      const next = { fileName: file.name, fileBase64: await readFileAsBase64(file) };
      setUpload(next);
      setKey(newIdempotencyKey("statement-import"));
      await runPreview(next, null);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  async function runImport(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!upload) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ import: StatementImport }>(`/api/bank-accounts/${account.id}/imports`, {
        method: "POST",
        body: { organisationId, source: "ui", idempotencyKey: key, ...upload, layout: layout ?? undefined },
      });
      setDone(result.import);
      setUpload(null);
      setPreview(null);
      setLayout(null);
      setKey(newIdempotencyKey("statement-import"));
      history.reload();
      onChanged();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: 16 }}>
      {can("bookkeeper") ? (
        <form onSubmit={(event) => void runImport(event)} style={{ display: "grid", gap: 12 }}>
          <Field
            label="Statement file"
            hint="CSV, Excel (.xlsx), OFX/QFX/QBO, QIF, CAMT.053 (.xml) or MT940, up to 10 MB. Lines already on this account are skipped, so overlapping date ranges are fine. Importing posts nothing."
          >
            <input type="file" accept={ACCEPT} onChange={(event) => void choose(event.target.files?.[0])} disabled={busy} />
          </Field>
          {account.isForeign ? (
            <p className={ui.muted}>
              Lines are recorded in {account.statementCurrency}. A file that says it&apos;s in another currency (an OFX CURDEF, a CAMT.053
              or MT940 currency, or a CSV currency column) is refused.
            </p>
          ) : null}
          {done ? (
            <Notice tone="success">
              Imported {done.lineCount} new {done.lineCount === 1 ? "line" : "lines"}
              {done.duplicateCount > 0 ? ` (${done.duplicateCount} already here were skipped)` : ""}. Reconcile them on the Reconcile tab.
            </Notice>
          ) : null}
          {error ? <Notice tone="error">{error}</Notice> : null}
          {busy && !preview ? <p className={ui.muted}>Reading the file…</p> : null}
          {preview ? <PreviewView preview={preview} /> : null}
          {preview?.table && layout && upload ? (
            <details open={preview.errors.length > 0 || layoutChanged}>
              <summary>Columns ({preview.table.headers.length} in the file)</summary>
              <div style={{ display: "grid", gap: 10, marginTop: 10 }}>
                <LayoutEditor
                  layout={layout}
                  headers={preview.table.headers}
                  onChange={(next) => {
                    setLayout(next);
                    setLayoutChanged(true);
                  }}
                />
                <div>
                  <Button variant="secondary" disabled={busy || !layoutChanged} onClick={() => void runPreview(upload, layout)}>
                    Read the file again with these columns
                  </Button>
                </div>
              </div>
            </details>
          ) : null}
          {preview ? (
            <div className={ui.actions}>
              <Button type="submit" disabled={busy || layoutChanged || preview.errors.length > 0 || preview.newCount === 0}>
                {busy ? "Importing…" : preview.newCount === 0 ? "Nothing new to import" : `Import ${preview.newCount} ${preview.newCount === 1 ? "line" : "lines"}`}
              </Button>
            </div>
          ) : null}
        </form>
      ) : null}
      <h3 className={ui.cardTitle}>Imports and bank feed syncs</h3>
      {history.error ? <Notice tone="error">{history.error}</Notice> : null}
      {history.data ? (
        <ImportHistory
          organisationId={organisationId}
          imports={history.data.imports}
          onChanged={() => {
            history.reload();
            onChanged();
          }}
        />
      ) : null}
    </div>
  );
}
