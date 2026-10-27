"use client";

import Link from "next/link";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useApiData } from "@/components/hooks";
import { Button, Field, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api } from "@/lib/client/api";
import { createFarmSelectionStore, resolveSelectedFarm } from "@/lib/client/farm-selection";
import type { Farm } from "@/lib/farming/paddocks";

const selection = createFarmSelectionStore(() => window.sessionStorage);

/**
 * The farm this tab is working on. A link's `?farm=` wins over the remembered
 * choice until the person picks another farm; a link or remembered choice that
 * isn't an active farm here is reported as stale, never swapped for another.
 * With nothing chosen in this tab yet, the farm the person last worked on (on
 * any device, decision 900) opens, so a farm page never opens empty when
 * there's a farm to show.
 */
export function useSelectedFarm(organisationId: string, farms: Farm[], linkedFarmId: string | null = null) {
  const { user } = useWorkspace();
  const stored = useSyncExternalStore(selection.subscribe, () => selection.read(user.id, organisationId), () => null);
  const [linked, setLinked] = useState(linkedFarmId);
  const wanted = linked ?? stored;
  const activeCount = farms.filter((entry) => entry.isActive).length;
  // Only asked when there's a real choice and none made in this tab.
  const needLast = wanted === null && activeCount > 1;
  const last = useApiData<{ farmId: string | null }>(needLast ? "/api/farming/last-farm" : null, { organisationId });
  const lastId = last.data?.farmId ?? null;
  const farm = resolveSelectedFarm(farms, wanted, lastId);
  const linkedValid = linked !== null && farm !== null;
  useEffect(() => {
    // A valid link becomes the remembered choice, so the other farm pages follow it.
    if (linkedValid && linked !== stored) {
      selection.select(user.id, organisationId, linked);
      remember(organisationId, linked);
    }
  }, [linkedValid, linked, stored, user.id, organisationId]);
  useEffect(() => {
    // The last farm becomes this tab's choice, so it stays put while this tab works (decision 740).
    if (wanted === null && farm && lastId === farm.id) selection.select(user.id, organisationId, farm.id);
  }, [wanted, farm, lastId, user.id, organisationId]);
  return {
    farm,
    stale: farms.length > 0 && wanted !== null && farm === null,
    /** True while the last farm is being looked up: show nothing rather than "Choose a farm". */
    deciding: needLast && !last.data && !last.error,
    selectFarm: (farmId: string) => {
      setLinked(null);
      selection.select(user.id, organisationId, farmId);
      remember(organisationId, farmId);
    },
  };
}

/** Remembers the choice on the server for next time; failing to is harmless (the tab still has it). */
function remember(organisationId: string, farmId: string) {
  void api("/api/farming/last-farm", { method: "PUT", body: { organisationId, farmId } }).catch(() => undefined);
}

/** A compact, labelled control works for one property or a group of nine or more. */
export function FarmSelector({ farms, farm, stale = false, deciding = false, onChange }: { farms: Farm[]; farm: Farm | null; stale?: boolean; deciding?: boolean; onChange: (id: string) => void }) {
  const active = farms.filter((entry) => entry.isActive);
  // One farm and it's showing: nothing to choose.
  if (!active.length || (active.length === 1 && farm)) return null;
  if (deciding) return <p className={ui.muted}>Opening your farm…</p>;
  // Nothing chosen yet: the farms themselves, big enough to tap, rather than an empty page (decision 900).
  if (!farm && !stale) {
    return (
      <nav aria-label="Choose a farm" className={ui.inlineForm}>
        <p style={{ flexBasis: "100%", margin: 0 }}>Which farm?</p>
        {active.map((entry) => (
          <Button key={entry.id} variant="secondary" onClick={() => onChange(entry.id)}>
            {entry.name}
            <span className={ui.muted} style={{ fontWeight: 400 }}>
              {entry.activePaddocks} paddock{entry.activePaddocks === 1 ? "" : "s"}
            </span>
          </Button>
        ))}
        <Link href="/operations/farming/compare">Compare all farms</Link>
      </nav>
    );
  }
  return (
    <div className={ui.inlineForm}>
      <Field label={`Farm (${active.length})`}>
        <select value={farm?.id ?? ""} onChange={(event) => onChange(event.target.value)}>
          <option value="" disabled>Choose a farm…</option>
          {active.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
        </select>
      </Field>
      <Link href="/operations/farming/compare">Compare all farms</Link>
      {stale ? <Notice tone="warning">The farm you were working on is archived or isn&apos;t in this organisation. Choose a farm.</Notice> : null}
    </div>
  );
}

/** Whether the signed-in person may record farm field work: farm staff (decision 904), or bookkeepers and up. */
export function useCanRecordFarmWork(): boolean {
  const { current, can } = useWorkspace();
  return current?.role === "farm_worker" || can("bookkeeper");
}
