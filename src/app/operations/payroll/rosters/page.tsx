"use client";

import { RequireOrganisation } from "@/components/books";
import { Rosters } from "@/components/rosters";
import { Page, PageHeader } from "@/components/ui";

export default function RostersPage() {
  return (
    <Page>
      <PageHeader title="Rosters" />
      <RequireOrganisation>{(organisationId) => <Rosters key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
