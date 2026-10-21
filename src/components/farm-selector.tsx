"use client";

import { useSyncExternalStore } from "react";
import { Field, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { createFarmSelectionStore, resolveSelectedFarm } from "@/lib/client/farm-selection";
import type { Farm } from "@/lib/farming/paddocks";

const selection = createFarmSelectionStore(() => window.sessionStorage);

export function useSelectedFarm(organisationId: string, farms: Farm[]) {
  const { user } = useWorkspace();
  const id = useSyncExternalStore(selection.subscribe, () => selection.read(user.id, organisationId), () => null);
  return {
    farm: resolveSelectedFarm(farms, id),
    selectFarm: (farmId: string) => selection.select(user.id, organisationId, farmId),
  };
}

/** A compact, labelled control works for one property or a group of nine or more. */
export function FarmSelector({ farms, farm, onChange }: { farms: Farm[]; farm: Farm | null; onChange: (id: string) => void }) {
  const active = farms.filter((entry) => entry.isActive);
  if (!active.length) return null;
  return (
    <div className={ui.inlineForm}>
      <Field label={`Farm (${active.length})`} hint="Your choice carries across maps, soil, pasture and fertiliser in this tab.">
        <select value={farm?.id ?? ""} onChange={(event) => onChange(event.target.value)}>
          <option value="" disabled>Choose a farm…</option>
          {active.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
        </select>
      </Field>
      {!farm ? <p className={ui.muted}>Choose a farm to view or add its records.</p> : null}
    </div>
  );
}
