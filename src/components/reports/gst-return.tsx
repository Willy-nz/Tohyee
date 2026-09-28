"use client";

import { type FormEvent, useEffect, useState } from "react";
import { Money } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Empty, Field, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import { formatDate, formatDateTime, todayInBrowser } from "@/lib/format";
import {
  GST_BOX_KEYS,
  GST_BOX_LABELS,
  GST_RETURN_PERIOD_MONTHS,
  gstBoxNumber,
  gstPeriodEnd,
  type GstAdjustment,
  type GstAdjustmentBox,
  type GstBoxKey,
  type GstReturnFigures,
} from "@/lib/reports/gst-boxes";
import type {
  FiledGstReturn,
  FiledGstReturnSummary,
  GstBasisChange,
  GstEventType,
  GstReturnLine,
} from "@/lib/reports/gst-return";
import { GST_BASIS_LABELS, type GstBasis, type TaxCategory } from "@/lib/tax/categories";

type Calculated = GstReturnFigures & {
  periodStart: string;
  periodEnd: string;
  months: number;
  basis: GstBasis;
  currencyCode: string;
  adjustments: GstAdjustment[];
  lines: GstReturnLine[];
  filedReturns: FiledGstReturnSummary[];
  basisChange: GstBasisChange | null;
};

/** What the report counts on each basis (docs/ACCOUNTING-EXAMPLES.md, G1-G18). */
const BASIS_DESCRIPTIONS: Record<GstBasis, string> = {
  invoice:
    "NZ GST101A on the invoice basis: sales invoices, credit notes, bills and supplier credit notes count when they're approved or voided.",
  payments:
    "NZ GST101A on the payments basis: invoices, bills and credit notes count when they're paid, credited or refunded, each line in proportion.",
  hybrid:
    "NZ GST101A on the hybrid basis: sales count when they're approved or voided; bills and supplier credit notes count when they're paid, credited or refunded.",
};

const EVENT_LABELS: Record<GstEventType, string> = {
  invoice_approved: "Invoice approved",
  invoice_voided: "Invoice voided",
  credit_note_approved: "Credit note approved",
  credit_note_voided: "Credit note voided",
  bill_approved: "Bill approved",
  bill_voided: "Bill voided",
  supplier_credit_note_approved: "Supplier credit note approved",
  supplier_credit_note_voided: "Supplier credit note voided",
  bank_transaction_posted: "Bank transaction",
  bank_transaction_voided: "Bank transaction voided",
  customer_payment: "Customer payment",
  customer_payment_voided: "Customer payment voided",
  credit_note_applied: "Credit applied",
  credit_note_application_removed: "Credit removed",
  credit_note_refunded: "Credit note refunded",
  credit_note_refund_voided: "Credit note refund voided",
  overpayment_applied: "Overpayment applied",
  overpayment_application_removed: "Overpayment removed",
  supplier_payment: "Supplier payment",
  supplier_payment_voided: "Supplier payment voided",
  supplier_credit_note_applied: "Supplier credit applied",
  supplier_credit_note_application_removed: "Supplier credit removed",
  supplier_credit_note_refunded: "Supplier refund received",
  supplier_credit_note_refund_voided: "Supplier refund voided",
};

const CATEGORY_LABELS: Record<TaxCategory, string> = {
  standard: "Standard rated",
  zero_rated: "Zero rated",
  exempt: "Exempt",
  out_of_scope: "Out of scope",
};

/** Which box's lines to show: a box, or the lines left out of every box. */
type Selection = GstBoxKey | "left_out";

/**
 * The lines behind a box. Boxes worked out from other boxes show the lines of
 * the boxes they come from; Box 9 and 13 are adjustments, not lines.
 */
function linesFor(lines: GstReturnLine[], selection: Selection): GstReturnLine[] {
  switch (selection) {
    case "box5":
    case "box7":
    case "box8":
    case "box10":
      return lines.filter((line) => line.boxes.includes("5"));
    case "box6":
      return lines.filter((line) => line.boxes.includes("6"));
    case "box11":
    case "box12":
    case "box14":
      return lines.filter((line) => line.boxes.includes("11"));
    case "box15":
      return lines.filter((line) => line.boxes.length > 0);
    case "left_out":
      return lines.filter((line) => line.boxes.length === 0);
    default:
      return [];
  }
}

function selectionTitle(selection: Selection): string {
  switch (selection) {
    case "left_out":
      return "Lines left out of every box";
    case "box7":
    case "box8":
    case "box10":
      return `Box ${gstBoxNumber(selection)}: worked out from the Box 5 lines`;
    case "box12":
    case "box14":
      return `Box ${gstBoxNumber(selection)}: worked out from the Box 11 lines`;
    case "box15":
      return "Box 15: every counted line";
    default:
      return `Box ${gstBoxNumber(selection)} lines`;
  }
}

function monthStart(isoDate: string): string {
  return `${isoDate.slice(0, 7)}-01`;
}

function BoxesTable({
  figures,
  selected,
  onSelect,
}: {
  figures: GstReturnFigures;
  selected: Selection | null;
  onSelect: (selection: Selection) => void;
}) {
  const { boxes, gstOnTransactions } = figures;
  return (
    <div className={ui.tableWrap}>
      <table className={ui.table}>
        <thead>
          <tr>
            <th>Box</th>
            <th>Description</th>
            <th className={ui.num}>Amount</th>
          </tr>
        </thead>
        <tbody>
          {GST_BOX_KEYS.map((box) => (
            <tr
              key={box}
              className={[
                ui.clickableRow,
                selected === box ? ui.selectedRow : "",
                box === "box10" || box === "box14" || box === "box15" ? ui.reportTotal : "",
              ]
                .filter(Boolean)
                .join(" ")}
              onClick={() => onSelect(box)}
            >
              <td>
                <Button variant="secondary" size="small" aria-label={`Show Box ${gstBoxNumber(box)}`}>
                  {gstBoxNumber(box)}
                </Button>
              </td>
              <td>
                {GST_BOX_LABELS[box]}
                {box === "box8" ? (
                  <span className={ui.muted}>
                    {" "}
                    · GST on transactions <Money value={gstOnTransactions.sales} />, difference{" "}
                    <Money value={gstOnTransactions.salesDifference} />
                  </span>
                ) : null}
                {box === "box12" ? (
                  <span className={ui.muted}>
                    {" "}
                    · GST on transactions <Money value={gstOnTransactions.purchases} />, difference{" "}
                    <Money value={gstOnTransactions.purchasesDifference} />
                  </span>
                ) : null}
              </td>
              <td className={ui.num}>
                <Money value={boxes[box]} />
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={2}>
              {boxes.box15.startsWith("-") ? (
                <Badge tone="green">Refund due</Badge>
              ) : boxes.box15 === "0.00" ? (
                <Badge>Nothing to pay</Badge>
              ) : (
                <Badge tone="amber">GST to pay</Badge>
              )}
            </td>
            <td className={ui.num}>
              <Money value={boxes.box15.replace(/^-/, "")} />
            </td>
          </tr>
        </tfoot>
      </table>
      <p className={ui.muted}>
        GST on transactions is the GST on each counted line, shown for information only; its difference from Box 8
        and Box 12 is rounding.{" "}
        <Button variant="secondary" size="small" onClick={() => onSelect("left_out")}>
          Show lines left out
        </Button>
      </p>
    </div>
  );
}

function LinesTable({ lines }: { lines: GstReturnLine[] }) {
  if (lines.length === 0) {
    return <Empty>No lines.</Empty>;
  }
  return (
    <div className={ui.tableWrap}>
      <table className={ui.table}>
        <thead>
          <tr>
            <th>Date</th>
            <th>Document</th>
            <th>Contact</th>
            <th>Event</th>
            <th>Line</th>
            <th>Category</th>
            <th className={ui.num}>Amount incl. GST</th>
            <th className={ui.num}>GST</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line, index) => (
            <tr key={`${line.eventType}-${line.documentId}-${line.documentLineOrder}-${index}`}>
              <td>{formatDate(line.eventDate)}</td>
              <td>
                {line.documentNumber}
                {line.reference ? <span className={ui.muted}> · {line.reference}</span> : null}
              </td>
              <td>{line.contactName}</td>
              <td>
                {EVENT_LABELS[line.eventType]}
                {line.settledAmount && line.documentTotal ? (
                  <span className={ui.muted}>
                    {" "}
                    · <Money value={line.settledAmount} /> of <Money value={line.documentTotal} />
                  </span>
                ) : null}
              </td>
              <td className={ui.muted}>
                {line.description}
                {line.taxCode ? ` · ${line.taxCode}` : ""}
              </td>
              <td>{CATEGORY_LABELS[line.category]}</td>
              <td className={ui.num}>
                <Money value={line.amount} />
              </td>
              <td className={ui.num}>
                <Money value={line.gst} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AdjustmentsTable({
  adjustments,
  onRemove,
}: {
  adjustments: GstAdjustment[];
  onRemove?: (index: number) => void;
}) {
  if (adjustments.length === 0) {
    return <p className={ui.muted}>No adjustments.</p>;
  }
  return (
    <div className={ui.tableWrap}>
      <table className={ui.table}>
        <thead>
          <tr>
            <th>Box</th>
            <th>Description</th>
            <th className={ui.num}>GST</th>
            {onRemove ? <th /> : null}
          </tr>
        </thead>
        <tbody>
          {adjustments.map((adjustment, index) => (
            <tr key={`${adjustment.box}-${index}`}>
              <td>{adjustment.box === "9" ? "Box 9 (debit)" : "Box 13 (credit)"}</td>
              <td>{adjustment.description}</td>
              <td className={ui.num}>
                <Money value={adjustment.amount} />
              </td>
              {onRemove ? (
                <td className={ui.num}>
                  <Button variant="secondary" size="small" onClick={() => onRemove(index)}>
                    Remove
                  </Button>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BoxDetail({
  figures,
  lines,
  adjustments,
  selected,
}: {
  figures: GstReturnFigures;
  lines: GstReturnLine[];
  adjustments: GstAdjustment[];
  selected: Selection | null;
}) {
  if (!selected) {
    return <p className={ui.muted}>Choose a box to see what&apos;s in it.</p>;
  }
  if (selected === "box9" || selected === "box13") {
    const box: GstAdjustmentBox = selected === "box9" ? "9" : "13";
    return (
      <>
        <h3>
          Box {box} adjustments (<Money value={figures.boxes[selected]} />)
        </h3>
        <AdjustmentsTable adjustments={adjustments.filter((adjustment) => adjustment.box === box)} />
      </>
    );
  }
  return (
    <>
      <h3>{selectionTitle(selected)}</h3>
      <LinesTable lines={linesFor(lines, selected)} />
    </>
  );
}

function FiledReturnDetail({ organisationId, gstReturnId }: { organisationId: string; gstReturnId: string }) {
  const detail = useApiData<FiledGstReturn>(`/api/gst-returns/${encodeURIComponent(gstReturnId)}`, { organisationId });
  const [selected, setSelected] = useState<Selection | null>(null);
  const filed = detail.data;
  return (
    <Card
      title={filed ? `Filed return ${formatDate(filed.periodStart)} to ${formatDate(filed.periodEnd)}` : "Filed return"}
      description={
        filed
          ? `Filed ${formatDateTime(filed.filedAt)} by ${filed.filedByEmail}. These are the figures as filed (${filed.currencyCode}, ${GST_BASIS_LABELS[filed.basis].toLowerCase()}).`
          : undefined
      }
    >
      {detail.error ? <Notice tone="error">{detail.error}</Notice> : null}
      {detail.loading ? <p className={ui.muted}>Loading…</p> : null}
      {filed ? (
        <>
          {filed.changedSinceFiled ? (
            <Notice tone="warning">
              <strong>Changed since filed.</strong> Something dated in this period was recorded, voided or removed after
              the return was filed. Amending a filed return isn&apos;t supported yet.
              <div className={ui.tableWrap}>
                <table className={ui.table}>
                  <thead>
                    <tr>
                      <th>Box</th>
                      <th className={ui.num}>Filed</th>
                      <th className={ui.num}>Now</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filed.changes.map((change) => (
                      <tr key={change.box}>
                        <td>Box {gstBoxNumber(change.box)}</td>
                        <td className={ui.num}>
                          <Money value={change.filed} />
                        </td>
                        <td className={ui.num}>
                          <Money value={change.current} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Notice>
          ) : null}
          {filed.currentError ? (
            <Notice tone="warning">The figures can&apos;t be worked out again now: {filed.currentError}</Notice>
          ) : null}
          <BoxesTable figures={filed} selected={selected} onSelect={setSelected} />
          <h3>Adjustments</h3>
          <AdjustmentsTable adjustments={filed.adjustments} />
          <BoxDetail figures={filed} lines={filed.lines} adjustments={filed.adjustments} selected={selected} />
        </>
      ) : null}
    </Card>
  );
}

/**
 * The IR546 adjustment for a change of GST basis since the last filed return
 * (G20, G21), with one click to add it as an adjustment.
 */
function BasisChangeNotice({
  change,
  added,
  onAdd,
}: {
  change: GstBasisChange;
  added: GstAdjustment[];
  onAdd: (adjustment: GstAdjustment) => void;
}) {
  const suggestion = change.suggestion;
  const alreadyAdded =
    suggestion !== null &&
    added.some(
      (adjustment) =>
        adjustment.box === suggestion.box &&
        adjustment.description === suggestion.description &&
        adjustment.amount === suggestion.amount,
    );
  return (
    <Notice tone="info">
      <strong>
        GST basis changed from {GST_BASIS_LABELS[change.from].toLowerCase()} to {GST_BASIS_LABELS[change.to].toLowerCase()}.
      </strong>{" "}
      The last return filed ended {formatDate(change.asAt)}. At that date GST on debtors was{" "}
      <Money value={change.debtorsGst} /> and GST on creditors <Money value={change.creditorsGst} />.{" "}
      {suggestion ? (
        <>
          IRD&apos;s IR546 calls for a {suggestion.box === "9" ? "Box 9 (debit)" : "Box 13 (credit)"} adjustment of{" "}
          <Money value={suggestion.amount} /> in the first return on the new basis.{" "}
          {alreadyAdded ? (
            <Badge tone="green">Added</Badge>
          ) : (
            <Button variant="secondary" size="small" onClick={() => onAdd(suggestion)}>
              Add this adjustment
            </Button>
          )}
        </>
      ) : (
        "No adjustment is needed."
      )}
    </Notice>
  );
}

/**
 * Reports -> GST return: pick a period, see boxes 5-15 laid out like the IRD
 * form, click a box for its lines, add Box 9 and 13 adjustments, and mark the
 * return as filed (admins). See "GST return" in docs/ACCOUNTING-EXAMPLES.md.
 */
export function GstReturnReport({ organisationId }: { organisationId: string }) {
  const { can } = useWorkspace();
  const [start, setStart] = useState(() => monthStart(todayInBrowser()));
  const [months, setMonths] = useState<number>(2);
  const periodEnd = gstPeriodEnd(start, months);
  const [adjustments, setAdjustments] = useState<GstAdjustment[]>([]);
  const [form, setForm] = useState<{ box: GstAdjustmentBox; description: string; amount: string }>({
    box: "9",
    description: "",
    amount: "",
  });
  const [formError, setFormError] = useState<string | null>(null);
  const [report, setReport] = useState<{ key: string; data: Calculated | null; error: string | null } | null>(null);
  const [selected, setSelected] = useState<Selection | null>(null);
  const [fileKey, setFileKey] = useState(() => newIdempotencyKey("gst"));
  const [filing, setFiling] = useState(false);
  const [status, setStatus] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [openReturn, setOpenReturn] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const filed = useApiData<{ gstReturns: FiledGstReturnSummary[] }>("/api/gst-returns", { organisationId });

  const requestKey = JSON.stringify({ organisationId, start, periodEnd, adjustments, version });
  useEffect(() => {
    let cancelled = false;
    api<Calculated>("/api/reports/gst-return", {
      method: "POST",
      body: { organisationId, periodStart: start, periodEnd, adjustments },
    }).then(
      (data) => {
        if (!cancelled) setReport({ key: requestKey, data, error: null });
      },
      (error) => {
        if (!cancelled) setReport({ key: requestKey, data: null, error: errorMessage(error) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [organisationId, start, periodEnd, adjustments, requestKey]);
  const current = report?.key === requestKey ? report : null;
  const data = current?.data ?? null;
  const alreadyFiled = data ? data.filedReturns.length > 0 : false;

  function changePeriod(nextStart: string, nextMonths: number) {
    setStart(nextStart);
    setMonths(nextMonths);
    setFileKey(newIdempotencyKey("gst"));
    setStatus(null);
  }

  /** The server checks an adjustment before it's kept, so a bad amount never replaces good figures. */
  async function keepAdjustment(adjustment: GstAdjustment): Promise<boolean> {
    try {
      const checked = await api<Calculated>("/api/reports/gst-return", {
        method: "POST",
        body: { organisationId, periodStart: start, periodEnd, adjustments: [...adjustments, adjustment] },
      });
      setAdjustments(checked.adjustments);
      setFormError(null);
      setFileKey(newIdempotencyKey("gst"));
      return true;
    } catch (caught) {
      setFormError(errorMessage(caught));
      return false;
    }
  }

  async function addAdjustment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (await keepAdjustment({ box: form.box, description: form.description.trim(), amount: form.amount.trim() })) {
      setForm({ ...form, description: "", amount: "" });
    }
  }

  function removeAdjustment(index: number) {
    setAdjustments(adjustments.filter((_, position) => position !== index));
    setFileKey(newIdempotencyKey("gst"));
  }

  async function markAsFiled() {
    if (
      !window.confirm(
        `Mark the GST return for ${formatDate(start)} to ${formatDate(periodEnd)} as filed? Its figures are stored as they are now and can't be changed.`,
      )
    ) {
      return;
    }
    setFiling(true);
    try {
      const result = await api<{ created: boolean; gstReturn: FiledGstReturn }>("/api/gst-returns", {
        method: "POST",
        body: { organisationId, idempotencyKey: fileKey, source: "ui", periodStart: start, periodEnd, adjustments },
      });
      setStatus({
        tone: "success",
        text: `Marked the GST return for ${formatDate(result.gstReturn.periodStart)} to ${formatDate(result.gstReturn.periodEnd)} as filed.`,
      });
      setFileKey(newIdempotencyKey("gst"));
      setOpenReturn(result.gstReturn.id);
      filed.reload();
      setVersion((value) => value + 1);
    } catch (caught) {
      setStatus({ tone: "error", text: errorMessage(caught) });
    } finally {
      setFiling(false);
    }
  }

  return (
    <>
      <Card
        title="GST return"
        description={data ? BASIS_DESCRIPTIONS[data.basis] : "NZ GST101A, worked out from the documents dated in the period."}
        actions={
          <div className={ui.inlineForm}>
            <Field label="Start month">
              <input
                type="month"
                value={start.slice(0, 7)}
                onChange={(event) => {
                  if (/^\d{4}-\d{2}$/.test(event.target.value)) changePeriod(`${event.target.value}-01`, months);
                }}
                required
              />
            </Field>
            <Field label="Length">
              <select value={months} onChange={(event) => changePeriod(start, Number(event.target.value))}>
                {GST_RETURN_PERIOD_MONTHS.map((length) => (
                  <option key={length} value={length}>
                    {length === 1 ? "1 month" : `${length} months`}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        }
      >
        <p className={ui.muted}>
          {formatDate(start)} to {formatDate(periodEnd)}
          {data ? ` · ${data.currencyCode}` : ""}
        </p>
        {status ? <Notice tone={status.tone}>{status.text}</Notice> : null}
        {current?.error ? <Notice tone="error">{current.error}</Notice> : null}
        {!current ? <p className={ui.muted}>Loading…</p> : null}
        {data ? (
          <>
            {alreadyFiled ? (
              <Notice tone="info">
                A return covering this period has already been filed (
                {data.filedReturns
                  .map((entry) => `${formatDate(entry.periodStart)} to ${formatDate(entry.periodEnd)}`)
                  .join(", ")}
                ). Its stored figures are under Filed returns.
              </Notice>
            ) : null}
            {data.basisChange ? (
              <BasisChangeNotice
                change={data.basisChange}
                added={adjustments}
                onAdd={(adjustment) => void keepAdjustment(adjustment)}
              />
            ) : null}
            <BoxesTable figures={data} selected={selected} onSelect={setSelected} />
            {can("admin") && !alreadyFiled ? (
              <div className={ui.actions}>
                <Button onClick={() => void markAsFiled()} disabled={filing}>
                  {filing ? "Filing…" : "Mark as filed"}
                </Button>
              </div>
            ) : null}
          </>
        ) : null}
      </Card>

      <Card
        title="Adjustments"
        description="GST amounts for Box 9 (debit adjustments, e.g. bad debt recovered) and Box 13 (credit adjustments, e.g. bad debt written off). They're only stored when the return is filed."
      >
        <AdjustmentsTable adjustments={adjustments} onRemove={removeAdjustment} />
        {formError ? <Notice tone="error">{formError}</Notice> : null}
        <form className={ui.inlineForm} onSubmit={(event) => void addAdjustment(event)}>
          <Field label="Box">
            <select
              value={form.box}
              onChange={(event) => setForm({ ...form, box: event.target.value === "13" ? "13" : "9" })}
            >
              <option value="9">Box 9 (debit)</option>
              <option value="13">Box 13 (credit)</option>
            </select>
          </Field>
          <Field label="Description">
            <input
              value={form.description}
              onChange={(event) => setForm({ ...form, description: event.target.value })}
              maxLength={200}
              required
            />
          </Field>
          <Field label="GST amount">
            <input
              value={form.amount}
              onChange={(event) => setForm({ ...form, amount: event.target.value })}
              inputMode="decimal"
              placeholder="0.00"
              required
            />
          </Field>
          <Button type="submit" variant="secondary">
            Add adjustment
          </Button>
        </form>
      </Card>

      {data ? (
        <Card title="What's in the boxes">
          <BoxDetail figures={data} lines={data.lines} adjustments={data.adjustments} selected={selected} />
        </Card>
      ) : null}

      <Card title="Filed returns" description="Stored as they were filed. Amending a filed return isn't supported yet.">
        {filed.error ? <Notice tone="error">{filed.error}</Notice> : null}
        {filed.loading ? <p className={ui.muted}>Loading…</p> : null}
        {filed.data ? (
          filed.data.gstReturns.length === 0 ? (
            <Empty>No GST returns filed yet.</Empty>
          ) : (
            <div className={ui.tableWrap}>
              <table className={ui.table}>
                <thead>
                  <tr>
                    <th>Period</th>
                    <th>Basis</th>
                    <th className={ui.num}>Box 15</th>
                    <th>Filed</th>
                  </tr>
                </thead>
                <tbody>
                  {filed.data.gstReturns.map((entry) => (
                    <tr
                      key={entry.id}
                      className={`${ui.clickableRow} ${openReturn === entry.id ? ui.selectedRow : ""}`}
                      onClick={() => setOpenReturn(entry.id)}
                    >
                      <td>
                        <Button variant="secondary" size="small">
                          {formatDate(entry.periodStart)} to {formatDate(entry.periodEnd)}
                        </Button>
                      </td>
                      <td>{GST_BASIS_LABELS[entry.basis]}</td>
                      <td className={ui.num}>
                        <Money value={entry.boxes.box15} />
                      </td>
                      <td className={ui.muted}>
                        {formatDateTime(entry.filedAt)} · {entry.filedByEmail}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : null}
      </Card>

      {openReturn ? (
        <FiledReturnDetail key={openReturn} organisationId={organisationId} gstReturnId={openReturn} />
      ) : null}
    </>
  );
}
