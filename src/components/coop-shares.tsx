"use client";

import { type FormEvent, useState } from "react";
import { Money } from "@/components/books";
import { useConfirm } from "@/components/confirm-dialog";
import { DateInput } from "@/components/date-input";
import { useApiData } from "@/components/hooks";
import { RecordExtrasPanel } from "@/components/records/record-extras";
import { ReportExport } from "@/components/reports/report-export";
import { Button, Card, Empty, Field, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage } from "@/lib/client/api";
import { formatDate, formatQuantity, todayInBrowser } from "@/lib/format";
import type { CoopHoldingSchedule, CoopShareSchedule, CoopSourceFile } from "@/lib/farming/coop-shares";
import type { RecordExtras } from "@/lib/records/types";

/*
 * The co-op share register (#327; CSR1-CSR10). Kinds are repeated here
 * rather than imported, since the lib reads the database.
 */
const MOVEMENT_KINDS = [
  { key: "brought_forward", label: "Brought forward", hint: "The holding when you start the register. Date it the day before the first year you enter, so it's that year's opening." },
  { key: "bought", label: "Bought or issued for payment", hint: "Shares bought or issued for money. Value is what was paid." },
  { key: "issued", label: "Issued without payment", hint: "Bonus shares, or shares issued for a rebate or retention. Value as the statement shows it." },
  { key: "sold", label: "Sold, surrendered or redeemed", hint: "Enter positive numbers: the shares that went and the value taken off the register." },
  { key: "adjusted", label: "Adjustment", hint: "A correction or split. Use a minus sign to take shares or value off." },
] as const;

const DISTRIBUTION_KINDS = [
  { key: "dividend", label: "Dividend" },
  { key: "rebate", label: "Rebate" },
  { key: "retention", label: "Retention" },
] as const;

function SourceCell({ organisationId, holdingId, reference, file }: { organisationId: string; holdingId: string; reference: string | null; file: CoopSourceFile | null }) {
  return (
    <>
      {reference}
      {reference && file ? <br /> : null}
      {file ? (
        file.removed ? (
          <span className={ui.muted}>{file.fileName} (removed)</span>
        ) : (
          <a href={`/api/records/coop-shareholding/${holdingId}/attachments/${file.id}?organisationId=${encodeURIComponent(organisationId)}`} target="_blank" rel="noreferrer">
            {file.fileName}
          </a>
        )
      ) : null}
    </>
  );
}

/** The register for a year, a holding per card, and adding co-ops (CSR1-CSR8). */
export function CoopSharesView({ organisationId }: { organisationId: string }) {
  const { can } = useWorkspace();
  const [yearEnd, setYearEnd] = useState<string | null>(null);
  const report = useApiData<CoopShareSchedule>("/api/farming/coop-shares", { organisationId, yearEnd });
  const data = report.data;
  const canEdit = can("bookkeeper");
  return (
    <>
      <Card
        title="Co-op share register"
        description="Shares held in co-ops, with each movement and each dividend, rebate and retention as the co-op's statements show them. It goes in the year-end pack. Nothing here posts to the ledger."
        actions={
          data ? (
            <Field label="Year ending">
              <select value={data.yearEnd} onChange={(event) => setYearEnd(event.target.value)}>
                {data.yearEnds.map((end) => (
                  <option key={end} value={end}>
                    {formatDate(end)}
                  </option>
                ))}
              </select>
            </Field>
          ) : null
        }
      >
        {report.error ? <Notice tone="error">{report.error}</Notice> : null}
        {report.loading && !data ? <p className={ui.muted}>Loading…</p> : null}
        {data && data.holdings.length === 0 ? <Empty>No co-op shares yet. Add a co-op below.</Empty> : null}
        {data && data.holdings.length > 0 ? (
          <>
            <ReportExport
              organisationId={organisationId}
              report="coop-share-register"
              title="Co-op share register"
              period={`${formatDate(data.yearStart)} to ${formatDate(data.yearEnd)}`}
              tables={[{ id: "coop-share-summary" }]}
            />
            <div className={ui.tableWrap}>
              <table id="coop-share-summary" className={`${ui.table} ${ui.stackOnPhone}`}>
                <thead>
                  <tr>
                    <th>Co-op and share class</th>
                    <th className={ui.num}>Opening shares</th>
                    <th className={ui.num}>Opening value</th>
                    <th className={ui.num}>Closing shares</th>
                    <th className={ui.num}>Closing value</th>
                    <th className={ui.num}>Dividends</th>
                    <th className={ui.num}>Imputation credits</th>
                    <th className={ui.num}>Rebates</th>
                    <th className={ui.num}>Retentions</th>
                  </tr>
                </thead>
                <tbody>
                  {data.holdings.map((holding) => (
                    <tr key={holding.id}>
                      <td data-label="Co-op">
                        <a href={`#coop-holding-${holding.id}`}>
                          {holding.coopName} · {holding.shareClass}
                        </a>
                      </td>
                      <td data-label="Opening shares" className={ui.num} data-export-value={holding.opening.quantity}>
                        {formatQuantity(holding.opening.quantity)}
                      </td>
                      <td data-label="Opening value" className={ui.num}>
                        <Money value={holding.opening.value} />
                      </td>
                      <td data-label="Closing shares" className={ui.num} data-export-value={holding.closing.quantity}>
                        {formatQuantity(holding.closing.quantity)}
                      </td>
                      <td data-label="Closing value" className={ui.num}>
                        <Money value={holding.closing.value} />
                      </td>
                      <td data-label="Dividends" className={ui.num}>
                        <Money value={holding.totals.dividends} />
                      </td>
                      <td data-label="Imputation credits" className={ui.num}>
                        <Money value={holding.totals.imputationCredits} />
                      </td>
                      <td data-label="Rebates" className={ui.num}>
                        <Money value={holding.totals.rebates} />
                      </td>
                      <td data-label="Retentions" className={ui.num}>
                        <Money value={holding.totals.retentions} />
                      </td>
                    </tr>
                  ))}
                  <tr className={ui.reportTotal}>
                    <td data-label="">Total</td>
                    <td data-label="" />
                    <td data-label="Opening value" className={ui.num}>
                      <Money value={data.totals.openingValue} />
                    </td>
                    <td data-label="" />
                    <td data-label="Closing value" className={ui.num}>
                      <Money value={data.totals.closingValue} />
                    </td>
                    <td data-label="Dividends" className={ui.num}>
                      <Money value={data.totals.dividends} />
                    </td>
                    <td data-label="Imputation credits" className={ui.num}>
                      <Money value={data.totals.imputationCredits} />
                    </td>
                    <td data-label="Rebates" className={ui.num}>
                      <Money value={data.totals.rebates} />
                    </td>
                    <td data-label="Retentions" className={ui.num}>
                      <Money value={data.totals.retentions} />
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className={ui.muted}>
              Values are as entered from the co-ops&apos; statements (usually what the shares cost). Tohyee doesn&apos;t value shares or work out how many a co-op requires you to hold.
            </p>
          </>
        ) : null}
      </Card>
      {data
        ? data.holdings.map((holding) => (
            <HoldingCard key={holding.id} organisationId={organisationId} holding={holding} yearStart={data.yearStart} yearEnd={data.yearEnd} canEdit={canEdit} onChanged={report.reload} />
          ))
        : null}
      {canEdit ? <AddHoldingCard organisationId={organisationId} onAdded={report.reload} /> : null}
    </>
  );
}

function HoldingCard({
  organisationId,
  holding,
  yearStart,
  yearEnd,
  canEdit,
  onChanged,
}: {
  organisationId: string;
  holding: CoopHoldingSchedule;
  yearStart: string;
  yearEnd: string;
  canEdit: boolean;
  onChanged: () => void;
}) {
  const confirm = useConfirm();
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<"movement" | "payment" | null>(null);
  async function remove(path: string, question: string) {
    if (!(await confirm(question))) return;
    setError(null);
    try {
      await api(path, { method: "DELETE", query: { organisationId } });
      onChanged();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }
  const title = `${holding.coopName} · ${holding.shareClass}`;
  return (
    <section id={`coop-holding-${holding.id}`}>
      <Card title={title} description={holding.notes ?? undefined}>
        {error ? <Notice tone="error">{error}</Notice> : null}
        <h3 className={ui.cardTitle}>Shares</h3>
        <div className={ui.tableWrap}>
          <table className={`${ui.table} ${ui.stackOnPhone}`}>
            <thead>
              <tr>
                <th>Date</th>
                <th>Movement</th>
                <th className={ui.num}>Shares</th>
                <th className={ui.num}>Value</th>
                <th>Source statement</th>
                {canEdit ? <th aria-label="Actions" /> : null}
              </tr>
            </thead>
            <tbody>
              <tr className={ui.reportSection}>
                <td data-label="Date">{formatDate(yearStart)}</td>
                <td data-label="Movement">Opening</td>
                <td data-label="Shares" className={ui.num}>
                  {formatQuantity(holding.opening.quantity)}
                </td>
                <td data-label="Value" className={ui.num}>
                  <Money value={holding.opening.value} />
                </td>
                <td data-label="" />
                {canEdit ? <td data-label="" /> : null}
              </tr>
              {holding.movements.map((movement) => (
                <tr key={movement.id}>
                  <td data-label="Date">{formatDate(movement.date)}</td>
                  <td data-label="Movement">{movement.kindLabel}</td>
                  <td data-label="Shares" className={ui.num}>
                    {formatQuantity(movement.quantity)}
                  </td>
                  <td data-label="Value" className={ui.num}>
                    <Money value={movement.value} />
                  </td>
                  <td data-label="Source statement">
                    <SourceCell organisationId={organisationId} holdingId={holding.id} reference={movement.sourceReference} file={movement.file} />
                  </td>
                  {canEdit ? (
                    <td data-label="">
                      <Button
                        size="small"
                        variant="secondary"
                        aria-label={`Remove ${movement.kindLabel.toLowerCase()} on ${formatDate(movement.date)}`}
                        onClick={() => void remove(`/api/farming/coop-share-movements/${movement.id}`, "Remove this movement? It's kept in the history.")}
                      >
                        Remove
                      </Button>
                    </td>
                  ) : null}
                </tr>
              ))}
              <tr className={ui.reportTotal}>
                <td data-label="Date">{formatDate(yearEnd)}</td>
                <td data-label="Movement">Closing</td>
                <td data-label="Shares" className={ui.num}>
                  {formatQuantity(holding.closing.quantity)}
                </td>
                <td data-label="Value" className={ui.num}>
                  <Money value={holding.closing.value} />
                </td>
                <td data-label="" />
                {canEdit ? <td data-label="" /> : null}
              </tr>
            </tbody>
          </table>
        </div>
        <h3 className={ui.cardTitle}>Dividends, rebates and retentions</h3>
        {holding.distributions.length === 0 ? (
          <p className={ui.muted}>None in this year.</p>
        ) : (
          <div className={ui.tableWrap}>
            <table className={`${ui.table} ${ui.stackOnPhone}`}>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Kind</th>
                  <th className={ui.num}>Amount</th>
                  <th className={ui.num}>Imputation credits</th>
                  <th>Source statement</th>
                  {canEdit ? <th aria-label="Actions" /> : null}
                </tr>
              </thead>
              <tbody>
                {holding.distributions.map((paid) => (
                  <tr key={paid.id}>
                    <td data-label="Date">{formatDate(paid.date)}</td>
                    <td data-label="Kind">{paid.kindLabel}</td>
                    <td data-label="Amount" className={ui.num}>
                      <Money value={paid.amount} />
                    </td>
                    <td data-label="Imputation credits" className={ui.num}>
                      {paid.imputationCredits === null ? <span className={ui.muted}>–</span> : <Money value={paid.imputationCredits} />}
                    </td>
                    <td data-label="Source statement">
                      <SourceCell organisationId={organisationId} holdingId={holding.id} reference={paid.sourceReference} file={paid.file} />
                    </td>
                    {canEdit ? (
                      <td data-label="">
                        <Button
                          size="small"
                          variant="secondary"
                          aria-label={`Remove ${paid.kindLabel.toLowerCase()} on ${formatDate(paid.date)}`}
                          onClick={() => void remove(`/api/farming/coop-share-distributions/${paid.id}`, `Remove this ${paid.kindLabel.toLowerCase()}? It's kept in the history.`)}
                        >
                          Remove
                        </Button>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {canEdit ? (
          <div className={ui.toolbar} style={{ marginTop: 12 }}>
            <Button variant={adding === "movement" ? "primary" : "secondary"} aria-expanded={adding === "movement"} onClick={() => setAdding(adding === "movement" ? null : "movement")}>
              Add a share movement
            </Button>
            <Button variant={adding === "payment" ? "primary" : "secondary"} aria-expanded={adding === "payment"} onClick={() => setAdding(adding === "payment" ? null : "payment")}>
              Add a dividend, rebate or retention
            </Button>
            {!holding.hasEntries ? (
              <Button variant="danger" onClick={() => void remove(`/api/farming/coop-shares/${holding.id}`, `Remove ${title} from the register? It's kept in the history.`)}>
                Remove this holding
              </Button>
            ) : null}
          </div>
        ) : null}
        {adding ? (
          <EntryForm
            key={adding}
            organisationId={organisationId}
            holdingId={holding.id}
            mode={adding}
            onSaved={() => {
              setAdding(null);
              onChanged();
            }}
          />
        ) : null}
        <RecordExtrasPanel organisationId={organisationId} recordType="coop_shareholding" recordId={holding.id} title="Statements, notes and history" />
      </Card>
    </section>
  );
}

function EntryForm({ organisationId, holdingId, mode, onSaved }: { organisationId: string; holdingId: string; mode: "movement" | "payment"; onSaved: () => void }) {
  const files = useApiData<RecordExtras>(`/api/records/coop-shareholding/${encodeURIComponent(holdingId)}`, { organisationId });
  const [form, setForm] = useState({
    date: todayInBrowser(),
    kind: mode === "movement" ? "bought" : "dividend",
    quantity: "",
    value: "",
    amount: "",
    imputationCredits: "",
    sourceReference: "",
    attachmentId: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (field: keyof typeof form) => (event: { target: { value: string } }) => setForm({ ...form, [field]: event.target.value });
  const movementKind = MOVEMENT_KINDS.find((kind) => kind.key === form.kind);
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const source = { sourceReference: form.sourceReference, attachmentId: form.attachmentId || null };
      if (mode === "movement") {
        await api("/api/farming/coop-share-movements", { method: "POST", body: { organisationId, holdingId, date: form.date, kind: form.kind, quantity: form.quantity, value: form.value, ...source } });
      } else {
        await api("/api/farming/coop-share-distributions", {
          method: "POST",
          body: { organisationId, holdingId, date: form.date, kind: form.kind, amount: form.amount, imputationCredits: form.kind === "dividend" ? form.imputationCredits : null, ...source },
        });
      }
      onSaved();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }
  const attachments = files.data?.attachments ?? [];
  return (
    <form onSubmit={save} style={{ display: "grid", gap: 8, marginTop: 12 }} aria-label={mode === "movement" ? "Add a share movement" : "Add a dividend, rebate or retention"}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.inlineForm}>
        <Field label="Date">
          <DateInput value={form.date} onChange={set("date")} required />
        </Field>
        {mode === "movement" ? (
          <>
            <Field label="Movement" hint={movementKind?.hint}>
              <select value={form.kind} onChange={set("kind")}>
                {MOVEMENT_KINDS.map((kind) => (
                  <option key={kind.key} value={kind.key}>
                    {kind.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Shares">
              <input inputMode="decimal" value={form.quantity} onChange={set("quantity")} required />
            </Field>
            <Field label="Value">
              <input inputMode="decimal" value={form.value} onChange={set("value")} required />
            </Field>
          </>
        ) : (
          <>
            <Field label="Kind">
              <select value={form.kind} onChange={set("kind")}>
                {DISTRIBUTION_KINDS.map((kind) => (
                  <option key={kind.key} value={kind.key}>
                    {kind.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Amount">
              <input inputMode="decimal" value={form.amount} onChange={set("amount")} required />
            </Field>
            {form.kind === "dividend" ? (
              <Field label="Imputation credits" hint="Leave blank if the statement shows none.">
                <input inputMode="decimal" value={form.imputationCredits} onChange={set("imputationCredits")} />
              </Field>
            ) : null}
          </>
        )}
      </div>
      <div className={ui.inlineForm}>
        <Field label="Source statement" hint="Which statement it comes from, e.g. “Fonterra share statement 31 May 2026”.">
          <input value={form.sourceReference} onChange={set("sourceReference")} maxLength={200} />
        </Field>
        <Field label="Statement file" hint={attachments.length === 0 ? "Add the statement under Statements, notes and history below, then choose it here." : undefined}>
          <select value={form.attachmentId} onChange={set("attachmentId")} onFocus={() => files.reload()}>
            <option value="">No file</option>
            {attachments.map((file) => (
              <option key={file.id} value={file.id}>
                {file.fileName}
              </option>
            ))}
          </select>
        </Field>
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
}

function AddHoldingCard({ organisationId, onAdded }: { organisationId: string; onAdded: () => void }) {
  const [form, setForm] = useState({ coopName: "", shareClass: "", notes: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/api/farming/coop-shares", { method: "POST", body: { organisationId, ...form } });
      setForm({ coopName: "", shareClass: "", notes: "" });
      onAdded();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card title="Add a co-op" description="One line per co-op and share class, e.g. Fonterra co-operative shares, Ravensdown ordinary shares or Silver Fern Farms rebate shares.">
      {error ? <Notice tone="error">{error}</Notice> : null}
      <form onSubmit={save} className={ui.inlineForm}>
        <Field label="Co-op">
          <input value={form.coopName} onChange={(event) => setForm({ ...form, coopName: event.target.value })} maxLength={100} required list="coop-names" />
        </Field>
        <datalist id="coop-names">
          <option value="Fonterra" />
          <option value="Ballance Agri-Nutrients" />
          <option value="Ravensdown" />
          <option value="Silver Fern Farms" />
          <option value="Alliance Group" />
          <option value="LIC" />
          <option value="Farmlands" />
        </datalist>
        <Field label="Share class">
          <input value={form.shareClass} onChange={(event) => setForm({ ...form, shareClass: event.target.value })} maxLength={100} required />
        </Field>
        <Field label="Notes">
          <input value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} maxLength={1000} />
        </Field>
        <Button type="submit" disabled={busy}>
          {busy ? "Adding…" : "Add co-op"}
        </Button>
      </form>
    </Card>
  );
}
