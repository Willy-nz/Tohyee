"use client";

import Link from "next/link";
import { RequireOrganisation } from "@/components/books";
import { RepeatingPriceChanges } from "@/components/repeating/price-changes";
import { Page, PageHeader } from "@/components/ui";

export default function RepeatingPriceChangesPage() {
  return (
    <Page>
      <PageHeader
        title="Price changes"
        description="A yearly price rise, or any change, across your repeating invoices in one go."
      />
      <p>
        <Link href="/operations/repeating-invoices">All repeating invoices</Link>
      </p>
      <RequireOrganisation>{(organisationId) => <RepeatingPriceChanges organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
