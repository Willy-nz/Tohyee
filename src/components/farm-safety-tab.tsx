"use client";

import { Card } from "@/components/ui";
import type { Farm } from "@/lib/farming/paddocks";

/*
 * The Safety tab of the farmer's workspace (#447, decision 910): a stub
 * until farm health and safety (#446) is built, kept in this one file so it
 * can be handed over. #446 replaces both components below with its own
 * (hazards, near misses, inductions); the workspace only imports these two
 * names, with these props.
 */

export function FarmSafetyTab({ farm }: { organisationId: string; farm: Farm }) {
  return (
    <Card title={`Health and safety on ${farm.name}`} description="Coming with farm health and safety (#446).">
      <p>Hazards on the map, near misses and incidents, inductions and checks will be kept here.</p>
    </Card>
  );
}

/** What Today shows from Safety (important hazards and safety jobs). Nothing until #446. */
export function FarmSafetyToday(props: { organisationId: string; farm: Farm }) {
  void props;
  return null;
}
