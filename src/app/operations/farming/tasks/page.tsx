"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { FarmTasks } from "@/components/farm-tasks";
import { FarmWorkspace } from "@/components/farm-workspace";
import { Page } from "@/components/ui";

/** Farm team tasks (decisions 1457-1461). `?farm=` opens a farm; `?new=1` opens Add a task. */
function TasksForLink() {
  const params = useSearchParams();
  return <FarmWorkspace title="Tasks" linkedFarmId={params.get("farm")}>{(context) => <FarmTasks {...context} startNew={params.get("new") === "1"} />}</FarmWorkspace>;
}

export default function TasksPage() {
  return (
    <Page>
      <Suspense fallback={null}>
        <TasksForLink />
      </Suspense>
    </Page>
  );
}
