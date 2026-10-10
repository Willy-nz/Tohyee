"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { Money, RequireOrganisation } from "@/components/books";
import { CustomValuesText, useCustomFields } from "@/components/custom-fields";
import { ExchangeRateField, useLastRate } from "@/components/fx";
import { useApiData } from "@/components/hooks";
import { formatUnitPrice, InvoiceStatusBadge } from "@/components/invoices/invoice-editor";
import { SalesOrderStatusBadge } from "@/components/sales-orders/sales-order-editor";
import { TrackingTagsText, useTracking } from "@/components/tracking";
import { Button, Card, Field, Notice, Page, PageHeader, Stat, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import { formatDate, formatDateTime, formatQuantity, personName, todayInBrowser } from "@/lib/format";
import type { Invoice } from "@/lib/invoices/service";
import { AMOUNTS_MODE_LABELS } from "@/lib/invoices/amounts";
import { dec, isPositive } from "@/lib/money/decimal";
import type { SalesOrder } from "@/lib/sales-orders/service";
import { useConfirm } from "@/components/confirm-dialog";

/**
 * "Invoice" (SO3, SO4): a draft invoice for what's left on each line, or less.
 * Each quantity starts at what's left; zero leaves the line off.
 */
function InvoiceForm({ organisationId, salesOrder, busy, run }: { organisationId: string; salesOrder: SalesOrder; busy: boolean; run: (action: () => Promise<void>) => void }) {
  const router = useRouter();
  const [invoiceKey] = useState(() => newIdempotencyKey("so-invoice"));
  const today = todayInBrowser();
  const [invoiceDate, setInvoiceDate] = useState(today < salesOrder.orderDate ? salesOrder.orderDate : today);
  const [dueDate, setDueDate] = useState("");
  const left = salesOrder.lines.filter((line) => isPositive(dec(line.remainingQuantity)));
  const [quantities, setQuantities] = useState<Record<string, string>>(() => Object.fromEntries(left.map((line) => [line.id, line.remainingQuantity])));
  // An order in another currency (SO10) makes an invoice at a rate for the invoice date.
  const baseCurrency = useWorkspace().current?.baseCurrency ?? "NZD";
  const [typedRate, setTypedRate] = useState<string | null>(null);
  const suggestedRate = useLastRate(organisationId, salesOrder.currencyCode, baseCurrency, invoiceDate);

  function invoice() {
    run(async () => {
      const result = await api<{ salesOrder: SalesOrder; invoice: Invoice }>(`/api/sales-orders/${salesOrder.id}/invoice`, {
        method: "POST",
        body: {
          organisationId,
          source: "ui",
          idempotencyKey: invoiceKey,
          invoiceDate,
          dueDate: dueDate || null,
          lines: left.map((line) => ({ salesOrderLineId: line.id, quantity: (quantities[line.id] ?? "").trim() || "0" })),
          ...(salesOrder.currencyCode !== baseCurrency && typedRate !== null ? { exchangeRate: typedRate } : {}),
        },
      });
      router.push(`/operations/invoices/${result.invoice.id}`);
    });
  }

  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div className={ui.tableWrap}>
        <table className={`${ui.table} ${ui.stackOnPhone}`}>
          <thead>
            <tr>
              <th>Line</th>
              <th className={ui.num}>Left to invoice</th>
              <th className={ui.num} style={{ width: 130 }}>
                Invoice now
              </th>
            </tr>
          </thead>
          <tbody>
            {left.map((line) => (
              <tr key={line.id}>
                <td data-label="Line">{line.description}</td>
                <td data-label="Left to invoice" className={ui.num}>
                  {formatQuantity(line.remainingQuantity)}
                  {line.unitName ? ` ${line.unitName}` : ""}
                </td>
                <td data-label="Invoice now">
                  <input
                    aria-label={`${line.description} quantity to invoice`}
                    inputMode="decimal"
                    className={ui.num}
                    value={quantities[line.id] ?? ""}
                    onChange={(event) => setQuantities((current) => ({ ...current, [line.id]: event.target.value }))}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className={ui.inlineForm}>
        <Field label="Invoice date">
          <input type="date" value={invoiceDate} min={salesOrder.orderDate} onChange={(event) => setInvoiceDate(event.target.value)} required />
        </Field>
        <Field label="Due date" hint="Blank: the customer's payment terms.">
          <input type="date" value={dueDate} min={invoiceDate || undefined} onChange={(event) => setDueDate(event.target.value)} />
        </Field>
        <ExchangeRateField currencyCode={salesOrder.currencyCode} baseCurrency={baseCurrency} suggested={suggestedRate} value={typedRate} onChange={setTypedRate} />
        <Button onClick={invoice} disabled={busy || !invoiceDate}>
          {busy ? "Working…" : "Invoice"}
        </Button>
      </div>
    </div>
  );
}

/** Approve, invoice, close, cancel, edit and delete (SO2-SO8). Each action has its own idempotency key. */
function SalesOrderActions({
  organisationId,
  salesOrder,
  onChanged,
}: {
  organisationId: string;
  salesOrder: SalesOrder;
  onChanged: (salesOrder: SalesOrder, message: string) => void;
}) {
  const confirm = useConfirm();
  const router = useRouter();
  const [approveKey] = useState(() => newIdempotencyKey("so-approve"));
  const [closeKey] = useState(() => newIdempotencyKey("so-close"));
  const [cancelKey] = useState(() => newIdempotencyKey("so-cancel"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const status = salesOrder.status;
  const open = status === "pending_billing" || status === "partly_billed";
  const hasRemaining = salesOrder.lines.some((line) => isPositive(dec(line.remainingQuantity)));
  const draftInvoices = salesOrder.invoices.filter((invoice) => invoice.status === "draft");
  const activeInvoices = salesOrder.invoices.filter((invoice) => invoice.status !== "voided");

  function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        await action();
      } catch (caught) {
        setError(errorMessage(caught));
      } finally {
        setBusy(false);
      }
    })();
  }

  async function command(path: "approve" | "close" | "cancel", idempotencyKey: string, confirmText: string, message: (order: SalesOrder) => string) {
    if (!(await confirm(confirmText))) return;
    run(async () => {
      const result = await api<{ salesOrder: SalesOrder }>(`/api/sales-orders/${salesOrder.id}/${path}`, {
        method: "POST",
        body: { organisationId, source: "ui", idempotencyKey },
      });
      onChanged(result.salesOrder, message(result.salesOrder));
    });
  }

  async function remove() {
    if (!(await confirm("Delete this draft? This can't be undone."))) return;
    run(async () => {
      await api(`/api/sales-orders/${salesOrder.id}`, { method: "DELETE", query: { organisationId } });
      router.push("/operations/sales-orders");
    });
  }

  if (status === "cancelled" || status === "closed" || status === "billed") return null;
  return (
    <Card
      title="Actions"
      description={
        status === "draft"
          ? "Drafts can be changed. Approving gives the sales order its number and locks it."
          : "Invoice makes a draft invoice for what's left on each line. Lower a quantity for a part invoice, or set it to 0 to leave the line off."
      }
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      {status === "draft" ? (
        <div className={ui.actions}>
          <Button
            onClick={() =>
              command("approve", approveKey, "Approve this sales order? It gets the next sales order number and can't be edited after that.", (order) => `Approved as ${order.soNumber}.`)
            }
            disabled={busy}
          >
            {busy ? "Working…" : "Approve"}
          </Button>
          <Button variant="secondary" onClick={() => router.push(`/operations/sales-orders/${salesOrder.id}/edit`)} disabled={busy}>
            Edit
          </Button>
          {salesOrder.fromQuote ? null : (
            <Button variant="danger" onClick={remove} disabled={busy}>
              Delete draft
            </Button>
          )}
        </div>
      ) : null}
      {open && hasRemaining ? <InvoiceForm organisationId={organisationId} salesOrder={salesOrder} busy={busy} run={run} /> : null}
      {open && !hasRemaining ? (
        <p className={ui.muted}>Everything on this sales order is on invoices. Approve the draft invoices to finish billing it.</p>
      ) : null}
      {open ? (
        <div className={ui.actions}>
          <Button
            variant="secondary"
            onClick={() =>
              command(
                "close",
                closeKey,
                `Close ${salesOrder.soNumber}? Nothing more can be invoiced on it, and it can't be reopened.`,
                (order) => `${order.soNumber} is closed.`,
              )
            }
            disabled={busy || draftInvoices.length > 0}
          >
            Close sales order
          </Button>
          <Button
            variant="danger"
            onClick={() => command("cancel", cancelKey, `Cancel ${salesOrder.soNumber}? It can't be invoiced after that.`, (order) => `${order.soNumber} is cancelled.`)}
            disabled={busy || activeInvoices.length > 0}
          >
            Cancel sales order
          </Button>
          {draftInvoices.length > 0 ? <span className={ui.muted}>It has draft invoices: approve or delete them before closing it.</span> : null}
          {draftInvoices.length === 0 && activeInvoices.length > 0 ? (
            <span className={ui.muted}>It has invoices, so it can be closed but not cancelled.</span>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}

function LinesWithInvoicing({ organisationId, salesOrder }: { organisationId: string; salesOrder: SalesOrder }) {
  const tracking = useTracking(organisationId);
  const customSetup = useCustomFields(organisationId);
  const hasTax = salesOrder.amountsMode !== "no_tax";
  const discounted = salesOrder.lines.some((line) => line.discountPercent && Number(line.discountPercent) !== 0);
  const approved = salesOrder.status !== "draft";
  return (
    <>
      <div className={ui.tableWrap}>
        <table className={`${ui.table} ${ui.stackOnPhone}`}>
          <thead>
            <tr>
              <th>Description</th>
              <th className={ui.num}>Ordered</th>
              <th className={ui.num}>Unit price</th>
              {discounted ? <th className={ui.num}>Disc %</th> : null}
              <th>Account</th>
              {hasTax ? <th>Tax code</th> : null}
              <th className={ui.num}>Amount</th>
              {approved ? <th className={ui.num}>Invoiced</th> : null}
              {approved ? <th className={ui.num}>On draft invoices</th> : null}
              {approved ? <th className={ui.num}>Left to invoice</th> : null}
            </tr>
          </thead>
          <tbody>
            {salesOrder.lines.map((line) => (
              <tr key={line.id}>
                <td data-label="Description">{line.description}</td>
                <td data-label="Ordered" className={ui.num}>
                  {formatQuantity(line.quantity)}
                  {line.unitName ? ` ${line.unitName}` : ""}
                </td>
                <td data-label="Unit price" className={ui.num}>
                  {formatUnitPrice(line.unitPrice)}
                </td>
                {discounted ? (
                  <td data-label="Disc %" className={ui.num}>
                    {line.discountPercent && Number(line.discountPercent) !== 0 ? `${Number(line.discountPercent)}%` : ""}
                  </td>
                ) : null}
                <td data-label="Account">
                  {line.accountCode} · {line.accountName}
                  <TrackingTagsText setup={tracking.data} tags={line.tracking} />
                  <CustomValuesText setup={customSetup.data} values={line.customFields} />
                </td>
                {hasTax ? <td data-label="Tax code">{line.taxCode}</td> : null}
                <td data-label="Amount" className={ui.num}>
                  <Money value={line.lineAmount} />
                </td>
                {approved ? (
                  <td data-label="Invoiced" className={ui.num}>
                    {formatQuantity(line.invoicedQuantity)}
                  </td>
                ) : null}
                {approved ? (
                  <td data-label="On draft invoices" className={ui.num}>
                    {formatQuantity(line.onDraftInvoicesQuantity)}
                  </td>
                ) : null}
                {approved ? (
                  <td data-label="Left to invoice" className={ui.num}>
                    {formatQuantity(line.remainingQuantity)}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className={ui.statRow}>
        <Stat label={hasTax ? "Subtotal (excl. GST)" : "Subtotal"} value={<Money value={salesOrder.subtotal} />} />
        {hasTax ? <Stat label="GST" value={<Money value={salesOrder.taxTotal} />} /> : null}
        <Stat label={`Total (${salesOrder.currencyCode})`} value={<Money value={salesOrder.total} />} />
      </div>
    </>
  );
}

function SalesOrderView({ organisationId, salesOrderId }: { organisationId: string; salesOrderId: string }) {
  const { can } = useWorkspace();
  const customSetup = useCustomFields(organisationId);
  const details = useApiData<{ salesOrder: SalesOrder }>(`/api/sales-orders/${encodeURIComponent(salesOrderId)}`, { organisationId });
  const [updated, setUpdated] = useState<SalesOrder | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  if (details.error) {
    return (
      <>
        <Notice tone="error">{details.error}</Notice>
        <p>
          <Link href="/operations/sales-orders">Back to sales orders</Link>
        </p>
      </>
    );
  }
  if (!details.data) return <p className={ui.muted}>Loading…</p>;
  const salesOrder = updated ?? details.data.salesOrder;
  const onChanged = (next: SalesOrder, text: string) => {
    setUpdated(next);
    setMessage(text);
  };
  return (
    <>
      {message ? <Notice tone="success">{message}</Notice> : null}
      <Card
        title={salesOrder.soNumber ?? `Draft #${salesOrder.id}`}
        description={`To ${salesOrder.contactName} · ${AMOUNTS_MODE_LABELS[salesOrder.amountsMode]} · ${salesOrder.currencyCode}`}
        actions={<SalesOrderStatusBadge status={salesOrder.status} />}
      >
        <div className={ui.grid3}>
          <Stat label="Order date" value={formatDate(salesOrder.orderDate)} />
          <Stat label="Expected" value={salesOrder.expectedDate ? formatDate(salesOrder.expectedDate) : "—"} />
          <Stat label="Reference" value={salesOrder.reference ?? "—"} />
        </div>
        {salesOrder.salespersonName ? <div className={ui.muted}>Salesperson: {salesOrder.salespersonName}</div> : null}
        {salesOrder.fromQuote ? (
          <div className={ui.muted}>
            Made by accepting quote <Link href={`/operations/quotes/${salesOrder.fromQuote.id}`}>{salesOrder.fromQuote.quoteNumber}</Link>.
          </div>
        ) : null}
        {salesOrder.memo ? <p style={{ whiteSpace: "pre-line", margin: 0 }}>{salesOrder.memo}</p> : null}
        <CustomValuesText setup={customSetup.data} values={salesOrder.customFields} />
        <LinesWithInvoicing organisationId={organisationId} salesOrder={salesOrder} />
        <p className={ui.muted}>
          Saved by {personName(salesOrder, "createdBy") ?? "unknown"} on {formatDateTime(salesOrder.createdAt)}.
          {salesOrder.approvedAt ? ` Approved by ${personName(salesOrder, "approvedBy") ?? "unknown"} on ${formatDateTime(salesOrder.approvedAt)}.` : ""}
          {salesOrder.closedAt ? ` Closed by ${personName(salesOrder, "closedBy") ?? "unknown"} on ${formatDateTime(salesOrder.closedAt)}.` : ""}
          {salesOrder.cancelledAt ? ` Cancelled by ${personName(salesOrder, "cancelledBy") ?? "unknown"} on ${formatDateTime(salesOrder.cancelledAt)}.` : ""}
        </p>
      </Card>
      {can("bookkeeper") ? (
        <SalesOrderActions key={`${salesOrder.status}-${salesOrder.updatedAt}`} organisationId={organisationId} salesOrder={salesOrder} onChanged={onChanged} />
      ) : null}
      <Card title="Invoices" description="Invoices made from this sales order. Approved ones count as invoiced; voiding one gives its quantities back.">
        {salesOrder.invoices.length === 0 ? (
          <p className={ui.muted}>None yet.</p>
        ) : (
          <div className={ui.tableWrap}>
            <table className={`${ui.table} ${ui.stackOnPhone}`}>
              <thead>
                <tr>
                  <th>Number</th>
                  <th>Date</th>
                  <th>Status</th>
                  <th className={ui.num}>Total</th>
                </tr>
              </thead>
              <tbody>
                {salesOrder.invoices.map((invoice) => (
                  <tr key={invoice.id}>
                    <td data-label="Number">
                      <Link href={`/operations/invoices/${invoice.id}`}>{invoice.invoiceNumber ?? `Draft #${invoice.id}`}</Link>
                    </td>
                    <td data-label="Date">{formatDate(invoice.invoiceDate)}</td>
                    <td data-label="Status">
                      <InvoiceStatusBadge status={invoice.status} />
                    </td>
                    <td data-label="Total" className={ui.num}>
                      <Money value={invoice.total} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <p>
        <Link href="/operations/sales-orders">Back to sales orders</Link>
      </p>
    </>
  );
}

export default function SalesOrderPage() {
  const { salesOrderId } = useParams<{ salesOrderId: string }>();
  return (
    <Page>
      <PageHeader title="Sales order" />
      <RequireOrganisation>{(organisationId) => <SalesOrderView organisationId={organisationId} salesOrderId={salesOrderId} />}</RequireOrganisation>
    </Page>
  );
}
