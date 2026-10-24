"use client";

import { DemoFarmCard } from "@/components/demo-farm";
import { Page, PageHeader } from "@/components/ui";

/** The demo farm (#437): add it, follow it being made, open, reset or delete it. Anyone signed in. */
export default function DemoFarmPage() {
  return (
    <Page>
      <PageHeader title="Demo farm" description="Kōwhai Dairies Ltd: a made-up Otago dairy farm with about 18 months of books, farm records and Analytics, to try Tohyee on." />
      <DemoFarmCard />
    </Page>
  );
}
