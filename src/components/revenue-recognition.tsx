"use client";

import Link from "next/link";
import { useState } from "react";
import { useConfirm } from "@/components/confirm-dialog";
import { useApiData } from "@/components/hooks";
import { Card, Field, Notice, ui } from "@/components/ui";
import type { Account } from "@/lib/accounts/service";
import { api, errorMessage } from "@/lib/client/api";
import type { SalesPlatformConnection } from "@/lib/sales-platforms/types";
import { SALES_PLATFORMS_HREF } from "@/components/navigation";

/**
 * Revenue recognition (SWS1-SWS11, decisions 1569-1571, 1573): when a
 * Shopify store's sales count as revenue. When paid suits things delivered
 * straight away (a game, a download); when fulfilled suits goods that are
 * sent, with the money held in Income in advance until Shopify marks them
 * sent. GST is counted when it's paid either way. One choice per store.
 */
export function RevenueRecognitionCard({ organisationId }: { organisationId: string }) {
  const stores = useApiData<{ connections: SalesPlatformConnection[] }>("/api/sales-platforms/connections", { organisationId });
  const shopify = (stores.data?.connections ?? []).filter((connection) => connection.platform === "shopify" && connection.status !== "disconnected");
  return (
    <Card
      title="Revenue recognition"
      description="When online store sales count as revenue. GST is counted when the order's paid either way. A change applies to orders that come in from then on."
    >
      {stores.error ? <Notice tone="error">{stores.error}</Notice> : null}
      {stores.data && shopify.length === 0 ? (
        <p className={ui.muted}>
          No Shopify store is connected. Online sales count as revenue when they&apos;re paid. <Link href={SALES_PLATFORMS_HREF}>Sales platforms</Link>
        </p>
      ) : null}
      {shopify.map((connection) => (
        <StoreRecognition key={connection.id} organisationId={organisationId} connection={connection} onChanged={stores.reload} />
      ))}
    </Card>
  );
}

function StoreRecognition({ organisationId, connection, onChanged }: { organisationId: string; connection: SalesPlatformConnection; onChanged: () => void }) {
  const confirm = useConfirm();
  const fulfilled = connection.salesWhenSentAccountCode !== null;
  const accounts = useApiData<{ accounts: Account[] }>(fulfilled ? null : "/api/accounts", { organisationId });
  const liabilities = (accounts.data?.accounts ?? []).filter((account) => account.isActive && account.accountClass === "liability" && account.accountType !== "bank");
  const named = liabilities.find((account) => /income in advance|unearned|deferred (income|revenue)/i.test(account.name));
  const [choice, setChoice] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const chosen = choice || named?.code || "__new__";
  const codes = new Set((accounts.data?.accounts ?? []).map((account) => account.code));
  let fresh = 2350;
  while (codes.has(String(fresh))) fresh += 1;
  const save = async (body: Record<string, unknown>, done: string) => {
    setBusy(true);
    setMessage(null);
    try {
      await api(`/api/sales-platforms/connections/${connection.id}`, { method: "PATCH", body: { organisationId, ...body } });
      setMessage({ tone: "success", text: done });
      onChanged();
    } catch (caught) {
      setMessage({ tone: "error", text: errorMessage(caught) });
    } finally {
      setBusy(false);
    }
  };
  const toPaid = async () => {
    if (!(await confirm("Recognise revenue when paid? Orders that come in from now count as revenue when they're paid. Orders already held still count when they're fulfilled."))) return;
    await save({ salesWhenSentAccountCode: null }, "Revenue is recognised when paid for new orders.");
  };
  const toFulfilled = () =>
    save(
      chosen === "__new__" ? { newSalesWhenSentAccount: { code: String(fresh), name: "Income in advance" } } : { salesWhenSentAccountCode: chosen },
      "Revenue is recognised when fulfilled for orders that come in from now.",
    );
  if (!connection.postToAccounts) {
    return (
      <p className={ui.muted}>
        {connection.storeName ?? connection.storeDomain}: orders aren&apos;t posted to the accounts, so there&apos;s nothing to recognise. <Link href={SALES_PLATFORMS_HREF}>Sales platforms</Link>
      </p>
    );
  }
  return (
    <div style={{ display: "grid", gap: 8 }}>
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      <Field label={`${connection.storeName ?? connection.storeDomain} (Shopify)`}>
        <div style={{ display: "grid", gap: 6 }}>
          <label className={ui.checkbox}>
            <input type="radio" name={`recognise-${connection.id}`} checked={!fulfilled} disabled={busy || !fulfilled} onChange={() => void toPaid()} /> When paid
            <span className={ui.muted}> · for things delivered straight away, like a game or a download</span>
          </label>
          <label className={ui.checkbox}>
            <input type="radio" name={`recognise-${connection.id}`} checked={fulfilled} disabled={busy || fulfilled} onChange={() => void toFulfilled()} /> When fulfilled
            <span className={ui.muted}>
              {" "}
              · for goods that are sent: the money waits in {fulfilled ? connection.salesWhenSentAccountCode : "Income in advance"} until Shopify marks each line fulfilled
            </span>
          </label>
        </div>
      </Field>
      {!fulfilled ? (
        <Field label="Income in advance account (for when fulfilled)">
          <select value={chosen} onChange={(event) => setChoice(event.target.value)} disabled={busy}>
            <option value="__new__">Add {fresh} Income in advance</option>
            {liabilities.map((account) => (
              <option key={account.id} value={account.code}>
                {account.code} {account.name}
              </option>
            ))}
          </select>
        </Field>
      ) : (
        <>
          <p className={ui.muted} style={{ margin: 0 }}>
            <Link href="/operations/to-send">Sales › To send</Link> shows the orders not yet fulfilled and what&apos;s held for each.
          </p>
          <ApplyToInvoiced organisationId={organisationId} connectionId={connection.id} />
        </>
      )}
    </div>
  );
}

type OrderToApply = { orderId: string; name: string | null; invoiceNumber: string; invoiceDate: string; total: string; shopifyStatus: string | null; chosen: boolean };

/**
 * SWS13: orders invoiced in full to sales before Sales when sent applied to
 * them, not yet sent. Choosing them holds what's still to be sent at the next
 * sync: one journal each, the invoice and its payment unchanged.
 */
function ApplyToInvoiced({ organisationId, connectionId }: { organisationId: string; connectionId: string }) {
  const confirm = useConfirm();
  const preview = useApiData<{ held: string | null; orders: OrderToApply[] }>(`/api/sales-platforms/connections/${connectionId}/apply-when-sent`, { organisationId });
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const waiting = (preview.data?.orders ?? []).filter((order) => !order.chosen);
  const marked = (preview.data?.orders ?? []).length - waiting.length;
  if (!preview.data || (waiting.length === 0 && marked === 0)) return null;
  const total = waiting.reduce((sum, order) => sum + Math.round(Number(order.total) * 100), 0);
  async function apply() {
    if (!(await confirm(`Apply Sales when sent to these ${waiting.length} orders? At the next sync, what each still has to send moves from sales to ${preview.data!.held}, in one journal per order on its invoice date. The invoices and payments don't change.`))) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await api<{ marked: number }>(`/api/sales-platforms/connections/${connectionId}/apply-when-sent`, {
        method: "POST",
        body: { organisationId, orderIds: waiting.map((order) => order.orderId) },
      });
      setMessage({ tone: "success", text: `${result.marked} orders will be held at the next sync. The sync log says what moved for each.` });
      preview.reload();
    } catch (caught) {
      setMessage({ tone: "error", text: errorMessage(caught) });
    } finally {
      setBusy(false);
    }
  }
  return (
    <div style={{ display: "grid", gap: 6 }}>
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      {marked > 0 ? <p className={ui.muted} style={{ margin: 0 }}>{marked} orders are waiting for the next sync to be held.</p> : null}
      {waiting.length > 0 ? (
        <Notice tone="warning">
          {waiting.length} {waiting.length === 1 ? "order was" : "orders were"} invoiced to sales before this applied, and Shopify hasn&apos;t marked {waiting.length === 1 ? "it" : "them"} fully sent
          (invoices total {(total / 100).toLocaleString("en-NZ", { minimumFractionDigits: 2 })}).{" "}
          <button type="button" className={ui.linkButton} onClick={() => setOpen(!open)}>
            {open ? "Hide them" : "See them"}
          </button>
          {open ? (
            <table className={ui.table} style={{ marginTop: 8 }}>
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Invoice</th>
                  <th>Date</th>
                  <th>Shopify says</th>
                  <th className={ui.num}>Total</th>
                </tr>
              </thead>
              <tbody>
                {waiting.map((order) => (
                  <tr key={order.orderId}>
                    <td>{order.name ?? order.orderId}</td>
                    <td>{order.invoiceNumber}</td>
                    <td>{order.invoiceDate}</td>
                    <td>{(order.shopifyStatus ?? "").toLowerCase().replace(/_/g, " ")}</td>
                    <td className={ui.num}>{order.total}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          <div style={{ marginTop: 8 }}>
            <button type="button" className={`${ui.button} ${ui.secondary}`} disabled={busy} onClick={() => void apply()}>
              {busy ? "Working…" : "Apply Sales when sent to these orders"}
            </button>
          </div>
        </Notice>
      ) : null}
    </div>
  );
}
