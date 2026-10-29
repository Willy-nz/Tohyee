"use client";

import Link from "next/link";
import { type ReactNode, useState } from "react";
import { DateInput } from "@/components/date-input";
import { ChecksScreen, IncidentsScreen, PackScreen, ReminderList, useEffluentCare } from "@/components/farm-effluent-care";
import { LogScreen, PondsScreen, useEffluentLog } from "@/components/farm-effluent-log";
import { newOperationId, SafetyHistory } from "@/components/farm-safety";
import { type MapOverlay, PaddockMap } from "@/components/farming";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Empty, Field, Notice, ui } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { EFFLUENT_SCREEN_TITLES, type EffluentLink, type EffluentScreen, effluentHref } from "@/lib/effluent/screens";
import type { EffluentSetup, SystemView } from "@/lib/effluent/setup";
import {
  activeConsent,
  type BlockData,
  bufferFor,
  bufferRing,
  CHECK_EVERY,
  CHECK_EVERY_LABELS,
  CHECK_YOUR_CONSENT,
  type CheckEvery,
  CONSENT_TEMPLATES,
  type ConsentData,
  type Council,
  COUNCIL_LABELS,
  COUNCILS,
  DAIRYNZ_GUIDES,
  POND_KIND_LABELS,
  POND_KINDS,
  type PondData,
  type PondKind,
  RISK_LABELS,
  RISK_LEVELS,
  SETTING_LABELS,
  SETTINGS_FOR,
  type SystemSettings,
  SYSTEM_TYPE_LABELS,
  SYSTEM_TYPES,
  type SystemType,
  ZONE_FEATURE_LABELS,
  ZONE_FEATURES,
  type ZoneData,
  type ZoneFeature,
} from "@/lib/effluent/shared";
import type { Farm, FarmingSettings, Paddock } from "@/lib/farming/paddocks";
import { formatDate, formatDateTime } from "@/lib/format";
import type { CurrentRecord, Position } from "@/lib/safety/shared";
import { safetyHref } from "@/lib/safety/screens";
import styles from "./farm-safety.module.css";

/*
 * Effluent in the farmer's workspace (#487, decisions 1070-1079): Farm ›
 * More › Effluent, an overview and focused screens with their own
 * addresses (like Safety). This part is the setup: systems linked to
 * Safety's equipment, ponds and sumps, effluent blocks and no-apply zones
 * on the map, and the consent conditions with a starting template per
 * council. Later parts add the daily log, ponds, checks, incidents and the
 * council pack.
 */

export type EffluentContext = { organisationId: string; farm: Farm };

export function useEffluentSetup(organisationId: string, farmId: string, includeWithdrawn = false) {
  return useApiData<EffluentSetup>("/api/farming/effluent", { organisationId, farmId, includeWithdrawn });
}

function usePaddocks(organisationId: string, farmId: string) {
  return useApiData<{ paddocks: Paddock[] }>(`/api/farming/farms/${farmId}/paddocks`, { organisationId });
}

function useImageryKey(organisationId: string) {
  return useApiData<{ settings: FarmingSettings }>("/api/farming/settings", { organisationId }).data?.settings.imageryKey ?? null;
}

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

/** Effluent: the overview, or the screen the link asks for. */
export function FarmEffluent({ organisationId, farm, link }: EffluentContext & { link: EffluentLink }) {
  if (!link.screen) return <EffluentOverview organisationId={organisationId} farm={farm} />;
  return (
    <EffluentScreenFrame farm={farm} screen={link.screen}>
      {link.screen === "setup" ? (
        <SetupScreen organisationId={organisationId} farm={farm} />
      ) : link.screen === "log" ? (
        <LogScreen organisationId={organisationId} farm={farm} />
      ) : link.screen === "ponds" ? (
        <PondsScreen organisationId={organisationId} farm={farm} />
      ) : link.screen === "checks" ? (
        <ChecksScreen organisationId={organisationId} farm={farm} />
      ) : link.screen === "incidents" ? (
        <IncidentsScreen organisationId={organisationId} farm={farm} />
      ) : link.screen === "pack" ? (
        <PackScreen organisationId={organisationId} farm={farm} />
      ) : (
        <Notice tone="info">This part of Effluent isn&apos;t built yet.</Notice>
      )}
    </EffluentScreenFrame>
  );
}

export function EffluentScreenFrame({ farm, screen, children }: { farm: Farm; screen: EffluentScreen; children: ReactNode }) {
  return (
    <div className={styles.screen}>
      <div>
        <Link className={styles.back} href={effluentHref({ farmId: farm.id })}>
          <span aria-hidden="true">‹</span> Back to Effluent
        </Link>
      </div>
      <div className={styles.screenHead}>
        <h2>{EFFLUENT_SCREEN_TITLES[screen]}</h2>
        <span className={ui.muted}>{farm.name}</span>
      </div>
      {children}
    </div>
  );
}

// Overview -----------------------------------------------------------------------------------------------

function EffluentOverview({ organisationId, farm }: EffluentContext) {
  const setup = useEffluentSetup(organisationId, farm.id);
  const log = useEffluentLog(organisationId, farm.id);
  const data = setup.data;
  const systems = (data?.systems ?? []).filter((system) => !system.data.retired);
  const consent = data ? activeConsent(data.consents) : null;
  const care = useEffluentCare(organisationId, farm.id);
  const running = (log.data?.applications ?? []).filter((application) => application.running);
  const openIncidents = (care.data?.incidents ?? []).filter((incident) => incident.state === "open" || incident.state === "actions");
  const ponds = log.data?.ponds ?? [];
  return (
    <div className={styles.overview}>
      <div className={styles.column}>
        {setup.error ? <Notice tone="error">{setup.error}</Notice> : null}
        {data?.access.canLog && systems.length ? (
          <nav aria-label="Everyday effluent" className={styles.bigActions}>
            <Link className={styles.bigAction} href={effluentHref({ farmId: farm.id, screen: "log" })}>
              <span className={styles.icon} aria-hidden="true">+</span>
              <span>
                Irrigation
                <small>{running.length ? `${running.length} running: shift or stop` : "Start or record a run"}</small>
              </span>
            </Link>
            <Link className={styles.bigAction} href={effluentHref({ farmId: farm.id, screen: "incidents" })}>
              <span className={styles.icon} aria-hidden="true">!</span>
              <span>
                Incident
                <small>Spill, ponding, runoff, a failure</small>
              </span>
            </Link>
            <Link className={styles.bigAction} href={effluentHref({ farmId: farm.id, screen: "ponds" })}>
              <span className={styles.icon} aria-hidden="true">≋</span>
              <span>
                Pond level
                <small>{ponds.some((pond) => pond.latest?.state.warning === "high") ? "A pond is high" : ponds.length && ponds.every((pond) => pond.readToday) ? "Read today" : "Read the gauge"}</small>
              </span>
            </Link>
          </nav>
        ) : null}
        {care.data && systems.length ? (
          <Card title="Needs doing">
            <ReminderList farm={farm} reminders={care.data.reminders} />
          </Card>
        ) : null}
        {ponds.length ? (
          <Card title="Ponds and sumps">
            <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {ponds.map((pond) => (
                <li key={pond.recordId} style={{ borderTop: "1px solid var(--border)", padding: "8px 0" }}>
                  <strong>{pond.data.name}</strong>{" "}
                  {pond.latest ? (
                    <>
                      {pond.latest.data.levelMm} mm{pond.latest.state.percentFull ? `, about ${pond.latest.state.percentFull}% full` : ""}
                      {pond.latest.state.daysLeft ? `, about ${pond.latest.state.daysLeft} days of storage left` : ""}{" "}
                      {pond.latest.state.warning === "high" ? <Badge tone="red">High</Badge> : pond.latest.state.warning === "low" ? <Badge tone="amber">Low</Badge> : null}
                    </>
                  ) : (
                    <span className={ui.muted}>no reading yet</span>
                  )}{" "}
                  {!pond.readToday ? <Badge tone="amber">Not read today</Badge> : null}
                </li>
              ))}
            </ul>
          </Card>
        ) : null}
        <SystemsSummary farm={farm} systems={systems} loading={!data} />
        <ConsentSummary farm={farm} consent={consent} loading={!data} canManage={Boolean(data?.access.canManage)} />
      </div>
      <div className={styles.column}>
        <Card title="Effluent on this farm">
          <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 6 }}>
            <li>
              <Link href={effluentHref({ farmId: farm.id, screen: "log" })}>{EFFLUENT_SCREEN_TITLES.log}</Link>
              <span className={ui.muted}> · {log.data ? `${log.data.summary.applications} runs in the last 30 days` : "…"}</span>
            </li>
            <li>
              <Link href={effluentHref({ farmId: farm.id, screen: "ponds" })}>{EFFLUENT_SCREEN_TITLES.ponds}</Link>
              <span className={ui.muted}> · levels, storage left and days not applied</span>
            </li>
            <li>
              <Link href={effluentHref({ farmId: farm.id, screen: "checks" })}>{EFFLUENT_SCREEN_TITLES.checks}</Link>
              <span className={ui.muted}> · {care.data ? `${care.data.systems.filter((system) => !system.available && !system.data.retired).length} out of use` : "…"}</span>
            </li>
            <li>
              <Link href={effluentHref({ farmId: farm.id, screen: "incidents" })}>{EFFLUENT_SCREEN_TITLES.incidents}</Link>
              <span className={ui.muted}> · {care.data ? `${openIncidents.length} open` : "…"}</span>
            </li>
            {data?.access.farmStaff ? null : (
              <li>
                <Link href={effluentHref({ farmId: farm.id, screen: "pack" })}>{EFFLUENT_SCREEN_TITLES.pack}</Link>
                <span className={ui.muted}> · download the records for the council</span>
              </li>
            )}
            <li>
              <Link href={effluentHref({ farmId: farm.id, screen: "setup" })}>{EFFLUENT_SCREEN_TITLES.setup}</Link>
              <span className={ui.muted}>
                {" "}
                · {data ? `${systems.length} system${systems.length === 1 ? "" : "s"}, ${data.ponds.filter((pond) => !pond.data.retired).length} ponds or sumps, ${data.blocks.filter((block) => !block.data.retired).length} blocks, ${data.zones.filter((zone) => !zone.data.removed).length} no-apply zones` : "…"}
              </span>
            </li>
          </ul>
          <p className={ui.muted}>
            Effluent records are kept like safety records: dated by Tohyee when they&apos;re entered, never changed or deleted, with corrections marked. Tohyee keeps the records; it doesn&apos;t decide what your consent needs, and it never sends anything to the council.
          </p>
        </Card>
      </div>
    </div>
  );
}

function SystemsSummary({ farm, systems, loading }: { farm: Farm; systems: SystemView[]; loading: boolean }) {
  return (
    <Card title="Systems" description={systems.length ? "Out of use after a failed critical check, until someone allowed releases it in Safety." : undefined}>
      {loading ? <p className={ui.muted}>Loading…</p> : null}
      {!loading && !systems.length ? <p>No effluent systems yet. An owner or admin adds them under {EFFLUENT_SCREEN_TITLES.setup}.</p> : null}
      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {systems.map((system) => (
          <li key={system.recordId} style={{ borderTop: "1px solid var(--border)", padding: "8px 0" }}>
            <strong>{system.data.name}</strong> <span className={ui.muted}>{SYSTEM_TYPE_LABELS[system.data.type]}</span>{" "}
            {system.available ? <Badge tone="green">In use</Badge> : <Badge tone="red">Out of use</Badge>}
            {!system.available ? (
              <div>
                {system.outOfUseBecause}.{" "}
                <Link href={safetyHref({ farmId: farm.id, screen: "equipment", equipment: system.data.equipmentId })}>Open in Safety</Link>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function ConsentSummary({ farm, consent, loading, canManage }: { farm: Farm; consent: CurrentRecord<ConsentData> | null; loading: boolean; canManage: boolean }) {
  if (loading) return null;
  return (
    <Card title="Consent conditions" description={consent ? `${consent.data.title}${consent.data.consentNumber ? `, ${consent.data.consentNumber}` : ""}` : undefined}>
      {!consent ? (
        <p>
          No consent conditions entered yet. {canManage ? <Link href={effluentHref({ farmId: farm.id, screen: "setup" })}>Enter them from your consent</Link> : "An owner or admin enters them from the farm's consent."}
        </p>
      ) : (
        <>
          <ConsentFacts consent={consent.data} />
          {consent.data.fromTemplate.length ? <Notice tone="warning">{CHECK_YOUR_CONSENT}</Notice> : null}
        </>
      )}
    </Card>
  );
}

function ConsentFacts({ consent }: { consent: ConsentData }) {
  const none = "Not entered";
  return (
    <dl style={{ display: "grid", gridTemplateColumns: "minmax(0, 9em) minmax(0, 1fr)", gap: "4px 12px", margin: 0 }}>
      <dt className={ui.muted}>Council</dt>
      <dd style={{ margin: 0 }}>{COUNCIL_LABELS[consent.council]}</dd>
      <dt className={ui.muted}>Expires</dt>
      <dd style={{ margin: 0 }}>{consent.expiresOn ? formatDate(consent.expiresOn) : none}</dd>
      <dt className={ui.muted}>Most depth</dt>
      <dd style={{ margin: 0 }}>{consent.maxDepthMm ? `${consent.maxDepthMm} mm` : none}</dd>
      <dt className={ui.muted}>Most rate</dt>
      <dd style={{ margin: 0 }}>{consent.maxRateMmPerHour ? `${consent.maxRateMmPerHour} mm an hour` : none}</dd>
      <dt className={ui.muted}>Between applications</dt>
      <dd style={{ margin: 0 }}>{consent.returnPeriodDays ? `at least ${consent.returnPeriodDays} days` : none}</dd>
      <dt className={ui.muted}>Buffers</dt>
      <dd style={{ margin: 0 }}>{consent.buffers.length ? consent.buffers.map((buffer) => `${ZONE_FEATURE_LABELS[buffer.feature].replace(/ \(.*\)$/, "")} ${buffer.metres} m`).join("; ") : none}</dd>
      {consent.notifyCouncil ? (
        <>
          <dt className={ui.muted}>If something goes wrong</dt>
          <dd style={{ margin: 0 }}>
            {consent.notifyCouncil.who}
            {consent.notifyCouncil.phone ? (
              <>
                {" "}
                <a href={`tel:${consent.notifyCouncil.phone.replace(/\s+/g, "")}`}>{consent.notifyCouncil.phone}</a>
              </>
            ) : null}
            : {consent.notifyCouncil.when}
          </dd>
        </>
      ) : null}
    </dl>
  );
}

// Setup screen ------------------------------------------------------------------------------------------

type Placing = { mode: "point" | "zone"; points: Position[] } | null;
type Place = { point: Position | null; zone: Position[] | null };
const NO_PLACE: Place = { point: null, zone: null };

/** Map overlays for the setup: blocks in blue, no-apply zones in red with their buffers, ponds as dots. */
export function setupOverlays(setup: EffluentSetup, paddocks: Paddock[], options: { consent?: ConsentData | null } = {}): { overlays: MapOverlay[]; fills: Record<string, string> } {
  const overlays: MapOverlay[] = [];
  const fills: Record<string, string> = {};
  for (const block of setup.blocks.filter((each) => !each.data.retired && each.change !== "withdrawn")) {
    for (const id of block.data.paddockIds) fills[id] = "rgba(30, 95, 174, 0.35)";
    if (block.data.zone) overlays.push({ id: `b${block.recordId}`, label: `Effluent block: ${block.data.name}`, tone: "effluent", ring: block.data.zone.coordinates[0] });
  }
  for (const zone of setup.zones.filter((each) => !each.data.removed && each.change !== "withdrawn")) {
    const buffer = Number(zone.data.bufferM ?? bufferFor(options.consent ?? null, zone.data.feature) ?? 0);
    const label = `No-apply zone: ${zone.data.name}${buffer ? `, ${buffer} m buffer` : ""}`;
    if (zone.data.point && buffer > 0) overlays.push({ id: `zb${zone.recordId}`, label, tone: "buffer", ring: bufferRing(zone.data.point, buffer) });
    overlays.push({ id: `z${zone.recordId}`, label, tone: "danger", point: zone.data.point, ring: zone.data.zone?.coordinates[0] ?? null });
  }
  for (const pond of setup.ponds.filter((each) => !each.data.retired && each.change !== "withdrawn" && each.data.point)) {
    overlays.push({ id: `p${pond.recordId}`, label: `${POND_KIND_LABELS[pond.data.kind]}: ${pond.data.name}`, tone: "effluent", point: pond.data.point, marker: "dot", short: "P" });
  }
  void paddocks;
  return { overlays, fills };
}

function SetupScreen({ organisationId, farm }: EffluentContext) {
  const [showWithdrawn, setShowWithdrawn] = useState(false);
  const setup = useEffluentSetup(organisationId, farm.id, showWithdrawn);
  const paddocks = usePaddocks(organisationId, farm.id);
  const imageryKey = useImageryKey(organisationId);
  const [placing, setPlacing] = useState<Placing>(null);
  const [place, setPlace] = useState<Place>(NO_PLACE);
  if (setup.error) return <Notice tone="error">{setup.error}</Notice>;
  if (!setup.data || !paddocks.data) return <p className={ui.muted}>Loading…</p>;
  const data = setup.data;
  const active = paddocks.data.paddocks.filter((paddock) => paddock.status === "active");
  const consent = activeConsent(data.consents);
  const { overlays, fills } = setupOverlays(data, active, { consent: consent?.data ?? null });
  if (place.point) overlays.push({ id: "new-point", label: "The new place", tone: "warning", point: place.point });
  if (place.zone && place.zone.length > 3) overlays.push({ id: "new-zone", label: "The new outline", tone: "warning", ring: place.zone });
  const placer = {
    place,
    start: (mode: "point" | "zone") => {
      setPlace(NO_PLACE);
      setPlacing({ mode, points: [] });
      requestAnimationFrame(() => document.getElementById("effluent-map")?.scrollIntoView({ behavior: "smooth", block: "start" }));
    },
    clear: () => setPlace(NO_PLACE),
    setPoint: (point: Position) => setPlace({ point, zone: null }),
  };
  const saved = () => {
    setPlace(NO_PLACE);
    setup.reload();
  };
  const manage = data.access.canManage;
  return (
    <div className={styles.overview}>
      <div className={styles.column}>
        <Card title="Map" description="Blue: effluent blocks. Red: no-apply zones, with their buffers as light red circles. P: ponds and sumps. A picture to plan by, not a survey.">
          <div id="effluent-map" style={{ scrollMarginTop: 72 }} />
          {placing ? (
            <Notice tone="info">
              {placing.mode === "point" ? "Tap the map where it is." : `Tap the map at each corner (${placing.points.length} so far), then Finish.`}{" "}
              {placing.mode === "zone" ? (
                <Button
                  size="small"
                  disabled={placing.points.length < 3}
                  onClick={() => {
                    setPlace({ point: null, zone: [...placing.points, placing.points[0]] });
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
            paddocks={active}
            selected={null}
            imageryKey={imageryKey}
            fills={fills}
            overlays={overlays}
            label={`Map of ${farm.name} with ${data.blocks.length} effluent blocks and ${data.zones.length} no-apply zones`}
            drawing={placing ? placing.points : null}
            onMapTap={(position) => {
              if (!placing) return;
              if (placing.mode === "point") {
                setPlace({ point: position, zone: null });
                setPlacing(null);
              } else setPlacing({ ...placing, points: [...placing.points, position] });
            }}
          />
        </Card>
        <ConsentCard organisationId={organisationId} farm={farm} consents={data.consents} manage={manage} onSaved={saved} />
        <label className={ui.checkbox}>
          <input type="checkbox" checked={showWithdrawn} onChange={(event) => setShowWithdrawn(event.target.checked)} /> Show records withdrawn as mistakes
        </label>
      </div>
      <div className={styles.column}>
        {!manage ? <Notice tone="info">Owners and admins keep the effluent setup and consent conditions. You can see them here.</Notice> : null}
        <SystemsCard organisationId={organisationId} farm={farm} setup={data} manage={manage} onSaved={saved} />
        <PondsCard organisationId={organisationId} farm={farm} ponds={data.ponds} manage={manage} placer={placer} onSaved={saved} />
        <BlocksCard organisationId={organisationId} farm={farm} blocks={data.blocks} paddocks={active} manage={manage} placer={placer} onSaved={saved} />
        <ZonesCard organisationId={organisationId} farm={farm} zones={data.zones} consent={consent?.data ?? null} manage={manage} placer={placer} onSaved={saved} />
      </div>
    </div>
  );
}

type Placer = { place: Place; start: (mode: "point" | "zone") => void; clear: () => void; setPoint: (point: Position) => void };

// Shared bits -------------------------------------------------------------------------------------------

function by(record: { enteredByName?: string; enteredByEmail: string }) {
  return record.enteredByName || record.enteredByEmail;
}

function RecordLine({ record }: { record: CurrentRecord<unknown> }) {
  return (
    <div className={ui.muted} style={{ fontSize: "var(--text-sm)" }}>
      {record.change === "withdrawn" ? "Withdrawn (entered by mistake) · " : ""}
      {record.version > 1 ? `version ${record.version}, ${record.changeLabel.toLowerCase()} ${formatDateTime(record.enteredAt)} by ${by(record)}` : `added ${formatDateTime(record.enteredAt)} by ${by(record)}`}
    </div>
  );
}

/** A record's row: its summary, history, and (for those who may) Change and Withdraw. */
function RecordRow({ organisationId, record, title, badges, children, manage, editor, part, onSaved }: { organisationId: string; record: CurrentRecord<unknown>; title: string; badges?: ReactNode; children?: ReactNode; manage: boolean; editor: (done: () => void, correcting: boolean) => ReactNode; part: string; onSaved: () => void }) {
  const [open, setOpen] = useState<"history" | "change" | "correct" | "withdraw" | null>(null);
  const withdrawn = record.change === "withdrawn";
  return (
    <li style={{ borderTop: "1px solid var(--border)", padding: "10px 0" }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
        <strong style={{ overflowWrap: "anywhere" }}>{title}</strong>
        {badges}
      </div>
      {children}
      <RecordLine record={record} />
      <div className={ui.actions} style={{ justifyContent: "flex-start", flexWrap: "wrap", marginTop: 4 }}>
        <Button variant="secondary" size="small" aria-expanded={open === "history"} onClick={() => setOpen(open === "history" ? null : "history")}>
          History
        </Button>
        {manage && !withdrawn ? (
          <>
            <Button variant="secondary" size="small" aria-expanded={open === "change"} onClick={() => setOpen(open === "change" ? null : "change")}>
              Change
            </Button>
            <Button variant="secondary" size="small" aria-expanded={open === "correct"} onClick={() => setOpen(open === "correct" ? null : "correct")}>
              Correct a mistake
            </Button>
            <Button variant="secondary" size="small" aria-expanded={open === "withdraw"} onClick={() => setOpen(open === "withdraw" ? null : "withdraw")}>
              Withdraw
            </Button>
          </>
        ) : null}
      </div>
      {open === "history" ? <SafetyHistory organisationId={organisationId} recordId={record.recordId} /> : null}
      {open === "change" || open === "correct" ? (
        editor(() => {
          setOpen(null);
          onSaved();
        }, open === "correct")
      ) : null}
      {open === "withdraw" ? (
        <WithdrawForm
          organisationId={organisationId}
          part={part}
          record={record}
          onDone={() => {
            setOpen(null);
            onSaved();
          }}
        />
      ) : null}
    </li>
  );
}

function WithdrawForm({ organisationId, part, record, onDone }: { organisationId: string; part: string; record: CurrentRecord<unknown>; onDone: () => void }) {
  const [why, setWhy] = useState("");
  const { busy, error, run } = useRun();
  return (
    <form
      style={{ margin: "8px 0", padding: 10, border: "1px solid var(--border)", borderRadius: 8 }}
      onSubmit={(event) => {
        event.preventDefault();
        void run(() => api(`/api/farming/effluent/${part}/${record.recordId}`, { method: "PATCH", body: { organisationId, expectedVersion: record.version, step: "withdraw", why } }), onDone);
      }}
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      <p style={{ marginTop: 0 }}>Withdraw only something entered by mistake. It stays in the history, marked withdrawn.</p>
      <Field label="Why">
        <input value={why} required maxLength={1000} onChange={(event) => setWhy(event.target.value)} />
      </Field>
      <Button type="submit" disabled={busy || !why.trim()}>
        Withdraw it
      </Button>
    </form>
  );
}

/** Save buttons and the "why" a correction needs. */
function SaveRow({ busy, correcting, why, onWhy, onCancel, label = "Save" }: { busy: boolean; correcting: boolean; why: string; onWhy: (value: string) => void; onCancel: () => void; label?: string }) {
  return (
    <>
      {correcting ? (
        <Field label="What was wrong" hint="The history shows the earlier version and why it was corrected.">
          <input value={why} required maxLength={1000} onChange={(event) => onWhy(event.target.value)} />
        </Field>
      ) : null}
      <div className={ui.actions}>
        <Button type="submit" disabled={busy || (correcting && !why.trim())}>
          {label}
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </>
  );
}

const FORM_STYLE = { margin: "10px 0", padding: 12, border: "1px solid var(--border)", borderRadius: 8 } as const;

function useSave(organisationId: string, part: string, record: CurrentRecord<unknown> | null, correcting: boolean) {
  const [operationId] = useState(() => (record ? undefined : newOperationId().replace(/^op-/, "")));
  const { busy, error, run } = useRun();
  const save = (body: Record<string, unknown>, done: () => void, why: string) =>
    void run(
      () =>
        record
          ? api(`/api/farming/effluent/${part}/${record.recordId}`, { method: "PATCH", body: { organisationId, expectedVersion: record.version, step: correcting ? "correct" : "update", why: why || null, ...body } })
          : api(`/api/farming/effluent/${part}`, { method: "POST", body: { organisationId, operationId, ...body } }),
      done,
    );
  return { busy, error, save };
}

function PlaceButtons({ placer, zone = true, point = true }: { placer: Placer; zone?: boolean; point?: boolean }) {
  const [locating, setLocating] = useState<string | null>(null);
  return (
    <>
      <div className={ui.fieldLabel}>On the map</div>
      <div className={ui.actions} style={{ justifyContent: "flex-start", flexWrap: "wrap" }}>
        {point ? (
          <>
            <Button
              variant="secondary"
              size="small"
              onClick={() => {
                if (!navigator.geolocation) return setLocating("This phone or browser can't share its location.");
                setLocating("Finding where you are…");
                navigator.geolocation.getCurrentPosition(
                  (position) => {
                    setLocating(null);
                    placer.setPoint([position.coords.longitude, position.coords.latitude]);
                  },
                  () => setLocating("The location wasn't shared."),
                  { enableHighAccuracy: true, timeout: 15_000 },
                );
              }}
            >
              Where I am now
            </Button>
            <Button variant="secondary" size="small" onClick={() => placer.start("point")}>
              Tap the map
            </Button>
          </>
        ) : null}
        {zone ? (
          <Button variant="secondary" size="small" onClick={() => placer.start("zone")}>
            Draw an outline
          </Button>
        ) : null}
        {placer.place.point || placer.place.zone ? (
          <Button variant="secondary" size="small" onClick={placer.clear}>
            Clear
          </Button>
        ) : null}
      </div>
      <p className={ui.muted} style={{ margin: "4px 0 8px" }}>
        {locating ?? (placer.place.zone ? "Outline drawn." : placer.place.point ? "Place marked." : "Not on the map yet.")}
      </p>
    </>
  );
}

// Consent ---------------------------------------------------------------------------------------------

function ConsentCard({ organisationId, farm, consents, manage, onSaved }: { organisationId: string; farm: Farm; consents: Array<CurrentRecord<ConsentData>>; manage: boolean; onSaved: () => void }) {
  const [adding, setAdding] = useState(false);
  const active = activeConsent(consents);
  return (
    <Card
      title="Consent conditions"
      description="Entered from the farm's own consent. The log, ponds and council pack compare records with these."
      actions={manage && !adding ? <Button size="small" onClick={() => setAdding(true)}>{active ? "Add a new consent" : "Enter the consent"}</Button> : null}
    >
      <Notice tone="warning">{CHECK_YOUR_CONSENT}</Notice>
      {adding ? <ConsentForm organisationId={organisationId} farm={farm} record={null} correcting={false} onDone={() => { setAdding(false); onSaved(); }} onCancel={() => setAdding(false)} /> : null}
      {!consents.length && !adding ? <Empty>No consent conditions yet.</Empty> : null}
      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {[...consents].reverse().map((consent) => (
          <RecordRow
            key={consent.recordId}
            organisationId={organisationId}
            record={consent}
            part="consents"
            manage={manage}
            onSaved={onSaved}
            title={`${consent.data.title}${consent.data.consentNumber ? ` (${consent.data.consentNumber})` : ""}`}
            badges={
              <>
                {consent === active ? <Badge tone="blue">In force</Badge> : consent.data.replaced ? <Badge>Replaced</Badge> : null}
                {consent.data.fromTemplate.length ? <Badge tone="amber">Check against your consent</Badge> : null}
              </>
            }
            editor={(done, correcting) => <ConsentForm organisationId={organisationId} farm={farm} record={consent} correcting={correcting} onDone={done} onCancel={done} />}
          >
            <ConsentFacts consent={consent.data} />
            {consent.data.deferWhen.length ? (
              <>
                <div className={ui.fieldLabel}>Don&apos;t apply when{consent.data.fromTemplate.includes("deferWhen") ? " (from the template)" : ""}</div>
                <ul style={{ margin: "2px 0 6px", paddingLeft: 18 }}>
                  {consent.data.deferWhen.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </>
            ) : null}
            {consent.data.recordsRequired.length ? (
              <>
                <div className={ui.fieldLabel}>Records to keep{consent.data.fromTemplate.includes("recordsRequired") ? " (from the template)" : ""}</div>
                <ul style={{ margin: "2px 0 6px", paddingLeft: 18 }}>
                  {consent.data.recordsRequired.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </>
            ) : null}
            {consent.data.otherConditions ? <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{consent.data.otherConditions}</p> : null}
            {consent.data.fromTemplate.length ? <p className={ui.muted}>Still as the template had them: {consent.data.fromTemplate.map((key) => TEMPLATE_FIELD_NAMES[key] ?? key).join(", ")}.</p> : null}
            {consent.data.sources.length ? (
              <details>
                <summary>Where the template came from</summary>
                <ul style={{ paddingLeft: 18 }}>
                  {consent.data.sources.map((source) => (
                    <li key={source.url}>
                      <a href={source.url} target="_blank" rel="noreferrer noopener">
                        {source.title}
                      </a>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </RecordRow>
        ))}
      </ul>
    </Card>
  );
}

const TEMPLATE_FIELD_NAMES: Record<string, string> = { buffers: "buffers", deferWhen: "when not to apply", recordsRequired: "records to keep", notifyCouncil: "who to tell", otherConditions: "other conditions" };

function ConsentForm({ organisationId, farm, record, correcting, onDone, onCancel }: { organisationId: string; farm: Farm; record: CurrentRecord<ConsentData> | null; correcting: boolean; onDone: () => void; onCancel: () => void }) {
  const start = record?.data;
  const [template, setTemplate] = useState<Council | "">(start?.template ?? "");
  const fromTemplate = template && template !== "other" && !record ? CONSENT_TEMPLATES[template] : null;
  const [form, setForm] = useState({
    council: (start?.council ?? "orc") as Council,
    title: start?.title ?? "",
    consentNumber: start?.consentNumber ?? "",
    expiresOn: start?.expiresOn ?? "",
    maxDepthMm: start?.maxDepthMm ?? "",
    maxRateMmPerHour: start?.maxRateMmPerHour ?? "",
    returnPeriodDays: start?.returnPeriodDays ? String(start.returnPeriodDays) : "",
    maxNitrogenKgHaYr: start?.maxNitrogenKgHaYr ?? "",
    storageM3: start?.storageM3 ?? "",
    buffers: start?.buffers ?? [],
    deferWhen: (start?.deferWhen ?? []).join("\n"),
    recordsRequired: (start?.recordsRequired ?? []).join("\n"),
    notifyWho: start?.notifyCouncil?.who ?? "",
    notifyPhone: start?.notifyCouncil?.phone ?? "",
    notifyWhen: start?.notifyCouncil?.when ?? "",
    otherConditions: start?.otherConditions ?? "",
    replaced: start?.replaced ?? false,
  });
  const [why, setWhy] = useState("");
  const { busy, error, save } = useSave(organisationId, "consents", record, correcting);
  const set = (patch: Partial<typeof form>) => setForm({ ...form, ...patch });
  const chooseTemplate = (value: Council | "") => {
    setTemplate(value);
    if (value && value !== "other") {
      const chosen = CONSENT_TEMPLATES[value];
      setForm({
        ...form,
        council: value,
        title: form.title || chosen.title,
        buffers: chosen.buffers,
        deferWhen: chosen.deferWhen.join("\n"),
        recordsRequired: chosen.recordsRequired.join("\n"),
        notifyWho: chosen.notifyCouncil.who,
        notifyPhone: chosen.notifyCouncil.phone ?? "",
        notifyWhen: chosen.notifyCouncil.when,
        otherConditions: chosen.otherConditions,
      });
    }
  };
  return (
    <form
      style={FORM_STYLE}
      aria-label={record ? "Change the consent conditions" : "Enter the consent conditions"}
      onSubmit={(event) => {
        event.preventDefault();
        save(
          {
            farmId: farm.id,
            ...(record ? {} : { template: template && template !== "other" ? template : null }),
            council: form.council,
            title: form.title,
            consentNumber: form.consentNumber,
            expiresOn: form.expiresOn || null,
            maxDepthMm: form.maxDepthMm || null,
            maxRateMmPerHour: form.maxRateMmPerHour || null,
            returnPeriodDays: form.returnPeriodDays || null,
            maxNitrogenKgHaYr: form.maxNitrogenKgHaYr || null,
            storageM3: form.storageM3 || null,
            buffers: form.buffers.filter((buffer) => buffer.metres),
            deferWhen: form.deferWhen,
            recordsRequired: form.recordsRequired,
            notifyCouncil: form.notifyWho || form.notifyWhen ? { who: form.notifyWho, phone: form.notifyPhone, when: form.notifyWhen } : null,
            otherConditions: form.otherConditions,
            replaced: form.replaced,
          },
          onDone,
          why,
        );
      }}
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      {!record ? (
        <Field label="Start from" hint="A template fills in what the council's pages say. Your consent's own conditions win: check every line against it.">
          <select value={template} onChange={(event) => chooseTemplate(event.target.value as Council | "")}>
            <option value="">Nothing: I&apos;ll type them in</option>
            <option value="orc">Otago Regional Council&apos;s pages</option>
            <option value="es">Environment Southland&apos;s pages</option>
          </select>
        </Field>
      ) : null}
      {fromTemplate ? (
        <Notice tone="warning">
          {fromTemplate.summary} {CHECK_YOUR_CONSENT}
        </Notice>
      ) : null}
      <Field label="Council">
        <select value={form.council} onChange={(event) => set({ council: event.target.value as Council })}>
          {COUNCILS.map((council) => (
            <option key={council} value={council}>
              {COUNCIL_LABELS[council]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="What the consent is">
        <input value={form.title} required maxLength={200} onChange={(event) => set({ title: event.target.value })} placeholder="e.g. Discharge permit: farm dairy effluent" />
      </Field>
      <div className={ui.inlineForm}>
        <Field label="Consent number">
          <input value={form.consentNumber} maxLength={60} onChange={(event) => set({ consentNumber: event.target.value })} />
        </Field>
        <Field label="Expires">
          <DateInput value={form.expiresOn} onChange={(event) => set({ expiresOn: event.target.value })} />
        </Field>
      </div>
      <p className={ui.muted} style={{ margin: "4px 0" }}>
        From your consent (no template fills these in):
      </p>
      <div className={ui.inlineForm}>
        <Field label="Most depth (mm)">
          <input inputMode="decimal" value={form.maxDepthMm} onChange={(event) => set({ maxDepthMm: event.target.value })} />
        </Field>
        <Field label="Most rate (mm an hour)">
          <input inputMode="decimal" value={form.maxRateMmPerHour} onChange={(event) => set({ maxRateMmPerHour: event.target.value })} />
        </Field>
        <Field label="Days between applications">
          <input inputMode="numeric" value={form.returnPeriodDays} onChange={(event) => set({ returnPeriodDays: event.target.value })} />
        </Field>
        <Field label="Most nitrogen (kg N/ha a year)">
          <input inputMode="numeric" value={form.maxNitrogenKgHaYr} onChange={(event) => set({ maxNitrogenKgHaYr: event.target.value })} />
        </Field>
        <Field label="Storage needed (m³)">
          <input inputMode="numeric" value={form.storageM3} onChange={(event) => set({ storageM3: event.target.value })} />
        </Field>
      </div>
      <fieldset style={{ border: 0, padding: 0, margin: "8px 0" }}>
        <legend className={ui.fieldLabel}>Buffers (no effluent within)</legend>
        {form.buffers.map((buffer, index) => (
          <div key={index} className={ui.inlineForm}>
            <Field label={`From ${index + 1}`}>
              <select value={buffer.feature} onChange={(event) => set({ buffers: form.buffers.map((each, at) => (at === index ? { ...each, feature: event.target.value as ZoneFeature } : each)) })}>
                {ZONE_FEATURES.map((feature) => (
                  <option key={feature} value={feature}>
                    {ZONE_FEATURE_LABELS[feature]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Metres">
              <input inputMode="decimal" value={buffer.metres} onChange={(event) => set({ buffers: form.buffers.map((each, at) => (at === index ? { ...each, metres: event.target.value } : each)) })} />
            </Field>
            <Button variant="secondary" size="small" onClick={() => set({ buffers: form.buffers.filter((_, at) => at !== index) })}>
              Remove
            </Button>
          </div>
        ))}
        <Button variant="secondary" size="small" onClick={() => set({ buffers: [...form.buffers, { feature: "waterway", metres: "" }] })}>
          Add a buffer
        </Button>
      </fieldset>
      <Field label="Don't apply when (one per line)" hint="Deferred irrigation: when the consent says to store instead.">
        <textarea rows={3} value={form.deferWhen} onChange={(event) => set({ deferWhen: event.target.value })} />
      </Field>
      <Field label="Records the consent needs (one per line)">
        <textarea rows={3} value={form.recordsRequired} onChange={(event) => set({ recordsRequired: event.target.value })} />
      </Field>
      <div className={ui.inlineForm}>
        <Field label="If something goes wrong, tell">
          <input value={form.notifyWho} maxLength={150} onChange={(event) => set({ notifyWho: event.target.value })} />
        </Field>
        <Field label="Their phone">
          <input value={form.notifyPhone} maxLength={40} onChange={(event) => set({ notifyPhone: event.target.value })} />
        </Field>
      </div>
      <Field label="When the consent says to tell them" hint="Tohyee shows this as a prompt. It never tells the council itself.">
        <textarea rows={2} value={form.notifyWhen} onChange={(event) => set({ notifyWhen: event.target.value })} />
      </Field>
      <Field label="Other conditions, as the consent says them">
        <textarea rows={3} value={form.otherConditions} maxLength={8000} onChange={(event) => set({ otherConditions: event.target.value })} />
      </Field>
      {record ? (
        <label className={ui.checkbox}>
          <input type="checkbox" checked={form.replaced} onChange={(event) => set({ replaced: event.target.checked })} /> Replaced by a newer consent, or expired and not renewed
        </label>
      ) : null}
      <SaveRow busy={busy} correcting={correcting} why={why} onWhy={setWhy} onCancel={onCancel} />
    </form>
  );
}

// Systems -----------------------------------------------------------------------------------------------

function SystemsCard({ organisationId, farm, setup, manage, onSaved }: { organisationId: string; farm: Farm; setup: EffluentSetup; manage: boolean; onSaved: () => void }) {
  const [adding, setAdding] = useState(false);
  return (
    <Card
      title={`Systems (${setup.systems.filter((system) => !system.data.retired && system.change !== "withdrawn").length})`}
      description="Each is a machine in Safety's equipment register, with its pre-start checklist. A failed critical check puts it out of use until someone allowed releases it."
      actions={manage && !adding ? <Button size="small" onClick={() => setAdding(true)}>Add a system</Button> : null}
    >
      {adding ? <SystemForm organisationId={organisationId} farm={farm} setup={setup} record={null} correcting={false} onDone={() => { setAdding(false); onSaved(); }} onCancel={() => setAdding(false)} /> : null}
      {!setup.systems.length && !adding ? <Empty>No systems yet: add the travelling irrigator, pods or K-line, tanker or spreader, and fixed sprinklers or rain gun you use.</Empty> : null}
      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {setup.systems.map((system) => {
          const pond = setup.ponds.find((each) => each.recordId === system.data.pondId);
          const blocks = setup.blocks.filter((each) => system.data.blockIds.includes(each.recordId)).map((each) => each.data.name);
          const settings = SETTINGS_FOR[system.data.type].filter((key) => system.data.settings[key]).map((key) => `${SETTING_LABELS[key].label} ${system.data.settings[key]}`);
          return (
            <RecordRow
              key={system.recordId}
              organisationId={organisationId}
              record={system}
              part="systems"
              manage={manage}
              onSaved={onSaved}
              title={system.data.name}
              badges={
                <>
                  <span className={ui.muted}>{SYSTEM_TYPE_LABELS[system.data.type]}</span>
                  {system.data.retired ? <Badge>No longer used</Badge> : system.available ? <Badge tone="green">In use</Badge> : <Badge tone="red">Out of use</Badge>}
                </>
              }
              editor={(done, correcting) => <SystemForm organisationId={organisationId} farm={farm} setup={setup} record={system} correcting={correcting} onDone={done} onCancel={done} />}
            >
              <div style={{ overflowWrap: "anywhere" }}>
                {[pond ? `From ${pond.data.name}` : null, blocks.length ? `On ${blocks.join(", ")}` : null, settings.join(" · ") || "No settings for working out depth", CHECK_EVERY_LABELS[system.data.checkEvery].toLowerCase() + " checks", system.data.serviceEveryMonths ? `serviced every ${system.data.serviceEveryMonths} months` : null, system.data.wofDue ? `Effluent WoF due ${formatDate(system.data.wofDue)}` : null]
                  .filter(Boolean)
                  .join(" · ")}
              </div>
              {!system.available ? <div>{system.outOfUseBecause}</div> : null}
              <Link href={safetyHref({ farmId: farm.id, screen: "equipment", equipment: system.data.equipmentId })}>Its checks and checklist in Safety</Link>
            </RecordRow>
          );
        })}
      </ul>
      <details>
        <summary>DairyNZ&apos;s guides the starting checklists come from</summary>
        <ul style={{ paddingLeft: 18 }}>
          {DAIRYNZ_GUIDES.map((guide) => (
            <li key={guide.url}>
              <a href={guide.url} target="_blank" rel="noreferrer noopener">
                {guide.title}
              </a>
            </li>
          ))}
        </ul>
      </details>
    </Card>
  );
}

type EquipmentChoices = { equipment: Array<{ recordId: string; change: string; data: { name: string; retired: boolean; type: string | null } }>; people: Array<{ userId: string; name: string }>; fixedAssets: Array<{ id: string; name: string }> };

function SystemForm({ organisationId, farm, setup, record, correcting, onDone, onCancel }: { organisationId: string; farm: Farm; setup: EffluentSetup; record: SystemView | null; correcting: boolean; onDone: () => void; onCancel: () => void }) {
  const choices = useApiData<EquipmentChoices>(record ? null : "/api/farming/safety/equipment", { organisationId, farmId: farm.id });
  const start = record?.data;
  const [form, setForm] = useState({
    name: start?.name ?? "",
    type: (start?.type ?? "travelling_irrigator") as SystemType,
    equipmentId: "",
    fixedAssetId: "",
    responsibleUserId: "",
    pondId: start?.pondId ?? "",
    blockIds: start?.blockIds ?? [],
    settings: { ...(start?.settings ?? {}) } as Partial<SystemSettings>,
    shiftEveryHours: start?.shiftEveryHours ?? "",
    checkEvery: (start?.checkEvery ?? "day") as CheckEvery,
    serviceEveryMonths: start?.serviceEveryMonths ? String(start.serviceEveryMonths) : "",
    wofDue: start?.wofDue ?? "",
    notes: start?.notes ?? "",
    retired: start?.retired ?? false,
  });
  const [why, setWhy] = useState("");
  const { busy, error, save } = useSave(organisationId, "systems", record, correcting);
  const set = (patch: Partial<typeof form>) => setForm({ ...form, ...patch });
  const linked = new Set(setup.systems.map((system) => system.data.equipmentId));
  const machines = (choices.data?.equipment ?? []).filter((item) => item.change !== "withdrawn" && !item.data.retired && !linked.has(item.recordId));
  return (
    <form
      style={FORM_STYLE}
      aria-label={record ? `Change ${record.data.name}` : "Add a system"}
      onSubmit={(event) => {
        event.preventDefault();
        save(
          {
            farmId: farm.id,
            name: form.name,
            ...(record ? {} : { type: form.type, equipmentId: form.equipmentId || null, fixedAssetId: form.fixedAssetId || null, responsibleUserId: form.responsibleUserId || null }),
            pondId: form.pondId || null,
            blockIds: form.blockIds,
            settings: form.settings,
            shiftEveryHours: form.shiftEveryHours || null,
            checkEvery: form.checkEvery,
            serviceEveryMonths: form.serviceEveryMonths || null,
            wofDue: form.wofDue || null,
            notes: form.notes,
            retired: form.retired,
          },
          onDone,
          why,
        );
      }}
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Field label="Name">
        <input value={form.name} required maxLength={150} onChange={(event) => set({ name: event.target.value })} placeholder="e.g. Travelling irrigator, shed block" />
      </Field>
      {!record ? (
        <>
          <Field label="Kind">
            <select value={form.type} onChange={(event) => set({ type: event.target.value as SystemType })}>
              {SYSTEM_TYPES.map((type) => (
                <option key={type} value={type}>
                  {SYSTEM_TYPE_LABELS[type]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Machine in Safety's register" hint="Leave as new to add one with a starting checklist from DairyNZ's staff guides. Change the checklist in Safety › Equipment.">
            <select value={form.equipmentId} onChange={(event) => set({ equipmentId: event.target.value })}>
              <option value="">New machine, with a starting checklist</option>
              {machines.map((item) => (
                <option key={item.recordId} value={item.recordId}>
                  {item.data.name}
                </option>
              ))}
            </select>
          </Field>
          {!form.equipmentId ? (
            <div className={ui.inlineForm}>
              {choices.data?.fixedAssets.length ? (
                <Field label="Fixed asset (if it is one)">
                  <select value={form.fixedAssetId} onChange={(event) => set({ fixedAssetId: event.target.value })}>
                    <option value="">Not a fixed asset</option>
                    {choices.data.fixedAssets.map((asset) => (
                      <option key={asset.id} value={asset.id}>
                        {asset.name}
                      </option>
                    ))}
                  </select>
                </Field>
              ) : null}
              {choices.data?.people.length ? (
                <Field label="Who looks after it" hint="Failed checks make an action for them.">
                  <select value={form.responsibleUserId} onChange={(event) => set({ responsibleUserId: event.target.value })}>
                    <option value="">Nobody named</option>
                    {choices.data.people.map((person) => (
                      <option key={person.userId} value={person.userId}>
                        {person.name}
                      </option>
                    ))}
                  </select>
                </Field>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}
      <div className={ui.inlineForm}>
        <Field label="Draws from">
          <select value={form.pondId} onChange={(event) => set({ pondId: event.target.value })}>
            <option value="">Not set</option>
            {setup.ponds.filter((pond) => pond.change !== "withdrawn" && !pond.data.retired).map((pond) => (
              <option key={pond.recordId} value={pond.recordId}>
                {pond.data.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Checks">
          <select value={form.checkEvery} onChange={(event) => set({ checkEvery: event.target.value as CheckEvery })}>
            {CHECK_EVERY.map((every) => (
              <option key={every} value={every}>
                {CHECK_EVERY_LABELS[every]}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {setup.blocks.length ? (
        <fieldset style={{ border: 0, padding: 0, margin: "8px 0" }}>
          <legend className={ui.fieldLabel}>Blocks it applies to</legend>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 14px" }}>
            {setup.blocks.filter((block) => block.change !== "withdrawn" && !block.data.retired).map((block) => (
              <label key={block.recordId} className={ui.checkbox}>
                <input type="checkbox" checked={form.blockIds.includes(block.recordId)} onChange={(event) => set({ blockIds: event.target.checked ? [...form.blockIds, block.recordId] : form.blockIds.filter((id) => id !== block.recordId) })} /> {block.data.name}
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}
      <fieldset style={{ border: 0, padding: 0, margin: "8px 0" }}>
        <legend className={ui.fieldLabel}>For working out the depth (from your bucket tests or designer)</legend>
        <div className={ui.inlineForm}>
          {SETTINGS_FOR[record?.data.type ?? form.type].map((key) => (
            <Field key={key} label={SETTING_LABELS[key].label} hint={SETTING_LABELS[key].hint}>
              <input inputMode="decimal" value={form.settings[key] ?? ""} onChange={(event) => set({ settings: { ...form.settings, [key]: event.target.value } })} />
            </Field>
          ))}
        </div>
      </fieldset>
      <div className={ui.inlineForm}>
        {(record?.data.type ?? form.type) !== "slurry_tanker" ? (
          <Field label="Remind to shift every (hours)">
            <input inputMode="decimal" value={form.shiftEveryHours} onChange={(event) => set({ shiftEveryHours: event.target.value })} />
          </Field>
        ) : null}
        <Field label="Service every (months)">
          <input inputMode="numeric" value={form.serviceEveryMonths} onChange={(event) => set({ serviceEveryMonths: event.target.value })} />
        </Field>
        <Field label="Next Effluent WoF">
          <DateInput value={form.wofDue} onChange={(event) => set({ wofDue: event.target.value })} />
        </Field>
      </div>
      <Field label="Notes">
        <textarea rows={2} value={form.notes} maxLength={2000} onChange={(event) => set({ notes: event.target.value })} />
      </Field>
      {record ? (
        <label className={ui.checkbox}>
          <input type="checkbox" checked={form.retired} onChange={(event) => set({ retired: event.target.checked })} /> No longer used
        </label>
      ) : null}
      <SaveRow busy={busy} correcting={correcting} why={why} onWhy={setWhy} onCancel={onCancel} />
    </form>
  );
}

// Ponds -----------------------------------------------------------------------------------------------

function PondsCard({ organisationId, farm, ponds, manage, placer, onSaved }: { organisationId: string; farm: Farm; ponds: Array<CurrentRecord<PondData>>; manage: boolean; placer: Placer; onSaved: () => void }) {
  const [adding, setAdding] = useState(false);
  return (
    <Card title={`Ponds and sumps (${ponds.filter((pond) => !pond.data.retired && pond.change !== "withdrawn").length})`} actions={manage && !adding ? <Button size="small" onClick={() => setAdding(true)}>Add one</Button> : null}>
      {adding ? <PondForm organisationId={organisationId} farm={farm} record={null} correcting={false} placer={placer} onDone={() => { setAdding(false); onSaved(); }} onCancel={() => setAdding(false)} /> : null}
      {!ponds.length && !adding ? <Empty>No ponds or sumps yet.</Empty> : null}
      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {ponds.map((pond) => (
          <RecordRow
            key={pond.recordId}
            organisationId={organisationId}
            record={pond}
            part="ponds"
            manage={manage}
            onSaved={onSaved}
            title={pond.data.name}
            badges={
              <>
                <span className={ui.muted}>{POND_KIND_LABELS[pond.data.kind]}</span>
                {pond.data.retired ? <Badge>No longer used</Badge> : null}
              </>
            }
            editor={(done, correcting) => <PondForm organisationId={organisationId} farm={farm} record={pond} correcting={correcting} placer={placer} onDone={done} onCancel={done} />}
          >
            <div>
              {[`Holds ${pond.data.capacityM3} m³`, pond.data.fullAtMm ? `full at ${pond.data.fullAtMm} mm on the gauge` : null, pond.data.highAtMm ? `warn at ${pond.data.highAtMm} mm` : null, pond.data.lowAtMm ? `low at ${pond.data.lowAtMm} mm` : null, pond.data.dailyInflowM3 ? `about ${pond.data.dailyInflowM3} m³ in a day` : null]
                .filter(Boolean)
                .join(" · ")}
            </div>
            {pond.data.markers.length ? <div className={ui.muted}>Gauge marks: {pond.data.markers.map((marker) => `${marker.label} ${marker.mm} mm`).join(", ")}</div> : null}
          </RecordRow>
        ))}
      </ul>
    </Card>
  );
}

function PondForm({ organisationId, farm, record, correcting, placer, onDone, onCancel }: { organisationId: string; farm: Farm; record: CurrentRecord<PondData> | null; correcting: boolean; placer: Placer; onDone: () => void; onCancel: () => void }) {
  const start = record?.data;
  const [form, setForm] = useState({
    name: start?.name ?? "",
    kind: (start?.kind ?? "pond") as PondKind,
    capacityM3: start?.capacityM3 ?? "",
    fullAtMm: start?.fullAtMm ?? "",
    highAtMm: start?.highAtMm ?? "",
    lowAtMm: start?.lowAtMm ?? "",
    dailyInflowM3: start?.dailyInflowM3 ?? "",
    markers: start?.markers ?? [],
    notes: start?.notes ?? "",
    retired: start?.retired ?? false,
  });
  const [why, setWhy] = useState("");
  const { busy, error, save } = useSave(organisationId, "ponds", record, correcting);
  const set = (patch: Partial<typeof form>) => setForm({ ...form, ...patch });
  const point = placer.place.point ?? start?.point ?? null;
  return (
    <form
      style={FORM_STYLE}
      aria-label={record ? `Change ${record.data.name}` : "Add a pond or sump"}
      onSubmit={(event) => {
        event.preventDefault();
        save({ farmId: farm.id, ...form, markers: form.markers.filter((marker) => marker.label.trim()), point }, onDone, why);
      }}
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.inlineForm}>
        <Field label="Name">
          <input value={form.name} required maxLength={150} onChange={(event) => set({ name: event.target.value })} />
        </Field>
        <Field label="What it is">
          <select value={form.kind} onChange={(event) => set({ kind: event.target.value as PondKind })}>
            {POND_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {POND_KIND_LABELS[kind]}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className={ui.inlineForm}>
        <Field label="Holds when full (m³)" hint="From your designer or DairyNZ's storage calculator.">
          <input inputMode="decimal" required value={form.capacityM3} onChange={(event) => set({ capacityM3: event.target.value })} />
        </Field>
        <Field label="Gauge reading when full (mm)">
          <input inputMode="numeric" value={form.fullAtMm} onChange={(event) => set({ fullAtMm: event.target.value })} />
        </Field>
        <Field label="Warn at or above (mm)">
          <input inputMode="numeric" value={form.highAtMm} onChange={(event) => set({ highAtMm: event.target.value })} />
        </Field>
        <Field label="Warn at or below (mm)">
          <input inputMode="numeric" value={form.lowAtMm} onChange={(event) => set({ lowAtMm: event.target.value })} />
        </Field>
        <Field label="Goes in each day, about (m³)" hint="For days of storage left.">
          <input inputMode="decimal" value={form.dailyInflowM3} onChange={(event) => set({ dailyInflowM3: event.target.value })} />
        </Field>
      </div>
      <fieldset style={{ border: 0, padding: 0, margin: "8px 0" }}>
        <legend className={ui.fieldLabel}>Marks on the gauge</legend>
        {form.markers.map((marker, index) => (
          <div key={index} className={ui.inlineForm}>
            <Field label={`Mark ${index + 1}`}>
              <input value={marker.label} maxLength={40} onChange={(event) => set({ markers: form.markers.map((each, at) => (at === index ? { ...each, label: event.target.value } : each)) })} placeholder="e.g. Low, Medium, Full" />
            </Field>
            <Field label="At (mm)">
              <input inputMode="numeric" value={marker.mm} onChange={(event) => set({ markers: form.markers.map((each, at) => (at === index ? { ...each, mm: event.target.value } : each)) })} />
            </Field>
            <Button variant="secondary" size="small" onClick={() => set({ markers: form.markers.filter((_, at) => at !== index) })}>
              Remove
            </Button>
          </div>
        ))}
        <Button variant="secondary" size="small" onClick={() => set({ markers: [...form.markers, { label: "", mm: "" }] })}>
          Add a mark
        </Button>
      </fieldset>
      <PlaceButtons placer={placer} zone={false} />
      <Field label="Notes">
        <textarea rows={2} value={form.notes} maxLength={2000} onChange={(event) => set({ notes: event.target.value })} />
      </Field>
      {record ? (
        <label className={ui.checkbox}>
          <input type="checkbox" checked={form.retired} onChange={(event) => set({ retired: event.target.checked })} /> No longer used
        </label>
      ) : null}
      <SaveRow busy={busy} correcting={correcting} why={why} onWhy={setWhy} onCancel={onCancel} />
    </form>
  );
}

// Blocks ----------------------------------------------------------------------------------------------

function BlocksCard({ organisationId, farm, blocks, paddocks, manage, placer, onSaved }: { organisationId: string; farm: Farm; blocks: Array<CurrentRecord<BlockData>>; paddocks: Paddock[]; manage: boolean; placer: Placer; onSaved: () => void }) {
  const [adding, setAdding] = useState(false);
  const names = new Map(paddocks.map((paddock) => [paddock.id, paddock.name]));
  return (
    <Card title={`Effluent blocks (${blocks.filter((block) => !block.data.retired && block.change !== "withdrawn").length})`} description="The paddocks or areas effluent goes on (blue on the map)." actions={manage && !adding ? <Button size="small" onClick={() => setAdding(true)}>Add a block</Button> : null}>
      {adding ? <BlockForm organisationId={organisationId} farm={farm} paddocks={paddocks} record={null} correcting={false} placer={placer} onDone={() => { setAdding(false); onSaved(); }} onCancel={() => setAdding(false)} /> : null}
      {!blocks.length && !adding ? <Empty>No effluent blocks yet.</Empty> : null}
      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {blocks.map((block) => {
          const area = block.data.areaHa ?? sumHa(paddocks.filter((paddock) => block.data.paddockIds.includes(paddock.id)));
          return (
            <RecordRow
              key={block.recordId}
              organisationId={organisationId}
              record={block}
              part="blocks"
              manage={manage}
              onSaved={onSaved}
              title={block.data.name}
              badges={
                <>
                  {block.data.risk ? <Badge tone={block.data.risk === "high" ? "amber" : "neutral"}>{RISK_LABELS[block.data.risk]}</Badge> : null}
                  {block.data.retired ? <Badge>No longer used</Badge> : null}
                </>
              }
              editor={(done, correcting) => <BlockForm organisationId={organisationId} farm={farm} paddocks={paddocks} record={block} correcting={correcting} placer={placer} onDone={done} onCancel={done} />}
            >
              <div style={{ overflowWrap: "anywhere" }}>
                {[block.data.paddockIds.length ? `Paddocks ${block.data.paddockIds.map((id) => names.get(id) ?? id).join(", ")}` : null, block.data.zone ? "drawn on the map" : null, area ? `${area} ha${block.data.areaHa ? "" : " (the paddocks' effective area)"}` : null].filter(Boolean).join(" · ")}
              </div>
            </RecordRow>
          );
        })}
      </ul>
    </Card>
  );
}

/** The paddocks' effective hectares added up (display: two places). */
function sumHa(paddocks: Paddock[]): string | null {
  const values = paddocks.map((paddock) => paddock.effectiveHa).filter((value): value is string => Boolean(value));
  if (!values.length) return null;
  // Hundredths of a hectare as whole numbers, so nothing is lost to floating point.
  const hundredths = values.reduce((total, value) => {
    const [whole, fraction = ""] = value.split(".");
    return total + Number(whole) * 100 + Number(`${fraction}00`.slice(0, 2));
  }, 0);
  return `${Math.floor(hundredths / 100)}.${String(hundredths % 100).padStart(2, "0")}`.replace(/\.00$/, "");
}

function BlockForm({ organisationId, farm, paddocks, record, correcting, placer, onDone, onCancel }: { organisationId: string; farm: Farm; paddocks: Paddock[]; record: CurrentRecord<BlockData> | null; correcting: boolean; placer: Placer; onDone: () => void; onCancel: () => void }) {
  const start = record?.data;
  const [form, setForm] = useState({ name: start?.name ?? "", paddockIds: start?.paddockIds ?? [], areaHa: start?.areaHa ?? "", risk: (start?.risk ?? "") as string, notes: start?.notes ?? "", retired: start?.retired ?? false });
  const [why, setWhy] = useState("");
  const { busy, error, save } = useSave(organisationId, "blocks", record, correcting);
  const set = (patch: Partial<typeof form>) => setForm({ ...form, ...patch });
  const ring = placer.place.zone ?? start?.zone?.coordinates[0] ?? null;
  return (
    <form
      style={FORM_STYLE}
      aria-label={record ? `Change ${record.data.name}` : "Add an effluent block"}
      onSubmit={(event) => {
        event.preventDefault();
        save({ farmId: farm.id, ...form, risk: form.risk || null, areaHa: form.areaHa || null, zone: ring ? { type: "Polygon", coordinates: [ring] } : null }, onDone, why);
      }}
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Field label="Name">
        <input value={form.name} required maxLength={150} onChange={(event) => set({ name: event.target.value })} placeholder="e.g. Shed block" />
      </Field>
      <fieldset style={{ border: 0, padding: 0, margin: "8px 0" }}>
        <legend className={ui.fieldLabel}>Paddocks</legend>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 14px", maxHeight: 180, overflowY: "auto" }}>
          {paddocks.map((paddock) => (
            <label key={paddock.id} className={ui.checkbox}>
              <input type="checkbox" checked={form.paddockIds.includes(paddock.id)} onChange={(event) => set({ paddockIds: event.target.checked ? [...form.paddockIds, paddock.id] : form.paddockIds.filter((id) => id !== paddock.id) })} /> {paddock.name}
            </label>
          ))}
        </div>
      </fieldset>
      <PlaceButtons placer={placer} point={false} />
      <div className={ui.inlineForm}>
        <Field label="Area (ha)" hint="Leave empty to use the paddocks' effective area.">
          <input inputMode="decimal" value={form.areaHa} onChange={(event) => set({ areaHa: event.target.value })} />
        </Field>
        <Field label="Soils">
          <select value={form.risk} onChange={(event) => set({ risk: event.target.value })}>
            <option value="">Not said</option>
            {RISK_LEVELS.map((risk) => (
              <option key={risk} value={risk}>
                {RISK_LABELS[risk]}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="Notes">
        <textarea rows={2} value={form.notes} maxLength={2000} onChange={(event) => set({ notes: event.target.value })} />
      </Field>
      {record ? (
        <label className={ui.checkbox}>
          <input type="checkbox" checked={form.retired} onChange={(event) => set({ retired: event.target.checked })} /> No longer used
        </label>
      ) : null}
      <SaveRow busy={busy} correcting={correcting} why={why} onWhy={setWhy} onCancel={onCancel} />
    </form>
  );
}

// No-apply zones --------------------------------------------------------------------------------------

function ZonesCard({ organisationId, farm, zones, consent, manage, placer, onSaved }: { organisationId: string; farm: Farm; zones: Array<CurrentRecord<ZoneData>>; consent: ConsentData | null; manage: boolean; placer: Placer; onSaved: () => void }) {
  const [adding, setAdding] = useState(false);
  return (
    <Card title={`No-apply zones and buffers (${zones.filter((zone) => !zone.data.removed && zone.change !== "withdrawn").length})`} description="Waterways, drains, bores, boundaries, houses and roads, with the buffer from your consent (red on the map)." actions={manage && !adding ? <Button size="small" onClick={() => setAdding(true)}>Add a zone</Button> : null}>
      {adding ? <ZoneForm organisationId={organisationId} farm={farm} consent={consent} record={null} correcting={false} placer={placer} onDone={() => { setAdding(false); onSaved(); }} onCancel={() => setAdding(false)} /> : null}
      {!zones.length && !adding ? <Empty>No no-apply zones yet.</Empty> : null}
      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {zones.map((zone) => {
          const buffer = zone.data.bufferM ?? bufferFor(consent, zone.data.feature);
          return (
            <RecordRow
              key={zone.recordId}
              organisationId={organisationId}
              record={zone}
              part="zones"
              manage={manage}
              onSaved={onSaved}
              title={zone.data.name}
              badges={
                <>
                  <span className={ui.muted}>{ZONE_FEATURE_LABELS[zone.data.feature]}</span>
                  {zone.data.removed ? <Badge>Gone</Badge> : null}
                </>
              }
              editor={(done, correcting) => <ZoneForm organisationId={organisationId} farm={farm} consent={consent} record={zone} correcting={correcting} placer={placer} onDone={done} onCancel={done} />}
            >
              <div>{buffer ? `Buffer ${buffer} m${zone.data.bufferM ? "" : " (from the consent)"}` : "No buffer entered"}</div>
            </RecordRow>
          );
        })}
      </ul>
    </Card>
  );
}

function ZoneForm({ organisationId, farm, consent, record, correcting, placer, onDone, onCancel }: { organisationId: string; farm: Farm; consent: ConsentData | null; record: CurrentRecord<ZoneData> | null; correcting: boolean; placer: Placer; onDone: () => void; onCancel: () => void }) {
  const start = record?.data;
  const [form, setForm] = useState({ name: start?.name ?? "", feature: (start?.feature ?? "waterway") as ZoneFeature, bufferM: start?.bufferM ?? "", notes: start?.notes ?? "", removed: start?.removed ?? false });
  const [why, setWhy] = useState("");
  const { busy, error, save } = useSave(organisationId, "zones", record, correcting);
  const set = (patch: Partial<typeof form>) => setForm({ ...form, ...patch });
  const ring = placer.place.zone ?? (placer.place.point ? null : (start?.zone?.coordinates[0] ?? null));
  const point = placer.place.point ?? (placer.place.zone ? null : (start?.point ?? null));
  const fromConsent = bufferFor(consent, form.feature);
  return (
    <form
      style={FORM_STYLE}
      aria-label={record ? `Change ${record.data.name}` : "Add a no-apply zone"}
      onSubmit={(event) => {
        event.preventDefault();
        save({ farmId: farm.id, ...form, bufferM: form.bufferM || null, point, zone: ring ? { type: "Polygon", coordinates: [ring] } : null }, onDone, why);
      }}
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.inlineForm}>
        <Field label="Name">
          <input value={form.name} required maxLength={150} onChange={(event) => set({ name: event.target.value })} placeholder="e.g. Kaihiku Stream" />
        </Field>
        <Field label="What it is">
          <select value={form.feature} onChange={(event) => set({ feature: event.target.value as ZoneFeature })}>
            {ZONE_FEATURES.map((feature) => (
              <option key={feature} value={feature}>
                {ZONE_FEATURE_LABELS[feature]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Buffer (m)" hint={fromConsent ? `Empty uses the consent's ${fromConsent} m.` : "From your consent."}>
          <input inputMode="decimal" value={form.bufferM} onChange={(event) => set({ bufferM: event.target.value })} />
        </Field>
      </div>
      <PlaceButtons placer={placer} />
      <Field label="Notes">
        <textarea rows={2} value={form.notes} maxLength={2000} onChange={(event) => set({ notes: event.target.value })} />
      </Field>
      {record ? (
        <label className={ui.checkbox}>
          <input type="checkbox" checked={form.removed} onChange={(event) => set({ removed: event.target.checked })} /> Gone (e.g. a bore filled in)
        </label>
      ) : null}
      <SaveRow busy={busy} correcting={correcting} why={why} onWhy={setWhy} onCancel={onCancel} />
    </form>
  );
}
