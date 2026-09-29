"use client";

import { RequireOrganisation } from "@/components/books";
import { ProjectList } from "@/components/projects";
import { Page, PageHeader } from "@/components/ui";

export default function ProjectsPage() {
  return (
    <Page>
      <PageHeader title="Projects" description="Work for customers: tasks, time, expenses, and invoicing what's unbilled." />
      <RequireOrganisation>{(organisationId) => <ProjectList key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
