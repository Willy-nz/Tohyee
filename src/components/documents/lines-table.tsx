"use client";

import { Money } from "@/components/books";
import { CustomValuesText, useCustomFields } from "@/components/custom-fields";
import { discountText, formatRate, formatUnitPrice } from "@/components/invoices/invoice-editor";
import { TrackingTagsText, useTracking } from "@/components/tracking";
import { Stat, ui } from "@/components/ui";
import { formatQuantity } from "@/lib/format";
import type { AmountsMode } from "@/lib/invoices/amounts";
import type { InvoiceLine } from "@/lib/invoices/service";

/**
 * A saved sales document's lines and totals, read only: quotes (QT1) and
 * repeating invoice templates (RI1) show them the way an invoice does, and
 * repeating bill templates (RB1), whose lines have the same fields.
 */
export function SalesLinesTable({
  organisationId,
  document,
}: {
  organisationId: string;
  document: { amountsMode: AmountsMode; currencyCode: string; subtotal: string; taxTotal: string; total: string; lines: InvoiceLine[] };
}) {
  const trackingSetup = useTracking(organisationId);
  const customSetup = useCustomFields(organisationId);
  const hasTax = document.amountsMode !== "no_tax";
  // The discount column only when a line has one (DS1-DS6).
  const discounted = document.lines.some((line) => line.discountPercent && Number(line.discountPercent) !== 0);
  return (
    <>
      <div className={ui.tableWrap}>
        <table className={`${ui.table} ${ui.stackOnPhone}`}>
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
                {document.amountsMode === "inclusive"
                  ? "Amount (incl. GST)"
                  : document.amountsMode === "exclusive"
                    ? "Amount (excl. GST)"
                    : "Amount"}
              </th>
            </tr>
          </thead>
          <tbody>
            {document.lines.map((line) => (
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
                    {discountText(line.discountPercent)}
                  </td>
                ) : null}
                <td data-label="Account">
                  {line.accountCode} · {line.accountName}
                  <TrackingTagsText setup={trackingSetup.data} tags={line.tracking} />
                  <CustomValuesText setup={customSetup.data} values={line.customFields} />
                </td>
                {hasTax ? (
                  <td data-label="Tax code">
                    {line.taxCode} ({formatRate(line.taxRate)})
                  </td>
                ) : null}
                {hasTax ? (
                  <td data-label="GST" className={ui.num}>
                    <Money value={line.taxAmount} />
                  </td>
                ) : null}
                <td data-label="Amount" className={ui.num}>
                  <Money value={line.lineAmount} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className={ui.statRow}>
        <Stat label={hasTax ? "Subtotal (excl. GST)" : "Subtotal"} value={<Money value={document.subtotal} />} />
        {hasTax ? <Stat label="GST" value={<Money value={document.taxTotal} />} /> : null}
        <Stat label={`Total (${document.currencyCode})`} value={<Money value={document.total} />} />
      </div>
    </>
  );
}
