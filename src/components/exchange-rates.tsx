"use client";

import { EcbRatesCard } from "@/components/consolidation";
import { type FormEvent, useState } from "react";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Empty, Field, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import { formatDate, formatDateTime, personName, todayInBrowser } from "@/lib/format";
import type { ExchangeRate, ExchangeRatesList } from "@/lib/fx/rates";
import { CURRENCY_MINOR_UNITS } from "@/lib/money/currency";
import { isRateText } from "@/lib/money/fx";
import { useConfirm } from "@/components/confirm-dialog";

/**
 * Accounting › Exchange rates (examples MC46-MC53), like NetSuite's Currency
 * Exchange Rates: what's in effect today per currency, adding one rate or
 * pasting several, and every entry with archiving (never deleting).
 */
export function ExchangeRatesManager({ organisationId }: { organisationId: string }) {
  const { can } = useWorkspace();
  const [showArchived, setShowArchived] = useState(false);
  const list = useApiData<ExchangeRatesList>("/api/fx/rates", { organisationId, includeArchived: showArchived ? "true" : null });
  const [message, setMessage] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  if (list.error) return <Notice tone="error">{list.error}</Notice>;
  if (!list.data) return <p className={ui.muted}>Loading…</p>;
  const data = list.data;
  const editable = can("bookkeeper");
  const added = (text: string) => {
    setMessage(text);
    list.reload();
  };
  const shown = data.rates.filter((rate) => !filter || rate.currencyCode === filter);
  return (
    <>
      {message ? <Notice tone="success">{message}</Notice> : null}
      <EcbRatesCard organisationId={organisationId} canAdmin={can("admin")} onChanged={list.reload} />
      <Card
        title="In effect today"
        description={`New foreign-currency invoices, bills, credit notes, payments, refunds and bank statement lines start with the rate in effect on their date (${data.baseCurrency} per 1 unit). You can still change it on each one. With no rate here, they start with the last rate used in the books.`}
      >
        {data.current.length === 0 ? (
          <Empty>No foreign currencies yet. Set a currency on a contact or an account, or add a rate below.</Empty>
        ) : (
          <div className={ui.tableWrap}>
            <table className={`${ui.table} ${ui.stackOnPhone}`}>
              <thead>
                <tr>
                  <th>Currency</th>
                  <th className={ui.num}>Rate ({data.baseCurrency} per 1)</th>
                  <th>Effective from</th>
                </tr>
              </thead>
              <tbody>
                {data.current.map((entry) => (
                  <tr key={entry.currencyCode}>
                    <td data-label="Currency">{entry.currencyCode}</td>
                    <td data-label="Rate" className={ui.num}>
                      {entry.rate ? entry.rate.rate : <span className={ui.muted}>None in the list</span>}
                    </td>
                    <td data-label="Effective from">{entry.rate ? formatDate(entry.rate.effectiveDate) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {editable ? (
        <>
          <AddRate organisationId={organisationId} data={data} onAdded={added} />
          <PasteRates organisationId={organisationId} onAdded={added} />
        </>
      ) : (
        <Notice tone="info">Bookkeepers, admins and owners can add and archive rates.</Notice>
      )}
      <Card
        title="All rates"
        description="Newest effective date first. To correct a rate, add the right one for the same date (the newest added wins) or archive the wrong one. Documents already made keep their rate."
        actions={
          <div className={ui.inlineForm}>
            <Field label="Currency">
              <select value={filter} onChange={(event) => setFilter(event.target.value)}>
                <option value="">All</option>
                {data.currenciesInUse.map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </select>
            </Field>
            <label className={ui.checkbox}>
              <input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} /> Show archived
            </label>
          </div>
        }
      >
        {shown.length === 0 ? (
          <Empty>No rates yet.</Empty>
        ) : (
          <div className={ui.tableWrap}>
            <table className={`${ui.table} ${ui.stackOnPhone}`}>
              <thead>
                <tr>
                  <th>Currency</th>
                  <th>Effective from</th>
                  <th className={ui.num}>Rate ({data.baseCurrency} per 1)</th>
                  <th>Note</th>
                  <th>Added</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {shown.map((rate) => (
                  <RateRow key={rate.id} organisationId={organisationId} rate={rate} editable={editable} onArchived={added} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

function RateRow({
  organisationId,
  rate,
  editable,
  onArchived,
}: {
  organisationId: string;
  rate: ExchangeRate;
  editable: boolean;
  onArchived: (message: string) => void;
}) {
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function archive() {
    if (!(await confirm(`Archive ${rate.currencyCode} ${rate.rate} effective ${formatDate(rate.effectiveDate)}? It stays in the list but isn't used again.`))) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/fx/rates/${rate.id}/archive`, { method: "POST", body: { organisationId } });
      onArchived(`Archived ${rate.currencyCode} ${rate.rate} effective ${formatDate(rate.effectiveDate)}.`);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }
  return (
    <tr>
      <td data-label="Currency">{rate.currencyCode}</td>
      <td data-label="Effective from">{formatDate(rate.effectiveDate)}</td>
      <td data-label="Rate" className={ui.num}>
        {rate.rate}
      </td>
      <td data-label="Note" className={ui.muted}>
        {rate.note ?? ""}
      </td>
      <td data-label="Added" className={ui.muted}>
        {personName(rate, "createdBy") ?? ""} · {formatDateTime(rate.createdAt)}
        {rate.archivedAt ? ` · archived by ${personName(rate, "archivedBy") ?? ""} ${formatDateTime(rate.archivedAt)}` : ""}
      </td>
      <td data-label="">
        {rate.archivedAt ? (
          <Badge>Archived</Badge>
        ) : editable ? (
          <Button size="small" variant="secondary" disabled={busy} onClick={() => void archive()}>
            Archive
          </Button>
        ) : null}
        {error ? <Notice tone="error">{error}</Notice> : null}
      </td>
    </tr>
  );
}

function AddRate({ organisationId, data, onAdded }: { organisationId: string; data: ExchangeRatesList; onAdded: (message: string) => void }) {
  const others = Object.keys(CURRENCY_MINOR_UNITS).filter((code) => code !== data.baseCurrency && !data.currenciesInUse.includes(code));
  const [currencyCode, setCurrencyCode] = useState(data.currenciesInUse[0] ?? others[0] ?? "");
  const [effectiveDate, setEffectiveDate] = useState(todayInBrowser);
  const [rate, setRate] = useState("");
  const [note, setNote] = useState("");
  const [key, setKey] = useState(() => newIdempotencyKey("fxrate"));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/api/fx/rates", {
        method: "POST",
        body: { organisationId, source: "ui", idempotencyKey: key, rates: [{ currencyCode, effectiveDate, rate: rate.trim(), note: note.trim() || null }] },
      });
      setKey(newIdempotencyKey("fxrate"));
      setRate("");
      setNote("");
      onAdded(`Added ${currencyCode} ${rate.trim()} effective ${formatDate(effectiveDate)}.`);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card title="Add a rate">
      {error ? <Notice tone="error">{error}</Notice> : null}
      <form onSubmit={(event) => void submit(event)} style={{ display: "grid", gap: 12 }}>
        <div className={ui.grid4}>
          <Field label="Currency">
            <select value={currencyCode} onChange={(event) => setCurrencyCode(event.target.value)} required>
              {data.currenciesInUse.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
              {others.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Effective from">
            <input type="date" value={effectiveDate} onChange={(event) => setEffectiveDate(event.target.value)} required />
          </Field>
          <Field label={`Rate (${data.baseCurrency} per 1 ${currencyCode})`} hint="Up to 8 decimal places.">
            <input inputMode="decimal" value={rate} onChange={(event) => setRate(event.target.value)} required aria-invalid={rate !== "" && !isRateText(rate)} />
          </Field>
          <Field label="Note (optional)" hint="e.g. RBNZ, or the bank's rate">
            <input value={note} onChange={(event) => setNote(event.target.value)} maxLength={200} />
          </Field>
        </div>
        <div className={ui.actions}>
          <Button type="submit" disabled={busy || !isRateText(rate)}>
            {busy ? "Adding…" : "Add rate"}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function PasteRates({ organisationId, onAdded }: { organisationId: string; onAdded: (message: string) => void }) {
  const [text, setText] = useState("");
  const [key, setKey] = useState(() => newIdempotencyKey("fxrates"));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ added: ExchangeRate[] }>("/api/fx/rates", { method: "POST", body: { organisationId, source: "ui", idempotencyKey: key, text } });
      setKey(newIdempotencyKey("fxrates"));
      setText("");
      onAdded(`Added ${result.added.length} rate${result.added.length === 1 ? "" : "s"}.`);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card
      title="Paste several rates"
      description="One per line: currency, effective date, rate, and an optional note, separated by commas or tabs (rows copied from a spreadsheet work). Dates as 2026-08-31 or 31/08/2026. All are added, or none if a line is wrong."
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      <form onSubmit={(event) => void submit(event)} style={{ display: "grid", gap: 12 }}>
        <Field label="Rates">
          <textarea value={text} onChange={(event) => setText(event.target.value)} rows={5} placeholder={"USD, 2026-08-31, 1.6543, RBNZ\nEUR, 2026-08-31, 1.9012, RBNZ"} required />
        </Field>
        <div className={ui.actions}>
          <Button type="submit" disabled={busy || !text.trim()}>
            {busy ? "Adding…" : "Add these rates"}
          </Button>
        </div>
      </form>
    </Card>
  );
}
