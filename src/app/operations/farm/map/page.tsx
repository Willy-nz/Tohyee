"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { AerialPhotosSettings } from "@/components/farm-imagery";
import { FarmMapTab, FarmWorkspace } from "@/components/farm-workspace";
import { Page } from "@/components/ui";

/** The farm Map, with the aerial photo (LINZ key) setup under it for owners and admins (decision 1324). */
function MapWithSetup() {
  const search = useSearchParams();
  const aerial = search.get("aerial") === "1";
  // `?farm=` opens that farm's map (the satellite overview links here, #612).
  return (
    <FarmWorkspace title="Map" linkedFarmId={search.get("farm")}>
      {(context) => (
        <>
          <FarmMapTab {...context} />
          <AerialPhotosSettings organisationId={context.organisationId} open={aerial} />
        </>
      )}
    </FarmWorkspace>
  );
}

export default function FarmMapPage() {
  return (
    <Page>
      <Suspense fallback={null}>
        <MapWithSetup />
      </Suspense>
    </Page>
  );
}
