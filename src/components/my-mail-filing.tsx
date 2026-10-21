"use client";

import Link from "next/link";
import { useId, useState } from "react";
import { useConfirm } from "@/components/confirm-dialog";
import { Button, Card, Field, Notice, ui } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { PASTURE_METHOD_LABELS, PASTURE_METHODS } from "@/lib/farming/pasture-rules";
import {
  FILING_RECORD_TYPES,
  type FilingDestination,
  type FilingKind,
  type FilingOptions,
  type FilingOverview,
  type FilingPreview,
  type FilingRecordHit,
  type FilingResult,
  KIND_LABELS,
  ruleText,
} from "@/lib/private-mail/filing-types";
import { formatBytes } from "@/lib/private-mail/types";
import styles from "./my-mail.module.css";

/*
 * Filing an attachment from My mail into shared data (#250; PM20-PM29).
 * The Owner chooses where it goes, sees exactly what others will see (and
 * what stays private), and only then files it. Rules put matching
 * attachments in "To file"; each one is still the Owner's to confirm.
 */

function nzDate(value: string): string {
  return new Date(value).toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric", timeZone: "Pacific/Auckland" });
}

/** "The bills inbox" mid-sentence. */
const lowerThe = (label: string) => label.replace(/^The /, "the ");

function kindsFor(options: FilingOptions): FilingKind[] {
  const kinds: FilingKind[] = [];
  if (options.accounting) kinds.push("bills_inbox");
  if (options.farming && options.farms.length) {
    kinds.push("soil_tests", "pasture_readings");
    if (options.farms.some((farm) => farm.plans.length)) kinds.push("fertiliser_applications");
  }
  kinds.push("record");
  return kinds;
}

/** The destination's own choices (farm, plan, record, import options). */
function DestinationFields({
  organisationId,
  options,
  value,
  onChange,
  forRule = false,
}: {
  organisationId: string;
  options: FilingOptions;
  value: FilingDestination | null;
  onChange: (next: FilingDestination | null) => void;
  forRule?: boolean;
}) {
  const kinds = kindsFor(options);
  const [kind, setKind] = useState<FilingKind | "">(value?.kind ?? "");
  const [recordType, setRecordType] = useState<string>(value?.kind === "record" ? value.recordType : "bill");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<FilingRecordHit[] | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const firstFarm = options.farms[0]?.id ?? "";
  const plans = options.farms.flatMap((farm) => farm.plans.map((plan) => ({ ...plan, farm: farm.name })));
  const choose = (kind: string) => {
    if (kind === "bills_inbox") onChange({ kind });
    else if (kind === "soil_tests") onChange({ kind, farmId: firstFarm, lab: null, sampledOn: null });
    else if (kind === "pasture_readings") onChange({ kind, farmId: firstFarm, method: null });
    else if (kind === "fertiliser_applications") onChange({ kind, planId: plans[0]?.id ?? "" });
    else if (kind === "record") onChange(null);
    else onChange(null);
    setKind(kind as FilingKind | "");
  };
  const search = async () => {
    setSearchError(null);
    try {
      const result = await api<{ records: FilingRecordHit[] }>("/api/my-mail/filing/records", { method: "POST", body: { organisationId, type: recordType, query } });
      setHits(result.records);
    } catch (caught) {
      setSearchError(errorMessage(caught));
    }
  };
  return (
    <>
      <Field label="File it into">
        <select value={kind} onChange={(event) => choose(event.target.value)}>
          <option value="">Choose…</option>
          {kinds.map((entry) => (
            <option key={entry} value={entry}>
              {KIND_LABELS[entry]}
            </option>
          ))}
        </select>
      </Field>
      {(value?.kind === "soil_tests" || value?.kind === "pasture_readings") && options.farms.length > 1 ? (
        <Field label="Farm">
          <select value={value.farmId} onChange={(event) => onChange({ ...value, farmId: event.target.value })}>
            {options.farms.map((farm) => (
              <option key={farm.id} value={farm.id}>
                {farm.name}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      {value?.kind === "soil_tests" ? (
        <div className={ui.grid2}>
          <Field label="Lab (optional)">
            <input value={value.lab ?? ""} maxLength={100} onChange={(event) => onChange({ ...value, lab: event.target.value || null })} />
          </Field>
          {!forRule ? (
            <Field label="Date sampled, for rows without one (optional)">
              <input type="date" value={value.sampledOn ?? ""} onChange={(event) => onChange({ ...value, sampledOn: event.target.value || null })} />
            </Field>
          ) : null}
        </div>
      ) : null}
      {value?.kind === "pasture_readings" ? (
        <Field label="Method, for rows without one (optional)">
          <select value={value.method ?? ""} onChange={(event) => onChange({ ...value, method: event.target.value || null })}>
            <option value="">From the file</option>
            {PASTURE_METHODS.map((method) => (
              <option key={method} value={method}>
                {PASTURE_METHOD_LABELS[method]}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      {value?.kind === "fertiliser_applications" ? (
        <Field label="Fertiliser plan">
          <select value={value.planId} onChange={(event) => onChange({ ...value, planId: event.target.value })}>
            {plans.map((plan) => (
              <option key={plan.id} value={plan.id}>
                {plan.name} ({plan.farm})
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      {kind === "record" ? (
        <div className={styles.filingSearch}>
          <Field label="Kind of record">
            <select
              value={recordType}
              onChange={(event) => {
                setRecordType(event.target.value);
                setHits(null);
                onChange(null);
              }}
            >
              {FILING_RECORD_TYPES.filter((entry) => options.farming || (entry.type !== "soil_test" && entry.type !== "coop_shareholding")).map((entry) => (
                <option key={entry.type} value={entry.type}>
                  {entry.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Find it">
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void search();
                }
              }}
              placeholder="Number or name"
            />
          </Field>
          <Button variant="secondary" onClick={() => void search()}>
            Find
          </Button>
          {searchError ? <Notice tone="error">{searchError}</Notice> : null}
          {hits ? (
            hits.length ? (
              <Field label="Record">
                <select value={value?.kind === "record" ? value.recordId : ""} onChange={(event) => onChange(event.target.value ? { kind: "record", recordType, recordId: event.target.value } : null)}>
                  <option value="">Choose…</option>
                  {hits.map((hit) => (
                    <option key={hit.id} value={hit.id}>
                      {hit.label}
                    </option>
                  ))}
                </select>
              </Field>
            ) : (
              <p className={ui.muted} role="status">
                Nothing found.
              </p>
            )
          ) : null}
        </div>
      ) : null}
    </>
  );
}

/** PM20-PM25: choose where, see exactly what others will see, then file it. */
export function FilePanel({
  organisationId,
  options,
  attachment,
  initial,
  toFileId,
  onClose,
  onFiled,
}: {
  organisationId: string;
  options: FilingOptions;
  attachment: { id: string; name: string };
  initial?: FilingDestination;
  toFileId?: string;
  onClose: () => void;
  onFiled?: (result: FilingResult) => void;
}) {
  const headingId = useId();
  const [destination, setDestinationNow] = useState<FilingDestination | null>(initial ?? null);
  const [fileName, setFileNameNow] = useState(attachment.name);
  const [note, setNoteNow] = useState("");
  const [preview, setPreview] = useState<FilingPreview | null>(null);
  // Anything changed: the old preview no longer says what would be shared.
  const setDestination = (next: FilingDestination | null) => {
    setDestinationNow(next);
    setPreview(null);
  };
  const setFileName = (next: string) => {
    setFileNameNow(next);
    setPreview(null);
  };
  const setNote = (next: string) => {
    setNoteNow(next);
    setPreview(null);
  };
  const noteAllowed = destination?.kind === "bills_inbox" || destination?.kind === "record";
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<FilingResult | null>(null);
  const body = { organisationId, attachmentId: attachment.id, destination, fileName, note: noteAllowed ? note : undefined };
  const look = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ preview: FilingPreview }>("/api/my-mail/filing", { method: "POST", body: { ...body, preview: true } });
      setPreview(result.preview);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };
  const file = async () => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ filed: FilingResult }>("/api/my-mail/filing", { method: "POST", body: { ...body, confirmation: preview.confirmation, toFileId } });
      setDone(result.filed);
      onFiled?.(result.filed);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };
  if (done) {
    return (
      <div className={styles.filePanel} role="region" aria-labelledby={headingId}>
        <h4 id={headingId} className={styles.folderHeading}>
          Filed {fileName}
        </h4>
        <Notice tone="success">
          {done.summary}. {done.link ? <Link href={done.link}>Open {lowerThe(done.destinationLabel)}</Link> : null}
        </Notice>
        <p className={ui.muted}>The email itself stays private. Deleting your copy of it later doesn&apos;t delete what you filed.</p>
        <span>
          <Button size="small" variant="secondary" onClick={onClose}>
            Close
          </Button>
        </span>
      </div>
    );
  }
  return (
    <div className={styles.filePanel} role="region" aria-labelledby={headingId}>
      <h4 id={headingId} className={styles.folderHeading}>
        File {attachment.name} into shared data
      </h4>
      <p className={styles.privacy}>A copy goes where you choose. Before anything is shared you&apos;ll see exactly what others will see. The email stays private.</p>
      <DestinationFields organisationId={organisationId} options={options} value={destination} onChange={setDestination} />
      <Field label="File name others will see" hint="Change it if the attachment's own name says more than you want shared. Keep its ending.">
        <input value={fileName} maxLength={200} onChange={(event) => setFileName(event.target.value)} />
      </Field>
      {noteAllowed ? (
        <Field label="Note to share (optional)" hint="Only what you type here goes with it: nothing of the email does.">
          <textarea value={note} maxLength={1000} rows={2} onChange={(event) => setNote(event.target.value)} />
        </Field>
      ) : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      <span className={ui.actions}>
        <Button variant="secondary" disabled={busy || !destination} onClick={() => void look()}>
          Preview what others will see
        </Button>
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
      </span>
      {preview ? <PreviewView preview={preview} busy={busy} onFile={() => void file()} /> : null}
    </div>
  );
}

function PreviewView({ preview, busy, onFile }: { preview: FilingPreview; busy: boolean; onFile: () => void }) {
  return (
    <section className={styles.preview} aria-label="Preview">
      {preview.problem ? <Notice tone="error">{preview.problem}</Notice> : null}
      {preview.warnings.map((warning) => (
        <Notice key={warning} tone="warning">
          {warning}
        </Notice>
      ))}
      <h5 className={styles.previewHeading}>Others will see</h5>
      <dl className={styles.facts}>
        {preview.shared.map((field) => (
          <div key={field.label}>
            <dt>{field.label}</dt>
            <dd>{field.value}</dd>
          </div>
        ))}
      </dl>
      {preview.table ? (
        <div className={ui.tableWrap}>
          <table className={ui.table}>
            <caption className={styles.visuallyHidden}>Rows that would be added</caption>
            <thead>
              <tr>
                {preview.table.headings.map((heading) => (
                  <th key={heading} scope="col">
                    {heading}
                  </th>
                ))}
                <th scope="col">Added?</th>
              </tr>
            </thead>
            <tbody>
              {preview.table.rows.map((row) => (
                <tr key={row.cells[0]}>
                  {row.cells.map((cell, index) => (
                    <td key={index}>{cell}</td>
                  ))}
                  <td>{row.error ? `No: ${row.error}` : "Yes"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <h5 className={styles.previewHeading}>Stays private</h5>
      <ul className={styles.notShared}>
        {preview.notShared.map((entry) => (
          <li key={entry}>{entry}</li>
        ))}
      </ul>
      <span>
        <Button disabled={busy || Boolean(preview.problem)} onClick={onFile}>
          File it
        </Button>
      </span>
    </section>
  );
}

/** PM25-PM27: what's waiting from rules, the rules, and what's been filed. */
export function FilingCard({ organisationId, overview, copies, onChanged }: { organisationId: string; overview: FilingOverview; copies: Array<{ id: string; email: string }>; onChanged: () => void }) {
  const confirm = useConfirm();
  const [filing, setFiling] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dismiss = async (id: string) => {
    setError(null);
    try {
      await api(`/api/my-mail/to-file/${id}?organisationId=${encodeURIComponent(organisationId)}`, { method: "DELETE" });
      onChanged();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };
  const removeRule = async (id: string, words: string) => {
    if (!(await confirm(`Delete the rule "${words}"? What's waiting from it is taken off To file. What you filed stays filed.`, { confirmLabel: "Delete rule", danger: true }))) return;
    setError(null);
    try {
      await api(`/api/my-mail/rules/${id}?organisationId=${encodeURIComponent(organisationId)}`, { method: "DELETE" });
      onChanged();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };
  return (
    <Card
      title="Filing into shared data"
      description="Nothing from your mail is shared unless you file it. Use File… on an attachment, or a rule that puts matching attachments here for you to confirm one by one."
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      <h3 className={styles.filingHeading}>To file{overview.toFile.length ? ` (${overview.toFile.length})` : ""}</h3>
      {overview.toFile.length ? (
        <ul className={styles.toFile}>
          {overview.toFile.map((entry) => (
            <li key={entry.id} className={styles.toFileRow}>
              <div>
                <strong>{entry.fileName}</strong> <span className={styles.meta}>{formatBytes(entry.size)}</span>
                <div className={styles.meta}>
                  {entry.from ?? "(no sender)"} · {entry.subject || "(no subject)"} · {nzDate(entry.sentAt)}
                </div>
                <div className={styles.meta}>
                  {entry.ruleText}, to {lowerThe(entry.destinationLabel)}
                </div>
              </div>
              {filing === entry.id ? (
                <FilePanel
                  organisationId={organisationId}
                  options={overview.options}
                  attachment={{ id: entry.attachmentId, name: entry.fileName }}
                  initial={entry.destination}
                  toFileId={entry.id}
                  onClose={() => {
                    setFiling(null);
                    onChanged();
                  }}
                />
              ) : (
                <span className={ui.actions}>
                  <Button size="small" onClick={() => setFiling(entry.id)}>
                    Preview and file…
                  </Button>
                  <Button size="small" variant="secondary" onClick={() => void dismiss(entry.id)}>
                    Not this one
                  </Button>
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className={ui.muted}>Nothing waiting.</p>
      )}
      <h3 className={styles.filingHeading}>Rules</h3>
      {overview.rules.length ? (
        <ul className={styles.toFile}>
          {overview.rules.map((rule) => (
            <li key={rule.id} className={styles.toFileRow}>
              <div>
                {ruleText(rule)}, to {lowerThe(rule.destinationLabel)}
                <div className={styles.meta}>
                  {rule.mailbox}
                  {rule.waiting ? ` · ${rule.waiting} waiting` : ""}
                </div>
              </div>
              <span>
                <Button size="small" variant="secondary" onClick={() => void removeRule(rule.id, ruleText(rule))}>
                  Delete
                </Button>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className={ui.muted}>No rules.</p>
      )}
      {adding ? (
        <RuleForm
          organisationId={organisationId}
          options={overview.options}
          copies={copies}
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            onChanged();
          }}
        />
      ) : copies.length ? (
        <span>
          <Button size="small" variant="secondary" onClick={() => setAdding(true)}>
            Add a rule
          </Button>
        </span>
      ) : null}
      <h3 className={styles.filingHeading}>Filed</h3>
      {overview.filed.length ? (
        <ul className={styles.toFile}>
          {overview.filed.map((item) => (
            <li key={item.id} className={styles.toFileRow}>
              <div>
                <strong>{item.fileName}</strong> · {item.summary}
                <div className={styles.meta}>
                  {nzDate(item.filedAt)}
                  {item.byRule ? " · from a rule" : ""}
                  {item.link ? (
                    <>
                      {" · "}
                      <Link href={item.link}>Open</Link>
                    </>
                  ) : null}
                </div>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className={ui.muted}>Nothing filed yet.</p>
      )}
    </Card>
  );
}

function RuleForm({ organisationId, options, copies, onClose, onSaved }: { organisationId: string; options: FilingOptions; copies: Array<{ id: string; email: string }>; onClose: () => void; onSaved: () => void }) {
  const headingId = useId();
  const [copyId, setCopyId] = useState(copies[0]?.id ?? "");
  const [sender, setSender] = useState("");
  const [fileName, setFileName] = useState("");
  const [destination, setDestination] = useState<FilingDestination | null>(null);
  const [includeExisting, setIncludeExisting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api("/api/my-mail/rules", { method: "POST", body: { organisationId, copyId, sender, fileName, destination, includeExisting } });
      onSaved();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={styles.filePanel} role="region" aria-labelledby={headingId}>
      <h4 id={headingId} className={styles.folderHeading}>
        A rule for attachments
      </h4>
      <p className={styles.privacy}>Matching attachments wait under To file. Nothing is shared until you preview and file each one.</p>
      {copies.length > 1 ? (
        <Field label="Mailbox">
          <select value={copyId} onChange={(event) => setCopyId(event.target.value)}>
            {copies.map((copy) => (
              <option key={copy.id} value={copy.id}>
                {copy.email}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      <div className={ui.grid2}>
        <Field label="From" hint="An address, or @ and a domain for anyone there (@soillab.example).">
          <input value={sender} onChange={(event) => setSender(event.target.value)} autoComplete="off" />
        </Field>
        <Field label="File name" hint="* for any characters, e.g. *.csv or Soil*">
          <input value={fileName} maxLength={100} onChange={(event) => setFileName(event.target.value)} autoComplete="off" />
        </Field>
      </div>
      <DestinationFields organisationId={organisationId} options={options} value={destination} onChange={setDestination} forRule />
      <label className={ui.checkbox}>
        <input type="checkbox" checked={includeExisting} onChange={(event) => setIncludeExisting(event.target.checked)} />
        <span>Also look at emails already copied</span>
      </label>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <span className={ui.actions}>
        <Button disabled={busy || !destination} onClick={() => void save()}>
          Save rule
        </Button>
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
      </span>
    </div>
  );
}
