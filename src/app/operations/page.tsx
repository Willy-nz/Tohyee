"use client";

import { useEffect, useState } from "react";
import { RequireOrganisation } from "@/components/books";
import { HomeTiles } from "@/components/home/home";
import { useApiData } from "@/components/hooks";
import { Page, PageHeader } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { financialYearEnd } from "@/lib/financial-year";
import { formatDate, todayInBrowser } from "@/lib/format";
import type { OrganisationSettings } from "@/lib/organisations/settings";

function Overview({ organisationId }: { organisationId: string }) {
  const { current, user } = useWorkspace();
  const settings = useApiData<{ settings: OrganisationSettings }>(`/api/organisations/${organisationId}/settings`);
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
  const yearEnd = settings.data ? financialYearEnd(todayInBrowser(), settings.data.settings.financialYearEndMonth) : null;
  return (
    <>
      <PageHeader
        title={`${greeting}, ${user.displayName.trim().split(/\s+/)[0] || user.displayName}`}
        description={<>{current?.displayName}{yearEnd ? ` · Financial year ending ${formatDate(yearEnd)}` : ""}</>}
      />
      <HomeTiles organisationId={organisationId} />
    </>
  );
}

export default function OperationsPage() {
  return (
    <Page>
      <RequireOrganisation>{(organisationId) => <Overview organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
