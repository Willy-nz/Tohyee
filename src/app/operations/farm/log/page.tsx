"use client";

import { Suspense } from "react";
import { FarmLog } from "@/components/farm-log";
import { FarmWorkspace } from "@/components/farm-workspace";
import { Page, PageHeader } from "@/components/ui";

export default function FarmLogPage() {
  return (
    <Page>
      <PageHeader title="Log" />
      {/* `?record=cover|in|out|feed|walk&paddock=&grazing=` opens a quick log, e.g. from a paddock card. */}
      <Suspense fallback={null}>
        <FarmWorkspace>{(context) => <FarmLog {...context} />}</FarmWorkspace>
      </Suspense>
    </Page>
  );
}
