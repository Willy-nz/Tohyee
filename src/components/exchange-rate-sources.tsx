"use client";

import { type FormEvent, useState } from "react";
import { readFileAsBase64 } from "@/components/bank/common";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Empty, Field, Notice, ui } from "@/components/ui";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import { formatDate, formatDateTime } from "@/lib/format";
import type { RateQuote, RateSet, RateSetPreview, RateSource, RateSourceSettings } from "@/lib/fx/sources";

const SOURCE_LABELS: Record<RateSource, string> = {
  ecb: "ECB (automatic, daily)",
  uploaded: "Uploaded rate sets",
  typed: "Typed only",
};

const SOURCE_HINTS: Record<RateSource, string> = {
  ecb: "The European Central Bank's daily rates are added to the list for the currencies you use.",
  uploaded:
    "A document dated in an uploaded set's period takes that set's rate. A date outside every set asks for the rate to be typed; October's rates aren't carried into November.",
  typed: "Nothing is added automatically. Documents take the list's rate for their date, else the last rate used.",
};

/**
 * Exchange rates › Rate source (#183, FX2, FX7): ECB, uploaded rate sets or
 * typed only. A change that would mix sources in a year asks for the reason
 * Inland Revenue asks you to keep.
 */
export function RateSourceCard({ organisationId, canAdmin, onChanged }: { organisationId: string; canAdmin: boolean; onChanged: (source: RateSource) => void }) {
  const [to, setTo] = useState<RateSource | null>(null);
  const loaded = useApiData<{ settings: RateSourceSettings }>("/api/exchange-rates/source", { organisationId });
  const warned = useApiData<{ warning: string | null }>(to ? "/api/exchange-rates/source" : null, { organisationId, to });
  const warning = warned.data?.warning ?? null;
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const settings = loaded.data?.settings;
  const chosen = to ?? settings?.source ?? null;
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!chosen) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await api("/api/exchange-rates/source", { method: "PUT", body: { organisationId, source: chosen, reason: reason.trim() || null } });
      setMessage(`Rates now come from: ${SOURCE_LABELS[chosen]}.`);
      setTo(null);
      setReason("");
      loaded.reload();
      onChanged(chosen);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card title="Rate source" description="Where new foreign-currency documents get their rates. A rate typed on a document always wins. Changing the source changes nothing already in the books.">
      {loaded.error ? <Notice tone="error">{loaded.error}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {message ? <Notice tone="success">{message}</Notice> : null}
      {settings && chosen ? (
        <form onSubmit={(event) => void save(event)} style={{ display: "grid", gap: 12 }}>
          <Field label="Rate source" hint={SOURCE_HINTS[chosen]}>
            <select value={chosen} disabled={!canAdmin} onChange={(event) => setTo(event.target.value as RateSource)}>
              {(Object.keys(SOURCE_LABELS) as RateSource[]).map((source) => (
                <option key={source} value={source}>
                  {SOURCE_LABELS[source]}
                </option>
              ))}
            </select>
          </Field>
          {to && to !== settings.source && warning ? (
            <>
              <Notice tone="warning">{warning}</Notice>
              <Field label="Reason for changing">
                <textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={2} maxLength={500} required />
              </Field>
            </>
          ) : null}
          {canAdmin && to && to !== settings.source ? (
            <div className={ui.actions}>
              <Button type="submit" disabled={busy || warned.loading || (warning ? !reason.trim() : false)}>
                {busy ? "Saving…" : "Change the source"}
              </Button>
              <Button variant="secondary" type="button" onClick={() => setTo(null)}>
                Cancel
              </Button>
            </div>
          ) : null}
          {!canAdmin ? <p className={ui.muted}>Admins and owners can change the source.</p> : null}
          {settings.history.length > 0 ? (
            <details>
              <summary>History</summary>
              <ul>
                {settings.history.map((change) => (
                  <li key={`${change.changedAt}-${change.toSource}`}>
                    {formatDateTime(change.changedAt)}: {SOURCE_LABELS[change.fromSource]} to {SOURCE_LABELS[change.toSource]}
                    {change.changedByEmail ? ` by ${change.changedByEmail}` : ""}
                    {change.reason ? `. Reason: ${change.reason}` : ""}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </form>
      ) : null}
    </Card>
  );
}

/**
 * Exchange rates › Uploaded rate sets (#183, FX3, FX6): a CSV or Excel file
 * of currency and rate for a period, named for where it came from,
 * previewed before it's saved.
 */
export function RateSetsCard({ organisationId, baseCurrency, canEdit, onChanged }: { organisationId: string; baseCurrency: string; canEdit: boolean; onChanged: () => void }) {
  const sets = useApiData<{ sets: RateSet[] }>("/api/exchange-rates/sets", { organisationId });
  const [name, setName] = useState("");
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [quoted, setQuoted] = useState<RateQuote>("foreign_per_base");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<RateSetPreview | null>(null);
  const [replaceReason, setReplaceReason] = useState("");
  const [key, setKey] = useState(() => newIdempotencyKey("rateset"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const reset = () => setPreview(null);
  async function body() {
    if (!file) throw new Error("Choose a CSV or Excel file.");
    return { organisationId, name, periodStart, periodEnd, quoted, fileName: file.name, fileBase64: await readFileAsBase64(file) };
  }
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await action();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }
  const showPreview = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void run(async () => {
      const result = await api<{ preview: RateSetPreview }>("/api/exchange-rates/sets", { method: "POST", body: { ...(await body()), preview: true } });
      setPreview(result.preview);
    });
  };
  const save = () =>
    void run(async () => {
      const result = await api<{ set: RateSet }>("/api/exchange-rates/sets", {
        method: "POST",
        body: { ...(await body()), idempotencyKey: key, source: "ui", replaceReason: preview?.overlaps.length ? replaceReason.trim() : null },
      });
      setMessage(`Saved ${result.set.name} for ${formatDate(result.set.periodStart)} to ${formatDate(result.set.periodEnd)}: ${result.set.rates.length} rate${result.set.rates.length === 1 ? "" : "s"}.`);
      setKey(newIdempotencyKey("rateset"));
      setPreview(null);
      setFile(null);
      setReplaceReason("");
      sets.reload();
      onChanged();
    });
  return (
    <Card
      title="Uploaded rate sets"
      description={`A set of rates for a period from any source you choose (IRD's monthly or yearly averages, the Reserve Bank, your bank), used while the rate source is Uploaded rate sets. Rates are kept as ${baseCurrency} per 1 unit. Inland Revenue asks you to keep a record of each rate's source and date; the set's name and file are kept.`}
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      {message ? <Notice tone="success">{message}</Notice> : null}
      {canEdit ? (
        <form onSubmit={showPreview} style={{ display: "grid", gap: 12 }}>
          <div className={ui.grid4}>
            <Field label="Name" hint="Where the rates came from, e.g. IRD monthly average">
              <input value={name} maxLength={100} required onChange={(event) => (setName(event.target.value), reset())} />
            </Field>
            <Field label="Period from">
              <input type="date" value={periodStart} required onChange={(event) => (setPeriodStart(event.target.value), reset())} />
            </Field>
            <Field label="Period to">
              <input type="date" value={periodEnd} required onChange={(event) => (setPeriodEnd(event.target.value), reset())} />
            </Field>
            <Field label="Rates are quoted as">
              <select value={quoted} onChange={(event) => (setQuoted(event.target.value as RateQuote), reset())}>
                <option value="foreign_per_base">Foreign currency per {baseCurrency} 1 (as IRD publishes)</option>
                <option value="base_per_foreign">{baseCurrency} per 1 foreign currency</option>
              </select>
            </Field>
          </div>
          <Field label="File (CSV or Excel)" hint="Each row: currency code, then rate. A heading row is fine; other columns are ignored.">
            <input type="file" accept=".csv,.txt,.xlsx" required onChange={(event) => (setFile(event.target.files?.[0] ?? null), reset())} />
          </Field>
          <div className={ui.actions}>
            <Button type="submit" variant={preview ? "secondary" : "primary"} disabled={busy}>
              {busy && !preview ? "Reading…" : "Preview"}
            </Button>
          </div>
        </form>
      ) : (
        <Notice tone="info">Bookkeepers, admins and owners can upload rate sets.</Notice>
      )}
      {preview ? (
        <div style={{ display: "grid", gap: 12, marginTop: 12 }}>
          <div className={ui.tableWrap}>
            <table className={ui.table}>
              <thead>
                <tr>
                  <th>Row</th>
                  <th>Currency</th>
                  <th className={ui.num}>In the file</th>
                  <th>Saved as</th>
                </tr>
              </thead>
              <tbody>
                {preview.rates.map((rate) => (
                  <tr key={rate.currencyCode}>
                    <td>{rate.row}</td>
                    <td>{rate.currencyCode}</td>
                    <td className={ui.num}>{rate.quoted}</td>
                    <td>{rate.text}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {preview.skipped.length > 0 ? (
            <p className={ui.muted}>Skipped (not used by this organisation): {preview.skipped.map((entry) => entry.currencyCode).join(", ")}.</p>
          ) : null}
          {preview.overlaps.length > 0 ? (
            <>
              <Notice tone="warning">
                Part of this period is already covered by{" "}
                {preview.overlaps.map((set) => `${set.name} (${formatDate(set.periodStart)} to ${formatDate(set.periodEnd)})`).join(", ")}. Saving replaces it: new
                documents in the period take the new rates, and documents already made keep theirs.
              </Notice>
              <Field label="Reason for replacing">
                <textarea value={replaceReason} onChange={(event) => setReplaceReason(event.target.value)} rows={2} maxLength={500} required />
              </Field>
            </>
          ) : null}
          <div className={ui.actions}>
            <Button disabled={busy || (preview.overlaps.length > 0 && !replaceReason.trim())} onClick={save}>
              {busy ? "Saving…" : preview.overlaps.length > 0 ? "Replace and save" : "Save these rates"}
            </Button>
          </div>
        </div>
      ) : null}
      {sets.error ? <Notice tone="error">{sets.error}</Notice> : null}
      {sets.data ? (
        sets.data.sets.length === 0 ? (
          <Empty>No rate sets uploaded yet.</Empty>
        ) : (
          <div className={ui.tableWrap} style={{ marginTop: 12 }}>
            <table className={`${ui.table} ${ui.stackOnPhone}`}>
              <thead>
                <tr>
                  <th>Set</th>
                  <th>Period</th>
                  <th>Rates</th>
                  <th>Added</th>
                </tr>
              </thead>
              <tbody>
                {sets.data.sets.map((set) => (
                  <tr key={set.id}>
                    <td data-label="Set">
                      {set.name} {set.replacedAt ? <Badge>Replaced</Badge> : null}
                      {set.replaceReason ? <div className={ui.muted}>Replaced an earlier set: {set.replaceReason}</div> : null}
                    </td>
                    <td data-label="Period">
                      {formatDate(set.periodStart)} to {formatDate(set.periodEnd)}
                    </td>
                    <td data-label="Rates">{set.rates.map((rate) => `${rate.currencyCode} ${rate.rate}`).join(", ")}</td>
                    <td data-label="Added" className={ui.muted}>
                      {set.createdByEmail ?? ""} · {formatDateTime(set.createdAt)}
                      {set.fileName ? ` · ${set.fileName}` : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : null}
    </Card>
  );
}
