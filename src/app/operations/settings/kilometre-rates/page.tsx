"use client";

import { RequireOrganisation } from "@/components/books";
import { KilometreRates } from "@/components/kilometre-rates";
import { Page, PageHeader } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";

/** Settings › Kilometre rates (MI1): the rates mileage on expense claims is paid at. Everyone sees them; admins enter them. */
export default function KilometreRatesPage() {
  const workspace = useWorkspace();
  return (
    <Page>
      <PageHeader title="Kilometre rates" description="IRD's kilometre rates for mileage on expense claims, per income year and vehicle type." />
      <RequireOrganisation>
        {(organisationId) => <KilometreRates key={organisationId} organisationId={organisationId} canEdit={workspace.can("admin")} />}
      </RequireOrganisation>
    </Page>
  );
}
