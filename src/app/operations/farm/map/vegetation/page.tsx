"use client";

import { SatelliteVegetationPage } from "@/components/farm-vegetation";
import { FarmWorkspace } from "@/components/farm-workspace";
import { Page } from "@/components/ui";

/** Farm › Map › Satellite vegetation (#612): the guided setup for owners and admins, every farm's state for everyone. */
export default function SatelliteVegetationRoute() {
  return (
    <Page>
      <FarmWorkspace title="Satellite vegetation">{(context) => <SatelliteVegetationPage organisationId={context.organisationId} />}</FarmWorkspace>
    </Page>
  );
}
