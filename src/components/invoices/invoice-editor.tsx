"use client";

import Link from "next/link";
import { type FormEvent, useState } from "react";
import { AccountSelect, useAccounts } from "@/components/books";
import { LineItemPicker, useItems } from "@/components/items";
import type { ItemList } from "@/lib/items/service";
import { useApiData } from "@/components/hooks";
import { CustomFieldInputs, startingValues, useCustomFields } from "@/components/custom-fields";
import { dueFromTerms, useCustomerSetup } from "@/components/customers";
import { customerDefault, SalespersonField, useSalespeople } from "@/components/salespeople";
import { TrackingSelects, useTracking } from "@/components/tracking";
import { Badge, Button, Field, Notice, Stat, ui } from "@/components/ui";
import type { Account } from "@/lib/accounts/service";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import type { Contact } from "@/lib/contacts/service";
import { formatMoney, todayInBrowser } from "@/lib/format";
import {
  AMOUNTS_MODE_LABELS,
  AMOUNTS_MODES,
  type AmountsMode,
  calculateInvoice,
  PAID_STATUS_LABELS,
  type PaidStatus,
} from "@/lib/invoices/amounts";
import type { Invoice, InvoiceStatus } from "@/lib/invoices/service";
import { currencyMinorUnits } from "@/lib/money/currency";
import { dec, isDecimalString, mul, toPlainString } from "@/lib/money/decimal";
import type { TaxCode } from "@/lib/tax/codes";
import type { CustomerSetup } from "@/lib/customers/service";
import type { SalespeopleSetup } from "@/lib/salespeople/service";
import { type CustomFieldSetup, type CustomValues } from "@/lib/custom-fields/values";
import type { TrackingSetup, TrackingTags } from "@/lib/tracking/service";

const STATUS_BADGES: Record<InvoiceStatus, { label: string; tone: "neutral" | "green" | "red" }> = {
  draft: { label: "Draft", tone: "neutral" },
  approved: { label: "Approved", tone: "green" },
  voided: { label: "Voided", tone: "red" },
};

export function InvoiceStatusBadge({ status }: { status: InvoiceStatus }) {
  const badge = STATUS_BADGES[status];
  return <Badge tone={badge.tone}>{badge.label}</Badge>;
}

const PAID_STATUS_TONES: Record<PaidStatus, "amber" | "blue" | "green"> = {
  unpaid: "amber",
  part_paid: "blue",
  paid: "green",
};

export function PaidStatusBadge({ status }: { status: PaidStatus }) {
  return <Badge tone={PAID_STATUS_TONES[status]}>{PAID_STATUS_LABELS[status]}</Badge>;
}

/** 0.15 -> "15%". */
export function formatRate(rate: string): string {
  return `${toPlainString(mul(dec(rate), dec("100")))}%`;
}

/** Unit prices keep the places they were entered with (2 to 4): "50" -> "50.00", "3.3333" stays. */
export function formatUnitPrice(value: string): string {
  const places = value.split(".")[1]?.length ?? 0;
  return formatMoney(value, Math.max(2, places));
}

export type EditorLine = {
  key: number;
  itemId: string;
  unitId: string;
  description: string;
  quantity: string;
  unitPrice: string;
  accountCode: string;
  taxCode: string;
  tracking: TrackingTags;
  customFields: CustomValues;
};

let lineKey = 0;
function nextLineKey(): number {
  lineKey += 1;
  return lineKey;
}

export type Defaults = { accountCode: string; taxCode: string };

export function blankLine(defaults: Defaults, customFields: CustomValues = {}): EditorLine {
  return { key: nextLineKey(), itemId: "", unitId: "", description: "", quantity: "1", unitPrice: "", tracking: {}, customFields, ...defaults };
}

/** Invoice lines go to revenue accounts, the same rule the server checks. */
function isRevenue(account: Account): boolean {
  return account.accountClass === "revenue";
}

type FormProps = {
  organisationId: string;
  items: ItemList | null;
  baseCurrency: string;
  accounts: Account[];
  customers: Contact[];
  taxCodes: TaxCode[];
  tracking: TrackingSetup;
  customSetup: CustomFieldSetup;
  salespeople: SalespeopleSetup;
  customerSetup: CustomerSetup;
  invoice?: Invoice;
  onSaved: (invoice: Invoice) => void;
  onCancel: () => void;
};

function InvoiceForm({
  organisationId,
  items,
  baseCurrency,
  accounts,
  customers,
  taxCodes,
  tracking,
  customSetup,
  salespeople,
  customerSetup,
  invoice,
  onSaved,
  onCancel,
}: FormProps) {
  const activeTaxCodes = taxCodes.filter((taxCode) => taxCode.isActive);
  const defaults: Defaults = {
    accountCode: accounts.find((account) => account.isActive && isRevenue(account))?.code ?? "",
    taxCode: (activeTaxCodes.find((taxCode) => taxCode.category === "standard") ?? activeTaxCodes[0])?.code ?? "",
  };
  const [contactId, setContactId] = useState(invoice?.contactId ?? "");
  const [invoiceDate, setInvoiceDate] = useState(invoice?.invoiceDate ?? todayInBrowser());
  const [dueDate, setDueDate] = useState(invoice?.dueDate ?? "");
  // A new invoice's due date follows the customer's payment terms until it's typed over (RC1).
  const [dueTyped, setDueTyped] = useState(Boolean(invoice));
  const refillDue = (customerId: string, date: string) => {
    if (dueTyped) return;
    const fromTerms = dueFromTerms(customerSetup, customers.find((contact) => contact.id === customerId), date);
    if (fromTerms) setDueDate(fromTerms);
  };
  const [reference, setReference] = useState(invoice?.reference ?? "");
  const [amountsMode, setAmountsMode] = useState<AmountsMode>(invoice?.amountsMode ?? "exclusive");
  // A new document takes the customer's default salesperson when the customer is chosen (SR1).
  const [salespersonId, setSalespersonId] = useState<string>(invoice?.salespersonId ?? "");
  const lineDefaults = startingValues(customSetup, "line", ["invoice"]);
  const [customFields, setCustomFields] = useState<CustomValues>(
    () => invoice?.customFields ?? startingValues(customSetup, "document", ["invoice"]),
  );
  const [lines, setLines] = useState<EditorLine[]>(() =>
    invoice
      ? invoice.lines.map((line) => ({
          key: nextLineKey(),
          itemId: line.itemId ?? "",
          unitId: line.unitId ?? "",
          description: line.description,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          accountCode: line.accountCode,
          taxCode: line.taxCode ?? defaults.taxCode,
          tracking: line.tracking ?? {},
          customFields: line.customFields ?? {},
        }))
      : [blankLine(defaults, lineDefaults)],
  );
  // One key per new invoice, so a double click or a retry can't save it twice.
  const [idempotencyKey] = useState(() => newIdempotencyKey("invoice"));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const hasTax = amountsMode !== "no_tax";

  const customerOptions = customers.filter((contact) => contact.isCustomer && !contact.isArchived);
  const savedCustomer =
    invoice && !customerOptions.some((contact) => contact.id === invoice.contactId) ? invoice : null;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const fields = {
      contactId,
      invoiceDate,
      dueDate,
      reference: reference.trim() || null,
      amountsMode,
      lines: lines.map((line) => ({
        itemId: line.itemId || null,
        unitId: line.unitId || null,
        description: line.description,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        accountCode: line.accountCode,
        taxCode: hasTax ? line.taxCode || null : null,
        tracking: line.tracking,
        customFields: line.customFields,
      })),
      customFields,
      salespersonId: salespersonId || null,
    };
    try {
      const result = invoice
        ? await api<{ invoice: Invoice }>(`/api/invoices/${invoice.id}`, {
            method: "PATCH",
            body: { organisationId, ...fields },
          })
        : await api<{ invoice: Invoice }>("/api/invoices", {
            method: "POST",
            body: { organisationId, source: "ui", idempotencyKey, ...fields },
          });
      onSaved(result.invoice);
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
      {hasTax && activeTaxCodes.length === 0 ? (
        <Notice tone="warning">
          There are no active tax codes. An admin can add them in <Link href="/operations/tax">Tax codes</Link>, or set
          the amounts to &quot;No tax&quot;.
        </Notice>
      ) : null}
      <div className={ui.grid3}>
        <Field label="Customer">
          <select value={contactId} onChange={(event) => {
              setContactId(event.target.value);
              refillDue(event.target.value, invoiceDate);
              if (!invoice) {
                const chosen = customers.find((contact) => contact.id === event.target.value);
                setSalespersonId(customerDefault(salespeople, chosen?.defaultSalespersonId));
              }
            }}
            required
          >
            <option value="">Choose a customer</option>
            {savedCustomer ? (
              <option value={savedCustomer.contactId}>{savedCustomer.contactName} (archived or not a customer)</option>
            ) : null}
            {customerOptions.map((contact) => (
              <option key={contact.id} value={contact.id}>
                {contact.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Invoice date" hint="Approving posts the invoice on this date.">
          <input
            type="date"
            value={invoiceDate}
            onChange={(event) => {
              setInvoiceDate(event.target.value);
              refillDue(contactId, event.target.value);
            }}
            required
          />
        </Field>
        <Field label="Due date" hint={dueTyped ? undefined : "From the customer's payment terms, if they have any."}>
          <input
            type="date"
            value={dueDate}
            min={invoiceDate || undefined}
            onChange={(event) => {
              setDueDate(event.target.value);
              setDueTyped(true);
            }}
            required
          />
        </Field>
        <SalespersonField setup={salespeople} value={salespersonId} onChange={setSalespersonId} />
        <Field label="Reference" hint="Optional, like the customer's order number.">
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
      <CustomFieldInputs setup={customSetup} record="document" uses={["invoice"]} value={customFields} onChange={setCustomFields} />
      <SalesLines
        organisationId={organisationId}
        items={items}
        baseCurrency={baseCurrency}
        accounts={accounts}
        taxCodes={taxCodes}
        tracking={tracking}
        customSetup={customSetup}
        customUse="invoice"
        contactId={contactId}
        amountsMode={amountsMode}
        lines={lines}
        setLines={setLines}
        defaults={defaults}
        lineDefaults={lineDefaults}
      />
      <div className={ui.actions}>
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save draft"}
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <span className={ui.muted}>A draft posts nothing. Approve it to give it a number and post it to the ledger.</span>
      </div>
    </form>
  );
}


/**
 * The lines table and live totals shared by invoices, quotes (QT1) and
 * repeating invoice templates (RI1): the same fields, account filter and
 * maths as the server.
 */
export function SalesLines({
  organisationId,
  items,
  baseCurrency,
  accounts,
  taxCodes,
  tracking,
  customSetup,
  customUse,
  contactId,
  amountsMode,
  lines,
  setLines,
  defaults,
  lineDefaults,
}: {
  organisationId: string;
  items: ItemList | null;
  baseCurrency: string;
  accounts: Account[];
  taxCodes: TaxCode[];
  tracking: TrackingSetup;
  customSetup: CustomFieldSetup;
  customUse: "invoice";
  contactId: string;
  amountsMode: AmountsMode;
  lines: EditorLine[];
  setLines: (update: (current: EditorLine[]) => EditorLine[]) => void;
  defaults: Defaults;
  lineDefaults: CustomValues;
}) {
  const scale = currencyMinorUnits(baseCurrency);
  const hasTax = amountsMode !== "no_tax";
  const rates = new Map(taxCodes.map((taxCode) => [taxCode.code, taxCode.rate]));
  const usable = (value: string) => isDecimalString(value) && !value.trim().startsWith("-");
  // Live totals use the same calculation the server does when it saves.
  const complete = lines.map(
    (line) => usable(line.quantity) && usable(line.unitPrice) && (!hasTax || rates.has(line.taxCode)),
  );
  const amounts = calculateInvoice(
    amountsMode,
    lines.map((line, index) =>
      complete[index]
        ? { quantity: line.quantity, unitPrice: line.unitPrice, taxRate: hasTax ? (rates.get(line.taxCode) ?? "0") : "0" }
        : { quantity: "0", unitPrice: "0", taxRate: "0" },
    ),
    scale,
  );
  const money = (value: string) => formatMoney(value, scale);

  function update(key: number, patch: Partial<EditorLine>) {
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  }

  return (
    <>
      <div className={ui.tableWrap}>
        <table className={`${ui.table} ${ui.stackOnPhone}`}>
          <thead>
            <tr>
              <th style={{ minWidth: 220 }}>Description</th>
              <th className={ui.num} style={{ width: 100 }}>
                Quantity
              </th>
              <th className={ui.num} style={{ width: 130 }}>
                Unit price
              </th>
              <th style={{ width: "20%" }}>Account</th>
              {hasTax ? <th style={{ width: "14%" }}>Tax code</th> : null}
              {hasTax ? <th className={ui.num}>GST</th> : null}
              <th className={ui.num}>
                {amountsMode === "inclusive" ? "Amount (incl. GST)" : amountsMode === "exclusive" ? "Amount (excl. GST)" : "Amount"}
              </th>
              <th style={{ width: 44 }} />
            </tr>
          </thead>
          <tbody>
            {lines.map((line, index) => (
              <tr key={line.key}>
                <td data-label="Description">
                  <input
                    aria-label={`Line ${index + 1} description`}
                    value={line.description}
                    onChange={(event) => update(line.key, { description: event.target.value })}
                    maxLength={500}
                    required
                  />
                  <LineItemPicker
                    organisationId={organisationId}
                    items={items}
                    side="sale"
                    contactId={contactId}
                    itemId={line.itemId}
                    unitId={line.unitId}
                    labelPrefix={`Line ${index + 1}`}
                    onPick={(patch) => update(line.key, patch)}
                  />
                </td>
                <td data-label="Quantity">
                  <input
                    aria-label={`Line ${index + 1} quantity`}
                    inputMode="decimal"
                    className={ui.num}
                    value={line.quantity}
                    onChange={(event) => update(line.key, { quantity: event.target.value })}
                    required
                  />
                </td>
                <td data-label="Unit price">
                  <input
                    aria-label={`Line ${index + 1} unit price`}
                    inputMode="decimal"
                    className={ui.num}
                    value={line.unitPrice}
                    onChange={(event) => update(line.key, { unitPrice: event.target.value })}
                    required
                  />
                </td>
                <td data-label="Account">
                  <AccountSelect
                    ariaLabel={`Line ${index + 1} account`}
                    accounts={accounts}
                    filter={isRevenue}
                    value={line.accountCode}
                    onChange={(code) => update(line.key, { accountCode: code })}
                    required
                  />
                  <TrackingSelects
                    setup={tracking}
                    labelPrefix={`Line ${index + 1}`}
                    value={line.tracking}
                    onChange={(tags) => update(line.key, { tracking: tags })}
                  />
                  <CustomFieldInputs
                    compact
                    setup={customSetup}
                    record="line"
                    uses={[customUse]}
                    labelPrefix={`Line ${index + 1}`}
                    value={line.customFields}
                    onChange={(values) => update(line.key, { customFields: values })}
                  />
                </td>
                {hasTax ? (
                  <td data-label="Tax code">
                    <select
                      aria-label={`Line ${index + 1} tax code`}
                      value={line.taxCode}
                      onChange={(event) => update(line.key, { taxCode: event.target.value })}
                      required
                    >
                      <option value="">Choose</option>
                      {taxCodes
                        .filter((taxCode) => taxCode.isActive || taxCode.code === line.taxCode)
                        .map((taxCode) => (
                          <option key={taxCode.id} value={taxCode.code}>
                            {taxCode.code} ({formatRate(taxCode.rate)}){taxCode.isActive ? "" : " (inactive)"}
                          </option>
                        ))}
                    </select>
                  </td>
                ) : null}
                {hasTax ? <td data-label="GST" className={ui.num}>{complete[index] ? money(amounts.lines[index].taxAmount) : ""}</td> : null}
                <td data-label="Amount" className={ui.num}>{complete[index] ? money(amounts.lines[index].lineAmount) : ""}</td>
                <td data-label="">
                  <Button
                    variant="secondary"
                    size="small"
                    aria-label={`Remove line ${index + 1}`}
                    disabled={lines.length <= 1}
                    onClick={() => setLines((current) => current.filter((entry) => entry.key !== line.key))}
                  >
                    ×
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={hasTax ? 8 : 6}>
                <Button variant="secondary" size="small" onClick={() => setLines((current) => [...current, blankLine(defaults, lineDefaults)])}>
                  Add line
                </Button>
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
      <div className={ui.statRow} aria-live="polite">
        <Stat label={hasTax ? "Subtotal (excl. GST)" : "Subtotal"} value={money(amounts.subtotal)} />
        {hasTax ? <Stat label="GST" value={money(amounts.taxTotal)} /> : null}
        <Stat label={`Total (${baseCurrency})`} value={money(amounts.total)} />
      </div>
    </>
  );
}

/** The data every sales document editor needs, loaded together. */
export function useSalesEditorData(organisationId: string) {
  const accounts = useAccounts(organisationId);
  const items = useItems(organisationId);
  const contacts = useApiData<{ contacts: Contact[] }>("/api/contacts", { organisationId });
  const taxCodes = useApiData<{ taxCodes: TaxCode[] }>("/api/tax/codes", { organisationId });
  const tracking = useTracking(organisationId);
  const customSetup = useCustomFields(organisationId);
  const salespeople = useSalespeople(organisationId);
  const customerSetup = useCustomerSetup(organisationId);
  const error =
    accounts.error ?? contacts.error ?? taxCodes.error ?? tracking.error ?? customSetup.error ?? salespeople.error ?? customerSetup.error;
  const ready =
    accounts.data && contacts.data && taxCodes.data && tracking.data && customSetup.data && salespeople.data && customerSetup.data
      ? {
          accounts: accounts.data.accounts,
          items: items.data,
          customers: contacts.data.contacts,
          taxCodes: taxCodes.data.taxCodes,
          tracking: tracking.data,
          customSetup: customSetup.data,
          salespeople: salespeople.data,
          customerSetup: customerSetup.data,
        }
      : null;
  return { error, data: ready };
}

/** Starting account and tax code for a new sales line. */
export function salesDefaults(accounts: Account[], taxCodes: TaxCode[]): Defaults {
  const activeTaxCodes = taxCodes.filter((taxCode) => taxCode.isActive);
  return {
    accountCode: accounts.find((account) => account.isActive && isRevenue(account))?.code ?? "",
    taxCode: (activeTaxCodes.find((taxCode) => taxCode.category === "standard") ?? activeTaxCodes[0])?.code ?? "",
  };
}

/** Saved lines as editor lines. */
export function editorLines(saved: ReadonlyArray<{ itemId: string | null; unitId: string | null; description: string; quantity: string; unitPrice: string; accountCode: string; taxCode: string | null; tracking: TrackingTags; customFields: CustomValues }>, defaults: Defaults): EditorLine[] {
  return saved.map((line) => ({
    key: nextLineKey(),
    itemId: line.itemId ?? "",
    unitId: line.unitId ?? "",
    description: line.description,
    quantity: line.quantity,
    unitPrice: line.unitPrice,
    accountCode: line.accountCode,
    taxCode: line.taxCode ?? defaults.taxCode,
    tracking: line.tracking ?? {},
    customFields: line.customFields ?? {},
  }));
}

/** Editor lines as the API takes them. */
export function linesForApi(lines: EditorLine[], hasTax: boolean) {
  return lines.map((line) => ({
    itemId: line.itemId || null,
    unitId: line.unitId || null,
    description: line.description,
    quantity: line.quantity,
    unitPrice: line.unitPrice,
    accountCode: line.accountCode,
    taxCode: hasTax ? line.taxCode || null : null,
    tracking: line.tracking,
    customFields: line.customFields,
  }));
}

/**
 * Creates a draft invoice, or edits one when `invoice` is given. Loads the
 * customers, revenue accounts and tax codes to choose from.
 */
export function InvoiceEditor({
  organisationId,
  baseCurrency,
  invoice,
  onSaved,
  onCancel,
}: {
  organisationId: string;
  baseCurrency: string;
  invoice?: Invoice;
  onSaved: (invoice: Invoice) => void;
  onCancel: () => void;
}) {
  const accounts = useAccounts(organisationId);
  const items = useItems(organisationId);
  const contacts = useApiData<{ contacts: Contact[] }>("/api/contacts", { organisationId });
  const taxCodes = useApiData<{ taxCodes: TaxCode[] }>("/api/tax/codes", { organisationId });
  const tracking = useTracking(organisationId);
  const customSetup = useCustomFields(organisationId);
  const salespeople = useSalespeople(organisationId);
  const customerSetup = useCustomerSetup(organisationId);
  const error =
    accounts.error ?? contacts.error ?? taxCodes.error ?? tracking.error ?? customSetup.error ?? salespeople.error ?? customerSetup.error;
  if (error) {
    return <Notice tone="error">{error}</Notice>;
  }
  if (!accounts.data || !contacts.data || !taxCodes.data || !tracking.data || !customSetup.data || !salespeople.data || !customerSetup.data) {
    return <p className={ui.muted}>Loading…</p>;
  }
  return (
    <InvoiceForm
      organisationId={organisationId}
      baseCurrency={baseCurrency}
      accounts={accounts.data.accounts}
      items={items.data}
      customers={contacts.data.contacts}
      taxCodes={taxCodes.data.taxCodes}
      tracking={tracking.data}
      customSetup={customSetup.data}
      salespeople={salespeople.data}
      customerSetup={customerSetup.data}
      invoice={invoice}
      onSaved={onSaved}
      onCancel={onCancel}
    />
  );
}
