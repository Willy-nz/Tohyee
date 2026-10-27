"use client";

import { useEffect, useMemo, useState } from "react";
import { DateInput } from "@/components/date-input";
import { FarmSelector, useSelectedFarm } from "@/components/farm-selector";
import { type MapOverlay, PaddockMap } from "@/components/farming";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Empty, Field, Notice, ui } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import type { Farm, FarmingSettings, Paddock } from "@/lib/farming/paddocks";
import { formatDate, formatDateTime, todayInBrowser } from "@/lib/format";
import type { SafetyChainReport } from "@/lib/safety/records";
import {
  type CurrentRecord,
  type EmergencyData,
  enteredLate,
  FIXED_NUMBERS,
  HAZARD_LEVEL_LABELS,
  HAZARD_LEVELS,
  type HazardData,
  type HazardLevel,
  hazardState,
  type Position,
  recordFields,
  reviewOverdue,
  type SafetyAccess,
  type SafetyVersion,
  WORKSAFE_NOTIFY_URL,
} from "@/lib/safety/shared";

/*
 * Farm safety (#446): each farm's emergency details (kept on the phone for
 * when there's no signal), its hazards and no-go zones on the map, and the
 * records' history: checking it and the WorkSafe pack. Every change is a
 * new version; nothing is deleted.
 */

type Overview = { hazards: Array<CurrentRecord<HazardData>>; emergency: CurrentRecord<EmergencyData> | null; access: SafetyAccess };

function useRun() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run<T>(action: () => Promise<T>, done?: (result: T) => void) {
    setBusy(true);
    setError(null);
    try {
      done?.(await action());
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run };
}

/** An id for one save, so a retried save is kept once (decision 933). */
export function newOperationId(): string {
  return `op-${typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

function by(record: { enteredByName?: string; enteredByEmail: string }): string {
  return record.enteredByName || record.enteredByEmail;
}

/** "Entered 27 Oct 2026, 2:10 pm by Mere", plus the date it happened when that was earlier (decision 932). */
export function EnteredLine({ record }: { record: Pick<SafetyVersion<unknown>, "enteredAt" | "enteredByEmail" | "enteredByName" | "happenedOn" | "via"> }) {
  const late = enteredLate(record.happenedOn, record.enteredAt);
  return (
    <span className={ui.muted}>
      Entered {formatDateTime(record.enteredAt)} by {by(record)}
      {record.via ? ` (${record.via})` : ""}
      {record.happenedOn ? (late ? `; happened ${formatDate(record.happenedOn)}, entered later` : `; happened ${formatDate(record.happenedOn)}`) : ""}
    </span>
  );
}

/** Every version of a record, oldest first. */
export function SafetyHistory({ organisationId, recordId, paddockNames }: { organisationId: string; recordId: string; paddockNames?: ReadonlyMap<string, string> }) {
  const history = useApiData<{ versions: Array<SafetyVersion<Record<string, unknown>>> }>(`/api/farming/safety/records/${recordId}`, { organisationId });
  if (history.error) return <Notice tone="error">{history.error}</Notice>;
  if (!history.data) return <p className={ui.muted}>Loading history…</p>;
  return (
    <ol style={{ paddingLeft: 20, margin: "8px 0" }} aria-label="Versions, oldest first">
      {history.data.versions.map((version) => (
        <li key={version.seq} style={{ marginBottom: 8 }}>
          <strong>
            Version {version.version}: {version.changeLabel}
          </strong>{" "}
          <EnteredLine record={version} />
          <dl style={{ margin: "4px 0", display: "grid", gridTemplateColumns: "minmax(90px, max-content) 1fr", gap: "2px 12px" }}>
            {recordFields(version.data, paddockNames).map(([label, value]) => (
              <div key={label} style={{ display: "contents" }}>
                <dt className={ui.muted}>{label}</dt>
                <dd style={{ margin: 0, overflowWrap: "anywhere" }}>{value}</dd>
              </div>
            ))}
          </dl>
          <span className={ui.muted} style={{ fontSize: "var(--text-xs)", overflowWrap: "anywhere" }}>
            Entry {version.seq} · hash {version.hash.slice(0, 16)}…
          </span>
        </li>
      ))}
    </ol>
  );
}

// The page ---------------------------------------------------------------------------------------

export function FarmSafetyHome({ organisationId, farmId = null }: { organisationId: string; farmId?: string | null }) {
  const farms = useApiData<{ farms: Farm[] }>("/api/farming/farms", { organisationId });
  const settings = useApiData<{ settings: FarmingSettings }>("/api/farming/settings", { organisationId });
  const { farm, stale, selectFarm } = useSelectedFarm(organisationId, farms.data?.farms ?? [], farmId);
  if (farms.error) return <Notice tone="error">{farms.error}</Notice>;
  if (!farms.data) return <p className={ui.muted}>Loading…</p>;
  const active = farms.data.farms.filter((entry) => entry.isActive);
  if (!active.length) return <Empty>Add your farm first, under Farms and paddocks.</Empty>;
  return (
    <>
      <FarmSelector farms={active} farm={farm} stale={stale} onChange={selectFarm} />
      {farm ? <FarmSafety key={farm.id} organisationId={organisationId} farm={farm} imageryKey={settings.data?.settings.imageryKey ?? null} /> : null}
      <p className={ui.muted}>
        Tohyee keeps these records; it doesn&apos;t decide what the law needs you to keep. Check WorkSafe&apos;s guidance, or ask someone who knows health and safety law.
      </p>
    </>
  );
}

function FarmSafety({ organisationId, farm, imageryKey }: { organisationId: string; farm: Farm; imageryKey: string | null }) {
  const [showWithdrawn, setShowWithdrawn] = useState(false);
  const overview = useApiData<Overview>("/api/farming/safety", { organisationId, farmId: farm.id, includeWithdrawn: showWithdrawn });
  const paddocks = useApiData<{ paddocks: Paddock[] }>(`/api/farming/farms/${farm.id}/paddocks`, { organisationId });
  const paddockNames = useMemo(() => new Map((paddocks.data?.paddocks ?? []).map((paddock) => [paddock.id, paddock.name])), [paddocks.data]);
  return (
    <>
      <EmergencyCard organisationId={organisationId} farm={farm} overview={overview.data} loadError={overview.error} onSaved={overview.reload} />
      {overview.error ? null : !overview.data ? (
        <p className={ui.muted}>Loading…</p>
      ) : (
        <HazardsCard
          organisationId={organisationId}
          farm={farm}
          hazards={overview.data.hazards}
          access={overview.data.access}
          paddocks={paddocks.data?.paddocks ?? []}
          paddockNames={paddockNames}
          imageryKey={imageryKey}
          showWithdrawn={showWithdrawn}
          onShowWithdrawn={setShowWithdrawn}
          onSaved={overview.reload}
        />
      )}
      <RecordsCard organisationId={organisationId} farm={farm} />
    </>
  );
}

// Emergency details ----------------------------------------------------------------------------------

type CachedEmergency = { savedAt: string; farmName: string; emergency: CurrentRecord<EmergencyData> | null };

function cacheKey(organisationId: string, farmId: string) {
  return `tohyee.safety.emergency.${organisationId}.${farmId}`;
}

function readCache(organisationId: string, farmId: string): CachedEmergency | null {
  try {
    const raw = window.localStorage.getItem(cacheKey(organisationId, farmId));
    return raw ? (JSON.parse(raw) as CachedEmergency) : null;
  } catch {
    return null;
  }
}

function writeCache(organisationId: string, farmId: string, value: CachedEmergency) {
  try {
    window.localStorage.setItem(cacheKey(organisationId, farmId), JSON.stringify(value));
  } catch {
    // A phone with no room or private browsing: the details still show while online.
  }
}

/**
 * The farm's emergency details, first on the page. A copy is kept on this
 * phone each time they load, so they still show (with their age) when the
 * server can't be reached (decision 940).
 */
function EmergencyCard({ organisationId, farm, overview, loadError, onSaved }: { organisationId: string; farm: Farm; overview: Overview | null; loadError: string | null; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  // Only read when the server couldn't be reached (an error only comes after the browser asked).
  const cached = useMemo(() => (loadError ? readCache(organisationId, farm.id) : null), [loadError, organisationId, farm.id]);
  useEffect(() => {
    if (overview) writeCache(organisationId, farm.id, { savedAt: new Date().toISOString(), farmName: farm.name, emergency: overview.emergency });
  }, [overview, organisationId, farm.id, farm.name]);
  const emergency = overview ? overview.emergency : (cached?.emergency ?? null);
  const data = emergency?.data;
  const tel = (phone: string) => `tel:${phone.replace(/[^0-9+]/g, "")}`;
  return (
    <Card
      title="In an emergency"
      description={`${farm.name}. Call 111 first if someone is hurt or in danger.`}
      actions={
        <>
          <Button variant="secondary" size="small" onClick={() => window.print()}>
            Print
          </Button>
          {overview?.access.canRecord && !editing ? (
            <Button variant="secondary" size="small" onClick={() => setEditing(true)}>
              {emergency ? "Change" : "Add details"}
            </Button>
          ) : null}
        </>
      }
    >
      {loadError ? (
        cached ? (
          <Notice tone="warning">
            Couldn&apos;t reach Tohyee ({loadError}). Showing the copy saved on this phone {formatDateTime(cached.savedAt)}; it may be out of date.
          </Notice>
        ) : (
          <Notice tone="error">{loadError}</Notice>
        )
      ) : null}
      <ul style={{ listStyle: "none", padding: 0, margin: "0 0 8px", display: "grid", gap: 6 }}>
        {FIXED_NUMBERS.map((number) => (
          <li key={number.phone}>
            <a href={tel(number.phone)} style={{ fontWeight: 700, fontSize: "var(--text-lg, 18px)" }}>
              {number.phone}
            </a>{" "}
            {number.name}
          </li>
        ))}
        {(data?.contacts ?? []).map((contact, index) => (
          <li key={`${contact.phone}-${index}`}>
            <a href={tel(contact.phone)} style={{ fontWeight: 700 }}>
              {contact.phone}
            </a>{" "}
            {contact.name}
            {contact.role ? `, ${contact.role}` : ""}
          </li>
        ))}
      </ul>
      {editing && overview ? (
        <EmergencyForm organisationId={organisationId} farm={farm} current={overview.emergency} onDone={() => { setEditing(false); onSaved(); }} onCancel={() => setEditing(false)} />
      ) : data ? (
        <dl style={{ display: "grid", gridTemplateColumns: "minmax(110px, max-content) 1fr", gap: "4px 12px", margin: 0 }}>
          {(
            [
              ["Address", data.address],
              ["Entrance", data.entrance],
              ["Assembly point", data.assemblyPoint],
              ["First aiders", data.firstAiders.join(", ")],
              ["Equipment", data.equipment.map((item) => `${item.what}: ${item.where}`).join("; ")],
              ["No phone coverage", data.noCoveragePlan],
              ["Medical centre", data.medicalCentre],
              ["Notes", data.notes],
            ] as Array<[string, string | null]>
          )
            .filter(([, value]) => value)
            .map(([label, value]) => (
              <div key={label} style={{ display: "contents" }}>
                <dt className={ui.muted}>{label}</dt>
                <dd style={{ margin: 0, overflowWrap: "anywhere", whiteSpace: "pre-wrap" }}>{value}</dd>
              </div>
            ))}
        </dl>
      ) : !loadError ? (
        <p className={ui.muted}>No emergency details for this farm yet: the address for 111, the entrance, the assembly point, first aiders and where the first aid kit is.</p>
      ) : null}
      {emergency && !editing ? (
        <p style={{ marginBottom: 0 }}>
          <EnteredLine record={emergency} />
        </p>
      ) : null}
      <p className={ui.muted} style={{ marginBottom: 0 }}>
        Someone seriously hurt or killed at work, or a serious near miss, may need to be told to WorkSafe as soon as possible.{" "}
        <a href={WORKSAFE_NOTIFY_URL} target="_blank" rel="noreferrer">
          What WorkSafe needs to be told
        </a>
        .
      </p>
    </Card>
  );
}

function EmergencyForm({ organisationId, farm, current, onDone, onCancel }: { organisationId: string; farm: Farm; current: CurrentRecord<EmergencyData> | null; onDone: () => void; onCancel: () => void }) {
  const start = current?.data;
  const [form, setForm] = useState({
    address: start?.address ?? "",
    entrance: start?.entrance ?? "",
    assemblyPoint: start?.assemblyPoint ?? "",
    contacts: start?.contacts.length ? start.contacts.map((contact) => ({ name: contact.name, role: contact.role ?? "", phone: contact.phone })) : [{ name: "", role: "", phone: "" }],
    firstAiders: start?.firstAiders.join(", ") ?? "",
    equipment: start?.equipment.length ? start.equipment : [{ what: "First aid kit", where: "" }],
    noCoveragePlan: start?.noCoveragePlan ?? "",
    medicalCentre: start?.medicalCentre ?? "",
    notes: start?.notes ?? "",
  });
  const [operationId] = useState(newOperationId);
  const { busy, error, run } = useRun();
  const set = (key: keyof typeof form) => (event: { target: { value: string } }) => setForm({ ...form, [key]: event.target.value });
  const save = () =>
    void run(
      () =>
        api("/api/farming/safety/emergency", {
          method: "POST",
          body: {
            organisationId,
            farmId: farm.id,
            expectedVersion: current?.version,
            operationId,
            ...form,
            firstAiders: form.firstAiders.split(",").map((name) => name.trim()).filter(Boolean),
            contacts: form.contacts.filter((contact) => contact.name || contact.phone),
            equipment: form.equipment.filter((item) => item.what || item.where),
          },
        }),
      onDone,
    );
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Field label="Address" hint="What you'd tell 111, including the road number.">
        <input value={form.address} maxLength={300} onChange={set("address")} autoComplete="street-address" />
      </Field>
      <Field label="Entrance for emergency services" hint="Which gate or road end, and how to find the house or shed.">
        <input value={form.entrance} maxLength={300} onChange={set("entrance")} />
      </Field>
      <Field label="Assembly point">
        <input value={form.assemblyPoint} maxLength={300} onChange={set("assemblyPoint")} />
      </Field>
      <fieldset style={{ border: 0, padding: 0, margin: "8px 0" }}>
        <legend className={ui.fieldLabel}>Contacts</legend>
        {form.contacts.map((contact, index) => (
          <div key={index} className={ui.inlineForm}>
            <Field label={`Name ${index + 1}`}>
              <input value={contact.name} maxLength={100} onChange={(event) => setForm({ ...form, contacts: form.contacts.map((each, at) => (at === index ? { ...each, name: event.target.value } : each)) })} />
            </Field>
            <Field label="Role">
              <input value={contact.role} maxLength={100} onChange={(event) => setForm({ ...form, contacts: form.contacts.map((each, at) => (at === index ? { ...each, role: event.target.value } : each)) })} />
            </Field>
            <Field label="Phone">
              <input type="tel" value={contact.phone} maxLength={40} onChange={(event) => setForm({ ...form, contacts: form.contacts.map((each, at) => (at === index ? { ...each, phone: event.target.value } : each)) })} />
            </Field>
          </div>
        ))}
        {form.contacts.length < 20 ? (
          <Button variant="secondary" size="small" onClick={() => setForm({ ...form, contacts: [...form.contacts, { name: "", role: "", phone: "" }] })}>
            Add a contact
          </Button>
        ) : null}
      </fieldset>
      <Field label="First aiders" hint="Names, separated by commas.">
        <input value={form.firstAiders} maxLength={1000} onChange={set("firstAiders")} />
      </Field>
      <fieldset style={{ border: 0, padding: 0, margin: "8px 0" }}>
        <legend className={ui.fieldLabel}>Emergency equipment</legend>
        {form.equipment.map((item, index) => (
          <div key={index} className={ui.inlineForm}>
            <Field label={`What ${index + 1}`}>
              <input value={item.what} maxLength={100} onChange={(event) => setForm({ ...form, equipment: form.equipment.map((each, at) => (at === index ? { ...each, what: event.target.value } : each)) })} />
            </Field>
            <Field label="Where it is">
              <input value={item.where} maxLength={200} onChange={(event) => setForm({ ...form, equipment: form.equipment.map((each, at) => (at === index ? { ...each, where: event.target.value } : each)) })} />
            </Field>
          </div>
        ))}
        {form.equipment.length < 30 ? (
          <Button variant="secondary" size="small" onClick={() => setForm({ ...form, equipment: [...form.equipment, { what: "", where: "" }] })}>
            Add equipment
          </Button>
        ) : null}
      </fieldset>
      <Field label="Where there's no phone coverage" hint="WorkSafe's guidance for contractors asks for a backup plan, e.g. a radio, check-in times or where the signal is.">
        <textarea value={form.noCoveragePlan} maxLength={2000} rows={3} onChange={set("noCoveragePlan")} />
      </Field>
      <Field label="Nearest medical centre">
        <input value={form.medicalCentre} maxLength={300} onChange={set("medicalCentre")} />
      </Field>
      <Field label="Notes">
        <textarea value={form.notes} maxLength={2000} rows={2} onChange={set("notes")} />
      </Field>
      <div className={ui.actions}>
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </Button>
        <Button variant="secondary" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {current ? <p className={ui.muted}>Saving keeps the earlier version in the history.</p> : null}
    </form>
  );
}

// Hazards ----------------------------------------------------------------------------------------------

function hazardOverlays(hazards: Array<CurrentRecord<HazardData>>, onSelect: (id: string) => void): MapOverlay[] {
  return hazards
    .filter((hazard) => hazardState(hazard) === "active" && (hazard.data.point || hazard.data.zone))
    .map((hazard) => ({
      id: hazard.recordId,
      label: `${hazard.data.noGo ? "No-go: " : ""}${hazard.data.title} (${HAZARD_LEVEL_LABELS[hazard.data.level]})`,
      tone: hazard.data.noGo || hazard.data.level === "high" ? ("danger" as const) : ("warning" as const),
      point: hazard.data.point,
      ring: hazard.data.zone?.coordinates[0] ?? null,
      onSelect: () => onSelect(hazard.recordId),
    }));
}

function HazardBadges({ hazard, today }: { hazard: CurrentRecord<HazardData>; today: string }) {
  const state = hazardState(hazard);
  return (
    <>
      {state === "withdrawn" ? <Badge>Withdrawn</Badge> : state === "removed" ? <Badge tone="green">Removed</Badge> : null}
      {state === "active" && hazard.data.noGo ? <Badge tone="red">No-go</Badge> : null}
      {state === "active" ? <Badge tone={hazard.data.level === "high" ? "red" : hazard.data.level === "medium" ? "amber" : "neutral"}>{HAZARD_LEVEL_LABELS[hazard.data.level]}</Badge> : null}
      {state === "active" && reviewOverdue(hazard.data, today) ? <Badge tone="amber">Review overdue</Badge> : null}
    </>
  );
}

function HazardsCard({
  organisationId,
  farm,
  hazards,
  access,
  paddocks,
  paddockNames,
  imageryKey,
  showWithdrawn,
  onShowWithdrawn,
  onSaved,
}: {
  organisationId: string;
  farm: Farm;
  hazards: Array<CurrentRecord<HazardData>>;
  access: SafetyAccess;
  paddocks: Paddock[];
  paddockNames: ReadonlyMap<string, string>;
  imageryKey: string | null;
  showWithdrawn: boolean;
  onShowWithdrawn: (value: boolean) => void;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [placing, setPlacing] = useState<{ mode: "point" | "zone"; points: Position[] } | null>(null);
  const [formPlace, setFormPlace] = useState<{ point: Position | null; zone: Position[] | null }>({ point: null, zone: null });
  const today = todayInBrowser();
  const active = hazards.filter((hazard) => hazardState(hazard) === "active");
  const other = hazards.filter((hazard) => hazardState(hazard) !== "active");
  const overlays = hazardOverlays(hazards, (id) => {
    setOpen(id);
    document.getElementById(`hazard-${id}`)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  });
  if (formPlace.point) overlays.push({ id: "new-point", label: "The new hazard", tone: "warning", point: formPlace.point });
  if (formPlace.zone && formPlace.zone.length > 3) overlays.push({ id: "new-zone", label: "The new zone", tone: "danger", ring: formPlace.zone });
  const sorted = [...active].sort((a, b) => Number(b.data.noGo) - Number(a.data.noGo) || HAZARD_LEVELS.indexOf(b.data.level) - HAZARD_LEVELS.indexOf(a.data.level));
  return (
    <Card
      title={`Hazards and no-go zones (${active.length})`}
      description="What could hurt someone here and what's done about it. Red is a no-go zone or a high hazard."
      actions={
        access.canRecord && !adding ? (
          <Button size="small" onClick={() => setAdding(true)}>
            Add a hazard
          </Button>
        ) : null
      }
    >
      {placing ? (
        <Notice tone="info">
          {placing.mode === "point" ? "Tap the map where the hazard is." : `Tap the map at each corner of the zone (${placing.points.length} so far), then Finish.`}{" "}
          {placing.mode === "zone" ? (
            <Button
              size="small"
              disabled={placing.points.length < 3}
              onClick={() => {
                setFormPlace({ point: null, zone: [...placing.points, placing.points[0]] });
                setPlacing(null);
              }}
            >
              Finish
            </Button>
          ) : null}{" "}
          <Button variant="secondary" size="small" onClick={() => setPlacing(null)}>
            Stop
          </Button>
        </Notice>
      ) : null}
      <PaddockMap
        paddocks={paddocks}
        selected={null}
        imageryKey={imageryKey}
        overlays={overlays}
        label={`Map of ${farm.name}'s paddocks with ${overlays.length} hazards and zones`}
        drawing={placing ? placing.points : null}
        onMapTap={(position) => {
          if (!placing) return;
          if (placing.mode === "point") {
            setFormPlace({ point: position, zone: null });
            setPlacing(null);
          } else setPlacing({ ...placing, points: [...placing.points, position] });
        }}
      />
      {adding ? (
        <HazardForm
          organisationId={organisationId}
          farm={farm}
          paddocks={paddocks}
          place={formPlace}
          onPlace={(mode) => setPlacing({ mode, points: [] })}
          onClearPlace={() => setFormPlace({ point: null, zone: null })}
          onLocated={(point) => setFormPlace({ point, zone: null })}
          onDone={() => {
            setAdding(false);
            setFormPlace({ point: null, zone: null });
            onSaved();
          }}
          onCancel={() => {
            setAdding(false);
            setFormPlace({ point: null, zone: null });
          }}
        />
      ) : null}
      {!hazards.length ? <Empty>No hazards recorded for this farm yet. Start with the ones that could kill or badly hurt someone: water, power lines, steep ground, machinery, chemicals, bulls.</Empty> : null}
      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {[...sorted, ...other].map((hazard) => (
          <li key={hazard.recordId} id={`hazard-${hazard.recordId}`} style={{ borderTop: "1px solid var(--border)", padding: "10px 0" }}>
            <button type="button" className={ui.linkButton} aria-expanded={open === hazard.recordId} onClick={() => setOpen(open === hazard.recordId ? null : hazard.recordId)} style={{ fontWeight: 600, textAlign: "left" }}>
              {hazard.data.title}
            </button>{" "}
            <HazardBadges hazard={hazard} today={today} />
            {hazard.data.controls ? <div style={{ overflowWrap: "anywhere" }}>{hazard.data.controls}</div> : null}
            <div className={ui.muted} style={{ fontSize: "var(--text-sm)" }}>
              {hazard.data.paddockIds.length ? `${hazard.data.paddockIds.map((id) => paddockNames.get(id) ?? id).join(", ")} · ` : ""}
              {hazard.data.reviewDue ? `review by ${formatDate(hazard.data.reviewDue)} · ` : ""}
              {hazard.version > 1 ? `version ${hazard.version}, ${hazard.changeLabel.toLowerCase()} ${formatDateTime(hazard.enteredAt)} by ${by(hazard)}` : `added ${formatDateTime(hazard.enteredAt)} by ${by(hazard)}`}
            </div>
            {open === hazard.recordId ? <HazardDetail organisationId={organisationId} hazard={hazard} access={access} paddockNames={paddockNames} onSaved={onSaved} /> : null}
          </li>
        ))}
      </ul>
      <label className={ui.checkbox} style={{ marginTop: 8 }}>
        <input type="checkbox" checked={showWithdrawn} onChange={(event) => onShowWithdrawn(event.target.checked)} /> Show hazards withdrawn as mistakes
      </label>
    </Card>
  );
}

function HazardForm({
  organisationId,
  farm,
  paddocks,
  place,
  onPlace,
  onClearPlace,
  onLocated,
  onDone,
  onCancel,
}: {
  organisationId: string;
  farm: Farm;
  paddocks: Paddock[];
  place: { point: Position | null; zone: Position[] | null };
  onPlace: (mode: "point" | "zone") => void;
  onClearPlace: () => void;
  onLocated: (point: Position) => void;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState({ title: "", level: "medium" as HazardLevel, description: "", controls: "", noGo: false, paddockIds: [] as string[], reviewDue: "", identifiedOn: "" });
  const [operationId] = useState(newOperationId);
  const [locating, setLocating] = useState<string | null>(null);
  const { busy, error, run } = useRun();
  const locate = () => {
    if (!navigator.geolocation) return setLocating("This phone or browser can't share its location.");
    setLocating("Finding where you are…");
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLocating(null);
        onLocated([position.coords.longitude, position.coords.latitude]);
      },
      () => setLocating("The location wasn't shared."),
      { enableHighAccuracy: true, timeout: 15_000 },
    );
  };
  const save = () =>
    void run(
      () =>
        api("/api/farming/safety/hazards", {
          method: "POST",
          body: {
            organisationId,
            farmId: farm.id,
            operationId,
            ...form,
            point: place.point,
            zone: place.zone ? { type: "Polygon", coordinates: [place.zone] } : null,
          },
        }),
      onDone,
    );
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
      style={{ margin: "12px 0", padding: 12, border: "1px solid var(--border)", borderRadius: 8 }}
      aria-label="Add a hazard"
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Field label="What the hazard is">
        <input value={form.title} maxLength={150} required onChange={(event) => setForm({ ...form, title: event.target.value })} placeholder="e.g. Power lines over the race" />
      </Field>
      <Field label="How serious">
        <select value={form.level} onChange={(event) => setForm({ ...form, level: event.target.value as HazardLevel })}>
          {HAZARD_LEVELS.map((level) => (
            <option key={level} value={level}>
              {HAZARD_LEVEL_LABELS[level]}
            </option>
          ))}
        </select>
      </Field>
      <label className={ui.checkbox}>
        <input type="checkbox" checked={form.noGo} onChange={(event) => setForm({ ...form, noGo: event.target.checked })} /> No-go zone: nobody goes here
      </label>
      <Field label="What's done about it" hint="Removed, fenced off, signposted, a rule (e.g. helmets on), or watched.">
        <textarea value={form.controls} maxLength={2000} rows={2} onChange={(event) => setForm({ ...form, controls: event.target.value })} />
      </Field>
      <Field label="Details">
        <textarea value={form.description} maxLength={2000} rows={2} onChange={(event) => setForm({ ...form, description: event.target.value })} />
      </Field>
      {paddocks.length ? (
        <fieldset style={{ border: 0, padding: 0, margin: "8px 0" }}>
          <legend className={ui.fieldLabel}>Paddocks</legend>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 14px", maxHeight: 160, overflowY: "auto" }}>
            {paddocks
              .filter((paddock) => paddock.status === "active")
              .map((paddock) => (
                <label key={paddock.id} className={ui.checkbox}>
                  <input
                    type="checkbox"
                    checked={form.paddockIds.includes(paddock.id)}
                    onChange={(event) => setForm({ ...form, paddockIds: event.target.checked ? [...form.paddockIds, paddock.id] : form.paddockIds.filter((id) => id !== paddock.id) })}
                  />{" "}
                  {paddock.name}
                </label>
              ))}
          </div>
        </fieldset>
      ) : null}
      <div className={ui.fieldLabel}>On the map</div>
      <div className={ui.actions} style={{ justifyContent: "flex-start", flexWrap: "wrap" }}>
        <Button variant="secondary" size="small" onClick={locate}>
          Where I am now
        </Button>
        <Button variant="secondary" size="small" onClick={() => onPlace("point")}>
          Tap the map
        </Button>
        <Button variant="secondary" size="small" onClick={() => onPlace("zone")}>
          Draw a zone
        </Button>
        {place.point || place.zone ? (
          <Button variant="secondary" size="small" onClick={onClearPlace}>
            Clear
          </Button>
        ) : null}
      </div>
      <p className={ui.muted}>{locating ?? (place.zone ? "A zone is drawn." : place.point ? "A place is marked." : "Not on the map yet (optional).")}</p>
      <div className={ui.inlineForm}>
        <Field label="Found on" hint="If it was found before today.">
          <DateInput value={form.identifiedOn} onChange={(event) => setForm({ ...form, identifiedOn: event.target.value })} />
        </Field>
        <Field label="Review by">
          <DateInput value={form.reviewDue} onChange={(event) => setForm({ ...form, reviewDue: event.target.value })} />
        </Field>
      </div>
      <div className={ui.actions}>
        <Button type="submit" disabled={busy || !form.title.trim()}>
          {busy ? "Saving…" : "Add hazard"}
        </Button>
        <Button variant="secondary" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

const ACTIONS = {
  reviewed: { label: "Reviewed: still stands", change: "updated", prompt: "What did you check? (optional)", needsWhy: false },
  removed: { label: "Removed from the farm", change: "updated", prompt: "How was it removed?", needsWhy: true },
  corrected: { label: "Correct a mistake", change: "corrected", prompt: "What was wrong?", needsWhy: true },
  withdrawn: { label: "Withdraw (entered by mistake)", change: "withdrawn", prompt: "Why is it withdrawn?", needsWhy: true },
} as const;
type ActionKey = keyof typeof ACTIONS;

function HazardDetail({ organisationId, hazard, access, paddockNames, onSaved }: { organisationId: string; hazard: CurrentRecord<HazardData>; access: SafetyAccess; paddockNames: ReadonlyMap<string, string>; onSaved: () => void }) {
  const [action, setAction] = useState<ActionKey | null>(null);
  const [why, setWhy] = useState("");
  const [fix, setFix] = useState({ title: hazard.data.title, level: hazard.data.level, controls: hazard.data.controls ?? "", reviewDue: hazard.data.reviewDue ?? "" });
  const [operationId, setOperationId] = useState(newOperationId);
  const { busy, error, run } = useRun();
  const state = hazardState(hazard);
  const submit = () => {
    if (!action) return;
    const step = ACTIONS[action];
    const body: Record<string, unknown> = { organisationId, change: step.change, expectedVersion: hazard.version, operationId, why: why || undefined };
    if (action === "reviewed") Object.assign(body, { reviewed: true, reviewDue: fix.reviewDue || null });
    if (action === "removed") body.removed = true;
    if (action === "corrected") Object.assign(body, { title: fix.title, level: fix.level, controls: fix.controls, reviewDue: fix.reviewDue || null });
    void run(
      () => api(`/api/farming/safety/hazards/${hazard.recordId}`, { method: "POST", body }),
      () => {
        setAction(null);
        setWhy("");
        setOperationId(newOperationId());
        onSaved();
      },
    );
  };
  return (
    <div style={{ marginTop: 8 }}>
      {hazard.data.description ? <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{hazard.data.description}</p> : null}
      <p style={{ margin: "4px 0" }}>
        <span className={ui.muted}>
          First added {formatDateTime(hazard.firstEnteredAt)} by {hazard.firstEnteredByName || hazard.firstEnteredByEmail}
        </span>
      </p>
      {access.canRecord && state === "active" ? (
        <div className={ui.actions} style={{ justifyContent: "flex-start", flexWrap: "wrap" }}>
          {(Object.keys(ACTIONS) as ActionKey[]).map((key) => (
            <Button key={key} variant={key === "withdrawn" ? "danger" : "secondary"} size="small" aria-pressed={action === key} onClick={() => setAction(action === key ? null : key)}>
              {ACTIONS[key].label}
            </Button>
          ))}
        </div>
      ) : null}
      {action ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
          style={{ marginTop: 8 }}
        >
          {error ? <Notice tone="error">{error}</Notice> : null}
          {action === "corrected" ? (
            <>
              <Field label="What the hazard is">
                <input value={fix.title} maxLength={150} onChange={(event) => setFix({ ...fix, title: event.target.value })} />
              </Field>
              <Field label="How serious">
                <select value={fix.level} onChange={(event) => setFix({ ...fix, level: event.target.value as HazardLevel })}>
                  {HAZARD_LEVELS.map((level) => (
                    <option key={level} value={level}>
                      {HAZARD_LEVEL_LABELS[level]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="What's done about it">
                <textarea value={fix.controls} rows={2} maxLength={2000} onChange={(event) => setFix({ ...fix, controls: event.target.value })} />
              </Field>
            </>
          ) : null}
          {action === "reviewed" || action === "corrected" ? (
            <Field label="Next review by">
              <DateInput value={fix.reviewDue} onChange={(event) => setFix({ ...fix, reviewDue: event.target.value })} />
            </Field>
          ) : null}
          <Field label={ACTIONS[action].prompt}>
            <textarea value={why} rows={2} maxLength={1000} required={ACTIONS[action].needsWhy} onChange={(event) => setWhy(event.target.value)} />
          </Field>
          <div className={ui.actions}>
            <Button type="submit" variant={action === "withdrawn" ? "danger" : "primary"} disabled={busy || (ACTIONS[action].needsWhy && !why.trim())}>
              {busy ? "Saving…" : "Save"}
            </Button>
          </div>
          <p className={ui.muted}>The earlier version stays in the history; nothing is deleted.</p>
        </form>
      ) : null}
      <details>
        <summary>History</summary>
        <SafetyHistory organisationId={organisationId} recordId={hazard.recordId} paddockNames={paddockNames} />
      </details>
    </div>
  );
}

// Records and checks ------------------------------------------------------------------------------

function RecordsCard({ organisationId, farm }: { organisationId: string; farm: Farm }) {
  const [report, setReport] = useState<(SafetyChainReport & { copy: "found" | "different" | "missing" | null }) | null>(null);
  const [copy, setCopy] = useState({ seq: "", hash: "" });
  const today = todayInBrowser();
  const [range, setRange] = useState({ from: `${today.slice(0, 4)}-01-01`, to: today, scope: "farm" });
  const { busy, error, run } = useRun();
  const check = (withCopy: boolean) =>
    void run(
      () => api<{ report: SafetyChainReport & { copy: "found" | "different" | "missing" | null } }>("/api/farming/safety/check", { query: { organisationId, ...(withCopy ? copy : {}) } }),
      (result) => setReport(result.report),
    );
  const packUrl = `/api/farming/safety/pack?${new URLSearchParams({ organisationId, from: range.from, to: range.to, ...(range.scope === "farm" ? { farmId: farm.id } : {}) }).toString()}`;
  return (
    <Card title="Records that stand up" description="Every safety record is dated by Tohyee when it's entered, never changed or deleted (a change or correction is a new version), and chained by hash, so a change made behind Tohyee's back shows up here.">
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.actions} style={{ justifyContent: "flex-start" }}>
        <Button variant="secondary" disabled={busy} onClick={() => check(false)}>
          {busy ? "Checking…" : "Check the history"}
        </Button>
      </div>
      {report ? (
        report.problems.length ? (
          <Notice tone="error">
            {report.problems.length} problem{report.problems.length === 1 ? "" : "s"} found in {report.total} entries:{" "}
            {report.problemsAt.slice(0, 10).map((problem) => `entry ${problem.seq} (${problem.problem === "hash" ? "details changed" : problem.problem === "link" ? "chain broken" : problem.problem === "missing" ? "entry missing" : "out of order"})`).join("; ")}
            . Someone changed the database directly. Keep the copies sent off the farm and ask your server admin.
          </Notice>
        ) : (
          <Notice tone="success">
            All {report.total} entries check out ({formatDateTime(report.checkedAt)}).
            {report.head ? ` Latest is entry ${report.head.seq}, hash ${report.head.hash.slice(0, 16)}…` : ""}
          </Notice>
        )
      ) : null}
      {report?.copy ? (
        <Notice tone={report.copy === "found" ? "success" : "error"}>
          {report.copy === "found" ? "That copy's entry is still in the history, unchanged." : report.copy === "different" ? "That entry's hash is different now: the history before it has been rewritten." : "That entry number isn't in the history: entries have been removed."}
        </Notice>
      ) : null}
      <details>
        <summary>Compare with a copy kept off the farm</summary>
        <p className={ui.muted}>Enter the entry number and hash from an earlier copy (a weekly email or a WorkSafe pack).</p>
        <div className={ui.inlineForm}>
          <Field label="Entry number">
            <input inputMode="numeric" value={copy.seq} onChange={(event) => setCopy({ ...copy, seq: event.target.value })} />
          </Field>
          <Field label="Hash">
            <input value={copy.hash} spellCheck={false} maxLength={64} onChange={(event) => setCopy({ ...copy, hash: event.target.value })} />
          </Field>
          <Button variant="secondary" disabled={busy || !copy.seq || !copy.hash} onClick={() => check(true)}>
            Compare
          </Button>
        </div>
      </details>
      <h3 style={{ fontSize: "var(--text-md, 16px)", margin: "16px 0 4px" }}>WorkSafe pack</h3>
      <p className={ui.muted} style={{ marginTop: 0 }}>
        Everything entered or dated in a date range, each record with its full history, as a zip: a PDF to read, the records exactly as stored, and a small program that checks them on any computer.
      </p>
      <div className={ui.inlineForm}>
        <Field label="From">
          <DateInput value={range.from} onChange={(event) => setRange({ ...range, from: event.target.value })} />
        </Field>
        <Field label="To">
          <DateInput value={range.to} onChange={(event) => setRange({ ...range, to: event.target.value })} />
        </Field>
        <Field label="Farms">
          <select value={range.scope} onChange={(event) => setRange({ ...range, scope: event.target.value })}>
            <option value="farm">{farm.name}</option>
            <option value="all">All my farms</option>
          </select>
        </Field>
        <a className={`${ui.button} ${ui.secondary}`} href={range.from && range.to ? packUrl : undefined} aria-disabled={!range.from || !range.to} download>
          Download pack
        </a>
      </div>
    </Card>
  );
}
