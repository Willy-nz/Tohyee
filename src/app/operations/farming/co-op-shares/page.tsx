"use client";

import { RequireOrganisation } from "@/components/books";
import { CoopSharesView } from "@/components/coop-shares";
import { Page, PageHeader } from "@/components/ui";

export default function CoopSharesPage() {
  return (
    <Page>
      <PageHeader title="Co-op shares" />
      <RequireOrganisation>{(organisationId) => <CoopSharesView key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
