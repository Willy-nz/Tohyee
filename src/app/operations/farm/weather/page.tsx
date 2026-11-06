"use client";

import { FarmWorkspace } from "@/components/farm-workspace";
import { Page } from "@/components/ui";
import { WeatherPage } from "@/components/weather-forecast";

export default function FarmWeatherPage() {
  return (
    <Page>
      <FarmWorkspace title="Weather">{(context) => <WeatherPage organisationId={context.organisationId} farm={context.farm} />}</FarmWorkspace>
    </Page>
  );
}
