"use client";

import Link from "next/link";
import type { Modules } from "@/components/modules";
import styles from "./app-shell.module.css";

/** Tohyee's apps, each with its own shell: Accounting (with Tax), the CRM and Analytics. */
export type AppKey = "accounting" | "crm" | "analytics";

const APPS: Array<{ key: AppKey; label: string; href: string }> = [
  { key: "accounting", label: "Accounting", href: "/operations" },
  { key: "crm", label: "CRM", href: "/crm" },
  { key: "analytics", label: "Analytics", href: "/analytics" },
];

/** The apps someone can switch to: the CRM only while it's on for the organisation (MOD1). */
export function availableApps(modules: Modules | null): AppKey[] {
  return APPS.filter((app) => (app.key !== "crm" || modules?.crm === true) && (app.key !== "analytics" || modules?.analytics === true)).map((app) => app.key);
}

/**
 * Moves between the apps, like Salesforce's app launcher. Shown only when
 * there's somewhere to switch to, so people without the CRM never see it
 * (nor while the organisation's modules are still loading).
 */
export function AppSwitcher({ current, modules }: { current: AppKey; modules: Modules | null }) {
  const keys = availableApps(modules);
  if (keys.length < 2) return null;
  return (
    <nav aria-label="Apps" className={styles.appSwitcher}>
      {APPS.filter((app) => keys.includes(app.key)).map((app) => (
        <Link
          key={app.key}
          href={app.href}
          className={`${styles.appLink} ${app.key === current ? styles.appLinkActive : ""}`}
          aria-current={app.key === current ? "true" : undefined}
        >
          {app.label}
        </Link>
      ))}
    </nav>
  );
}
