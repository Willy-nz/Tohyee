"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { RequireOrganisation } from "@/components/books";
import { FertiliserHome } from "@/components/fertiliser";
import { Page, PageHeader } from "@/components/ui";

function ForPlan() {
  const plan = useSearchParams().get("plan");
  return <RequireOrganisation>{(organisationId) => <FertiliserHome key={`${organisationId}-${plan ?? ""}`} organisationId={organisationId} planId={plan} />}</RequireOrganisation>;
}

export default function FertiliserPage() {
  return (
    <Page>
      <PageHeader title="Fertiliser plans" description="Plan what goes on each paddock, link the bills that bought and spread it, and compare the plan with what was applied." />
      <Suspense fallback={null}>
        <ForPlan />
      </Suspense>
    </Page>
  );
}
