"use client";

import { RequireOrganisation } from "@/components/books";
import { Notice, Page, PageHeader } from "@/components/ui";
import { WeatherSetupPage } from "@/components/weather-setup";
import { useWorkspace } from "@/components/workspace";

/** Settings › Farm › Weather (MetService): the guided setup (decision 1541). Admins. */
export default function WeatherSettingsPage() {
  const { can } = useWorkspace();
  return (
    <Page>
      <PageHeader title="Weather forecast (MetService)" />
      {can("admin") ? <RequireOrganisation>{(organisationId) => <WeatherSetupPage organisationId={organisationId} />}</RequireOrganisation> : <Notice tone="info">Setting up the weather forecast needs the admin role.</Notice>}
    </Page>
  );
}
