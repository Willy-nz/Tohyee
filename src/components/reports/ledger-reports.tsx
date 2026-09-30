"use client";

import Link from "next/link";
import { Fragment, useState } from "react";
import { Money, useAccounts } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { reportCategories, TrackingTagsText, useTracking } from "@/components/tracking";
import { Button, Card, Empty, Field, Notice, ui } from "@/components/ui";
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
      <>
        <Money value={value.slice(1)} /> Cr
      </>
    );
  }
  return <Money value={value} />;
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
  const [asAt, setAsAt] = useState(todayInBrowser);
  const [open, setOpen] = useState<string | null>(null);
  const report = useApiData<AgedPayables>("/api/reports/aged-payables", { organisationId, asAt });
  const data = report.data;
  return (
    <Card
      title="Aged payables"
      description="What you owe each supplier, by days past the bill's due date, less supplier credit not yet used, in the base currency (foreign-currency bills at their own rates, with their own currency beside them). The total matches accounts payable on the balance sheet, with any FX revaluation on the date."
      actions={
        <div className={ui.inlineForm} data-print="hide">
          <Field label="As at">
            <input type="date" value={asAt} onChange={(event) => setAsAt(event.target.value)} />
          </Field>
          <PrintButton />
        </div>
      }
    >
      {report.error ? <Notice tone="error">{report.error}</Notice> : null}
      {report.loading ? <p className={ui.muted}>Loading…</p> : null}
      {data ? <p className={`${ui.muted} ${ui.printOnly}`}>As at {formatDate(data.asAt)}</p> : null}
      {data && data.rows.length === 0 ? <Empty>You don&apos;t owe any supplier anything on this date.</Empty> : null}
      {data && data.rows.length > 0 ? (
        <div className={ui.tableWrap}>
          <table className={ui.table}>
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
    </Card>
  );
}

export function AccountTransactionsReport({
  organisationId,
  initialAccountId,
  initialTo,
}: {
  organisationId: string;
  initialAccountId?: string | null;
  initialTo?: string | null;
}) {
  const [accountId, setAccountId] = useState(() => (initialAccountId && /^\d+$/.test(initialAccountId) ? initialAccountId : ""));
  const [from, setFrom] = useState<string | null>(null);
  const [to, setTo] = useState(() => (initialTo && /^\d{4}-\d{2}-\d{2}$/.test(initialTo) ? initialTo : todayInBrowser()));
  const [filter, setFilter] = useState<{ categoryId: string; valueId: string }>({ categoryId: "", valueId: "" });
  const accounts = useAccounts(organisationId, true);
  const tracking = useTracking(organisationId);
  const categories = reportCategories(tracking.data);
  const category = categories.find((entry) => entry.id === filter.categoryId);
  const valueId = category && category.values.some((value) => value.id === filter.valueId) ? filter.valueId : "";
  const report = useApiData<AccountTransactions>("/api/reports/account-transactions", {
    organisationId,
    accountId: accountId || null,
    from,
    to,
    trackingCategoryId: valueId ? filter.categoryId : null,
    trackingValueId: valueId || null,
  });
  const data = report.data;
  return (
    <Card
      title="Account transactions"
      description="Every posted line on an account (or all of them): the balance before, each line with its source, and the balance at the end. Balances match the trial balance."
      actions={
        <div className={ui.inlineForm} data-print="hide">
          <Field label="Account">
            <select value={accountId} onChange={(event) => setAccountId(event.target.value)}>
              <option value="">All accounts</option>
              {(accounts.data?.accounts ?? []).map((account) => (
                <option key={account.id} value={account.id}>
                  {account.code} · {account.name}
                  {account.isActive ? "" : " (archived)"}
                </option>
              ))}
            </select>
          </Field>
          <Field label="From">
            <input type="date" value={from ?? data?.from ?? ""} onChange={(event) => setFrom(event.target.value || null)} />
          </Field>
          <Field label="To">
            <input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
          </Field>
          {categories.length > 0 ? (
            <Field label="Only lines tagged">
              <select
                value={valueId ? `${filter.categoryId}:${valueId}` : ""}
                onChange={(event) => {
                  const [categoryId = "", value = ""] = event.target.value.split(":");
                  setFilter({ categoryId, valueId: value });
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
                  </optgroup>
                ))}
              </select>
            </Field>
          ) : null}
          <PrintButton />
        </div>
      }
    >
      {report.error ? <Notice tone="error">{report.error}</Notice> : null}
      {report.loading ? <p className={ui.muted}>Loading…</p> : null}
      {data ? (
        <p className={ui.muted}>
          {formatDate(data.from)} to {formatDate(data.to)} · {data.currencyCode}
          {data.filter ? ` · only lines tagged ${data.filter.label}` : ""}
        </p>
      ) : null}
      {data && data.accounts.length === 0 ? <Empty>Nothing posted to these accounts yet.</Empty> : null}
      {data && data.accounts.length > 0 ? (
        <div className={ui.tableWrap}>
          <table className={ui.table}>
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
      ) : null}
    </Card>
  );
}

export function JournalReportView({ organisationId }: { organisationId: string }) {
  const [from, setFrom] = useState<string | null>(null);
  const [to, setTo] = useState(todayInBrowser);
  const tracking = useTracking(organisationId);
  const report = useApiData<JournalReport & { truncated: boolean }>("/api/reports/journal-report", { organisationId, from, to });
  const data = report.data;
  return (
    <Card
      title="Journal report"
      description="Every journal posted in the period, with its lines, where it came from and who posted it."
      actions={
        <div className={ui.inlineForm} data-print="hide">
          <Field label="From">
            <input type="date" value={from ?? data?.from ?? ""} onChange={(event) => setFrom(event.target.value || null)} />
          </Field>
          <Field label="To">
            <input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
          </Field>
          <PrintButton />
        </div>
      }
    >
      {report.error ? <Notice tone="error">{report.error}</Notice> : null}
      {report.loading ? <p className={ui.muted}>Loading…</p> : null}
      {data ? (
        <p className={ui.muted}>
          {formatDate(data.from)} to {formatDate(data.to)} · {data.journals.length} journals · {data.currencyCode}
        </p>
      ) : null}
      {data?.truncated ? <Notice tone="warning">Only the first {data.journals.length} journals are shown. Choose a shorter period to see the rest.</Notice> : null}
      {data && data.journals.length === 0 ? <Empty>No journals were posted in this period.</Empty> : null}
      {data && data.journals.length > 0 ? (
        <div className={ui.tableWrap}>
          <table className={ui.table}>
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
      ) : null}
    </Card>
  );
}
