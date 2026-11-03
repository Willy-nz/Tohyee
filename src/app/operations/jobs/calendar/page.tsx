"use client";

import { RequireOrganisation } from "@/components/books";
import { JobCalendar } from "@/components/jobs";
import { Page, PageHeader } from "@/components/ui";

export default function JobCalendarPage() {
  return (
    <Page>
      <PageHeader title="Job calendar" />
      <RequireOrganisation>{(organisationId) => <JobCalendar key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
