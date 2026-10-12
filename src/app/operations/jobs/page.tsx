"use client";

import { RequireOrganisation } from "@/components/books";
import { JobsList } from "@/components/jobs";
import { Page, PageHeader } from "@/components/ui";

export default function JobsPage() {
  return (
    <Page>
      <PageHeader title="Jobs" description="Projects with a site, their visits and the services due." />
      <RequireOrganisation>{(organisationId) => <JobsList key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
