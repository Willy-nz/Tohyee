"use client";

import { RequireOrganisation } from "@/components/books";
import { ItemsManager } from "@/components/items";
import { Page, PageHeader } from "@/components/ui";

export default function ItemsPage() {
  return (
    <Page>
      <PageHeader title="Products and services" />
      <RequireOrganisation>{(organisationId) => <ItemsManager key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
