"use client";

import { ConsolidationGroups } from "@/components/consolidation";
import { Page, PageHeader } from "@/components/ui";

/** Reports › Consolidation (CO1): the groups you can see, and making one. */
export default function ConsolidationPage() {
  return (
    <Page>
      <PageHeader title="Consolidation" />
      <ConsolidationGroups />
    </Page>
  );
}
