"use client";

import { RequireOrganisation } from "@/components/books";
import { LivestockManagement } from "@/components/livestock";
import { Page, PageHeader } from "@/components/ui";

export default function LivestockManagementPage() {
  return (
    <Page>
      <PageHeader title="Livestock management values" description="Stock on hand at the farm's own values per head, month by month. A report only." />
      <RequireOrganisation>{(organisationId) => <LivestockManagement key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
