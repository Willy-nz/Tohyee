"use client";

import Link from "next/link";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Field, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { createFarmSelectionStore, resolveSelectedFarm } from "@/lib/client/farm-selection";
import type { Farm } from "@/lib/farming/paddocks";

const selection = createFarmSelectionStore(() => window.sessionStorage);

/**
 * The farm this tab is working on. A link's `?farm=` wins over the remembered
 * choice until the person picks another farm; a link or remembered choice that
 * isn't an active farm here is reported as stale, never swapped for another.
 */
export function useSelectedFarm(organisationId: string, farms: Farm[], linkedFarmId: string | null = null) {
  const { user } = useWorkspace();
  const stored = useSyncExternalStore(selection.subscribe, () => selection.read(user.id, organisationId), () => null);
  const [linked, setLinked] = useState(linkedFarmId);
  const wanted = linked ?? stored;
  const farm = resolveSelectedFarm(farms, wanted);
  const linkedValid = linked !== null && farm !== null;
  useEffect(() => {
    // A valid link becomes the remembered choice, so the other farm pages follow it.
    if (linkedValid && linked !== stored) selection.select(user.id, organisationId, linked);
  }, [linkedValid, linked, stored, user.id, organisationId]);
  return {
    farm,
    stale: farms.length > 0 && wanted !== null && farm === null,
    selectFarm: (farmId: string) => {
      setLinked(null);
      selection.select(user.id, organisationId, farmId);
    },
  };
}

/** A compact, labelled control works for one property or a group of nine or more. */
export function FarmSelector({ farms, farm, stale = false, onChange }: { farms: Farm[]; farm: Farm | null; stale?: boolean; onChange: (id: string) => void }) {
  const active = farms.filter((entry) => entry.isActive);
  // One farm and it's showing: nothing to choose.
  if (!active.length || (active.length === 1 && farm)) return null;
  return (
    <div className={ui.inlineForm}>
      <Field label={`Farm (${active.length})`} hint="Your choice carries across maps, soil, pasture and fertiliser in this tab.">
        <select value={farm?.id ?? ""} onChange={(event) => onChange(event.target.value)}>
          <option value="" disabled>Choose a farm…</option>
          {active.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
        </select>
      </Field>
      <Link href="/operations/farming/compare">Compare all farms</Link>
      {stale ? <Notice tone="warning">The farm you were working on is archived or isn&apos;t in this organisation. Choose a farm.</Notice> : !farm ? <p className={ui.muted}>Choose a farm to view or add its records.</p> : null}
    </div>
  );
}
