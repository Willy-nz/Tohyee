"use client";

import Link from "next/link";
import { RequireOrganisation } from "@/components/books";
import { RdClaimView } from "@/components/rd-claim";
import { Page, PageHeader } from "@/components/ui";

export default function RdClaimPage() {
  return (
    <Page>
      <PageHeader
        title="R&D claim report"
        description="The R&D tax credit for an income year, the supplementary return's figures, overhead rules and deadlines."
        actions={<Link href="/operations/rd/costs">Tagged R&amp;D costs</Link>}
      />
      <RequireOrganisation>{(organisationId) => <RdClaimView key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
