"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { Money, RequireOrganisation } from "@/components/books";
import { CreditStatusBadge } from "@/components/credit-notes/credit-note-editor";
import { useApiData } from "@/components/hooks";
import { OverpaymentApplications, OverpaymentRefunds } from "@/components/invoices/overpayment-credit";
import { Badge, Card, Notice, Page, PageHeader, Stat, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { formatDate } from "@/lib/format";
import type { CustomerPayment } from "@/lib/invoices/payments";

function journalHref(journalId: string): string {
  return `/operations/ledger-journals?journal=${journalId}`;
}

/**
 * A customer overpayment (examples OP1-OP8): the part of a payment beyond its
 * invoice's amount due. It's credit for the customer in accounts receivable,
 * to apply to their other invoices or refund.
 */
function OverpaymentView({ organisationId, paymentId }: { organisationId: string; paymentId: string }) {
  const details = useApiData<{ payment: CustomerPayment }>(`/api/overpayments/${encodeURIComponent(paymentId)}`, {
    organisationId,
  });
  // Applying, removing, refunding and voiding return the updated payment, which is shown straight away.
  const [updated, setUpdated] = useState<CustomerPayment | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const baseCurrency = useWorkspace().current?.baseCurrency ?? "NZD";

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
  const payment = updated ?? details.data.payment;
  const onChanged = (next: CustomerPayment, text: string) => {
    setUpdated(next);
    setMessage(text);
  };
  return (
    <>
      {message ? <Notice tone="success">{message}</Notice> : null}
      <Card
        title={`Overpayment on ${payment.invoiceNumber}`}
        description={`From ${payment.contactName} · ${payment.currencyCode}`}
        actions={
          payment.status === "voided" ? (
            <Badge tone="red">Payment voided</Badge>
          ) : payment.overpaymentStatus ? (
            <CreditStatusBadge status={payment.overpaymentStatus} />
          ) : null
        }
      >
        <div className={ui.grid4}>
          <Stat label="Payment date" value={formatDate(payment.paymentDate)} />
          <Stat
            label="Invoice"
            value={<Link href={`/operations/invoices/${payment.invoiceId}`}>{payment.invoiceNumber}</Link>}
          />
          <Stat label="Customer" value={payment.contactName} />
          <Stat label="Bank account" value={`${payment.bankAccountCode} · ${payment.bankAccountName}`} />
        </div>
        <div className={ui.statRow}>
          <Stat label="Received" value={<Money value={payment.amount} />} />
          <Stat label="Paid on the invoice" value={<Money value={payment.invoiceAmount} />} />
          <Stat label="Overpayment" value={<Money value={payment.overpaymentAmount} />} />
          <Stat label="Applied" value={<Money value={payment.overpaymentApplied} />} />
          <Stat label="Refunded" value={<Money value={payment.overpaymentRefunded} />} />
          <Stat label="Left" value={<Money value={payment.overpaymentRemaining} />} />
          {payment.exchangeRate ? (
            <Stat label={`Left (${baseCurrency}, at ${payment.exchangeRate})`} value={<Money value={payment.overpaymentRemainingBase ?? "0.00"} />} />
          ) : null}
        </div>
        <p className={ui.muted}>
          The whole payment was posted as{" "}
          <Link href={journalHref(payment.journalId)}>journal #{payment.journalId}</Link>: debit the bank account,
          credit accounts receivable. The overpayment sits in accounts receivable as credit for {payment.contactName}. No
          GST is posted on it, because the invoice already carried the GST.
          {payment.voidJournalId ? (
            <>
              {" "}
              The payment was voided on {formatDate(payment.voidDate)} by{" "}
              <Link href={journalHref(payment.voidJournalId)}>journal #{payment.voidJournalId}</Link>.
            </>
          ) : null}
        </p>
      </Card>
      <OverpaymentApplications organisationId={organisationId} payment={payment} onChanged={onChanged} />
      <OverpaymentRefunds organisationId={organisationId} payment={payment} onChanged={onChanged} />
      <p>
        <Link href={`/operations/invoices/${payment.invoiceId}`}>Back to {payment.invoiceNumber}</Link>
      </p>
    </>
  );
}

export default function OverpaymentPage() {
  const { paymentId } = useParams<{ paymentId: string }>();
  return (
    <Page>
      <PageHeader title="Overpayment" />
      <RequireOrganisation>
        {(organisationId) => <OverpaymentView organisationId={organisationId} paymentId={paymentId} />}
      </RequireOrganisation>
    </Page>
  );
}
