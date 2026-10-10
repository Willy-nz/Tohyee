"use client";

import Link from "next/link";
import { Money } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { OrganisationLogo } from "@/components/organisation/logo";
import { formatRate, formatUnitPrice } from "@/lib/documents/format";
import { PrintButton } from "@/components/reports/ledger-reports";
import { Card, Notice, ui } from "@/components/ui";
import type { PrintedDocument } from "@/lib/documents/print";
import type { PrintKind } from "@/lib/documents/tax-invoice";
import { formatDate, formatGstNumber, formatMoney, formatQuantity } from "@/lib/format";

const BACK: Record<PrintKind, (id: string) => string> = {
  invoice: (id) => `/operations/invoices/${id}`,
  credit_note: (id) => `/operations/credit-notes/${id}`,
  quote: (id) => `/operations/quotes/${id}`,
  purchase_order: (id) => `/operations/purchase-orders/${id}`,
};

const NUMBER_LABELS: Record<PrintKind, string> = {
  invoice: "Invoice number",
  credit_note: "Credit note number",
  quote: "Quote number",
  purchase_order: "Order number",
};

/**
 * A printable invoice, credit note, quote or purchase order (examples
 * PD1-PD8, PO8): the page
 * as it will print, with "Print or save as PDF" (the browser's print, as for
 * statements). Warnings (PD4, PD6) show on screen only.
 */
export function PrintedDocumentView({ organisationId, kind, id }: { organisationId: string; kind: PrintKind; id: string }) {
  const loaded = useApiData<{ document: PrintedDocument }>("/api/documents/print", { organisationId, kind, id });
  if (loaded.error) return <Notice tone="error">{loaded.error}</Notice>;
  if (!loaded.data) return <p className={ui.muted}>Loading…</p>;
  const doc = loaded.data.document;
  const { labels } = doc;
  const hasTax = doc.amountsMode !== "no_tax";
  const discounted = doc.lines.some((line) => line.discountPercent && Number(line.discountPercent) !== 0);
  const money = (value: string) => formatMoney(value);
  return (
    <>
      <div data-print="hide">
      <Card
        title={`${labels.title}${doc.number ? ` ${doc.number}` : ""}`}
        description="This is the page as it prints. Use your browser's print to save it as a PDF."
        actions={
          <>
            <PrintButton />
            <span data-print="hide">
              <Link href={BACK[kind](id)}>Back</Link>
            </span>
          </>
        }
      >
        {labels.warnings.map((warning) => (
          <Notice key={warning} tone="warning">
            {warning}
          </Notice>
        ))}
      </Card>
      </div>
      <article className={ui.reportPaper}>
        <header className={ui.reportPaperHeader} style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
          <div>
            <OrganisationLogo organisationId={organisationId} />
            <h2 className={ui.reportPaperTitle}>{labels.title}</h2>
            <p style={{ margin: 0, whiteSpace: "pre-line" }}>
              <strong>{doc.customer.name}</strong>
              {doc.customer.billingAddress ? `\n${doc.customer.billingAddress}` : ""}
              {!doc.customer.billingAddress && labels.buyerIdentifierRequired && doc.customer.contactIdentifier ? `\n${doc.customer.contactIdentifier}` : ""}
            </p>
          </div>
          <div style={{ whiteSpace: "pre-line" }}>
            <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "auto 1fr", gap: "2px 12px" }}>
              {doc.number ? (
                <>
                  <dt>{NUMBER_LABELS[kind]}</dt>
                  <dd style={{ margin: 0 }}>{doc.number}</dd>
                </>
              ) : null}
              <dt>{kind === "quote" ? "Quote date" : kind === "purchase_order" ? "Order date" : "Date"}</dt>
              <dd style={{ margin: 0 }}>{formatDate(doc.date)}</dd>
              {doc.dueDate ? (
                <>
                  <dt>Due date</dt>
                  <dd style={{ margin: 0 }}>{formatDate(doc.dueDate)}</dd>
                </>
              ) : null}
              {doc.deliveryDate ? (
                <>
                  <dt>Delivery date</dt>
                  <dd style={{ margin: 0 }}>{formatDate(doc.deliveryDate)}</dd>
                </>
              ) : null}
              {doc.expiryDate ? (
                <>
                  <dt>Expires</dt>
                  <dd style={{ margin: 0 }}>{formatDate(doc.expiryDate)}</dd>
                </>
              ) : null}
              {doc.reference ? (
                <>
                  <dt>Reference</dt>
                  <dd style={{ margin: 0 }}>{doc.reference}</dd>
                </>
              ) : null}
              {doc.organisation.gstNumber ? (
                <>
                  <dt>GST number</dt>
                  <dd style={{ margin: 0 }}>{formatGstNumber(doc.organisation.gstNumber)}</dd>
                </>
              ) : null}
            </dl>
          </div>
          <div style={{ whiteSpace: "pre-line" }}>
            <strong>{doc.organisation.name}</strong>
            {doc.organisation.postalAddress ? `\n${doc.organisation.postalAddress}` : ""}
          </div>
        </header>
        <div className={ui.tableWrap}>
          <table className={`${ui.table} ${ui.stackOnPhone}`}>
            <thead>
              <tr>
                <th>Description</th>
                <th className={ui.num}>Quantity</th>
                <th className={ui.num}>Unit price</th>
              {discounted ? <th className={ui.num}>Disc %</th> : null}
                {hasTax ? <th className={ui.num}>GST</th> : null}
                <th className={ui.num}>
                  Amount {doc.amountsMode === "inclusive" ? "(incl. GST)" : doc.amountsMode === "exclusive" ? "(excl. GST)" : ""} ({doc.currencyCode})
                </th>
              </tr>
            </thead>
            <tbody>
              {doc.lines.map((line) => (
                <tr key={line.lineOrder}>
                  <td data-label="Description">{line.description}</td>
                  <td data-label="Quantity" className={ui.num}>
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
                  {hasTax ? (
                    <td data-label="GST" className={ui.num}>
                      {formatRate(line.taxRate)}
                    </td>
                  ) : null}
                  <td data-label="Amount" className={ui.num}>
                    <Money value={line.lineAmount} />
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              {labels.gstLine ? (
                <>
                  <tr>
                    <td colSpan={(hasTax ? 4 : 3) + (discounted ? 1 : 0)}>Subtotal</td>
                    <td className={ui.num}>
                      <Money value={doc.subtotal} />
                    </td>
                  </tr>
                  <tr>
                    <td colSpan={4 + (discounted ? 1 : 0)}>Total GST</td>
                    <td className={ui.num}>
                      <Money value={doc.taxTotal} />
                    </td>
                  </tr>
                </>
              ) : null}
              <tr>
                <td colSpan={(hasTax ? 4 : 3) + (discounted ? 1 : 0)}>
                  <strong>Total {doc.currencyCode}</strong>
                </td>
                <td className={ui.num}>
                  <strong>
                    <Money value={doc.total} />
                  </strong>
                </td>
              </tr>
              {doc.amountDue !== null && doc.amountPaid !== null ? (
                <>
                  <tr>
                    <td colSpan={(hasTax ? 4 : 3) + (discounted ? 1 : 0)}>Paid or credited</td>
                    <td className={ui.num}>
                      <Money value={doc.amountPaid} />
                    </td>
                  </tr>
                  <tr>
                    <td colSpan={(hasTax ? 4 : 3) + (discounted ? 1 : 0)}>
                      <strong>Amount due {doc.currencyCode}</strong>
                    </td>
                    <td className={ui.num}>
                      <strong>
                        <Money value={doc.amountDue} />
                      </strong>
                    </td>
                  </tr>
                </>
              ) : null}
            </tfoot>
          </table>
        </div>
        {labels.includesGstStatement ? <p>Total includes GST of ${money(doc.taxTotal)}.</p> : null}
        {doc.deliveryAddress || doc.deliveryInstructions ? (
          <section className={ui.reportPaperBlock}>
            <strong>Deliver to</strong>
            <p style={{ margin: 0, whiteSpace: "pre-line" }}>
              {doc.deliveryAddress ?? ""}
              {doc.deliveryInstructions ? `${doc.deliveryAddress ? "\n" : ""}${doc.deliveryInstructions}` : ""}
            </p>
          </section>
        ) : null}
        {doc.terms ? <p style={{ whiteSpace: "pre-line" }}>{doc.terms}</p> : null}
        {doc.paymentDetails ? (
          <section className={ui.reportPaperBlock}>
            <strong>How to pay</strong>
            <p style={{ margin: 0, whiteSpace: "pre-line" }}>
              {doc.dueDate ? `Due ${formatDate(doc.dueDate)}. ` : ""}
              {doc.paymentDetails}
            </p>
          </section>
        ) : null}
        {doc.payNowUrl || doc.payPalUrl ? (
          <section className={ui.reportPaperBlock}>
            <strong>Pay now</strong>
            {doc.payNowUrl ? (
              <p style={{ margin: 0, overflowWrap: "anywhere" }}>
                Pay online by card: <a href={doc.payNowUrl}>{doc.payNowUrl}</a>
              </p>
            ) : null}
            {doc.payPalUrl ? (
              <p style={{ margin: 0, overflowWrap: "anywhere" }}>
                Pay with PayPal: <a href={doc.payPalUrl}>{doc.payPalUrl}</a>
              </p>
            ) : null}
          </section>
        ) : null}
      </article>
    </>
  );
}
