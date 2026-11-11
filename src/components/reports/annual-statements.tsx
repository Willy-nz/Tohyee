"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Fragment, useState } from "react";
import { DateInput } from "@/components/date-input";
import { useApiData } from "@/components/hooks";
import { InfoTip } from "@/components/info-tip";
import { MoreMenu } from "@/components/more-menu";
import { useYearEndMonth } from "@/components/reports/report-frame";
import { useReportLayout } from "@/components/reports/report-layout";
import { NotesEditor } from "@/components/reports/statement-notes";
import { Money } from "@/components/books";
import { Badge, Button, Field, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage } from "@/lib/client/api";
import type { DepreciationSchedule, ScheduleAmounts } from "@/lib/fixed-assets/schedule";
import type { AnnualTexts } from "@/lib/reports/annual-document";
import { formatDate, todayInBrowser } from "@/lib/format";
import { accountTransactionsHref } from "@/lib/reports/drilldown";
import type { AnnualPage, FinancialStatement, FinancialStatements, StatementLine } from "@/lib/reports/financial-statements";
import { statementValue } from "@/lib/reports/statement-format";

/** The end of the last financial year that has finished, for a year ending in `endMonth`. */
function lastYearEnd(endMonth: number, today: string): string {
  const [year, month] = today.split("-").map(Number);
  const endYear = month > endMonth ? year : year - 1;
  const lastDay = new Date(Date.UTC(endYear, endMonth, 0)).getUTCDate();
  return `${endYear}-${String(endMonth).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
}

function rowClass(line: StatementLine): string | undefined {
  if (line.kind === "section") return ui.reportHeading;
  if (line.kind === "total") return ui.reportGrand;
  if (line.kind === "subtotal") return ui.reportTotal;
  return ui.reportSection;
}

const ZERO = /^-?0*(\.0*)?$/;

/** An amount, linked to the transactions that make it up when it's accounts' (decision 1575). */
function Amount({ statement, line, year }: { statement: FinancialStatement; line: StatementLine; year: "current" | "prior" }) {
  const value = line[year];
  const text = statementValue(line, value);
  const dates = statement.drill?.[year];
  if (!dates || !line.accountIds || line.accountIds.length === 0 || value == null || ZERO.test(value) || (line.format && line.format !== "money")) return <>{text}</>;
  const href = accountTransactionsHref(line.accountIds.length === 1 ? { accountId: line.accountIds[0], ...dates } : { accountIds: line.accountIds, ...dates });
  return (
    <Link href={href} title={`What makes up ${line.label}`}>
      {text}
    </Link>
  );
}

function StatementTable({
  statement,
  columns,
  action,
  title,
}: {
  statement: FinancialStatement;
  columns: FinancialStatements["columns"];
  action: React.ReactNode;
  title?: React.ReactNode;
}) {
  return (
    <section aria-label={statement.title}>
      <header className={ui.statementHeading}>
        <h3 className={ui.statementTitle}>{title ?? statement.title}</h3>
        <p>{statement.subtitle}</p>
        {statement.layout ? <p className={ui.muted}>In the layout {statement.layout.title}</p> : null}
        {action ? (
          <div data-print="hide" style={{ marginTop: 8 }}>
            {action}
          </div>
        ) : null}
      </header>
      <div className={ui.statementWrap}>
        <table id={`annual-${statement.key}`} className={`${ui.table} ${ui.statement}`}>
          <thead>
            <tr>
              <th>
                <span className={ui.srOnly}>Item</span>
              </th>
              <th className={ui.num}>{columns.current}</th>
              <th className={ui.num}>{columns.prior}</th>
            </tr>
          </thead>
          <tbody>
            {statement.lines.map((line) =>
              line.kind === "section" ? (
                <tr key={line.key} className={rowClass(line)}>
                  <td colSpan={3}>{line.label}</td>
                </tr>
              ) : (
                <tr key={line.key} className={rowClass(line)}>
                  <td>
                    {line.label}
                    {line.note ? <div className={ui.muted}>{line.note}</div> : null}
                  </td>
                  <td className={ui.num}>
                    <Amount statement={statement} line={line} year="current" />
                  </td>
                  <td className={ui.num}>
                    <Amount statement={statement} line={line} year="prior" />
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      </div>
      {statement.paragraphs.map((paragraph, index) => (
        <p key={index} className={ui.reportNote}>
          {paragraph}
        </p>
      ))}
    </section>
  );
}

/** Text shown as it is, or a box to type in while editing. */
function Editable({
  editing,
  value,
  onChange,
  label,
  multiline,
  placeholder,
}: {
  editing: boolean;
  value: string;
  onChange: (value: string) => void;
  label: string;
  multiline?: boolean;
  placeholder?: string;
}) {
  if (!editing) return <>{value}</>;
  const style = { width: "100%", font: "inherit" } as const;
  return multiline ? (
    <textarea aria-label={label} rows={Math.min(12, Math.max(3, value.split("\n").length + 1))} value={value} placeholder={placeholder} style={style} onChange={(event) => onChange(event.target.value)} />
  ) : (
    <input aria-label={label} value={value} placeholder={placeholder} style={style} onChange={(event) => onChange(event.target.value)} />
  );
}

/** The year's depreciation schedule (FS12). */
function DepreciationTable({ schedule }: { schedule: DepreciationSchedule }) {
  const cells = (entry: ScheduleAmounts) =>
    (["cost", "opening", "additions", "disposals", "depreciation", "closing"] as const).map((key) => (
      <td key={key} className={ui.num}>
        <Money value={entry[key]} />
      </td>
    ));
  return (
    <div className={ui.statementWrap}>
      <table className={`${ui.table} ${ui.statement}`}>
        <thead>
          <tr>
            <th>Asset</th>
            <th>Rate</th>
            <th className={ui.num}>Cost</th>
            <th className={ui.num}>Opening</th>
            <th className={ui.num}>Additions</th>
            <th className={ui.num}>Disposals</th>
            <th className={ui.num}>Depreciation</th>
            <th className={ui.num}>Closing</th>
          </tr>
        </thead>
        <tbody>
          {schedule.groups.map((group) => (
            <Fragment key={group.typeName}>
              <tr className={ui.reportHeading}>
                <td colSpan={8}>{group.typeName}</td>
              </tr>
              {group.assets.map((asset) => (
                <tr key={asset.id} className={ui.reportSection}>
                  <td>{asset.disposedOn ? `${asset.name} (disposed of ${formatDate(asset.disposedOn)})` : asset.name}</td>
                  <td>{asset.rate}</td>
                  {cells(asset)}
                </tr>
              ))}
              <tr className={ui.reportTotal}>
                <td colSpan={2}>Total {group.typeName}</td>
                {cells(group.totals)}
              </tr>
            </Fragment>
          ))}
          <tr className={ui.reportGrand}>
            <td colSpan={2}>Total</td>
            {cells(schedule.totals)}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/**
 * Annual financial statements as one document, one page at a time (FS4-FS14,
 * decisions 1559-1561, 1576-1577): cover, contents, compilation report, the
 * statements, notes and depreciation schedule, with Previous and Next. Edit
 * changes every piece of wording in place; Save as draft or Save as final
 * keeps it for the year. Amounts click through to their transactions.
 */
export function AnnualStatementsReport({ organisationId }: { organisationId: string }) {
  const params = useSearchParams();
  const { can } = useWorkspace();
  const yearEndMonth = useYearEndMonth(organisationId);
  const fallback = lastYearEnd(yearEndMonth, todayInBrowser());
  const [chosen, setChosen] = useState<string | null>(params.get("yearEnd"));
  const yearEnd = chosen ?? fallback;
  const [typed, setTyped] = useState(yearEnd);
  const report = useApiData<FinancialStatements>("/api/reports/annual-statements", { organisationId, yearEnd });
  const plLayout = useReportLayout(organisationId, "profit_and_loss");
  const bsLayout = useReportLayout(organisationId, "balance_sheet");
  const cfLayout = useReportLayout(organisationId, "cash_flows");
  const ceLayout = useReportLayout(organisationId, "changes_in_equity");
  const [pageIndex, setPageIndex] = useState(0);
  const [draft, setDraft] = useState<AnnualTexts | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const data = report.data;
  const editing = draft !== null;
  const pdf = `/api/reports/financial-statements?organisationId=${encodeURIComponent(organisationId)}&yearEnd=${encodeURIComponent(yearEnd)}&kind=statements`;
  const layoutFor = (statement: FinancialStatement) => (statement.base === "profit_and_loss" ? plLayout : statement.base === "balance_sheet" ? bsLayout : statement.base === "cash_flows" ? cfLayout : statement.base === "changes_in_equity" ? ceLayout : null);
  const pages = data?.pages ?? [];
  const page = pages[Math.min(pageIndex, Math.max(0, pages.length - 1))];
  const texts = draft ?? data?.document.texts ?? null;
  const change = (patch: Partial<AnnualTexts>) => setDraft((current) => (current ? { ...current, ...patch } : current));
  const heading = (key: AnnualPage["key"], fallbackTitle: string) =>
    editing ? (
      <Editable editing value={draft!.titles[key] ?? fallbackTitle} label="Page heading" onChange={(value) => change({ titles: { ...draft!.titles, [key]: value } })} />
    ) : (
      fallbackTitle
    );

  async function save(status: "draft" | "final") {
    if (!draft || !data) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await api("/api/reports/annual-statements", { method: "PUT", body: { organisationId, yearEnd: data.yearEnd, status, texts: draft } });
      setDraft(null);
      setMessage(status === "draft" ? "Saved as a draft. Every page says DRAFT until you save it as final." : "Saved as final.");
      report.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  function go(index: number) {
    setPageIndex(Math.max(0, Math.min(pages.length - 1, index)));
  }

  function pageBody() {
    if (!data || !page || !texts) return null;
    if (page.key === "cover") {
      return (
        <div className={ui.annualCover}>
          <div style={{ display: "grid", gap: 8 }}>
            <h2 className={ui.statementTitle} style={{ fontSize: "var(--text-2xl, 1.75rem)" }}>
              <Editable editing={editing} value={texts.coverTitle} label="Cover title" onChange={(value) => change({ coverTitle: value })} />
            </h2>
            <p style={{ margin: 0, fontWeight: 600, fontSize: "var(--text-lg)" }}>
              <Editable editing={editing} value={texts.coverSubtitle} label="Cover subtitle" onChange={(value) => change({ coverSubtitle: value })} />
            </p>
            <p style={{ margin: 0 }}>
              <Editable editing={editing} value={texts.coverPeriod} label="Cover period" onChange={(value) => change({ coverPeriod: value })} />
            </p>
          </div>
          <p className={ui.muted} style={{ margin: 0 }}>
            <Editable editing={editing} value={texts.coverNote} label="Cover note" placeholder="Left off when blank" onChange={(value) => change({ coverNote: value })} />
          </p>
        </div>
      );
    }
    if (page.key === "contents") {
      return (
        <>
          <h3 className={ui.statementTitle}>{heading("contents", page.title)}</h3>
          <table className={`${ui.table} ${ui.statement}`} style={{ marginTop: 16 }}>
            <tbody>
              {pages.slice(2).map((entry, index) => (
                <tr key={entry.key} className={ui.reportSection}>
                  <td>
                    <button type="button" className={ui.linkButton} onClick={() => go(index + 2)}>
                      {entry.title}
                    </button>
                  </td>
                  <td className={ui.num}>{index + 3}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className={ui.muted}>Made from the pages after it. In the PDF, a page that runs onto a second sheet moves the numbers after it on.</p>
        </>
      );
    }
    if (page.key === "compilation") {
      return (
        <div style={{ display: "grid", gap: 12 }}>
          <h3 className={ui.statementTitle}>
            <Editable editing={editing} value={texts.compilationTitle} label="Compilation report title" onChange={(value) => change({ compilationTitle: value })} />
          </h3>
          {texts.compilationSections.map((section, index) => (
            <div key={index} style={{ display: "grid", gap: 4 }}>
              <strong>
                <Editable
                  editing={editing}
                  value={section.heading}
                  label={`Section ${index + 1} heading`}
                  onChange={(value) => change({ compilationSections: texts.compilationSections.map((entry, at) => (at === index ? { ...entry, heading: value } : entry)) })}
                />
              </strong>
              {editing ? (
                <Editable
                  editing
                  multiline
                  value={section.body}
                  label={`Section ${index + 1} text`}
                  onChange={(value) => change({ compilationSections: texts.compilationSections.map((entry, at) => (at === index ? { ...entry, body: value } : entry)) })}
                />
              ) : (
                section.body.split(/\n{2,}/).map((paragraph, at) => (
                  <p key={at} className={ui.reportNote} style={{ margin: 0 }}>
                    {paragraph}
                  </p>
                ))
              )}
              {editing ? (
                <div>
                  <Button variant="secondary" size="small" onClick={() => change({ compilationSections: texts.compilationSections.filter((_, at) => at !== index) })}>
                    Remove this section
                  </Button>
                </div>
              ) : null}
            </div>
          ))}
          {editing ? (
            <div>
              <Button variant="secondary" size="small" onClick={() => change({ compilationSections: [...texts.compilationSections, { heading: "", body: "" }] })}>
                Add a section
              </Button>
            </div>
          ) : null}
          <div style={{ whiteSpace: "pre-line", marginTop: 12 }}>
            <Editable editing={editing} multiline value={texts.compilationSignOff} label="Sign-off" onChange={(value) => change({ compilationSignOff: value })} />
          </div>
        </div>
      );
    }
    if (page.key === "notes") {
      return (
        <section aria-label="Notes to the financial statements">
          <header className={ui.statementHeading}>
            <h3 className={ui.statementTitle}>{heading("notes", page.title)}</h3>
            <p>{data.period}</p>
          </header>
          {editing ? (
            <NotesEditor key={`${data.yearEnd}-${data.notes.saved}`} organisationId={organisationId} loaded={data.notes} onSaved={report.reload} />
          ) : (
            <div style={{ display: "grid", gap: 12, marginTop: 16 }}>
              {data.notes.saved ? null : <Notice tone="warning">These notes are drafts. Fill in the parts in [square brackets] and have them checked.</Notice>}
              {data.notes.notes.map((note, index) => (
                <div key={index}>
                  <strong>
                    {index + 1}. {note.title}
                  </strong>
                  {note.body.split(/\n{2,}/).map((paragraph, at) => (
                    <p key={at} className={ui.reportNote}>
                      {paragraph}
                    </p>
                  ))}
                </div>
              ))}
            </div>
          )}
        </section>
      );
    }
    if (page.key === "depreciation") {
      return (
        <section aria-label="Depreciation schedule">
          <header className={ui.statementHeading}>
            <h3 className={ui.statementTitle}>{heading("depreciation", page.title)}</h3>
            <p>{data.period}</p>
          </header>
          {data.depreciation ? <DepreciationTable schedule={data.depreciation} /> : null}
        </section>
      );
    }
    const statement = data.statements.find((entry) => entry.key === page.key);
    if (!statement) return null;
    return <StatementTable statement={statement} columns={data.columns} action={editing ? null : layoutFor(statement)?.button(data.yearEnd)} title={heading(statement.key, statement.title)} />;
  }

  return (
    <section className={ui.reportFrame} aria-label="Annual financial statements">
      <div className={ui.reportToolbar} data-print="hide" role="group" aria-label="Report options">
        <Field label="Financial year ending" hint="The last day of the year">
          <DateInput value={typed} onChange={(event) => setTyped(event.target.value)} />
        </Field>
        <Button
          onClick={() => {
            setDraft(null);
            setPageIndex(0);
            setChosen(typed || fallback);
          }}
          disabled={report.loading || editing}
        >
          Update
        </Button>
        <div className={ui.reportToolbarEnd}>
          <InfoTip label="About this report">
            Special purpose statements, with last year beside this year, one page at a time. The statements of financial performance and position follow your default profit and
            loss and balance sheet layouts, if you&apos;ve set them. Click an amount to see what makes it up. The PDF has the same pages.
          </InfoTip>
          {data && can("bookkeeper") && !editing ? (
            <Button variant="secondary" onClick={() => setDraft(structuredClone(data.document.texts))}>
              Edit
            </Button>
          ) : null}
          {editing ? (
            <>
              <Button variant="secondary" disabled={busy} onClick={() => setDraft(null)}>
                Cancel
              </Button>
              <Button variant="secondary" disabled={busy} onClick={() => void save("draft")}>
                Save as draft
              </Button>
              <Button disabled={busy} onClick={() => void save("final")}>
                {busy ? "Saving…" : "Save as final"}
              </Button>
            </>
          ) : (
            <a className={`${ui.button} ${ui.secondary}`} href={pdf} download>
              Download PDF
            </a>
          )}
          <MoreMenu label="More report options" items={[{ label: "Print this page", onSelect: () => window.print() }]} />
        </div>
      </div>
      {report.error ? <Notice tone="error">{report.error}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {message ? <Notice tone="success">{message}</Notice> : null}
      {plLayout.error ? <Notice tone="error">{plLayout.error}</Notice> : null}
      {bsLayout.error ? <Notice tone="error">{bsLayout.error}</Notice> : null}
      {cfLayout.error ? <Notice tone="error">{cfLayout.error}</Notice> : null}
      {ceLayout.error ? <Notice tone="error">{ceLayout.error}</Notice> : null}
      {report.loading ? <p className={ui.muted}>Loading…</p> : null}
      {data && page && texts ? (
        <>
          {editing ? (
            <Notice tone="info">
              Editing. Change any words on any page, then save. The notes save with their own button.{" "}
              <label style={{ whiteSpace: "nowrap" }}>
                <input type="checkbox" checked={texts.compilation} onChange={(event) => change({ compilation: event.target.checked })} /> Include the compilation report
              </label>
            </Notice>
          ) : null}
          <div className={ui.annualPager} data-print="hide" role="group" aria-label="Pages">
            <Button variant="secondary" size="small" disabled={pageIndex === 0} onClick={() => go(pageIndex - 1)}>
              Previous
            </Button>
            <select aria-label="Go to page" value={pageIndex} style={{ width: "auto", maxWidth: 320 }} onChange={(event) => go(Number(event.target.value))}>
              {pages.map((entry, index) => (
                <option key={entry.key} value={index}>
                  {index + 1}. {entry.title}
                </option>
              ))}
            </select>
            <span className={ui.muted}>
              Page {pageIndex + 1} of {pages.length}
            </span>
            <Button variant="secondary" size="small" disabled={pageIndex >= pages.length - 1} onClick={() => go(pageIndex + 1)}>
              Next
            </Button>
            {data.document.status === "draft" ? <Badge tone="amber">DRAFT</Badge> : <Badge tone="green">Final</Badge>}
          </div>
          <div className={ui.annualPage}>{pageBody()}</div>
        </>
      ) : null}
    </section>
  );
}
