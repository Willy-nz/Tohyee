"use client";

import Link from "next/link";
import { IllustratedIcon, type IllustratedIconName } from "@/components/illustrated-icon";
import styles from "./area-overview.module.css";
import { AmountsDueTile, useHomeSummary } from "@/components/home/home";
import { Card, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";

type AreaLink = { icon: IllustratedIconName; href: string; label: string; description: string; bookkeeper?: boolean };

const SALES_LINKS: AreaLink[] = [
  { icon: "tax", href: "/operations/invoices/new", label: "New invoice", description: "Draft a sales invoice.", bookkeeper: true },
  { icon: "documents", href: "/operations/invoices?show=drafts", label: "Draft invoices", description: "Invoices not approved yet." },
  { icon: "accounting", href: "/operations/invoices?show=awaiting", label: "Awaiting payment", description: "Approved invoices with something still due." },
  { icon: "accounting", href: "/operations/credit-notes", label: "Credit notes", description: "Credit for customers: apply it to invoices or refund it." },
  { icon: "documents", href: "/operations/quotes", label: "Quotes", description: "Prices offered to customers; accept one to make its invoice." },
  { icon: "documents", href: "/operations/sales-orders", label: "Sales orders", description: "What customers have ordered; invoice it all at once or in parts." },
  { icon: "calendar", href: "/operations/repeating-invoices", label: "Repeating invoices", description: "Invoices made every so many weeks or months." },
  { icon: "jobs", href: "/operations/projects", label: "Projects", description: "Time and expenses for customer work, and invoicing what's unbilled." },
];

const PURCHASES_LINKS: AreaLink[] = [
  { icon: "tax", href: "/operations/bills/new", label: "New bill", description: "Enter a bill from a supplier.", bookkeeper: true },
  { icon: "documents", href: "/operations/bills?show=drafts", label: "Draft bills", description: "Bills not approved yet." },
  { icon: "accounting", href: "/operations/bills?show=awaiting", label: "Awaiting payment", description: "Approved bills with something still to pay." },
  { icon: "documents", href: "/operations/purchase-orders", label: "Purchase orders", description: "Orders to suppliers; copy one to a bill when their invoice arrives." },
  { icon: "calendar", href: "/operations/repeating-bills", label: "Repeating bills", description: "Bills made every so many weeks or months, such as rent." },
  { icon: "accounting", href: "/operations/supplier-credit-notes", label: "Supplier credit notes", description: "Credit from suppliers: apply it to bills or record a refund." },
  { icon: "photo", href: "/operations/expense-claims", label: "Expense claims", description: "Receipts people paid for themselves: approve and pay them back." },
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
              note={`Overdue: ${home.data.owedToYou.overdueCount}`}
              href="/operations/invoices?show=awaiting"
            />
          ) : (
            <AmountsDueTile
              title="Bills to pay"
              due={home.data.billsToPay}
              note={`Overdue: ${home.data.billsToPay.overdueCount}`}
              href="/operations/bills?show=awaiting"
            />
          )}
        </div>
      ) : home.error ? null : (
        <p className={ui.muted}>Loading…</p>
      )}
      <Card title={area === "sales" ? "Sales" : "Purchases"}>
        <ul className={styles.links}>
          {links.map((link) => (
            <li key={link.href}>
              <Link href={link.href} className={styles.link}>
                <IllustratedIcon name={link.icon} />
                <span className={styles.copy}><strong>{link.label}</strong><span>{link.description}</span></span>
                <span className={styles.arrow} aria-hidden="true">›</span>
              </Link>
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
