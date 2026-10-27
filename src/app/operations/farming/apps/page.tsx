"use client";

import { RequireOrganisation } from "@/components/books";
import { FarmApps } from "@/components/farm-apps";
import { Page, PageHeader } from "@/components/ui";

export default function FarmAppsPage() {
  return (
    <Page>
      <PageHeader title="Farm apps" description="Tiles for the apps the farm uses, and keys for apps you build (often with an AI) or use, through Tohyee's Farming API." />
      <RequireOrganisation>{(organisationId) => <FarmApps key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
