"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { ROLE_LABELS, type Role } from "@/lib/auth/roles";
import styles from "./app-shell.module.css";
import {
  useWorkspace,
  type WorkspaceOrganisation,
  WorkspaceProvider,
  type WorkspaceUser,
} from "./workspace";

type NavItem = { href: string; label: string; minRole?: Role; serverAdmin?: boolean };

const NAV: Array<{ label: string; items: NavItem[] }> = [
  {
    label: "Books",
    items: [
      { href: "/operations", label: "Overview" },
      { href: "/operations/ledger-journals", label: "Journals" },
      { href: "/operations/accounts", label: "Chart of accounts" },
      { href: "/operations/contacts", label: "Contacts" },
      { href: "/operations/invoices", label: "Invoices" },
      { href: "/operations/credit-notes", label: "Credit notes" },
      { href: "/operations/bills", label: "Bills" },
      { href: "/operations/supplier-credit-notes", label: "Supplier credit notes" },
      { href: "/operations/inventory", label: "Stock" },
      { href: "/operations/reports", label: "Reports" },
      { href: "/operations/fx-revaluation", label: "FX revaluation", minRole: "bookkeeper" },
    ],
  },
  {
    label: "Organisation",
    items: [
      { href: "/operations/settings", label: "Settings and locks", minRole: "admin" },
      { href: "/operations/members", label: "People and roles", minRole: "admin" },
      { href: "/operations/tax", label: "Tax codes" },
    ],
  },
  {
    label: "Server",
    items: [
      { href: "/operations/organisations", label: "Organisations", serverAdmin: true },
      { href: "/operations/users", label: "Users", serverAdmin: true },
      { href: "/operations/server", label: "Updates", serverAdmin: true },
    ],
  },
];

function isActive(pathname: string, href: string) {
  return href === "/operations" ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
}

function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { user, organisations, current, selectOrganisation, can } = useWorkspace();

  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    router.replace("/login");
    router.refresh();
  }

  return (
    <div className={styles.shell}>
      <a href="#main-content" className={styles.skipLink}>
        Skip to content
      </a>
      <aside className={styles.sidebar}>
        <div className={styles.brand}>
          <span className={styles.brandDot} aria-hidden />
          Tohyee
        </div>
        <nav aria-label="Primary">
          {NAV.map((group) => {
            const items = group.items.filter(
              (item) => (!item.serverAdmin || user.isServerAdmin) && (!item.minRole || can(item.minRole)),
            );
            if (items.length === 0) return null;
            return (
              <div key={group.label} className={styles.navGroup} style={{ marginBottom: 14 }}>
                <div className={styles.navLabel}>{group.label}</div>
                {items.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`${styles.navLink} ${isActive(pathname, item.href) ? styles.navLinkActive : ""}`}
                    aria-current={isActive(pathname, item.href) ? "page" : undefined}
                  >
                    {item.label}
                  </Link>
                ))}
              </div>
            );
          })}
        </nav>
      </aside>
      <div className={styles.main}>
        <header className={styles.topbar}>
          <div className={styles.orgPicker}>
            {organisations.length > 0 ? (
              <>
                <select
                  id="organisation-picker"
                  aria-label="Organisation"
                  value={current?.id ?? ""}
                  onChange={(event) => selectOrganisation(event.target.value)}
                >
                  {organisations.map((organisation) => (
                    <option key={organisation.id} value={organisation.id}>
                      {organisation.displayName}
                    </option>
                  ))}
                </select>
                {current ? (
                  <span className={styles.orgMeta}>
                    {ROLE_LABELS[current.role]} · {current.baseCurrency}
                  </span>
                ) : null}
              </>
            ) : (
              <span className={styles.orgMeta}>No organisations yet</span>
            )}
          </div>
          <div className={styles.user}>
            <Link href="/operations/profile" className={styles.userName}>
              {user.displayName}
            </Link>
            <button type="button" className={styles.linkButton} onClick={() => void signOut()}>
              Sign out
            </button>
          </div>
        </header>
        <main id="main-content" className={styles.content} tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  );
}

export function AppShell({
  user,
  organisations,
  children,
}: {
  user: WorkspaceUser;
  organisations: WorkspaceOrganisation[];
  children: ReactNode;
}) {
  return (
    <WorkspaceProvider user={user} organisations={organisations}>
      <Shell>{children}</Shell>
    </WorkspaceProvider>
  );
}
