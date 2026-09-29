"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Notice, ui } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import type { OrganisationSettings } from "@/lib/organisations/settings";

/**
 * Tohyee's four modules (example MOD1): Accounting and Tax are always on; the
 * CRM and Advanced reporting are switched on per organisation.
 */
export type Modules = { crm: boolean; reporting: boolean };

const CHANGED = "tohyee:modules-changed";

/** Which optional modules are on for an organisation. Updates when they're switched. */
export function useModules(organisationId: string | null): Modules | null {
  const settings = useApiData<{ settings: OrganisationSettings }>(organisationId ? `/api/organisations/${organisationId}/settings` : null);
  const { reload } = settings;
  useEffect(() => {
    window.addEventListener(CHANGED, reload);
    return () => window.removeEventListener(CHANGED, reload);
  }, [reload]);
  if (!settings.data) return null;
  return { crm: settings.data.settings.crmEnabled, reporting: settings.data.settings.advancedFeatures };
}

type ModuleRow = {
  key: "crm" | "reporting";
  setting: "crmEnabled" | "advancedFeatures";
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
      { href: "/operations/crm/companies", label: "Companies" },
      { href: "/operations/crm/pipeline", label: "Pipeline" },
    ],
  },
  {
    key: "reporting",
    setting: "advancedFeatures",
    title: "Advanced reporting",
    description:
      "For bigger organisations: tracking categories (Department, Class, Location and segments of your own) on every line with the profit and loss split and filtered by them, custom fields, and salespeople with sales by salesperson.",
    links: [
      { href: "/operations/settings/tracking", label: "Tracking categories" },
      { href: "/operations/settings/custom-fields", label: "Custom fields" },
      { href: "/operations/settings/salespeople", label: "Salespeople" },
    ],
  },
];

/** Settings › Modules. Turning a module off hides it; anything entered is kept. */
export function ModulesCard({ organisationId }: { organisationId: string }) {
  const settings = useApiData<{ settings: OrganisationSettings }>(`/api/organisations/${organisationId}/settings`);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function toggle(row: ModuleRow, on: boolean) {
    setBusy(row.key);
    setError(null);
    try {
      await api(`/api/organisations/${organisationId}/settings`, { method: "PATCH", body: { [row.setting]: !on } });
      settings.reload();
      window.dispatchEvent(new Event(CHANGED));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  }
  const current = settings.data?.settings;
  return (
    <Card title="Modules" description="Accounting and Tax are always on. Turn on the others you need; turning one off hides it, and anything entered is kept.">
      {error ? <Notice tone="error">{error}</Notice> : null}
      {settings.error ? <Notice tone="error">{settings.error}</Notice> : null}
      <div className={ui.tableWrap}>
        <table className={ui.table}>
          <tbody>
            {["Accounting", "Tax"].map((name) => (
              <tr key={name}>
                <td>
                  <strong>{name}</strong>
                </td>
                <td>
                  <Badge tone="green">Always on</Badge>
                </td>
                <td />
              </tr>
            ))}
            {OPTIONAL.map((row) => {
              const on = current ? current[row.setting] : false;
              return (
                <tr key={row.key}>
                  <td>
                    <strong>{row.title}</strong>
                    <div className={ui.muted}>{row.description}</div>
                    {on ? (
                      <div className={ui.actions}>
                        {row.links.map((link) => (
                          <Link key={link.href} href={link.href}>
                            {link.label}
                          </Link>
                        ))}
                      </div>
                    ) : null}
                  </td>
                  <td>{on ? <Badge tone="green">On</Badge> : <Badge>Off</Badge>}</td>
                  <td className={ui.num}>
                    <Button variant={on ? "secondary" : "primary"} size="small" disabled={!current || busy !== null} onClick={() => void toggle(row, on)}>
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
