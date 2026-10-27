"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { RequireOrganisation } from "@/components/books";
import { FarmSafetyHome } from "@/components/farm-safety";
import { Page, PageHeader } from "@/components/ui";

/** Farm safety (#446). `?farm=` opens a particular farm. */
function ForFarm() {
  const farm = useSearchParams().get("farm");
  return <RequireOrganisation>{(organisationId) => <FarmSafetyHome key={`${organisationId}:${farm ?? ""}`} organisationId={organisationId} farmId={farm} />}</RequireOrganisation>;
}

export default function FarmSafetyPage() {
  return (
    <Page>
      <PageHeader title="Safety" description="Emergency details, hazards and no-go zones, kept as records that can't be quietly changed." />
      <Suspense fallback={null}>
        <ForFarm />
      </Suspense>
    </Page>
  );
}
