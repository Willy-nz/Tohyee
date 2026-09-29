"use client";

import { useParams } from "next/navigation";
import { RequireOrganisation } from "@/components/books";
import { ProjectView } from "@/components/projects";
import { Page, PageHeader } from "@/components/ui";

export default function ProjectPage() {
  const { projectId } = useParams<{ projectId: string }>();
  return (
    <Page>
      <PageHeader title="Project" />
      <RequireOrganisation>{(organisationId) => <ProjectView key={`${organisationId}:${projectId}`} organisationId={organisationId} projectId={projectId} />}</RequireOrganisation>
    </Page>
  );
}
