"use client";

import { type ReactNode, useState } from "react";
import { RequireOrganisation } from "@/components/books";
import { DateInput } from "@/components/date-input";
import { useApiData } from "@/components/hooks";
import { Card, Field, Notice, Page, PageHeader, ui } from "@/components/ui";
import { todayInBrowser } from "@/lib/format";
import { CategoriesCard, ReportFormatCard, ServicePerformanceCard } from "@/components/performance-report";
import type { ReportFormat } from "@/lib/reports/performance-categories";
import { YearEndSigning } from "@/components/signing/year-end-signing";
import { StatementNotesCard } from "@/components/reports/statement-notes";
import Link from "next/link";

/** The end of the last financial year that has finished, for a year ending in `endMonth`. */
function lastYearEnd(endMonth: number, today: string): string {
  const [year, month] = today.split("-").map(Number);
  const endYear = month > endMonth ? year : year - 1;
  const lastDay = new Date(Date.UTC(endYear, endMonth, 0)).getUTCDate();
  return `${endYear}-${String(endMonth).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
}

const DOWNLOAD_TEXT: Record<ReportFormat, string> = {
  special_purpose: "Special purpose financial statements for the year, with last year beside it.",
  tier3:
    "The Tier 3 performance report for the year, with last year beside it: entity information, service performance, financial performance, financial position, cash flows, and the notes below.",
  tier4: "The Tier 4 performance report for the year, with last year beside it: entity information, service performance, cash received and cash paid, and the notes below.",
};

function Download({ organisationId, format, chosen, setYearEnd }: { organisationId: string; format: ReportFormat; chosen: string; setYearEnd: (value: string | null) => void }) {
  const href = `/api/reports/financial-statements?organisationId=${encodeURIComponent(organisationId)}&yearEnd=${chosen}`;
  if (format === "special_purpose") {
    // The statements are a report now (decision 1561): see them, edit their layout and notes, and download them there.
    return (
      <Card
        title="The statements"
        description="The annual financial statements are in Reports, beside the profit and loss and balance sheet. Edit their layout and notes, and download the PDF, there."
      >
        <div className={ui.inlineForm}>
          <Field label="Financial year ending" hint="The last day of the year">
            <DateInput value={chosen} onChange={(event) => setYearEnd(event.target.value || null)} />
          </Field>
          <Link className={`${ui.button} ${ui.primary}`} href={`/operations/reports?report=statements&yearEnd=${encodeURIComponent(chosen)}`} style={{ alignSelf: "center" }}>
            Open the statements
          </Link>
        </div>
      </Card>
    );
  }
  return (
    <Card title="Download the performance report" description={DOWNLOAD_TEXT[format]}>
      <div className={ui.inlineForm}>
        <Field label="Financial year ending" hint="The last day of the year">
          <DateInput value={chosen} onChange={(event) => setYearEnd(event.target.value || null)} />
        </Field>
        <a className={`${ui.button} ${ui.primary}`} href={href} download style={{ alignSelf: "center" }}>
          Download PDF
        </a>
      </div>
    </Card>
  );
}

/** The long cards fold away so the download stays near the top; they open when needed. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className={ui.collapsible}>
      <summary>{title}</summary>
      {children}
    </details>
  );
}

function YearEndReports({ organisationId }: { organisationId: string }) {
  const settings = useApiData<{ settings: { financialYearEndMonth: number } }>(`/api/organisations/${organisationId}/settings`, {});
  const performance = useApiData<{ settings: { format: ReportFormat } }>("/api/reports/performance/settings", { organisationId });
  const [yearEnd, setYearEnd] = useState<string | null>(null);
  const [format, setFormat] = useState<ReportFormat | null>(null);
  if (settings.error) return <Notice tone="error">{settings.error}</Notice>;
  if (!settings.data || !performance.data) return <p className={ui.muted}>Loading…</p>;
  const chosen = yearEnd ?? lastYearEnd(settings.data.settings.financialYearEndMonth, todayInBrowser());
  const current = format ?? performance.data.settings.format;
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <ReportFormatCard organisationId={organisationId} onChanged={setFormat} />
      <Download organisationId={organisationId} format={current} chosen={chosen} setYearEnd={setYearEnd} />
      {/^\d{4}-\d{2}-\d{2}$/.test(chosen) ? (
        <YearEndSigning
          key={chosen}
          organisationId={organisationId}
          yearEnd={chosen}
          downloadHref={`/api/reports/financial-statements?organisationId=${encodeURIComponent(organisationId)}&yearEnd=${chosen}`}
        />
      ) : null}
      {current !== "special_purpose" ? (
        <Section title="Statement of service performance">
          <ServicePerformanceCard organisationId={organisationId} yearEnd={chosen} />
        </Section>
      ) : null}
      {current !== "special_purpose" ? (
        <Section title="Notes">
          <StatementNotesCard key={current} organisationId={organisationId} />
        </Section>
      ) : null}
      {current !== "special_purpose" ? (
        <Section title="Categories">
          <CategoriesCard organisationId={organisationId} tier={current} />
        </Section>
      ) : null}
    </div>
  );
}

export default function FinancialStatementsPage() {
  return (
    <Page>
      <PageHeader title="Financial statements" />
      <RequireOrganisation>{(organisationId) => <YearEndReports key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
