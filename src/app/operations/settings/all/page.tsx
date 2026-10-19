"use client";

import Link from "next/link";
import { RequireOrganisation } from "@/components/books";
import { useModules } from "@/components/modules";
import { visibleSettings } from "@/components/navigation";
import { Card, Page, PageHeader, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import styles from "./all-settings.module.css";

/** Every setting someone may open, grouped as cards (like Xero's Settings page; #338, decision 580). */
function AllSettings({ organisationId }: { organisationId: string }) {
  const { can } = useWorkspace();
  const modules = useModules(organisationId);
  if (!modules) return <p className={ui.muted}>Loading…</p>;
  const groups = visibleSettings({ can, modules });
  return (
    <div className={styles.cards}>
      {groups.map((group) => (
        <Card key={group.heading} title={group.heading}>
          <ul className={styles.links}>
            {group.links.map((link) => (
              <li key={`${link.href}|${link.label}`}>
                <Link href={link.href}>{link.label}</Link>
              </li>
            ))}
          </ul>
        </Card>
      ))}
    </div>
  );
}

export default function AllSettingsPage() {
  const { can } = useWorkspace();
  return (
    <Page>
      <PageHeader
        title="All settings"
        description={
          can("admin")
            ? "Everything you can set up for this organisation. Settings for modules that are off don't show; turn them on under Modules."
            : "The settings you can open. Admins see more."
        }
      />
      <RequireOrganisation>{(organisationId) => <AllSettings key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
