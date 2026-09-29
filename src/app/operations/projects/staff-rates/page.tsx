"use client";

import { RequireOrganisation } from "@/components/books";
import { StaffRates } from "@/components/projects";
import { Page, PageHeader } from "@/components/ui";

export default function StaffRatesPage() {
  return (
    <Page>
      <PageHeader title="Staff cost rates" />
      <RequireOrganisation>{(organisationId) => <StaffRates key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
