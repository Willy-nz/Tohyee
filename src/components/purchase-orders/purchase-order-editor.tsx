"use client";

import Link from "next/link";
import { type FormEvent, useState } from "react";
import { useAccounts } from "@/components/books";
import {
  blankLine,
  contactPurchaseTaxCode,
  defaultPurchaseTaxCode,
  type EditorLine,
  editorLines,
  linesForApi,
  PurchaseLines,
  retaxLines,
} from "@/components/bills/bill-editor";
import { CustomFieldInputs, startingValues, useCustomFields } from "@/components/custom-fields";
import { useApiData } from "@/components/hooks";
import { useItems } from "@/components/items";
import { useTracking } from "@/components/tracking";
import { Badge, Button, Field, Notice, ui } from "@/components/ui";
import type { Account } from "@/lib/accounts/service";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import type { Contact } from "@/lib/contacts/service";
import type { CustomFieldSetup, CustomValues } from "@/lib/custom-fields/values";
import { todayInBrowser } from "@/lib/format";
import { AMOUNTS_MODE_LABELS, AMOUNTS_MODES, type AmountsMode } from "@/lib/invoices/amounts";
import type { ItemList } from "@/lib/items/service";
import type { PurchaseOrder, PurchaseOrderStatus } from "@/lib/purchase-orders/service";
import type { TaxCode } from "@/lib/tax/codes";
import { codesForSide } from "@/lib/tax/available-on";
import type { TrackingSetup } from "@/lib/tracking/service";

export function PurchaseOrderStatusBadge({ status }: { status: PurchaseOrderStatus }) {
  const badges = {
    draft: { label: "Draft", tone: "neutral" },
    approved: { label: "Approved", tone: "blue" },
    billed: { label: "Billed", tone: "green" },
    closed: { label: "Closed", tone: "neutral" },
    cancelled: { label: "Cancelled", tone: "red" },
  } as const;
  const badge = badges[status];
  return <Badge tone={badge.tone}>{badge.label}</Badge>;
}

type Data = {
  accounts: Account[];
  items: ItemList | null;
  contacts: Contact[];
  taxCodes: TaxCode[];
  tracking: TrackingSetup;
  customSetup: CustomFieldSetup;
};

/** Creates a draft purchase order, or edits one when `purchaseOrder` is given (PO1). */
export function PurchaseOrderEditor({
  organisationId,
  baseCurrency,
  purchaseOrder,
  deliveryAddressDefault,
  onSaved,
  onCancel,
}: {
  organisationId: string;
  baseCurrency: string;
  purchaseOrder?: PurchaseOrder;
  /** A new purchase order starts with the organisation's own address to deliver to. */
  deliveryAddressDefault?: string | null;
  onSaved: (purchaseOrder: PurchaseOrder) => void;
  onCancel: () => void;
}) {
  const accounts = useAccounts(organisationId);
  const items = useItems(organisationId);
  const contacts = useApiData<{ contacts: Contact[] }>("/api/contacts", { organisationId });
  const taxCodes = useApiData<{ taxCodes: TaxCode[] }>("/api/tax/codes", { organisationId });
  const tracking = useTracking(organisationId);
  const customSetup = useCustomFields(organisationId);
  const error = accounts.error ?? contacts.error ?? taxCodes.error ?? tracking.error ?? customSetup.error;
  if (error) return <Notice tone="error">{error}</Notice>;
  if (!accounts.data || !contacts.data || !taxCodes.data || !tracking.data || !customSetup.data) {
    return <p className={ui.muted}>Loading…</p>;
  }
  return (
    <PurchaseOrderForm
      organisationId={organisationId}
      baseCurrency={baseCurrency}
      data={{
        accounts: accounts.data.accounts,
        items: items.data,
        contacts: contacts.data.contacts,
        taxCodes: codesForSide(taxCodes.data.taxCodes, "purchases"),
        tracking: tracking.data,
        customSetup: customSetup.data,
      }}
      purchaseOrder={purchaseOrder}
      deliveryAddressDefault={deliveryAddressDefault ?? null}
      onSaved={onSaved}
      onCancel={onCancel}
    />
  );
}

function PurchaseOrderForm({
  organisationId,
  baseCurrency,
  data,
  purchaseOrder,
  deliveryAddressDefault,
  onSaved,
  onCancel,
}: {
  organisationId: string;
  baseCurrency: string;
  data: Data;
  purchaseOrder?: PurchaseOrder;
  deliveryAddressDefault: string | null;
  onSaved: (purchaseOrder: PurchaseOrder) => void;
  onCancel: () => void;
}) {
  const defaultTaxCode = defaultPurchaseTaxCode(data.taxCodes);
  const lineDefaults = startingValues(data.customSetup, "line", ["bill"]);
  const [contactId, setContactId] = useState(purchaseOrder?.contactId ?? "");
  const [orderDate, setOrderDate] = useState(purchaseOrder?.orderDate ?? todayInBrowser());
  const [deliveryDate, setDeliveryDate] = useState(purchaseOrder?.deliveryDate ?? "");
  const [deliveryAddress, setDeliveryAddress] = useState(purchaseOrder ? (purchaseOrder.deliveryAddress ?? "") : (deliveryAddressDefault ?? ""));
  const [deliveryInstructions, setDeliveryInstructions] = useState(purchaseOrder?.deliveryInstructions ?? "");
  const [reference, setReference] = useState(purchaseOrder?.reference ?? "");
  const [amountsMode, setAmountsMode] = useState<AmountsMode>(purchaseOrder?.amountsMode ?? "exclusive");
  const [customFields, setCustomFields] = useState<CustomValues>(() => purchaseOrder?.customFields ?? startingValues(data.customSetup, "document", ["bill"]));
  const [lines, setLines] = useState<EditorLine[]>(() =>
    purchaseOrder ? editorLines(purchaseOrder.lines, defaultTaxCode) : [blankLine(defaultTaxCode, lineDefaults)],
  );
  const [idempotencyKey] = useState(() => newIdempotencyKey("purchase-order"));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const supplierOptions = data.contacts.filter((contact) => contact.isSupplier && !contact.isArchived);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const fields = {
      contactId,
      orderDate,
      deliveryDate: deliveryDate || null,
      deliveryAddress: deliveryAddress.trim() || null,
      deliveryInstructions: deliveryInstructions.trim() || null,
      reference: reference.trim() || null,
      amountsMode,
      lines: linesForApi(lines, amountsMode !== "no_tax"),
      customFields,
    };
    try {
      const result = purchaseOrder
        ? await api<{ purchaseOrder: PurchaseOrder }>(`/api/purchase-orders/${purchaseOrder.id}`, { method: "PATCH", body: { organisationId, ...fields } })
        : await api<{ purchaseOrder: PurchaseOrder }>("/api/purchase-orders", {
            method: "POST",
            body: { organisationId, source: "ui", idempotencyKey, ...fields },
          });
      onSaved(result.purchaseOrder);
    } catch (caught) {
      setError(errorMessage(caught));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} autoComplete="off" style={{ display: "grid", gap: 14 }}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {supplierOptions.length === 0 ? (
        <Notice tone="warning">
          There are no suppliers yet. Add one in <Link href="/operations/contacts">Contacts</Link> (tick Supplier) first.
        </Notice>
      ) : null}
      <div className={ui.grid3}>
        <Field label="Supplier">
          <select
            value={contactId}
            onChange={(event) => {
              setContactId(event.target.value);
              const next = data.contacts.find((contact) => contact.id === event.target.value);
              setLines((current) => retaxLines(current, contactPurchaseTaxCode(next, data.taxCodes)));
            }}
            required
          >
            <option value="">Choose a supplier</option>
            {purchaseOrder && !supplierOptions.some((contact) => contact.id === purchaseOrder.contactId) ? (
              <option value={purchaseOrder.contactId}>{purchaseOrder.contactName} (archived or not a supplier)</option>
            ) : null}
            {supplierOptions.map((contact) => (
              <option key={contact.id} value={contact.id}>
                {contact.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Order date">
          <input type="date" value={orderDate} onChange={(event) => setOrderDate(event.target.value)} required />
        </Field>
        <Field label="Delivery date" hint="Optional.">
          <input type="date" value={deliveryDate} min={orderDate || undefined} onChange={(event) => setDeliveryDate(event.target.value)} />
        </Field>
        <Field label="Reference" hint="Optional.">
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
      <div className={ui.grid3}>
        <Field label="Delivery address" hint="Printed on the purchase order.">
          <textarea value={deliveryAddress} onChange={(event) => setDeliveryAddress(event.target.value)} maxLength={500} rows={3} />
        </Field>
        <Field label="Delivery instructions" hint="Optional.">
          <textarea value={deliveryInstructions} onChange={(event) => setDeliveryInstructions(event.target.value)} maxLength={1000} rows={3} />
        </Field>
      </div>
      <CustomFieldInputs setup={data.customSetup} record="document" uses={["bill"]} value={customFields} onChange={setCustomFields} />
      <PurchaseLines
        organisationId={organisationId}
        items={data.items}
        baseCurrency={baseCurrency}
        accounts={data.accounts}
        taxCodes={data.taxCodes}
        tracking={data.tracking}
        customSetup={data.customSetup}
        customUse="bill"
        contactId={contactId}
        amountsMode={amountsMode}
        lines={lines}
        setLines={setLines}
        defaultTaxCode={defaultTaxCode}
        lineDefaults={lineDefaults}
        contactTaxCode={contactPurchaseTaxCode(
          data.contacts.find((contact) => contact.id === contactId),
          data.taxCodes,
        )}
      />
      <div className={ui.actions}>
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save draft"}
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <span className={ui.muted}>Purchase orders post nothing. Approve it to number it, then copy it to a bill when the supplier&apos;s invoice arrives.</span>
      </div>
    </form>
  );
}
