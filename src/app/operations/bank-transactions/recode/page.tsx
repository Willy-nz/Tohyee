"use client";

import { RequireOrganisation } from "@/components/books";
import { BulkRecode } from "@/components/bank/recode-in-place";
import { Page, PageHeader } from "@/components/ui";

/** Recode several spend and receive money transactions in place (RC6, decision 1587). */
export default function RecodeBankTransactionsPage() {
  return (
    <Page>
      <PageHeader title="Recode bank transactions" />
      <RequireOrganisation>{(organisationId) => <BulkRecode key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
