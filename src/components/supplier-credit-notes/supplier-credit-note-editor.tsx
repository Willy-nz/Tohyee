"use client";

import Link from "next/link";
import { type FormEvent, useState } from "react";
import { AccountSelect, useAccounts } from "@/components/books";
import { LineItemPicker, useItems } from "@/components/items";
import type { ItemList } from "@/lib/items/service";
import { useApiData } from "@/components/hooks";
import { CustomFieldInputs, startingValues, useCustomFields } from "@/components/custom-fields";
import { TrackingSelects, useTracking } from "@/components/tracking";
import { formatRate } from "@/components/invoices/invoice-editor";
import { Button, Field, Notice, Stat, ui } from "@/components/ui";
import type { Account } from "@/lib/accounts/service";
import { billLineAccountProblem } from "@/lib/bills/accounts";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import type { Contact } from "@/lib/contacts/service";
import { formatMoney, todayInBrowser } from "@/lib/format";
import { AMOUNTS_MODE_LABELS, AMOUNTS_MODES, type AmountsMode, calculateInvoice } from "@/lib/invoices/amounts";
import { currencyMinorUnits } from "@/lib/money/currency";
import { isDecimalString } from "@/lib/money/decimal";
import type { SupplierCreditNote } from "@/lib/supplier-credit-notes/service";
import type { TaxCode } from "@/lib/tax/codes";
import { type CustomFieldSetup, type CustomValues, copyableValuesFor } from "@/lib/custom-fields/values";
import type { TrackingSetup, TrackingTags } from "@/lib/tracking/service";

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

/** New lines have no account, so each credit is put somewhere on purpose. */
function blankLine(taxCode: string, customFields: CustomValues = {}): EditorLine {
  return { key: nextLineKey(), itemId: "", unitId: "", description: "", quantity: "1", unitPrice: "", accountCode: "", taxCode, tracking: {}, customFields };
}

/** The accounts supplier credit note lines can go to: the bill line rule the server checks. */
function takesBillLines(account: Account): boolean {
  return billLineAccountProblem(account) === null;
}

/** What a new draft starts with, e.g. an approved bill's supplier and lines. */
export type SupplierCreditNoteStart = {
  contactId: string;
  reference: string | null;
  amountsMode: AmountsMode;
  lines: Array<{ description: string; quantity: string; unitPrice: string; accountCode: string; taxCode: string | null; tracking?: TrackingTags; customFields?: CustomValues; itemId?: string | null; unitId?: string | null }>;
  customFields?: CustomValues;
};

type FormProps = {
  organisationId: string;
  items: ItemList | null;
  baseCurrency: string;
  accounts: Account[];
  suppliers: Contact[];
  taxCodes: TaxCode[];
  tracking: TrackingSetup;
  customSetup: CustomFieldSetup;
  creditNote?: SupplierCreditNote;
  start?: SupplierCreditNoteStart;
  onSaved: (creditNote: SupplierCreditNote) => void;
  onCancel: () => void;
};

function SupplierCreditNoteForm({
  organisationId,
  items,
  baseCurrency,
  accounts,
  suppliers,
  taxCodes,
  tracking,
  customSetup,
  creditNote,
  start,
  onSaved,
  onCancel,
}: FormProps) {
  const scale = currencyMinorUnits(baseCurrency);
  const activeTaxCodes = taxCodes.filter((taxCode) => taxCode.isActive);
  const defaultTaxCode =
    (activeTaxCodes.find((taxCode) => taxCode.category === "standard") ?? activeTaxCodes[0])?.code ?? "";
  const initial = creditNote ?? start;
  const [contactId, setContactId] = useState(initial?.contactId ?? "");
  const [creditNoteDate, setCreditNoteDate] = useState(creditNote?.creditNoteDate ?? todayInBrowser());
  const [supplierCreditNoteNumber, setSupplierCreditNoteNumber] = useState(
    creditNote?.supplierCreditNoteNumber ?? "",
  );
  const [reference, setReference] = useState(initial?.reference ?? "");
  const [amountsMode, setAmountsMode] = useState<AmountsMode>(initial?.amountsMode ?? "exclusive");
  const lineDefaults = startingValues(customSetup, "line", ["supplier_credit_note"]);
  // A copy from an invoice or bill keeps the values of fields also used here (CF6).
  const [customFields, setCustomFields] = useState<CustomValues>(
    () =>
      creditNote?.customFields ??
      (start ? copyableValuesFor(customSetup.fields, start.customFields, "document", "supplier_credit_note") : startingValues(customSetup, "document", ["supplier_credit_note"])),
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
          taxCode: line.taxCode ?? defaultTaxCode,
          tracking: line.tracking ?? {},
          customFields: creditNote ? (line.customFields ?? {}) : copyableValuesFor(customSetup.fields, line.customFields, "line", "supplier_credit_note"),
        }))
      : [blankLine(defaultTaxCode, lineDefaults)],
  );
  // One key per new credit note, so a double click or a retry can't save it twice.
  const [idempotencyKey] = useState(() => newIdempotencyKey("supplier-credit-note"));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  const supplierOptions = suppliers.filter((contact) => contact.isSupplier && !contact.isArchived);
  const savedSupplier =
    creditNote && !supplierOptions.some((contact) => contact.id === creditNote.contactId) ? creditNote : null;

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
      supplierCreditNoteNumber,
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
    };
    try {
      const result = creditNote
        ? await api<{ creditNote: SupplierCreditNote }>(`/api/supplier-credit-notes/${creditNote.id}`, {
            method: "PATCH",
            body: { organisationId, ...fields },
          })
        : await api<{ creditNote: SupplierCreditNote }>("/api/supplier-credit-notes", {
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
      {supplierOptions.length === 0 ? (
        <Notice tone="warning">
          There are no suppliers yet. Add one in <Link href="/operations/contacts">Contacts</Link> (tick Supplier) first.
        </Notice>
      ) : null}
      {hasTax && activeTaxCodes.length === 0 ? (
        <Notice tone="warning">
          There are no active tax codes. An admin can add them in <Link href="/operations/tax">Tax codes</Link>, or set
          the amounts to &quot;No tax&quot;.
        </Notice>
      ) : null}
      <div className={ui.grid3}>
        <Field label="Supplier">
          <select value={contactId} onChange={(event) => setContactId(event.target.value)} required>
            <option value="">Choose a supplier</option>
            {savedSupplier ? (
              <option value={savedSupplier.contactId}>{savedSupplier.contactName} (archived or not a supplier)</option>
            ) : null}
            {supplierOptions.map((contact) => (
              <option key={contact.id} value={contact.id}>
                {contact.name}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Supplier's credit note number"
          hint="As it's shown on their credit note. A supplier can't have two credit notes with the same number."
        >
          <input
            value={supplierCreditNoteNumber}
            onChange={(event) => setSupplierCreditNoteNumber(event.target.value)}
            maxLength={100}
            required
          />
        </Field>
        <Field label="Credit note date" hint="The date on the supplier's credit note. Approving posts it on this date.">
          <input type="date" value={creditNoteDate} onChange={(event) => setCreditNoteDate(event.target.value)} required />
        </Field>
        <Field label="Reference" hint="Optional, like the bill it credits.">
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
      <CustomFieldInputs setup={customSetup} record="document" uses={["supplier_credit_note"]} value={customFields} onChange={setCustomFields} />
      <div className={ui.tableWrap}>
        <table className={ui.table}>
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
                <td>
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
                    side="purchase"
                    contactId={contactId}
                    itemId={line.itemId}
                    unitId={line.unitId}
                    labelPrefix={`Line ${index + 1}`}
                    onPick={(patch) => update(line.key, patch)}
                  />
                </td>
                <td>
                  <input
                    aria-label={`Line ${index + 1} quantity`}
                    inputMode="decimal"
                    className={ui.num}
                    value={line.quantity}
                    onChange={(event) => update(line.key, { quantity: event.target.value })}
                    required
                  />
                </td>
                <td>
                  <input
                    aria-label={`Line ${index + 1} unit price`}
                    inputMode="decimal"
                    className={ui.num}
                    value={line.unitPrice}
                    onChange={(event) => update(line.key, { unitPrice: event.target.value })}
                    required
                  />
                </td>
                <td>
                  <AccountSelect
                    ariaLabel={`Line ${index + 1} account`}
                    accounts={accounts}
                    filter={takesBillLines}
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
                    uses={["supplier_credit_note"]}
                    labelPrefix={`Line ${index + 1}`}
                    value={line.customFields}
                    onChange={(values) => update(line.key, { customFields: values })}
                  />
                </td>
                {hasTax ? (
                  <td>
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
                {hasTax ? <td className={ui.num}>{complete[index] ? money(amounts.lines[index].taxAmount) : ""}</td> : null}
                <td className={ui.num}>{complete[index] ? money(amounts.lines[index].lineAmount) : ""}</td>
                <td>
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
                <Button variant="secondary" size="small" onClick={() => setLines((current) => [...current, blankLine(defaultTaxCode, lineDefaults)])}>
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
      <div className={ui.actions}>
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save draft"}
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <span className={ui.muted}>A draft posts nothing. Approve it to post it to the ledger.</span>
      </div>
    </form>
  );
}

/**
 * Creates a draft supplier credit note, or edits one when `creditNote` is
 * given. A new draft can start from `start`, e.g. a bill's supplier and
 * lines. Loads the suppliers, accounts and tax codes to choose from.
 */
export function SupplierCreditNoteEditor({
  organisationId,
  baseCurrency,
  creditNote,
  start,
  onSaved,
  onCancel,
}: {
  organisationId: string;
  baseCurrency: string;
  creditNote?: SupplierCreditNote;
  start?: SupplierCreditNoteStart;
  onSaved: (creditNote: SupplierCreditNote) => void;
  onCancel: () => void;
}) {
  const accounts = useAccounts(organisationId);
  const items = useItems(organisationId);
  const contacts = useApiData<{ contacts: Contact[] }>("/api/contacts", { organisationId });
  const taxCodes = useApiData<{ taxCodes: TaxCode[] }>("/api/tax/codes", { organisationId });
  const tracking = useTracking(organisationId);
  const customSetup = useCustomFields(organisationId);
  const error = accounts.error ?? contacts.error ?? taxCodes.error ?? tracking.error ?? customSetup.error;
  if (error) {
    return <Notice tone="error">{error}</Notice>;
  }
  if (!accounts.data || !contacts.data || !taxCodes.data || !tracking.data || !customSetup.data) {
    return <p className={ui.muted}>Loading…</p>;
  }
  return (
    <SupplierCreditNoteForm
      organisationId={organisationId}
      baseCurrency={baseCurrency}
      accounts={accounts.data.accounts}
      items={items.data}
      suppliers={contacts.data.contacts}
      taxCodes={taxCodes.data.taxCodes}
      tracking={tracking.data}
      customSetup={customSetup.data}
      creditNote={creditNote}
      start={start}
      onSaved={onSaved}
      onCancel={onCancel}
    />
  );
}
