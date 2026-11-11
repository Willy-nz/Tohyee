"use client";

import Link from "next/link";
import { Fragment, useState } from "react";
import { Money, useAccounts } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { reportCategories, TrackingTagsText, useTracking } from "@/components/tracking";
import { Button, Empty, Field, Notice, ui } from "@/components/ui";
import { ReportFrame, type ReportDates, ReportToolbar, StatementHeading, useYearEndMonth } from "@/components/reports/report-frame";
import { useSaveAsCustomReport } from "@/components/reports/save-as-custom-report";
import { statementAsAt, statementPeriod } from "@/lib/reports/report-dates";
import { formatDate, formatDateTime, formatMoney, todayInBrowser, personName } from "@/lib/format";
import type { AccountTransactions } from "@/lib/reports/account-transactions";
import type { AgedPayables } from "@/lib/reports/aged-payables";
import type { AgeBucket, AgedAmounts } from "@/lib/reports/ageing";
import type { JournalReport } from "@/lib/reports/journal-report";

/**
 * Reporting › Aged payables (AGP1-AGP3), Account transactions (ATX1-ATX5)
 * and the Journal report (JR1-JR3). Each has "Print or save as PDF", which
 * uses the browser's print with the menus hidden.
 */

export const BUCKET_LABELS: Record<AgeBucket, string> = {
  current: "Current",
  days1to30: "1-30 days",
  days31to60: "31-60 days",
  days61to90: "61-90 days",
  over90: "Over 90 days",
};
export const BUCKETS = Object.keys(BUCKET_LABELS) as AgeBucket[];

const PRINT = { label: "Print", onSelect: () => window.print() };

export function PrintButton() {
  return (
    <span data-print="hide">
      <Button size="small" variant="secondary" onClick={() => window.print()}>
        Print or save as PDF
      </Button>
    </span>
  );
}

/** A balance as debit (positive) or "Cr" (negative), the way bookkeepers read a ledger. */
export function Balance({ value }: { value: string }) {
  if (value.startsWith("-")) {
    return (
      <span data-export-value={value}>
        <Money value={value.slice(1)} /> Cr
      </span>
    );
  }
  return (
    <span data-export-value={value}>
      <Money value={value} />
    </span>
  );
}

function AgedCells({ amounts }: { amounts: AgedAmounts }) {
  return (
    <>
      {BUCKETS.map((bucket) => (
        <td key={bucket} className={ui.num}>
          <Money value={amounts[bucket]} blankZero />
        </td>
      ))}
      <td className={ui.num}>{amounts.credit === "0.00" ? null : <Money value={`-${amounts.credit}`} />}</td>
      <td className={ui.num}>
        <Money value={amounts.total} />
      </td>
    </>
  );
}

export function AgedPayablesReport({ organisationId }: { organisationId: string }) {
  const yearEndMonth = useYearEndMonth(organisationId);
  const [dates, setDates] = useState<ReportDates>(() => ({ from: null, to: todayInBrowser() }));
  const asAt = dates.to;
  const [open, setOpen] = useState<string | null>(null);
  const report = useApiData<AgedPayables>("/api/reports/aged-payables", { organisationId, asAt });
  const data = report.data;
  const save = useSaveAsCustomReport(organisationId, "aged_payables", { asAt });
  const period = data ? statementAsAt(data.asAt) : "";
  return (
    <ReportFrame
      label="Aged payables"
      toolbar={
        <ReportToolbar
          mode="asAt"
          dates={dates}
          yearEndMonth={yearEndMonth}
          onUpdate={setDates}
          busy={report.loading}
          more={[PRINT, ...(save.item ? [save.item] : [])]}
          info={
            <>
              What you owe each supplier, by days past the due date, less supplier credit not yet used, in the base currency (foreign-currency bills at
              their own rates, with their own currency beside them). The total matches accounts payable on the balance sheet, with any FX revaluation on
              the date.
            </>
          }
          exportProps={data ? { organisationId, report: "aged-payables", title: "Aged payables", period, tables: [{ id: "aged-payables-report" }] } : null}
        />
      }
    >
      {save.error ? <Notice tone="error">{save.error}</Notice> : null}
      {data ? <StatementHeading title="Aged payables" period={period} /> : null}
      {report.error ? <Notice tone="error">{report.error}</Notice> : null}
      {report.loading ? <p className={ui.muted}>Loading…</p> : null}
      {data && data.rows.length === 0 ? <Empty>You don&apos;t owe any supplier anything on this date.</Empty> : null}
      {data && data.rows.length > 0 ? (
        <div className={ui.tableWrap}>
          <table id="aged-payables-report" className={ui.table}>
            <thead>
              <tr>
                <th>Supplier</th>
                {BUCKETS.map((bucket) => (
                  <th key={bucket} className={ui.num}>
                    {BUCKET_LABELS[bucket]}
                  </th>
                ))}
                <th className={ui.num}>Credit</th>
                <th className={ui.num}>Total</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row) => (
                <Fragment key={row.contactId}>
                  <tr>
                    <td>
                      <button
                        type="button"
                        className={ui.linkButton}
                        aria-expanded={open === row.contactId}
                        onClick={() => setOpen(open === row.contactId ? null : row.contactId)}
                      >
                        {open === row.contactId ? "▾" : "▸"} {row.name}
                      </button>
                      {row.foreign ? (
                        <div className={ui.muted}>
                          Owed {row.foreign.currencyCode} {formatMoney(row.foreign.total)}
                        </div>
                      ) : null}
                    </td>
                    <AgedCells amounts={row.amounts} />
                  </tr>
                  {open === row.contactId ? (
                    <>
                      {row.bills.map((bill) => (
                        <tr key={`b${bill.id}`} className={ui.reportSection}>
                          <td colSpan={BUCKETS.length + 2} style={{ paddingLeft: 28 }}>
                            <Link href={`/operations/bills/${bill.id}`}>{bill.supplierInvoiceNumber}</Link> · dated {formatDate(bill.billDate)} · due{" "}
                            {formatDate(bill.dueDate)}
                            {bill.daysOverdue > 0 ? ` · ${bill.daysOverdue} days overdue` : ""}
                            {bill.currencyCode !== data.currencyCode ? ` · ${bill.currencyCode} ${formatMoney(bill.amountDue)}` : ""}
                          </td>
                          <td className={ui.num}>
                            <Money value={bill.amountDueBase} />
                          </td>
                        </tr>
                      ))}
                      {row.credits.map((credit) => (
                        <tr key={`c${credit.id}`} className={ui.reportSection}>
                          <td colSpan={BUCKETS.length + 2} style={{ paddingLeft: 28 }}>
                            <Link href={`/operations/supplier-credit-notes/${credit.id}`}>{credit.supplierCreditNoteNumber}</Link> · credit dated{" "}
                            {formatDate(credit.creditNoteDate)}
                            {credit.currencyCode !== data.currencyCode ? ` · ${credit.currencyCode} ${formatMoney(credit.unused)}` : ""}
                          </td>
                          <td className={ui.num}>
                            <Money value={`-${credit.unusedBase}`} />
                          </td>
                        </tr>
                      ))}
                    </>
                  ) : null}
                </Fragment>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td>Total ({data.currencyCode})</td>
                <AgedCells amounts={data.total} />
              </tr>
              {data.revaluation !== "0.00" ? (
                <tr>
                  <td colSpan={BUCKETS.length + 2}>Unrealised FX revaluation of foreign-currency bills on this date (reversed the next day)</td>
                  <td className={ui.num}>
                    <Money value={data.revaluation} />
                  </td>
                </tr>
              ) : null}
              {data.payablesAccount ? (
                <tr>
                  <td colSpan={BUCKETS.length + 2}>
                    Account {data.payablesAccount.code} · {data.payablesAccount.name} in the ledger
                    {data.payablesAccount.difference !== "0.00" ? ` (difference ${data.payablesAccount.difference})` : ""}
                  </td>
                  <td className={ui.num}>
                    <Money value={data.payablesAccount.balance} />
                  </td>
                </tr>
              ) : null}
            </tfoot>
          </table>
        </div>
      ) : null}
    </ReportFrame>
  );
}

export function AccountTransactionsReport({
  organisationId,
  initialAccountId,
  initialAccountIds,
  initialFrom,
  initialTo,
  initialTrackingCategoryId,
  initialTrackingValueId,
  ledger = false,
}: {
  organisationId: string;
  /** The general ledger (GL1): every account with a balance or lines, no account to choose. */
  ledger?: boolean;
  initialAccountId?: string | null;
  /** Several accounts, "12,15": a custom report group's total (decision 1356). */
  initialAccountIds?: string | null;
  initialFrom?: string | null;
  initialTo?: string | null;
  initialTrackingCategoryId?: string | null;
  initialTrackingValueId?: string | null;
}) {
  const [accountIds] = useState(() => (!ledger && initialAccountIds && /^\d+(,\d+)*$/.test(initialAccountIds) ? initialAccountIds : ""));
  // "several" while the report shows a group's accounts; choosing another account replaces them.
  const [accountId, setAccountId] = useState(() => (ledger ? "" : accountIds ? "several" : initialAccountId && /^\d+$/.test(initialAccountId) ? initialAccountId : ""));
  const [from, setFrom] = useState<string | null>(() => (initialFrom && /^\d{4}-\d{2}-\d{2}$/.test(initialFrom) ? initialFrom : null));
  const [to, setTo] = useState(() => (initialTo && /^\d{4}-\d{2}-\d{2}$/.test(initialTo) ? initialTo : todayInBrowser()));
  const [filter, setFilter] = useState<{ categoryId: string; valueId: string }>(() => ({
    categoryId: initialTrackingCategoryId && /^\d+$/.test(initialTrackingCategoryId) ? initialTrackingCategoryId : "",
    valueId:
      initialTrackingValueId === "unassigned" || (initialTrackingValueId && /^\d+$/.test(initialTrackingValueId))
        ? initialTrackingValueId
        : "",
  }));
  const [draft, setDraft] = useState({ accountId, filter });
  // VP3: on screen, a journal and its reversal both in the range are left out unless asked for.
  const [hideVoided, setHideVoided] = useState(true);
  const yearEndMonth = useYearEndMonth(organisationId);
  const accounts = useAccounts(organisationId, true);
  const tracking = useTracking(organisationId);
  const categories = reportCategories(tracking.data);
  const category = categories.find((entry) => entry.id === filter.categoryId);
  const valueId = category && category.values.some((value) => value.id === filter.valueId) ? filter.valueId : "";
  const unassigned = Boolean(category && filter.valueId === "unassigned");
  const report = useApiData<AccountTransactions>("/api/reports/account-transactions", {
    organisationId,
    accountId: accountId && accountId !== "several" ? accountId : null,
    accountIds: accountId === "several" ? accountIds : null,
    from,
    to,
    trackingCategoryId: valueId || unassigned ? filter.categoryId : null,
    trackingValueId: valueId || (unassigned ? "unassigned" : null),
    hideVoidedPairs: hideVoided ? "1" : null,
  });
  const data = report.data;
  const save = useSaveAsCustomReport(organisationId, "account_transactions", {
    accountId: accountId && accountId !== "several" ? accountId : null,
    from,
    to,
    trackingCategoryId: valueId || unassigned ? filter.categoryId : null,
    trackingValueId: valueId || (unassigned ? "unassigned" : null),
  });
  const period = data ? statementPeriod(data.from, data.to, yearEndMonth) : "";
  const lines = data
    ? [
        ...(data.accounts.length === 1 ? [`${data.accounts[0].code} · ${data.accounts[0].name}`] : []),
        ...(data.filter ? [`Only lines tagged ${data.filter.label}`] : []),
      ]
    : [];
  return (
    <ReportFrame
      label={ledger ? "General ledger" : "Account transactions"}
      toolbar={
        <ReportToolbar
          mode="range"
          dates={{ from, to }}
          shownFrom={data?.from}
          yearEndMonth={yearEndMonth}
          busy={report.loading}
          onUpdate={(next) => {
            setFrom(next.from);
            setTo(next.to);
            setAccountId(draft.accountId);
            setFilter(draft.filter);
          }}
          filters={
            <>
              {ledger ? null : (
              <Field label="Account">
                <select value={draft.accountId} onChange={(event) => setDraft({ ...draft, accountId: event.target.value })}>
                  <option value="">All accounts</option>
                  {accountIds ? <option value="several">The group&apos;s {accountIds.split(",").length} accounts</option> : null}
                  {(accounts.data?.accounts ?? []).map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.code} · {account.name}
                      {account.isActive ? "" : " (archived)"}
                    </option>
                  ))}
                </select>
              </Field>
              )}
              <label className={ui.checkbox} style={{ alignSelf: "end" }}>
                <input type="checkbox" checked={hideVoided} onChange={(event) => setHideVoided(event.target.checked)} /> Leave out voided pairs
              </label>
              {categories.length > 0 ? (
                <Field label="Tracking">
                  <select
                    value={draft.filter.categoryId && draft.filter.valueId ? `${draft.filter.categoryId}:${draft.filter.valueId}` : ""}
                    onChange={(event) => {
                      const [categoryId = "", value = ""] = event.target.value.split(":");
                      setDraft({ ...draft, filter: { categoryId, valueId: value } });
                    }}
                  >
                    <option value="">Any</option>
                    {categories.map((entry) => (
                      <optgroup key={entry.id} label={entry.name}>
                        {entry.values.map((value) => (
                          <option key={value.id} value={`${entry.id}:${value.id}`}>
                            {value.name}
                          </option>
                        ))}
                        <option value={`${entry.id}:unassigned`}>Not set</option>
                      </optgroup>
                    ))}
                  </select>
                </Field>
              ) : null}
            </>
          }
          more={[PRINT, ...(save.item ? [save.item] : [])]}
          info={
            <>
              Balance sheet accounts open with every posting before the start date. Income and expense accounts open with this financial year&apos;s postings
              only, as on the trial balance; earlier years&apos; profit is in retained earnings.
            </>
          }
          exportProps={
            data
              ? {
                  organisationId,
                  report: "account-transactions",
                  title: "Account transactions",
                  period,
                  filters: lines,
                  tables: [{ id: "account-transactions-report" }],
                }
              : null
          }
        />
      }
    >
      {save.error ? <Notice tone="error">{save.error}</Notice> : null}
      {data ? <StatementHeading title={ledger ? "General ledger" : "Account transactions"} period={period} lines={lines} /> : null}
      {data?.crossesYearEnd ? (
        <Notice tone="info">
          These dates cross a financial year end ({formatDate(data.financialYearStart)} starts the first year): income and expense balances run on
          without restarting, so they won&apos;t match the trial balance at the end date.
        </Notice>
      ) : null}
      {data && data.hiddenPairs > 0 ? (
        <p className={ui.muted} data-print="hide">
          {data.hiddenPairs} voided or corrected {data.hiddenPairs === 1 ? "journal and its reversal are" : "journals and their reversals are"} left out: they come to nothing in
          these dates. Untick Leave out voided pairs to see them.
        </p>
      ) : null}
      {report.error ? <Notice tone="error">{report.error}</Notice> : null}
      {report.loading ? <p className={ui.muted}>Loading…</p> : null}
      {data && data.accounts.length === 0 ? <Empty>Nothing posted to these accounts yet.</Empty> : null}
      {data && data.accounts.length > 0 ? (
        <>
          <div className={ui.tableWrap}>
            <table id="account-transactions-report" className={ui.table}>
            <thead>
              <tr>
                <th>Date</th>
                <th>Source</th>
                <th>Description</th>
                <th>Contact</th>
                <th className={ui.num}>Debit</th>
                <th className={ui.num}>Credit</th>
                <th className={ui.num}>Balance</th>
              </tr>
            </thead>
            <tbody>
              {data.accounts.map((account) => (
                <Fragment key={account.accountId}>
                  <tr className={ui.reportHeading}>
                    <td colSpan={7}>
                      {account.code} · {account.name}
                    </td>
                  </tr>
                  <tr className={ui.reportSection}>
                    <td colSpan={6}>Opening balance</td>
                    <td className={ui.num}>
                      <Balance value={account.opening} />
                    </td>
                  </tr>
                  {account.lines.map((line) => (
                    <tr key={`${line.journalId}:${line.lineOrder}`}>
                      <td>{formatDate(line.date)}</td>
                      <td>
                        <Link href={line.source.href}>{line.source.label}</Link>
                      </td>
                      <td>
                        {line.description}
                        <TrackingTagsText setup={tracking.data} tags={line.tracking} />
                      </td>
                      <td>{line.source.contactName ?? ""}</td>
                      <td className={ui.num}>
                        <Money value={line.debit} blankZero />
                      </td>
                      <td className={ui.num}>
                        <Money value={line.credit} blankZero />
                      </td>
                      <td className={ui.num}>
                        <Balance value={line.balance} />
                      </td>
                    </tr>
                  ))}
                  <tr className={ui.reportTotal}>
                    <td colSpan={4}>Closing balance {account.code}</td>
                    <td className={ui.num}>
                      <Money value={account.totalDebit} />
                    </td>
                    <td className={ui.num}>
                      <Money value={account.totalCredit} />
                    </td>
                    <td className={ui.num}>
                      <Balance value={account.closing} />
                    </td>
                  </tr>
                </Fragment>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={4}>Total ({data.currencyCode})</td>
                <td className={ui.num}>
                  <Money value={data.totalDebit} />
                </td>
                <td className={ui.num}>
                  <Money value={data.totalCredit} />
                </td>
                <td />
              </tr>
            </tfoot>
            </table>
          </div>
        </>
      ) : null}
    </ReportFrame>
  );
}

export function JournalReportView({ organisationId }: { organisationId: string }) {
  const yearEndMonth = useYearEndMonth(organisationId);
  const [dates, setDates] = useState<ReportDates>(() => ({ from: null, to: todayInBrowser() }));
  const { from, to } = dates;
  const tracking = useTracking(organisationId);
  const report = useApiData<JournalReport & { truncated: boolean }>("/api/reports/journal-report", { organisationId, from, to });
  const data = report.data;
  const save = useSaveAsCustomReport(organisationId, "journal_report", { from, to });
  const period = data ? statementPeriod(data.from, data.to, yearEndMonth) : "";
  return (
    <ReportFrame
      label="Journal report"
      toolbar={
        <ReportToolbar
          mode="range"
          dates={dates}
          shownFrom={data?.from}
          yearEndMonth={yearEndMonth}
          onUpdate={setDates}
          busy={report.loading}
          more={[PRINT, ...(save.item ? [save.item] : [])]}
          exportProps={data ? { organisationId, report: "journal-report", title: "Journal report", period, tables: [{ id: "journal-report" }] } : null}
        />
      }
    >
      {save.error ? <Notice tone="error">{save.error}</Notice> : null}
      {data ? <StatementHeading title="Journal report" period={period} lines={[`${data.journals.length} journals`]} /> : null}
      {report.error ? <Notice tone="error">{report.error}</Notice> : null}
      {report.loading ? <p className={ui.muted}>Loading…</p> : null}
      {data?.truncated ? <Notice tone="warning">Only the first {data.journals.length} journals are shown. Choose a shorter period to see the rest.</Notice> : null}
      {data && data.journals.length === 0 ? <Empty>No journals were posted in this period.</Empty> : null}
      {data && data.journals.length > 0 ? (
        <>
          <div className={ui.tableWrap}>
            <table id="journal-report" className={ui.table}>
            <thead>
              <tr>
                <th>Account</th>
                <th>Description</th>
                <th className={ui.num}>Debit</th>
                <th className={ui.num}>Credit</th>
              </tr>
            </thead>
            <tbody>
              {data.journals.map((journal) => (
                <Fragment key={journal.journalId}>
                  <tr className={ui.reportHeading}>
                    <td colSpan={4}>
                      {formatDate(journal.date)} · <Link href={journal.source.href}>{journal.source.label}</Link>
                      {journal.source.contactName ? ` · ${journal.source.contactName}` : ""}
                      <div className={ui.muted} style={{ fontWeight: 400 }}>
                        Journal #{journal.journalId}
                        {journal.description ? ` · ${journal.description}` : ""} · posted by {personName(journal, "postedBy") ?? "unknown"} on{" "}
                        {formatDateTime(journal.postedAt)}
                      </div>
                    </td>
                  </tr>
                  {journal.lines.map((line) => (
                    <tr key={line.lineOrder}>
                      <td>
                        {line.accountCode} · {line.accountName}
                      </td>
                      <td>
                        {line.description ?? ""}
                        <TrackingTagsText setup={tracking.data} tags={line.tracking} />
                      </td>
                      <td className={ui.num}>
                        <Money value={line.debit} blankZero />
                      </td>
                      <td className={ui.num}>
                        <Money value={line.credit} blankZero />
                      </td>
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={2}>Total ({data.currencyCode})</td>
                <td className={ui.num}>
                  <Money value={data.totalDebit} />
                </td>
                <td className={ui.num}>
                  <Money value={data.totalCredit} />
                </td>
              </tr>
            </tfoot>
            </table>
          </div>
        </>
      ) : null}
    </ReportFrame>
  );
}
