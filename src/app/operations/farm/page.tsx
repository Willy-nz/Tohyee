"use client";

import { FarmToday, FarmWorkspace } from "@/components/farm-workspace";
import { Page } from "@/components/ui";

export default function FarmTodayPage() {
  return (
    <Page>
      <FarmWorkspace title="Today">{(context) => <FarmToday {...context} />}</FarmWorkspace>
    </Page>
  );
}
