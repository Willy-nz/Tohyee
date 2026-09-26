"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { Money, RequireOrganisation } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { formatRate, formatUnitPrice, InvoiceStatusBadge, PaidStatusBadge } from "@/components/invoices/invoice-editor";
import { InvoicePayments } from "@/components/invoices/invoice-payments";
import { Button, Card, Field, Notice, Page, PageHeader, Stat, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import { formatDate, formatDateTime, formatQuantity, todayInBrowser } from "@/lib/format";
import { AMOUNTS_MODE_LABELS } from "@/lib/invoices/amounts";
import type { Invoice } from "@/lib/invoices/service";

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
  // Example CP5: an invoice with active payments is voided after its payments.
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
        <Notice tone="info">This invoice has payments against it. Void its payments first, then void the invoice.</Notice>
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

function InvoiceView({ organisationId, invoiceId }: { organisationId: string; invoiceId: string }) {
  const { can } = useWorkspace();
  const details = useApiData<{ invoice: Invoice }>(`/api/invoices/${encodeURIComponent(invoiceId)}`, { organisationId });
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
  return (
    <>
      {message ? <Notice tone="success">{message}</Notice> : null}
      <Card
        title={invoice.invoiceNumber ?? `Draft #${invoice.id}`}
        description={`To ${invoice.contactName} · ${AMOUNTS_MODE_LABELS[invoice.amountsMode]} · ${invoice.currencyCode}`}
        actions={
          <>
            <InvoiceStatusBadge status={invoice.status} />
            {invoice.paidStatus ? <PaidStatusBadge status={invoice.paidStatus} /> : null}
          </>
        }
      >
        <div className={ui.grid4}>
          <Stat label="Invoice date" value={formatDate(invoice.invoiceDate)} />
          <Stat label="Due date" value={formatDate(invoice.dueDate)} />
          <Stat label="Reference" value={invoice.reference ?? "—"} />
          <Stat label="Customer" value={invoice.contactName} />
        </div>
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
