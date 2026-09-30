"use client";

import Link from "next/link";
import { type FormEvent, useState } from "react";
import { useAccounts } from "@/components/books";
import { blankLine, defaultPurchaseTaxCode, type EditorLine, editorLines, linesForApi, PurchaseLines } from "@/components/bills/bill-editor";
import { CustomFieldInputs, startingValues, useCustomFields } from "@/components/custom-fields";
import { useApiData } from "@/components/hooks";
import { useItems } from "@/components/items";
import { useTracking } from "@/components/tracking";
import { Button, Field, Notice, ui } from "@/components/ui";
import type { Account } from "@/lib/accounts/service";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import type { Contact } from "@/lib/contacts/service";
import type { CustomFieldSetup, CustomValues } from "@/lib/custom-fields/values";
import { formatDate, todayInBrowser } from "@/lib/format";
import { AMOUNTS_MODE_LABELS, AMOUNTS_MODES, type AmountsMode } from "@/lib/invoices/amounts";
import type { ItemList } from "@/lib/items/service";
import { BILL_DUE_RULE_LABELS, BILL_DUE_RULES, billDueDate, billNumberFor, type BillDueRule, NUMBER_PATTERN_MAX, numberPatternProblem } from "@/lib/repeating/bill-rules";
import type { RepeatingBill } from "@/lib/repeating/bills";
import type { SaveAs } from "@/lib/repeating/runner";
import { datesBetween, type RepeatPeriod } from "@/lib/repeating/schedule";
import type { TaxCode } from "@/lib/tax/codes";
import type { TrackingSetup } from "@/lib/tracking/service";

/** Short enough for the select; the preview below spells out each due date. */
const SHORT_DUE_LABELS: Record<BillDueRule, string> = {
  terms: "Supplier's payment terms",
  days_after: "Days after bill date",
  days_after_month_end: "Days after month end",
  day_of_next_month: "Day of next month",
};

type Data = {
  accounts: Account[];
  items: ItemList | null;
  contacts: Contact[];
  taxCodes: TaxCode[];
  tracking: TrackingSetup;
  customSetup: CustomFieldSetup;
};

/** Creates a repeating bill template, or changes one when `template` is given (RB1, RB6). */
export function RepeatingBillEditor({
  organisationId,
  baseCurrency,
  template,
  onSaved,
  onCancel,
}: {
  organisationId: string;
  baseCurrency: string;
  template?: RepeatingBill;
  onSaved: (template: RepeatingBill) => void;
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
    <RepeatingBillForm
      organisationId={organisationId}
      baseCurrency={baseCurrency}
      data={{
        accounts: accounts.data.accounts,
        items: items.data,
        contacts: contacts.data.contacts,
        taxCodes: taxCodes.data.taxCodes,
        tracking: tracking.data,
        customSetup: customSetup.data,
      }}
      template={template}
      onSaved={onSaved}
      onCancel={onCancel}
    />
  );
}

function RepeatingBillForm({
  organisationId,
  baseCurrency,
  data,
  template,
  onSaved,
  onCancel,
}: {
  organisationId: string;
  baseCurrency: string;
  data: Data;
  template?: RepeatingBill;
  onSaved: (template: RepeatingBill) => void;
  onCancel: () => void;
}) {
  const defaultTaxCode = defaultPurchaseTaxCode(data.taxCodes);
  const lineDefaults = startingValues(data.customSetup, "line", ["bill"]);
  const [contactId, setContactId] = useState(template?.contactId ?? "");
  const [numberPattern, setNumberPattern] = useState(template ? (template.supplierInvoiceNumber ?? "") : "{date}");
  const [amountsMode, setAmountsMode] = useState<AmountsMode>(template?.amountsMode ?? "exclusive");
  const [customFields, setCustomFields] = useState<CustomValues>(() => template?.customFields ?? startingValues(data.customSetup, "document", ["bill"]));
  const [lines, setLines] = useState<EditorLine[]>(() => (template ? editorLines(template.lines, defaultTaxCode) : [blankLine(defaultTaxCode, lineDefaults)]));
  const [every, setEvery] = useState(String(template?.every ?? 1));
  const [period, setPeriod] = useState<RepeatPeriod>(template?.period ?? "month");
  const [startDate, setStartDate] = useState(template?.startDate ?? todayInBrowser());
  const [endDate, setEndDate] = useState(template?.endDate ?? "");
  const [dueRule, setDueRule] = useState<BillDueRule>(template?.dueRule ?? "days_after");
  const [dueDays, setDueDays] = useState(String(template?.dueDays ?? 20));
  const [saveAs, setSaveAs] = useState<SaveAs>(template?.saveAs ?? "draft");
  const [idempotencyKey] = useState(() => newIdempotencyKey("repeating-bill"));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const supplierOptions = data.contacts.filter((contact) => contact.isSupplier && !contact.isArchived);
  const everyNumber = /^\d{1,2}$/.test(every) ? Number(every) : 0;
  const dueNumber = /^\d{1,3}$/.test(dueDays) ? Number(dueDays) : null;
  const patternProblem = numberPatternProblem(numberPattern, period, saveAs);
  // The same date, number and due date maths as the server (RB1-RB3).
  // A template that has made bills carries on from its next date (or from today, once its schedule changes), and numbers from its history.
  const scheduleChanged = template ? period !== template.period || everyNumber !== template.every || startDate !== template.startDate : false;
  const madeSoFar = template?.runs.length ?? 0;
  const previewFrom =
    template && madeSoFar > 0 ? (scheduleChanged ? (todayInBrowser() > startDate ? todayInBrowser() : startDate) : (template.nextDate ?? startDate)) : startDate;
  const preview =
    everyNumber >= 1 && startDate ? datesBetween({ period, every: everyNumber, startDate, endDate: endDate || null }, previewFrom, "9999-12-31", 3) : [];

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const fields = {
      contactId,
      supplierInvoiceNumber: numberPattern.trim() || null,
      amountsMode,
      lines: linesForApi(lines, amountsMode !== "no_tax"),
      customFields,
      period,
      every: everyNumber,
      startDate,
      endDate: endDate || null,
      dueRule,
      dueDays: dueRule === "terms" ? 0 : dueNumber,
      saveAs,
    };
    try {
      const result = template
        ? await api<{ repeatingBill: RepeatingBill }>(`/api/repeating-bills/${template.id}`, { method: "PATCH", body: { organisationId, ...fields } })
        : await api<{ repeatingBill: RepeatingBill }>("/api/repeating-bills", {
            method: "POST",
            body: { organisationId, source: "ui", idempotencyKey, ...fields },
          });
      onSaved(result.repeatingBill);
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
          <select value={contactId} onChange={(event) => setContactId(event.target.value)} required>
            <option value="">Choose a supplier</option>
            {template && !supplierOptions.some((contact) => contact.id === template.contactId) ? (
              <option value={template.contactId}>{template.contactName} (archived or not a supplier)</option>
            ) : null}
            {supplierOptions.map((contact) => (
              <option key={contact.id} value={contact.id}>
                {contact.name}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Supplier's invoice number"
          hint="Each bill needs its own. {date} becomes the bill date, {month} its month and {n} the bill's number (1, 2, 3…). Leave it empty to make drafts without a number, to fill in from each real invoice."
        >
          <input value={numberPattern} onChange={(event) => setNumberPattern(event.target.value)} maxLength={NUMBER_PATTERN_MAX} />
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
        <Field label="Repeat every">
          <span style={{ display: "flex", gap: 8 }}>
            <input
              value={every}
              onChange={(event) => setEvery(event.target.value)}
              inputMode="numeric"
              pattern="[0-9]{1,2}"
              style={{ width: 64 }}
              aria-label="How many"
              required
            />
            <select value={period} onChange={(event) => setPeriod(event.target.value as RepeatPeriod)} aria-label="Weeks or months">
              <option value="week">week(s)</option>
              <option value="month">month(s)</option>
            </select>
          </span>
        </Field>
        <Field label="First bill date">
          <input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} required />
        </Field>
        <Field label="End date" hint="Optional. Blank repeats until you end it.">
          <input type="date" value={endDate} min={startDate || undefined} onChange={(event) => setEndDate(event.target.value)} />
        </Field>
        <Field label="Due">
          <select value={dueRule} onChange={(event) => setDueRule(event.target.value as BillDueRule)} aria-label="Due date rule">
            {BILL_DUE_RULES.map((rule) => (
              <option key={rule} value={rule} title={BILL_DUE_RULE_LABELS[rule]}>
                {SHORT_DUE_LABELS[rule]}
              </option>
            ))}
          </select>
        </Field>
        {dueRule === "terms" ? null : (
          <Field label={dueRule === "day_of_next_month" ? "Day of the month" : "Days"}>
            <input
              value={dueDays}
              onChange={(event) => setDueDays(event.target.value)}
              inputMode="numeric"
              pattern="[0-9]{1,3}"
              aria-label="Due days"
              required
            />
          </Field>
        )}
        <Field label="Each bill is" hint="Nothing is paid automatically either way.">
          <select value={saveAs} onChange={(event) => setSaveAs(event.target.value as SaveAs)}>
            <option value="draft">Saved as a draft</option>
            <option value="approve">Approved (posted)</option>
          </select>
        </Field>
      </div>
      {patternProblem ? <Notice tone="warning">{patternProblem}</Notice> : null}
      {preview.length > 0 && !patternProblem ? (
        <p className={ui.muted}>
          {preview
            .map((date, index) => {
              const due =
                dueRule === "terms"
                  ? ", due by the supplier's terms"
                  : dueNumber !== null && (dueRule !== "day_of_next_month" || (dueNumber >= 1 && dueNumber <= 31))
                    ? `, due ${formatDate(billDueDate(date, dueRule, dueNumber))}`
                    : "";
              return `${formatDate(date)}: ${billNumberFor(numberPattern, date, madeSoFar + index + 1) ?? "draft, no number yet"}${due}`;
            })
            .join("; ")}
          {preview.length === 3 ? "; …" : "."}
        </p>
      ) : null}
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
      />
      <div className={ui.actions}>
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <span className={ui.muted}>
          The template posts nothing. Each date&apos;s bill is made once, by the hourly job or &ldquo;Run now&rdquo;. Changes only affect bills not yet
          made.
        </span>
      </div>
    </form>
  );
}
