"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useState } from "react";
import { RequireOrganisation } from "@/components/books";
import { FarmEffluentToday } from "@/components/farm-effluent-care";
import { lastMovedOverlays, useEffluentLog } from "@/components/farm-effluent-log";
import { hazardOverlays } from "@/components/farm-safety";
import { FarmSafetyTab, FarmSafetyToday } from "@/components/farm-safety-tab";
import { FarmOfflineStatus, OFFLINE_PAGE } from "@/components/farm-offline";
import { FarmRowList } from "@/components/farm-rows";
import { FarmSelector, useCanRecordFarmWork, useSelectedFarm } from "@/components/farm-selector";
import { PaddockMap } from "@/components/farming";
import { useApiData } from "@/components/hooks";
import { Button, Card, Empty, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { CALENDAR_KIND_LABELS, type CalendarItem } from "@/lib/farming/calendar-shared";
import { addDays, coverText, daysAgo, mobText, shortDate } from "@/lib/farming/farm-words";
import type { FarmAppLauncher } from "@/lib/farming/launchers";
import { bandsFor, MAP_COLOURINGS, type MapColouring, paddockBand } from "@/lib/farming/map-colours";
import type { PaddockStatus } from "@/lib/farming/paddock-status";
import type { Farm, FarmingSettings, Paddock } from "@/lib/farming/paddocks";
import type { GrazingRecord, PastureReading } from "@/lib/farming/pasture";
import { PASTURE_METHOD_LABELS } from "@/lib/farming/pasture-rules";
import { todayInBrowser } from "@/lib/format";
import { effluentHref } from "@/lib/effluent/screens";
import { safetyHref } from "@/lib/safety/screens";
import { type CurrentRecord, HAZARD_LEVEL_LABELS, type HazardData, hazardState } from "@/lib/safety/shared";
import styles from "./farm-workspace.module.css";

/*
 * The farmer's workspace (#447, decisions 907-910; William's comment):
 * Today · Map · Log · Safety · More, the farm being worked on always in
 * view, and the accounting tables one tap away under More › Details. On a
 * phone the tabs sit at the bottom of the screen.
 */

const NATURAL = new Intl.Collator("en-NZ", { numeric: true, sensitivity: "base" });

export type FarmTab = "today" | "map" | "log" | "safety" | "more";

export const FARM_TABS: Array<{ key: FarmTab; label: string; href: string; icon: string }> = [
  { key: "today", label: "Today", href: "/operations/farm", icon: "◷" },
  { key: "map", label: "Map", href: "/operations/farm/map", icon: "▦" },
  { key: "log", label: "Log", href: "/operations/farm/log", icon: "+" },
  { key: "safety", label: "Safety", href: "/operations/farm/safety", icon: "⚠" },
  { key: "more", label: "More", href: "/operations/farm/more", icon: "≡" },
];

export type FarmContext = { organisationId: string; farm: Farm; farms: Farm[] };

/** `linkedFarmId` (a link's `?farm=`) opens that farm, so a link to a record opens it on the right farm (decision 984). */
export function FarmWorkspace({ tab, linkedFarmId = null, children }: { tab: FarmTab; linkedFarmId?: string | null; children: (context: FarmContext) => ReactNode }) {
  return <RequireOrganisation>{(organisationId) => <Workspace key={`${organisationId}:${linkedFarmId ?? ""}`} organisationId={organisationId} tab={tab} linkedFarmId={linkedFarmId} render={children} />}</RequireOrganisation>;
}

function Workspace({ organisationId, tab, linkedFarmId, render }: { organisationId: string; tab: FarmTab; linkedFarmId: string | null; render: (context: FarmContext) => ReactNode }) {
  const farms = useApiData<{ farms: Farm[] }>("/api/farming/farms", { organisationId });
  const { farm, stale, deciding, selectFarm } = useSelectedFarm(organisationId, farms.data?.farms ?? [], linkedFarmId);
  const active = (farms.data?.farms ?? []).filter((entry) => entry.isActive);
  return (
    <div className={styles.workspace}>
      <nav className={styles.tabs} aria-label="Farm">
        {FARM_TABS.map((entry) => (
          <Link key={entry.key} href={entry.href} className={styles.tab} aria-current={entry.key === tab ? "page" : undefined}>
            <span className={styles.tabIcon} aria-hidden="true">
              {entry.icon}
            </span>
            {entry.label}
          </Link>
        ))}
      </nav>
      {farms.error ? <Notice tone="error">{farms.error}</Notice> : null}
      {!farms.data ? <p className={ui.muted}>Loading…</p> : null}
      {farms.data && active.length === 0 ? <Empty>No farms yet. {farms.data.farms.length ? "" : "An owner or admin adds them under Farms and paddocks."}</Empty> : null}
      {farm ? (
        <div className={styles.farmBar}>
          {active.length > 1 ? (
            <>
              <span className={styles.farmName} id="farm-bar-label">
                Farm
              </span>
              <select value={farm.id} aria-labelledby="farm-bar-label" onChange={(event) => selectFarm(event.target.value)}>
                {active.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                  </option>
                ))}
              </select>
            </>
          ) : (
            <span className={styles.farmName}>{farm.name}</span>
          )}
        </div>
      ) : farms.data && active.length ? (
        <FarmSelector farms={active} farm={null} stale={stale} deciding={deciding} onChange={selectFarm} />
      ) : null}
      {farm ? <FarmOfflineStatus organisationId={organisationId} farmId={farm.id} /> : null}
      {/* Keyed by farm: anything half-filled belongs to the farm it was opened on, and goes when the farm changes (decision 902). */}
      {farm ? <div key={farm.id}>{render({ organisationId, farm, farms: active })}</div> : null}
    </div>
  );
}

// Shared data ---------------------------------------------------------------------------------------------

function useStatuses(organisationId: string, farmId: string) {
  return useApiData<{ paddocks: PaddockStatus[] }>(`/api/farming/farms/${farmId}/paddock-status`, { organisationId, onDate: todayInBrowser() });
}

function useShapes(organisationId: string, farmId: string) {
  return useApiData<{ paddocks: Paddock[] }>(`/api/farming/farms/${farmId}/paddocks`, { organisationId });
}

/** The farm's hazards and no-go zones (#446), for the map and the paddock card. */
function useHazards(organisationId: string, farmId: string) {
  return useApiData<{ hazards: Array<CurrentRecord<HazardData>> }>("/api/farming/safety", { organisationId, farmId });
}

function useImageryKey(organisationId: string) {
  return useApiData<{ settings: FarmingSettings }>("/api/farming/settings", { organisationId }).data?.settings.imageryKey ?? null;
}

/** Each paddock's colour for a colouring. */
export function bandFills(statuses: PaddockStatus[], colouring: MapColouring, today: string): Record<string, string> {
  return Object.fromEntries(statuses.map((status) => [status.paddockId, paddockBand({ inNow: Boolean(status.inNow), lastGrazedOn: status.lastGrazedOn, coverOn: status.cover?.measuredOn ?? null }, colouring, today).colour]));
}

function Legend({ colouring }: { colouring: MapColouring }) {
  return (
    <ul className={styles.legend} aria-label="What the colours mean">
      {bandsFor(colouring).map((band) => (
        <li key={band.key}>
          <span className={styles.swatch} style={{ background: band.colour }} aria-hidden="true" />
          {band.label}
        </li>
      ))}
    </ul>
  );
}

function ColouringSwitch({ value, onChange }: { value: MapColouring; onChange: (value: MapColouring) => void }) {
  return (
    <div className={ui.tabs} role="group" aria-label="Colour paddocks by">
      {MAP_COLOURINGS.map((entry) => (
        <button key={entry.value} type="button" aria-pressed={entry.value === value} className={`${ui.tab} ${entry.value === value ? ui.tabActive : ""}`} onClick={() => onChange(entry.value)}>
          {entry.label}
        </button>
      ))}
    </div>
  );
}

function AppTiles({ organisationId, farmId, manage }: { organisationId: string; farmId: string; manage: boolean }) {
  const launchers = useApiData<{ launchers: FarmAppLauncher[] }>("/api/farming/launchers", { organisationId });
  const shown = (launchers.data?.launchers ?? []).filter((launcher) => launcher.farmId === null || launcher.farmId === farmId);
  if (!shown.length && !manage) return null;
  return (
    <Card title="Farm apps" description={shown.length ? "Apps your farm uses. Each asks for its own key." : undefined}>
      {shown.length ? (
        <div className={styles.tiles}>
          {shown.map((launcher) => (
            <a key={launcher.id} className={styles.tile} href={launcher.url} target="_blank" rel="noreferrer noopener">
              <span className={styles.tileName}>{launcher.name}</span>
              {launcher.description ? <span className={styles.tileNote}>{launcher.description}</span> : null}
            </a>
          ))}
        </div>
      ) : (
        <p className={ui.muted}>No app tiles yet.</p>
      )}
      {manage ? (
        <p>
          <Link href="/operations/farming/apps">Manage integrations</Link>
        </p>
      ) : null}
    </Card>
  );
}

// Today -------------------------------------------------------------------------------------------------

export function FarmToday({ organisationId, farm }: FarmContext) {
  const { can, current } = useWorkspace();
  const today = todayInBrowser();
  const statuses = useStatuses(organisationId, farm.id);
  const shapes = useShapes(organisationId, farm.id);
  const imageryKey = useImageryKey(organisationId);
  const calendar = useApiData<{ items: CalendarItem[] }>("/api/farming/calendar", { organisationId, from: today, to: addDays(today, 6), farmId: farm.id });
  const [mapOpen, setMapOpen] = useState(false);
  const jobs = (calendar.data?.items ?? []).filter((item) => item.state !== "cancelled" && item.state !== "dismissed");
  const todays = jobs.filter((item) => item.date === today);
  const later = jobs.filter((item) => item.date !== today);
  const inNow = (statuses.data?.paddocks ?? []).filter((status) => status.inNow).sort((a, b) => NATURAL.compare(a.name, b.name));
  const fills = statuses.data ? bandFills(statuses.data.paddocks, "grazed", today) : undefined;
  const farmWorker = current?.role === "farm_worker";
  return (
    <div className={styles.grid}>
      <Card title="Today's jobs" description={todays.length ? undefined : "From the farm calendar."}>
        {calendar.error ? <Notice tone="error">{calendar.error}</Notice> : null}
        {calendar.data && !todays.length ? <p>Nothing on the calendar for today.</p> : null}
        {todays.length ? <JobList items={todays} today={today} /> : null}
        {later.length ? (
          <>
            <h3>Next few days</h3>
            <JobList items={later.slice(0, 6)} today={today} />
          </>
        ) : null}
        <p>
          <Link href="/operations/farming/calendar">Open the farm calendar</Link>
        </p>
      </Card>
      <FarmSafetyToday organisationId={organisationId} farm={farm} />
      <FarmEffluentToday organisationId={organisationId} farm={farm} />
      <Card title="Mobs in now">
        {statuses.error ? <Notice tone="error">{statuses.error}</Notice> : null}
        {statuses.data && !inNow.length ? <p>No mobs recorded in a paddock.</p> : null}
        {inNow.length ? (
          <FarmRowList
            label="Mobs in now"
            rows={inNow.map((status) => ({
              key: status.paddockId,
              title: status.name,
              parts: [mobText(status.inNow!.mob, status.inNow!.head), `in ${shortDate(status.inNow!.inOn, today)}`, daysAgo(status.inNow!.inOn, today)],
            }))}
          />
        ) : null}
      </Card>
      <Card title="Map" description="Coloured by days since grazed.">
        {shapes.data && statuses.data ? (
          <>
            <div className={mapOpen ? undefined : styles.compactMap}>
              <PaddockMap paddocks={shapes.data.paddocks.filter((paddock) => paddock.status === "active")} selected={null} imageryKey={mapOpen ? imageryKey : null} fills={fills} label="Map of the paddocks, coloured by days since grazed" />
            </div>
            {mapOpen ? <Legend colouring="grazed" /> : null}
            <div className={styles.actions}>
              <Button variant="secondary" aria-expanded={mapOpen} onClick={() => setMapOpen(!mapOpen)}>
                {mapOpen ? "Show less" : "Show the whole map"}
              </Button>
              <Link href="/operations/farm/map" className={ui.linkButton}>
                Open Map
              </Link>
            </div>
          </>
        ) : (
          <p className={ui.muted}>Loading…</p>
        )}
      </Card>
      <AppTiles organisationId={organisationId} farmId={farm.id} manage={false} />
      {!farmWorker && can("viewer") ? (
        <Card title="Money and year-end" description="The books, budgets and benchmarks stay on Home and under More.">
          <div className={styles.actions}>
            <Link href="/operations">Home</Link>
            <Link href="/operations/farming/benchmarks">Farm benchmarks</Link>
          </div>
        </Card>
      ) : null}
    </div>
  );
}

function JobList({ items, today }: { items: CalendarItem[]; today: string }) {
  return (
    <FarmRowList
      label="Jobs"
      rows={items.map((item) => ({
        key: item.key,
        title: item.date && item.date !== today ? shortDate(item.date, today) : (item.startTime ?? "Today"),
        parts: [item.title, CALENDAR_KIND_LABELS[item.kind], item.tentative ? "to confirm" : null],
      }))}
    />
  );
}

// Map ----------------------------------------------------------------------------------------------------

export function FarmMapTab({ organisationId, farm }: FarmContext) {
  const today = todayInBrowser();
  const statuses = useStatuses(organisationId, farm.id);
  const shapes = useShapes(organisationId, farm.id);
  const imageryKey = useImageryKey(organisationId);
  const [colouring, setColouring] = useState<MapColouring>("grazed");
  const [selected, setSelected] = useState<string | null>(null);
  // Paddocks in the order people say them: 1, 2 … 10, not 1, 10, 2.
  const list = [...(statuses.data?.paddocks ?? [])].sort((a, b) => NATURAL.compare(a.name, b.name));
  const fills = bandFills(list, colouring, today);
  const status = list.find((entry) => entry.paddockId === selected) ?? null;
  const shaped = (shapes.data?.paddocks ?? []).filter((paddock) => paddock.status === "active");
  const router = useRouter();
  const hazards = useHazards(organisationId, farm.id);
  const activeHazards = (hazards.data?.hazards ?? []).filter((hazard) => hazardState(hazard) === "active");
  // Hazards and no-go zones over the paddocks (#446): a tap opens that hazard in Safety.
  const overlays = hazardOverlays(activeHazards, (id) => router.push(safetyHref({ farmId: farm.id, screen: "hazards", hazard: id })));
  // Where each effluent system's pods or irrigator were last moved (#487): a tap opens the irrigation log.
  const effluent = useEffluentLog(organisationId, farm.id);
  overlays.push(...lastMovedOverlays(effluent.data?.lastMoved ?? []).map((overlay) => ({ ...overlay, onSelect: () => router.push(effluentHref({ farmId: farm.id, screen: "log" })) })));
  return (
    <div className={styles.grid}>
      <Card
        title="Paddocks"
        description="Tap a paddock for its cover, mob and recent records. Colours show what was recorded, not whether it's good or bad. Red and amber triangles and dashed outlines are hazards and no-go zones."
        actions={
          <Link className={styles.bigButton} href={`/operations/farm/tractor?farm=${farm.id}`}>
            Tractor mode
          </Link>
        }
      >
        <ColouringSwitch value={colouring} onChange={setColouring} />
        {statuses.error ? <Notice tone="error">{statuses.error}</Notice> : null}
        {shapes.data && statuses.data ? (
          <PaddockMap paddocks={shaped} selected={selected} onSelect={setSelected} imageryKey={imageryKey} fills={fills} overlays={overlays} label={`Map of the paddocks, coloured by ${colouring === "grazed" ? "days since grazed" : "cover reading age"}, with ${overlays.length} hazards`} />
        ) : (
          <p className={ui.muted}>Loading…</p>
        )}
        <Legend colouring={colouring} />
      </Card>
      <div>
        <div id="paddock-card" style={{ scrollMarginTop: 64 }}>
          {status ? <PaddockCard organisationId={organisationId} farm={farm} status={status} hazards={activeHazards} onClose={() => setSelected(null)} /> : null}
        </div>
        <Card title="All paddocks">
          <FarmRowList
            label="Paddocks"
            rows={list.map((entry) => {
              const band = paddockBand({ inNow: Boolean(entry.inNow), lastGrazedOn: entry.lastGrazedOn, coverOn: entry.cover?.measuredOn ?? null }, colouring, today);
              return {
                key: entry.paddockId,
                title: (
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <span className={styles.swatch} style={{ background: band.colour }} aria-hidden="true" />
                    {entry.name}
                  </span>
                ),
                parts: [entry.cover ? `${entry.cover.cover.toLocaleString("en-NZ")} · ${shortDate(entry.cover.measuredOn, today)}` : "No cover", entry.inNow ? `${entry.inNow.mob} in` : entry.lastGrazedOn ? `grazed ${shortDate(entry.lastGrazedOn, today)}` : null],
                onOpen: () => {
                  setSelected(entry.paddockId);
                  // The card opens above the list: bring it into view.
                  requestAnimationFrame(() => document.getElementById("paddock-card")?.scrollIntoView({ behavior: "smooth", block: "start" }));
                },
              };
            })}
          />
        </Card>
      </div>
    </div>
  );
}

/** A paddock's card (decision 909): cover and how old it is, the mob, recent records and buttons to record. */
export function PaddockCard({ organisationId, farm, status, hazards = [], onClose }: { organisationId: string; farm: Farm; status: PaddockStatus; hazards?: Array<CurrentRecord<HazardData>>; onClose: () => void }) {
  const here = hazards.filter((hazard) => hazard.data.paddockIds.includes(status.paddockId));
  const today = todayInBrowser();
  const canRecord = useCanRecordFarmWork();
  const history = useApiData<{ pasture: { readings: PastureReading[]; grazings: GrazingRecord[] } }>(`/api/farming/paddocks/${status.paddockId}/pasture`, { organisationId });
  const recent = [
    ...(history.data?.pasture.readings.slice(0, 3).map((reading) => ({ date: reading.measuredOn, text: `Cover ${coverText(reading.cover)}`, key: `r${reading.id}` })) ?? []),
    ...(history.data?.pasture.grazings.slice(0, 3).map((grazing) => ({ date: grazing.inOn, text: `${mobText(grazing.mob, grazing.head)} in${grazing.outOn ? `, out ${shortDate(grazing.outOn, today)}` : ""}`, key: `g${grazing.id}` })) ?? []),
  ]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 4);
  const logHref = (record: string, extra = "") => `/operations/farm/log?record=${record}&paddock=${status.paddockId}${extra}`;
  return (
    <Card title={`Paddock ${status.name}`} description={`${farm.name}${status.hectares ? ` · ${status.hectares} ha` : ""}`} actions={<Button variant="secondary" onClick={onClose}>Close</Button>}>
      <dl className={styles.facts}>
        <dt>Cover</dt>
        <dd>{status.cover ? `${coverText(status.cover.cover)}, ${daysAgo(status.cover.measuredOn, today)} (${PASTURE_METHOD_LABELS[status.cover.method]})` : "No reading yet"}</dd>
        <dt>Mob</dt>
        <dd>{status.inNow ? `${mobText(status.inNow.mob, status.inNow.head)}, in since ${shortDate(status.inNow.inOn, today)}` : "None in now"}</dd>
        <dt>Last grazed</dt>
        <dd>{status.inNow ? "Being grazed now" : status.lastGrazedOn ? `${shortDate(status.lastGrazedOn, today)} (${daysAgo(status.lastGrazedOn, today)})` : "No grazing recorded"}</dd>
        <dt>Hazards</dt>
        <dd>
          {here.length ? (
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {here.map((hazard) => (
                <li key={hazard.recordId}>
                  <Link href={safetyHref({ farmId: farm.id, screen: "hazards", hazard: hazard.recordId })}>
                    <strong>{hazard.data.noGo ? "No-go: " : ""}{hazard.data.title}</strong>
                  </Link>{" "}
                  ({HAZARD_LEVEL_LABELS[hazard.data.level]}){hazard.data.controls ? `: ${hazard.data.controls}` : ""}
                </li>
              ))}
            </ul>
          ) : (
            "None recorded for this paddock. "
          )}
          <Link href={safetyHref({ farmId: farm.id, screen: "hazards" })}>All hazards on {farm.name}</Link>
        </dd>
      </dl>
      {recent.length ? (
        <>
          <h3>Recent</h3>
          <FarmRowList label="Recent records" rows={recent.map((entry) => ({ key: entry.key, title: shortDate(entry.date, today), parts: [entry.text] }))} />
        </>
      ) : null}
      {canRecord ? (
        <div className={styles.actions}>
          <Link className={styles.bigButton} href={logHref("hazard")}>
            Report a hazard
          </Link>
          <Link className={styles.bigButton} href={logHref("cover")}>
            Add cover
          </Link>
          {status.inNow ? (
            <Link className={styles.bigButton} href={logHref("out", `&grazing=${status.inNow.grazingId}`)}>
              Mob out
            </Link>
          ) : (
            <Link className={styles.bigButton} href={logHref("in")}>
              Mob in
            </Link>
          )}
        </div>
      ) : null}
      <p>
        <Link href={`/operations/farming/pasture?farm=${farm.id}`}>Details: readings and grazings</Link>
      </p>
    </Card>
  );
}

// Safety, More ----------------------------------------------------------------------------------------------

export { FarmSafetyTab };

type MoreLink = { href: string; label: string; note?: string; staff?: boolean; minRole?: "viewer" | "bookkeeper" | "admin" };

const DETAILS: MoreLink[] = [
  { href: "/operations/farm/effluent", label: "Effluent", note: "Irrigation log, ponds, checks, incidents and the council pack", staff: true },
  { href: "/operations/farm/tractor", label: "Tractor mode", note: "Spreading, spraying and mowing coverage from the phone's GPS", staff: true },
  { href: "/operations/farming/pasture", label: "Pasture and feed", note: "Readings, grazings and feed, with tables", staff: true },
  { href: "/operations/farming", label: "Farms and paddocks", note: "Areas, boundaries and drawing paddocks", staff: true },
  { href: "/operations/farming/soil", label: "Soil tests", staff: true },
  { href: "/operations/farming/calendar", label: "Farm calendar", staff: true },
  { href: "/operations/farming/fertiliser", label: "Fertiliser plans" },
  { href: "/operations/farming/notebook", label: "Farm notebook" },
  { href: "/operations/livestock", label: "Livestock" },
  { href: "/operations/farming/compare", label: "All farms compared" },
];

const YEAR_END: MoreLink[] = [
  { href: "/operations/farming/benchmarks", label: "Benchmarks" },
  { href: "/operations/farming/co-op-shares", label: "Co-op shares" },
  { href: "/operations/livestock/valuation", label: "Livestock valuation" },
  { href: "/operations/farming/import", label: "Import paddock shapes", minRole: "bookkeeper" },
];

export function FarmMore({ organisationId, farm }: FarmContext) {
  const { can, current } = useWorkspace();
  const farmWorker = current?.role === "farm_worker";
  const shown = (links: MoreLink[]) => links.filter((link) => (farmWorker ? link.staff : can(link.minRole ?? "viewer")));
  return (
    <div className={styles.grid}>
      <Card title="Details" description="Every record as a table, for checking and the accounts.">
        <LinkList links={shown(DETAILS)} />
      </Card>
      {farmWorker ? null : (
        <Card title="Year-end and setup">
          <LinkList links={shown(YEAR_END)} />
        </Card>
      )}
      <AppTiles organisationId={organisationId} farmId={farm.id} manage />
      <Card title="This phone or tablet" description="Put Tohyee on the Home Screen. The farm pages then open without a signal.">
        <LinkList
          links={[
            { href: "/get-tohyee", label: "Get Tohyee on this device", staff: true },
            { href: OFFLINE_PAGE, label: "Offline on this device", note: "What's kept, and when it was updated", staff: true },
          ]}
        />
      </Card>
    </div>
  );
}

function LinkList({ links }: { links: MoreLink[] }) {
  return (
    <ul className={styles.links}>
      {links.map((link) => (
        <li key={link.href}>
          <Link href={link.href}>
            <span>
              {link.label}
              {link.note ? <span className={ui.muted}> · {link.note}</span> : null}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
