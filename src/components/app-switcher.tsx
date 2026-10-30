"use client";

import Link from "next/link";
import { IllustratedIcon } from "@/components/illustrated-icon";
import type { Modules } from "@/components/modules";
import styles from "./app-shell.module.css";

/** Tohyee's apps, each with its own top bar: Accounting (with Tax), Farm (#498, decision 1110), the CRM and Analytics. */
export type AppKey = "accounting" | "farm" | "crm" | "analytics";

const APPS: Array<{ key: AppKey; label: string; href: string }> = [
  { key: "accounting", label: "Accounting", href: "/operations" },
  { key: "farm", label: "Farm", href: "/operations/farm" },
  { key: "crm", label: "CRM", href: "/crm" },
  { key: "analytics", label: "Analytics", href: "/analytics" },
];

/**
 * The apps someone can switch to: the CRM only while it's on for the
 * organisation (MOD1), Accounting unless it's off (MOD2), Farm while
 * Farming is on (it needs Accounting, #249). Farm staff have Farm only
 * (decision 904).
 */
export function availableApps(modules: Modules | null, reportViewer = false, farmWorker = false): AppKey[] {
  // Report viewers only have Analytics (decision 360).
  if (reportViewer) return ["analytics"];
  if (farmWorker) return modules?.farming ? ["farm"] : [];
  return APPS.filter(
    (app) =>
      (app.key !== "accounting" || modules?.accounting !== false) &&
      (app.key !== "farm" || (modules?.farming === true && modules.accounting !== false)) &&
      (app.key !== "crm" || modules?.crm === true) &&
      (app.key !== "analytics" || modules?.analytics === true),
  ).map((app) => app.key);
}

/**
 * Moves between the apps, like Salesforce's app launcher. Shown only when
 * there's somewhere to switch to, so people without the CRM never see it
 * (nor while the organisation's modules are still loading).
 */
export function AppSwitcher({ current, modules, reportViewer = false, farmWorker = false }: { current: AppKey; modules: Modules | null; reportViewer?: boolean; farmWorker?: boolean }) {
  const keys = availableApps(modules, reportViewer, farmWorker);
  if (keys.length < 2) return null;
  const apps = APPS.filter((app) => keys.includes(app.key));
  return (
    <details className={styles.appLauncher} onKeyDown={(event) => {
      if (event.key === "Escape") {
        event.currentTarget.removeAttribute("open");
        event.currentTarget.querySelector("summary")?.focus();
      }
    }}>
      <summary className={styles.appLauncherButton} aria-label="Apps">
        <span className={styles.appLauncherGrid} aria-hidden>
          <span />
          <span />
          <span />
          <span />
        </span>
      </summary>
      <nav aria-label="Apps" className={styles.appLauncherPanel}>
        {apps.map((app) => (
          <Link
            key={app.key}
            href={app.href}
            onClick={(event) => event.currentTarget.closest("details")?.removeAttribute("open")}
            className={`${styles.appLauncherLink} ${app.key === current ? styles.appLauncherLinkActive : ""}`}
            aria-current={app.key === current ? "page" : undefined}
          >
            <IllustratedIcon name={app.key} />
            <span>{app.label}</span>
          </Link>
        ))}
      </nav>
    </details>
  );
}
