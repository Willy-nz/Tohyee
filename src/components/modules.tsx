"use client";

import Link from "next/link";
import { type ReactNode, useEffect, useState } from "react";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Notice, ui } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import type { OrganisationSettings } from "@/lib/organisations/settings";
import { useWorkspace } from "@/components/workspace";
import { useConfirm } from "@/components/confirm-dialog";

/**
 * The modules switched on per organisation. Accounting is on unless the
 * organisation only uses the CRM or Analytics (#181); Tax is the GST
 * registration switch (#180).
 */
export type Modules = {
  crm: boolean;
  reporting: boolean;
  notForProfit: boolean;
  analytics: boolean;
  /** Registered for GST at any time (issue #180): the GST return and GST audit show. */
  gst: boolean;
  /** Accounting (#181, MOD2): false only when it's been turned off; left out means on. */
  accounting?: boolean;
};

const CHANGED = "tohyee:modules-changed";

/** Which optional modules are on for an organisation. Updates when they're switched. */
export function useModules(organisationId: string | null): Modules | null {
  const { current } = useWorkspace();
  // Report viewers see only shared dashboards (decision 360), not the organisation's settings.
  const reportViewer = current?.id === organisationId && current?.role === "report_viewer";
  // Sales reps and managers use the CRM only (decision 491): whether it's on comes from the CRM, not the settings.
  const salesRole = current?.id === organisationId && (current?.role === "sales_rep" || current?.role === "sales_manager");
  const settings = useApiData<{ settings: OrganisationSettings }>(
    organisationId && !reportViewer && !salesRole ? `/api/organisations/${organisationId}/settings` : null,
  );
  const crmTeam = useApiData<{ crmEnabled: boolean }>(organisationId && salesRole ? "/api/crm/team" : null, organisationId ? { organisationId } : {});
  const { reload } = settings;
  useEffect(() => {
    window.addEventListener(CHANGED, reload);
    return () => window.removeEventListener(CHANGED, reload);
  }, [reload]);
  if (reportViewer) return { crm: false, reporting: false, notForProfit: false, analytics: true, gst: false, accounting: false };
  if (salesRole) return crmTeam.data ? { crm: crmTeam.data.crmEnabled, reporting: false, notForProfit: false, analytics: false, gst: false, accounting: false } : null;
  if (!settings.data) return null;
  return {
    crm: settings.data.settings.crmEnabled,
    reporting: settings.data.settings.advancedFeatures,
    notForProfit: settings.data.settings.notForProfitEnabled,
    analytics: settings.data.settings.analyticsEnabled,
    gst: settings.data.settings.gstRegistered,
    accounting: settings.data.settings.accountingEnabled,
  };
}

type ModuleRow = {
  key: keyof Modules;
  setting: "crmEnabled" | "advancedFeatures" | "notForProfitEnabled" | "analyticsEnabled";
  title: string;
  description: string;
  links: Array<{ href: string; label: string }>;
};

const OPTIONAL: ModuleRow[] = [
  {
    key: "crm",
    setting: "crmEnabled",
    title: "CRM",
    description:
      "Companies and the people who work there, prospects, an opportunities pipeline that turns won work into invoices, tasks, calls, meetings and notes, and a timeline for every company.",
    links: [
      { href: "/crm/companies", label: "Companies" },
      { href: "/crm/pipeline", label: "Pipeline" },
    ],
  },
  {
    key: "analytics",
    setting: "analyticsEnabled",
    title: "Analytics",
    description:
      "Load CSV files from a folder on the server (sales exports, emailed reports, anything with rows and columns) every night, and build dashboards from them like Power BI: charts, tables and key figures with date ranges and slicers. A server admin chooses the folder.",
    links: [
      { href: "/analytics", label: "Reports" },
      { href: "/analytics/sources", label: "Data sources" },
      { href: "/analytics/shaping", label: "Prepare data" },
    ],
  },
  {
    key: "reporting",
    setting: "advancedFeatures",
    title: "Advanced reporting",
    description:
      "For bigger organisations: tracking categories (Department, Class, Location and segments of your own) on every line with the profit and loss split and filtered by them, custom fields, salespeople with sales by salesperson, and richer customers (credit limits, groups, price levels, parent customers).",
    links: [
      { href: "/operations/settings/tracking", label: "Tracking categories" },
      { href: "/operations/settings/custom-fields", label: "Custom fields" },
      { href: "/operations/settings/salespeople", label: "Salespeople" },
      { href: "/operations/settings/customers", label: "Customers" },
    ],
  },
  {
    key: "notForProfit",
    setting: "notForProfitEnabled",
    title: "Not-for-profit",
    description:
      "Use a Fund tracking category to split income and expenses, and assign budgets to funds. Turn on Advanced reporting too to tag lines. Grant recognition, donation receipts, fund equity balances and PBE reports are not supported yet.",
    links: [
      { href: "/operations/settings/tracking", label: "Set up fund tracking" },
      { href: "/operations/reports?report=pnl", label: "Profit and loss" },
      { href: "/operations/budgets", label: "Budgets by fund" },
      { href: "/operations/reports?view=custom", label: "Custom reports" },
    ],
  },
];

/** Modules (Settings, and the account menu in every app). Turning a module off hides it; anything entered is kept. */
export function ModulesCard({ organisationId }: { organisationId: string }) {
  const settings = useApiData<{ settings: OrganisationSettings }>(`/api/organisations/${organisationId}/settings`);
  const confirm = useConfirm();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function save(key: string, body: Record<string, boolean>) {
    setBusy(key);
    setError(null);
    try {
      await api(`/api/organisations/${organisationId}/settings`, { method: "PATCH", body });
      settings.reload();
      window.dispatchEvent(new Event(CHANGED));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  }
  async function toggleAccounting(on: boolean) {
    if (on && current) {
      // MOD5, MOD6: what else goes off, and what pauses.
      const alsoOff = [current.advancedFeatures ? "Advanced reporting" : null, current.notForProfitEnabled ? "Not-for-profit" : null].filter(Boolean);
      const message = [
        "Turn Accounting off? Everything already entered is kept and shows again when it's turned back on.",
        alsoOff.length ? `${alsoOff.join(" and ")} need${alsoOff.length === 1 ? "s" : ""} Accounting, so ${alsoOff.length === 1 ? "it turns" : "they turn"} off too.` : null,
        "Bank feeds, Shopify and WooCommerce syncs and repeating invoices and bills pause until it's back on, then carry on from where they stopped.",
      ]
        .filter(Boolean)
        .join(" ");
      if (!(await confirm(message))) return;
    }
    await save("accounting", { accountingEnabled: !on });
  }
  const current = settings.data?.settings;
  const accountingOn = current?.accountingEnabled !== false;
  return (
    <Card
      title="Modules"
      description="Keep at least one of Accounting, CRM or Analytics on. Turning a module off hides it; anything entered is kept. Advanced reporting and Not-for-profit need Accounting."
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      {settings.error ? <Notice tone="error">{settings.error}</Notice> : null}
      <div className={ui.tableWrap}>
        <table className={ui.table}>
          <tbody>
            <tr>
              <td>
                <strong>Accounting</strong>
                <div className={ui.muted}>
                  Invoices, bills, banking and bank feeds, payroll, reports and the GST return. Shopify and WooCommerce orders post here.
                </div>
              </td>
              <td>{accountingOn ? <Badge tone="green">On</Badge> : <Badge>Off</Badge>}</td>
              <td className={ui.num}>
                <Button variant={accountingOn ? "secondary" : "primary"} size="small" disabled={!current || busy !== null} onClick={() => void toggleAccounting(accountingOn)}>
                  {busy === "accounting" ? "Saving…" : accountingOn ? "Turn off Accounting" : "Turn on Accounting"}
                </Button>
              </td>
            </tr>
            <tr>
              <td>
                <strong>Tax</strong>
                <div className={ui.muted}>
                  GST registration, set under Settings › GST{current?.gstNumber ? "" : " (with the GST number)"}. The GST return and GST audit show while registered.
                </div>
                {accountingOn ? (
                  <div className={ui.actions}>
                    <Link href="/operations/settings">GST settings</Link>
                  </div>
                ) : null}
              </td>
              <td>{!accountingOn ? <Badge>Off with Accounting</Badge> : current?.gstRegistered ? <Badge tone="green">Registered for GST</Badge> : <Badge>Not registered</Badge>}</td>
              <td />
            </tr>
            {OPTIONAL.map((row) => {
              const on = current ? current[row.setting] : false;
              const needsAccounting = (row.key === "reporting" || row.key === "notForProfit") && !accountingOn;
              return (
                <tr key={row.key}>
                  <td>
                    <strong>{row.title}</strong>
                    <div className={ui.muted}>{row.description}</div>
                    {on && !needsAccounting ? (
                      <div className={ui.actions}>
                        {row.links.map((link) => (
                          <Link key={link.href} href={link.href}>
                            {link.label}
                          </Link>
                        ))}
                      </div>
                    ) : null}
                  </td>
                  <td>{on ? <Badge tone="green">On</Badge> : <Badge>{needsAccounting ? "Needs Accounting" : "Off"}</Badge>}</td>
                  <td className={ui.num}>
                    <Button
                      variant={on ? "secondary" : "primary"}
                      size="small"
                      disabled={!current || busy !== null || needsAccounting}
                      onClick={() => void save(row.key, { [row.setting]: !on })}
                    >
                      {busy === row.key ? "Saving…" : on ? `Turn off ${row.title}` : `Turn on ${row.title}`}
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/**
 * Shown instead of the GST return and GST audit while the organisation has
 * never been registered for GST (issue #180, NR4).
 */
export function RequireGstRegistered({ organisationId, children }: { organisationId: string; children: ReactNode }) {
  const modules = useModules(organisationId);
  const { current } = useWorkspace();
  if (!modules) return <p className={ui.muted}>Loading…</p>;
  if (!modules.gst) {
    return (
      <Notice tone="info">
        {current?.displayName ?? "This organisation"} isn&apos;t registered for GST, so there are no GST returns.{" "}
        <Link href="/operations/settings">Settings</Link> turns registration on.
      </Notice>
    );
  }
  return <>{children}</>;
}
