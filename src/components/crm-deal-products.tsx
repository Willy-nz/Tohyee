"use client";

import Link from "next/link";
import { useState } from "react";
import { amountIn, useBaseCurrency, useBusy } from "@/components/crm";
import { useApiData } from "@/components/hooks";
import { discountText } from "@/components/invoices/invoice-editor";
import { useItems } from "@/components/items";
import { Badge, Button, Card, Empty, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, newIdempotencyKey } from "@/lib/client/api";
import type { DealLine, DealQuote } from "@/lib/crm/deal-lines";
import type { Opportunity } from "@/lib/crm/service";
import { formatDate, formatMoney } from "@/lib/format";
import { discountedLineAmount } from "@/lib/invoices/amounts";
import { currencyMinorUnits } from "@/lib/money/currency";
import { add, dec, isDecimalString, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";

type Row = { key: number; itemId: string; description: string; quantity: string; unitPrice: string; discountPercent: string };

let rowKey = 0;
const nextKey = () => (rowKey += 1);

const QUOTE_LABELS: Record<string, string> = { draft: "Draft", finalised: "Sent", accepted: "Accepted", declined: "Declined" };

/**
 * A deal's products and quotes (decision 502, DS7-DS9): lines excluding GST
 * whose total is the deal's amount, "Make quote" (or "New revision", which
 * replaces the open quote), and the quotes made so far. Accepting a quote
 * wins the deal.
 */
export function DealProducts({ organisationId, opportunity, onChanged }: { organisationId: string; opportunity: Opportunity; onChanged: () => void }) {
  const { can, canCrm } = useWorkspace();
  const baseCurrency = useBaseCurrency();
  const data = useApiData<{ lines: DealLine[]; quotes: DealQuote[] }>(`/api/crm/opportunities/${opportunity.id}/lines`, { organisationId });
  const items = useItems(can("viewer") ? organisationId : null).data?.items.filter((item) => item.isActive) ?? [];
  const [editing, setEditing] = useState<Row[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const { busy, error, run } = useBusy();
  const open = opportunity.stageType === "open";
  const scale = currencyMinorUnits(opportunity.currencyCode);
  const lines = data.data?.lines ?? [];
  const quotes = data.data?.quotes ?? [];
  const money = (amount: string) => amountIn(amount, opportunity.currencyCode, baseCurrency);
  const rowAmount = (row: Row) => {
    const item = items.find((entry) => entry.id === row.itemId);
    const price = row.unitPrice.trim() || item?.salePrice || "";
    if (!isDecimalString(row.quantity) || !isDecimalString(price) || (row.discountPercent.trim() && !isDecimalString(row.discountPercent))) return null;
    return toFixedString(discountedLineAmount(row.quantity, price, row.discountPercent.trim() || undefined, scale), scale);
  };
  const editTotal = editing
    ? editing.reduce((total, row) => {
        const amount = rowAmount(row);
        return amount === null ? total : add(total, dec(amount));
      }, ZERO_DECIMAL)
    : null;
  const startEditing = () =>
    setEditing(
      lines.length > 0
        ? lines.map((line) => ({ key: nextKey(), itemId: line.itemId ?? "", description: line.description, quantity: line.quantity, unitPrice: line.unitPrice, discountPercent: discountText(line.discountPercent) }))
        : [{ key: nextKey(), itemId: "", description: "", quantity: "1", unitPrice: "", discountPercent: "" }],
    );
  const update = (key: number, patch: Partial<Row>) => setEditing((rows) => rows?.map((row) => (row.key === key ? { ...row, ...patch } : row)) ?? null);
  const openQuote = quotes.find((quote) => quote.isOpen);
  return (
    <Card
      title="Products"
      description="Excluding GST. With products, the deal's amount is their total."
      actions={
        open && canCrm("write") && editing === null ? (
          <span className={ui.rowButtons}>
            <Button size="small" variant="secondary" onClick={startEditing}>
              {lines.length > 0 ? "Edit products" : "Add products"}
            </Button>
            {can("bookkeeper") && !opportunity.invoiceId && !opportunity.salesOrderId ? (
              <Button
                size="small"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const made = await api<{ quote: { id: string }; replaced: string | null }>(`/api/crm/opportunities/${opportunity.id}/quote`, {
                      method: "POST",
                      body: { organisationId, idempotencyKey: newIdempotencyKey("deal-quote") },
                    });
                    setMessage(made.replaced ? `${made.replaced} was declined and a new draft quote made.` : "Draft quote made.");
                    data.reload();
                    onChanged();
                  })
                }
              >
                {openQuote ? "New revision" : "Make quote"}
              </Button>
            ) : null}
          </span>
        ) : null
      }
    >
      {data.error ? <Notice tone="error">{data.error}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {message ? <Notice tone="success">{message}</Notice> : null}
      {editing ? (
        <div style={{ display: "grid", gap: 8 }}>
          <div className={ui.tableWrap}>
            <table className={`${ui.table} ${ui.stackOnPhone}`}>
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Description</th>
                  <th className={ui.num}>Quantity</th>
                  <th className={ui.num}>Unit price</th>
                  <th className={ui.num}>Disc %</th>
                  <th className={ui.num}>Amount</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {editing.map((row, index) => {
                  const amount = rowAmount(row);
                  return (
                    <tr key={row.key}>
                      <td data-label="Item">
                        <select aria-label={`Line ${index + 1} item`} value={row.itemId} onChange={(event) => update(row.key, { itemId: event.target.value })}>
                          <option value="">None</option>
                          {items.map((item) => (
                            <option key={item.id} value={item.id}>
                              {item.code} · {item.name}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td data-label="Description">
                        <input
                          aria-label={`Line ${index + 1} description`}
                          value={row.description}
                          maxLength={500}
                          placeholder={items.find((item) => item.id === row.itemId)?.name ?? ""}
                          onChange={(event) => update(row.key, { description: event.target.value })}
                        />
                      </td>
                      <td data-label="Quantity">
                        <input aria-label={`Line ${index + 1} quantity`} inputMode="decimal" className={ui.num} value={row.quantity} onChange={(event) => update(row.key, { quantity: event.target.value })} />
                      </td>
                      <td data-label="Unit price">
                        <input
                          aria-label={`Line ${index + 1} unit price`}
                          inputMode="decimal"
                          className={ui.num}
                          value={row.unitPrice}
                          placeholder={items.find((item) => item.id === row.itemId)?.salePrice ?? ""}
                          onChange={(event) => update(row.key, { unitPrice: event.target.value })}
                        />
                      </td>
                      <td data-label="Disc %">
                        <input aria-label={`Line ${index + 1} discount percent`} inputMode="decimal" className={ui.num} value={row.discountPercent} placeholder="0" onChange={(event) => update(row.key, { discountPercent: event.target.value })} />
                      </td>
                      <td data-label="Amount" className={ui.num}>
                        {amount === null ? "" : money(amount)}
                      </td>
                      <td>
                        <Button size="small" variant="secondary" aria-label={`Remove line ${index + 1}`} onClick={() => setEditing((rows) => rows?.filter((entry) => entry.key !== row.key) ?? null)}>
                          ×
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <span className={ui.rowButtons}>
            <Button size="small" variant="secondary" onClick={() => setEditing((rows) => [...(rows ?? []), { key: nextKey(), itemId: "", description: "", quantity: "1", unitPrice: "", discountPercent: "" }])}>
              Add line
            </Button>
            <span className={ui.muted}>Total {editTotal ? money(toFixedString(editTotal, scale)) : ""}</span>
          </span>
          <span className={ui.rowButtons}>
            <Button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await api(`/api/crm/opportunities/${opportunity.id}/lines`, {
                    method: "PUT",
                    body: {
                      organisationId,
                      lines: editing.map((row) => ({
                        itemId: row.itemId || null,
                        description: row.description || null,
                        quantity: row.quantity,
                        unitPrice: row.unitPrice || null,
                        discountPercent: row.discountPercent || null,
                      })),
                    },
                  });
                  setEditing(null);
                  data.reload();
                  onChanged();
                })
              }
            >
              Save products
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => setEditing(null)}>
              Cancel
            </Button>
          </span>
          <p className={ui.muted}>Saving with no lines removes the products, and the amount can be typed again.</p>
        </div>
      ) : lines.length === 0 ? (
        <Empty>No products. The deal&apos;s amount is typed.</Empty>
      ) : (
        <div className={ui.tableWrap}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th>Description</th>
                <th className={ui.num}>Quantity</th>
                <th className={ui.num}>Unit price</th>
                <th className={ui.num}>Disc %</th>
                <th className={ui.num}>Amount</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => (
                <tr key={line.lineOrder}>
                  <td>
                    {line.description}
                    {line.itemCode ? <span className={ui.muted}> · {line.itemCode}</span> : null}
                  </td>
                  <td className={ui.num}>{line.quantity}</td>
                  <td className={ui.num}>{formatMoney(line.unitPrice)}</td>
                  <td className={ui.num}>{discountText(line.discountPercent)}</td>
                  <td className={ui.num}>{money(line.lineAmount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {quotes.length > 0 ? (
        <div style={{ display: "grid", gap: 4, marginTop: 10 }}>
          <strong>Quotes</strong>
          {quotes.map((quote) => (
            <span key={quote.id}>
              <Link href={`/operations/quotes/${quote.id}`}>{quote.quoteNumber ?? "Draft quote"}</Link> <Badge tone={quote.isOpen ? "blue" : quote.status === "accepted" ? "green" : "neutral"}>{QUOTE_LABELS[quote.status] ?? quote.status}</Badge>{" "}
              <span className={ui.muted}>
                {formatDate(quote.quoteDate)} · {money(quote.total)} incl. GST
              </span>
            </span>
          ))}
          <span className={ui.muted}>Accepting a quote moves the deal to Won and links its invoice or sales order.</span>
        </div>
      ) : null}
    </Card>
  );
}
