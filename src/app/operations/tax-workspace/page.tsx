"use client";
import Link from "next/link";
import { RequireOrganisation } from "@/components/books";
import { useModules } from "@/components/modules";
import { visibleMenus, menuSections } from "@/components/navigation";
import { Card, Page, PageHeader, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
function Tools({ organisationId }: { organisationId: string }) {
  const { can } = useWorkspace();
  const modules = useModules(organisationId);
  if (!modules) return <p>Loading…</p>;
  const groups = visibleMenus("accounting", { can, modules }).find((menu) => menu.label === "Tax")?.groups ?? [];
  return <div className={ui.grid3}>{groups.flatMap((group) => menuSections(group).map((section) => <Card key={group.heading + section.heading} title={section.heading ?? group.heading}><ul>{section.links.map((link) => <li key={link.href} style={{ marginBottom: 12 }}><Link href={link.href}>{link.label}</Link></li>)}</ul></Card>))}</div>;
}
export default function ToolsPage() { return <Page><PageHeader title="Tax" description="Choose the work you want to do." /><RequireOrganisation>{(id) => <Tools key={id} organisationId={id} />}</RequireOrganisation></Page>; }
