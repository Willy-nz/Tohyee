"use client";

import Link from "next/link";
import { RequireOrganisation } from "@/components/books";
import { useModules } from "@/components/modules";
import { visibleMenus, menuSections, type MenuSection } from "@/components/navigation";
import { Card, Page, PageHeader, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";

function Section({ section }: { section: MenuSection }) {
  return (
    <Card title={section.heading === "R&D" ? "Research and development tax incentive (RDTI)" : section.heading ?? "Tax"}>
      <ul>
        {section.links.map((link) => (
          <li key={link.href} style={{ marginBottom: 12 }}>
            <Link href={link.href}>{link.label}</Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Tools({ organisationId }: { organisationId: string }) {
  const { can } = useWorkspace();
  const modules = useModules(organisationId);
  if (!modules) return <p>Loading…</p>;
  const groups = visibleMenus("accounting", { can, modules }).find((menu) => menu.label === "Tax")?.groups ?? [];
  const sections = groups.flatMap(menuSections);
  const everyday = sections.filter((section) => section.heading !== "R&D");
  const advanced = sections.filter((section) => section.heading === "R&D");
  return (
    <>
      <div className={ui.grid3}>
        {everyday.map((section) => <Section key={section.heading} section={section} />)}
      </div>
      {advanced.length > 0 ? (
        <details>
          <summary style={{ cursor: "pointer", color: "var(--text-muted)", padding: "12px 0" }}>Advanced tax tools</summary>
          <div className={ui.grid3} style={{ marginTop: 12 }}>
            {advanced.map((section) => <Section key={section.heading} section={section} />)}
          </div>
        </details>
      ) : null}
    </>
  );
}

export default function ToolsPage() {
  return (
    <Page>
      <PageHeader title="Tax" description="Choose the work you want to do." />
      <RequireOrganisation>{(id) => <Tools key={id} organisationId={id} />}</RequireOrganisation>
    </Page>
  );
}
