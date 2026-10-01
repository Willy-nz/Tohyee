"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { BillStatusBadge } from "@/components/bills/bill-editor";
import { BillPayments } from "@/components/bills/bill-payments";
import { Money, RequireOrganisation } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { ForeignTotals } from "@/components/fx-totals";
import { CustomValuesText, useCustomFields } from "@/components/custom-fields";
import { TrackingTagsText, useTracking } from "@/components/tracking";
import { formatRate, formatUnitPrice, PaidStatusBadge } from "@/components/invoices/invoice-editor";
import { Badge, Button, Card, Field, Notice, Page, PageHeader, Stat, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import type { Bill } from "@/lib/bills/service";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import { formatDate, formatDateTime, formatMoney, formatQuantity, todayInBrowser, personName } from "@/lib/format";
import { AMOUNTS_MODE_LABELS } from "@/lib/invoices/amounts";
import type { SupplierCreditNoteApplication } from "@/lib/supplier-credit-notes/applications";
import type { SupplierCreditNoteSummary } from "@/lib/supplier-credit-notes/service";
import { RdLineTags } from "@/components/rd";
import { RecordExtrasPanel } from "@/components/records/record-extras";

function journalHref(journalId: string): string {
  return `/operations/ledger-journals?journal=${journalId}`;
}

function BillActions({
  organisationId,
  bill,
  onChanged,
}: {
  organisationId: string;
  bill: Bill;
  onChanged: (bill: Bill, message: string) => void;
}) {
  const router = useRouter();
  // One key per action on this page, so a retry after a dropped connection
  // returns the first result instead of posting again.
  const [approveKey] = useState(() => newIdempotencyKey("bill-approve"));
  const [voidKey] = useState(() => newIdempotencyKey("bill-void"));
  const [voidDate, setVoidDate] = useState(todayInBrowser());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  function approve() {
    if (!window.confirm(`Approve this bill? It's posted to the ledger on ${formatDate(bill.billDate)}, owing ${bill.contactName} through accounts payable. After that it can only be voided.`)) {
      return;
    }
    void run(async () => {
      const result = await api<{ bill: Bill }>(`/api/bills/${bill.id}/approve`, {
        method: "POST",
        body: { organisationId, source: "ui", idempotencyKey: approveKey },
      });
      onChanged(result.bill, `Approved bill ${result.bill.supplierInvoiceNumber} and posted it to the ledger.`);
    });
  }

  function remove() {
    if (!window.confirm("Delete this draft? This can't be undone.")) {
      return;
    }
    void run(async () => {
      await api(`/api/bills/${bill.id}`, { method: "DELETE", query: { organisationId } });
      router.push("/operations/bills");
    });
  }

  function voidBill() {
    if (!window.confirm(`Void bill ${bill.supplierInvoiceNumber}? This posts a reversal of its journal on ${formatDate(voidDate)}, and can't be undone.`)) {
      return;
    }
    void run(async () => {
      const result = await api<{ bill: Bill }>(`/api/bills/${bill.id}/void`, {
        method: "POST",
        body: { organisationId, source: "ui", idempotencyKey: voidKey, voidDate },
      });
      onChanged(
        result.bill,
        `Voided bill ${result.bill.supplierInvoiceNumber}. Its journal was reversed on ${formatDate(result.bill.voidDate)}.`,
      );
    });
  }

  if (bill.status === "voided") {
    return null;
  }
  // Examples SP5 and SCN9: a bill with active payments or credit applied is voided after they're removed.
  const hasPayments = bill.status === "approved" && bill.paidStatus !== "unpaid";
  return (
    <Card
      title={bill.status === "draft" ? "Draft" : "Void"}
      description={
        bill.status === "draft"
          ? "Drafts post nothing. Approving posts the bill on its bill date, if that date is in an open period."
          : "Voiding posts the exact reversal of the bill's journal on the void date, which must be in an open period."
      }
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      {hasPayments ? (
        <Notice tone="info">
          This bill has payments or credit against it. Void its payments and remove its credit first, then void the bill.
        </Notice>
      ) : null}
      {bill.status === "draft" ? (
        <div className={ui.actions}>
          <Button onClick={approve} disabled={busy}>
            {busy ? "Working…" : "Approve"}
          </Button>
          <Button variant="secondary" onClick={() => router.push(`/operations/bills/${bill.id}/edit`)} disabled={busy}>
            Edit
          </Button>
          <Button variant="danger" onClick={remove} disabled={busy}>
            Delete draft
          </Button>
        </div>
      ) : (
        <div className={ui.inlineForm}>
          <Field label="Void date">
            <input
              type="date"
              value={voidDate}
              min={bill.billDate}
              onChange={(event) => setVoidDate(event.target.value)}
              required
            />
          </Field>
          <Button variant="danger" onClick={voidBill} disabled={busy || !voidDate || hasPayments}>
            {busy ? "Working…" : "Void bill"}
          </Button>
        </div>
      )}
    </Card>
  );
}

/**
 * Credit applied to a bill from supplier credit notes (example SCN3). Credit
 * is applied and removed on the supplier credit note's page.
 */
function BillCredit({ creditApplied }: { creditApplied: SupplierCreditNoteApplication[] }) {
  return (
    <Card
      title="Credit applied"
      description="Credit from supplier credit notes lowers the amount due without posting a journal. Apply or remove it on the supplier credit note."
    >
      <div className={ui.tableWrap}>
        <table className={ui.table}>
          <thead>
            <tr>
              <th>Date</th>
              <th>Supplier credit note</th>
              <th>Status</th>
              <th className={ui.num}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {creditApplied.map((application) => (
              <tr key={application.id}>
                <td>{formatDate(application.applicationDate)}</td>
                <td>
                  <Link href={`/operations/supplier-credit-notes/${application.creditNoteId}`}>
                    {application.supplierCreditNoteNumber}
                  </Link>
                </td>
                <td>
                  {application.status === "active" ? (
                    <Badge tone="green">Active</Badge>
                  ) : (
                    <>
                      <Badge tone="red">Removed</Badge>
                      <span className={ui.muted}> on {formatDate(application.removalDate)}</span>
                    </>
                  )}
                </td>
                <td className={ui.num}>
                  <Money value={application.amount} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/** Points to the supplier's approved credit notes that still have credit to apply. */
function UnusedCredit({ organisationId, bill }: { organisationId: string; bill: Bill }) {
  const list = useApiData<{ creditNotes: SupplierCreditNoteSummary[] }>("/api/supplier-credit-notes", {
    organisationId,
    contactId: bill.contactId,
    hasRemainingCredit: "true",
  });
  const creditNotes = (list.data?.creditNotes ?? []).filter((creditNote) => creditNote.currencyCode === bill.currencyCode);
  if (creditNotes.length === 0) {
    return null;
  }
  return (
    <Notice tone="info">
      {bill.contactName} has unused credit:{" "}
      {creditNotes.map((creditNote, index) => (
        <span key={creditNote.id}>
          {index > 0 ? ", " : ""}
          <Link href={`/operations/supplier-credit-notes/${creditNote.id}`}>{creditNote.supplierCreditNoteNumber}</Link> (
          {formatMoney(creditNote.remainingCredit)} left)
        </span>
      ))}
      . Apply it from the supplier credit note.
    </Notice>
  );
}

function BillView({ organisationId, billId }: { organisationId: string; billId: string }) {
  const trackingSetup = useTracking(organisationId);
  const customSetup = useCustomFields(organisationId);
  const { can, current } = useWorkspace();
  const router = useRouter();
  const details = useApiData<{
    bill: Bill;
    creditApplied: SupplierCreditNoteApplication[];
    fromRepeating: { id: string; scheduledDate: string } | null;
  }>(
    `/api/bills/${encodeURIComponent(billId)}`,
    { organisationId },
  );
  // Approving and voiding return the updated bill, which is shown straight away.
  const [updated, setUpdated] = useState<Bill | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  if (details.error) {
    return (
      <>
        <Notice tone="error">{details.error}</Notice>
        <p>
          <Link href="/operations/bills">Back to bills</Link>
        </p>
      </>
    );
  }
  if (!details.data) {
    return <p className={ui.muted}>Loading…</p>;
  }
  const bill = updated ?? details.data.bill;
  const hasTax = bill.amountsMode !== "no_tax";
  const { creditApplied, fromRepeating } = details.data;
  return (
    <>
      {message ? <Notice tone="success">{message}</Notice> : null}
      {bill.status === "approved" && bill.paidStatus !== "paid" ? (
        <UnusedCredit organisationId={organisationId} bill={bill} />
      ) : null}
      <Card
        title={bill.supplierInvoiceNumber === null ? "Draft bill (no number yet)" : `Bill ${bill.supplierInvoiceNumber}`}
        description={`From ${bill.contactName} · ${AMOUNTS_MODE_LABELS[bill.amountsMode]} · ${bill.currencyCode}`}
        actions={
          <>
            <BillStatusBadge status={bill.status} />
            {bill.paidStatus ? <PaidStatusBadge status={bill.paidStatus} /> : null}
            {bill.status === "approved" && can("bookkeeper") ? (
              <Button
                size="small"
                variant="secondary"
                onClick={() => router.push(`/operations/supplier-credit-notes/new?fromBill=${encodeURIComponent(bill.id)}`)}
              >
                Create credit note
              </Button>
            ) : null}
          </>
        }
      >
        <div className={ui.grid4}>
          <Stat label="Bill date" value={formatDate(bill.billDate)} />
          <Stat label="Due date" value={formatDate(bill.dueDate)} />
          <Stat label="Supplier's invoice number" value={bill.supplierInvoiceNumber ?? "Not yet: add it from the supplier's invoice before approving"} />
          <Stat label="Supplier" value={bill.contactName} />
        </div>
        {bill.purchaseOrderId ? (
          <div>
            From purchase order <Link href={`/operations/purchase-orders/${bill.purchaseOrderId}`}>{bill.purchaseOrderNumber}</Link>.
          </div>
        ) : null}
        {fromRepeating ? (
          <div>
            Made by a <Link href={`/operations/repeating-bills/${fromRepeating.id}`}>repeating bill</Link> for {formatDate(fromRepeating.scheduledDate)}.
          </div>
        ) : null}
        <CustomValuesText setup={customSetup.data} values={bill.customFields} />
        <div className={ui.tableWrap}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th>Description</th>
                <th className={ui.num}>Quantity</th>
                <th className={ui.num}>Unit price</th>
                <th>Account</th>
                {hasTax ? <th>Tax code</th> : null}
                {hasTax ? <th className={ui.num}>GST</th> : null}
                <th className={ui.num}>
                  {bill.amountsMode === "inclusive"
                    ? "Amount (incl. GST)"
                    : bill.amountsMode === "exclusive"
                      ? "Amount (excl. GST)"
                      : "Amount"}
                </th>
              </tr>
            </thead>
            <tbody>
              {bill.lines.map((line) => (
                <tr key={line.lineOrder}>
                  <td>{line.description}</td>
                  <td className={ui.num}>{formatQuantity(line.quantity)}</td>
                  <td className={ui.num}>{formatUnitPrice(line.unitPrice)}</td>
                  <td>
                    {line.accountCode} · {line.accountName}
                    <TrackingTagsText setup={trackingSetup.data} tags={line.tracking} />
                    <CustomValuesText setup={customSetup.data} values={line.customFields} />
                  </td>
                  {hasTax ? (
                    <td>
                      {line.taxCode} ({formatRate(line.taxRate)})
                    </td>
                  ) : null}
                  {hasTax ? (
                    <td className={ui.num}>
                      <Money value={line.taxAmount} />
                    </td>
                  ) : null}
                  <td className={ui.num}>
                    <Money value={line.lineAmount} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className={ui.statRow}>
          <Stat label={hasTax ? "Subtotal (excl. GST)" : "Subtotal"} value={<Money value={bill.subtotal} />} />
          {hasTax ? <Stat label="GST" value={<Money value={bill.taxTotal} />} /> : null}
          <Stat label={`Total (${bill.currencyCode})`} value={<Money value={bill.total} />} />
          {bill.status === "approved" ? (
            <>
              <Stat label="Paid" value={<Money value={bill.amountPaid} />} />
              <Stat label="Credited" value={<Money value={bill.amountCredited} />} />
              <Stat label="Amount due" value={<Money value={bill.amountDue} />} />
            </>
          ) : null}
          <ForeignTotals document={bill} baseCurrency={current?.baseCurrency ?? "NZD"} hasTax={hasTax} openLabel="Due" openBase={bill.amountDueBase} />
        </div>
        <p className={ui.muted}>
          Bill #{bill.id}, saved by {personName(bill, "createdBy") ?? "unknown"} on {formatDateTime(bill.createdAt)}.
          {bill.approvalJournalId ? (
            <>
              {" "}
              Approved by {personName(bill, "approvedBy") ?? "unknown"} on {formatDateTime(bill.approvedAt)} and posted as{" "}
              <Link href={journalHref(bill.approvalJournalId)}>journal #{bill.approvalJournalId}</Link>.
            </>
          ) : null}
          {bill.voidJournalId ? (
            <>
              {" "}
              Voided by {personName(bill, "voidedBy") ?? "unknown"} on {formatDateTime(bill.voidedAt)}, reversed on{" "}
              {formatDate(bill.voidDate)} by <Link href={journalHref(bill.voidJournalId)}>journal #{bill.voidJournalId}</Link>.
            </>
          ) : null}
        </p>
      </Card>
      {bill.status !== "draft" ? (
        <BillPayments
          organisationId={organisationId}
          bill={bill}
          onChanged={(next, text) => {
            setUpdated(next);
            setMessage(text);
          }}
        />
      ) : null}
      {creditApplied.length > 0 ? <BillCredit creditApplied={creditApplied} /> : null}
      {can("bookkeeper") ? (
        <BillActions
          key={bill.status}
          organisationId={organisationId}
          bill={bill}
          onChanged={(next, text) => {
            setUpdated(next);
            setMessage(text);
          }}
        />
      ) : null}
      {bill.status === "approved" || bill.status === "voided" ? (
        <RdLineTags key={`rd-${bill.status}`} organisationId={organisationId} documentType="bill" documentId={bill.id} />
      ) : null}
      <RecordExtrasPanel
        key={`${bill.status}-${message ?? ""}`}
        organisationId={organisationId}
        recordType="bill"
        recordId={bill.id}
      />
      <p>
        <Link href="/operations/bills">Back to bills</Link>
      </p>
    </>
  );
}

export default function BillPage() {
  const { billId } = useParams<{ billId: string }>();
  return (
    <Page>
      <PageHeader title="Bill" />
      <RequireOrganisation>{(organisationId) => <BillView organisationId={organisationId} billId={billId} />}</RequireOrganisation>
    </Page>
  );
}
