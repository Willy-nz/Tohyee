"use client";

import { RequireOrganisation } from "@/components/books";
import { ItemsManager } from "@/components/items";
import { Page, PageHeader } from "@/components/ui";

export default function ItemsPage() {
  return (
    <Page>
      <PageHeader title="Products and services" description="Items to pick on invoice, bill and credit note lines, with their prices, accounts and tax codes." />
      <RequireOrganisation>{(organisationId) => <ItemsManager key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
