"use client";

import { useRouter } from "next/navigation";
import { Suspense } from "react";
import { OrganisationActions, RequireOrganisation } from "@/components/books";
import { PipelinePage, RequireCrm } from "@/components/crm";
import { useModules } from "@/components/modules";
import { Button, Page, PageHeader } from "@/components/ui";

/** Only while the CRM is on: with it off, the page says so instead. */
function NewOpportunityButton({ organisationId, onClick }: { organisationId: string; onClick: () => void }) {
  const modules = useModules(organisationId);
  return modules?.crm ? <Button onClick={onClick}>New opportunity</Button> : null;
}

export default function CrmPipelinePage() {
  const router = useRouter();
  return (
    <Page>
      <PageHeader
        title="Pipeline"
        actions={
          <OrganisationActions>
            {({ canCrm, current }) => (canCrm("write") && current ? <NewOpportunityButton organisationId={current.id} onClick={() => router.replace("/crm/pipeline?new=1", { scroll: false })} /> : null)}
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
