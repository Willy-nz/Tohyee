"use client";

import { RequireOrganisation } from "@/components/books";
import { BillsInbox } from "@/components/bills/bills-inbox";
import { Page, PageHeader } from "@/components/ui";

/** The bills inbox (BI1-BI7). */
export default function BillsInboxPage() {
  return (
    <Page>
      <PageHeader title="Bills inbox" />
      <RequireOrganisation>{(organisationId) => <BillsInbox key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
