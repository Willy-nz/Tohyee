"use client";

import { usualTaxCode } from "@/lib/accounts/types";
import Link from "next/link";
import { type FormEvent, useState } from "react";
import { AccountSelect, useAccounts } from "@/components/books";
import { LineItemPicker, useItems } from "@/components/items";
import type { ItemList } from "@/lib/items/service";
import type { InvoiceSummary } from "@/lib/invoices/service";
import { useApiData } from "@/components/hooks";
import { ExchangeRateField, useLastRate } from "@/components/fx";
import { CustomFieldInputs, startingValues, useCustomFields } from "@/components/custom-fields";
import { customerDefault, SalespersonField, useSalespeople } from "@/components/salespeople";
import { TrackingSelects, useTracking } from "@/components/tracking";
import { formatRate } from "@/components/invoices/invoice-editor";
import { Badge, Button, Field, Notice, Stat, ui } from "@/components/ui";
import type { Account } from "@/lib/accounts/service";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import type { Contact } from "@/lib/contacts/service";
import type { CreditNote, CreditNoteStatus } from "@/lib/credit-notes/service";
import { formatMoney, todayInBrowser } from "@/lib/format";
import {
  AMOUNTS_MODE_LABELS,
  AMOUNTS_MODES,
  type AmountsMode,
  calculateInvoice,
  CREDIT_STATUS_LABELS,
  type CreditStatus,
} from "@/lib/invoices/amounts";
import { currencyMinorUnits } from "@/lib/money/currency";
import { isDecimalString } from "@/lib/money/decimal";
import type { TaxCode } from "@/lib/tax/codes";
import type { SalespeopleSetup } from "@/lib/salespeople/service";
import { type CustomFieldSetup, type CustomValues, copyableValuesFor } from "@/lib/custom-fields/values";
import type { TrackingSetup, TrackingTags } from "@/lib/tracking/service";

const STATUS_BADGES: Record<CreditNoteStatus, { label: string; tone: "neutral" | "green" | "red" }> = {
  draft: { label: "Draft", tone: "neutral" },
  approved: { label: "Approved", tone: "green" },
  voided: { label: "Voided", tone: "red" },
};

export function CreditNoteStatusBadge({ status }: { status: CreditNoteStatus }) {
  const badge = STATUS_BADGES[status];
  return <Badge tone={badge.tone}>{badge.label}</Badge>;
}

const CREDIT_STATUS_TONES: Record<CreditStatus, "amber" | "blue" | "green"> = {
  open: "amber",
  part_used: "blue",
  used: "green",
};

export function CreditStatusBadge({ status }: { status: CreditStatus }) {
  return <Badge tone={CREDIT_STATUS_TONES[status]}>{CREDIT_STATUS_LABELS[status]}</Badge>;
}

type EditorLine = {
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

type Defaults = { accountCode: string; taxCode: string };

function blankLine(defaults: Defaults, customFields: CustomValues = {}): EditorLine {
  return { key: nextLineKey(), itemId: "", unitId: "", description: "", quantity: "1", unitPrice: "", tracking: {}, customFields, ...defaults };
}

/** Credit note lines go to revenue accounts, the same rule the server checks. */
function isRevenue(account: Account): boolean {
  return account.accountClass === "revenue";
}

/** What a new draft starts with, e.g. an approved invoice's customer and lines. */
export type CreditNoteStart = {
  contactId: string;
  reference: string | null;
  amountsMode: AmountsMode;
  lines: Array<{
    description: string;
    quantity: string;
    unitPrice: string;
    accountCode: string;
    taxCode: string | null;
    tracking?: TrackingTags;
    customFields?: CustomValues;
    itemId?: string | null;
    unitId?: string | null;
  }>;
  customFields?: CustomValues;
  /** The invoice stock is returned from (ST5), when starting from an invoice. */
  returnInvoiceId?: string | null;
  /** The invoice's salesperson (SR3). */
  salespersonId?: string | null;
};

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
  creditNote?: CreditNote;
  start?: CreditNoteStart;
  onSaved: (creditNote: CreditNote) => void;
  onCancel: () => void;
};

function CreditNoteForm({
  organisationId,
  items,
  baseCurrency,
  accounts,
  customers,
  taxCodes,
  tracking,
  customSetup,
  salespeople,
  creditNote,
  start,
  onSaved,
  onCancel,
}: FormProps) {
  const scale = currencyMinorUnits(baseCurrency);
  const activeTaxCodes = taxCodes.filter((taxCode) => taxCode.isActive);
  const defaults: Defaults = {
    accountCode: accounts.find((account) => account.isActive && isRevenue(account))?.code ?? "",
    taxCode: (activeTaxCodes.find((taxCode) => taxCode.category === "standard") ?? activeTaxCodes[0])?.code ?? "",
  };
  const initial = creditNote ?? start;
  const [contactId, setContactId] = useState(initial?.contactId ?? "");
  const [creditNoteDate, setCreditNoteDate] = useState(creditNote?.creditNoteDate ?? todayInBrowser());
  const [reference, setReference] = useState(initial?.reference ?? "");
  // Stock items on the credit note go back at the cost of their sale on this invoice (ST5).
  const [returnInvoiceId, setReturnInvoiceId] = useState(creditNote?.returnInvoiceId ?? start?.returnInvoiceId ?? "");
  const customerInvoices = useApiData<{ invoices: InvoiceSummary[] }>(contactId ? "/api/invoices" : null, {
    organisationId,
    contactId,
    status: "approved",
    limit: 200,
  });
  const [amountsMode, setAmountsMode] = useState<AmountsMode>(initial?.amountsMode ?? "exclusive");
  // A new document takes the customer's default salesperson when the customer is chosen (SR1).
  const [salespersonId, setSalespersonId] = useState<string>(creditNote?.salespersonId ?? (start ? (start.salespersonId ?? "") : ""));
  const lineDefaults = startingValues(customSetup, "line", ["credit_note"]);
  // A copy from an invoice or bill keeps the values of fields also used here (CF6).
  const [customFields, setCustomFields] = useState<CustomValues>(
    () =>
      creditNote?.customFields ??
      (start ? copyableValuesFor(customSetup.fields, start.customFields, "document", "credit_note") : startingValues(customSetup, "document", ["credit_note"])),
  );
  const [lines, setLines] = useState<EditorLine[]>(() =>
    initial && initial.lines.length > 0
      ? initial.lines.map((line) => ({
          key: nextLineKey(),
          itemId: line.itemId ?? "",
          unitId: line.unitId ?? "",
          description: line.description,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          accountCode: line.accountCode,
          taxCode: line.taxCode ?? defaults.taxCode,
          tracking: line.tracking ?? {},
          customFields: creditNote ? (line.customFields ?? {}) : copyableValuesFor(customSetup.fields, line.customFields, "line", "credit_note"),
        }))
      : [blankLine(defaults, lineDefaults)],
  );
  // One key per new credit note, so a double click or a retry can't save it twice.
  const [idempotencyKey] = useState(() => newIdempotencyKey("credit-note"));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // A customer in another currency gets credit notes in it, at a rate for its date (MC7).
  const chosenCustomer = customers.find((contact) => contact.id === contactId);
  const currencyCode = chosenCustomer ? (chosenCustomer.currencyCode ?? baseCurrency) : (creditNote?.currencyCode ?? baseCurrency);
  const foreign = currencyCode !== baseCurrency;
  const [typedRate, setTypedRate] = useState<string | null>(creditNote?.exchangeRate ?? null);
  const suggestedRate = useLastRate(organisationId, currencyCode, baseCurrency, creditNoteDate);

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

  const customerOptions = customers.filter((contact) => contact.isCustomer && !contact.isArchived);
  const savedCustomer =
    creditNote && !customerOptions.some((contact) => contact.id === creditNote.contactId) ? creditNote : null;

  function update(key: number, patch: Partial<EditorLine>) {
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const fields = {
      contactId,
      creditNoteDate,
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
      returnInvoiceId: returnInvoiceId || null,
      ...(foreign && typedRate !== null ? { exchangeRate: typedRate } : {}),
    };
    try {
      const result = creditNote
        ? await api<{ creditNote: CreditNote }>(`/api/credit-notes/${creditNote.id}`, {
            method: "PATCH",
            body: { organisationId, ...fields },
          })
        : await api<{ creditNote: CreditNote }>("/api/credit-notes", {
            method: "POST",
            body: { organisationId, source: "ui", idempotencyKey, ...fields },
          });
      onSaved(result.creditNote);
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
              const next = customers.find((contact) => contact.id === event.target.value);
              if ((next?.currencyCode ?? baseCurrency) !== currencyCode) setTypedRate(null);
              setContactId(event.target.value);
              if (!creditNote) {
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
        <Field label="Credit note date" hint="Approving posts the credit note on this date.">
          <input type="date" value={creditNoteDate} onChange={(event) => setCreditNoteDate(event.target.value)} required />
        </Field>
        <ExchangeRateField currencyCode={currencyCode} baseCurrency={baseCurrency} suggested={suggestedRate} value={typedRate} onChange={setTypedRate} />
        <SalespersonField setup={salespeople} value={salespersonId} onChange={setSalespersonId} />
        <Field label="Reference" hint="Optional, like the invoice it credits.">
          <input value={reference} onChange={(event) => setReference(event.target.value)} maxLength={100} />
        </Field>
        <Field label="Stock returned from" hint="For stock items: the invoice they were sold on, so they go back into stock at that sale's cost.">
          <select value={returnInvoiceId} onChange={(event) => setReturnInvoiceId(event.target.value)}>
            <option value="">No stock returned</option>
            {(customerInvoices.data?.invoices ?? [])
              .filter((invoice) => invoice.status === "approved" || invoice.id === returnInvoiceId)
              .map((invoice) => (
                <option key={invoice.id} value={invoice.id}>
                  {invoice.invoiceNumber} · {invoice.invoiceDate}
                </option>
              ))}
          </select>
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
      <CustomFieldInputs setup={customSetup} record="document" uses={["credit_note"]} value={customFields} onChange={setCustomFields} />
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
                    onChange={(code) => update(line.key, { accountCode: code, ...usualTaxCode(accounts, taxCodes, code) })}
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
                    uses={["credit_note"]}
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
        <Stat label={`Total (${currencyCode})`} value={money(amounts.total)} />
      </div>
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
 * Creates a draft credit note, or edits one when `creditNote` is given. A new
 * draft can start from `start`, e.g. an invoice's customer and lines. Loads
 * the customers, revenue accounts and tax codes to choose from.
 */
export function CreditNoteEditor({
  organisationId,
  baseCurrency,
  creditNote,
  start,
  onSaved,
  onCancel,
}: {
  organisationId: string;
  baseCurrency: string;
  creditNote?: CreditNote;
  start?: CreditNoteStart;
  onSaved: (creditNote: CreditNote) => void;
  onCancel: () => void;
}) {
  const accounts = useAccounts(organisationId);
  const items = useItems(organisationId);
  const contacts = useApiData<{ contacts: Contact[] }>("/api/contacts", { organisationId });
  const taxCodes = useApiData<{ taxCodes: TaxCode[] }>("/api/tax/codes", { organisationId });
  const tracking = useTracking(organisationId);
  const customSetup = useCustomFields(organisationId);
  const salespeople = useSalespeople(organisationId);
  const error = accounts.error ?? contacts.error ?? taxCodes.error ?? tracking.error ?? customSetup.error ?? salespeople.error;
  if (error) {
    return <Notice tone="error">{error}</Notice>;
  }
  if (!accounts.data || !contacts.data || !taxCodes.data || !tracking.data || !customSetup.data || !salespeople.data) {
    return <p className={ui.muted}>Loading…</p>;
  }
  return (
    <CreditNoteForm
      organisationId={organisationId}
      baseCurrency={baseCurrency}
      accounts={accounts.data.accounts}
      items={items.data}
      customers={contacts.data.contacts}
      taxCodes={taxCodes.data.taxCodes}
      tracking={tracking.data}
      customSetup={customSetup.data}
      salespeople={salespeople.data}
      creditNote={creditNote}
      start={start}
      onSaved={onSaved}
      onCancel={onCancel}
    />
  );
}
