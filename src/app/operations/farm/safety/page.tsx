"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { FarmSafetyTab } from "@/components/farm-safety-tab";
import { FarmWorkspace } from "@/components/farm-workspace";
import { Page, PageHeader } from "@/components/ui";
import { readSafetyLink } from "@/lib/safety/screens";

/**
 * Safety (#446): the overview, or a focused screen. `?view=` chooses the
 * screen, `?farm=` the farm, and `?hazard=`, `?report=`, `?action=`,
 * `?equipment=` (a machine's QR code), `?induction=`, `?training=` or
 * `?visit=` the record to open (decisions 976-989).
 */
function SafetyForLink() {
  const link = readSafetyLink(useSearchParams());
  return (
    <FarmWorkspace linkedFarmId={link.farmId}>
      {(context) => <FarmSafetyTab {...context} link={link} />}
    </FarmWorkspace>
  );
}

export default function FarmSafetyPage() {
  return (
    <Page>
      <PageHeader title="Safety" />
      <Suspense fallback={null}>
        <SafetyForLink />
      </Suspense>
    </Page>
  );
}
