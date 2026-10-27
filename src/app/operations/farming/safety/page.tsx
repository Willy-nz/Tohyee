"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { RequireOrganisation } from "@/components/books";
import { FarmSafetyHome } from "@/components/farm-safety";
import { Page, PageHeader } from "@/components/ui";

/** Farm safety (#446). `?farm=` opens a particular farm. */
function ForFarm() {
  const search = useSearchParams();
  const farm = search.get("farm");
  // `?equipment=` (from a machine's QR code) opens its pre-start check.
  const equipment = search.get("equipment");
  return <RequireOrganisation>{(organisationId) => <FarmSafetyHome key={`${organisationId}:${farm ?? ""}`} organisationId={organisationId} farmId={farm} equipmentId={equipment} />}</RequireOrganisation>;
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
