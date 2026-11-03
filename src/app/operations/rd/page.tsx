"use client";

import Link from "next/link";
import { RequireOrganisation } from "@/components/books";
import { RdRegister } from "@/components/rd";
import { Page, PageHeader } from "@/components/ui";

export default function RdActivitiesPage() {
  return (
    <Page>
      <PageHeader
        title="R&D activities"
        actions={<Link href="/operations/rd/costs">Tagged R&amp;D costs</Link>}
      />
      <RequireOrganisation>{(organisationId) => <RdRegister key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
