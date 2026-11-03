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
        actions={<Link href="/operations/rd/costs">Tagged R&amp;D costs</Link>}
      />
      <RequireOrganisation>{(organisationId) => <RdClaimView key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
