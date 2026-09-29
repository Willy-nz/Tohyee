"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { Money, RequireOrganisation } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { CustomValuesText, useCustomFields } from "@/components/custom-fields";
import { TrackingTagsText, useTracking } from "@/components/tracking";
import { formatRate, formatUnitPrice, InvoiceStatusBadge, PaidStatusBadge } from "@/components/invoices/invoice-editor";
import { InvoicePayments } from "@/components/invoices/invoice-payments";
import { Badge, Button, Card, Field, Notice, Page, PageHeader, Stat, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import type { CreditNoteApplication } from "@/lib/credit-notes/applications";
import type { CreditNoteSummary } from "@/lib/credit-notes/service";
import { formatDate, formatDateTime, formatMoney, formatQuantity, todayInBrowser } from "@/lib/format";
import { AMOUNTS_MODE_LABELS } from "@/lib/invoices/amounts";
import type { OverpaymentApplication } from "@/lib/invoices/overpayments";
import type { CustomerPayment } from "@/lib/invoices/payments";
import type { Invoice } from "@/lib/invoices/service";
import { RecordExtrasPanel } from "@/components/records/record-extras";

function journalHref(journalId: string): string {
  return `/operations/ledger-journals?journal=${journalId}`;
}

function InvoiceActions({
  organisationId,
  invoice,
  onChanged,
}: {
  organisationId: string;
  invoice: Invoice;
  onChanged: (invoice: Invoice, message: string) => void;
}) {
  const router = useRouter();
  // One key per action on this page, so a retry after a dropped connection
  // returns the first result instead of posting again.
  const [approveKey] = useState(() => newIdempotencyKey("invoice-approve"));
  const [voidKey] = useState(() => newIdempotencyKey("invoice-void"));
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
    if (!window.confirm(`Approve this invoice? It gets the next invoice number and is posted to the ledger on ${formatDate(invoice.invoiceDate)}. After that it can only be voided.`)) {
      return;
    }
    void run(async () => {
      const result = await api<{ invoice: Invoice }>(`/api/invoices/${invoice.id}/approve`, {
        method: "POST",
        body: { organisationId, source: "ui", idempotencyKey: approveKey },
      });
      onChanged(result.invoice, `Approved as ${result.invoice.invoiceNumber} and posted to the ledger.`);
    });
  }

  function remove() {
    if (!window.confirm("Delete this draft? This can't be undone.")) {
      return;
    }
    void run(async () => {
      await api(`/api/invoices/${invoice.id}`, { method: "DELETE", query: { organisationId } });
      router.push("/operations/invoices");
    });
  }

  function voidInvoice() {
    if (!window.confirm(`Void ${invoice.invoiceNumber}? This posts a reversal of its journal on ${formatDate(voidDate)}, and can't be undone.`)) {
      return;
    }
    void run(async () => {
      const result = await api<{ invoice: Invoice }>(`/api/invoices/${invoice.id}/void`, {
        method: "POST",
        body: { organisationId, source: "ui", idempotencyKey: voidKey, voidDate },
      });
      onChanged(
        result.invoice,
        `Voided ${result.invoice.invoiceNumber}. Its journal was reversed on ${formatDate(result.invoice.voidDate)}.`,
      );
    });
  }

  if (invoice.status === "voided") {
    return null;
  }
  // Examples CP5 and CN9: an invoice with active payments or credit applied is voided after they're removed.
  const hasPayments = invoice.status === "approved" && invoice.paidStatus !== "unpaid";
  return (
    <Card
      title={invoice.status === "draft" ? "Draft" : "Void"}
      description={
        invoice.status === "draft"
          ? "Drafts post nothing. Approving gives the invoice its number and posts it on the invoice date, if that date is in an open period."
          : "Voiding posts the exact reversal of the invoice's journal on the void date, which must be in an open period. The invoice keeps its number."
      }
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      {hasPayments ? (
        <Notice tone="info">
          This invoice has payments or credit against it. Void its payments and remove its credit first, then void the
          invoice.
        </Notice>
      ) : null}
      {invoice.status === "draft" ? (
        <div className={ui.actions}>
          <Button onClick={approve} disabled={busy}>
            {busy ? "Working…" : "Approve"}
          </Button>
          <Button variant="secondary" onClick={() => router.push(`/operations/invoices/${invoice.id}/edit`)} disabled={busy}>
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
              min={invoice.invoiceDate}
              onChange={(event) => setVoidDate(event.target.value)}
              required
            />
          </Field>
          <Button variant="danger" onClick={voidInvoice} disabled={busy || !voidDate || hasPayments}>
            {busy ? "Working…" : "Void invoice"}
          </Button>
        </div>
      )}
    </Card>
  );
}

/**
 * Credit applied to an invoice from credit notes (example CN3) and from
 * overpayments on the customer's other invoices (example OP2). Credit is
 * applied and removed on the credit note's or overpayment's page.
 */
function InvoiceCredit({
  creditApplied,
  overpaymentCreditApplied,
}: {
  creditApplied: CreditNoteApplication[];
  overpaymentCreditApplied: OverpaymentApplication[];
}) {
  const rows = [
    ...creditApplied.map((application) => ({
      id: `cn-${application.id}`,
      date: application.applicationDate,
      source: (
        <Link href={`/operations/credit-notes/${application.creditNoteId}`}>{application.creditNoteNumber}</Link>
      ),
      status: application.status,
      removalDate: application.removalDate,
      amount: application.amount,
    })),
    ...overpaymentCreditApplied.map((application) => ({
      id: `op-${application.id}`,
      date: application.applicationDate,
      source: (
        <Link href={`/operations/overpayments/${application.paymentId}`}>
          Overpayment on {application.sourceInvoiceNumber}
        </Link>
      ),
      status: application.status,
      removalDate: application.removalDate,
      amount: application.amount,
    })),
  ].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return (
    <Card
      title="Credit applied"
      description="Credit from credit notes and overpayments lowers the amount due without posting a journal. Apply or remove it on the credit note or overpayment."
    >
      <div className={ui.tableWrap}>
        <table className={ui.table}>
          <thead>
            <tr>
              <th>Date</th>
              <th>From</th>
              <th>Status</th>
              <th className={ui.num}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>{formatDate(row.date)}</td>
                <td>{row.source}</td>
                <td>
                  {row.status === "active" ? (
                    <Badge tone="green">Active</Badge>
                  ) : (
                    <>
                      <Badge tone="red">Removed</Badge>
                      <span className={ui.muted}> on {formatDate(row.removalDate)}</span>
                    </>
                  )}
                </td>
                <td className={ui.num}>
                  <Money value={row.amount} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/** Points to the customer's approved credit notes and overpayments that still have credit to apply. */
function UnusedCredit({ organisationId, invoice }: { organisationId: string; invoice: Invoice }) {
  const list = useApiData<{ creditNotes: CreditNoteSummary[] }>("/api/credit-notes", {
    organisationId,
    contactId: invoice.contactId,
    hasRemainingCredit: "true",
  });
  const overpaymentList = useApiData<{ overpayments: CustomerPayment[] }>("/api/overpayments", {
    organisationId,
    contactId: invoice.contactId,
    hasRemainingCredit: "true",
  });
  const creditNotes = (list.data?.creditNotes ?? []).filter((creditNote) => creditNote.currencyCode === invoice.currencyCode);
  const overpayments = (overpaymentList.data?.overpayments ?? []).filter(
    (payment) => payment.currencyCode === invoice.currencyCode && payment.invoiceId !== invoice.id,
  );
  if (creditNotes.length === 0 && overpayments.length === 0) {
    return null;
  }
  const sources = [
    ...creditNotes.map((creditNote) => (
      <span key={`cn-${creditNote.id}`}>
        <Link href={`/operations/credit-notes/${creditNote.id}`}>{creditNote.creditNoteNumber}</Link> (
        {formatMoney(creditNote.remainingCredit)} left)
      </span>
    )),
    ...overpayments.map((payment) => (
      <span key={`op-${payment.id}`}>
        <Link href={`/operations/overpayments/${payment.id}`}>the overpayment on {payment.invoiceNumber}</Link> (
        {formatMoney(payment.overpaymentRemaining)} left)
      </span>
    )),
  ];
  return (
    <Notice tone="info">
      {invoice.contactName} has unused credit:{" "}
      {sources.map((source, index) => (
        <span key={source.key}>
          {index > 0 ? ", " : ""}
          {source}
        </span>
      ))}
      . Apply it from the credit note or overpayment.
    </Notice>
  );
}

function InvoiceView({ organisationId, invoiceId }: { organisationId: string; invoiceId: string }) {
  const trackingSetup = useTracking(organisationId);
  const customSetup = useCustomFields(organisationId);
  const { can } = useWorkspace();
  const router = useRouter();
  const details = useApiData<{
    invoice: Invoice;
    creditApplied: CreditNoteApplication[];
    overpaymentCreditApplied: OverpaymentApplication[];
  }>(
    `/api/invoices/${encodeURIComponent(invoiceId)}`,
    { organisationId },
  );
  // Approving, voiding and payments return the updated invoice, which is shown straight away.
  const [updated, setUpdated] = useState<Invoice | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  if (details.error) {
    return (
      <>
        <Notice tone="error">{details.error}</Notice>
        <p>
          <Link href="/operations/invoices">Back to invoices</Link>
        </p>
      </>
    );
  }
  if (!details.data) {
    return <p className={ui.muted}>Loading…</p>;
  }
  const invoice = updated ?? details.data.invoice;
  const hasTax = invoice.amountsMode !== "no_tax";
  const { creditApplied, overpaymentCreditApplied } = details.data;
  return (
    <>
      {message ? <Notice tone="success">{message}</Notice> : null}
      {invoice.status === "approved" && invoice.paidStatus !== "paid" ? (
        <UnusedCredit organisationId={organisationId} invoice={invoice} />
      ) : null}
      <Card
        title={invoice.invoiceNumber ?? `Draft #${invoice.id}`}
        description={`To ${invoice.contactName} · ${AMOUNTS_MODE_LABELS[invoice.amountsMode]} · ${invoice.currencyCode}`}
        actions={
          <>
            <InvoiceStatusBadge status={invoice.status} />
            {invoice.paidStatus ? <PaidStatusBadge status={invoice.paidStatus} /> : null}
            {invoice.status === "approved" && can("bookkeeper") ? (
              <Button
                size="small"
                variant="secondary"
                onClick={() => router.push(`/operations/credit-notes/new?fromInvoice=${encodeURIComponent(invoice.id)}`)}
              >
                Create credit note
              </Button>
            ) : null}
          </>
        }
      >
        <div className={ui.grid4}>
          <Stat label="Invoice date" value={formatDate(invoice.invoiceDate)} />
          <Stat label="Due date" value={formatDate(invoice.dueDate)} />
          <Stat label="Reference" value={invoice.reference ?? "—"} />
          <Stat label="Customer" value={invoice.contactName} />
        </div>
        <CustomValuesText setup={customSetup.data} values={invoice.customFields} />
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
                  {invoice.amountsMode === "inclusive"
                    ? "Amount (incl. GST)"
                    : invoice.amountsMode === "exclusive"
                      ? "Amount (excl. GST)"
                      : "Amount"}
                </th>
              </tr>
            </thead>
            <tbody>
              {invoice.lines.map((line) => (
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
          <Stat label={hasTax ? "Subtotal (excl. GST)" : "Subtotal"} value={<Money value={invoice.subtotal} />} />
          {hasTax ? <Stat label="GST" value={<Money value={invoice.taxTotal} />} /> : null}
          <Stat label={`Total (${invoice.currencyCode})`} value={<Money value={invoice.total} />} />
          {invoice.status === "approved" ? (
            <>
              <Stat label="Paid" value={<Money value={invoice.amountPaid} />} />
              <Stat label="Credited" value={<Money value={invoice.amountCredited} />} />
              <Stat label="Amount due" value={<Money value={invoice.amountDue} />} />
            </>
          ) : null}
        </div>
        <p className={ui.muted}>
          Saved by {invoice.createdByEmail ?? "unknown"} on {formatDateTime(invoice.createdAt)}.
          {invoice.approvalJournalId ? (
            <>
              {" "}
              Approved by {invoice.approvedByEmail ?? "unknown"} on {formatDateTime(invoice.approvedAt)} and posted as{" "}
              <Link href={journalHref(invoice.approvalJournalId)}>journal #{invoice.approvalJournalId}</Link>.
            </>
          ) : null}
          {invoice.voidJournalId ? (
            <>
              {" "}
              Voided by {invoice.voidedByEmail ?? "unknown"} on {formatDateTime(invoice.voidedAt)}, reversed on{" "}
              {formatDate(invoice.voidDate)} by <Link href={journalHref(invoice.voidJournalId)}>journal #{invoice.voidJournalId}</Link>.
            </>
          ) : null}
        </p>
      </Card>
      {invoice.status !== "draft" ? (
        <InvoicePayments
          organisationId={organisationId}
          invoice={invoice}
          onChanged={(next, text) => {
            setUpdated(next);
            setMessage(text);
          }}
        />
      ) : null}
      {creditApplied.length > 0 || overpaymentCreditApplied.length > 0 ? (
        <InvoiceCredit creditApplied={creditApplied} overpaymentCreditApplied={overpaymentCreditApplied} />
      ) : null}
      {can("bookkeeper") ? (
        <InvoiceActions
          key={invoice.status}
          organisationId={organisationId}
          invoice={invoice}
          onChanged={(next, text) => {
            setUpdated(next);
            setMessage(text);
          }}
        />
      ) : null}
      <RecordExtrasPanel
        key={`${invoice.status}-${message ?? ""}`}
        organisationId={organisationId}
        recordType="sales_invoice"
        recordId={invoice.id}
      />
      <p>
        <Link href="/operations/invoices">Back to invoices</Link>
      </p>
    </>
  );
}

export default function InvoicePage() {
  const { invoiceId } = useParams<{ invoiceId: string }>();
  return (
    <Page>
      <PageHeader title="Invoice" />
      <RequireOrganisation>{(organisationId) => <InvoiceView organisationId={organisationId} invoiceId={invoiceId} />}</RequireOrganisation>
    </Page>
  );
}
