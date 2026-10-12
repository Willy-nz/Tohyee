"use client";

import { RequireOrganisation } from "@/components/books";
import { JobCalendar } from "@/components/jobs";
import { Page, PageHeader } from "@/components/ui";

export default function JobCalendarPage() {
  return (
    <Page>
      <PageHeader title="Job calendar" description="Everyone's visits by day, or one person's." />
      <RequireOrganisation>{(organisationId) => <JobCalendar key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
