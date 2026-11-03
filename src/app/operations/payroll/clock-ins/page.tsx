"use client";

import { RequireOrganisation } from "@/components/books";
import { ClockIns } from "@/components/clock-ins";
import { Page, PageHeader } from "@/components/ui";

export default function ClockInsPage() {
  return (
    <Page>
      <PageHeader title="Clock-ins" />
      <RequireOrganisation>{(organisationId) => <ClockIns key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
