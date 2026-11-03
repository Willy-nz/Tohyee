"use client";

import { useRouter } from "next/navigation";
import { Suspense } from "react";
import { OrganisationActions, RequireOrganisation } from "@/components/books";
import { PipelinePage, RequireCrm } from "@/components/crm";
import { Button, Page, PageHeader } from "@/components/ui";

export default function CrmPipelinePage() {
  const router = useRouter();
  return (
    <Page>
      <PageHeader
        title="Pipeline"
        actions={
          <OrganisationActions>
            {({ canCrm }) => (canCrm("write") ? <Button onClick={() => router.replace("/crm/pipeline?new=1", { scroll: false })}>New opportunity</Button> : null)}
          </OrganisationActions>
        }
      />
      <Suspense fallback={null}>
        <RequireOrganisation>
          {(organisationId) => (
            <RequireCrm organisationId={organisationId}>
              <PipelinePage key={organisationId} organisationId={organisationId} />
            </RequireCrm>
          )}
        </RequireOrganisation>
      </Suspense>
    </Page>
  );
}
