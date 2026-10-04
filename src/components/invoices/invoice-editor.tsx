"use client";

import { defaultsCheckers, withContactDefaults } from "@/lib/contacts/line-defaults";
import { usualTaxCode } from "@/lib/accounts/types";
import Link from "next/link";
import { type FormEvent, useState } from "react";
import { AccountSelect, useAccounts } from "@/components/books";
import { LineItemPicker, useItems } from "@/components/items";
import type { ItemList } from "@/lib/items/service";
import { useApiData } from "@/components/hooks";
import { CustomFieldInputs, startingValues, useCustomFields } from "@/components/custom-fields";
import { dueFromTerms, useCustomerSetup } from "@/components/customers";
import { NEW_CONTACT, QuickContact } from "@/components/quick-contact";
import { customerDefault, SalespersonField, useSalespeople } from "@/components/salespeople";
import { TrackingSelects, useTracking } from "@/components/tracking";
import { Badge, Button, Field, Notice, Stat, ui } from "@/components/ui";
import type { Account } from "@/lib/accounts/service";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import type { Contact } from "@/lib/contacts/service";
import { formatRate, formatUnitPrice } from "@/lib/documents/format";
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
import { add, dec, isDecimalString, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";
import { convertAtRate, isRateText } from "@/lib/money/fx";
import { ExchangeRateField, effectiveRate, useLastRate } from "@/components/fx";
import type { TaxCode } from "@/lib/tax/codes";
import { codesForSide, unavailableNote } from "@/lib/tax/available-on";
import type { CustomerSetup } from "@/lib/customers/service";
import type { SalespeopleSetup } from "@/lib/salespeople/service";
import { type CustomFieldSetup, type CustomValues } from "@/lib/custom-fields/values";
import type { TrackingSetup, TrackingTags } from "@/lib/tracking/service";
import { ExportBadge, ExportWarning, useExportSettings } from "@/components/exports";
import { contactSalesTaxCode, type ExportSettings, retaxLines, usualWithContact } from "@/lib/tax/exports";

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

/** 0.15 -> "15%"; unit prices keep their places. Shared with the PDF (src/lib/documents/format.ts). */
export { formatRate, formatUnitPrice };

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
  /** The code Tohyee's usual default gave (the item's, the account's or the organisation's), before the customer's (EX2-EX6). */
  usualTaxCode?: string;
  /** Chosen by hand, or saved: the customer's defaults leave it alone (EX7, EX8). */
  taxTyped?: boolean;
  /** An invoice line made from a sales order line (SO3); it keeps that line's item and unit. */
  salesOrderLineId?: string;
};

let lineKey = 0;
function nextLineKey(): number {
  lineKey += 1;
  return lineKey;
}

export type Defaults = { accountCode: string; taxCode: string };

/**
 * A new line. `contactTaxCode` is the customer's starting code (their own
 * default, or the tax code for exports, EX2-EX6); without one the line starts
 * with the usual default.
 */
/** A sales line nobody has filled in yet: it can take the customer's defaults (SD1). */
export const untouchedSalesLine = (line: EditorLine) => !line.itemId && !line.description.trim() && !line.unitPrice.trim();

export function blankLine(defaults: Defaults, customFields: CustomValues = {}, contactTaxCode: string | null = null): EditorLine {
  return {
    key: nextLineKey(),
    itemId: "",
    unitId: "",
    description: "",
    quantity: "1",
    unitPrice: "",
    tracking: {},
    customFields,
    ...defaults,
    taxCode: contactTaxCode ?? defaults.taxCode,
    usualTaxCode: defaults.taxCode,
  };
}

export { retaxLines, usualWithContact };

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
  exportSettings: ExportSettings;
  invoice?: Invoice;
  onSaved: (invoice: Invoice) => void;
  onCancel: () => void;
};

function InvoiceForm({
  organisationId,
  items,
  baseCurrency,
  accounts,
  customers: givenCustomers,
  taxCodes,
  tracking,
  customSetup,
  salespeople,
  customerSetup,
  exportSettings,
  invoice,
  onSaved,
  onCancel,
}: FormProps) {
  // Customers added here with "New customer…" join the list straight away.
  const [added, setAdded] = useState<Contact[]>([]);
  const [addingCustomer, setAddingCustomer] = useState(false);
  const customers = [...givenCustomers, ...added];
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
  const refillDue = (customerId: string, date: string, known?: Contact) => {
    if (dueTyped) return;
    const fromTerms = dueFromTerms(customerSetup, known ?? customers.find((contact) => contact.id === customerId), date);
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
          taxTyped: true,
          ...(line.salesOrderLineId ? { salesOrderLineId: line.salesOrderLineId } : {}),
        }))
      : [blankLine(defaults, lineDefaults)],
  );
  // One key per new invoice, so a double click or a retry can't save it twice.
  const [idempotencyKey] = useState(() => newIdempotencyKey("invoice"));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // A customer in another currency gets invoices in it, at a rate for the invoice date (MC1-MC3).
  const chosenCustomer = customers.find((contact) => contact.id === contactId);
  const currencyCode = chosenCustomer ? (chosenCustomer.currencyCode ?? baseCurrency) : (invoice?.currencyCode ?? baseCurrency);
  // Untouched lines take the customer's default account and tracking (SD1).
  const checkers = defaultsCheckers(accounts, tracking);
  const salesDefaults = (current: EditorLine[], customer: Contact | undefined) =>
    withContactDefaults(current, customer, "sales", checkers.accountUsable, checkers.valueUsable, untouchedSalesLine);
  const foreign = currencyCode !== baseCurrency;
  const [typedRate, setTypedRate] = useState<string | null>(invoice?.exchangeRate ?? null);
  const suggestedRate = useLastRate(organisationId, currencyCode, baseCurrency, invoiceDate);

  const hasTax = amountsMode !== "no_tax";

  const customerOptions = customers.filter((contact) => contact.isCustomer && !contact.isArchived);
  function chooseCustomer(id: string, list: Contact[]) {
    const next = list.find((contact) => contact.id === id);
    if ((next?.currencyCode ?? baseCurrency) !== currencyCode) setTypedRate(null);
    setContactId(id);
    refillDue(id, invoiceDate, next);
    setLines((current) => retaxLines(salesDefaults(current, next), contactSalesTaxCode(next, exportSettings, taxCodes)));
    if (!invoice) setSalespersonId(customerDefault(salespeople, next?.defaultSalespersonId));
  }
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
        ...(line.salesOrderLineId ? { salesOrderLineId: line.salesOrderLineId } : {}),
      })),
      customFields,
      salespersonId: salespersonId || null,
      // Left out, the server takes the last rate used, the one shown (MC3).
      ...(foreign && typedRate !== null ? { exchangeRate: typedRate } : {}),
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
          There are no customers yet. Choose &ldquo;+ New customer…&rdquo; below, or add one in <Link href="/operations/contacts">Contacts</Link>.
        </Notice>
      ) : null}
      {hasTax && activeTaxCodes.length === 0 ? (
        <Notice tone="warning">
          There are no active tax codes. An admin can add them in <Link href="/operations/tax">Tax codes</Link>, or set
          the amounts to &quot;No tax&quot;.
        </Notice>
      ) : null}
      <div className={ui.grid3}>
        <Field label="Customer" hint={invoice?.salesOrderNumber ? `From sales order ${invoice.salesOrderNumber}, so the customer stays.` : undefined}>
          <select value={contactId} disabled={Boolean(invoice?.salesOrderId)} onChange={(event) => {
              if (event.target.value === NEW_CONTACT) {
                setAddingCustomer(true);
                return;
              }
              chooseCustomer(event.target.value, customers);
            }}
            required
          >
            <option value="">Choose a customer</option>
            {invoice?.salesOrderId ? null : <option value={NEW_CONTACT}>+ New customer…</option>}
            {savedCustomer ? (
              <option value={savedCustomer.contactId}>{savedCustomer.contactName} (archived or not a customer)</option>
            ) : null}
            {customerOptions.map((contact) => (
              <option key={contact.id} value={contact.id}>
                {contact.name}
                {contact.currencyCode && contact.currencyCode !== baseCurrency ? ` (${contact.currencyCode})` : ""}
              </option>
            ))}
          </select>
          <ExportBadge contact={chosenCustomer} />
        </Field>
        {addingCustomer ? (
          <div style={{ gridColumn: "1 / -1" }}>
            <QuickContact
              organisationId={organisationId}
              kind="customer"
              onCreated={(contact) => {
                setAdded((current) => [...current, contact]);
                setAddingCustomer(false);
                chooseCustomer(contact.id, [...customers, contact]);
              }}
              onCancel={() => setAddingCustomer(false)}
            />
          </div>
        ) : null}
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
        <Field
          label="Due date"
          hint={
            dueTyped
              ? undefined
              : contactId && !dueDate
                ? "This customer has no payment terms: type the due date (or set default terms in Settings › Payment terms and customers)."
                : "From the customer's payment terms, or the organisation's default terms."
          }
        >
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
        <ExchangeRateField currencyCode={currencyCode} baseCurrency={baseCurrency} suggested={suggestedRate} value={typedRate} onChange={setTypedRate} />
      </div>
      {foreign ? (
        <Notice tone="info">
          This invoice is in {currencyCode}, and its GST is worked out in {currencyCode} as usual. The currency doesn&apos;t decide
          the tax code: where the customer is does (exports are zero-rated). Approving posts its {baseCurrency} value, each line and
          its GST converted at the rate.
        </Notice>
      ) : null}
      <CustomFieldInputs setup={customSetup} record="document" uses={["invoice"]} value={customFields} onChange={setCustomFields} />
      <SalesLines
        organisationId={organisationId}
        items={items}
        baseCurrency={currencyCode}
        homeCurrency={foreign ? baseCurrency : undefined}
        exchangeRate={foreign ? effectiveRate(typedRate, suggestedRate) : undefined}
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
        contact={chosenCustomer}
        withDefaults={(fresh) => salesDefaults(fresh, chosenCustomer)}
        exportSettings={exportSettings}
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
  homeCurrency,
  exchangeRate,
  contact,
  exportSettings,
  withDefaults,
}: {
  organisationId: string;
  items: ItemList | null;
  /** The document's currency. */
  baseCurrency: string;
  /** For a foreign-currency document (MC2): the organisation's base currency and the rate, to show the total in it. */
  homeCurrency?: string;
  exchangeRate?: string;
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
  /** The chosen customer and the organisation's export settings (EX2-EX6, EX12). */
  contact?: Contact;
  exportSettings?: ExportSettings | null;
  /** Gives a new line the customer's default account and tracking (SD1). */
  withDefaults?: (lines: EditorLine[]) => EditorLine[];
}) {
  const scale = currencyMinorUnits(baseCurrency);
  const contactTaxCode = contactSalesTaxCode(contact, exportSettings, taxCodes);
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
  // Each line converted on its own, as the server does (MC4).
  const homeTotal =
    homeCurrency && exchangeRate && isRateText(exchangeRate) && complete.every(Boolean)
      ? toFixedString(
          amounts.lines.reduce(
            (total, entry) => add(add(total, dec(convertAtRate(entry.netAmount, exchangeRate))), dec(convertAtRate(entry.taxAmount, exchangeRate))),
            ZERO_DECIMAL,
          ),
          2,
        )
      : null;

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
                  {line.salesOrderLineId ? (
                    <div className={ui.muted}>From the sales order (keeps its item)</div>
                  ) : (
                    <LineItemPicker
                      organisationId={organisationId}
                      items={items}
                      side="sale"
                      contactId={contactId}
                      itemId={line.itemId}
                      unitId={line.unitId}
                      labelPrefix={`Line ${index + 1}`}
                      onPick={(patch) => {
                        const { taxCode, ...rest } = patch;
                        update(line.key, { ...rest, ...usualWithContact(taxCode, contactTaxCode) });
                      }}
                    />
                  )}
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
                    onChange={(code) =>
                      update(line.key, { accountCode: code, ...usualWithContact(usualTaxCode(accounts, taxCodes, code).taxCode, contactTaxCode) })
                    }
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
                      onChange={(event) => update(line.key, { taxCode: event.target.value, taxTyped: true })}
                      required
                    >
                      <option value="">Choose</option>
                      {taxCodes
                        .filter((taxCode) => taxCode.isActive || taxCode.code === line.taxCode)
                        .map((taxCode) => (
                          <option key={taxCode.id} value={taxCode.code}>
                            {taxCode.code} ({formatRate(taxCode.rate)}){unavailableNote(taxCode)}
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
                <Button variant="secondary" size="small" onClick={() => setLines((current) => [...current, ...(withDefaults ?? ((fresh: EditorLine[]) => fresh))([blankLine(defaults, lineDefaults, contactTaxCode)])])}>
                  Add line
                </Button>
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
      {hasTax ? <ExportWarning contact={contact} settings={exportSettings} lineTaxCodes={lines.map((line) => line.taxCode)} taxCodes={taxCodes} /> : null}
      <div className={ui.statRow} aria-live="polite">
        <Stat label={hasTax ? "Subtotal (excl. GST)" : "Subtotal"} value={money(amounts.subtotal)} />
        {hasTax ? <Stat label="GST" value={money(amounts.taxTotal)} /> : null}
        <Stat label={`Total (${baseCurrency})`} value={money(amounts.total)} />
        {homeTotal !== null ? <Stat label={`Total (${homeCurrency} at ${exchangeRate})`} value={formatMoney(homeTotal)} /> : null}
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
  const exportSettings = useExportSettings(organisationId);
  const error =
    accounts.error ??
    contacts.error ??
    taxCodes.error ??
    tracking.error ??
    customSetup.error ??
    salespeople.error ??
    customerSetup.error ??
    exportSettings.error;
  const ready =
    accounts.data && contacts.data && taxCodes.data && tracking.data && customSetup.data && salespeople.data && customerSetup.data && exportSettings.data
      ? {
          exportSettings: exportSettings.data,
          accounts: accounts.data.accounts,
          items: items.data,
          customers: contacts.data.contacts,
          taxCodes: codesForSide(taxCodes.data.taxCodes, "sales"),
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
    // Saved lines keep their tax codes whatever the customer or settings (EX8).
    taxTyped: true,
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
  const exportSettings = useExportSettings(organisationId);
  const error =
    accounts.error ??
    contacts.error ??
    taxCodes.error ??
    tracking.error ??
    customSetup.error ??
    salespeople.error ??
    customerSetup.error ??
    exportSettings.error;
  if (error) {
    return <Notice tone="error">{error}</Notice>;
  }
  if (
    !accounts.data ||
    !contacts.data ||
    !taxCodes.data ||
    !tracking.data ||
    !customSetup.data ||
    !salespeople.data ||
    !customerSetup.data ||
    !exportSettings.data
  ) {
    return <p className={ui.muted}>Loading…</p>;
  }
  return (
    <InvoiceForm
      organisationId={organisationId}
      baseCurrency={baseCurrency}
      accounts={accounts.data.accounts}
      items={items.data}
      customers={contacts.data.contacts}
      taxCodes={codesForSide(taxCodes.data.taxCodes, "sales")}
      tracking={tracking.data}
      customSetup={customSetup.data}
      salespeople={salespeople.data}
      customerSetup={customerSetup.data}
      exportSettings={exportSettings.data}
      invoice={invoice}
      onSaved={onSaved}
      onCancel={onCancel}
    />
  );
}
