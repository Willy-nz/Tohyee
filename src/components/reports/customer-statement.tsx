"use client";

import Link from "next/link";
import { useState } from "react";
import { Money } from "@/components/books";
import { EmailDocumentPanel, pdfHref, type StatementQuery } from "@/components/documents/email-document";
import { StatementRunCard } from "@/components/reports/statement-emails";
import { useApiData } from "@/components/hooks";
import { OrganisationLogo } from "@/components/organisation/logo";
import { Balance, BUCKET_LABELS, BUCKETS, PrintButton } from "@/components/reports/ledger-reports";
import { Card, Empty, Field, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import type { Contact } from "@/lib/contacts/service";
import { formatDate, todayInBrowser } from "@/lib/format";
import type { AgedAmounts } from "@/lib/reports/ageing";
import type { ActivityStatement, OutstandingStatement } from "@/lib/reports/customer-statements";

/**
 * Contacts › Customer statements (examples CST1-CST5): an activity
 * statement for a date range or an outstanding statement as at a date, for
 * one customer (optionally with its sub-customers), laid out as a page to
 * print or save as PDF with the browser's print, or to email as a PDF
 * (to one customer, or to every customer with a balance).
 */

function monthStart(isoDate: string): string {
  return `${isoDate.slice(0, 7)}-01`;
}

function AgeingTable({ ageing, currencyCode }: { ageing: AgedAmounts; currencyCode: string }) {
  return (
    <div className={ui.tableWrap}>
      <table className={ui.table}>
        <thead>
          <tr>
            {BUCKETS.map((bucket) => (
              <th key={bucket} className={ui.num}>
                {BUCKET_LABELS[bucket]}
              </th>
            ))}
            <th className={ui.num}>Credit</th>
            <th className={ui.num}>Balance due ({currencyCode})</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            {BUCKETS.map((bucket) => (
              <td key={bucket} className={ui.num}>
                <Money value={ageing[bucket]} />
              </td>
            ))}
            <td className={ui.num}>{ageing.credit === "0.00" ? <Money value="0.00" /> : <Money value={`-${ageing.credit}`} />}</td>
            <td className={ui.num}>
              <strong>
                <Money value={ageing.total} />
              </strong>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function StatementHeader({
  title,
  statement,
  period,
}: {
  title: string;
  statement: ActivityStatement | OutstandingStatement;
  period: string;
}) {
  const { current } = useWorkspace();
  return (
    <header className={ui.reportPaperHeader}>
      {current ? <OrganisationLogo organisationId={current.id} /> : null}
      <h2 className={ui.reportPaperTitle}>{title}</h2>
      <p className={ui.reportPaperMeta}>
        {current?.displayName}
        <br />
        {period}
      </p>
      <p style={{ margin: 0, whiteSpace: "pre-line" }}>
        <strong>{statement.customer.name}</strong>
        {statement.customer.billingAddress ? `\n${statement.customer.billingAddress}` : ""}
      </p>
      {statement.includeSubCustomers && statement.customers.length > 1 ? (
        <p className={ui.reportPaperMeta}>Includes {statement.customers.slice(1).map((c) => c.name).join(", ")}</p>
      ) : null}
    </header>
  );
}

function ActivityPaper({ statement }: { statement: ActivityStatement }) {
  const showCustomer = statement.customers.length > 1;
  return (
    <article className={ui.reportPaper}>
      <StatementHeader title="Activity statement" statement={statement} period={`${formatDate(statement.from)} to ${formatDate(statement.to)}`} />
      <div className={ui.tableWrap}>
        <table className={ui.table}>
          <thead>
            <tr>
              <th>Date</th>
              <th>Activity</th>
              {showCustomer ? <th>Customer</th> : null}
              <th>Reference</th>
              <th className={ui.num}>Amount</th>
              <th className={ui.num}>Payments and credit</th>
              <th className={ui.num}>Balance</th>
            </tr>
          </thead>
          <tbody>
            <tr className={ui.reportSection}>
              <td>{formatDate(statement.from)}</td>
              <td colSpan={showCustomer ? 5 : 4}>Opening balance</td>
              <td className={ui.num}>
                <Balance value={statement.opening} />
              </td>
            </tr>
            {statement.lines.map((line, index) => (
              <tr key={index}>
                <td>{formatDate(line.date)}</td>
                <td>
                  <Link href={line.href}>{line.description}</Link>
                </td>
                {showCustomer ? <td>{line.contactName}</td> : null}
                <td>{line.reference ?? ""}</td>
                <td className={ui.num}>
                  <Money value={line.amount} blankZero />
                </td>
                <td className={ui.num}>
                  <Money value={line.payment} blankZero />
                </td>
                <td className={ui.num}>
                  <Balance value={line.balance} />
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={showCustomer ? 4 : 3}>Closing balance ({statement.currencyCode})</td>
              <td className={ui.num}>
                <Money value={statement.totalAmount} />
              </td>
              <td className={ui.num}>
                <Money value={statement.totalPayment} />
              </td>
              <td className={ui.num}>
                <Balance value={statement.closing} />
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
      <AgeingTable ageing={statement.ageing} currencyCode={statement.currencyCode} />
    </article>
  );
}

function OutstandingPaper({ statement }: { statement: OutstandingStatement }) {
  const showCustomer = statement.customers.length > 1;
  return (
    <article className={ui.reportPaper}>
      <StatementHeader title="Statement" statement={statement} period={`Outstanding as at ${formatDate(statement.asAt)}`} />
      {statement.lines.length === 0 ? (
        <Empty>Nothing is owed on this date.</Empty>
      ) : (
        <div className={ui.tableWrap}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th>Date</th>
                <th>Document</th>
                {showCustomer ? <th>Customer</th> : null}
                <th>Due</th>
                <th className={ui.num}>Total</th>
                <th className={ui.num}>Outstanding</th>
              </tr>
            </thead>
            <tbody>
              {statement.lines.map((line) => (
                <tr key={`${line.type}:${line.documentId}`}>
                  <td>{formatDate(line.date)}</td>
                  <td>
                    <Link href={line.href}>
                      {line.type === "credit_note" ? `Credit note ${line.number}` : line.type === "invoice" ? `Invoice ${line.number}` : line.number}
                    </Link>
                  </td>
                  {showCustomer ? <td>{line.contactName}</td> : null}
                  <td>
                    {line.dueDate ? formatDate(line.dueDate) : ""}
                    {line.daysOverdue > 0 ? <span className={ui.muted}> · {line.daysOverdue} days overdue</span> : null}
                  </td>
                  <td className={ui.num}>
                    <Money value={line.original} />
                  </td>
                  <td className={ui.num}>
                    <Money value={line.outstanding} />
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={showCustomer ? 5 : 4}>Balance due ({statement.currencyCode})</td>
                <td className={ui.num}>
                  <Money value={statement.balance} />
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      <AgeingTable ageing={statement.ageing} currencyCode={statement.currencyCode} />
    </article>
  );
}

export function CustomerStatements({ organisationId, initialContactId }: { organisationId: string; initialContactId: string | null }) {
  const today = todayInBrowser();
  const [contactId, setContactId] = useState(initialContactId ?? "");
  const [kind, setKind] = useState<"activity" | "outstanding">("activity");
  const [from, setFrom] = useState(() => monthStart(today));
  const [to, setTo] = useState(today);
  const [asAt, setAsAt] = useState(today);
  const [includeSubs, setIncludeSubs] = useState(false);
  const contacts = useApiData<{ contacts: Contact[] }>("/api/contacts", { organisationId, includeArchived: "true" });
  const customers = (contacts.data?.contacts ?? []).filter((contact) => contact.isCustomer);
  const chosen = customers.find((contact) => contact.id === contactId);
  const hasSubs = customers.some((contact) => contact.parentContactId === contactId);
  const statement = useApiData<ActivityStatement | OutstandingStatement>(
    chosen ? "/api/reports/customer-statement" : null,
    kind === "activity"
      ? { organisationId, contactId, kind, from, to, includeSubCustomers: includeSubs && hasSubs ? "true" : null }
      : { organisationId, contactId, kind, asAt, includeSubCustomers: includeSubs && hasSubs ? "true" : null },
  );
  const emailQuery: StatementQuery =
    kind === "activity"
      ? { statementKind: "activity", from, to, includeSubCustomers: includeSubs && hasSubs }
      : { statementKind: "outstanding", asAt, includeSubCustomers: includeSubs && hasSubs };
  return (
    <>
      <Card
        title="Customer statement"
        description="What a customer owes: their activity over a period, or what's outstanding on a date, aged by due date."
        actions={
          statement.data ? (
            <>
              <PrintButton />
              <span data-print="hide">
                <a href={pdfHref(organisationId, "statement", contactId, emailQuery)} target="_blank" rel="noreferrer">
                  PDF
                </a>
              </span>
            </>
          ) : null
        }
      >
        <div className={ui.inlineForm} data-print="hide">
          <Field label="Customer">
            <select value={contactId} onChange={(event) => setContactId(event.target.value)}>
              <option value="">Choose a customer</option>
              {customers.map((contact) => (
                <option key={contact.id} value={contact.id}>
                  {contact.name}
                  {contact.isArchived ? " (archived)" : ""}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Statement">
            <select value={kind} onChange={(event) => setKind(event.target.value === "outstanding" ? "outstanding" : "activity")}>
              <option value="activity">Activity</option>
              <option value="outstanding">Outstanding</option>
            </select>
          </Field>
          {kind === "activity" ? (
            <>
              <Field label="From">
                <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
              </Field>
              <Field label="To">
                <input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
              </Field>
            </>
          ) : (
            <Field label="As at">
              <input type="date" value={asAt} onChange={(event) => setAsAt(event.target.value)} />
            </Field>
          )}
          {hasSubs ? (
            <label className={ui.checkbox}>
              <input type="checkbox" checked={includeSubs} onChange={(event) => setIncludeSubs(event.target.checked)} />
              Include sub-customers
            </label>
          ) : null}
        </div>
        {contacts.error ? <Notice tone="error">{contacts.error}</Notice> : null}
        {statement.error ? <Notice tone="error">{statement.error}</Notice> : null}
        {!chosen ? <p className={ui.muted}>Choose a customer to see their statement.</p> : null}
        {statement.loading ? <p className={ui.muted}>Loading…</p> : null}
      </Card>
      {statement.data?.kind === "activity" ? <ActivityPaper statement={statement.data} /> : null}
      {statement.data?.kind === "outstanding" ? <OutstandingPaper statement={statement.data} /> : null}
      {statement.data && chosen ? (
        <div data-print="hide">
          <EmailDocumentPanel
            key={`${contactId}:${JSON.stringify(emailQuery)}`}
            organisationId={organisationId}
            kind="statement"
            id={contactId}
            statement={emailQuery}
            title="Email this statement"
          />
        </div>
      ) : null}
      <div data-print="hide">
        <StatementRunCard key={JSON.stringify(emailQuery)} organisationId={organisationId} statement={emailQuery} />
      </div>
    </>
  );
}
