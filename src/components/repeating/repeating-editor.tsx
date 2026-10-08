"use client";

import { onlyNoGstCodes } from "@/components/document-tax-codes";
import Link from "next/link";
import { type FormEvent, useState } from "react";
import { CustomFieldInputs, startingValues } from "@/components/custom-fields";
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
import { ExportBadge } from "@/components/exports";
import { contactSalesTaxCode } from "@/lib/tax/exports";
import { formatDate, todayInBrowser } from "@/lib/format";
import { AMOUNTS_MODE_LABELS, AMOUNTS_MODES, type AmountsMode } from "@/lib/invoices/amounts";
import { datesBetween, type RepeatPeriod } from "@/lib/repeating/schedule";
import type { DueRule, RepeatingInvoice, RepeatingStatus, SaveAs } from "@/lib/repeating/service";

export function RepeatingStatusBadge({ status }: { status: RepeatingStatus }) {
  const badges = {
    active: { label: "Active", tone: "green" },
    paused: { label: "Paused", tone: "amber" },
    ended: { label: "Ended", tone: "neutral" },
  } as const;
  return <Badge tone={badges[status].tone}>{badges[status].label}</Badge>;
}

/** Creates a repeating invoice template, or changes one when `template` is given (RI1, RI8). */
export function RepeatingEditor({
  organisationId,
  baseCurrency,
  template,
  onSaved,
  onCancel,
}: {
  organisationId: string;
  baseCurrency: string;
  template?: RepeatingInvoice;
  onSaved: (template: RepeatingInvoice) => void;
  onCancel: () => void;
}) {
  const loaded = useSalesEditorData(organisationId);
  if (loaded.error) return <Notice tone="error">{loaded.error}</Notice>;
  if (!loaded.data) return <p className={ui.muted}>Loading…</p>;
  return (
    <RepeatingForm
      organisationId={organisationId}
      baseCurrency={baseCurrency}
      data={loaded.data}
      template={template}
      onSaved={onSaved}
      onCancel={onCancel}
    />
  );
}

function RepeatingForm({
  organisationId,
  baseCurrency,
  data,
  template,
  onSaved,
  onCancel,
}: {
  organisationId: string;
  baseCurrency: string;
  data: NonNullable<ReturnType<typeof useSalesEditorData>["data"]>;
  template?: RepeatingInvoice;
  onSaved: (template: RepeatingInvoice) => void;
  onCancel: () => void;
}) {
  const defaults = salesDefaults(data.accounts, data.taxCodes);
  const lineDefaults = startingValues(data.customSetup, "line", ["invoice"]);
  const [contactId, setContactId] = useState(template?.contactId ?? "");
  const [reference, setReference] = useState(template?.reference ?? "");
  const [amountsMode, setAmountsMode] = useState<AmountsMode>(template?.amountsMode ?? (onlyNoGstCodes(data.taxCodes) ? "no_tax" : "exclusive"));
  const [salespersonId, setSalespersonId] = useState(template?.salespersonId ?? "");
  const [customFields, setCustomFields] = useState<CustomValues>(
    () => template?.customFields ?? startingValues(data.customSetup, "document", ["invoice"]),
  );
  const [lines, setLines] = useState<EditorLine[]>(() => (template ? editorLines(template.lines, defaults) : [blankLine(defaults, lineDefaults)]));
  const [every, setEvery] = useState(String(template?.every ?? 1));
  const [period, setPeriod] = useState<RepeatPeriod>(template?.period ?? "month");
  const [startDate, setStartDate] = useState(template?.startDate ?? todayInBrowser());
  const [endDate, setEndDate] = useState(template?.endDate ?? "");
  const [dueRule, setDueRule] = useState<DueRule>(template?.dueRule ?? "terms");
  const [dueDays, setDueDays] = useState(String(template?.dueDays ?? 20));
  const [saveAs, setSaveAs] = useState<SaveAs>(template?.saveAs ?? "draft");
  const [idempotencyKey] = useState(() => newIdempotencyKey("repeating-invoice"));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const customerOptions = data.customers.filter((contact) => contact.isCustomer && !contact.isArchived);
  const everyNumber = /^\d{1,2}$/.test(every) ? Number(every) : 0;
  // The same date maths as the server (RI1, RI5, RI6).
  const preview =
    everyNumber >= 1 && startDate
      ? datesBetween({ period, every: everyNumber, startDate, endDate: endDate || null }, startDate, "9999-12-31", 4)
      : [];

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const fields = {
      contactId,
      reference: reference.trim() || null,
      amountsMode,
      lines: linesForApi(lines, amountsMode !== "no_tax"),
      customFields,
      salespersonId: salespersonId || null,
      period,
      every: everyNumber,
      startDate,
      endDate: endDate || null,
      dueRule,
      dueDays: dueRule === "days_after" ? Number(dueDays) : null,
      saveAs,
    };
    try {
      const result = template
        ? await api<{ repeatingInvoice: RepeatingInvoice }>(`/api/repeating-invoices/${template.id}`, {
            method: "PATCH",
            body: { organisationId, ...fields },
          })
        : await api<{ repeatingInvoice: RepeatingInvoice }>("/api/repeating-invoices", {
            method: "POST",
            body: { organisationId, source: "ui", idempotencyKey, ...fields },
          });
      onSaved(result.repeatingInvoice);
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
        <Field label="Customer">
          <select
            value={contactId}
            onChange={(event) => {
              setContactId(event.target.value);
              const next = data.customers.find((contact) => contact.id === event.target.value);
              setLines((current) => retaxLines(current, contactSalesTaxCode(next, data.exportSettings, data.taxCodes)));
              if (!template) {
                const chosen = data.customers.find((contact) => contact.id === event.target.value);
                setSalespersonId(customerDefault(data.salespeople, chosen?.defaultSalespersonId));
              }
            }}
            required
          >
            <option value="">Choose a customer</option>
            {template && !customerOptions.some((contact) => contact.id === template.contactId) ? (
              <option value={template.contactId}>{template.contactName} (archived or not a customer)</option>
            ) : null}
            {customerOptions.map((contact) => (
              <option key={contact.id} value={contact.id}>
                {contact.name}
              </option>
            ))}
          </select>
          <ExportBadge contact={data.customers.find((contact) => contact.id === contactId)} />
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
        <Field label="First invoice date">
          <input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} required />
        </Field>
        <Field label="End date" hint="Optional. Blank repeats until you end it.">
          <input type="date" value={endDate} min={startDate || undefined} onChange={(event) => setEndDate(event.target.value)} />
        </Field>
        <Field label="Due date">
          <select value={dueRule} onChange={(event) => setDueRule(event.target.value as DueRule)}>
            <option value="terms">The customer&apos;s payment terms</option>
            <option value="days_after">A number of days after the invoice date</option>
          </select>
        </Field>
        {dueRule === "days_after" ? (
          <Field label="Days after the invoice date">
            <input value={dueDays} onChange={(event) => setDueDays(event.target.value)} inputMode="numeric" pattern="[0-9]{1,3}" required />
          </Field>
        ) : null}
        <Field label="Each invoice is" hint="In another currency, approved only when the exchange rates list has a rate for its date; otherwise left as a draft.">
          <select value={saveAs} onChange={(event) => setSaveAs(event.target.value as SaveAs)}>
            <option value="draft">Saved as a draft</option>
            <option value="approve">Approved (posted)</option>
          </select>
        </Field>
        <SalespersonField setup={data.salespeople} value={salespersonId} onChange={setSalespersonId} />
        <Field label="Reference" hint="Optional. Put on every invoice.">
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
      {preview.length > 0 ? (
        <p className={ui.muted}>
          Invoice dates: {preview.map((date) => formatDate(date)).join(", ")}
          {preview.length === 4 ? "…" : "."}
        </p>
      ) : null}
      <CustomFieldInputs setup={data.customSetup} record="document" uses={["invoice"]} value={customFields} onChange={setCustomFields} />
      <SalesLines
        organisationId={organisationId}
        items={data.items}
        baseCurrency={baseCurrency}
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
        contact={data.customers.find((contact) => contact.id === contactId)}
        exportSettings={data.exportSettings}
      />
      <div className={ui.actions}>
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <span className={ui.muted}>
          The template posts nothing. Each date&apos;s invoice is made once, by the hourly job or &ldquo;Run now&rdquo;. Changes only affect invoices
          not yet made.
        </span>
      </div>
    </form>
  );
}
