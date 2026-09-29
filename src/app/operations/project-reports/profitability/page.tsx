"use client";

import { RequireOrganisation } from "@/components/books";
import { ProfitabilityReportView } from "@/components/projects";
import { Page, PageHeader } from "@/components/ui";

export default function ProjectProfitabilityPage() {
  return (
    <Page>
      <PageHeader title="Project profitability" />
      <RequireOrganisation>{(organisationId) => <ProfitabilityReportView key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
