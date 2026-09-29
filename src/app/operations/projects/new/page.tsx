"use client";

import { useRouter } from "next/navigation";
import { RequireOrganisation } from "@/components/books";
import { ProjectEditor } from "@/components/projects";
import { Card, Notice, Page, PageHeader } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";

function NewProject({ organisationId }: { organisationId: string }) {
  const { can } = useWorkspace();
  const router = useRouter();
  if (!can("bookkeeper")) return <Notice tone="info">Only bookkeepers and admins can start projects.</Notice>;
  return (
    <Card title="New project">
      <ProjectEditor
        organisationId={organisationId}
        onSaved={(project) => router.push(`/operations/projects/${project.id}`)}
        onCancel={() => router.push("/operations/projects")}
      />
    </Card>
  );
}

export default function NewProjectPage() {
  return (
    <Page>
      <PageHeader title="New project" description="A project is work for one customer. Add its tasks after saving it." />
      <RequireOrganisation>{(organisationId) => <NewProject organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
