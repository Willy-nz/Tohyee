"use client";

import Link from "next/link";
import { useState } from "react";
import { journalHref, originLabel } from "@/components/bank/common";
import { Money } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { PrintButton } from "@/components/reports/ledger-reports";
import { Badge, Card, Empty, Field, Notice, ui } from "@/components/ui";
import type { BankAccount } from "@/lib/bank/accounts";
import { formatDate, formatMoney, todayInBrowser } from "@/lib/format";
import type { BankReconciliationReport as Report } from "@/lib/reports/bank-reconciliation";

/** How the statement balance was worked out, in words. */
function sourceText(report: Report): string {
  const source = report.statementBalanceSource;
  if (!source) {
    return "Not known: no statement line on or before this date has the bank's running balance, and there's no bank feed balance from before it.";
  }
  const from =
    source.kind === "line_balance"
      ? `the bank's running balance of ${formatMoney(source.balance)} on the ${formatDate(source.date)} statement line`
      : `the bank feed's balance of ${formatMoney(source.balance)} on ${formatDate(source.date)}`;
  return source.linesAfter === 0
    ? `From ${from}.`
    : `From ${from}, plus ${source.linesAfter} statement ${source.linesAfter === 1 ? "line" : "lines"} after it (${formatMoney(source.linesAfterTotal)}).`;
}

/**
 * Reporting › Bank reconciliation (examples BK20, BK21): the bank's balance,
 * Tohyee's, and the items between them, as at a date. Printable.
 */
export function BankReconciliationReportView({ organisationId, initialAccountId }: { organisationId: string; initialAccountId?: string | null }) {
  const accounts = useApiData<{ bankAccounts: BankAccount[] }>("/api/bank-accounts", { organisationId });
  const [chosen, setChosen] = useState(initialAccountId ?? "");
  const [asAt, setAsAt] = useState(todayInBrowser);
  const accountId = chosen || accounts.data?.bankAccounts[0]?.id || "";
  const report = useApiData<Report>(accountId ? "/api/reports/bank-reconciliation" : null, { organisationId, accountId, asAt });
  const data = report.data;
  return (
    <Card
      title="Bank reconciliation"
      description="The bank's balance and Tohyee's, and the items that explain the difference: statement lines not yet in Tohyee, and transactions in Tohyee not yet on the statement."
      actions={
        <div className={ui.inlineForm} data-print="hide">
          <Field label="Account">
            <select value={accountId} onChange={(event) => setChosen(event.target.value)}>
              {(accounts.data?.bankAccounts ?? []).map((account) => (
                <option key={account.id} value={account.id}>
                  {account.code} · {account.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="As at">
            <input type="date" value={asAt} onChange={(event) => setAsAt(event.target.value)} />
          </Field>
          <PrintButton />
        </div>
      }
    >
      {accounts.error ? <Notice tone="error">{accounts.error}</Notice> : null}
      {report.error ? <Notice tone="error">{report.error}</Notice> : null}
      {accounts.data && accounts.data.bankAccounts.length === 0 ? <Empty>There are no bank or credit card accounts.</Empty> : null}
      {report.loading ? <p className={ui.muted}>Loading…</p> : null}
      {data ? (
        <>
          <p className={`${ui.muted} ${ui.printOnly}`}>
            {data.account.code} · {data.account.name}, as at {formatDate(data.asAt)}
          </p>
          {data.account.accountType === "credit_card" ? (
            <p className={ui.muted}>For a credit card, a negative balance is what&apos;s owed on the card.</p>
          ) : null}
          <div className={ui.tableWrap}>
            <table className={ui.table}>
              <tbody>
                <tr className={ui.reportTotal}>
                  <td>Balance in Tohyee</td>
                  <td className={ui.num}>
                    <Money value={data.ledgerBalance} />
                  </td>
                </tr>
                <tr className={ui.reportHeading}>
                  <td colSpan={2}>Plus: in the bank, not yet in Tohyee</td>
                </tr>
                {data.bankNotInTohyee.items.length === 0 ? (
                  <tr>
                    <td className={ui.muted} colSpan={2}>
                      None.
                    </td>
                  </tr>
                ) : (
                  data.bankNotInTohyee.items.map((item) => (
                    <tr key={`${item.lineId}:${item.matchedJournalId ?? ""}`} className={ui.reportSection}>
                      <td>
                        {formatDate(item.date)} · {item.description}
                        {item.reference ? ` · ${item.reference}` : ""}
                        {item.why === "matched_later" && item.matchedJournalId ? (
                          <span className={ui.muted}>
                            {" "}
                            (matched to <Link href={journalHref(item.matchedJournalId)}>#{item.matchedJournalId}</Link> dated{" "}
                            {formatDate(item.matchedDate)})
                          </span>
                        ) : null}
                      </td>
                      <td className={ui.num}>
                        <Money value={item.amount} />
                      </td>
                    </tr>
                  ))
                )}
                <tr className={ui.reportSection}>
                  <td>Total in the bank, not yet in Tohyee</td>
                  <td className={ui.num}>
                    <Money value={data.bankNotInTohyee.total} />
                  </td>
                </tr>
                <tr className={ui.reportHeading}>
                  <td colSpan={2}>Less: in Tohyee, not yet on the statement</td>
                </tr>
                {data.tohyeeNotInBank.items.length === 0 ? (
                  <tr>
                    <td className={ui.muted} colSpan={2}>
                      None.
                    </td>
                  </tr>
                ) : (
                  data.tohyeeNotInBank.items.map((item) => (
                    <tr key={item.journalLineId} className={ui.reportSection}>
                      <td>
                        {formatDate(item.date)} · {originLabel(item.origin)} <Link href={journalHref(item.journalId)}>#{item.journalId}</Link>
                        {item.description ? ` · ${item.description}` : ""}
                        {item.reconciledOn ? <span className={ui.muted}> (on the statement {formatDate(item.reconciledOn)})</span> : null}
                      </td>
                      <td className={ui.num}>
                        <Money value={item.amount} />
                      </td>
                    </tr>
                  ))
                )}
                <tr className={ui.reportSection}>
                  <td>Total in Tohyee, not yet on the statement</td>
                  <td className={ui.num}>
                    <Money value={data.tohyeeNotInBank.total} />
                  </td>
                </tr>
                <tr className={ui.reportTotal}>
                  <td>Statement balance these explain</td>
                  <td className={ui.num}>
                    <Money value={data.expectedStatementBalance} />
                  </td>
                </tr>
              </tbody>
              <tfoot>
                <tr>
                  <td>
                    Statement balance ({data.currencyCode}){" "}
                    {data.explained ? (
                      <Badge tone="green">Fully explained</Badge>
                    ) : data.statementBalance === null ? (
                      <Badge tone="amber">Balance not known</Badge>
                    ) : (
                      <Badge tone="red">Not fully explained</Badge>
                    )}
                    <div className={ui.muted}>{sourceText(data)}</div>
                  </td>
                  <td className={ui.num}>{data.statementBalance === null ? "—" : <Money value={data.statementBalance} />}</td>
                </tr>
                {data.notExplained !== null && data.notExplained !== "0.00" ? (
                  <tr>
                    <td>
                      Not explained
                      <div className={ui.muted}>
                        Usually a statement line that&apos;s missing or excluded, an opening balance from before the first line, or a duplicate
                        that wasn&apos;t excluded.
                      </div>
                    </td>
                    <td className={ui.num}>
                      <Money value={data.notExplained} />
                    </td>
                  </tr>
                ) : null}
              </tfoot>
            </table>
          </div>
        </>
      ) : null}
    </Card>
  );
}
