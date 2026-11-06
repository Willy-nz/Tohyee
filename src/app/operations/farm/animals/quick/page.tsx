"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { FarmQuickEntry } from "@/components/farm-quick-entry";
import { FarmWorkspace } from "@/components/farm-workspace";
import { Page } from "@/components/ui";

/** Quick entry in the yards (decision 1486): tag, score and/or weight, next. `?farm=` and `?mob=`. */
function QuickEntry() {
  const params = useSearchParams();
  return <FarmWorkspace title="Quick entry" linkedFarmId={params.get("farm")}>{(context) => <FarmQuickEntry {...context} mobId={params.get("mob")} />}</FarmWorkspace>;
}

export default function FarmQuickEntryPage() {
  return (
    <Page>
      <Suspense fallback={null}>
        <QuickEntry />
      </Suspense>
    </Page>
  );
}
