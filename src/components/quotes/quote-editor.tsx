"use client";

import Link from "next/link";
import { type FormEvent, useState } from "react";
import { CustomFieldInputs, startingValues } from "@/components/custom-fields";
import {
  blankLine,
  type EditorLine,
  editorLines,
  linesForApi,
  salesDefaults,
  SalesLines,
  useSalesEditorData,
} from "@/components/invoices/invoice-editor";
import { customerDefault, SalespersonField } from "@/components/salespeople";
import { Badge, Button, Field, Notice, ui } from "@/components/ui";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import { todayInBrowser } from "@/lib/format";
import { AMOUNTS_MODE_LABELS, AMOUNTS_MODES, type AmountsMode } from "@/lib/invoices/amounts";
import type { Quote, QuoteSummary } from "@/lib/quotes/service";
import type { CustomValues } from "@/lib/custom-fields/values";

export function QuoteStatusBadge({ quote }: { quote: Pick<QuoteSummary, "status" | "expired"> }) {
  if (quote.expired) return <Badge tone="amber">Expired</Badge>;
  const badges = {
    draft: { label: "Draft", tone: "neutral" },
    finalised: { label: "Finalised", tone: "blue" },
    accepted: { label: "Accepted", tone: "green" },
    declined: { label: "Declined", tone: "red" },
  } as const;
  const badge = badges[quote.status];
  return <Badge tone={badge.tone}>{badge.label}</Badge>;
}

function addDays(date: string, days: number): string {
  const moved = new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000);
  return moved.toISOString().slice(0, 10);
}

/** Creates a draft quote, or edits one when `quote` is given (QT1). */
export function QuoteEditor({
  organisationId,
  baseCurrency,
  quote,
  onSaved,
  onCancel,
}: {
  organisationId: string;
  baseCurrency: string;
  quote?: Quote;
  onSaved: (quote: Quote) => void;
  onCancel: () => void;
}) {
  const loaded = useSalesEditorData(organisationId);
  if (loaded.error) return <Notice tone="error">{loaded.error}</Notice>;
  if (!loaded.data) return <p className={ui.muted}>Loading…</p>;
  return <QuoteForm organisationId={organisationId} baseCurrency={baseCurrency} data={loaded.data} quote={quote} onSaved={onSaved} onCancel={onCancel} />;
}

function QuoteForm({
  organisationId,
  baseCurrency,
  data,
  quote,
  onSaved,
  onCancel,
}: {
  organisationId: string;
  baseCurrency: string;
  data: NonNullable<ReturnType<typeof useSalesEditorData>["data"]>;
  quote?: Quote;
  onSaved: (quote: Quote) => void;
  onCancel: () => void;
}) {
  const defaults = salesDefaults(data.accounts, data.taxCodes);
  const lineDefaults = startingValues(data.customSetup, "line", ["invoice"]);
  const today = todayInBrowser();
  const [contactId, setContactId] = useState(quote?.contactId ?? "");
  const [quoteDate, setQuoteDate] = useState(quote?.quoteDate ?? today);
  const [expiryDate, setExpiryDate] = useState(quote ? (quote.expiryDate ?? "") : addDays(today, 30));
  const [reference, setReference] = useState(quote?.reference ?? "");
  const [terms, setTerms] = useState(quote?.terms ?? "");
  const [amountsMode, setAmountsMode] = useState<AmountsMode>(quote?.amountsMode ?? "exclusive");
  const [salespersonId, setSalespersonId] = useState(quote?.salespersonId ?? "");
  const [customFields, setCustomFields] = useState<CustomValues>(() => quote?.customFields ?? startingValues(data.customSetup, "document", ["invoice"]));
  const [lines, setLines] = useState<EditorLine[]>(() => (quote ? editorLines(quote.lines, defaults) : [blankLine(defaults, lineDefaults)]));
  const [idempotencyKey] = useState(() => newIdempotencyKey("quote"));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const customerOptions = data.customers.filter((contact) => contact.isCustomer && !contact.isArchived);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const fields = {
      contactId,
      quoteDate,
      expiryDate: expiryDate || null,
      reference: reference.trim() || null,
      terms: terms.trim() || null,
      amountsMode,
      lines: linesForApi(lines, amountsMode !== "no_tax"),
      customFields,
      salespersonId: salespersonId || null,
    };
    try {
      const result = quote
        ? await api<{ quote: Quote }>(`/api/quotes/${quote.id}`, { method: "PATCH", body: { organisationId, ...fields } })
        : await api<{ quote: Quote }>("/api/quotes", { method: "POST", body: { organisationId, source: "ui", idempotencyKey, ...fields } });
      onSaved(result.quote);
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
              if (!quote) {
                const chosen = data.customers.find((contact) => contact.id === event.target.value);
                setSalespersonId(customerDefault(data.salespeople, chosen?.defaultSalespersonId));
              }
            }}
            required
          >
            <option value="">Choose a customer</option>
            {quote && !customerOptions.some((contact) => contact.id === quote.contactId) ? (
              <option value={quote.contactId}>{quote.contactName} (archived or not a customer)</option>
            ) : null}
            {customerOptions.map((contact) => (
              <option key={contact.id} value={contact.id}>
                {contact.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Quote date">
          <input type="date" value={quoteDate} onChange={(event) => setQuoteDate(event.target.value)} required />
        </Field>
        <Field label="Expiry date" hint="Optional. After it, the quote shows as expired.">
          <input type="date" value={expiryDate} min={quoteDate || undefined} onChange={(event) => setExpiryDate(event.target.value)} />
        </Field>
        <SalespersonField setup={data.salespeople} value={salespersonId} onChange={setSalespersonId} />
        <Field label="Reference" hint="Optional. Carried to the invoice when it's accepted.">
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
      <Field label="Terms" hint="Optional. Printed on the quote.">
        <textarea value={terms} onChange={(event) => setTerms(event.target.value)} maxLength={2000} rows={2} />
      </Field>
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
      />
      <div className={ui.actions}>
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save draft"}
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <span className={ui.muted}>Quotes post nothing. Finalise it to give it a number, then accept it to make the invoice.</span>
      </div>
    </form>
  );
}
