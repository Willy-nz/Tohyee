"use client";

import { useEffect, useMemo, useState } from "react";
import { readFileAsBase64 } from "@/components/bank/common";
import { Money } from "@/components/books";
import { DateInput } from "@/components/date-input";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Empty, Field, Notice, ui } from "@/components/ui";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import { formatDate } from "@/lib/format";
import { APPLIES_TO, APPLIES_TO_LABELS, type AppliesToKey } from "@/lib/tax/income/allocation-kinds";
import {
  AMOUNT_SIGN_LABELS,
  AMOUNT_SIGNS,
  type AmountSign,
  DATE_ORDER_LABELS,
  DATE_ORDERS,
  type DateOrder,
  distinctValues,
  headingsAt,
  IRD_IMPORT_COLUMN_LABELS,
  IRD_IMPORT_COLUMNS,
  IRD_IMPORT_SOURCE_LABELS,
  IRD_IMPORT_SOURCES,
  IRD_ROW_KIND_LABELS,
  IRD_ROW_KINDS,
  type IrdImportColumn,
  type IrdImportMapping,
  type IrdImportSource,
  type IrdRowKind,
  suggestAppliesTo,
  suggestKind,
} from "@/lib/tax/income/ird-import-kinds";
import type { ImportedFigures, IrdImport, IrdImportPreview, IrdImportRow, SavedIrdMapping } from "@/lib/tax/income/ird-imports";
import type { IrdDocument } from "@/lib/tax/income/ird-documents";

/*
 * Importing IRD account files (examples ITX-IMP1 to ITX-IMP12, decisions
 * 710-716). A self-contained panel for the income tax workspace: choose a
 * file, map its columns with a preview, then accept or decline each row.
 * Nothing counts until a person accepts it; nothing is sent to IRD.
 */

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_PREVIEW_ROWS = 200;
/** A block whose tables scroll or stack inside it, rather than widening the card on a phone. */
const BLOCK = { minWidth: 0, gridTemplateColumns: "minmax(0, 1fr)" } as const;

type Status = { tone: "success" | "error"; text: string } | null;
type ReadFile = {
  fileName: string;
  rows: string[][];
  headerRow: number;
  headings: string[];
};
type ReadResult = {
  file: ReadFile;
  mappings: SavedIrdMapping[];
  suggestedMappingId: string | null;
};
type Loaded = {
  imports: IrdImport[];
  mappings: SavedIrdMapping[];
  documents: IrdDocument[];
  figures: ImportedFigures | null;
};

const emptyMapping = (headerRow: number): IrdImportMapping => ({
  headerRow,
  columns: {},
  dateOrder: "dmy",
  kindValues: {},
  appliesToValues: {},
});

/** Fills in suggestions for values that have no choice yet, so the person starts from something and changes what's wrong. */
export function withSuggestions(mapping: IrdImportMapping, rows: readonly string[][]): IrdImportMapping {
  const kindValues = { ...mapping.kindValues };
  for (const value of distinctValues(rows, mapping.headerRow, mapping.columns.type)) {
    if (kindValues[value.key] === undefined) {
      const suggested = suggestKind(value.text);
      if (suggested) kindValues[value.key] = suggested;
    }
  }
  const appliesToValues = { ...mapping.appliesToValues };
  for (const value of distinctValues(rows, mapping.headerRow, mapping.columns.appliesTo)) {
    if (appliesToValues[value.key] === undefined) appliesToValues[value.key] = suggestAppliesTo(value.text) ?? "none";
  }
  return { ...mapping, kindValues, appliesToValues };
}

function directionAmount(row: { direction: "debit" | "credit" | null; amount: string | null }) {
  if (!row.amount || !row.direction) return <span className={ui.muted}>none</span>;
  return (
    <>
      <Money value={row.amount} /> <span className={ui.muted}>{row.direction === "debit" ? "owed" : "paid or credited"}</span>
    </>
  );
}

function Mapper({
  organisationId,
  read,
  source,
  years,
  documents,
  fileBase64,
  onImported,
}: {
  organisationId: string;
  read: ReadResult;
  source: IrdImportSource;
  years: number[];
  documents: IrdDocument[];
  fileBase64: string;
  onImported: () => void;
}) {
  const rows = read.file.rows;
  const suggested = read.mappings.find((entry) => entry.id === read.suggestedMappingId);
  const [savedId, setSavedId] = useState<string>(suggested?.id ?? "");
  const [mapping, setMapping] = useState<IrdImportMapping>(() => (suggested ? withSuggestions({ ...suggested.mapping, headerRow: read.file.headerRow }, rows) : emptyMapping(read.file.headerRow)));
  const [fileIncomeYear, setFileIncomeYear] = useState("");
  const [supportingDocumentId, setSupportingDocumentId] = useState("");
  const [saveAs, setSaveAs] = useState(suggested?.name ?? "");
  const [preview, setPreview] = useState<IrdImportPreview | null>(null);
  const [status, setStatus] = useState<Status>(null);
  const [busy, setBusy] = useState(false);
  const [key] = useState(() => newIdempotencyKey("ird-import"));
  const headings = useMemo(() => headingsAt(rows, mapping.headerRow), [rows, mapping.headerRow]);
  const typeValues = useMemo(() => distinctValues(rows, mapping.headerRow, mapping.columns.type), [rows, mapping.headerRow, mapping.columns.type]);
  const appliesValues = useMemo(() => distinctValues(rows, mapping.headerRow, mapping.columns.appliesTo), [rows, mapping.headerRow, mapping.columns.appliesTo]);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      api<{ preview: IrdImportPreview }>("/api/income-tax/imports/preview", {
        method: "POST",
        body: {
          organisationId,
          rows,
          mapping,
          fileIncomeYear: fileIncomeYear || null,
        },
      }).then(
        (result) => {
          if (!cancelled) setPreview(result.preview);
        },
        (error: unknown) => {
          if (!cancelled) setStatus({ tone: "error", text: errorMessage(error) });
        },
      );
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [organisationId, rows, mapping, fileIncomeYear]);

  const setColumn = (field: IrdImportColumn, heading: string) =>
    setMapping((current) =>
      withSuggestions(
        {
          ...current,
          columns: { ...current.columns, [field]: heading || undefined },
        },
        rows,
      ),
    );
  const chooseSaved = (id: string) => {
    setSavedId(id);
    const saved = read.mappings.find((entry) => entry.id === id);
    if (saved) {
      setMapping(withSuggestions({ ...saved.mapping, headerRow: mapping.headerRow }, rows));
      setSaveAs(saved.name);
    }
  };

  async function submit() {
    setBusy(true);
    setStatus(null);
    try {
      await api("/api/income-tax/imports", {
        method: "POST",
        body: {
          organisationId,
          idempotencyKey: key,
          fileName: read.file.fileName,
          fileBase64,
          source,
          mapping,
          fileIncomeYear: fileIncomeYear || null,
          supportingDocumentId: supportingDocumentId || null,
          saveMappingAs: saveAs.trim() || null,
        },
      });
      onImported();
    } catch (error) {
      setStatus({ tone: "error", text: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  const ready = preview && preview.mappingProblems.length === 0 && preview.counts.withProblems === 0 && preview.counts.toReview > 0;
  return (
    <div className={ui.reportBlock} style={BLOCK}>
      <h3>Match the columns: {read.file.fileName}</h3>
      <p className={ui.muted}>IRD doesn&apos;t publish the columns of its downloads, so tell Tohyee which column is which. Every row is shown below before anything is saved.</p>
      <div className={ui.inlineForm}>
        {read.mappings.length > 0 ? (
          <Field label="Saved mapping" hint={suggested ? `"${suggested.name}" matches this file's headings.` : undefined}>
            <select value={savedId} onChange={(event) => chooseSaved(event.target.value)}>
              <option value="">None</option>
              {read.mappings.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
        <Field label="Headings are on row">
          <select
            value={mapping.headerRow}
            onChange={(event) =>
              setMapping((current) => ({
                ...emptyMapping(Number(event.target.value)),
                dateOrder: current.dateOrder,
              }))
            }
          >
            {rows.slice(0, 20).map((row, index) => (
              <option key={index} value={index}>
                {index + 1}:{" "}
                {row
                  .filter((cell) => cell.trim())
                  .join(", ")
                  .slice(0, 60) || "(blank)"}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Dates are written">
          <select
            value={mapping.dateOrder}
            onChange={(event) =>
              setMapping((current) => ({
                ...current,
                dateOrder: event.target.value as DateOrder,
              }))
            }
          >
            {DATE_ORDERS.map((order) => (
              <option key={order} value={order}>
                {DATE_ORDER_LABELS[order]}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className={ui.inlineForm}>
        {IRD_IMPORT_COLUMNS.map((field) => (
          <Field key={field} label={IRD_IMPORT_COLUMN_LABELS[field].label} hint={IRD_IMPORT_COLUMN_LABELS[field].hint}>
            <select value={mapping.columns[field] ?? ""} onChange={(event) => setColumn(field, event.target.value)}>
              <option value="">Not in this file</option>
              {headings.map((heading) => (
                <option key={heading} value={heading}>
                  {heading}
                </option>
              ))}
            </select>
          </Field>
        ))}
      </div>
      <div className={ui.inlineForm}>
        {mapping.columns.amount ? (
          <Field label="The Amount column">
            <select
              value={mapping.amountSign ?? ""}
              onChange={(event) =>
                setMapping((current) => ({
                  ...current,
                  amountSign: (event.target.value || undefined) as AmountSign | undefined,
                }))
              }
            >
              <option value="">Choose…</option>
              {AMOUNT_SIGNS.map((sign) => (
                <option key={sign} value={sign}>
                  {AMOUNT_SIGN_LABELS[sign]}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
        {!mapping.columns.type ? (
          <Field label="Every row is">
            <select
              value={mapping.defaultKind ?? ""}
              onChange={(event) =>
                setMapping((current) => ({
                  ...current,
                  defaultKind: (event.target.value || undefined) as IrdRowKind | undefined,
                }))
              }
            >
              <option value="">Choose…</option>
              {IRD_ROW_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {IRD_ROW_KIND_LABELS[kind]}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
        {!mapping.columns.period ? (
          <Field label="Income year of the whole file">
            <select value={fileIncomeYear} onChange={(event) => setFileIncomeYear(event.target.value)}>
              <option value="">Choose…</option>
              {years.map((year) => (
                <option key={year} value={year}>
                  {year}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
      </div>
      {typeValues.length > 0 ? (
        <>
          <p className={ui.muted}>What each value in the {mapping.columns.type} column is. Suggestions come from the words; check them.</p>
          <div className={ui.tableWrap}>
            <table className={`${ui.table} ${ui.stackOnPhone}`}>
              <thead>
                <tr>
                  <th>{mapping.columns.type}</th>
                  <th className={ui.num}>Rows</th>
                  <th>Is</th>
                </tr>
              </thead>
              <tbody>
                {typeValues.map((value) => (
                  <tr key={value.key}>
                    <td data-label={mapping.columns.type}>{value.text || <span className={ui.muted}>(blank)</span>}</td>
                    <td data-label="Rows" className={ui.num}>
                      {value.count}
                    </td>
                    <td data-label="Is">
                      <select
                        aria-label={`What "${value.text || "(blank)"}" rows are`}
                        value={mapping.kindValues[value.key] ?? ""}
                        onChange={(event) =>
                          setMapping((current) => ({
                            ...current,
                            kindValues: {
                              ...current.kindValues,
                              [value.key]: event.target.value as IrdRowKind | "skip",
                            },
                          }))
                        }
                      >
                        <option value="" disabled>
                          Choose…
                        </option>
                        {IRD_ROW_KINDS.map((kind) => (
                          <option key={kind} value={kind}>
                            {IRD_ROW_KIND_LABELS[kind]}
                          </option>
                        ))}
                        <option value="skip">Leave these rows out</option>
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
      {appliesValues.length > 0 ? (
        <>
          <p className={ui.muted}>Which instalment each value in the {mapping.columns.appliesTo} column means. A payment is allocated only when the file says.</p>
          <div className={ui.tableWrap}>
            <table className={`${ui.table} ${ui.stackOnPhone}`}>
              <thead>
                <tr>
                  <th>{mapping.columns.appliesTo}</th>
                  <th className={ui.num}>Rows</th>
                  <th>Means</th>
                </tr>
              </thead>
              <tbody>
                {appliesValues.map((value) => (
                  <tr key={value.key}>
                    <td data-label={mapping.columns.appliesTo}>{value.text || <span className={ui.muted}>(blank)</span>}</td>
                    <td data-label="Rows" className={ui.num}>
                      {value.count}
                    </td>
                    <td data-label="Means">
                      <select
                        aria-label={`What "${value.text || "(blank)"}" means`}
                        value={mapping.appliesToValues[value.key] ?? "none"}
                        disabled={value.key === ""}
                        onChange={(event) =>
                          setMapping((current) => ({
                            ...current,
                            appliesToValues: {
                              ...current.appliesToValues,
                              [value.key]: event.target.value as AppliesToKey | "none",
                            },
                          }))
                        }
                      >
                        <option value="none">Doesn&apos;t say</option>
                        {APPLIES_TO.map((entry) => (
                          <option key={entry} value={entry}>
                            {APPLIES_TO_LABELS[entry]}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
      {preview && preview.mappingProblems.length > 0 ? (
        <Notice tone="warning">
          <ul>
            {preview.mappingProblems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </Notice>
      ) : null}
      {preview && preview.mappingProblems.length === 0 ? (
        <>
          <p>
            {preview.counts.toReview} row
            {preview.counts.toReview === 1 ? "" : "s"} to bring in for checking
            {preview.counts.skipped ? `, ${preview.counts.skipped} left out` : ""}
            {preview.counts.withProblems ? (
              <>
                , <strong>{preview.counts.withProblems} with a problem</strong>
              </>
            ) : null}
            .
          </p>
          <div className={ui.tableWrap}>
            <table className={`${ui.table} ${ui.stackOnPhone}`}>
              <thead>
                <tr>
                  <th className={ui.num}>Row</th>
                  <th>Date</th>
                  <th>Is</th>
                  <th>Year</th>
                  <th>Instalment</th>
                  <th className={ui.num}>Amount</th>
                  <th>Check</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.slice(0, MAX_PREVIEW_ROWS).map((row) => (
                  <tr key={row.row}>
                    <td data-label="Row" className={ui.num}>
                      {row.row}
                    </td>
                    <td data-label="Date">{row.transactionOn ? formatDate(row.transactionOn) : null}</td>
                    <td data-label="Is">
                      {row.kind ? IRD_ROW_KIND_LABELS[row.kind] : null}
                      {row.description ? <span className={ui.muted}> · {row.description}</span> : null}
                    </td>
                    <td data-label="Year">{row.incomeYear}</td>
                    <td data-label="Instalment">{row.appliesTo ? APPLIES_TO_LABELS[row.appliesTo] : null}</td>
                    <td data-label="Amount" className={ui.num}>
                      {row.skipped ? null : directionAmount(row)}
                    </td>
                    <td data-label="Check">
                      {row.problems.length > 0 ? (
                        <Badge tone="red">{row.problems.join(" ")}</Badge>
                      ) : row.skipped ? (
                        <span className={ui.muted}>Left out. {row.skipped}</span>
                      ) : (
                        <Badge tone="green">OK</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {preview.rows.length > MAX_PREVIEW_ROWS ? (
            <p className={ui.muted}>
              Showing the first {MAX_PREVIEW_ROWS} rows of {preview.rows.length}; all of them are checked.
            </p>
          ) : null}
        </>
      ) : null}
      <div className={ui.inlineForm}>
        {documents.length > 0 ? (
          <Field label="Goes with this PDF" hint="Optional: the IRD document this file came with.">
            <select value={supportingDocumentId} onChange={(event) => setSupportingDocumentId(event.target.value)}>
              <option value="">None</option>
              {documents.map((document) => (
                <option key={document.id} value={document.id}>
                  {document.fileName}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
        <Field label="Save this mapping as" hint="Optional. It's chosen again for a file with the same headings.">
          <input value={saveAs} maxLength={100} onChange={(event) => setSaveAs(event.target.value)} placeholder="e.g. myIR income tax account" />
        </Field>
        <Button onClick={() => void submit()} disabled={!ready || busy}>
          Bring in {preview?.counts.toReview ?? 0} rows to check
        </Button>
      </div>
      {status ? <Notice tone={status.tone}>{status.text}</Notice> : null}
    </div>
  );
}

function RowActions({ organisationId, row, onDone }: { organisationId: string; row: IrdImportRow; onDone: () => void }) {
  const [mode, setMode] = useState<"none" | "decline" | "rit">("none");
  const [reason, setReason] = useState("");
  const [filedOn, setFiledOn] = useState(row.transactionOn);
  const [error, setError] = useState<string | null>(null);
  async function post(action: "accept" | "decline", body: Record<string, unknown>) {
    try {
      setError(null);
      await api(`/api/income-tax/imports/rows/${row.id}/${action}`, {
        method: "POST",
        body: { organisationId, ...body },
      });
      onDone();
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }
  if (row.status !== "waiting") return null;
  return (
    <>
      {mode === "decline" ? (
        <span className={ui.inlineForm}>
          <input aria-label={`Why decline row ${row.row}?`} placeholder="Why decline?" value={reason} maxLength={500} onChange={(event) => setReason(event.target.value)} />
          <Button size="small" variant="secondary" onClick={() => void post("decline", { reason })}>
            Decline
          </Button>
          <Button size="small" variant="secondary" onClick={() => setMode("none")}>
            Cancel
          </Button>
        </span>
      ) : mode === "rit" ? (
        <span className={ui.inlineForm}>
          <Field label="Return filed on">
            <DateInput value={filedOn} onChange={(event) => setFiledOn(event.target.value)} />
          </Field>
          <Button
            size="small"
            onClick={() =>
              void post("accept", {
                useAsAssessedRit: true,
                returnFiledOn: filedOn,
              })
            }
          >
            Save as the {row.incomeYear} assessed RIT
          </Button>
          <Button size="small" variant="secondary" onClick={() => setMode("none")}>
            Cancel
          </Button>
        </span>
      ) : (
        <span className={ui.rowButtons}>
          {row.sameAs ? null : (
            <Button size="small" onClick={() => void post("accept", {})}>
              {row.wouldLinkTo ? "Accept and link" : row.kind === "assessment" ? "Accept as a record" : "Accept"}
            </Button>
          )}
          {row.wouldLinkTo ? (
            <Button size="small" variant="secondary" onClick={() => void post("accept", { asNewPayment: true })}>
              Accept as a new payment
            </Button>
          ) : null}
          {row.kind === "assessment" && row.direction === "debit" && !row.sameAs ? (
            <Button size="small" variant="secondary" onClick={() => setMode("rit")}>
              Use as the assessed RIT…
            </Button>
          ) : null}
          <Button size="small" variant="secondary" onClick={() => setMode("decline")}>
            Decline…
          </Button>
        </span>
      )}
      {error ? <Notice tone="error">{error}</Notice> : null}
    </>
  );
}

function rowStatus(row: IrdImportRow, source: IrdImportSource) {
  if (row.status === "accepted") return <Badge tone="green">{source === "myir_export" ? "Accepted: IRD's figure" : "Accepted: from a spreadsheet"}</Badge>;
  if (row.status === "declined") return <Badge tone="neutral">Declined</Badge>;
  if (row.sameAs)
    return (
      <Badge tone="amber">
        Already accepted from {row.sameAs.fileName}, row {row.sameAs.row}
      </Badge>
    );
  return <Badge tone="blue">To check</Badge>;
}

function ImportCard({ organisationId, entry, onDone }: { organisationId: string; entry: IrdImport; onDone: () => void }) {
  const [chosen, setChosen] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const fileUrl = (id: string) => `/api/income-tax/documents/${id}/file?organisationId=${encodeURIComponent(organisationId)}`;
  const bulkable = entry.rows.filter((row) => row.status === "waiting" && !row.sameAs);
  async function acceptChosen() {
    try {
      setError(null);
      await api("/api/income-tax/imports/rows/accept", {
        method: "POST",
        body: { organisationId, rowIds: chosen },
      });
      setChosen([]);
      onDone();
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }
  return (
    <div className={ui.reportBlock} style={BLOCK}>
      <p style={{ overflowWrap: "anywhere" }}>
        {entry.fileRemoved ? (
          <strong>{entry.fileName}</strong>
        ) : (
          <a href={fileUrl(entry.documentId)} target="_blank" rel="noreferrer">
            <strong>{entry.fileName}</strong>
          </a>
        )}{" "}
        <Badge tone={entry.source === "myir_export" ? "blue" : "neutral"}>{entry.source === "myir_export" ? "From myIR" : "Not IRD's own file"}</Badge>
        <span className={ui.muted}>
          {" "}
          · imported {formatDate(entry.createdAt.slice(0, 10))}
          {entry.createdByEmail ? ` by ${entry.createdByEmail}` : ""} · {entry.counts.waiting} to check, {entry.counts.accepted} accepted, {entry.counts.declined} declined
        </span>
        {entry.supportingDocument ? (
          <>
            {" "}
            · goes with{" "}
            {entry.supportingDocument.removed ? (
              entry.supportingDocument.fileName
            ) : (
              <a href={fileUrl(entry.supportingDocument.id)} target="_blank" rel="noreferrer">
                {entry.supportingDocument.fileName}
              </a>
            )}
          </>
        ) : null}
        {entry.fileRemoved ? <span className={ui.muted}> · the file was removed; its rows are kept</span> : null}
      </p>
      <div className={ui.tableWrap}>
        <table className={`${ui.table} ${ui.stackOnPhone}`}>
          <thead>
            <tr>
              <th aria-label="Choose rows" />
              <th className={ui.num}>Row</th>
              <th>Date</th>
              <th>What</th>
              <th>Year</th>
              <th className={ui.num}>Amount</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {entry.rows.map((row) => (
              <tr key={row.id}>
                <td data-label="">
                  {bulkable.includes(row) ? (
                    <input
                      type="checkbox"
                      aria-label={`Choose row ${row.row}`}
                      checked={chosen.includes(row.id)}
                      onChange={(event) => setChosen((current) => (event.target.checked ? [...current, row.id] : current.filter((id) => id !== row.id)))}
                    />
                  ) : null}
                </td>
                <td data-label="Row" className={ui.num}>
                  {row.row}
                </td>
                <td data-label="Date">
                  {formatDate(row.transactionOn)}
                  {row.effectiveOn ? <span className={ui.muted}> (effective {formatDate(row.effectiveOn)})</span> : null}
                </td>
                <td data-label="What">
                  {IRD_ROW_KIND_LABELS[row.kind]}
                  {row.appliesTo ? (
                    <span> · {APPLIES_TO_LABELS[row.appliesTo]}</span>
                  ) : row.kind === "payment" && row.direction === "credit" ? (
                    <span className={ui.muted}> · instalment not stated</span>
                  ) : null}
                  {row.description ? <span className={ui.muted}> · {row.description}</span> : null}
                  {row.wouldLinkTo ? (
                    <div className={ui.muted}>
                      Will link to the payment of <Money value={row.wouldLinkTo.amount} /> on {formatDate(row.wouldLinkTo.paidOn)} already in Tohyee.
                    </div>
                  ) : null}
                  {row.outcome ? <div className={ui.muted}>{row.outcome}</div> : null}
                  {row.declineReason ? <div className={ui.muted}>Declined: {row.declineReason}</div> : null}
                </td>
                <td data-label="Year">{row.incomeYear}</td>
                <td data-label="Amount" className={ui.num}>
                  {directionAmount(row)}
                </td>
                <td data-label="Status">{rowStatus(row, entry.source)}</td>
                <td data-label="">
                  <RowActions organisationId={organisationId} row={row} onDone={onDone} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {bulkable.length > 1 ? (
        <div className={ui.rowButtons} style={{ flexWrap: "wrap", whiteSpace: "normal", gap: 8, alignItems: "center" }}>
          <span className={ui.muted}>Tick only rows you&apos;ve checked against the file.</span>
          <Button size="small" variant="secondary" onClick={() => setChosen(chosen.length === bulkable.length ? [] : bulkable.map((row) => row.id))}>
            {chosen.length === bulkable.length ? "Choose none" : "Choose all to check"}
          </Button>
          <Button size="small" disabled={chosen.length === 0} onClick={() => void acceptChosen()}>
            Accept {chosen.length} checked
          </Button>
        </div>
      ) : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
    </div>
  );
}

function YearFiguresFromImports({ figures }: { figures: ImportedFigures }) {
  if (figures.byKind.length === 0) return <p className={ui.muted}>Nothing accepted from imported files for the {figures.incomeYear} income year yet.</p>;
  return (
    <>
      <p className={ui.muted}>
        Accepted rows for the {figures.incomeYear} income year: {figures.fromIrd} from IRD&apos;s own files
        {figures.fromOther ? `, ${figures.fromOther} from other spreadsheets (not IRD's figures)` : ""}.
      </p>
      <div className={ui.tableWrap}>
        <table className={`${ui.table} ${ui.stackOnPhone}`}>
          <thead>
            <tr>
              <th>Kind</th>
              <th className={ui.num}>Owed (debits)</th>
              <th className={ui.num}>Paid or credited</th>
              <th className={ui.num}>Net owed</th>
            </tr>
          </thead>
          <tbody>
            {figures.byKind.map((entry) => (
              <tr key={entry.kind}>
                <td data-label="Kind">{IRD_ROW_KIND_LABELS[entry.kind]}</td>
                <td data-label="Owed (debits)" className={ui.num}>
                  <Money value={entry.debits} />
                </td>
                <td data-label="Paid or credited" className={ui.num}>
                  <Money value={entry.credits} />
                </td>
                <td data-label="Net owed" className={ui.num}>
                  <Money value={entry.net} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** The income tax workspace's import panel (ITX-IMP1 to ITX-IMP12). Owners and admins. */
export function IrdImports({ organisationId, incomeYear, years, onChanged }: { organisationId: string; incomeYear: number; years: number[]; onChanged: () => void }) {
  const loaded = useApiData<Loaded>("/api/income-tax/imports", {
    organisationId,
    incomeYear,
  });
  const [file, setFile] = useState<File | null>(null);
  const [source, setSource] = useState<IrdImportSource>("myir_export");
  const [read, setRead] = useState<{
    result: ReadResult;
    base64: string;
  } | null>(null);
  const [status, setStatus] = useState<Status>(null);
  const [busy, setBusy] = useState(false);
  const refresh = () => {
    loaded.reload();
    onChanged();
  };
  async function readFile() {
    if (!file) return;
    if (file.size > MAX_BYTES) {
      setStatus({
        tone: "error",
        text: `${file.name} is more than 10 MB. Split it into smaller files.`,
      });
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      const base64 = await readFileAsBase64(file);
      const result = await api<ReadResult>("/api/income-tax/imports/read", {
        method: "POST",
        body: { organisationId, fileName: file.name, fileBase64: base64 },
      });
      setRead({ result, base64 });
    } catch (error) {
      setStatus({ tone: "error", text: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  }
  async function deleteMapping(mapping: SavedIrdMapping) {
    try {
      await api(`/api/income-tax/imports/mappings/${mapping.id}`, {
        method: "DELETE",
        query: { organisationId },
      });
      loaded.reload();
    } catch (error) {
      setStatus({ tone: "error", text: errorMessage(error) });
    }
  }
  const data = loaded.data;
  const waiting = data?.imports.reduce((total, entry) => total + entry.counts.waiting, 0) ?? 0;
  return (
    <Card
      title="Import IRD account files"
      description="Bring in a CSV or Excel file of an IRD account's transactions: payments, assessments, credits, interest and penalties. You match its columns, check every row, and accept or decline each one. Nothing counts until you accept it, and nothing is sent to IRD."
    >
      {loaded.error ? <Notice tone="error">{loaded.error}</Notice> : null}
      {data?.figures ? <YearFiguresFromImports figures={data.figures} /> : null}
      {read ? (
        <>
          <Mapper
            key={read.result.file.fileName + read.base64.length}
            organisationId={organisationId}
            read={read.result}
            source={source}
            years={years}
            documents={data?.documents ?? []}
            fileBase64={read.base64}
            onImported={() => {
              setRead(null);
              setFile(null);
              setStatus({
                tone: "success",
                text: "Imported. Check the rows below and accept or decline each one.",
              });
              refresh();
            }}
          />
          <Button variant="secondary" size="small" onClick={() => setRead(null)}>
            Choose another file
          </Button>
        </>
      ) : (
        <form
          className={ui.inlineForm}
          onSubmit={(event) => {
            event.preventDefault();
            void readFile();
          }}
        >
          <Field label="CSV or Excel file" hint="Up to 10 MB. For PDFs, use IRD documents.">
            <input type="file" accept=".csv,.txt,.xlsx" onChange={(event) => setFile(event.target.files?.[0] ?? null)} required />
          </Field>
          <Field label="Where it's from" hint="Only a file downloaded from myIR can confirm a figure as IRD's.">
            <select value={source} onChange={(event) => setSource(event.target.value as IrdImportSource)}>
              {IRD_IMPORT_SOURCES.map((entry) => (
                <option key={entry} value={entry}>
                  {IRD_IMPORT_SOURCE_LABELS[entry]}
                </option>
              ))}
            </select>
          </Field>
          <Button type="submit" variant="secondary" disabled={!file || busy}>
            Read the file
          </Button>
        </form>
      )}
      {status ? <Notice tone={status.tone}>{status.text}</Notice> : null}
      {!data ? (
        <p className={ui.muted}>Loading…</p>
      ) : data.imports.length === 0 ? (
        <Empty>No IRD files imported yet.</Empty>
      ) : (
        <>
          <h3>
            Imported files
            {waiting ? ` (${waiting} row${waiting === 1 ? "" : "s"} to check)` : ""}
          </h3>
          {data.imports.map((entry) => (
            <ImportCard key={entry.id} organisationId={organisationId} entry={entry} onDone={refresh} />
          ))}
        </>
      )}
      {data && data.mappings.length > 0 ? (
        <details>
          <summary>Saved mappings ({data.mappings.length})</summary>
          <ul>
            {data.mappings.map((mapping) => (
              <li key={mapping.id}>
                {mapping.name} <span className={ui.muted}>· {mapping.headings.join(", ").slice(0, 80)}</span>{" "}
                <button type="button" className={ui.linkButton} onClick={() => void deleteMapping(mapping)}>
                  Delete
                </button>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </Card>
  );
}
