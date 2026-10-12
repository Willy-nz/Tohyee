import type { Metadata } from "next";
import { ClockDevice } from "@/components/clock-device";
import { Page, PageHeader } from "@/components/ui";

export const metadata: Metadata = { title: "Clock in · Tohyee" };

/** The shared clock-in device at the shop (RS5). No sign-in: the device's own cookie is its key. */
export default function ClockPage() {
  return (
    <main style={{ maxWidth: 960, margin: "0 auto", padding: "24px 16px" }}>
      <Page>
        <PageHeader title="Clock in" />
        <ClockDevice />
      </Page>
    </main>
  );
}
