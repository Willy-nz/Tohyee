"use client";

import Link from "next/link";
import { Suspense } from "react";
import { RequireOrganisation } from "@/components/books";
import { useSearchParams } from "next/navigation";
import { FarmHomeTiles } from "@/components/home/farm-home";
import { HomeTiles } from "@/components/home/home";
import { useModules } from "@/components/modules";
import { Page, PageHeader, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { homeKindFor } from "@/lib/dashboard/defaults";

function Overview({ organisationId }: { organisationId: string }) {
  const { current } = useWorkspace();
  const modules = useModules(organisationId);
  // FH1, decision 660: with Farming on, Home is the farm Home; ?view=business shows the business one.
  const business = useSearchParams().get("view") === "business";
  const farmHome = modules !== null && current !== null && homeKindFor({ role: current.role, farming: modules.farming === true }) === "farming";
  return (
    <>
      <PageHeader title="Home" />
      {modules === null ? null : farmHome && !business ? (
        <FarmHomeTiles organisationId={organisationId} />
      ) : (
        <>
          {modules.farming ? <p className={ui.muted}><Link href="/operations">Back to the farm Home</Link></p> : null}
          <HomeTiles organisationId={organisationId} />
        </>
      )}
    </>
  );
}

export default function OperationsPage() {
  return (
    <Page>
      <Suspense fallback={null}>
        <RequireOrganisation>{(organisationId) => <Overview organisationId={organisationId} />}</RequireOrganisation>
      </Suspense>
    </Page>
  );
}
