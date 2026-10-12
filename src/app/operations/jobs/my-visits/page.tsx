"use client";

import { RequireOrganisation } from "@/components/books";
import { MyVisits } from "@/components/jobs";
import { Page, PageHeader } from "@/components/ui";

export default function MyVisitsPage() {
  return (
    <Page>
      <PageHeader title="My visits" description="Your visits today and coming up. Open one to start, finish and confirm your hours." />
      <RequireOrganisation>{(organisationId) => <MyVisits key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
