"use client";

import { RequireOrganisation } from "@/components/books";
import { TrackingManager } from "@/components/tracking";
import { Page, PageHeader } from "@/components/ui";

export default function TrackingSettingsPage() {
  return (
    <Page>
      <PageHeader title="Tracking categories" />
      <RequireOrganisation>{(organisationId) => <TrackingManager key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
