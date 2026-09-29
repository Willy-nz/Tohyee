"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { RequireOrganisation } from "@/components/books";
import { CustomerStatements } from "@/components/reports/customer-statement";
import { Page, PageHeader } from "@/components/ui";

function Statements() {
  // ?contact= opens a customer's statement straight away (from Contacts).
  const contactId = useSearchParams().get("contact");
  return (
    <RequireOrganisation>
      {(organisationId) => <CustomerStatements key={`${organisationId}:${contactId ?? ""}`} organisationId={organisationId} initialContactId={contactId} />}
    </RequireOrganisation>
  );
}

export default function CustomerStatementsPage() {
  return (
    <Page>
      <PageHeader title="Customer statements" description="Activity or outstanding statements to print or save as PDF." />
      <Suspense fallback={null}>
        <Statements />
      </Suspense>
    </Page>
  );
}
