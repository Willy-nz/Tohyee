"use client";

import Link from "next/link";
import { RequireOrganisation } from "@/components/books";
import { RdCostsView } from "@/components/rd";
import { Page, PageHeader } from "@/components/ui";

export default function RdCostsPage() {
  return (
    <Page>
      <PageHeader
        title="Tagged R&D costs"
        description="Costs tagged to R&D activities, by activity and category, for an income year."
        actions={<Link href="/operations/rd">R&amp;D activities</Link>}
      />
      <RequireOrganisation>{(organisationId) => <RdCostsView key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
