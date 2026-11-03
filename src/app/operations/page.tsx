"use client";

import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { RequireOrganisation } from "@/components/books";
import { useSearchParams } from "next/navigation";
import { FarmHomeTiles } from "@/components/home/farm-home";
import { HomeTiles } from "@/components/home/home";
import { useModules } from "@/components/modules";
import { Page, PageHeader, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { homeKindFor } from "@/lib/dashboard/defaults";

function Overview({ organisationId }: { organisationId: string }) {
  const { current, user } = useWorkspace();
  const modules = useModules(organisationId);
  // FH1, decision 660: with Farming on, Home is the farm Home; ?view=business shows the business one.
  const business = useSearchParams().get("view") === "business";
  const farmHome = modules !== null && current !== null && homeKindFor({ role: current.role, farming: modules.farming === true }) === "farming";
  const [greeting, setGreeting] = useState("Welcome");
  useEffect(() => {
    const update = () => {
      const hour = new Date().getHours();
      setGreeting(hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening");
    };
    update();
    const timer = window.setInterval(update, 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <>
      <PageHeader
        title={`${greeting}, ${user.displayName.trim().split(/\s+/)[0] || user.displayName}`}
      />
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
