"use client";

import Link from "next/link";
import { type FormEvent, useState } from "react";
import { CustomFieldInputs, startingValues } from "@/components/custom-fields";
import { ExportBadge } from "@/components/exports";
import {
  blankLine,
  type EditorLine,
  editorLines,
  linesForApi,
  retaxLines,
  salesDefaults,
  SalesLines,
  useSalesEditorData,
} from "@/components/invoices/invoice-editor";
import { customerDefault, SalespersonField } from "@/components/salespeople";
import { Badge, Button, Field, Notice, ui } from "@/components/ui";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import type { CustomValues } from "@/lib/custom-fields/values";
import { todayInBrowser } from "@/lib/format";
import { AMOUNTS_MODE_LABELS, AMOUNTS_MODES, type AmountsMode } from "@/lib/invoices/amounts";
import type { SalesOrder, SalesOrderStatus } from "@/lib/sales-orders/service";
import { contactSalesTaxCode } from "@/lib/tax/exports";

/** NetSuite's sales order statuses, in plain words (SO2-SO8). */
export const SALES_ORDER_STATUS_LABELS: Record<SalesOrderStatus, string> = {
  draft: "Draft",
  pending_billing: "Pending billing",
  partly_billed: "Partly billed",
  billed: "Billed",
  closed: "Closed",
  cancelled: "Cancelled",
};

export function SalesOrderStatusBadge({ status }: { status: SalesOrderStatus }) {
  const tones = {
    draft: "neutral",
    pending_billing: "blue",
    partly_billed: "amber",
    billed: "green",
    closed: "neutral",
    cancelled: "red",
  } as const;
  return <Badge tone={tones[status]}>{SALES_ORDER_STATUS_LABELS[status]}</Badge>;
}

/** Creates a draft sales order, or edits one when `salesOrder` is given (SO1). */
export function SalesOrderEditor({
  organisationId,
  baseCurrency,
  salesOrder,
  onSaved,
  onCancel,
}: {
  organisationId: string;
  baseCurrency: string;
  salesOrder?: SalesOrder;
  onSaved: (salesOrder: SalesOrder) => void;
  onCancel: () => void;
}) {
  const loaded = useSalesEditorData(organisationId);
  if (loaded.error) return <Notice tone="error">{loaded.error}</Notice>;
  if (!loaded.data) return <p className={ui.muted}>Loading…</p>;
  return (
    <SalesOrderForm
      organisationId={organisationId}
      baseCurrency={baseCurrency}
      data={loaded.data}
      salesOrder={salesOrder}
      onSaved={onSaved}
      onCancel={onCancel}
    />
  );
}

function SalesOrderForm({
  organisationId,
  baseCurrency,
  data,
  salesOrder,
  onSaved,
  onCancel,
}: {
  organisationId: string;
  baseCurrency: string;
  data: NonNullable<ReturnType<typeof useSalesEditorData>["data"]>;
  salesOrder?: SalesOrder;
  onSaved: (salesOrder: SalesOrder) => void;
  onCancel: () => void;
}) {
  const defaults = salesDefaults(data.accounts, data.taxCodes);
  const lineDefaults = startingValues(data.customSetup, "line", ["invoice"]);
  const [contactId, setContactId] = useState(salesOrder?.contactId ?? "");
  const [orderDate, setOrderDate] = useState(salesOrder?.orderDate ?? todayInBrowser());
  const [expectedDate, setExpectedDate] = useState(salesOrder?.expectedDate ?? "");
  const [reference, setReference] = useState(salesOrder?.reference ?? "");
  const [memo, setMemo] = useState(salesOrder?.memo ?? "");
  const [amountsMode, setAmountsMode] = useState<AmountsMode>(salesOrder?.amountsMode ?? "exclusive");
  const [salespersonId, setSalespersonId] = useState(salesOrder?.salespersonId ?? "");
  const [customFields, setCustomFields] = useState<CustomValues>(
    () => salesOrder?.customFields ?? startingValues(data.customSetup, "document", ["invoice"]),
  );
  const [lines, setLines] = useState<EditorLine[]>(() => (salesOrder ? editorLines(salesOrder.lines, defaults) : [blankLine(defaults, lineDefaults)]));
  const [idempotencyKey] = useState(() => newIdempotencyKey("sales-order"));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const customerOptions = data.customers.filter((contact) => contact.isCustomer && !contact.isArchived);
  const chosen = data.customers.find((contact) => contact.id === contactId);
  const currencyCode = chosen?.currencyCode ?? salesOrder?.currencyCode ?? baseCurrency;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const fields = {
      contactId,
      orderDate,
      expectedDate: expectedDate || null,
      reference: reference.trim() || null,
      memo: memo.trim() || null,
      amountsMode,
      lines: linesForApi(lines, amountsMode !== "no_tax"),
      customFields,
      salespersonId: salespersonId || null,
    };
    try {
      const result = salesOrder
        ? await api<{ salesOrder: SalesOrder }>(`/api/sales-orders/${salesOrder.id}`, { method: "PATCH", body: { organisationId, ...fields } })
        : await api<{ salesOrder: SalesOrder }>("/api/sales-orders", { method: "POST", body: { organisationId, source: "ui", idempotencyKey, ...fields } });
      onSaved(result.salesOrder);
    } catch (caught) {
      setError(errorMessage(caught));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} autoComplete="off" style={{ display: "grid", gap: 14 }}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {customerOptions.length === 0 ? (
        <Notice tone="warning">
          There are no customers yet. Add one in <Link href="/operations/contacts">Contacts</Link> (tick Customer) first.
        </Notice>
      ) : null}
      <div className={ui.grid3}>
        <Field
          label="Customer"
          hint={salesOrder?.fromQuote ? `Made from quote ${salesOrder.fromQuote.quoteNumber}, so the customer stays.` : currencyCode !== baseCurrency ? `In ${currencyCode}.` : undefined}
        >
          <select
            value={contactId}
            disabled={Boolean(salesOrder?.fromQuote)}
            onChange={(event) => {
              setContactId(event.target.value);
              const next = data.customers.find((contact) => contact.id === event.target.value);
              setLines((current) => retaxLines(current, contactSalesTaxCode(next, data.exportSettings, data.taxCodes)));
              if (!salesOrder) setSalespersonId(customerDefault(data.salespeople, next?.defaultSalespersonId));
            }}
            required
          >
            <option value="">Choose a customer</option>
            {salesOrder && !customerOptions.some((contact) => contact.id === salesOrder.contactId) ? (
              <option value={salesOrder.contactId}>{salesOrder.contactName} (archived or not a customer)</option>
            ) : null}
            {customerOptions.map((contact) => (
              <option key={contact.id} value={contact.id}>
                {contact.name}
                {contact.currencyCode && contact.currencyCode !== baseCurrency ? ` (${contact.currencyCode})` : ""}
              </option>
            ))}
          </select>
          <ExportBadge contact={chosen} />
        </Field>
        <Field label="Order date">
          <input type="date" value={orderDate} onChange={(event) => setOrderDate(event.target.value)} required />
        </Field>
        <Field label="Expected date" hint="Optional. When the customer expects it.">
          <input type="date" value={expectedDate} min={orderDate || undefined} onChange={(event) => setExpectedDate(event.target.value)} />
        </Field>
        <SalespersonField setup={data.salespeople} value={salespersonId} onChange={setSalespersonId} />
        <Field label="Reference" hint="Optional, such as the customer's order number. Carried to its invoices.">
          <input value={reference} onChange={(event) => setReference(event.target.value)} maxLength={100} />
        </Field>
        <Field label="Amounts are">
          <select value={amountsMode} onChange={(event) => setAmountsMode(event.target.value as AmountsMode)}>
            {AMOUNTS_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {AMOUNTS_MODE_LABELS[mode]}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="Memo" hint="Optional. For your team; not carried to invoices.">
        <textarea value={memo} onChange={(event) => setMemo(event.target.value)} maxLength={1000} rows={2} />
      </Field>
      <CustomFieldInputs setup={data.customSetup} record="document" uses={["invoice"]} value={customFields} onChange={setCustomFields} />
      <SalesLines
        organisationId={organisationId}
        items={data.items}
        baseCurrency={currencyCode}
        accounts={data.accounts}
        taxCodes={data.taxCodes}
        tracking={data.tracking}
        customSetup={data.customSetup}
        customUse="invoice"
        contactId={contactId}
        amountsMode={amountsMode}
        lines={lines}
        setLines={setLines}
        defaults={defaults}
        lineDefaults={lineDefaults}
        contact={chosen}
        exportSettings={data.exportSettings}
      />
      <div className={ui.actions}>
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save draft"}
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <span className={ui.muted}>Sales orders post nothing. Approve it to give it a number, then invoice it.</span>
      </div>
    </form>
  );
}
