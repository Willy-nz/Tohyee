"use client";

import Link from "next/link";
import { AmountsDueTile, useHomeSummary } from "@/components/home/home";
import { Card, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";

type AreaLink = { href: string; label: string; description: string; bookkeeper?: boolean };

const SALES_LINKS: AreaLink[] = [
  { href: "/operations/invoices/new", label: "New invoice", description: "Draft a sales invoice.", bookkeeper: true },
  { href: "/operations/invoices?show=drafts", label: "Draft invoices", description: "Invoices not approved yet." },
  { href: "/operations/invoices?show=awaiting", label: "Awaiting payment", description: "Approved invoices with something still due." },
  { href: "/operations/credit-notes", label: "Credit notes", description: "Credit for customers: apply it to invoices or refund it." },
  { href: "/operations/quotes", label: "Quotes", description: "Prices offered to customers; accept one to make its invoice." },
  { href: "/operations/repeating-invoices", label: "Repeating invoices", description: "Invoices made every so many weeks or months." },
  { href: "/operations/projects", label: "Projects", description: "Time and expenses for customer work, and invoicing what's unbilled." },
];

const PURCHASES_LINKS: AreaLink[] = [
  { href: "/operations/bills/new", label: "New bill", description: "Enter a bill from a supplier.", bookkeeper: true },
  { href: "/operations/bills?show=drafts", label: "Draft bills", description: "Bills not approved yet." },
  { href: "/operations/bills?show=awaiting", label: "Awaiting payment", description: "Approved bills with something still to pay." },
  { href: "/operations/purchase-orders", label: "Purchase orders", description: "Orders to suppliers; copy one to a bill when their invoice arrives." },
  { href: "/operations/repeating-bills", label: "Repeating bills", description: "Bills made every so many weeks or months, such as rent." },
  { href: "/operations/supplier-credit-notes", label: "Supplier credit notes", description: "Credit from suppliers: apply it to bills or record a refund." },
  { href: "/operations/expense-claims", label: "Expense claims", description: "Receipts people paid for themselves: approve and pay them back." },
];

/** Sales or Purchases overview: what's due (H2, H3) and where to go next. */
export function AreaOverview({ organisationId, area }: { organisationId: string; area: "sales" | "purchases" }) {
  const { can } = useWorkspace();
  const home = useHomeSummary(organisationId);
  const links = (area === "sales" ? SALES_LINKS : PURCHASES_LINKS).filter((link) => !link.bookkeeper || can("bookkeeper"));
  return (
    <>
      {home.error ? <Notice tone="error">{home.error}</Notice> : null}
      {home.data ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 16, marginBottom: 16 }}>
          {area === "sales" ? (
            <AmountsDueTile
              title="Money owed to you"
              due={home.data.owedToYou}
              noun={["invoice", "invoices"]}
              href="/operations/invoices?show=awaiting"
              emptyText="Nothing owed right now."
            />
          ) : (
            <AmountsDueTile
              title="Bills to pay"
              due={home.data.billsToPay}
              noun={["bill", "bills"]}
              href="/operations/bills?show=awaiting"
              emptyText="No bills to pay right now."
            />
          )}
        </div>
      ) : home.error ? null : (
        <p className={ui.muted}>Loading…</p>
      )}
      <Card title={area === "sales" ? "Sales" : "Purchases"}>
        <ul style={{ listStyle: "none", display: "grid", gap: 12 }}>
          {links.map((link) => (
            <li key={link.href}>
              <Link href={link.href} style={{ fontWeight: 600 }}>
                {link.label}
              </Link>
              <div className={ui.muted}>{link.description}</div>
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
