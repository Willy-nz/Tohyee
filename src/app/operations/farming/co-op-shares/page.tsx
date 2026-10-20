"use client";

import { RequireOrganisation } from "@/components/books";
import { CoopSharesView } from "@/components/coop-shares";
import { Page, PageHeader } from "@/components/ui";

export default function CoopSharesPage() {
  return (
    <Page>
      <PageHeader title="Co-op shares" description="The farm's shares in co-ops, with dividends, rebates and retentions, for the year-end pack." />
      <RequireOrganisation>{(organisationId) => <CoopSharesView key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
