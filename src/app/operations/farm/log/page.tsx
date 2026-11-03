"use client";

import { Suspense } from "react";
import { FarmLog } from "@/components/farm-log";
import { FarmWorkspace } from "@/components/farm-workspace";
import { Page } from "@/components/ui";

export default function FarmLogPage() {
  return (
    <Page>
      {/* `?record=cover|in|out|feed|walk&paddock=&grazing=` opens a quick log, e.g. from a paddock card. */}
      <Suspense fallback={null}>
        <FarmWorkspace title="Log">{(context) => <FarmLog {...context} />}</FarmWorkspace>
      </Suspense>
    </Page>
  );
}
