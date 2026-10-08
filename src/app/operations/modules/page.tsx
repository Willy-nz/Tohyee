"use client";

import { RequireOrganisation } from "@/components/books";
import { ModulesCard } from "@/components/modules";
import { Page, PageHeader } from "@/components/ui";

/** Modules (#181, MOD2): reachable from every app's account menu, and works with Accounting off. */
export default function ModulesPage() {
  return (
    <Page>
      <PageHeader title="Modules" description="Which apps this organisation uses. Turning one off hides it; anything entered is kept." />
      <RequireOrganisation>{(organisationId) => <ModulesCard key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
