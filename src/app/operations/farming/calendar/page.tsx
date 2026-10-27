"use client";

import { Suspense } from "react";
import { RequireOrganisation } from "@/components/books";
import { FarmCalendarHome } from "@/components/farm-calendar";
import { FarmSafetyDue } from "@/components/farm-safety-tab";
import { Page, PageHeader } from "@/components/ui";

export default function FarmCalendarPage() {
  return (
    <Page>
      <PageHeader title="Farm calendar" description="Visits, deliveries, contractors and deadlines read from your own email, items you add, and what others share with the farm team." />
      <Suspense fallback={null}>
        <RequireOrganisation>
          {(organisationId) => (
            <>
              <FarmSafetyDue key={`safety-${organisationId}`} organisationId={organisationId} />
              <FarmCalendarHome key={organisationId} organisationId={organisationId} />
            </>
          )}
        </RequireOrganisation>
      </Suspense>
    </Page>
  );
}
