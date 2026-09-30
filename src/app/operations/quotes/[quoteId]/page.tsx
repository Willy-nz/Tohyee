"use client";

import Link from "next/link";
import { EmailDocumentPanel, pdfHref, useEmailedStatus } from "@/components/documents/email-document";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { RequireOrganisation } from "@/components/books";
import { CustomValuesText, useCustomFields } from "@/components/custom-fields";
import { SalesLinesTable } from "@/components/documents/lines-table";
import { ExchangeRateField, useLastRate } from "@/components/fx";
import { DocumentExportFlags } from "@/components/exports";
import { useApiData } from "@/components/hooks";
import { QuoteStatusBadge } from "@/components/quotes/quote-editor";
import { Badge, Button, Card, Field, Notice, Page, PageHeader, Stat, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import { formatDate, formatDateTime, todayInBrowser, personName } from "@/lib/format";
import type { Invoice } from "@/lib/invoices/service";
import { AMOUNTS_MODE_LABELS } from "@/lib/invoices/amounts";
import type { Quote } from "@/lib/quotes/service";

/** Finalise, accept, decline, copy, edit and delete (QT2-QT4, QT6). Each action has its own idempotency key. */
function QuoteActions({
  organisationId,
  quote,
  onChanged,
}: {
  organisationId: string;
  quote: Quote;
  onChanged: (quote: Quote, message: string) => void;
}) {
  const router = useRouter();
  const [finaliseKey] = useState(() => newIdempotencyKey("quote-finalise"));
  const [acceptKey] = useState(() => newIdempotencyKey("quote-accept"));
  const [declineKey] = useState(() => newIdempotencyKey("quote-decline"));
  const [copyKey] = useState(() => newIdempotencyKey("quote-copy"));
  const today = todayInBrowser();
  const [invoiceDate, setInvoiceDate] = useState(today < quote.quoteDate ? quote.quoteDate : today);
  const [dueDate, setDueDate] = useState("");
  const [copyDate, setCopyDate] = useState(today);
  // A quote in another currency (MC25) makes an invoice at a rate for the invoice date.
  const baseCurrency = useWorkspace().current?.baseCurrency ?? "NZD";
  const [typedRate, setTypedRate] = useState<string | null>(null);
  const suggestedRate = useLastRate(organisationId, quote.currencyCode, baseCurrency, invoiceDate);
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

  function finalise() {
    if (!window.confirm("Finalise this quote? It gets the next quote number and can't be edited after that.")) return;
    void run(async () => {
      const result = await api<{ quote: Quote }>(`/api/quotes/${quote.id}/finalise`, {
        method: "POST",
        body: { organisationId, source: "ui", idempotencyKey: finaliseKey },
      });
      onChanged(result.quote, `Finalised as ${result.quote.quoteNumber}.`);
    });
  }

  function accept() {
    if (!window.confirm(`Accept ${quote.quoteNumber}? This makes a draft invoice with the quote's lines.`)) return;
    void run(async () => {
      const result = await api<{ quote: Quote; invoice: Invoice }>(`/api/quotes/${quote.id}/accept`, {
        method: "POST",
        body: {
          organisationId,
          source: "ui",
          idempotencyKey: acceptKey,
          invoiceDate,
          dueDate: dueDate || null,
          ...(quote.currencyCode !== baseCurrency && typedRate !== null ? { exchangeRate: typedRate } : {}),
        },
      });
      router.push(`/operations/invoices/${result.invoice.id}`);
    });
  }

  function decline() {
    if (!window.confirm(`Mark ${quote.quoteNumber} as declined by the customer? It can't be accepted after that.`)) return;
    void run(async () => {
      const result = await api<{ quote: Quote }>(`/api/quotes/${quote.id}/decline`, {
        method: "POST",
        body: { organisationId, source: "ui", idempotencyKey: declineKey },
      });
      onChanged(result.quote, `${result.quote.quoteNumber} is declined.`);
    });
  }

  function copy() {
    void run(async () => {
      const result = await api<{ quote: Quote }>(`/api/quotes/${quote.id}/copy`, {
        method: "POST",
        body: { organisationId, source: "ui", idempotencyKey: copyKey, quoteDate: copyDate },
      });
      router.push(`/operations/quotes/${result.quote.id}`);
    });
  }

  function remove() {
    if (!window.confirm("Delete this draft? This can't be undone.")) return;
    void run(async () => {
      await api(`/api/quotes/${quote.id}`, { method: "DELETE", query: { organisationId } });
      router.push("/operations/quotes");
    });
  }

  return (
    <Card
      title="Actions"
      description={
        quote.status === "draft"
          ? "Drafts can be changed. Finalising gives the quote its number and locks it."
          : quote.status === "finalised"
            ? "When the customer answers: accepting makes a draft invoice with these lines (due on the date you give, or by the customer's payment terms); declining closes the quote."
            : "This quote is closed. Copy it to quote again."
      }
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      {quote.status === "draft" ? (
        <div className={ui.actions}>
          <Button onClick={finalise} disabled={busy}>
            {busy ? "Working…" : "Finalise"}
          </Button>
          <Button variant="secondary" onClick={() => router.push(`/operations/quotes/${quote.id}/edit`)} disabled={busy}>
            Edit
          </Button>
          <Button variant="danger" onClick={remove} disabled={busy}>
            Delete draft
          </Button>
        </div>
      ) : null}
      {quote.status === "finalised" ? (
        <>
          <div className={ui.inlineForm}>
            <Field label="Invoice date">
              <input type="date" value={invoiceDate} min={quote.quoteDate} onChange={(event) => setInvoiceDate(event.target.value)} required />
            </Field>
            <Field label="Due date" hint="Blank: the customer's payment terms.">
              <input type="date" value={dueDate} min={invoiceDate || undefined} onChange={(event) => setDueDate(event.target.value)} />
            </Field>
            <ExchangeRateField currencyCode={quote.currencyCode} baseCurrency={baseCurrency} suggested={suggestedRate} value={typedRate} onChange={setTypedRate} />
            <Button onClick={accept} disabled={busy || !invoiceDate}>
              {busy ? "Working…" : "Accept and make the invoice"}
            </Button>
          </div>
          <div className={ui.actions}>
            <Button variant="danger" onClick={decline} disabled={busy}>
              Declined by the customer
            </Button>
          </div>
        </>
      ) : null}
      <div className={ui.inlineForm}>
        <Field label="Copy to a new draft dated">
          <input type="date" value={copyDate} onChange={(event) => setCopyDate(event.target.value)} required />
        </Field>
        <Button variant="secondary" onClick={copy} disabled={busy || !copyDate}>
          Copy
        </Button>
      </div>
    </Card>
  );
}

function QuoteView({ organisationId, quoteId }: { organisationId: string; quoteId: string }) {
  const { can } = useWorkspace();
  const customSetup = useCustomFields(organisationId);
  const details = useApiData<{ quote: Quote }>(`/api/quotes/${encodeURIComponent(quoteId)}`, { organisationId });
  const [updated, setUpdated] = useState<Quote | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // "Sent" only from an email the email server accepted; the quote's own status doesn't change.
  const emailed = useEmailedStatus(organisationId, "quote", quoteId);
  if (details.error) {
    return (
      <>
        <Notice tone="error">{details.error}</Notice>
        <p>
          <Link href="/operations/quotes">Back to quotes</Link>
        </p>
      </>
    );
  }
  if (!details.data) return <p className={ui.muted}>Loading…</p>;
  const quote = updated ?? details.data.quote;
  const onChanged = (next: Quote, text: string) => {
    setUpdated(next);
    setMessage(text);
  };
  return (
    <>
      {message ? <Notice tone="success">{message}</Notice> : null}
      <Card
        title={quote.quoteNumber ?? `Draft #${quote.id}`}
        description={`To ${quote.contactName} · ${AMOUNTS_MODE_LABELS[quote.amountsMode]} · ${quote.currencyCode}`}
        actions={
          <>
            <QuoteStatusBadge quote={quote} />
            {emailed ? <Badge tone="green">Sent</Badge> : null}
            <Link href={`/operations/quotes/${quote.id}/print`}>Print or save as PDF</Link>
            <a href={pdfHref(organisationId, "quote", quote.id)} target="_blank" rel="noreferrer">
              PDF
            </a>
          </>
        }
      >
        <div className={ui.grid3}>
          <Stat label="Quote date" value={formatDate(quote.quoteDate)} />
          <Stat label="Expires" value={quote.expiryDate ? formatDate(quote.expiryDate) : "—"} />
          <Stat label="Reference" value={quote.reference ?? "—"} />
        </div>
        {quote.salespersonName ? <div className={ui.muted}>Salesperson: {quote.salespersonName}</div> : null}
        <DocumentExportFlags organisationId={organisationId} contactId={quote.contactId} lineTaxCodes={quote.lines.map((line) => line.taxCode)} />
        {quote.invoiceId ? (
          <div>
            Accepted: made invoice{" "}
            <Link href={`/operations/invoices/${quote.invoiceId}`}>{quote.invoiceNumber ?? `draft #${quote.invoiceId}`}</Link>.
          </div>
        ) : null}
        {quote.copiedFromQuoteId ? (
          <div className={ui.muted}>
            Copied from <Link href={`/operations/quotes/${quote.copiedFromQuoteId}`}>quote #{quote.copiedFromQuoteId}</Link>.
          </div>
        ) : null}
        {quote.terms ? <p style={{ whiteSpace: "pre-line" }}>{quote.terms}</p> : null}
        <CustomValuesText setup={customSetup.data} values={quote.customFields} />
        <SalesLinesTable organisationId={organisationId} document={quote} />
        <p className={ui.muted}>
          Saved by {personName(quote, "createdBy") ?? "unknown"} on {formatDateTime(quote.createdAt)}.
          {quote.finalisedAt ? ` Finalised by ${personName(quote, "finalisedBy") ?? "unknown"} on ${formatDateTime(quote.finalisedAt)}.` : ""}
          {quote.closedAt ? ` ${quote.status === "accepted" ? "Accepted" : "Declined"} by ${personName(quote, "closedBy") ?? "unknown"} on ${formatDateTime(quote.closedAt)}.` : ""}
        </p>
      </Card>
      {can("bookkeeper") ? <QuoteActions key={quote.status} organisationId={organisationId} quote={quote} onChanged={onChanged} /> : null}
      <EmailDocumentPanel
        organisationId={organisationId}
        kind="quote"
        id={quote.id}
        unavailableReason={quote.status === "draft" ? "Finalise the quote to email it." : null}
      />
      <p>
        <Link href="/operations/quotes">Back to quotes</Link>
      </p>
    </>
  );
}

export default function QuotePage() {
  const { quoteId } = useParams<{ quoteId: string }>();
  return (
    <Page>
      <PageHeader title="Quote" />
      <RequireOrganisation>{(organisationId) => <QuoteView organisationId={organisationId} quoteId={quoteId} />}</RequireOrganisation>
    </Page>
  );
}
