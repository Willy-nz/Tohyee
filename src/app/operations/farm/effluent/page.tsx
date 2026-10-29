"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { FarmEffluent } from "@/components/farm-effluent";
import { FarmWorkspace } from "@/components/farm-workspace";
import { Page, PageHeader } from "@/components/ui";
import { readEffluentLink } from "@/lib/effluent/screens";

/**
 * Effluent (#487, decision 1070): under More, with its daily jobs on Today
 * and the Log. `?view=` chooses the screen, `?farm=` the farm and
 * `?record=` the record to open.
 */
function EffluentForLink() {
  const link = readEffluentLink(useSearchParams());
  return (
    <FarmWorkspace linkedFarmId={link.farmId}>
      {(context) => <FarmEffluent organisationId={context.organisationId} farm={context.farm} link={link} />}
    </FarmWorkspace>
  );
}

export default function FarmEffluentPage() {
  return (
    <Page>
      <PageHeader title="Effluent" />
      <Suspense fallback={null}>
        <EffluentForLink />
      </Suspense>
    </Page>
  );
}
