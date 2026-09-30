"use client";

import { useMemo, useState } from "react";
import { readFileAsBase64 } from "@/components/bank/common";
import { Money } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Empty, Field, Notice, Stat, ui } from "@/components/ui";
import type { CustomFieldSetup } from "@/lib/custom-fields/values";
import {
  applyMapping,
  autoMap,
  IMPORT_FIELDS,
  IMPORT_KIND_LABELS,
  IMPORT_PRESET_LABELS,
  IMPORT_PRESETS,
  type ImportField,
  type ImportKind,
  type ImportMapping,
  type ImportOptions,
  type ImportPreset,
  missingRequired,
} from "@/lib/import/fields";
import type { ConversionResult, ConversionStatus } from "@/lib/import/conversion";
import type { ImportFile } from "@/lib/import/read";
import type { ImportResult, RowProblem } from "@/lib/import/service";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import { formatDate } from "@/lib/format";

/**
 * Import and export (examples IM1-IM16): a step-by-step wizard for bringing
 * an organisation's existing books into Tohyee. Each step reads a CSV or
 * Excel file, maps its columns (remembered per organisation), checks every
 * row and then imports it all in one go, or nothing.
 */

const MAX_BYTES = 10 * 1024 * 1024;
const ACCEPT = ".csv,.txt,.xlsx";

const STEPS = [
  { key: "accounts", label: "1 Chart of accounts" },
  { key: "contacts", label: "2 Contacts" },
  { key: "items", label: "3 Products and services" },
  { key: "balances", label: "4 Opening balances" },
  { key: "documents", label: "5 Open invoices and bills" },
  { key: "check", label: "6 Final check" },
] as const;
type StepKey = (typeof STEPS)[number]["key"];

type Loaded = {
  file: ImportFile;
  preset: ImportPreset;
  columns: Record<string, string[]>;
};

function customFieldsFor(setup: CustomFieldSetup | null): ImportField[] {
  if (!setup?.advancedFeatures) return [];
  return setup.fields
    .filter((field) => field.record === "contact" && field.isActive)
    .map((field) => ({ key: `custom:${field.id}`, label: `${field.label} (custom field)`, aliases: [field.label] }));
}

/** Choosing a file, the preset, and which column goes into each field. */
function FilePicker({
  organisationId,
  kind,
  loaded,
  onLoaded,
  extraFields = [],
  optional = false,
}: {
  organisationId: string;
  kind: ImportKind;
  loaded: Loaded | null;
  onLoaded: (loaded: Loaded | null) => void;
  extraFields?: ImportField[];
  optional?: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [preset, setPreset] = useState<ImportPreset>(loaded?.preset ?? "other_system");
  const fields = [...IMPORT_FIELDS[kind], ...extraFields];

  async function choose(file: File | undefined) {
    setError(null);
    if (!file) return;
    if (file.size > MAX_BYTES) {
      setError("The file is larger than 10 MB. Split it into smaller files.");
      return;
    }
    setBusy(true);
    try {
      const response = await api<{ file: ImportFile; mapping: ImportMapping | null }>("/api/import/read", {
        method: "POST",
        body: { organisationId, kind, fileName: file.name, fileBase64: await readFileAsBase64(file) },
      });
      const saved = response.mapping;
      // The saved mapping is used when every column it names is in this file; otherwise columns are matched from the headings.
      const savedFits =
        saved && Object.values(saved.columns).every((names) => names.every((name) => response.file.headings.includes(name))) && Object.keys(saved.columns).length > 0;
      const usePreset = savedFits ? saved.preset : preset;
      setPreset(usePreset);
      onLoaded({ file: response.file, preset: usePreset, columns: savedFits ? saved.columns : autoMap(kind, response.file.headings, usePreset, extraFields) });
    } catch (caught) {
      setError(errorMessage(caught));
      onLoaded(null);
    } finally {
      setBusy(false);
    }
  }

  function setColumns(field: ImportField, names: string[]) {
    if (!loaded) return;
    const columns = { ...loaded.columns };
    if (names.length > 0) columns[field.key] = names;
    else delete columns[field.key];
    onLoaded({ ...loaded, columns });
  }

  const missing = loaded ? missingRequired(kind, loaded.columns) : [];
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div className={ui.grid2}>
        <Field label="The file comes from">
          <select
            value={preset}
            onChange={(event) => {
              const next = event.target.value as ImportPreset;
              setPreset(next);
              if (loaded) onLoaded({ ...loaded, preset: next, columns: autoMap(kind, loaded.file.headings, next, extraFields) });
            }}
          >
            {IMPORT_PRESETS.map((entry) => (
              <option key={entry} value={entry}>
                {IMPORT_PRESET_LABELS[entry]}
              </option>
            ))}
          </select>
        </Field>
        <Field label={`${IMPORT_KIND_LABELS[kind]} file${optional ? " (if any)" : ""}`} hint="CSV or Excel (.xlsx), up to 10 MB.">
          <input type="file" accept={ACCEPT} disabled={busy} onChange={(event) => void choose(event.target.files?.[0])} />
        </Field>
      </div>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {loaded ? (
        <>
          <p className={ui.muted}>
            {loaded.file.fileName}: headings on row {loaded.file.headerRow + 1}, {Math.max(0, loaded.file.rows.length - loaded.file.headerRow - 1)} rows after them.
            Match each field to a column; the matches are remembered for next time.
          </p>
          <div className={ui.grid3}>
            {fields.map((field) =>
              field.multi ? (
                <div key={field.key} className={ui.field}>
                  <span className={ui.fieldLabel}>{field.label}</span>
                  <details>
                    <summary>{loaded.columns[field.key]?.length ? loaded.columns[field.key].join(" + ") : "Not in this file"}</summary>
                    <div style={{ display: "grid", gap: 4, marginTop: 6, maxHeight: 220, overflowY: "auto" }}>
                      {loaded.file.headings.map((heading) => {
                        const chosen = loaded.columns[field.key] ?? [];
                        return (
                          <label key={heading} className={ui.checkbox}>
                            <input
                              type="checkbox"
                              checked={chosen.includes(heading)}
                              onChange={(event) =>
                                setColumns(
                                  field,
                                  event.target.checked
                                    ? loaded.file.headings.filter((name) => name === heading || chosen.includes(name))
                                    : chosen.filter((name) => name !== heading),
                                )
                              }
                            />
                            {heading}
                          </label>
                        );
                      })}
                    </div>
                  </details>
                  <span className={ui.fieldHint}>One or more columns, joined one per line.</span>
                </div>
              ) : (
                <Field key={field.key} label={`${field.label}${field.required ? " *" : ""}`} hint={field.hint}>
                  <select value={loaded.columns[field.key]?.[0] ?? ""} onChange={(event) => setColumns(field, event.target.value ? [event.target.value] : [])}>
                    <option value="">Not in this file</option>
                    {loaded.file.headings.map((heading) => (
                      <option key={heading} value={heading}>
                        {heading}
                      </option>
                    ))}
                  </select>
                </Field>
              ),
            )}
          </div>
          {missing.length > 0 ? <Notice tone="warning">Choose a column for {missing.map((field) => field.label).join(", ")}.</Notice> : null}
        </>
      ) : null}
    </div>
  );
}

function recordsOf(loaded: Loaded | null) {
  return loaded ? applyMapping(loaded.file.rows, loaded.file.headerRow, loaded.columns) : [];
}

function mappingOf(loaded: Loaded, options: ImportOptions = {}): ImportMapping {
  return { preset: loaded.preset, columns: loaded.columns, options };
}

function Problems({ problems, title }: { problems: RowProblem[]; title: string }) {
  if (problems.length === 0) return null;
  return (
    <Notice tone="error">
      {title}
      <ul style={{ margin: "6px 0 0 18px" }}>
        {problems.slice(0, 50).map((problem, index) => (
          <li key={`${problem.kind ?? ""}-${problem.row}-${index}`}>
            {problem.kind ? `${IMPORT_KIND_LABELS[problem.kind]}, ` : ""}
            {problem.row > 0 ? `row ${problem.row}: ` : ""}
            {problem.message}
          </li>
        ))}
      </ul>
      {problems.length > 50 ? `…and ${problems.length - 50} more.` : null}
    </Notice>
  );
}

const ACTION_LABELS = { create: "Add", update: "Update", unchanged: "No change" } as const;
const ACTION_TONES = { create: "green", update: "blue", unchanged: "neutral" } as const;

/** Steps 1-3: accounts, contacts, products and services. */
function MasterStep({ organisationId, kind }: { organisationId: string; kind: "accounts" | "contacts" | "items" }) {
  const custom = useApiData<CustomFieldSetup>(kind === "contacts" ? "/api/custom-fields" : null, { organisationId });
  const extraFields = useMemo(() => customFieldsFor(custom.data), [custom.data]);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [defaultRole, setDefaultRole] = useState<NonNullable<ImportOptions["defaultRole"]>>("both");
  const [dateOrder, setDateOrder] = useState<NonNullable<ImportOptions["dateOrder"]>>("dmy");
  const [result, setResult] = useState<ImportResult | null>(null);
  const [checkedKey, setCheckedKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const records = useMemo(() => recordsOf(loaded), [loaded]);
  const options: ImportOptions = kind === "contacts" ? { defaultRole, dateOrder } : {};
  const requestKey = JSON.stringify({ records, options });

  async function run(commit: boolean) {
    if (!loaded) return;
    setBusy(true);
    setError(null);
    try {
      const response = await api<{ result: ImportResult }>("/api/import/records", {
        method: "POST",
        body: { organisationId, kind, records, options, idempotencyKey: newIdempotencyKey("import"), commit, mapping: mappingOf(loaded, options) },
      });
      setResult(response.result);
      setCheckedKey(commit ? null : requestKey);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  const checkedClean = result !== null && !result.committed && result.problems.length === 0 && checkedKey === requestKey;
  return (
    <Card
      title={IMPORT_KIND_LABELS[kind]}
      description={
        kind === "accounts"
          ? "Matched by code: existing accounts are updated, new ones added, nothing deleted. Tohyee's own accounts (accounts receivable, GST…) keep their type; one named like them in the file takes its code."
          : kind === "contacts"
            ? "Matched by name (ignoring case): existing contacts are updated from the columns that have something in them, new ones added."
            : "Matched by code. Items with an inventory account become stock items; their quantities come with the opening balances."
      }
      actions={
        <a className={`${ui.button} ${ui.secondary} ${ui.small}`} href={`/api/import/export?organisationId=${encodeURIComponent(organisationId)}&kind=${kind}`}>
          Download as CSV
        </a>
      }
    >
      <div style={{ display: "grid", gap: 14 }}>
        <FilePicker
          organisationId={organisationId}
          kind={kind}
          loaded={loaded}
          extraFields={extraFields}
          onLoaded={(next) => {
            setLoaded(next);
            setResult(null);
          }}
        />
        {kind === "contacts" && loaded ? (
          <div className={ui.grid2}>
            <Field label="New contacts without customer or supplier columns are" hint="Another system's contact export doesn't say which they are.">
              <select value={defaultRole} onChange={(event) => setDefaultRole(event.target.value as typeof defaultRole)}>
                <option value="both">Customers and suppliers</option>
                <option value="customer">Customers</option>
                <option value="supplier">Suppliers</option>
                <option value="neither">Neither (just contacts)</option>
              </select>
            </Field>
            <Field label="Dates in custom fields are written">
              <select value={dateOrder} onChange={(event) => setDateOrder(event.target.value as typeof dateOrder)}>
                <option value="dmy">Day first (31/03/2026)</option>
                <option value="mdy">Month first (03/31/2026)</option>
                <option value="ymd">Year first (2026-03-31)</option>
              </select>
            </Field>
          </div>
        ) : null}
        {error ? <Notice tone="error">{error}</Notice> : null}
        {loaded ? (
          <div className={ui.actions} style={{ justifyContent: "flex-start" }}>
            <Button variant="secondary" disabled={busy || records.length === 0 || missingRequired(kind, loaded.columns).length > 0} onClick={() => void run(false)}>
              Check {records.length} {records.length === 1 ? "row" : "rows"}
            </Button>
            <Button disabled={busy || !checkedClean} onClick={() => void run(true)}>
              Import
            </Button>
          </div>
        ) : null}
        {result ? (
          <>
            {result.committed ? (
              <Notice tone="success">
                Imported: {result.counts.create} added, {result.counts.update} updated, {result.counts.unchanged} unchanged.
              </Notice>
            ) : result.problems.length === 0 ? (
              <Notice tone="info">
                Every row is fine: {result.counts.create} to add, {result.counts.update} to update, {result.counts.unchanged} unchanged. Nothing is saved until you import.
              </Notice>
            ) : null}
            <Problems problems={result.problems} title={`${result.problems.length} ${result.problems.length === 1 ? "row is" : "rows are"} refused, so nothing in this file can be imported:`} />
            {result.outcomes.length > 0 ? (
              <div className={ui.tableWrap}>
                <table className={ui.table}>
                  <thead>
                    <tr>
                      <th>Row</th>
                      <th>{kind === "contacts" ? "Contact" : "Code and name"}</th>
                      <th>What happens</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.outcomes.slice(0, 200).map((outcome) => (
                      <tr key={outcome.row}>
                        <td>{outcome.row}</td>
                        <td>{outcome.label}</td>
                        <td>
                          <Badge tone={ACTION_TONES[outcome.action]}>{ACTION_LABELS[outcome.action]}</Badge>
                          {outcome.detail ? <span className={ui.muted}> {outcome.detail}</span> : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </Card>
  );
}

type ConversionFiles = { trial_balance: Loaded | null; stock: Loaded | null; open_invoices: Loaded | null; open_bills: Loaded | null };

/** Steps 4 and 5: the trial balance and stock, then open invoices and bills, checked and posted together. */
function ConversionStep({
  organisationId,
  step,
  files,
  setFiles,
  conversionDate,
  setConversionDate,
  onPosted,
  done,
}: {
  organisationId: string;
  step: "balances" | "documents";
  files: ConversionFiles;
  setFiles: (files: ConversionFiles) => void;
  conversionDate: string;
  setConversionDate: (value: string) => void;
  onPosted: () => void;
  done: ConversionStatus["conversion"];
}) {
  const [dateOrder, setDateOrder] = useState<NonNullable<ImportOptions["dateOrder"]>>("dmy");
  const [result, setResult] = useState<ConversionResult | null>(null);
  const [checkedKey, setCheckedKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const body = useMemo(
    () => ({
      conversionDate,
      options: { dateOrder },
      trialBalance: recordsOf(files.trial_balance),
      stock: recordsOf(files.stock),
      openInvoices: recordsOf(files.open_invoices),
      openBills: recordsOf(files.open_bills),
    }),
    [conversionDate, dateOrder, files],
  );
  const requestKey = JSON.stringify(body);

  if (done) {
    return (
      <Card title="Opening balances">
        <Notice tone="success">
          Opening balances were brought in as at {formatDate(done.conversionDate)}: the trial balance, {done.invoiceCount} open invoices, {done.billCount} open bills and{" "}
          {done.stockCount} stock lines. They can&apos;t be imported again; correct them with a journal. See the final check.
        </Notice>
      </Card>
    );
  }

  async function run(commit: boolean) {
    setBusy(true);
    setError(null);
    try {
      const mappings = Object.fromEntries(
        Object.entries(files)
          .filter((entry): entry is [string, Loaded] => entry[1] !== null)
          .map(([kind, loaded]) => [kind, mappingOf(loaded, { dateOrder })]),
      );
      const response = await api<{ result: ConversionResult }>("/api/import/conversion", {
        method: "POST",
        body: { organisationId, ...body, idempotencyKey: newIdempotencyKey("conversion"), commit, mappings },
      });
      setResult(response.result);
      setCheckedKey(commit ? null : requestKey);
      if (response.result.committed) onPosted();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  const set = (kind: keyof ConversionFiles) => (loaded: Loaded | null) => {
    setFiles({ ...files, [kind]: loaded });
    setResult(null);
  };
  const plan = result?.plan;
  const checkedClean = result !== null && result.ok && !result.committed && checkedKey === requestKey;
  const ready = files.trial_balance !== null && missingRequired("trial_balance", files.trial_balance.columns).length === 0 && conversionDate !== "";
  return (
    <div style={{ display: "grid", gap: 16 }}>
      {step === "balances" ? (
        <>
          <Card
            title="Conversion date and trial balance"
            description="The trial balance from the old system as at the conversion date (usually the end of a GST period or financial year). Accounts receivable, accounts payable and inventory are made up by the open invoices, bills and stock, so those must add up to them exactly."
          >
            <div style={{ display: "grid", gap: 14 }}>
              <div className={ui.grid2}>
                <Field label="Conversion date" hint="Everything is posted as at this date; nothing may be posted on or before it yet.">
                  <input type="date" value={conversionDate} onChange={(event) => setConversionDate(event.target.value)} />
                </Field>
                <Field label="Dates in the files are written">
                  <select value={dateOrder} onChange={(event) => setDateOrder(event.target.value as typeof dateOrder)}>
                    <option value="dmy">Day first (31/03/2026)</option>
                    <option value="mdy">Month first (03/31/2026)</option>
                    <option value="ymd">Year first (2026-03-31)</option>
                  </select>
                </Field>
              </div>
              <FilePicker organisationId={organisationId} kind="trial_balance" loaded={files.trial_balance} onLoaded={set("trial_balance")} />
            </div>
          </Card>
          <Card title="Stock on hand" description="Quantity and value per stock item (and location, if stock is kept by location). Leave it out if there's no stock.">
            <FilePicker organisationId={organisationId} kind="stock" loaded={files.stock} onLoaded={set("stock")} optional />
          </Card>
          <Notice tone="info">Next, the open invoices and bills. Everything is checked and posted together on the next step.</Notice>
        </>
      ) : (
        <>
          <Card title="Open invoices" description="One row per invoice still owed at the conversion date: number, customer, date, due date and the amount still owed including GST.">
            <FilePicker organisationId={organisationId} kind="open_invoices" loaded={files.open_invoices} onLoaded={set("open_invoices")} optional />
          </Card>
          <Card title="Open bills" description="One row per bill still owed at the conversion date.">
            <FilePicker organisationId={organisationId} kind="open_bills" loaded={files.open_bills} onLoaded={set("open_bills")} optional />
          </Card>
          <Card title="Check and post the opening balances">
            <div style={{ display: "grid", gap: 12 }}>
              {!ready ? <Notice tone="warning">Choose the conversion date and the trial balance file first (step 4).</Notice> : null}
              {error ? <Notice tone="error">{error}</Notice> : null}
              <div className={ui.actions} style={{ justifyContent: "flex-start" }}>
                <Button variant="secondary" disabled={busy || !ready} onClick={() => void run(false)}>
                  Check everything
                </Button>
                <Button disabled={busy || !checkedClean} onClick={() => void run(true)}>
                  Post opening balances
                </Button>
              </div>
              {result?.committed ? <Notice tone="success">Posted. Go to the final check.</Notice> : null}
              {result && result.ok && !result.committed ? <Notice tone="info">Everything checks out. Nothing is posted until you post it, and it can only be posted once.</Notice> : null}
              {result ? <Problems problems={result.problems} title="These need fixing first, so nothing can be posted:" /> : null}
              {plan ? (
                <>
                  <div className={ui.statRow}>
                    <Stat label="Debits" value={<Money value={plan.totalDebit} />} />
                    <Stat label="Credits" value={<Money value={plan.totalCredit} />} />
                    <Stat label="Open invoices" value={plan.invoices.length} />
                    <Stat label="Open bills" value={plan.bills.length} />
                    <Stat label="Stock lines" value={plan.stock.length} />
                  </div>
                  {plan.ties.length > 0 ? (
                    <div className={ui.tableWrap}>
                      <table className={ui.table}>
                        <caption className={ui.muted} style={{ textAlign: "left" }}>
                          Balances made up by invoices, bills and stock
                        </caption>
                        <thead>
                          <tr>
                            <th>Account</th>
                            <th className={ui.num}>Trial balance</th>
                            <th className={ui.num}>Made up by</th>
                            <th className={ui.num}>Difference</th>
                          </tr>
                        </thead>
                        <tbody>
                          {plan.ties.map((tie) => (
                            <tr key={tie.accountCode}>
                              <td>
                                {tie.accountCode} {tie.label}
                              </td>
                              <td className={ui.num}>
                                <Money value={tie.trialBalance} />
                              </td>
                              <td className={ui.num}>
                                <Money value={tie.documents} />
                              </td>
                              <td className={ui.num}>{tie.difference === "0.00" ? <Badge tone="green">0.00</Badge> : <Badge tone="red">{tie.difference}</Badge>}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : null}
                  {plan.lines.length > 0 ? (
                    <div className={ui.tableWrap}>
                      <table className={ui.table}>
                        <caption className={ui.muted} style={{ textAlign: "left" }}>
                          The opening journal, dated {formatDate(plan.conversionDate)}
                        </caption>
                        <thead>
                          <tr>
                            <th>Row</th>
                            <th>Account</th>
                            <th>Posted to</th>
                            <th className={ui.num}>Debit</th>
                            <th className={ui.num}>Credit</th>
                          </tr>
                        </thead>
                        <tbody>
                          {plan.lines.map((line) => (
                            <tr key={line.accountId}>
                              <td>{line.row}</td>
                              <td>
                                {line.accountCode} {line.accountName}
                              </td>
                              <td>
                                {line.postedTo}
                                {line.heldBy ? <span className={ui.muted}> (clearing; held by the {line.heldBy})</span> : null}
                              </td>
                              <td className={ui.num}>
                                <Money value={line.debit} blankZero />
                              </td>
                              <td className={ui.num}>
                                <Money value={line.credit} blankZero />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : null}
                  {plan.skipped.length > 0 ? (
                    <p className={ui.muted}>
                      Left out: {plan.skipped.map((entry) => `${IMPORT_KIND_LABELS[entry.kind ?? "trial_balance"]} row ${entry.row} (${entry.message})`).join("; ")}.
                    </p>
                  ) : null}
                </>
              ) : null}
            </div>
          </Card>
        </>
      )}
    </div>
  );
}

/** Step 6: the trial balance at the conversion date beside the imported one, then the period lock. */
function FinalCheck({ organisationId, status, reload }: { organisationId: string; status: ConversionStatus | null; reload: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!status) return <p className={ui.muted}>Loading…</p>;
  const conversion = status.conversion;
  if (!conversion) return <Empty>Opening balances haven&apos;t been brought in yet (steps 4 and 5).</Empty>;

  async function lock() {
    setBusy(true);
    setError(null);
    try {
      await api("/api/ledger/period-controls", { method: "PATCH", body: { organisationId, lockDate: conversion!.conversionDate } });
      reload();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title={`Trial balance at ${formatDate(conversion.conversionDate)}`}
      description="Tohyee's trial balance at the conversion date beside the one imported, account by account (debits positive, credits negative). Conversion clearing should be 0.00."
    >
      <div style={{ display: "grid", gap: 12 }}>
        {status.matches ? <Notice tone="success">Every account matches the imported trial balance.</Notice> : <Notice tone="error">Some accounts don&apos;t match: see the differences below.</Notice>}
        {error ? <Notice tone="error">{error}</Notice> : null}
        <div className={ui.tableWrap}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th>Account</th>
                <th className={ui.num}>Imported</th>
                <th className={ui.num}>In Tohyee</th>
                <th className={ui.num}>Difference</th>
              </tr>
            </thead>
            <tbody>
              {status.lines.map((line) => (
                <tr key={line.accountId}>
                  <td>
                    {line.code} {line.name}
                  </td>
                  <td className={ui.num}>
                    <Money value={line.imported} />
                  </td>
                  <td className={ui.num}>
                    <Money value={line.inTohyee} />
                  </td>
                  <td className={ui.num}>{line.difference === "0.00" ? <Badge tone="green">Matches</Badge> : <Badge tone="red">{line.difference}</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {status.locked ? (
          <Notice tone="success">Locked up to {formatDate(status.lockDate)}: nothing can be posted on or before the conversion date.</Notice>
        ) : (
          <div className={ui.actions} style={{ justifyContent: "flex-start" }}>
            <Button disabled={busy || !status.matches} onClick={() => void lock()}>
              Lock up to {formatDate(conversion.conversionDate)}
            </Button>
            <span className={ui.muted}>Uses the ordinary period lock (Settings and locks), so it can be opened again by an admin.</span>
          </div>
        )}
      </div>
    </Card>
  );
}

export function ImportWizard({ organisationId }: { organisationId: string }) {
  const [step, setStep] = useState<StepKey>("accounts");
  const [files, setFiles] = useState<ConversionFiles>({ trial_balance: null, stock: null, open_invoices: null, open_bills: null });
  const [conversionDate, setConversionDate] = useState("");
  const status = useApiData<{ status: ConversionStatus }>("/api/import/conversion", { organisationId });
  const done = status.data?.status.conversion ?? null;
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div className={ui.tabs} role="tablist" aria-label="Import steps">
        {STEPS.map((entry) => (
          <button
            key={entry.key}
            type="button"
            role="tab"
            aria-selected={step === entry.key}
            className={`${ui.tab} ${step === entry.key ? ui.tabActive : ""}`}
            onClick={() => setStep(entry.key)}
          >
            {entry.label}
          </button>
        ))}
      </div>
      {status.error ? <Notice tone="error">{status.error}</Notice> : null}
      {step === "accounts" || step === "contacts" || step === "items" ? (
        <MasterStep key={step} organisationId={organisationId} kind={step} />
      ) : step === "check" ? (
        <FinalCheck organisationId={organisationId} status={status.data?.status ?? null} reload={status.reload} />
      ) : (
        <ConversionStep
          organisationId={organisationId}
          step={step}
          files={files}
          setFiles={setFiles}
          conversionDate={conversionDate}
          setConversionDate={setConversionDate}
          onPosted={status.reload}
          done={done}
        />
      )}
    </div>
  );
}
