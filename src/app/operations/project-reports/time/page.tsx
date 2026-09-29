"use client";

import { RequireOrganisation } from "@/components/books";
import { TimeReportView } from "@/components/projects";
import { Page, PageHeader } from "@/components/ui";

export default function ProjectTimePage() {
  return (
    <Page>
      <PageHeader title="Time report" />
      <RequireOrganisation>{(organisationId) => <TimeReportView key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
