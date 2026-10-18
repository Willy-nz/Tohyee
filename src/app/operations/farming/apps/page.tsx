"use client";

import { RequireOrganisation } from "@/components/books";
import { FarmApps } from "@/components/farm-apps";
import { Page, PageHeader } from "@/components/ui";

export default function FarmAppsPage() {
  return (
    <Page>
      <PageHeader title="Farm apps" description="Keys for apps you build (often with an AI) or use, to read farm data and record field work through Tohyee's Farming API." />
      <RequireOrganisation>{(organisationId) => <FarmApps key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
