"use client";

import Link from "next/link";
import { type FormEvent, useState } from "react";
import { RequireOrganisation } from "@/components/books";
import { ModulesCard } from "@/components/modules";
import { LogoCard } from "@/components/organisation/logo-card";
import { useApiData } from "@/components/hooks";
import { Button, Card, Field, Notice, Page, PageHeader, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage } from "@/lib/client/api";
import { MONTH_NAMES } from "@/lib/financial-year";
import { formatDate, formatGstNumber } from "@/lib/format";
import type { PeriodControls } from "@/lib/ledger/period-controls";
import { CURRENCY_MINOR_UNITS } from "@/lib/money/currency";
import type { OrganisationSettings } from "@/lib/organisations/settings";
import { describeGstPeriodSetting, gstPeriodSetting } from "@/lib/reports/gst-boxes";
import { GST_BASES, GST_BASIS_LABELS, type GstBasis } from "@/lib/tax/categories";
import type { TaxCode } from "@/lib/tax/codes";
import { codesForSide, unavailableNote } from "@/lib/tax/available-on";

/** The GST filing frequency choices (GP1): "months:endMonth", or "" for not set. */
const GST_PERIOD_CHOICES: Array<{ value: string; label: string }> = [
  { value: "", label: "Not set" },
  ...[
    gstPeriodSetting(1, 1),
    gstPeriodSetting(2, 1),
    gstPeriodSetting(2, 2),
    ...[1, 2, 3, 4, 5, 6].map((month) => gstPeriodSetting(6, month)),
  ].map((setting) => ({ value: `${setting.months}:${setting.endMonth}`, label: describeGstPeriodSetting(setting) })),
];

// The forms below remount when their data reloads (so the fields show what
// was saved), which would wipe their own state. Success messages therefore
// live in the parent; the forms only keep their error messages.
type SavedHandler = (message: string) => void;

function SettingsForm({
  organisationId,
  settings,
  taxCodes,
  onSaved,
}: {
  organisationId: string;
  settings: OrganisationSettings;
  taxCodes: TaxCode[];
  onSaved: SavedHandler;
}) {
  const [displayName, setDisplayName] = useState(settings.displayName);
  const [baseCurrency, setBaseCurrency] = useState(settings.baseCurrency);
  const [financialYearEndMonth, setFinancialYearEndMonth] = useState(settings.financialYearEndMonth);
  const [gstBasis, setGstBasis] = useState<GstBasis>(settings.gstBasis);
  const [gstPeriod, setGstPeriod] = useState(settings.gstPeriod ? `${settings.gstPeriod.months}:${settings.gstPeriod.endMonth}` : "");
  const [allowNegativeStock, setAllowNegativeStock] = useState(settings.allowNegativeStock);
  const [foreignTrade, setForeignTrade] = useState(settings.foreignTrade);
  const [exportTaxCode, setExportTaxCode] = useState(settings.exportTaxCode ?? "");
  // Only zero-rated codes available on sales can be the tax code for exports (EX13, TAO7).
  const zeroRated = codesForSide(taxCodes, "sales").filter(
    (code) => code.category === "zero_rated" && (code.isActive || code.code === settings.exportTaxCode),
  );
  const [postalAddress, setPostalAddress] = useState(settings.postalAddress ?? "");
  const [gstNumber, setGstNumber] = useState(settings.gstNumber ? formatGstNumber(settings.gstNumber) : "");
  // Issue #180: registered for GST, optionally from and until a date (NR5, NR6).
  const [gstRegistered, setGstRegistered] = useState(settings.gstRegistered);
  const [gstRegisteredFrom, setGstRegisteredFrom] = useState(settings.gstRegisteredFrom ?? "");
  const [gstRegisteredUntil, setGstRegisteredUntil] = useState(settings.gstRegisteredUntil ?? "");
  const [paymentDetails, setPaymentDetails] = useState(settings.paymentDetails ?? "");
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    try {
      await api(`/api/organisations/${organisationId}/settings`, {
        method: "PATCH",
        body: {
          displayName,
          baseCurrency,
          financialYearEndMonth,
          gstBasis,
          gstPeriodMonths: gstPeriod === "" ? null : Number(gstPeriod.split(":")[0]),
          gstPeriodEndMonth: gstPeriod === "" ? null : Number(gstPeriod.split(":")[1]),
          allowNegativeStock,
          foreignTrade,
          ...(exportTaxCode ? { exportTaxCode } : {}),
          postalAddress: postalAddress.trim() || null,
          gstNumber: gstNumber.trim() || null,
          gstRegistered,
          gstRegisteredFrom: gstRegistered ? gstRegisteredFrom || null : null,
          gstRegisteredUntil: gstRegistered ? gstRegisteredUntil || null : null,
          paymentDetails: paymentDetails.trim() || null,
        },
      });
      onSaved(
        displayName === settings.displayName
          ? "Saved."
          : "Saved. Reload the page to see the new name in the organisation picker.",
      );
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} style={{ display: "grid", gap: 12 }}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.grid3}>
        <Field label="Organisation name">
          <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={150} required />
        </Field>
        <Field
          label="Base currency"
          hint={settings.hasPostings ? "Fixed now that journals have been posted." : "Every journal is posted in this currency."}
        >
          <select value={baseCurrency} disabled={settings.hasPostings} onChange={(event) => setBaseCurrency(event.target.value)}>
            {Object.keys(CURRENCY_MINOR_UNITS).map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Financial year ends" hint="On the last day of this month. Sets report defaults and the balance sheet's current year. It can't change while a financial year is closed.">
          <select value={financialYearEndMonth} onChange={(event) => setFinancialYearEndMonth(Number(event.target.value))}>
            {MONTH_NAMES.map((name, index) => (
              <option key={name} value={index + 1}>
                {name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <h3 style={{ margin: "8px 0 0" }}>GST</h3>
      <label className={ui.checkbox}>
        <input type="checkbox" checked={gstRegistered} onChange={(event) => setGstRegistered(event.target.checked)} />
        Registered for GST. When it&apos;s off, documents use only tax codes with no GST, print as &ldquo;Invoice&rdquo;, and the
        GST return and GST audit are hidden.
      </label>
      {gstRegistered ? (
        <div className={ui.grid3}>
          <Field label="GST number" hint="Printed on tax invoices and credit notes. Without it, invoices print as “Invoice”, not “Tax invoice”.">
            <input value={gstNumber} onChange={(event) => setGstNumber(event.target.value)} maxLength={20} placeholder="123-456-789" />
          </Field>
          <Field label="Registered from" hint="Blank if registered from the start. Documents dated before it can't have GST.">
            <input type="date" value={gstRegisteredFrom} onChange={(event) => setGstRegisteredFrom(event.target.value)} />
          </Field>
          <Field label="Registration ended" hint="Blank while still registered. Documents dated after it can't have GST; the last GST return covers up to it.">
            <input type="date" value={gstRegisteredUntil} onChange={(event) => setGstRegisteredUntil(event.target.value)} />
          </Field>
          <Field label="GST basis" hint="How GST returns are worked out. The payments basis is for sales of $2 million or less in the last 12 months (Tohyee doesn't check this). After a change, the next GST return suggests the adjustment IRD asks for.">
            <select value={gstBasis} onChange={(event) => setGstBasis(event.target.value as GstBasis)}>
              {GST_BASES.map((basis) => (
                <option key={basis} value={basis}>
                  {GST_BASIS_LABELS[basis]}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label="GST filing frequency"
            hint="How often you file GST with IRD, and which months periods end in (IRD lines two-monthly and six-monthly periods up with your balance date unless you asked otherwise). The GST return, Home and the period close use it."
          >
            <select value={gstPeriod} onChange={(event) => setGstPeriod(event.target.value)}>
              {GST_PERIOD_CHOICES.map((choice) => (
                <option key={choice.value} value={choice.value}>
                  {choice.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
      ) : null}
      {gstRegistered ? <h3 style={{ margin: "8px 0 0" }}>Exports</h3> : null}
      <div className={ui.grid3} hidden={!gstRegistered}>
        <label className={ui.checkbox}>
          <input type="checkbox" checked={foreignTrade} onChange={(event) => setForeignTrade(event.target.checked)} />
          Foreign trade: new sales lines for customers outside New Zealand (by their delivery country, else their billing country)
          start with the tax code for exports. A customer&apos;s own default sales tax code comes first, and any line can be changed.
        </label>
        <Field
          label="Tax code for exports"
          hint="A zero-rated code. Exported goods and most services to non-residents are zero-rated (GST at 0%), not exempt, so they count in Box 5 and Box 6 of the GST return."
        >
          <select value={exportTaxCode} onChange={(event) => setExportTaxCode(event.target.value)}>
            {exportTaxCode === "" ? <option value="">None</option> : null}
            {zeroRated.map((code) => (
              <option key={code.id} value={code.code}>
                {code.code} ({code.label}){unavailableNote(code)}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <h3 style={{ margin: "8px 0 0" }}>On printed invoices, credit notes and quotes</h3>
      <div className={ui.grid3}>
        <Field label="Address" hint="Your postal or business address, printed under your name.">
          <textarea value={postalAddress} onChange={(event) => setPostalAddress(event.target.value)} maxLength={500} rows={3} />
        </Field>
        <Field label="How to pay" hint="Printed on approved invoices, e.g. the bank account number and what to use as the reference.">
          <textarea value={paymentDetails} onChange={(event) => setPaymentDetails(event.target.value)} maxLength={1000} rows={3} />
        </Field>
      </div>
      <label className={ui.checkbox}>
        <input type="checkbox" checked={allowNegativeStock} onChange={(event) => setAllowNegativeStock(event.target.checked)} />
        Allow negative stock: sell stock items before their bill is in. The sale is costed at the average (or the last or purchase
        cost); the bill that fills the shortfall puts any difference to cost of sales. It can&apos;t be turned off while anything is
        below zero.
      </label>
      <div>
        <Button type="submit">Save settings</Button>
      </div>
    </form>
  );
}

function Settings({ organisationId }: { organisationId: string }) {
  const { can } = useWorkspace();
  const settings = useApiData<{ settings: OrganisationSettings }>(`/api/organisations/${organisationId}/settings`);
  const controls = useApiData<{ controls: PeriodControls }>("/api/ledger/period-controls", { organisationId });
  const taxCodes = useApiData<{ taxCodes: TaxCode[] }>("/api/tax/codes", { organisationId });
  const [saved, setSaved] = useState<{ settings: string | null }>({ settings: null });
  if (!can("admin")) {
    return <Notice tone="warning">Only organisation admins and owners can change settings.</Notice>;
  }
  return (
    <>
      <Card title="Organisation">
        {settings.error ? <Notice tone="error">{settings.error}</Notice> : null}
        {taxCodes.error ? <Notice tone="error">{taxCodes.error}</Notice> : null}
        {saved.settings ? <Notice tone="success">{saved.settings}</Notice> : null}
        {settings.data && taxCodes.data ? (
          <SettingsForm
            key={JSON.stringify(settings.data.settings)}
            organisationId={organisationId}
            settings={settings.data.settings}
            taxCodes={taxCodes.data.taxCodes}
            onSaved={(message) => {
              setSaved((current) => ({ ...current, settings: message }));
              settings.reload();
            }}
          />
        ) : null}
      </Card>
      <LogoCard organisationId={organisationId} />
      <Card title="Period locks" description="Months are closed, and reopened, on Accounting › Period close. Nothing can be posted in a closed month.">
        {controls.error ? <Notice tone="error">{controls.error}</Notice> : null}
        {controls.data ? (
          <p className={ui.muted}>
            {controls.data.controls.lockDate
              ? `Closed up to ${formatDate(controls.data.controls.lockDate)}: nothing can be posted on or before it.`
              : "Nothing is closed yet, so any date can be posted to."}{" "}
            <Link href="/operations/period-close">Period close</Link>
          </p>
        ) : null}
      </Card>
      <ModulesCard organisationId={organisationId} />
    </>
  );
}

export default function SettingsPage() {
  return (
    <Page>
      <PageHeader title="Settings" />
      <RequireOrganisation>{(organisationId) => <Settings key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
