"use client";

import { RequireOrganisation } from "@/components/books";
import { FarmApps } from "@/components/farm-apps";
import { Page, PageHeader } from "@/components/ui";

export default function FarmAppsPage() {
  return (
    <Page>
      <PageHeader title="Farm apps" />
      <RequireOrganisation>{(organisationId) => <FarmApps key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
