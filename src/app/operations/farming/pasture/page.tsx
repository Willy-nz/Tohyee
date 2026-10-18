"use client";

import { RequireOrganisation } from "@/components/books";
import { PastureHome } from "@/components/pasture";
import { Page, PageHeader } from "@/components/ui";

export default function PasturePage() {
  return (
    <Page>
      <PageHeader title="Pasture and feed" description="Cover readings, each paddock's growth, grazings and supplements fed. Records only: no feed plan or targets." />
      <RequireOrganisation>{(organisationId) => <PastureHome key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
