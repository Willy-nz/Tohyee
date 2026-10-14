"use client";

import { useState } from "react";
import { AccountSelect, Money, useAccounts } from "@/components/books";
import { DateInput } from "@/components/date-input";
import { useApiData } from "@/components/hooks";
import { Button, Card, Field, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import { formatDate, formatQuantity, todayInBrowser } from "@/lib/format";
import type { LandedCostAllocation } from "@/lib/inventory/landed-cost";

/**
 * Landed cost on an approved bill's stock (examples LDC1-LDC5): freight,
 * duty or insurance from another bill, spread by value or quantity. Shown
 * only when the bill received stock items.
 */
export function LandedCostCard({ organisationId, billId }: { organisationId: string; billId: string }) {
  const { can } = useWorkspace();
  const data = useApiData<{ stockLines: number; allocations: LandedCostAllocation[] }>(`/api/bills/${billId}/landed-cost`, { organisationId });
  const accounts = useAccounts(can("bookkeeper") ? organisationId : null);
  const [form, setForm] = useState({ amount: "", method: "value", offsetAccountCode: "5100", allocationDate: todayInBrowser() });
  const [key, setKey] = useState(() => newIdempotencyKey("lc"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  if (!data.data || data.data.stockLines === 0) return null;

  async function allocate(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await api<{ allocation: LandedCostAllocation }>(`/api/bills/${billId}/landed-cost`, {
        method: "POST",
        body: { organisationId, idempotencyKey: key, ...form },
      });
      const sold = result.allocation.lines.reduce((sum, line) => sum + (line.toCostOfSales === "0.00" ? 0 : 1), 0);
      setMessage(sold > 0 ? "Added. Part of it was for stock already sold, so that part went to cost of sales." : "Added to the stock.");
      setForm({ ...form, amount: "" });
      setKey(newIdempotencyKey("lc"));
      data.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title="Landed cost"
      description="Freight, duty or insurance on this stock, from another bill. Enter it excluding GST: import GST is claimed back, so it isn't stock cost."
    >
      {data.data.allocations.length > 0 ? (
        <div className={ui.tableWrap}>
          <table className={`${ui.table} ${ui.stackOnPhone}`}>
            <thead>
              <tr>
                <th>Date</th>
                <th>Item</th>
                <th className={ui.num}>Received</th>
                <th className={ui.num}>Share</th>
                <th className={ui.num}>To stock</th>
                <th className={ui.num}>To cost of sales</th>
              </tr>
            </thead>
            <tbody>
              {data.data.allocations.flatMap((allocation) =>
                allocation.lines.map((line, index) => (
                  <tr key={`${allocation.id}-${index}`}>
                    <td data-label="Date">
                      {index === 0 ? `${formatDate(allocation.allocationDate)} · ${allocation.reference} (by ${allocation.method}, from ${allocation.offsetAccountCode})` : ""}
                    </td>
                    <td data-label="Item">{line.itemCode}</td>
                    <td data-label="Received" className={ui.num}>
                      {formatQuantity(line.receivedQuantity)}
                    </td>
                    <td data-label="Share" className={ui.num}>
                      <Money value={line.share} />
                    </td>
                    <td data-label="To stock" className={ui.num}>
                      <Money value={line.toStock} />
                    </td>
                    <td data-label="To cost of sales" className={ui.num}>
                      <Money value={line.toCostOfSales} />
                    </td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
        </div>
      ) : null}
      {message ? <Notice tone="success">{message}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {can("bookkeeper") ? (
        <form className={ui.inlineForm} onSubmit={allocate}>
          <Field label="Amount excl. GST">
            <input inputMode="decimal" required value={form.amount} onChange={(event) => setForm({ ...form, amount: event.target.value })} />
          </Field>
          <Field label="Split by">
            <select value={form.method} onChange={(event) => setForm({ ...form, method: event.target.value })}>
              <option value="value">Value</option>
              <option value="quantity">Quantity</option>
            </select>
          </Field>
          <Field label="Coded to on its bill">
            {accounts.data ? (
              <AccountSelect
                accounts={accounts.data.accounts}
                value={form.offsetAccountCode}
                onChange={(code) => setForm({ ...form, offsetAccountCode: code })}
                filter={(account) => !account.systemKey && !account.currencyCode && account.accountType !== "bank" && account.accountType !== "credit_card"}
                required
              />
            ) : (
              <input value={form.offsetAccountCode} onChange={(event) => setForm({ ...form, offsetAccountCode: event.target.value })} />
            )}
          </Field>
          <Field label="Date">
            <DateInput value={form.allocationDate} onChange={(event) => setForm({ ...form, allocationDate: event.target.value })} required />
          </Field>
          <Button type="submit" disabled={busy}>
            {busy ? "Adding…" : "Add landed cost"}
          </Button>
        </form>
      ) : null}
    </Card>
  );
}
