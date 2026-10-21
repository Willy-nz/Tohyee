"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { RequireOrganisation } from "@/components/books";
import { FertiliserHome } from "@/components/fertiliser";
import { Page, PageHeader } from "@/components/ui";

function ForPlan() {
  const params = useSearchParams();
  const plan = params.get("plan");
  const farm = params.get("farm");
  return <RequireOrganisation>{(organisationId) => <FertiliserHome key={`${organisationId}-${plan ?? ""}-${farm ?? ""}`} organisationId={organisationId} planId={plan} farmId={farm} />}</RequireOrganisation>;
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
