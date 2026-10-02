"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { RequireOrganisation } from "@/components/books";
import { FixedAssetForm } from "@/components/fixed-assets";
import { Card, Notice, Page, PageHeader } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";

function NewFixedAsset({ organisationId }: { organisationId: string }) {
  const { can } = useWorkspace();
  const router = useRouter();
  const billLine = useSearchParams().get("billLine") ?? undefined;
  if (!can("bookkeeper")) return <Notice tone="info">Only bookkeepers and admins can register assets.</Notice>;
  return (
    <Card title="Register an asset">
      <FixedAssetForm
        organisationId={organisationId}
        initialBillLineId={billLine}
        onSaved={(asset) => router.push(`/operations/fixed-assets/${asset.id}`)}
        onCancel={() => router.push("/operations/fixed-assets")}
      />
    </Card>
  );
}

export default function NewFixedAssetPage() {
  return (
    <Page>
      <PageHeader title="New fixed asset" description="Registering records the asset's cost; it posts nothing, since the cost is already in the ledger from its bill or journal." />
      <Suspense>
        <RequireOrganisation>{(organisationId) => <NewFixedAsset organisationId={organisationId} />}</RequireOrganisation>
      </Suspense>
    </Page>
  );
}
