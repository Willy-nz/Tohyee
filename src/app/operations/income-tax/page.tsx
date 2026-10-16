"use client";

import { RequireOrganisation } from "@/components/books";
import { IncomeTaxView } from "@/components/income-tax";
import { Page, PageHeader } from "@/components/ui";

export default function IncomeTaxPage() {
  return (
    <Page>
      <PageHeader title="Income tax" description="Taxable income from the books, provisional tax, end-of-year tax and when they're due." />
      <RequireOrganisation>{(organisationId) => <IncomeTaxView key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
