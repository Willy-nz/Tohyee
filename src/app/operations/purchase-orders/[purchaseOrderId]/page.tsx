"use client";

import Link from "next/link";
import { approvalBlocksApproving, DocumentApprovalPanel, useDocumentApproval, waitingForApproval } from "@/components/approvals";
import { EmailDocumentPanel, pdfHref } from "@/components/documents/email-document";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { Money, RequireOrganisation } from "@/components/books";
import { BillStatusBadge } from "@/components/bills/bill-editor";
import { CustomValuesText, useCustomFields } from "@/components/custom-fields";
import { ExchangeRateField, useLastRate } from "@/components/fx";
import { useApiData } from "@/components/hooks";
import { formatUnitPrice } from "@/components/invoices/invoice-editor";
import { PurchaseOrderStatusBadge } from "@/components/purchase-orders/purchase-order-editor";
import { TrackingTagsText, useTracking } from "@/components/tracking";
import { Button, Card, Field, Notice, Page, PageHeader, Stat, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import type { Bill } from "@/lib/bills/service";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import { formatDate, formatDateTime, formatQuantity, todayInBrowser, personName } from "@/lib/format";
import { AMOUNTS_MODE_LABELS } from "@/lib/invoices/amounts";
import { dec, isPositive } from "@/lib/money/decimal";
import type { PurchaseOrder } from "@/lib/purchase-orders/service";
import { useConfirm } from "@/components/confirm-dialog";

/** Approve, copy to bill, cancel, edit and delete (PO2-PO7). Each action has its own idempotency key. */
function PurchaseOrderActions({
  organisationId,
  purchaseOrder,
  onChanged,
}: {
  organisationId: string;
  purchaseOrder: PurchaseOrder;
  onChanged: (purchaseOrder: PurchaseOrder, message: string) => void;
}) {
  const confirm = useConfirm();
  const router = useRouter();
  // An approval rule that applies, or a waiting approval (AW11): submitted, not approved here.
  const approval = useDocumentApproval(organisationId, "purchase_order", purchaseOrder.id);
  const approvalState = approval.data?.approval;
  const [approveKey] = useState(() => newIdempotencyKey("po-approve"));
  const [copyKey] = useState(() => newIdempotencyKey("po-bill"));
  const [cancelKey] = useState(() => newIdempotencyKey("po-cancel"));
  const [closeKey] = useState(() => newIdempotencyKey("po-close"));
  const today = todayInBrowser();
  const [billDate, setBillDate] = useState(today);
  const [dueDate, setDueDate] = useState("");
  const [supplierInvoiceNumber, setSupplierInvoiceNumber] = useState("");
  // An order in another currency (MC28) makes a bill at a rate for the bill date.
  const baseCurrency = useWorkspace().current?.baseCurrency ?? "NZD";
  const [typedRate, setTypedRate] = useState<string | null>(null);
  const suggestedRate = useLastRate(organisationId, purchaseOrder.currencyCode, baseCurrency, billDate);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasRemaining = purchaseOrder.lines.some((line) => isPositive(dec(line.remainingQuantity)));
  const openBills = purchaseOrder.bills.filter((bill) => bill.status !== "voided");

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function approve() {
    if (!(await confirm("Approve this purchase order? It gets the next PO number and can't be edited after that."))) return;
    void run(async () => {
      const result = await api<{ purchaseOrder: PurchaseOrder }>(`/api/purchase-orders/${purchaseOrder.id}/approve`, {
        method: "POST",
        body: { organisationId, source: "ui", idempotencyKey: approveKey },
      });
      onChanged(result.purchaseOrder, `Approved as ${result.purchaseOrder.poNumber}.`);
    });
  }

  function copyToBill() {
    void run(async () => {
      const result = await api<{ purchaseOrder: PurchaseOrder; bill: Bill }>(`/api/purchase-orders/${purchaseOrder.id}/bill`, {
        method: "POST",
        body: {
          organisationId,
          source: "ui",
          idempotencyKey: copyKey,
          billDate,
          dueDate: dueDate || null,
          supplierInvoiceNumber,
          ...(purchaseOrder.currencyCode !== baseCurrency && typedRate !== null ? { exchangeRate: typedRate } : {}),
        },
      });
      router.push(`/operations/bills/${result.bill.id}`);
    });
  }

  async function close() {
    if (!(await confirm(`Close the rest of ${purchaseOrder.poNumber}? What's still to bill won't be on order any more, and it can't be copied to a bill after that.`))) return;
    void run(async () => {
      const result = await api<{ purchaseOrder: PurchaseOrder }>(`/api/purchase-orders/${purchaseOrder.id}/close`, {
        method: "POST",
        body: { organisationId, source: "ui", idempotencyKey: closeKey },
      });
      onChanged(result.purchaseOrder, `${result.purchaseOrder.poNumber} is closed.`);
    });
  }

  async function cancel() {
    if (!(await confirm(`Cancel ${purchaseOrder.poNumber}? It can't be billed after that.`))) return;
    void run(async () => {
      const result = await api<{ purchaseOrder: PurchaseOrder }>(`/api/purchase-orders/${purchaseOrder.id}/cancel`, {
        method: "POST",
        body: { organisationId, source: "ui", idempotencyKey: cancelKey },
      });
      onChanged(result.purchaseOrder, `${result.purchaseOrder.poNumber} is cancelled.`);
    });
  }

  async function remove() {
    if (!(await confirm("Delete this draft? This can't be undone."))) return;
    void run(async () => {
      await api(`/api/purchase-orders/${purchaseOrder.id}`, { method: "DELETE", query: { organisationId } });
      router.push("/operations/purchase-orders");
    });
  }

  if (purchaseOrder.status === "cancelled" || purchaseOrder.status === "closed") return null;
  return (
    <Card
      title="Actions"
      description={
        purchaseOrder.status === "draft"
          ? "Drafts can be changed. Approving gives the purchase order its number and locks it."
          : "When the supplier's invoice arrives, copy the purchase order to a bill: the draft bill gets what's still to bill on each line, and you can change it to match the invoice before approving it."
      }
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      {purchaseOrder.status === "draft" ? (
        <DocumentApprovalPanel
          organisationId={organisationId}
          documentType="purchase_order"
          documentId={purchaseOrder.id}
          documentStatus={purchaseOrder.status}
          approval={approvalState}
          canSubmit
          onChanged={(text) => {
            approval.reload();
            onChanged(purchaseOrder, text);
          }}
        />
      ) : null}
      {purchaseOrder.status === "draft" && (approval.data || approval.error) ? (
        <div className={ui.actions}>
          {approvalBlocksApproving(approvalState) ? null : (
            <Button onClick={approve} disabled={busy}>
              {busy ? "Working…" : "Approve"}
            </Button>
          )}
          {waitingForApproval(approvalState) ? null : (
            <>
              <Button variant="secondary" onClick={() => router.push(`/operations/purchase-orders/${purchaseOrder.id}/edit`)} disabled={busy}>
                Edit
              </Button>
              <Button variant="danger" onClick={remove} disabled={busy}>
                Delete draft
              </Button>
            </>
          )}
        </div>
      ) : null}
      {purchaseOrder.status === "approved" && hasRemaining ? (
        <div className={ui.inlineForm}>
          <Field label="Supplier's invoice number">
            <input value={supplierInvoiceNumber} onChange={(event) => setSupplierInvoiceNumber(event.target.value)} maxLength={100} required />
          </Field>
          <Field label="Bill date">
            <input type="date" value={billDate} onChange={(event) => setBillDate(event.target.value)} required />
          </Field>
          <Field label="Due date" hint="Leave blank to use the supplier's payment terms.">
            <input type="date" value={dueDate} min={billDate || undefined} onChange={(event) => setDueDate(event.target.value)} />
          </Field>
          <ExchangeRateField currencyCode={purchaseOrder.currencyCode} baseCurrency={baseCurrency} suggested={suggestedRate} value={typedRate} onChange={setTypedRate} />
          <Button onClick={copyToBill} disabled={busy || !supplierInvoiceNumber.trim() || !billDate}>
            {busy ? "Working…" : "Copy to bill"}
          </Button>
        </div>
      ) : null}
      {purchaseOrder.status === "approved" && !hasRemaining ? (
        <p className={ui.muted}>Everything on this purchase order is on bills. Approve the draft bills to finish billing it.</p>
      ) : null}
      {purchaseOrder.status === "approved" ? (
        <div className={ui.actions}>
          <Button variant="danger" onClick={cancel} disabled={busy || openBills.length > 0}>
            Cancel purchase order
          </Button>
          {openBills.length > 0 ? (
            <Button variant="secondary" onClick={close} disabled={busy || purchaseOrder.bills.some((bill) => bill.status === "draft")}>
              Close the rest
            </Button>
          ) : null}
          {openBills.length > 0 ? <span className={ui.muted}>It has bills, so it can&apos;t be cancelled.</span> : null}
        </div>
      ) : null}
    </Card>
  );
}

function LinesWithBilling({ organisationId, purchaseOrder }: { organisationId: string; purchaseOrder: PurchaseOrder }) {
  const tracking = useTracking(organisationId);
  const customSetup = useCustomFields(organisationId);
  const hasTax = purchaseOrder.amountsMode !== "no_tax";
  const approved = purchaseOrder.status !== "draft";
  return (
    <>
      <div className={ui.tableWrap}>
        <table className={`${ui.table} ${ui.stackOnPhone}`}>
          <thead>
            <tr>
              <th>Description</th>
              <th className={ui.num}>Ordered</th>
              <th className={ui.num}>Unit price</th>
              <th>Account</th>
              {hasTax ? <th>Tax code</th> : null}
              <th className={ui.num}>Amount</th>
              {approved ? <th className={ui.num}>Billed</th> : null}
              {approved ? <th className={ui.num}>On draft bills</th> : null}
              {approved ? <th className={ui.num}>Still to bill</th> : null}
            </tr>
          </thead>
          <tbody>
            {purchaseOrder.lines.map((line) => (
              <tr key={line.id}>
                <td data-label="Description">{line.description}</td>
                <td data-label="Ordered" className={ui.num}>
                  {formatQuantity(line.quantity)}
                  {line.unitName ? ` ${line.unitName}` : ""}
                </td>
                <td data-label="Unit price" className={ui.num}>
                  {formatUnitPrice(line.unitPrice)}
                </td>
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
                  <td data-label="Billed" className={ui.num}>
                    {formatQuantity(line.billedQuantity)}
                  </td>
                ) : null}
                {approved ? (
                  <td data-label="On draft bills" className={ui.num}>
                    {formatQuantity(line.onDraftBillsQuantity)}
                  </td>
                ) : null}
                {approved ? (
                  <td data-label="Still to bill" className={ui.num}>
                    {formatQuantity(line.remainingQuantity)}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className={ui.statRow}>
        <Stat label={hasTax ? "Subtotal (excl. GST)" : "Subtotal"} value={<Money value={purchaseOrder.subtotal} />} />
        {hasTax ? <Stat label="GST" value={<Money value={purchaseOrder.taxTotal} />} /> : null}
        <Stat label={`Total (${purchaseOrder.currencyCode})`} value={<Money value={purchaseOrder.total} />} />
      </div>
    </>
  );
}

function PurchaseOrderView({ organisationId, purchaseOrderId }: { organisationId: string; purchaseOrderId: string }) {
  const { can } = useWorkspace();
  const customSetup = useCustomFields(organisationId);
  const details = useApiData<{ purchaseOrder: PurchaseOrder }>(`/api/purchase-orders/${encodeURIComponent(purchaseOrderId)}`, { organisationId });
  const [updated, setUpdated] = useState<PurchaseOrder | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  if (details.error) {
    return (
      <>
        <Notice tone="error">{details.error}</Notice>
        <p>
          <Link href="/operations/purchase-orders">Back to purchase orders</Link>
        </p>
      </>
    );
  }
  if (!details.data) return <p className={ui.muted}>Loading…</p>;
  const purchaseOrder = updated ?? details.data.purchaseOrder;
  const onChanged = (next: PurchaseOrder, text: string) => {
    setUpdated(next);
    setMessage(text);
  };
  return (
    <>
      {message ? <Notice tone="success">{message}</Notice> : null}
      <Card
        title={purchaseOrder.poNumber ?? `Draft #${purchaseOrder.id}`}
        description={`To ${purchaseOrder.contactName} · ${AMOUNTS_MODE_LABELS[purchaseOrder.amountsMode]} · ${purchaseOrder.currencyCode}`}
        actions={
          <>
            <PurchaseOrderStatusBadge status={purchaseOrder.status} />
            <Link href={`/operations/purchase-orders/${purchaseOrder.id}/print`}>Print or save as PDF</Link>
            <a href={pdfHref(organisationId, "purchase_order", purchaseOrder.id)} target="_blank" rel="noreferrer">
              PDF
            </a>
          </>
        }
      >
        <div className={ui.grid3}>
          <Stat label="Order date" value={formatDate(purchaseOrder.orderDate)} />
          <Stat label="Delivery date" value={purchaseOrder.deliveryDate ? formatDate(purchaseOrder.deliveryDate) : "—"} />
          <Stat label="Reference" value={purchaseOrder.reference ?? "—"} />
        </div>
        {purchaseOrder.deliveryAddress || purchaseOrder.deliveryInstructions ? (
          <p style={{ whiteSpace: "pre-line", margin: 0 }}>
            <strong>Deliver to:</strong> {purchaseOrder.deliveryAddress ?? ""}
            {purchaseOrder.deliveryInstructions ? `\n${purchaseOrder.deliveryInstructions}` : ""}
          </p>
        ) : null}
        <CustomValuesText setup={customSetup.data} values={purchaseOrder.customFields} />
        <LinesWithBilling organisationId={organisationId} purchaseOrder={purchaseOrder} />
        {purchaseOrder.bills.length > 0 ? (
          <div>
            <strong>Bills</strong>
            <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
              {purchaseOrder.bills.map((bill) => (
                <li key={bill.id}>
                  <Link href={`/operations/bills/${bill.id}`}>{bill.supplierInvoiceNumber ?? "(no number yet)"}</Link> · {formatDate(bill.billDate)} ·{" "}
                  <Money value={bill.total} /> <BillStatusBadge status={bill.status} />
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <p className={ui.muted}>
          Saved by {personName(purchaseOrder, "createdBy") ?? "unknown"} on {formatDateTime(purchaseOrder.createdAt)}.
          {purchaseOrder.approvedAt ? ` Approved by ${personName(purchaseOrder, "approvedBy") ?? "unknown"} on ${formatDateTime(purchaseOrder.approvedAt)}.` : ""}
          {purchaseOrder.cancelledAt ? ` Cancelled by ${personName(purchaseOrder, "cancelledBy") ?? "unknown"} on ${formatDateTime(purchaseOrder.cancelledAt)}.` : ""}
        </p>
      </Card>
      {can("bookkeeper") ? (
        <PurchaseOrderActions key={purchaseOrder.status} organisationId={organisationId} purchaseOrder={purchaseOrder} onChanged={onChanged} />
      ) : null}
      <EmailDocumentPanel
        organisationId={organisationId}
        kind="purchase_order"
        id={purchaseOrder.id}
        unavailableReason={purchaseOrder.status === "draft" ? "Approve the purchase order to email it." : purchaseOrder.status === "cancelled" ? "A cancelled purchase order can't be emailed." : null}
      />
      <p>
        <Link href="/operations/purchase-orders">Back to purchase orders</Link>
      </p>
    </>
  );
}

export default function PurchaseOrderPage() {
  const { purchaseOrderId } = useParams<{ purchaseOrderId: string }>();
  return (
    <Page>
      <PageHeader title="Purchase order" />
      <RequireOrganisation>{(organisationId) => <PurchaseOrderView organisationId={organisationId} purchaseOrderId={purchaseOrderId} />}</RequireOrganisation>
    </Page>
  );
}
