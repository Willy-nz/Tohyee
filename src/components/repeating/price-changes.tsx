"use client";

import { useState } from "react";
import { DateInput } from "@/components/date-input";
import { Money } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Empty, Field, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage } from "@/lib/client/api";
import { formatDate, todayInBrowser } from "@/lib/format";
import type { PriceChange, PriceChangePreview } from "@/lib/repeating/price-changes";
import type { RepeatingInvoiceSummary } from "@/lib/repeating/service";

const ROUNDING: Array<{ value: string; label: string }> = [
  { value: "cent", label: "To the cent" },
  { value: "0.50", label: "Nearest 50c" },
  { value: "1", label: "Nearest $1" },
  { value: "5", label: "Nearest $5" },
  { value: "10", label: "Nearest $10" },
];

const LINE_STATUS: Record<string, string> = {
  waiting: "Waiting",
  made: "Changed",
  skipped: "Left alone",
  cancelled: "Cancelled",
  undone: "Undone",
  kept: "Kept",
};

type Item = { id: string; code: string | null; name: string; isArchived?: boolean };

function describeRule(change: PriceChange): string {
  if (change.method === "fixed") return `${change.itemName ?? "Item"} set to ${change.fixedPrice}`;
  const percent = Number(change.percent);
  const words = [`${percent > 0 ? "Up" : "Down"} ${Math.abs(percent)}%`];
  if (change.minimumIncrease) words.push(`at least ${change.minimumIncrease}`);
  const rounding = ROUNDING.find((entry) => entry.value === change.rounding);
  if (rounding && change.rounding !== "cent") words.push(rounding.label.toLowerCase());
  return words.join(", ");
}

/**
 * Price changes on repeating invoices (RP1-RP8): choose templates, a
 * percentage or a fixed price for one item, rounding and a date; preview
 * every line, then save. Earlier changes are listed with an undo.
 */
export function RepeatingPriceChanges({ organisationId }: { organisationId: string }) {
  const { can } = useWorkspace();
  const editable = can("bookkeeper");
  const templates = useApiData<{ repeatingInvoices: RepeatingInvoiceSummary[] }>("/api/repeating-invoices", { organisationId });
  const items = useApiData<{ items: Item[] }>(editable ? "/api/items" : null, { organisationId });
  const changes = useApiData<{ priceChanges: PriceChange[] }>("/api/repeating-invoices/price-changes", { organisationId });
  const open = (templates.data?.repeatingInvoices ?? []).filter((template) => template.status !== "ended");

  const [chosen, setChosen] = useState<string[] | null>(null);
  const [method, setMethod] = useState<"percent" | "fixed">("percent");
  const [percent, setPercent] = useState("3");
  const [fixedPrice, setFixedPrice] = useState("");
  const [itemId, setItemId] = useState("");
  const [rounding, setRounding] = useState("cent");
  const [minimumIncrease, setMinimumIncrease] = useState("");
  const [effectiveDate, setEffectiveDate] = useState(todayInBrowser());
  const [note, setNote] = useState("");
  const [preview, setPreview] = useState<PriceChangePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [confirmUndo, setConfirmUndo] = useState<string | null>(null);

  const selected = chosen ?? open.map((template) => template.id);
  const body = () => ({
    organisationId,
    repeatingInvoiceIds: selected,
    method,
    percent: method === "percent" ? percent : undefined,
    fixedPrice: method === "fixed" ? fixedPrice : undefined,
    itemId: itemId || undefined,
    rounding,
    minimumIncrease: method === "percent" ? minimumIncrease : undefined,
    effectiveDate,
    note,
  });
  const changed = () => {
    setPreview(null);
    setSaved(null);
  };

  async function showPreview() {
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      setPreview((await api<{ preview: PriceChangePreview }>("/api/repeating-invoices/price-changes/preview", { method: "POST", body: body() })).preview);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const { priceChange } = await api<{ priceChange: PriceChange }>("/api/repeating-invoices/price-changes", { method: "POST", body: body() });
      const waiting = priceChange.lines.filter((line) => line.status === "waiting").length;
      setSaved(
        waiting > 0
          ? `Saved. ${priceChange.lines.length - waiting} line(s) changed now; ${waiting} wait for the first invoice dated ${formatDate(priceChange.effectiveDate)} or later.`
          : `Saved. ${priceChange.lines.length} line(s) changed.`,
      );
      setPreview(null);
      changes.reload();
      templates.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function undo(id: string) {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/repeating-invoices/price-changes/${id}/undo`, { method: "POST", body: { organisationId } });
      setConfirmUndo(null);
      changes.reload();
      templates.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {editable ? (
        <Card
          title="Change prices"
          description="Raise or lower the unit prices on many repeating invoices at once. Invoices already made keep their prices, and nothing posts."
        >
          {templates.error ? <Notice tone="error">{templates.error}</Notice> : null}
          {open.length === 0 && templates.data ? <Empty>No active or paused repeating invoices.</Empty> : null}
          {open.length > 0 ? (
            <>
              <fieldset className={ui.fieldSection}>
                <legend>Repeating invoices</legend>
                <label className={ui.checkbox}>
                  <input
                    type="checkbox"
                    checked={selected.length === open.length}
                    onChange={(event) => {
                      setChosen(event.target.checked ? open.map((template) => template.id) : []);
                      changed();
                    }}
                  />{" "}
                  All ({open.length})
                </label>
                {open.map((template) => (
                  <label key={template.id} className={ui.checkbox}>
                    <input
                      type="checkbox"
                      checked={selected.includes(template.id)}
                      onChange={(event) => {
                        setChosen(event.target.checked ? [...selected, template.id] : selected.filter((id) => id !== template.id));
                        changed();
                      }}
                    />{" "}
                    {template.contactName}
                    {template.reference ? ` · ${template.reference}` : ""} · <Money value={template.total} />
                    {template.status === "paused" ? " (paused)" : ""}
                  </label>
                ))}
              </fieldset>
              <div className={ui.grid}>
                <Field label="Change">
                  <select
                    value={method}
                    onChange={(event) => {
                      setMethod(event.target.value as "percent" | "fixed");
                      changed();
                    }}
                  >
                    <option value="percent">By a percentage</option>
                    <option value="fixed">Set one item&apos;s price</option>
                  </select>
                </Field>
                {method === "percent" ? (
                  <Field label="Percentage" hint="Negative to lower prices">
                    <input inputMode="decimal" value={percent} onChange={(event) => (setPercent(event.target.value), changed())} />
                  </Field>
                ) : (
                  <Field label="New price">
                    <input inputMode="decimal" value={fixedPrice} onChange={(event) => (setFixedPrice(event.target.value), changed())} />
                  </Field>
                )}
                <Field label={method === "fixed" ? "Item" : "Only lines for item"} hint={method === "fixed" ? undefined : "Blank for every line"}>
                  <select value={itemId} onChange={(event) => (setItemId(event.target.value), changed())}>
                    <option value="">{method === "fixed" ? "Choose…" : "Every line"}</option>
                    {(items.data?.items ?? [])
                      .filter((item) => !item.isArchived)
                      .map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.code ? `${item.code} · ` : ""}
                          {item.name}
                        </option>
                      ))}
                  </select>
                </Field>
                {method === "percent" ? (
                  <Field label="Minimum increase" hint="Optional">
                    <input inputMode="decimal" value={minimumIncrease} onChange={(event) => (setMinimumIncrease(event.target.value), changed())} />
                  </Field>
                ) : null}
                <Field label="Rounding">
                  <select value={rounding} onChange={(event) => (setRounding(event.target.value), changed())}>
                    {ROUNDING.map((entry) => (
                      <option key={entry.value} value={entry.value}>
                        {entry.label}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="New prices from" hint="Invoices dated on or after this use them">
                  <DateInput value={effectiveDate} onChange={(event) => (setEffectiveDate(event.target.value), changed())} />
                </Field>
                <Field label="Note" hint="Optional, e.g. 2027 price review">
                  <input value={note} maxLength={500} onChange={(event) => setNote(event.target.value)} />
                </Field>
              </div>
              <div className={ui.actions}>
                <Button variant="secondary" disabled={busy || selected.length === 0} onClick={() => void showPreview()}>
                  Preview
                </Button>
                {preview ? (
                  <Button disabled={busy || preview.linesChanged === 0} onClick={() => void save()}>
                    Save price change
                  </Button>
                ) : null}
              </div>
            </>
          ) : null}
          {error ? <Notice tone="error">{error}</Notice> : null}
          {saved ? <Notice tone="success">{saved}</Notice> : null}
          {preview ? <PreviewTable preview={preview} /> : null}
        </Card>
      ) : null}
      <Card title="Earlier price changes" description="Undo cancels what's still waiting and puts back the old price on lines still at the new one.">
        {changes.error ? <Notice tone="error">{changes.error}</Notice> : null}
        {changes.data && changes.data.priceChanges.length === 0 ? <Empty>No price changes yet.</Empty> : null}
        {(changes.data?.priceChanges ?? []).map((change) => (
          <section key={change.id} className={ui.reportSection}>
            <h3 className={ui.reportHeading}>
              {describeRule(change)} from {formatDate(change.effectiveDate)}{" "}
              <Badge tone={change.status === "saved" ? "blue" : "neutral"}>{change.status === "saved" ? "Saved" : change.status === "undone" ? "Undone" : "Cancelled"}</Badge>
            </h3>
            <p className={ui.muted}>
              {change.note ? `${change.note} · ` : ""}By {change.createdByEmail}
              {change.endedByEmail ? ` · ${change.status} by ${change.endedByEmail}` : ""}
            </p>
            <div className={ui.tableWrap}>
              <table className={`${ui.table} ${ui.stackOnPhone}`}>
                <thead>
                  <tr>
                    <th>Customer</th>
                    <th>Line</th>
                    <th className={ui.num}>Old price</th>
                    <th className={ui.num}>New price</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {change.lines.map((line) => (
                    <tr key={`${line.repeatingInvoiceId}-${line.lineOrder}`}>
                      <td data-label="Customer">{line.contactName}</td>
                      <td data-label="Line">{line.description}</td>
                      <td data-label="Old price" className={ui.num}>
                        <Money value={line.oldUnitPrice} />
                      </td>
                      <td data-label="New price" className={ui.num}>
                        <Money value={line.newUnitPrice} />
                      </td>
                      <td data-label="Status">
                        {LINE_STATUS[line.status] ?? line.status}
                        {line.message ? <div className={ui.muted}>{line.message}</div> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {editable && change.status === "saved" ? (
              <div className={ui.actions}>
                {confirmUndo === change.id ? (
                  <>
                    <Button variant="danger" size="small" disabled={busy} onClick={() => void undo(change.id)}>
                      Yes, undo it
                    </Button>
                    <Button variant="secondary" size="small" onClick={() => setConfirmUndo(null)}>
                      Keep it
                    </Button>
                  </>
                ) : (
                  <Button variant="secondary" size="small" onClick={() => setConfirmUndo(change.id)}>
                    Undo
                  </Button>
                )}
              </div>
            ) : null}
          </section>
        ))}
      </Card>
    </>
  );
}

function PreviewTable({ preview }: { preview: PriceChangePreview }) {
  return (
    <>
      <p>
        <strong>{preview.linesChanged}</strong> line{preview.linesChanged === 1 ? "" : "s"} would change. Nothing is saved until you press Save.
      </p>
      <div className={ui.tableWrap}>
        <table className={`${ui.table} ${ui.stackOnPhone}`}>
          <thead>
            <tr>
              <th>Customer</th>
              <th>Prices</th>
              <th>Line</th>
              <th className={ui.num}>Old price</th>
              <th className={ui.num}>New price</th>
              <th className={ui.num}>Invoice total</th>
            </tr>
          </thead>
          <tbody>
            {preview.templates.flatMap((template) =>
              template.lines.map((line, index) => (
                <tr key={`${template.repeatingInvoiceId}-${line.lineOrder}`}>
                  <td data-label="Customer">{index === 0 ? template.contactName : null}</td>
                  <td data-label="Prices">
                    {index === 0 ? (template.amountsMode === "inclusive" ? "Include GST" : template.amountsMode === "exclusive" ? "Exclude GST" : "No tax") : null}
                  </td>
                  <td data-label="Line">{line.description}</td>
                  <td data-label="Old price" className={ui.num}>
                    <Money value={line.oldUnitPrice} />
                  </td>
                  <td data-label="New price" className={ui.num}>
                    {line.notChanged ? (
                      <span className={ui.muted}>{line.notChanged}</span>
                    ) : (
                      <strong>
                        <Money value={line.newUnitPrice} />
                      </strong>
                    )}
                  </td>
                  <td data-label="Invoice total" className={ui.num}>
                    {index === 0 ? (
                      <>
                        <Money value={template.totalBefore} /> → <Money value={template.totalAfter} />
                      </>
                    ) : null}
                  </td>
                </tr>
              )),
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
