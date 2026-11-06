"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { FarmTimeline } from "@/components/farm-timeline";
import { FarmWorkspace } from "@/components/farm-workspace";
import { Page } from "@/components/ui";

/** The farm's timeline (decisions 1445-1446). `?farm=`, `?mob=` and `?paddock=` open it filtered. */
function Timeline() {
  const params = useSearchParams();
  return (
    <FarmWorkspace title="Farm timeline" linkedFarmId={params.get("farm")}>
      {(context) => <FarmTimeline {...context} mobId={params.get("mob")} paddockId={params.get("paddock")} />}
    </FarmWorkspace>
  );
}

export default function FarmTimelinePage() {
  return (
    <Page>
      <Suspense fallback={null}>
        <Timeline />
      </Suspense>
    </Page>
  );
}
