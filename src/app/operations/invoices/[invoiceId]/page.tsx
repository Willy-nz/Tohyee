"use client";

import { DateInput } from "@/components/date-input";
import Link from "next/link";
import { EmailDocumentPanel, pdfHref } from "@/components/documents/email-document";
import { useParams, useRouter } from "next/navigation";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Money, RequireOrganisation } from "@/components/books";
import { DocumentExportFlags } from "@/components/exports";
import { useApiData } from "@/components/hooks";
import { ForeignTotals } from "@/components/fx-totals";
import { CustomValuesText, useCustomFields } from "@/components/custom-fields";
import { TrackingTagsText, useTracking } from "@/components/tracking";
import { formatRate, formatUnitPrice, InvoiceStatusBadge, PaidStatusBadge } from "@/components/invoices/invoice-editor";
import { InvoicePayments } from "@/components/invoices/invoice-payments";
import { Badge, Button, Card, Field, Notice, Page, PageHeader, Stat, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import type { CreditNoteApplication } from "@/lib/credit-notes/applications";
import type { CreditNoteSummary } from "@/lib/credit-notes/service";
import { formatDate, formatDateTime, formatMoney, formatQuantity, todayInBrowser, personName } from "@/lib/format";
import type { OverpaymentApplication } from "@/lib/invoices/overpayments";
import type { CustomerPayment } from "@/lib/invoices/payments";
import type { Invoice } from "@/lib/invoices/service";
import { InvoiceDirectDebitCard } from "@/components/direct-debit";
import { InvoicePayNowCard } from "@/components/online-payments";
import { RecordExtrasPanel } from "@/components/records/record-extras";
import { RecodeCard } from "@/components/recode";
import { useConfirm } from "@/components/confirm-dialog";
import { MoreMenu, type MoreMenuItem } from "@/components/more-menu";

function journalHref(journalId: string): string {
  return `/operations/ledger-journals?journal=${journalId}`;
}

type Panel = "payment" | "void" | "recode" | "email" | "notes";

/** Approve and delete for a draft: the header's Approve button and its ⋯ menu use these. */
function useDraftActions(organisationId: string, invoice: Invoice, onChanged: (invoice: Invoice, message: string, warning?: string) => void) {
  const confirm = useConfirm();
  const router = useRouter();
  // One key per action on this page, so a retry after a dropped connection
  // returns the first result instead of posting again.
  const [approveKey] = useState(() => newIdempotencyKey("invoice-approve"));
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

  async function approve() {
    if (!(await confirm(`Approve this invoice? It gets the next invoice number and is posted to the ledger on ${formatDate(invoice.invoiceDate)}. After that it can only be voided.`))) {
      return;
    }
    void run(async () => {
      const result = await api<{ invoice: Invoice; creditWarning?: string }>(`/api/invoices/${invoice.id}/approve`, {
        method: "POST",
        body: { organisationId, source: "ui", idempotencyKey: approveKey },
      });
      // Over the customer's credit limit with "warn": approved, and said so (RC3).
      onChanged(result.invoice, `Approved as ${result.invoice.invoiceNumber} and posted to the ledger.`, result.creditWarning);
    });
  }

  async function remove() {
    if (!(await confirm("Delete this draft? This can't be undone."))) {
      return;
    }
    void run(async () => {
      await api(`/api/invoices/${invoice.id}`, { method: "DELETE", query: { organisationId } });
      router.push("/operations/invoices");
    });
  }

  return { approve, remove, busy, error };
}

/** Voiding an approved invoice, opened from the ⋯ menu. The warning stays here and in the confirmation. */
function VoidInvoicePanel({
  organisationId,
  invoice,
  onChanged,
  onClose,
}: {
  organisationId: string;
  invoice: Invoice;
  onChanged: (invoice: Invoice, message: string) => void;
  onClose: () => void;
}) {
  const confirm = useConfirm();
  const [voidKey] = useState(() => newIdempotencyKey("invoice-void"));
  const [voidDate, setVoidDate] = useState(todayInBrowser());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function voidInvoice() {
    if (!(await confirm(`Void ${invoice.invoiceNumber}? This posts a reversal of its journal on ${formatDate(voidDate)}, and can't be undone.`))) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ invoice: Invoice }>(`/api/invoices/${invoice.id}/void`, {
        method: "POST",
        body: { organisationId, source: "ui", idempotencyKey: voidKey, voidDate },
      });
      onChanged(result.invoice, `Voided ${result.invoice.invoiceNumber}. Its journal was reversed on ${formatDate(result.invoice.voidDate)}.`);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  // Examples CP5 and CN9: an invoice with active payments or credit applied is voided after they're removed.
  const hasPayments = invoice.paidStatus !== "unpaid";
  return (
    <Card title="Void invoice" description="Posts the exact reversal of its journal on the void date, which must be in an open period. It keeps its number.">
      {error ? <Notice tone="error">{error}</Notice> : null}
      {hasPayments ? (
        <Notice tone="info">
          This invoice has payments or credit against it. Void its payments and remove its credit first, then void the
          invoice.
        </Notice>
      ) : null}
      <div className={ui.inlineForm}>
        <Field label="Void date">
          <DateInput value={voidDate} min={invoice.invoiceDate} onChange={(event) => setVoidDate(event.target.value)} required />
        </Field>
        <Button variant="danger" onClick={() => void voidInvoice()} disabled={busy || !voidDate || hasPayments}>
          {busy ? "Working…" : "Void invoice"}
        </Button>
        <Button variant="secondary" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}

/** A section opened from the header or the ⋯ menu: it scrolls into view and takes focus when opened. */
function OpenedPanel({ id, focus, children }: { id: string; focus: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focus || !ref.current) return;
    ref.current.scrollIntoView({ block: "start", behavior: "smooth" });
    const field = ref.current.querySelector<HTMLElement>("input, select, textarea, button");
    (field ?? ref.current).focus({ preventScroll: true });
  }, [focus]);
  return (
    <div id={id} ref={ref} tabIndex={-1} style={{ display: "grid", gap: 24, outline: "none" }}>
      {children}
    </div>
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
  const { can, current } = useWorkspace();
  const baseCurrency = current?.baseCurrency ?? "NZD";
  const details = useApiData<{
    invoice: Invoice;
    creditApplied: CreditNoteApplication[];
    overpaymentCreditApplied: OverpaymentApplication[];
    fromQuote: { id: string; quoteNumber: string } | null;
    fromRepeating: { id: string; scheduledDate: string } | null;
  }>(
    `/api/invoices/${encodeURIComponent(invoiceId)}`,
    { organisationId },
  );
  // Approving, voiding and payments return the updated invoice, which is shown straight away.
  const [updated, setUpdated] = useState<Invoice | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  // Sections opened from the header button or the ⋯ menu; the last one opened takes focus.
  const [panels, setPanels] = useState<Panel[]>([]);
  const [focused, setFocused] = useState<Panel | null>(null);
  const invoice = updated ?? details.data?.invoice ?? null;
  const changed = (next: Invoice, text: string, creditWarning?: string) => {
    setUpdated(next);
    setMessage(text);
    setWarning(creditWarning ?? null);
    setPanels((open) => open.filter((panel) => panel !== "void" && panel !== "payment"));
  };
  const draft = useDraftActions(organisationId, invoice ?? ({ id: invoiceId } as Invoice), changed);

  if (details.error) {
    return (
      <>
        <PageHeader title="Invoice" />
        <Notice tone="error">{details.error}</Notice>
        <p>
          <Link href="/operations/invoices">Back to invoices</Link>
        </p>
      </>
    );
  }
  if (!details.data || !invoice) {
    return (
      <>
        <PageHeader title="Invoice" />
        <p className={ui.muted}>Loading…</p>
      </>
    );
  }
  const open = (panel: Panel) => {
    setPanels((current) => (current.includes(panel) ? current : [...current, panel]));
    setFocused(panel);
  };
  const close = (panel: Panel) => setPanels((current) => current.filter((entry) => entry !== panel));
  const shown = (panel: Panel) => panels.includes(panel);
  const hasTax = invoice.amountsMode !== "no_tax";
  const discounted = invoice.lines.some((line) => line.discountPercent && Number(line.discountPercent) !== 0);
  const { creditApplied, overpaymentCreditApplied, fromQuote, fromRepeating } = details.data;
  const bookkeeper = can("bookkeeper");
  const pdf: MoreMenuItem = { label: "Download PDF", href: pdfHref(organisationId, "invoice", invoice.id), newTab: true };
  const notes: MoreMenuItem = { label: "Notes, files and history", onSelect: () => open("notes") };
  const email: MoreMenuItem = { label: "Email invoice", onSelect: () => open("email") };
  const menu: MoreMenuItem[] =
    invoice.status === "draft"
      ? bookkeeper
        ? [
            { label: "Edit", href: `/operations/invoices/${invoice.id}/edit` },
            pdf,
            notes,
            { label: "Delete draft", onSelect: () => void draft.remove(), danger: true, disabled: draft.busy },
          ]
        : [pdf, notes]
      : invoice.status === "approved"
        ? [
            ...(bookkeeper ? [email, { label: "Create credit note", href: `/operations/credit-notes/new?fromInvoice=${encodeURIComponent(invoice.id)}` }] : []),
            pdf,
            { label: "Recode a line", onSelect: () => open("recode") },
            notes,
            ...(bookkeeper ? [{ label: "Void invoice…", onSelect: () => open("void"), danger: true }] : []),
          ]
        : [pdf, { label: "Emails sent", onSelect: () => open("email") }, notes];
  return (
    <>
      <PageHeader
        title={invoice.invoiceNumber ?? `Draft #${invoice.id}`}
        actions={
          <>
            <InvoiceStatusBadge status={invoice.status} />
            {invoice.paidStatus ? <PaidStatusBadge status={invoice.paidStatus} /> : null}
            {bookkeeper && invoice.status === "draft" ? (
              <Button onClick={() => void draft.approve()} disabled={draft.busy}>
                {draft.busy ? "Working…" : "Approve"}
              </Button>
            ) : null}
            {bookkeeper && invoice.status === "approved" ? <Button onClick={() => open("payment")}>Record payment</Button> : null}
            <MoreMenu label="More invoice actions" items={menu} />
          </>
        }
      />
      {draft.error ? <Notice tone="error">{draft.error}</Notice> : null}
      {message ? <Notice tone="success">{message}</Notice> : null}
      {warning ? <Notice tone="warning">Over the credit limit: {warning}</Notice> : null}
      {invoice.status === "approved" && invoice.paidStatus !== "paid" ? (
        <UnusedCredit organisationId={organisationId} invoice={invoice} />
      ) : null}
      <Card>
        <div className={ui.grid4}>
          <Stat label="Customer" value={invoice.contactName} />
          <Stat label="Invoice date" value={formatDate(invoice.invoiceDate)} />
          <Stat label="Due date" value={formatDate(invoice.dueDate)} />
          <Stat label="Reference" value={invoice.reference ?? "—"} />
        </div>
        {invoice.salespersonName ? <div className={ui.muted}>Salesperson: {invoice.salespersonName}</div> : null}
        <DocumentExportFlags organisationId={organisationId} contactId={invoice.contactId} lineTaxCodes={invoice.lines.map((line) => line.taxCode)}
          editable={invoice.status === "draft"}
        />
        {fromQuote ? (
          <div className={ui.muted}>
            Made by accepting quote <Link href={`/operations/quotes/${fromQuote.id}`}>{fromQuote.quoteNumber}</Link>.
          </div>
        ) : null}
        {invoice.salesOrderId ? (
          <div className={ui.muted}>
            Made from sales order <Link href={`/operations/sales-orders/${invoice.salesOrderId}`}>{invoice.salesOrderNumber}</Link>.
          </div>
        ) : null}
        {fromRepeating ? (
          <div className={ui.muted}>
            Made by a <Link href={`/operations/repeating-invoices/${fromRepeating.id}`}>repeating invoice</Link> for{" "}
            {formatDate(fromRepeating.scheduledDate)}.
          </div>
        ) : null}
        <CustomValuesText setup={customSetup.data} values={invoice.customFields} />
        <div className={ui.tableWrap}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th>Description</th>
                <th className={ui.num}>Quantity</th>
                <th className={ui.num}>Unit price</th>
              {discounted ? <th className={ui.num}>Disc %</th> : null}
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
                  {discounted ? <td className={ui.num}>{line.discountPercent && Number(line.discountPercent) !== 0 ? `${Number(line.discountPercent)}%` : ""}</td> : null}
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
        <dl className={ui.totals} aria-label="Totals">
          <dt>{hasTax ? "Subtotal (excl. GST)" : "Subtotal"}</dt>
          <dd><Money value={invoice.subtotal} /></dd>
          {hasTax ? (
            <>
              <dt>GST</dt>
              <dd><Money value={invoice.taxTotal} /></dd>
            </>
          ) : null}
          <dt className={ui.totalsStrong}>Total ({invoice.currencyCode})</dt>
          <dd className={ui.totalsStrong}><Money value={invoice.total} /></dd>
          {invoice.status === "approved" ? (
            <>
              <dt>Paid</dt>
              <dd><Money value={invoice.amountPaid} /></dd>
              <dt>Credited</dt>
              <dd><Money value={invoice.amountCredited} /></dd>
              <dt className={ui.totalsStrong}>Amount due</dt>
              <dd className={ui.totalsStrong}><Money value={invoice.amountDue} /></dd>
            </>
          ) : null}
        </dl>
        <div className={ui.statRow}>
          <ForeignTotals document={invoice} baseCurrency={baseCurrency} hasTax={hasTax} openLabel="Due" openBase={invoice.amountDueBase} />
        </div>
        <p className={ui.muted}>
          Saved by {personName(invoice, "createdBy") ?? "unknown"} on {formatDateTime(invoice.createdAt)}.
          {invoice.approvalJournalId ? (
            <>
              {" "}
              Approved by {personName(invoice, "approvedBy") ?? "unknown"} on {formatDateTime(invoice.approvedAt)} and posted as{" "}
              <Link href={journalHref(invoice.approvalJournalId)}>journal #{invoice.approvalJournalId}</Link>.
            </>
          ) : null}
          {invoice.voidJournalId ? (
            <>
              {" "}
              Voided by {personName(invoice, "voidedBy") ?? "unknown"} on {formatDateTime(invoice.voidedAt)}, reversed on{" "}
              {formatDate(invoice.voidDate)} by <Link href={journalHref(invoice.voidJournalId)}>journal #{invoice.voidJournalId}</Link>.
            </>
          ) : null}
        </p>
      </Card>
      {invoice.status !== "draft" ? (
        <OpenedPanel id="invoice-payment" focus={focused === "payment" && shown("payment")}>
          <InvoicePayments
            organisationId={organisationId}
            invoice={invoice}
            recording={shown("payment")}
            onRecordingDone={() => close("payment")}
            onChanged={(next, text) => {
              setUpdated(next);
              setMessage(text);
            }}
          />
        </OpenedPanel>
      ) : null}
      {invoice.status !== "draft" ? (
        <InvoicePayNowCard organisationId={organisationId} invoiceId={invoice.id} refreshKey={`${invoice.status}-${invoice.amountDue ?? ""}`} />
      ) : null}
      {invoice.status !== "draft" ? (
        <InvoiceDirectDebitCard organisationId={organisationId} invoiceId={invoice.id} refreshKey={`${invoice.status}-${invoice.amountDue ?? ""}`} />
      ) : null}
      {creditApplied.length > 0 || overpaymentCreditApplied.length > 0 ? (
        <InvoiceCredit creditApplied={creditApplied} overpaymentCreditApplied={overpaymentCreditApplied} />
      ) : null}
      {invoice.status === "approved" && bookkeeper && shown("void") ? (
        <OpenedPanel id="invoice-void" focus={focused === "void"}>
          <VoidInvoicePanel key={invoice.status} organisationId={organisationId} invoice={invoice} onChanged={changed} onClose={() => close("void")} />
        </OpenedPanel>
      ) : null}
      {invoice.status === "approved" && shown("recode") ? (
        <OpenedPanel id="invoice-recode" focus={focused === "recode"}>
          <RecodeCard
            organisationId={organisationId}
            documentType="invoice"
            documentId={invoice.id}
            lines={invoice.lines}
            defaultOpen={bookkeeper}
            onRecoded={() => {
              setUpdated(null);
              details.reload();
            }}
          />
        </OpenedPanel>
      ) : null}
      {shown("email") ? (
        <OpenedPanel id="invoice-email" focus={focused === "email"}>
          <EmailDocumentPanel
            organisationId={organisationId}
            kind="invoice"
            id={invoice.id}
            defaultOpen={invoice.status === "approved"}
            unavailableReason={invoice.status === "draft" ? "Approve the invoice to email it." : invoice.status === "voided" ? "A voided invoice can't be emailed." : null}
          />
        </OpenedPanel>
      ) : null}
      {shown("notes") ? (
        <OpenedPanel id="invoice-notes" focus={focused === "notes"}>
          <RecordExtrasPanel
            key={`${invoice.status}-${message ?? ""}`}
            organisationId={organisationId}
            recordType="sales_invoice"
            recordId={invoice.id}
          />
        </OpenedPanel>
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
      <RequireOrganisation>{(organisationId) => <InvoiceView organisationId={organisationId} invoiceId={invoiceId} />}</RequireOrganisation>
    </Page>
  );
}
