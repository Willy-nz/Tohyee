"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { Money, RequireOrganisation } from "@/components/books";
import { CreditStatusBadge } from "@/components/credit-notes/credit-note-editor";
import { useApiData } from "@/components/hooks";
import { Badge, Card, Empty, Notice, Page, PageHeader, ui } from "@/components/ui";
import { formatDate } from "@/lib/format";
import type { CustomerPayment } from "@/lib/invoices/payments";
import { dec, sum, toFixedString } from "@/lib/money/decimal";

/** The API returns at most this many (newest first). */
const LIMIT = 200;

type Filter = { slug: string; label: string; hasRemainingCredit: boolean; empty: string };

const FILTERS: Filter[] = [
  {
    slug: "left",
    label: "With credit left",
    hasRemainingCredit: true,
    empty: "No overpayments have credit left to apply or refund.",
  },
  { slug: "all", label: "All", hasRemainingCredit: false, empty: "No customer has overpaid yet." },
];

/**
 * Every customer overpayment (examples OP1-OP11): the part of a payment
 * beyond its invoice's amount due, kept as credit for the customer. Nothing
 * here is stored: what's applied, refunded and left is worked out each time.
 */
function OverpaymentList({ organisationId, filter, contactId }: { organisationId: string; filter: Filter; contactId: string | null }) {
  const list = useApiData<{ overpayments: CustomerPayment[] }>("/api/overpayments", {
    organisationId,
    contactId,
    hasRemainingCredit: filter.hasRemainingCredit ? "true" : null,
  });
  if (list.error) return <Notice tone="error">{list.error}</Notice>;
  if (!list.data) return <p className={ui.muted}>Loading…</p>;
  const overpayments = list.data.overpayments;
  if (overpayments.length === 0) return <Empty>{filter.empty}</Empty>;
  const left = toFixedString(sum(overpayments.map((p) => dec(p.overpaymentRemaining))), 2);
  return (
    <>
      {filter.hasRemainingCredit ? (
        <p>
          Credit left for customers: <strong><Money value={left} /></strong> on {overpayments.length}{" "}
          {overpayments.length === 1 ? "overpayment" : "overpayments"}.
        </p>
      ) : null}
      <div className={ui.tableWrap}>
        <table className={ui.table}>
          <thead>
            <tr>
              <th>Payment date</th>
              <th>Customer</th>
              <th>Invoice</th>
              <th>Status</th>
              <th className={ui.num}>Received</th>
              <th className={ui.num}>Overpaid</th>
              <th className={ui.num}>Applied</th>
              <th className={ui.num}>Refunded</th>
              <th className={ui.num}>Left</th>
            </tr>
          </thead>
          <tbody>
            {overpayments.map((payment) => (
              <tr key={payment.id}>
                <td>
                  <Link href={`/operations/overpayments/${payment.id}`}>{formatDate(payment.paymentDate)}</Link>
                </td>
                <td>
                  <Link href={`/operations/overpayments?contact=${payment.contactId}`}>{payment.contactName}</Link>
                </td>
                <td>
                  <Link href={`/operations/invoices/${payment.invoiceId}`}>{payment.invoiceNumber}</Link>
                </td>
                <td>
                  {payment.status === "voided" ? (
                    <Badge tone="red">Payment voided</Badge>
                  ) : payment.overpaymentStatus ? (
                    <CreditStatusBadge status={payment.overpaymentStatus} />
                  ) : null}
                </td>
                <td className={ui.num}>
                  <Money value={payment.amount} />
                </td>
                <td className={ui.num}>
                  <Money value={payment.overpaymentAmount} />
                </td>
                <td className={ui.num}>
                  <Money value={payment.overpaymentApplied} blankZero />
                </td>
                <td className={ui.num}>
                  <Money value={payment.overpaymentRefunded} blankZero />
                </td>
                <td className={ui.num}>
                  <Money value={payment.overpaymentRemaining} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {overpayments.length >= LIMIT ? (
        <p className={ui.muted}>Showing the newest {LIMIT}. Choose a customer to see all of theirs.</p>
      ) : null}
    </>
  );
}

function Overpayments({ organisationId }: { organisationId: string }) {
  const router = useRouter();
  const params = useSearchParams();
  // The filter and customer are in the address, so the menu and links can open them.
  const filter = FILTERS.find((entry) => entry.slug === params.get("show")) ?? FILTERS[0];
  const contactId = params.get("contact");
  const href = (slug: string, contact: string | null) => {
    const query = new URLSearchParams();
    if (slug !== FILTERS[0].slug) query.set("show", slug);
    if (contact) query.set("contact", contact);
    const text = query.toString();
    return text ? `/operations/overpayments?${text}` : "/operations/overpayments";
  };
  return (
    <Card
      title="Customer overpayments"
      description="Latest entered first. When a customer pays more than an invoice's amount due, the extra is credit for them: apply it to their other invoices or refund it from the overpayment's page."
    >
      <div className={ui.tabs} role="tablist" aria-label="Overpayments shown">
        {FILTERS.map((entry) => (
          <button
            key={entry.slug}
            type="button"
            role="tab"
            aria-selected={filter === entry}
            className={`${ui.tab} ${filter === entry ? ui.tabActive : ""}`}
            onClick={() => router.replace(href(entry.slug, contactId), { scroll: false })}
          >
            {entry.label}
          </button>
        ))}
      </div>
      {contactId ? (
        <p className={ui.muted}>
          One customer only. <Link href={href(filter.slug, null)}>Show every customer</Link>
        </p>
      ) : null}
      <OverpaymentList key={`${filter.slug}-${contactId ?? ""}`} organisationId={organisationId} filter={filter} contactId={contactId} />
    </Card>
  );
}

export default function OverpaymentsPage() {
  return (
    <Page>
      <PageHeader title="Overpayments" description="Money customers paid beyond what their invoices asked for, and what's left of it." />
      <Suspense fallback={null}>
        <RequireOrganisation>{(organisationId) => <Overpayments organisationId={organisationId} />}</RequireOrganisation>
      </Suspense>
    </Page>
  );
}
