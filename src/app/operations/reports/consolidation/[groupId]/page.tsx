"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { ConsolidationGroupView } from "@/components/consolidation";
import { Page, PageHeader } from "@/components/ui";

/** A consolidation group's reports, rates, adjustments and intercompany settings (CO3-CO11). */
export default function ConsolidationGroupPage() {
  const { groupId } = useParams<{ groupId: string }>();
  return (
    <Page>
      <PageHeader title="Consolidation" description={<Link href="/operations/reports/consolidation">All groups</Link>} />
      <ConsolidationGroupView key={groupId} groupId={groupId} />
    </Page>
  );
}
