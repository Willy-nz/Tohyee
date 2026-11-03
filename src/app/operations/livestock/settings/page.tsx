"use client";

import { RequireOrganisation } from "@/components/books";
import { LivestockSettingsPanel } from "@/components/livestock";
import { Page, PageHeader } from "@/components/ui";

export default function LivestockSettingsPage() {
  return (
    <Page>
      <PageHeader title="Livestock settings" />
      <RequireOrganisation>{(organisationId) => <LivestockSettingsPanel key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
