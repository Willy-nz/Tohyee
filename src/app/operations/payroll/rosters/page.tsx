"use client";

import { RequireOrganisation } from "@/components/books";
import { Rosters } from "@/components/rosters";
import { Page, PageHeader } from "@/components/ui";

export default function RostersPage() {
  return (
    <Page>
      <PageHeader title="Rosters" description="Shifts by week for each area, their cost against its budget, and publishing them to staff." />
      <RequireOrganisation>{(organisationId) => <Rosters key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
