"use client";

import { type FormEvent, useState } from "react";
import { RequireOrganisation } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { Button, Card, Field, Notice, Page, PageHeader, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage } from "@/lib/client/api";
import { MONTH_NAMES } from "@/lib/financial-year";
import { formatDate } from "@/lib/format";
import type { PeriodControls } from "@/lib/ledger/period-controls";
import { CURRENCY_MINOR_UNITS } from "@/lib/money/currency";
import type { OrganisationSettings } from "@/lib/organisations/settings";

// The forms below remount when their data reloads (so the fields show what
// was saved), which would wipe their own state. Success messages therefore
// live in the parent; the forms only keep their error messages.
type SavedHandler = (message: string) => void;

function SettingsForm({ organisationId, settings, onSaved }: { organisationId: string; settings: OrganisationSettings; onSaved: SavedHandler }) {
  const [displayName, setDisplayName] = useState(settings.displayName);
  const [baseCurrency, setBaseCurrency] = useState(settings.baseCurrency);
  const [financialYearEndMonth, setFinancialYearEndMonth] = useState(settings.financialYearEndMonth);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    try {
      await api(`/api/organisations/${organisationId}/settings`, {
        method: "PATCH",
        body: { displayName, baseCurrency, financialYearEndMonth },
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
        <Field label="Financial year ends" hint="On the last day of this month. Sets report defaults and the balance sheet's current year.">
          <select value={financialYearEndMonth} onChange={(event) => setFinancialYearEndMonth(Number(event.target.value))}>
            {MONTH_NAMES.map((name, index) => (
              <option key={name} value={index + 1}>
                {name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div>
        <Button type="submit">Save settings</Button>
      </div>
    </form>
  );
}

function LocksForm({ organisationId, controls, onSaved }: { organisationId: string; controls: PeriodControls; onSaved: SavedHandler }) {
  const [lockDate, setLockDate] = useState(controls.lockDate ?? "");
  const [unlockStart, setUnlockStart] = useState(controls.unlockStart ?? "");
  const [unlockEnd, setUnlockEnd] = useState(controls.unlockEnd ?? "");
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    try {
      await api("/api/ledger/period-controls", {
        method: "PATCH",
        body: {
          organisationId,
          lockDate: lockDate || null,
          unlockStart: unlockStart || null,
          unlockEnd: unlockEnd || null,
        },
      });
      onSaved("Period locks saved.");
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} style={{ display: "grid", gap: 12 }}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <p className={ui.muted}>
        {controls.lockDate
          ? `Nothing can be posted on or before ${formatDate(controls.lockDate)}${
              controls.unlockStart ? `, except between ${formatDate(controls.unlockStart)} and ${formatDate(controls.unlockEnd)}` : ""
            }.`
          : "No lock date is set, so any date can be posted to."}
      </p>
      <div className={ui.grid3}>
        <Field label="Lock date" hint="Usually the end of the last filed GST or financial period.">
          <input type="date" value={lockDate} onChange={(event) => setLockDate(event.target.value)} />
        </Field>
        <Field label="Unlock window from" hint="Optional: temporarily reopen part of a locked period.">
          <input type="date" value={unlockStart} onChange={(event) => setUnlockStart(event.target.value)} />
        </Field>
        <Field label="Unlock window to">
          <input type="date" value={unlockEnd} onChange={(event) => setUnlockEnd(event.target.value)} />
        </Field>
      </div>
      <div className={ui.actions}>
        <Button type="submit">Save locks</Button>
        <Button
          variant="secondary"
          onClick={() => {
            setUnlockStart("");
            setUnlockEnd("");
          }}
        >
          Clear unlock window
        </Button>
      </div>
    </form>
  );
}

function Settings({ organisationId }: { organisationId: string }) {
  const { can } = useWorkspace();
  const settings = useApiData<{ settings: OrganisationSettings }>(`/api/organisations/${organisationId}/settings`);
  const controls = useApiData<{ controls: PeriodControls }>("/api/ledger/period-controls", { organisationId });
  const [saved, setSaved] = useState<{ settings: string | null; locks: string | null }>({ settings: null, locks: null });
  if (!can("admin")) {
    return <Notice tone="warning">Only organisation admins and owners can change settings.</Notice>;
  }
  return (
    <>
      <Card title="Organisation">
        {settings.error ? <Notice tone="error">{settings.error}</Notice> : null}
        {saved.settings ? <Notice tone="success">{saved.settings}</Notice> : null}
        {settings.data ? (
          <SettingsForm
            key={JSON.stringify(settings.data.settings)}
            organisationId={organisationId}
            settings={settings.data.settings}
            onSaved={(message) => {
              setSaved((current) => ({ ...current, settings: message }));
              settings.reload();
            }}
          />
        ) : null}
      </Card>
      <Card title="Period locks" description="Protects filed periods from new postings. Corrections go into an open period instead.">
        {controls.error ? <Notice tone="error">{controls.error}</Notice> : null}
        {saved.locks ? <Notice tone="success">{saved.locks}</Notice> : null}
        {controls.data ? (
          <LocksForm
            key={controls.data.controls.updatedAt}
            organisationId={organisationId}
            controls={controls.data.controls}
            onSaved={(message) => {
              setSaved((current) => ({ ...current, locks: message }));
              controls.reload();
            }}
          />
        ) : null}
      </Card>
    </>
  );
}

export default function SettingsPage() {
  return (
    <Page>
      <PageHeader title="Settings and locks" />
      <RequireOrganisation>{(organisationId) => <Settings key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
