"use client";

import { RequireOrganisation } from "@/components/books";
import { LivestockSettingsPanel } from "@/components/livestock";
import { Page, PageHeader } from "@/components/ui";

export default function LivestockSettingsPage() {
  return (
    <Page>
      <PageHeader title="Livestock settings" description="Turning livestock on, the opening position, elections, IRD rates, accounts and locations." />
      <RequireOrganisation>{(organisationId) => <LivestockSettingsPanel key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
