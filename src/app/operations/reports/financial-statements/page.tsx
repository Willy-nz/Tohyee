"use client";

import { useState } from "react";
import { RequireOrganisation } from "@/components/books";
import { DateInput } from "@/components/date-input";
import { useApiData } from "@/components/hooks";
import { Button, Card, Field, Notice, Page, PageHeader, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage } from "@/lib/client/api";
import { todayInBrowser } from "@/lib/format";
import { CategoriesCard, ReportFormatCard, ServicePerformanceCard } from "@/components/performance-report";
import type { StatementNote, StatementNotes } from "@/lib/reports/financial-statements";
import type { ReportFormat } from "@/lib/reports/performance-categories";

/** The end of the last financial year that has finished, for a year ending in `endMonth`. */
function lastYearEnd(endMonth: number, today: string): string {
  const [year, month] = today.split("-").map(Number);
  const endYear = month > endMonth ? year : year - 1;
  const lastDay = new Date(Date.UTC(endYear, endMonth, 0)).getUTCDate();
  return `${endYear}-${String(endMonth).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
}

const DOWNLOAD_TEXT: Record<ReportFormat, string> = {
  special_purpose:
    "Special purpose financial statements for the year, with last year beside it: financial performance, financial position, changes in equity, cash flows, and the notes below. The figures are the same as the reports on screen.",
  tier3:
    "The Tier 3 performance report for the year, with last year beside it: entity information, service performance, financial performance, financial position, cash flows, and the notes below.",
  tier4: "The Tier 4 performance report for the year, with last year beside it: entity information, service performance, cash received and cash paid, and the notes below.",
};

function Download({ organisationId, format, chosen, setYearEnd }: { organisationId: string; format: ReportFormat; chosen: string; setYearEnd: (value: string | null) => void }) {
  const href = `/api/reports/financial-statements?organisationId=${encodeURIComponent(organisationId)}&yearEnd=${chosen}`;
  return (
    <Card title={format === "special_purpose" ? "Download the statements" : "Download the performance report"} description={DOWNLOAD_TEXT[format]}>
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

function NotesEditor({ organisationId, loaded }: { organisationId: string; loaded: StatementNotes }) {
  const { can } = useWorkspace();
  const [notes, setNotes] = useState<StatementNote[]>(loaded.notes);
  const [saved, setSaved] = useState(loaded.saved);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const edit = (index: number, change: Partial<StatementNote>) => setNotes(notes.map((note, at) => (at === index ? { ...note, ...change } : note)));
  async function save(list: StatementNote[]) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await api<StatementNotes>("/api/reports/financial-statement-notes", { method: "PUT", body: { organisationId, notes: list } });
      setNotes(result.notes);
      setSaved(result.saved);
      setMessage(result.saved ? "Notes saved." : "Back to the drafts.");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }
  const editable = can("bookkeeper");
  return (
    <Card
      title="Notes"
      description={
        saved
          ? "Your notes, printed after the statements."
          : "Drafts to start from: fill in the parts in [square brackets] and have them checked. Until you save them, the PDF marks the notes as drafts."
      }
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      {message ? <Notice tone="success">{message}</Notice> : null}
      <div style={{ display: "grid", gap: 16 }}>
        {notes.map((note, index) => (
          <div key={index} style={{ display: "grid", gap: 6 }}>
            <Field label={`Note ${index + 1} title`}>
              <input value={note.title} disabled={!editable} maxLength={150} onChange={(event) => edit(index, { title: event.target.value })} />
            </Field>
            <Field label={`Note ${index + 1} text`}>
              <textarea rows={4} value={note.body} disabled={!editable} maxLength={10000} onChange={(event) => edit(index, { body: event.target.value })} />
            </Field>
            {editable ? (
              <div>
                <Button variant="secondary" size="small" onClick={() => setNotes(notes.filter((_, at) => at !== index))}>
                  Remove note {index + 1}
                </Button>
              </div>
            ) : null}
          </div>
        ))}
      </div>
      {editable ? (
        <div className={ui.rowButtons} style={{ marginTop: 16 }}>
          <Button variant="secondary" onClick={() => setNotes([...notes, { title: "", body: "" }])}>
            Add a note
          </Button>
          <Button disabled={busy} onClick={() => void save(notes)}>
            {busy ? "Saving…" : "Save notes"}
          </Button>
          {saved ? (
            <Button variant="secondary" disabled={busy} onClick={() => void save([])}>
              Go back to the drafts
            </Button>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}

function Notes({ organisationId }: { organisationId: string }) {
  const notes = useApiData<StatementNotes>("/api/reports/financial-statement-notes", { organisationId });
  if (notes.error) return <Notice tone="error">{notes.error}</Notice>;
  if (!notes.data) return null;
  return <NotesEditor organisationId={organisationId} loaded={notes.data} />;
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
      {current !== "special_purpose" ? <ServicePerformanceCard organisationId={organisationId} yearEnd={chosen} /> : null}
      <Notes key={current} organisationId={organisationId} />
      {current !== "special_purpose" ? <CategoriesCard organisationId={organisationId} tier={current} /> : null}
    </div>
  );
}

export default function FinancialStatementsPage() {
  return (
    <Page>
      <PageHeader
        title="Financial statements"
        description="Year-end financial statements, or a not-for-profit's Tier 3 or Tier 4 performance report, with your notes, as one PDF."
      />
      <RequireOrganisation>{(organisationId) => <YearEndReports key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
