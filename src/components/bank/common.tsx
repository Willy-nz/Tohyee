"use client";

import { Money } from "@/components/books";
import { Badge, ui } from "@/components/ui";
import type { Account } from "@/lib/accounts/service";
import type { BankAccount, BankFeedStatus, SimpleFinFeedStatus, StatementLine } from "@/lib/bank/accounts";
import { formatDateTime } from "@/lib/format";

export const ACCOUNT_TYPE_LABELS: Record<BankAccount["accountType"], string> = {
  bank: "Bank",
  credit_card: "Credit card",
};

/** Journal origins in plain words, for reconciled items and match suggestions. */
export const ORIGIN_LABELS: Record<string, string> = {
  manual: "Journal",
  customer_payment: "Customer payment",
  supplier_payment: "Supplier payment",
  bank_transaction: "Bank transaction",
  bank_transfer: "Transfer",
  customer_overpayment_refund: "Overpayment refund",
  sales_credit_note_refund: "Credit note refund",
  supplier_credit_note_refund: "Supplier credit note refund",
  payroll: "Payroll",
};

export function originLabel(origin: string): string {
  return ORIGIN_LABELS[origin] ?? origin.replace(/_/g, " ");
}

export function journalHref(journalId: string): string {
  return `/operations/ledger-journals?journal=${journalId}`;
}

/** Accounts a bank transaction line can use (the same rules the server checks). */
export function takesBankTransactionLines(account: Account): boolean {
  if (
    account.systemKey === "accounts_receivable" ||
    account.systemKey === "accounts_payable" ||
    account.systemKey === "expense_claims_payable" ||
    account.systemKey === "gst"
  ) {
    return false;
  }
  if (account.accountType === "bank" || account.accountType === "credit_card" || account.accountType === "inventory") return false;
  return account.currencyCode === null;
}

export function isStatementAccount(account: Account): boolean {
  return account.accountType === "bank" || account.accountType === "credit_card";
}

export function FeedBadge({
  feed,
  simplefin = null,
  stripe = null,
}: {
  feed: BankFeedStatus;
  simplefin?: SimpleFinFeedStatus | null;
  stripe?: SimpleFinFeedStatus | null;
}) {
  const other = !feed.active ? (simplefin ? { name: "SimpleFIN", status: simplefin } : stripe ? { name: "Stripe", status: stripe } : null) : null;
  if (other) {
    if (other.status.lastSyncStatus === "failed") return <Badge tone="red">{other.name} failed</Badge>;
    if (other.status.lastSyncStatus === "never") return <Badge tone="amber">{other.name} waiting</Badge>;
    return (
      <span title={other.status.lastSyncedAt ? `Last synced ${formatDateTime(other.status.lastSyncedAt)}` : undefined}>
        <Badge tone="green">{other.name} on</Badge>
      </span>
    );
  }
  if (!feed.active) return <Badge>No feed</Badge>;
  if (feed.lastSyncStatus === "failed") return <Badge tone="red">Feed failed</Badge>;
  if (feed.lastSyncStatus === "never") return <Badge tone="amber">Feed waiting</Badge>;
  return (
    <span title={feed.lastSyncedAt ? `Last synced ${formatDateTime(feed.lastSyncedAt)}` : undefined}>
      <Badge tone="green">Feed on</Badge>
    </span>
  );
}

export function LineStatusBadge({ status }: { status: StatementLine["status"] }) {
  const tone = { unreconciled: "amber", reconciled: "green", excluded: "neutral", deleted: "red" } as const;
  const label = { unreconciled: "To reconcile", reconciled: "Reconciled", excluded: "Excluded", deleted: "Deleted" };
  return <Badge tone={tone[status]}>{label[status]}</Badge>;
}

/** The line's other details (payee, particulars, code, reference) in one muted row. */
export function LineDetails({ line }: { line: Pick<StatementLine, "payee" | "particulars" | "code" | "reference"> }) {
  const parts = [line.payee, line.particulars, line.code, line.reference].filter(Boolean);
  if (parts.length === 0) return null;
  return <div className={ui.muted}>{parts.join(" · ")}</div>;
}

/** Money in and money out as two columns, the way a statement shows them. */
export function InOutCells({ amount }: { amount: string }) {
  const out = amount.startsWith("-");
  return (
    <>
      <td className={ui.num}>{out ? null : <Money value={amount} />}</td>
      <td className={ui.num}>{out ? <Money value={amount.slice(1)} /> : null}</td>
    </>
  );
}

/** Reads a file the person picked as base64, for the import API. */
export function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("The file couldn't be read."));
    reader.readAsDataURL(file);
  });
}

/** A date a number of days before an ISO date. */
export function daysBefore(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - days);
  return value.toISOString().slice(0, 10);
}

/** Cents from a 2-dp amount string, for comparing totals without floats. */
export function toCents(value: string): bigint | null {
  const match = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) return null;
  const cents = BigInt(match[2]) * BigInt(100) + BigInt((match[3] ?? "").padEnd(2, "0") || "0");
  return match[1] ? -cents : cents;
}

export function centsToText(cents: bigint): string {
  const negative = cents < BigInt(0);
  const text = (negative ? -cents : cents).toString().padStart(3, "0");
  return `${negative ? "-" : ""}${text.slice(0, -2)}.${text.slice(-2)}`;
}
