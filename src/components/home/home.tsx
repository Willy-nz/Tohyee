"use client";

import Link from "next/link";
import { Money } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { Notice, ui } from "@/components/ui";
import { formatDate, todayInBrowser } from "@/lib/format";
import type { AmountsDue, HomeSummary } from "@/lib/reports/home";
import { GST_BASIS_LABELS } from "@/lib/tax/categories";
import styles from "./home.module.css";

/** Home's figures (examples H1-H4), loaded once for the page. */
export function useHomeSummary(organisationId: string) {
  return useApiData<HomeSummary>("/api/home", { organisationId, today: todayInBrowser() });
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** H2 and H3: what's owed to you, or what you owe, with the overdue part. */
export function AmountsDueTile({
  title,
  due,
  noun,
  href,
  emptyText,
}: {
  title: string;
  due: AmountsDue;
  noun: [string, string];
  href: string;
  emptyText: string;
}) {
  return (
    <section className={styles.tile} aria-label={title}>
      <div className={styles.tileTitle}>
        <Link href={href}>{title}</Link>
      </div>
      <div className={styles.figure}>
        <Money value={due.total} />
      </div>
      {due.count === 0 ? (
        <div className={styles.quiet}>{emptyText}</div>
      ) : (
        <>
          <div className={styles.rows}>
            <div className={styles.row}>
              <span>{plural(due.count, ...noun)}</span>
              <span />
            </div>
            <div className={`${styles.row} ${due.overdueCount > 0 ? styles.overdue : ""}`}>
              <span>Overdue ({due.overdueCount})</span>
              <span>
                <Money value={due.overdueTotal} />
              </span>
            </div>
          </div>
          <Link className={styles.action} href={href}>
            See them
          </Link>
        </>
      )}
    </section>
  );
}

function NextGstTile({ summary }: { summary: HomeSummary }) {
  const gst = summary.nextGstReturn;
  return (
    <section className={styles.tile} aria-label="Next GST return">
      <div className={styles.tileTitle}>
        <Link href="/operations/gst-return">Next GST return</Link>
        {gst.status === "ready" ? <span className={styles.kind}>{GST_BASIS_LABELS[gst.basis]}</span> : null}
      </div>
      {gst.status === "none_filed" ? (
        <p className={ui.muted}>
          No GST return has been filed in Tohyee yet, so the next period isn&apos;t known. Work one out and mark it as filed
          on the GST return page.
        </p>
      ) : (
        <>
          <div className={styles.rows}>
            <div className={styles.row}>
              <span>Period</span>
              <span>
                {formatDate(gst.periodStart)} to {formatDate(gst.periodEnd)}
              </span>
            </div>
          </div>
          {gst.status === "ready" ? (
            <>
              <div className={styles.figure}>
                <Money value={gst.box15.replace(/^-/, "")} />
              </div>
              <div className={ui.muted}>
                {gst.box15.startsWith("-") ? "Refund due so far (Box 15)" : gst.box15 === "0.00" ? "Nothing to pay so far (Box 15)" : "GST to pay so far (Box 15)"}
              </div>
            </>
          ) : (
            <Notice tone="warning">{gst.message}</Notice>
          )}
        </>
      )}
      <Link className={styles.action} href="/operations/gst-return">
        Open the GST return
      </Link>
    </section>
  );
}

export function HomeTiles({ organisationId }: { organisationId: string }) {
  const home = useHomeSummary(organisationId);
  if (home.error) return <Notice tone="error">{home.error}</Notice>;
  const summary = home.data;
  if (!summary) return <p className={ui.muted}>Loading…</p>;
  return (
    <>
      <h2 className={styles.sectionTitle}>Bank accounts</h2>
      <div className={styles.grid}>
        {summary.bankAccounts.length === 0 ? (
          <section className={styles.tile}>
            <p className={ui.muted}>No bank accounts yet.</p>
            <Link className={styles.action} href="/operations/bank-accounts">
              Add a bank account
            </Link>
          </section>
        ) : (
          summary.bankAccounts.map((account) => (
            <section key={account.id} className={styles.tile} aria-label={account.name}>
              <div className={styles.tileTitle}>
                <Link href={`/operations/bank-accounts/${account.id}`}>{account.name}</Link>
                <span className={styles.kind}>
                  {account.code} · {account.accountType === "credit_card" ? "Credit card" : "Bank"}
                </span>
              </div>
              <div className={styles.rows}>
                <div className={styles.row}>
                  <span>Balance in Tohyee</span>
                  <span>
                    <Money value={account.ledgerBalance} />
                  </span>
                </div>
                <div className={styles.row}>
                  <span>
                    Statement balance
                    {account.statementBalanceAt ? ` (${formatDate(account.statementBalanceAt)})` : ""}
                  </span>
                  <span>{account.statementBalance !== null ? <Money value={account.statementBalance} /> : "—"}</span>
                </div>
              </div>
              {account.unreconciledCount > 0 ? (
                <Link className={styles.action} href={`/operations/bank-accounts/${account.id}`}>
                  Reconcile {plural(account.unreconciledCount, "item", "items")}
                </Link>
              ) : (
                <div className={styles.quiet}>All reconciled</div>
              )}
            </section>
          ))
        )}
      </div>
      <div className={styles.grid}>
        <AmountsDueTile
          title="Money owed to you"
          due={summary.owedToYou}
          noun={["invoice", "invoices"]}
          href="/operations/invoices?show=awaiting"
          emptyText="Nothing owed right now."
        />
        <AmountsDueTile
          title="Bills to pay"
          due={summary.billsToPay}
          noun={["bill", "bills"]}
          href="/operations/bills?show=awaiting"
          emptyText="No bills to pay right now."
        />
        <NextGstTile summary={summary} />
      </div>
    </>
  );
}
