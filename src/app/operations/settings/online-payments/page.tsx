"use client";

import { RequireOrganisation } from "@/components/books";
import { OnlinePaymentsSettings } from "@/components/online-payments";
import { Page, PageHeader } from "@/components/ui";

/** Settings › Online payments (PN1, PN10, PN11). Everyone sees it; admins turn it on and off. */
export default function OnlinePaymentsPage() {
  return (
    <Page>
      <PageHeader title="Online payments" description="Let customers pay invoices online through your own Stripe or PayPal account." />
      <RequireOrganisation>{(organisationId) => <OnlinePaymentsSettings key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
