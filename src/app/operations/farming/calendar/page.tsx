"use client";

import { Suspense } from "react";
import { RequireOrganisation } from "@/components/books";
import { FarmCalendarHome } from "@/components/farm-calendar";
import { Page, PageHeader } from "@/components/ui";

export default function FarmCalendarPage() {
  return (
    <Page>
      <PageHeader title="Farm calendar" description="Visits, deliveries, contractors and deadlines read from your own email. Only you see your calendar." />
      <Suspense fallback={null}>
        <RequireOrganisation>{(organisationId) => <FarmCalendarHome key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
      </Suspense>
    </Page>
  );
}
