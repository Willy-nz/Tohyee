"use client";

import { useState } from "react";
import { RequireOrganisation } from "@/components/books";
import { DateInput } from "@/components/date-input";
import { useApiData } from "@/components/hooks";
import { Card, Field, Notice, Page, PageHeader, ui } from "@/components/ui";
import { todayInBrowser } from "@/lib/format";

/** The end of the last financial year that has finished, for a year ending in `endMonth`. */
function lastYearEnd(endMonth: number, today: string): string {
  const [year, month] = today.split("-").map(Number);
  const endYear = month > endMonth ? year : year - 1;
  const lastDay = new Date(Date.UTC(endYear, endMonth, 0)).getUTCDate();
  return `${endYear}-${String(endMonth).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
}

function AccountantPack({ organisationId }: { organisationId: string }) {
  const settings = useApiData<{ settings: { financialYearEndMonth: number } }>(`/api/organisations/${organisationId}/settings`, {});
  const [yearEnd, setYearEnd] = useState<string | null>(null);
  if (settings.error) return <Notice tone="error">{settings.error}</Notice>;
  if (!settings.data) return <p className={ui.muted}>Loading…</p>;
  const chosen = yearEnd ?? lastYearEnd(settings.data.settings.financialYearEndMonth, todayInBrowser());
  const href = `/api/reports/accountant-pack?organisationId=${encodeURIComponent(organisationId)}&yearEnd=${chosen}`;
  return (
    <Card
      title="Download the pack"
      description="One ZIP file for your accountant: the trial balance, profit and loss, balance sheet and general ledger for the year (CSV, for Excel), and a bank reconciliation for each bank and credit card account as at the year end (PDF). The figures are the same as the reports on screen. Nothing is posted."
    >
      <div className={ui.inlineForm}>
        <Field label="Financial year ending" hint="The last day of the year">
          <DateInput value={chosen} onChange={(event) => setYearEnd(event.target.value || null)} />
        </Field>
        <a className={ui.button} href={href} download>
          Download ZIP
        </a>
      </div>
    </Card>
  );
}

export default function AccountantPackPage() {
  return (
    <Page>
      <PageHeader title="Year-end pack" description="The reports your accountant asks for at the year end, in one download." />
      <RequireOrganisation>{(organisationId) => <AccountantPack key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
