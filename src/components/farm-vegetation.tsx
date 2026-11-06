"use client";

import Link from "next/link";
import { type ReactNode, useEffect, useId, useState, useSyncExternalStore } from "react";
import { InfoTip } from "@/components/info-tip";
import { useApiData } from "@/components/hooks";
import { PaddockMap } from "@/components/farming";
import { Badge, Button, Card, Field, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage, offlineServedSnapshot, subscribeOfflineServed } from "@/lib/client/api";
import type { Paddock } from "@/lib/farming/paddocks";
import type { ConnectionProblem } from "@/lib/farming/vegetation/provider";
import {
  bytesText,
  CHANGE_SCALE,
  changeText,
  cssColour,
  FLAG_WORDS,
  GREENNESS_NOTE,
  MISSING_LABEL,
  NDVI_SCALE,
  ndviText,
  PAUSE_WORDS,
  QUALITY_WORDS,
  type ScaleStep,
  STATE_WORDS,
  THRESHOLD_LIMITS,
  type VegetationState,
} from "@/lib/farming/vegetation/rules";
import type { FarmVegetation, OverviewRow, PaddockObservation, PaddockTrend, PilotResult, SetupFarm, VegetationSettings } from "@/lib/farming/vegetation/service";
import { canGoOn, nextStep, previousStep, resumeStep, SETUP_STEPS, type SetupProgress, type SetupStep, stepNumber } from "@/lib/farming/vegetation/setup-steps";
import styles from "./farm-vegetation.module.css";

/*
 * Satellite vegetation on the farm map (#612, decisions 1531-1540): the
 * Aerial / Vegetation / Change switch, the date and legend under the map,
 * a paddock's greenness and trend, and the guided setup (one thing a
 * screen) on Farm › Map › Satellite vegetation.
 */

export const VEGETATION_PAGE = "/operations/farm/map/vegetation";

const TONE_BADGE: Record<"info" | "success" | "warning" | "error", "blue" | "green" | "amber" | "red"> = { info: "blue", success: "green", warning: "amber", error: "red" };

/** "Tue 3 Nov 2026, 11:35 am", in New Zealand time. */
export function nzDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-NZ", { timeZone: "Pacific/Auckland", weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
}

export function nzDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-NZ", { timeZone: "Pacific/Auckland", day: "numeric", month: "short", year: "numeric" });
}

export type FarmVegetationAnswer = { vegetation: FarmVegetation; pictures: { overlay: string | null; change: string | null; leftOut?: boolean } };

export function useFarmVegetation(organisationId: string, farmId: string, sceneId: string | null) {
  return useApiData<FarmVegetationAnswer>(`/api/farming/farms/${farmId}/vegetation`, sceneId ? { organisationId, sceneId } : { organisationId });
}

export function StateBadge({ state }: { state: VegetationState }) {
  const words = STATE_WORDS[state];
  return <Badge tone={TONE_BADGE[words.tone]}>{words.title}</Badge>;
}

// The map's picture switch ------------------------------------------------------------------------

export type MapPicture = "aerial" | "vegetation" | "change";
const PICTURE_KEY = "tohyee.farmMapPicture";

/** Which picture is on the map; remembered on this device (like the layer buttons, decision 1465). */
export function useMapPicture(): [MapPicture, (value: MapPicture) => void] {
  const [value, setValue] = useState<MapPicture>("aerial");
  useEffect(() => {
    try {
      const saved = localStorage.getItem(PICTURE_KEY);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- read once from this device's storage after hydration
      if (saved === "vegetation" || saved === "change") setValue(saved);
    } catch {
      // Storage blocked: start on the aerial photo.
    }
  }, []);
  return [
    value,
    (next) => {
      setValue(next);
      try {
        localStorage.setItem(PICTURE_KEY, next);
      } catch {
        // Not remembered; still changed on screen.
      }
    },
  ];
}

/** Aerial / Vegetation / Change, in the same buttons as the map's layers (#602). */
export function MapPictureSwitch({ value, onChange }: { value: MapPicture; onChange: (value: MapPicture) => void }) {
  const options: Array<{ key: MapPicture; label: string }> = [
    { key: "aerial", label: "Aerial" },
    { key: "vegetation", label: "Vegetation" },
    { key: "change", label: "Change" },
  ];
  return (
    <div role="group" aria-label="Picture on the map" className={styles.switch}>
      <span className={ui.muted}>Picture:</span>
      {options.map((option) => (
        <Button key={option.key} size="small" variant="secondary" aria-pressed={value === option.key} onClick={() => onChange(option.key)} style={value === option.key ? { borderColor: "var(--accent)", boxShadow: "inset 0 0 0 1px var(--accent)" } : undefined}>
          {value === option.key ? "✓ " : ""}
          {option.label}
        </Button>
      ))}
      <InfoTip label="Satellite pictures">
        Vegetation colours each paddock by how green it looked from the satellite on the date shown. Change compares it with the clear date before. Grey stripes are where the satellite couldn&apos;t see the ground. {GREENNESS_NOTE}
      </InfoTip>
    </div>
  );
}

/** What the map draws for a picture: the image and its corners, or nothing. */
export function vegetationRaster(answer: FarmVegetationAnswer | null, picture: MapPicture): { href: string; bounds: [number, number, number, number] } | null {
  if (!answer?.vegetation.scene || picture === "aerial") return null;
  const href = picture === "change" ? answer.pictures.change : answer.pictures.overlay;
  return href ? { href, bounds: answer.vegetation.scene.bounds } : null;
}

export function ScaleLegend({ scale, label }: { scale: ScaleStep[]; label: string }) {
  return (
    <ul className={styles.legend} aria-label={label}>
      {scale.map((step) => (
        <li key={step.label}>
          <span className={styles.swatch} style={{ background: cssColour(step.colour) }} aria-hidden="true" />
          {step.label}
        </li>
      ))}
      <li>
        <span className={`${styles.swatch} ${styles.missing}`} aria-hidden="true" />
        {MISSING_LABEL}
      </li>
    </ul>
  );
}

/** Under the map: the state, the capture date and other dates, the legend, the note and the attribution (decisions 1531-1533). */
export function VegetationMapNotes({ organisationId, answer, picture, onScene, canSetUp }: { organisationId: string; answer: FarmVegetationAnswer; picture: MapPicture; onScene: (sceneId: string | null) => void; canSetUp: boolean }) {
  const { vegetation } = answer;
  const scene = vegetation.scene;
  const words = STATE_WORDS[vegetation.state];
  const earlier = scene?.changeFromSceneId ? vegetation.scenes.find((entry) => entry.id === scene.changeFromSceneId) : null;
  // Kept on this device (decision 1540): say so, and when, so it isn't taken for the newest.
  const served = useSyncExternalStore(subscribeOfflineServed, offlineServedSnapshot, () => new Map<string, string>());
  const savedAt = served.get(`/api/farming/farms/${vegetation.farmId}/vegetation`) ?? null;
  return (
    <div className={styles.notes}>
      {savedAt ? (
        <Notice tone="warning">
          <strong>Kept on this device</strong> since {nzDateTime(savedAt)}. There may be newer satellite pictures. Only the latest clear date and a few earlier ones are kept here.
        </Notice>
      ) : null}
      {vegetation.state !== "ready" ? (
        <Notice tone={words.tone === "success" ? "info" : words.tone}>
          <strong>{words.title}.</strong> {vegetation.state === "quota_paused" && vegetation.pausedReason ? PAUSE_WORDS[vegetation.pausedReason] : vegetation.state === "reconnect" && vegetation.connectionError ? `${words.body} (${vegetation.connectionError})` : words.body}{" "}
          {canSetUp && (vegetation.state === "reconnect" || vegetation.state === "quota_paused" || vegetation.state === "not_set_up") ? <Link href={VEGETATION_PAGE}>Satellite vegetation settings</Link> : null}
        </Notice>
      ) : null}
      {scene ? (
        <>
          <p className={styles.captured}>
            {picture === "change" && earlier ? `Change from ${nzDate(earlier.acquiredAt)} to ${nzDate(scene.acquiredAt)}` : `Satellite picture taken ${nzDateTime(scene.acquiredAt)}`}
            {scene.farmValidPct !== null ? ` · ${Math.round(Number(scene.farmValidPct))}% of the paddocks clear` : ""}
          </p>
          {picture === "change" && !answer.pictures.change ? <Notice tone="info">There&apos;s no clear earlier date to compare this one with yet, so Change has nothing to show.</Notice> : null}
          {picture !== "aerial" && answer.pictures.leftOut ? <Notice tone="info">This date&apos;s picture was too big to keep on this device. Its numbers are, below and in each paddock.</Notice> : null}
          {picture !== "aerial" && !answer.pictures.overlay && !scene.hasPicture ? <Notice tone="info">This date&apos;s picture is no longer kept on the server. Its numbers are, below and in each paddock.</Notice> : null}
          {vegetation.scenes.length > 1 ? (
            <Field label="Date">
              <select value={scene.id} onChange={(event) => onScene(event.target.value === vegetation.scenes.find((entry) => entry.usable)?.id ? null : event.target.value)}>
                {vegetation.scenes.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {nzDate(entry.acquiredAt)} · {entry.usable ? `${Math.round(Number(entry.farmValidPct ?? 0))}% clear` : entry.farmValidPct !== null && Number(entry.farmValidPct) > 0 ? `mostly cloud (${Math.round(Number(entry.farmValidPct))}% clear)` : "cloud"}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}
          {picture !== "aerial" ? <ScaleLegend scale={picture === "change" ? CHANGE_SCALE : NDVI_SCALE} label={picture === "change" ? "Change colours" : "Greenness colours"} /> : null}
        </>
      ) : null}
      <p className={styles.note}>{GREENNESS_NOTE}</p>
      {vegetation.attribution ? <p className={styles.attribution}>{vegetation.attribution}</p> : null}
      {scene ? (
        <details className={styles.details}>
          <summary>Provider and processing details</summary>
          <dl>
            <dt>Taken (satellite)</dt>
            <dd>{nzDateTime(scene.acquiredAt)}</dd>
            <dt>Fetched by Tohyee</dt>
            <dd>{nzDateTime(scene.retrievedAt)}</dd>
            <dt>Products</dt>
            <dd>{scene.productIds.join(", ")}</dd>
            <dt>Processing baseline</dt>
            <dd>{scene.processingBaseline ?? "Not given"}</dd>
            <dt>Satellite</dt>
            <dd>{scene.platform ?? "Not given"}</dd>
            <dt>Cloud over the wider area</dt>
            <dd>{scene.sceneCloudPct === null ? "Not given" : `${Math.round(Number(scene.sceneCloudPct))}%`}</dd>
            <dt>Worked out with</dt>
            <dd>{scene.processorVersion}</dd>
            <dt>Clear enough to use</dt>
            <dd>
              At least {vegetation.thresholds.minValidPixels} clear pixels and {vegetation.thresholds.minCoveragePct}% of a paddock
            </dd>
            <dt>Licence</dt>
            <dd>{scene.licence}</dd>
          </dl>
          <p>
            <a href={`/api/farming/farms/${vegetation.farmId}/vegetation/export?organisationId=${encodeURIComponent(organisationId)}`} download>
              Download every date&apos;s paddock numbers (CSV)
            </a>
          </p>
        </details>
      ) : null}
    </div>
  );
}

// A paddock's greenness ------------------------------------------------------------------------

/** The paddock card's greenness: the date shown, then the trend (decisions 1530, 1533). */
export function PaddockGreenness({ organisationId, paddockId, observation, onClose }: { organisationId: string; paddockId: string; observation: PaddockObservation | null; onClose?: () => void }) {
  const trend = useApiData<{ trend: PaddockTrend }>(`/api/farming/paddocks/${paddockId}/vegetation`, { organisationId });
  const name = observation?.paddockName ?? trend.data?.trend.paddockName ?? "Paddock";
  return (
    <Card
      title={`Greenness: ${name}`}
      description={<>From satellite pictures. {GREENNESS_NOTE}</>}
      actions={
        onClose ? (
          <Button size="small" variant="secondary" onClick={onClose}>
            Close
          </Button>
        ) : undefined
      }
    >
      {observation ? <ObservationFacts observation={observation} /> : <p className={ui.muted}>No satellite numbers for this paddock on this date.</p>}
      {trend.error ? <Notice tone="error">{trend.error}</Notice> : null}
      {trend.data ? <TrendChart trend={trend.data.trend} /> : <p className={ui.muted}>Loading…</p>}
      {trend.data?.trend.attribution ? <p className={styles.attribution}>{trend.data.trend.attribution}</p> : null}
    </Card>
  );
}

function ObservationFacts({ observation }: { observation: PaddockObservation }) {
  return (
    <>
      <div className={styles.facts}>
        <div className={styles.fact}>
          <span>Greenness on {nzDate(observation.acquiredAt)}</span>
          <strong>{ndviText(observation.meanNdvi)}</strong>
        </div>
        <div className={styles.fact}>
          <span>Clear view</span>
          <strong>{observation.coveragePct === null ? "None" : `${Math.round(Number(observation.coveragePct))}%`}</strong>
        </div>
        <div className={styles.fact}>
          <span>Since the clear date before</span>
          <strong>{changeText(observation.changeNdvi)}</strong>
        </div>
      </div>
      <p>
        <Badge tone={observation.quality === "good" ? "green" : observation.quality === "no_data" ? "neutral" : "amber"}>{QUALITY_WORDS[observation.quality]}</Badge>{" "}
        <span className={ui.muted}>
          {observation.validPixels} of {observation.totalPixels} pixels clear (each about 10 m × 10 m)
          {observation.medianNdvi !== null ? `, middle value ${ndviText(observation.medianNdvi)}` : ""}.
        </span>{" "}
        <InfoTip label="How sure is this?">
          The number is the average greenness of the pixels the satellite saw clearly. It&apos;s only compared with other dates when at least the minimum share of the paddock was clear on both. Pixels on the fence line also see the race or the next paddock.
        </InfoTip>
      </p>
      {observation.flags.map((flag) => (
        <Notice key={flag} tone="info">
          {FLAG_WORDS[flag]}
        </Notice>
      ))}
      {!observation.currentBoundary ? <Notice tone="info">These numbers are for the paddock&apos;s earlier boundary.</Notice> : null}
    </>
  );
}

/**
 * The trend: greenness 0 to 1 on a fixed scale (never stretched), a point a
 * date. Good dates are joined by the line; dates partly hidden are hollow;
 * dates with no clear view sit on the bottom edge as grey ticks, never at 0
 * on the scale. Tap or hover a point for its numbers; the table is below.
 */
export function TrendChart({ trend }: { trend: PaddockTrend }) {
  const titleId = useId();
  const [active, setActive] = useState<number | null>(null);
  const shown = trend.observations.filter((observation, index, all) => all.findLastIndex((other) => other.sceneId === observation.sceneId) === index);
  if (!shown.length) return <p className={ui.muted}>No satellite dates for this paddock yet.</p>;
  const W = 340;
  const H = 170;
  const left = 34;
  const right = 10;
  const top = 10;
  const bottom = 26;
  const times = shown.map((observation) => Date.parse(observation.acquiredAt));
  const t0 = Math.min(...times);
  const t1 = Math.max(...times);
  const x = (t: number) => (t1 === t0 ? (left + W - right) / 2 : left + ((t - t0) / (t1 - t0)) * (W - left - right));
  const y = (value: number) => top + (1 - Math.max(0, Math.min(1, value))) * (H - top - bottom);
  const good = shown.map((observation, index) => ({ observation, index })).filter(({ observation }) => observation.quality === "good" && observation.meanNdvi !== null);
  const path = good.map(({ observation, index }, at) => `${at ? "L" : "M"}${x(times[index]).toFixed(1)},${y(Number(observation.meanNdvi)).toFixed(1)}`).join("");
  const current = active === null ? null : shown[active];
  const months = [...new Set(shown.map((observation) => observation.acquiredAt.slice(0, 7)))];
  const tickEvery = Math.max(1, Math.ceil(months.length / 5));
  return (
    <figure style={{ margin: "8px 0 0" }}>
      <svg viewBox={`0 0 ${W} ${H}`} className={styles.chart} role="img" aria-labelledby={titleId} onPointerLeave={() => setActive(null)}>
        <title id={titleId}>{`Greenness of ${trend.paddockName} on ${shown.length} satellite dates, ${good.length} of them clear enough to compare`}</title>
        {[0, 0.25, 0.5, 0.75, 1].map((value) => (
          <g key={value}>
            <line x1={left} x2={W - right} y1={y(value)} y2={y(value)} stroke="var(--chart-grid)" strokeWidth={1} />
            <text x={left - 6} y={y(value) + 4} textAnchor="end" fontSize={10} fill="var(--chart-text-muted)">
              {value.toFixed(2).replace(/0$/, "").replace(/\.0$/, "")}
            </text>
          </g>
        ))}
        {months.map((month, index) =>
          index % tickEvery === 0 ? (
            <text key={month} x={x(Date.parse(`${month}-15T00:00:00Z`))} y={H - 8} textAnchor="middle" fontSize={10} fill="var(--chart-text-muted)">
              {new Date(`${month}-15T00:00:00Z`).toLocaleDateString("en-NZ", { month: "short" })}
            </text>
          ) : null,
        )}
        {current ? <line x1={x(times[active!])} x2={x(times[active!])} y1={top} y2={H - bottom} stroke="var(--chart-axis)" strokeWidth={1} /> : null}
        {path ? <path d={path} fill="none" stroke="var(--chart-1)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" /> : null}
        {shown.map((observation, index) => {
          const cx = x(times[index]);
          if (observation.meanNdvi === null) {
            return <rect key={observation.id} x={cx - 1.5} y={H - bottom - 8} width={3} height={8} rx={1} fill="var(--chart-muted)" />;
          }
          const isGood = observation.quality === "good";
          return (
            <circle key={observation.id} cx={cx} cy={y(Number(observation.meanNdvi))} r={4} fill={isGood ? "var(--chart-1)" : "var(--chart-surface)"} stroke={isGood ? "var(--chart-surface)" : "var(--chart-muted)"} strokeWidth={2} />
          );
        })}
        {shown.map((observation, index) => (
          <rect
            key={`hit-${observation.id}`}
            x={x(times[index]) - 8}
            y={top}
            width={16}
            height={H - top - bottom + 10}
            fill="transparent"
            onPointerEnter={() => setActive(index)}
            onPointerDown={() => setActive(index)}
          />
        ))}
      </svg>
      <p className={styles.chartReadout} aria-live="polite">
        {current ? `${nzDate(current.acquiredAt)}: ${current.meanNdvi === null ? "no clear view" : `${ndviText(current.meanNdvi)} (${QUALITY_WORDS[current.quality].toLowerCase()}, ${Math.round(Number(current.coveragePct ?? 0))}% clear)`}` : "Tap a date for its numbers. Filled dots were clear enough to compare; hollow ones were partly hidden; grey ticks had no clear view."}
      </p>
      <details className={styles.trendList}>
        <summary>All dates as a table</summary>
        <table>
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">Greenness</th>
              <th scope="col">Clear</th>
              <th scope="col">View</th>
            </tr>
          </thead>
          <tbody>
            {[...shown].reverse().map((observation) => (
              <tr key={observation.id}>
                <td>{nzDate(observation.acquiredAt)}</td>
                <td>{ndviText(observation.meanNdvi)}</td>
                <td>{observation.coveragePct === null ? "–" : `${Math.round(Number(observation.coveragePct))}%`}</td>
                <td>
                  {QUALITY_WORDS[observation.quality]}
                  {observation.currentBoundary ? "" : " (earlier boundary)"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}

// The setup page -----------------------------------------------------------------------------------

type SettingsAnswer = { settings: VegetationSettings; farms: SetupFarm[]; demoAllowed: boolean };
const STEP_KEY = "tohyee.vegetationSetupStep";

/** "finished": the Done screen was seen and Finish pressed, so the page opens on the farms and settings. */
function useSavedStep(organisationId: string): [string | null, (step: SetupStep | "finished") => void, boolean] {
  const [saved, setSaved] = useState<string | null>(null);
  const [read, setRead] = useState(false);
  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- read once from this device's storage after hydration
      setSaved(localStorage.getItem(`${STEP_KEY}.${organisationId}`));
    } catch {
      setSaved(null);
    }
    setRead(true);
  }, [organisationId]);
  return [
    saved,
    (step) => {
      setSaved(step);
      try {
        localStorage.setItem(`${STEP_KEY}.${organisationId}`, step);
      } catch {
        // Not remembered on this device; the server's state still says how far it got.
      }
    },
    read,
  ];
}

function progressOf(answer: SettingsAnswer): SetupProgress {
  const { settings, farms } = answer;
  return {
    connected: Boolean(settings.provider) && settings.connectionStatus === "ok",
    farmOn: farms.some((farm) => farm.enabled),
    tested: Boolean(settings.lastTest && !settings.lastTest.error && settings.lastTest.bytes > 0),
    enabled: settings.enabled,
  };
}

/** Farm › Map › Satellite vegetation: the setup for owners and admins, the farms' state for everyone. */
export function SatelliteVegetationPage({ organisationId }: { organisationId: string }) {
  const { can } = useWorkspace();
  const admin = can("admin");
  const overview = useApiData<{ farms: OverviewRow[] }>("/api/farming/vegetation/overview", { organisationId });
  const settings = useApiData<SettingsAnswer>(admin ? "/api/farming/vegetation" : null, { organisationId });
  const [saved, save, read] = useSavedStep(organisationId);
  const [step, setStep] = useState<SetupStep | null>(null);
  const [managing, setManaging] = useState(false);
  const progress = settings.data ? progressOf(settings.data) : null;
  const finished = saved === "finished";
  const current = step ?? (progress && read ? resumeStep(finished ? "done" : saved, progress) : null);
  const go = (next: SetupStep) => {
    setStep(next);
    save(next);
    requestAnimationFrame(() => document.getElementById("vegetation-step")?.focus());
  };
  const reload = () => {
    settings.reload();
    overview.reload();
  };

  if (!admin) {
    return (
      <div style={{ display: "grid", gap: 16 }}>
        <Overview rows={overview.data?.farms ?? null} error={overview.error} />
        <Card title="About satellite vegetation">
          <p>{GREENNESS_NOTE}</p>
          <p className={ui.muted}>An owner or admin sets it up. Once it&apos;s on, choose Vegetation on the farm map.</p>
        </Card>
      </div>
    );
  }
  if (settings.error) return <Notice tone="error">{settings.error}</Notice>;
  if (!settings.data || !current || !progress) return <p className={ui.muted}>Loading…</p>;
  // Settings once it's on and the Done screen has been seen (decision 1539); the steps again on request.
  const done = progress.enabled && finished && step === null && !managing;
  return (
    <div style={{ display: "grid", gap: 16 }}>
      {done ? (
        <>
          <Overview rows={overview.data?.farms ?? null} error={overview.error} />
          <Manage organisationId={organisationId} answer={settings.data} onChanged={reload} onSetUp={() => go("connect")} />
          <p>
            <Button
              variant="secondary"
              onClick={() => {
                setManaging(true);
                go("need");
              }}
            >
              See the setup steps again
            </Button>
          </p>
        </>
      ) : (
        <SetupWizard
          organisationId={organisationId}
          answer={settings.data}
          step={current}
          progress={progress}
          onStep={go}
          onChanged={reload}
          onFinish={() => {
            setManaging(false);
            setStep(null);
            save("finished");
          }}
        />
      )}
    </div>
  );
}

function Overview({ rows, error }: { rows: OverviewRow[] | null; error: string | null }) {
  return (
    <Card title="Your farms" description="The latest clear satellite date for each farm you can see.">
      {error ? <Notice tone="error">{error}</Notice> : null}
      {rows === null ? (
        <p className={ui.muted}>Loading…</p>
      ) : rows.length === 0 ? (
        <p className={ui.muted}>No farms yet.</p>
      ) : (
        <div className={ui.tableWrap ?? undefined} style={{ overflowX: "auto" }}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th scope="col">Farm</th>
                <th scope="col">State</th>
                <th scope="col">Latest clear date</th>
                <th scope="col">Paddocks clear enough</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.farmId}>
                  <td>
                    <Link href={`/operations/farm/map?farm=${row.farmId}`}>{row.farmName}</Link>
                  </td>
                  <td>
                    <StateBadge state={row.state} />
                  </td>
                  <td>{row.lastUsableOn ? `${nzDate(`${row.lastUsableOn}T00:00:00+13:00`)}${row.lastUsableClearPct !== null ? ` (${Math.round(Number(row.lastUsableClearPct))}% clear)` : ""}` : "None yet"}</td>
                  <td>{row.paddocksGood === null ? "–" : `${row.paddocksGood} of ${row.paddocks}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function ExternalButton({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className={`${ui.button} ${ui.secondary} ${styles.externalLink}`}>
      {children}
      <span className={styles.visuallyHidden}> (opens in a new tab)</span>
    </a>
  );
}

const MAY_DIFFER = "The buttons on the Copernicus site may be named slightly differently: Tohyee couldn't check these steps against the live site.";

function SetupWizard({ organisationId, answer, step, progress, onStep, onChanged, onFinish }: { organisationId: string; answer: SettingsAnswer; step: SetupStep; progress: SetupProgress; onStep: (step: SetupStep) => void; onChanged: () => void; onFinish: () => void }) {
  const number = stepNumber(step);
  const title = SETUP_STEPS[number - 1].title;
  const [farmId, setFarmId] = useState<string | null>(null);
  const chosenFarm = farmId ?? answer.farms.find((farm) => farm.enabled)?.farmId ?? answer.farms.find((farm) => farm.withBoundary > 0)?.farmId ?? null;
  const next = nextStep(step);
  const open = canGoOn(step, progress);
  return (
    <Card>
      <ol className={styles.progress} aria-hidden="true">
        {SETUP_STEPS.map((entry, index) => (
          <li key={entry.key} className={index + 1 < number ? styles.done : index + 1 === number ? styles.here : undefined} />
        ))}
      </ol>
      <p className={styles.stepLabel}>
        Step {number} of {SETUP_STEPS.length} · Your progress is saved, so you can stop and come back.
      </p>
      <h2 className={styles.stepTitle} id="vegetation-step" tabIndex={-1}>
        {title}
      </h2>
      {step === "need" ? <NeedStep /> : null}
      {step === "explain" ? <ExplainStep /> : null}
      {step === "account" ? <AccountStep /> : null}
      {step === "client" ? <ClientStep /> : null}
      {step === "connect" ? <ConnectStep organisationId={organisationId} answer={answer} onChanged={onChanged} /> : null}
      {step === "farm" ? <FarmStep organisationId={organisationId} farms={answer.farms} farmId={chosenFarm} onFarm={setFarmId} onChanged={onChanged} /> : null}
      {step === "test" ? <TestStep organisationId={organisationId} farms={answer.farms} farmId={chosenFarm} lastTest={answer.settings.lastTest} onChanged={onChanged} /> : null}
      {step === "budget" ? <BudgetStep organisationId={organisationId} settings={answer.settings} onChanged={onChanged} /> : null}
      {step === "on" ? <TurnOnStep organisationId={organisationId} answer={answer} onChanged={onChanged} /> : null}
      {step === "done" ? <DoneStep /> : null}
      <div className={styles.nav}>
        <div>
          {step !== "need" ? (
            <Button variant="secondary" onClick={() => onStep(previousStep(step))}>
              Back
            </Button>
          ) : null}
        </div>
        <div>
          {step === "done" ? (
            <>
              <Link href="/operations/farm/map" className={`${ui.button} ${ui.secondary}`}>
                Open the farm map
              </Link>
              <Button onClick={onFinish}>Finish</Button>
            </>
          ) : (
            <Button disabled={!open} onClick={() => onStep(next)} title={open ? undefined : "Finish this step first"}>
              {step === "need" ? "Start" : "Next"}
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

function NeedStep() {
  return (
    <>
      <p>This takes about 10 minutes. You&apos;ll make a free account with Copernicus (the European Union&apos;s Earth observation programme), then Tohyee fetches satellite pictures of your paddocks by itself.</p>
      <ul className={styles.need}>
        <li>An email address you can open now, to confirm the Copernicus account.</li>
        <li>This page and a second tab or window for the Copernicus website.</li>
        <li>Your paddock boundaries in Tohyee (Farm › More › Import paddock shapes, or drawn on the map).</li>
        <li>About 10 minutes. You can stop at any step and carry on later.</li>
      </ul>
      <p className={ui.muted}>It&apos;s free. Tohyee keeps within a monthly budget you set and never switches to a paid service.</p>
    </>
  );
}

function ExplainStep() {
  return (
    <>
      <p>
        Every few days a Sentinel-2 satellite passes over New Zealand. Tohyee asks for the picture of your paddocks and works out how green each paddock looked. On the farm map you can then choose <strong>Vegetation</strong> to see it, or <strong>Change</strong> to see where it got greener or less green.
      </p>
      <p className={styles.note}>{GREENNESS_NOTE} Use it to spot differences between paddocks and over time, then go and look.</p>
      <ul className={styles.need}>
        <li>The satellite can&apos;t see through cloud. A cloudy week can mean no new picture. Cloud shows as grey stripes, never as poor pasture.</li>
        <li>Each pixel is about 10 m across. Very small or narrow paddocks are flagged, because their pixels also see the fence or the race.</li>
        <li>
          What&apos;s sent to Copernicus: only the box around your paddocks (plus 50 m) and the dates.{" "}
          <InfoTip label="What's sent">No paddock names, records, stock or money. Copernicus sends back the satellite&apos;s numbers for that box; Tohyee works out the rest on your server.</InfoTip>
        </li>
        <li>The aerial photo stays on the map for detail. The satellite picture is a dated layer on top.</li>
      </ul>
    </>
  );
}

function AccountStep() {
  return (
    <>
      <p>Copernicus is free. You make the account once.</p>
      <ol className={styles.steps}>
        <li>
          <strong>Open the Copernicus Data Space Ecosystem</strong> in a new tab.
          <br />
          <ExternalButton href="https://dataspace.copernicus.eu/">Open dataspace.copernicus.eu</ExternalButton>
        </li>
        <li>
          At the top right, choose <strong>Login</strong>. On the sign-in page, choose <strong>Register</strong>.
        </li>
        <li>
          Fill in your name, email, a password and your country. If it asks what you&apos;ll use it for, choose something like <em>Agriculture</em>. Tick the terms, then choose <strong>Register</strong>.
        </li>
        <li>
          Open the email from Copernicus (look in junk mail too) and choose the link in it to <strong>confirm your email address</strong>. The account doesn&apos;t work until you do.
        </li>
        <li>Sign in at dataspace.copernicus.eu once, to check it works. Then come back here.</li>
      </ol>
      <Notice tone="info">{MAY_DIFFER}</Notice>
    </>
  );
}

function ClientStep() {
  return (
    <>
      <p>
        Tohyee needs a <strong>client ID</strong> and <strong>client secret</strong> (Copernicus calls them an <em>OAuth client</em>). They let Tohyee fetch pictures for you without your password.
      </p>
      <ol className={styles.steps}>
        <li>
          <strong>Open the Sentinel Hub dashboard</strong> in a new tab and sign in with the account you just made.
          <br />
          <ExternalButton href="https://shapps.dataspace.copernicus.eu/dashboard/">Open the Sentinel Hub dashboard</ExternalButton>
        </li>
        <li>
          In the menu on the left, choose <strong>User settings</strong>.
        </li>
        <li>
          Under <strong>OAuth clients</strong>, choose <strong>Create</strong> (it may be a <strong>+</strong> button).
        </li>
        <li>
          Name it <em>Tohyee</em>. Leave it to never expire if you can (otherwise choose the longest). Choose <strong>Create</strong>.
        </li>
        <li>
          <strong>Copy the client ID and the client secret now</strong>, for example into a note. The secret is shown only once. Keep that tab open for the next step.
        </li>
      </ol>
      <Notice tone="info">{MAY_DIFFER}</Notice>
    </>
  );
}

const PROBLEM_TITLES: Record<ConnectionProblem, string> = {
  wrong_credentials: "Wrong client ID or secret",
  not_activated: "The account isn't activated yet",
  quota: "This month's free allowance is used up",
  unreachable: "Copernicus couldn't be reached",
  failed: "Something unexpected",
};

function ConnectStep({ organisationId, answer, onChanged }: { organisationId: string; answer: SettingsAnswer; onChanged: () => void }) {
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: true; provider: "copernicus" | "demo" } | { ok: false; problem: ConnectionProblem | null; message: string } | null>(null);
  const connected = answer.settings.provider && answer.settings.connectionStatus === "ok";
  const run = async (provider: "copernicus" | "demo", testOnly: boolean) => {
    setBusy(true);
    try {
      const response = await api<{ ok: boolean; problem?: ConnectionProblem; message?: string }>("/api/farming/vegetation/connection", { method: "POST", body: { organisationId, provider, clientId, clientSecret, testOnly } });
      if (!response.ok) setResult({ ok: false, problem: response.problem ?? null, message: response.message ?? "That didn't work." });
      else {
        setResult({ ok: true, provider });
        if (!testOnly) {
          setClientSecret("");
          onChanged();
        }
      }
    } catch (error) {
      setResult({ ok: false, problem: null, message: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {connected ? (
        <Notice tone="success">
          {answer.settings.provider === "demo" ? "Made-up demo pictures are connected." : `Connected (client ${answer.settings.clientIdHint ?? ""}).`} Saved {answer.settings.connectedAt ? nzDateTime(answer.settings.connectedAt) : ""}
          {answer.settings.connectedByEmail ? ` by ${answer.settings.connectedByEmail}` : ""}. Press Next, or connect a different client below.
        </Notice>
      ) : null}
      {answer.settings.connectionStatus === "reconnect" ? <Notice tone="error">The saved client stopped working{answer.settings.connectionError ? `: ${answer.settings.connectionError}` : "."} Paste it again (or make a new one) and test it.</Notice> : null}
      <p>Paste the two values from the Sentinel Hub dashboard, then test them. Nothing is saved until the test works.</p>
      <div className={styles.form}>
        <Field
          label="Client ID"
          hint={
            <>
              Where do I find this?{" "}
              <InfoTip label="Where to find the client ID">
                Sentinel Hub dashboard › User settings › OAuth clients. It&apos;s the ID of the client you made, a line of letters and numbers (often starting <em>sh-</em>).
              </InfoTip>
            </>
          }
        >
          <input value={clientId} onChange={(event) => setClientId(event.target.value)} autoComplete="off" spellCheck={false} />
        </Field>
        <Field
          label="Client secret"
          hint={
            <>
              Where do I find this?{" "}
              <InfoTip label="Where to find the client secret">
                It&apos;s shown once, when you make the client, labelled <em>Client secret</em>. If you didn&apos;t copy it, make a new client and use that one. Tohyee keeps it encrypted on your server and never shows it again.
              </InfoTip>
            </>
          }
        >
          <input type="password" value={clientSecret} onChange={(event) => setClientSecret(event.target.value)} autoComplete="off" spellCheck={false} />
        </Field>
        <div className={ui.actions ?? undefined} style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <Button disabled={busy || !clientId.trim() || !clientSecret.trim()} onClick={() => run("copernicus", true)}>
            {busy ? "Testing…" : "Test connection"}
          </Button>
          {result?.ok && result.provider === "copernicus" && clientSecret ? (
            <Button disabled={busy} onClick={() => run("copernicus", false)}>
              Save
            </Button>
          ) : null}
        </div>
      </div>
      <div className={styles.check} aria-live="polite">
        {result?.ok ? <Notice tone="success">{clientSecret ? "It works. Press Save to keep it." : "Saved. Press Next."}</Notice> : null}
        {result && !result.ok ? (
          <Notice tone="error">
            <strong>{result.problem ? PROBLEM_TITLES[result.problem] : "That didn't work"}.</strong> {result.message}
          </Notice>
        ) : null}
      </div>
      {answer.demoAllowed ? (
        <details className={styles.details} style={{ marginTop: 12 }}>
          <summary>Trying Tohyee out? Use made-up pictures instead</summary>
          <p className={ui.muted}>On the demo farm or a test server, made-up pictures stand in for the satellite. They aren&apos;t real and are labelled so everywhere.</p>
          <Button variant="secondary" disabled={busy} onClick={() => run("demo", false)}>
            Use made-up demo pictures
          </Button>
        </details>
      ) : null}
    </>
  );
}

function usePaddockShapes(organisationId: string, farmId: string | null) {
  return useApiData<{ paddocks: Paddock[] }>(farmId ? `/api/farming/farms/${farmId}/paddocks` : null, { organisationId });
}

function FarmStep({ organisationId, farms, farmId, onFarm, onChanged }: { organisationId: string; farms: SetupFarm[]; farmId: string | null; onFarm: (id: string) => void; onChanged: () => void }) {
  const farm = farms.find((entry) => entry.farmId === farmId) ?? null;
  const shapes = usePaddockShapes(organisationId, farmId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = async (enabled: boolean) => {
    if (!farm) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/farming/farms/${farm.farmId}/vegetation`, { method: "POST", body: { organisationId, action: "setup", enabled } });
      onChanged();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <p>Start with one farm whose paddock boundaries you trust. You can add the others later.</p>
      <div className={styles.choices} role="radiogroup" aria-label="Farm">
        {farms.map((entry) => (
          <label key={entry.farmId} className={styles.choice} aria-disabled={entry.withBoundary === 0}>
            <input type="radio" name="vegetation-farm" checked={entry.farmId === farmId} disabled={entry.withBoundary === 0} onChange={() => onFarm(entry.farmId)} />
            <span className={styles.choiceText}>
              <strong>
                {entry.farmName} {entry.enabled ? <Badge tone="green">On</Badge> : null}
              </strong>
              <span>{entry.withBoundary === 0 ? "No paddock boundaries yet: import or draw them first." : `${entry.withBoundary} of ${entry.paddocks} paddocks have boundaries, ${entry.mappedHa} ha.`}</span>
            </span>
          </label>
        ))}
      </div>
      {farm ? (
        <>
          <h3 style={{ margin: "8px 0" }}>Check {farm.farmName}&apos;s paddocks</h3>
          {shapes.data ? <PaddockMap paddocks={shapes.data.paddocks.filter((paddock) => paddock.status === "active")} selected={null} label={`Paddock boundaries of ${farm.farmName}`} /> : <p className={ui.muted}>Loading…</p>}
          <p>
            Are these the right boundaries? The box around them (plus 50 m) is what&apos;s sent to Copernicus.{" "}
            <InfoTip label="Boundaries">Each paddock&apos;s numbers are kept with the boundary they were worked out with. If you change a boundary later, earlier numbers aren&apos;t changed.</InfoTip>
          </p>
          {farm.withBoundary < farm.paddocks ? <Notice tone="warning">{farm.paddocks - farm.withBoundary} paddocks have no boundary, so they won&apos;t get satellite numbers.</Notice> : null}
          {farm.smallPaddocks.length ? <Notice tone="info">Small paddocks (under 0.6 ha) will be flagged, because a few pixels make a big difference: {farm.smallPaddocks.join(", ")}.</Notice> : null}
          {farm.boundariesChanged ? <Notice tone="info">The boundaries changed since they were confirmed. Confirm them again to update the area sent.</Notice> : null}
          {error ? <Notice tone="error">{error}</Notice> : null}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            <Button disabled={busy} onClick={() => set(true)}>
              {farm.enabled && !farm.boundariesChanged ? "Confirmed" : "These boundaries are right"}
            </Button>
            {farm.enabled ? (
              <Button variant="secondary" disabled={busy} onClick={() => set(false)}>
                Leave this farm out
              </Button>
            ) : null}
            <Link href="/operations/farming" className={`${ui.button} ${ui.secondary}`}>
              Fix boundaries first
            </Link>
          </div>
        </>
      ) : null}
    </>
  );
}

type TestAnswer = { result: PilotResult; preview: string | null; bounds: [number, number, number, number] };

function TestFigures({ result }: { result: PilotResult }) {
  return (
    <div className={styles.figures}>
      <div className={styles.figure}>
        <strong>{result.acquiredAt ? nzDate(result.acquiredAt) : "None"}</strong>
        <span>Date fetched ({result.datesFound} dates in the last 30 days)</span>
      </div>
      <div className={styles.figure}>
        <strong>{result.clearPct === null ? "–" : `${Math.round(result.clearPct)}%`}</strong>
        <span>Of the paddocks clear</span>
      </div>
      <div className={styles.figure}>
        <strong>{bytesText(result.bytes)}</strong>
        <span>
          Downloaded ({result.width} × {result.height} pixels)
        </span>
      </div>
      <div className={styles.figure}>
        <strong>{((result.searchMs + result.fetchMs + result.processMs) / 1000).toFixed(1)} s</strong>
        <span>
          Search {(result.searchMs / 1000).toFixed(1)} s, fetch {(result.fetchMs / 1000).toFixed(1)} s, work out {(result.processMs / 1000).toFixed(1)} s
        </span>
      </div>
      <div className={styles.figure}>
        <strong>{result.provider === "demo" ? "None" : result.unitsSpent !== null ? result.unitsSpent.toFixed(3) : `about ${result.unitsEstimated.toFixed(3)}`}</strong>
        <span>{result.provider === "demo" ? `Processing units (made-up pictures use none; about ${result.unitsEstimated.toFixed(3)} for a real one this size)` : result.unitsSpent !== null ? "Processing units Copernicus charged" : "Processing units (an estimate: Copernicus didn't say)"}</span>
      </div>
      <div className={styles.figure}>
        <strong>
          {result.rssBeforeMb} → {result.rssAfterMb} MB
        </strong>
        <span>Server memory before and after</span>
      </div>
    </div>
  );
}

function TestStep({ organisationId, farms, farmId, lastTest, onChanged }: { organisationId: string; farms: SetupFarm[]; farmId: string | null; lastTest: PilotResult | null; onChanged: () => void }) {
  const farm = farms.find((entry) => entry.farmId === farmId && entry.enabled) ?? farms.find((entry) => entry.enabled) ?? null;
  const shapes = usePaddockShapes(organisationId, farm?.farmId ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tested, setTested] = useState<TestAnswer | null>(null);
  const result = tested?.result ?? (lastTest && lastTest.farmId === farm?.farmId ? lastTest : null);
  const run = async () => {
    if (!farm) return;
    setBusy(true);
    setError(null);
    try {
      setTested(await api<TestAnswer>("/api/farming/vegetation/test", { method: "POST", body: { organisationId, farmId: farm.farmId } }));
      onChanged();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  if (!farm) return <Notice tone="warning">Choose a farm in the step before first.</Notice>;
  return (
    <>
      <p>
        Tohyee fetches one picture of <strong>{farm.farmName}</strong>: the clearest date in the last 30 days. It shows what it cost, so you know before turning it on.
      </p>
      <div>
        <Button disabled={busy} onClick={run}>
          {busy ? "Testing… (this can take a minute)" : result ? "Test again" : "Test one farm"}
        </Button>
      </div>
      {error ? (
        <div className={styles.check}>
          <Notice tone="error">{error}</Notice>
        </div>
      ) : null}
      {result?.error ? (
        <div className={styles.check}>
          <Notice tone="error">The test didn&apos;t finish: {result.error}</Notice>
        </div>
      ) : null}
      {result && !result.error ? (
        <>
          {tested?.preview && shapes.data ? (
            <div className={styles.preview}>
              <PaddockMap paddocks={shapes.data.paddocks.filter((paddock) => paddock.status === "active")} selected={null} fills={Object.fromEntries(shapes.data.paddocks.map((paddock) => [paddock.id, "rgba(0, 0, 0, 0)"]))} raster={{ href: tested.preview, bounds: tested.bounds }} label={`Preview of greenness on ${farm.farmName}`} />
              <ScaleLegend scale={NDVI_SCALE} label="Greenness colours" />
              <p className={styles.attribution}>{result.provider === "demo" ? "Made-up demo pictures, not satellite data." : `Contains modified Copernicus Sentinel data ${result.acquiredAt?.slice(0, 4) ?? ""}`}</p>
            </div>
          ) : null}
          <TestFigures result={result} />
          {!result.acquiredAt ? <Notice tone="warning">No date in the last 30 days was clear enough to fetch. That&apos;s the weather, not a fault. Try again in a few days, or press Next.</Notice> : null}
        </>
      ) : null}
    </>
  );
}

function BudgetStep({ organisationId, settings, onChanged }: { organisationId: string; settings: VegetationSettings; onChanged: () => void }) {
  const [units, setUnits] = useState(String(Math.round(Number(settings.monthlyUnitBudget))));
  const [requests, setRequests] = useState(String(settings.monthlyRequestBudget));
  const [storage, setStorage] = useState(String(Math.round(settings.storageCapBytes / 1048576)));
  const [days, setDays] = useState(String(settings.retentionDays));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const perPicture = settings.lastTest ? (settings.lastTest.unitsSpent ?? settings.lastTest.unitsEstimated) : null;
  const save = async () => {
    setBusy(true);
    setMessage(null);
    try {
      await api("/api/farming/vegetation", { method: "PATCH", body: { organisationId, monthlyUnitBudget: units, monthlyRequestBudget: requests, storageCapMb: storage, retentionDays: days } });
      setMessage({ tone: "success", text: "Saved. Press Next." });
      onChanged();
    } catch (error) {
      setMessage({ tone: "error", text: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <p>Tohyee stops fetching when it reaches these limits, and tells you. It never goes over and never switches to a paid service.</p>
      {perPicture !== null ? (
        <Notice tone="info">
          {settings.lastTest?.provider === "demo"
            ? `Made-up pictures use none. A real picture of ${settings.lastTest.farmName} this size would use about ${perPicture.toFixed(3)} processing units (the published rule; not measured).`
            : `One picture of ${settings.lastTest?.farmName} used ${settings.lastTest?.unitsSpent !== null ? "" : "about "}${perPicture.toFixed(3)} processing units in the test.`} With 6 to 12 dates a month, that&apos;s about {(perPicture * 6).toFixed(1)} to {(perPicture * 12).toFixed(1)} units a month for that farm, plus the first {settings.historyDays} days once.
        </Notice>
      ) : null}
      <div className={styles.form}>
        <Field label="Processing units a month" hint={<>Start: {THRESHOLD_LIMITS.monthlyUnitBudget.start.toLocaleString("en-NZ")}. <InfoTip label="Processing units">Copernicus counts its work in processing units. A free account had 10,000 a month when this was written; your account page on the Sentinel Hub dashboard shows yours. Set this below that, to leave room.</InfoTip></>}>
          <input inputMode="numeric" value={units} onChange={(event) => setUnits(event.target.value)} />
        </Field>
        <Field label="Requests a month" hint={<>Start: {THRESHOLD_LIMITS.monthlyRequestBudget.start.toLocaleString("en-NZ")}. <InfoTip label="Requests">Each search and each picture is a request. Copernicus also limits these.</InfoTip></>}>
          <input inputMode="numeric" value={requests} onChange={(event) => setRequests(event.target.value)} />
        </Field>
        <Field label="Storage on the server (MB)" hint={<>Start: {THRESHOLD_LIMITS.storageCapMb.start}. <InfoTip label="Storage">Pictures are kept on the server&apos;s disk. They can be fetched again, so they aren&apos;t in the nightly backup. The numbers are.</InfoTip></>}>
          <input inputMode="numeric" value={storage} onChange={(event) => setStorage(event.target.value)} />
        </Field>
        <Field label="Keep pictures for (days)" hint={<>Start: {THRESHOLD_LIMITS.retentionDays.start}. <InfoTip label="Keeping pictures">After this, a date&apos;s picture is removed but its numbers stay. The newest clear picture of each farm is always kept.</InfoTip></>}>
          <input inputMode="numeric" value={days} onChange={(event) => setDays(event.target.value)} />
        </Field>
        <div>
          <Button disabled={busy} onClick={save}>
            Save the budget
          </Button>
        </div>
      </div>
      {message ? (
        <div className={styles.check}>
          <Notice tone={message.tone}>{message.text}</Notice>
        </div>
      ) : null}
    </>
  );
}

function TurnOnStep({ organisationId, answer, onChanged }: { organisationId: string; answer: SettingsAnswer; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const on = answer.farms.filter((farm) => farm.enabled);
  const turnOn = async () => {
    setBusy(true);
    setError(null);
    try {
      await api("/api/farming/vegetation", { method: "PATCH", body: { organisationId, enabled: true } });
      for (const farm of on) await api(`/api/farming/farms/${farm.farmId}/vegetation`, { method: "POST", body: { organisationId, action: "check" } }).catch(() => null);
      onChanged();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <p>When it&apos;s on, Tohyee checks {on.length === 1 ? on[0].farmName : `${on.length} farms`} about once a day and fetches each new date, starting with the last {answer.settings.historyDays} days.</p>
      <ul className={styles.need}>
        <li>Budget: {Number(answer.settings.monthlyUnitBudget).toLocaleString("en-NZ")} processing units and {answer.settings.monthlyRequestBudget.toLocaleString("en-NZ")} requests a month.</li>
        <li>Storage: up to {bytesText(answer.settings.storageCapBytes)}, pictures kept {answer.settings.retentionDays} days.</li>
        <li>You can turn it off at any time on this page.</li>
      </ul>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {answer.settings.enabled ? <Notice tone="success">It&apos;s on. Press Next.</Notice> : <Button disabled={busy || !on.length} onClick={turnOn}>{busy ? "Turning on…" : "Turn on satellite vegetation"}</Button>}
    </>
  );
}

function DoneStep() {
  return (
    <>
      <p>Here&apos;s what happens next:</p>
      <ul className={styles.need}>
        <li>The first pictures arrive within a day if it isn&apos;t cloudy. Tohyee fetches the last few weeks first, a few at a time, so the books stay quick.</li>
        <li>After that it checks once a day. A new clear picture comes every few days, less often in cloudy weather.</li>
        <li>
          On the farm map, choose <strong>Vegetation</strong> to see greenness, or <strong>Change</strong> to compare with the date before. Tap a paddock for its numbers and trend.
        </li>
        <li>If it pauses (the budget is used up, or the Copernicus account stops working), the map and this page say why and what to do.</li>
      </ul>
    </>
  );
}

// Managing it after setup -------------------------------------------------------------------------

function Manage({ organisationId, answer, onChanged, onSetUp }: { organisationId: string; answer: SettingsAnswer; onChanged: () => void; onSetUp: () => void }) {
  const { settings } = answer;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState<TestAnswer | null>(null);
  const [minCoverage, setMinCoverage] = useState(String(settings.minCoveragePct));
  const [minPixels, setMinPixels] = useState(String(settings.minValidPixels));
  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      onChanged();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  const firstFarm = answer.farms.find((farm) => farm.enabled) ?? null;
  return (
    <Card title="Settings" description="Owners and admins.">
      {settings.pausedReason ? (
        <Notice tone="warning">
          <strong>Paused.</strong> {PAUSE_WORDS[settings.pausedReason]}{" "}
          <Button size="small" variant="secondary" disabled={busy} onClick={() => act(() => api("/api/farming/vegetation", { method: "PATCH", body: { organisationId, resume: true } }))}>
            Carry on
          </Button>
        </Notice>
      ) : null}
      {settings.connectionStatus === "reconnect" ? (
        <Notice tone="error">
          <strong>Reconnect.</strong> {settings.connectionError}{" "}
          <Button size="small" variant="secondary" onClick={onSetUp}>
            Connect again
          </Button>
        </Notice>
      ) : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      <h3>Farms</h3>
      <div className={styles.choices}>
        {answer.farms.map((farm) => (
          <div key={farm.farmId} className={styles.choice} style={{ cursor: "default", justifyContent: "space-between", flexWrap: "wrap" }}>
            <span className={styles.choiceText}>
              <strong>
                {farm.farmName} {farm.enabled ? <Badge tone="green">On</Badge> : <Badge>Off</Badge>}
              </strong>
              <span>{farm.withBoundary === 0 ? "No paddock boundaries yet." : `${farm.withBoundary} paddocks with boundaries${farm.boundariesChanged ? " · boundaries changed since confirmed" : ""}`}</span>
            </span>
            {farm.withBoundary > 0 ? (
              <Button size="small" variant="secondary" disabled={busy} onClick={() => act(() => api(`/api/farming/farms/${farm.farmId}/vegetation`, { method: "POST", body: { organisationId, action: "setup", enabled: !farm.enabled || farm.boundariesChanged } }))}>
                {farm.enabled ? (farm.boundariesChanged ? "Confirm boundaries" : "Turn off") : "Turn on"}
              </Button>
            ) : null}
          </div>
        ))}
      </div>
      <h3>Clear enough to use</h3>
      <div className={styles.form}>
        <Field label="Least clear share of a paddock (%)" hint={<>50 to 100. <InfoTip label="Clear share">A paddock date is only used, and compared with others, when at least this much of it was clear. Higher is more careful.</InfoTip></>}>
          <input inputMode="numeric" value={minCoverage} onChange={(event) => setMinCoverage(event.target.value)} />
        </Field>
        <Field label="Fewest clear pixels" hint={<>5 to 10000; each is about 100 m². <InfoTip label="Clear pixels">Fewer than this and the paddock is too small to measure reliably. 20 pixels is about 0.2 ha.</InfoTip></>}>
          <input inputMode="numeric" value={minPixels} onChange={(event) => setMinPixels(event.target.value)} />
        </Field>
        <div>
          <Button variant="secondary" disabled={busy} onClick={() => act(() => api("/api/farming/vegetation", { method: "PATCH", body: { organisationId, minCoveragePct: minCoverage, minValidPixels: minPixels } }))}>
            Save
          </Button>
        </div>
      </div>
      <details className={styles.details} style={{ marginTop: 16 }}>
        <summary>Provider and processing details</summary>
        <dl>
          <dt>Provider</dt>
          <dd>{settings.provider === "demo" ? "Made-up demo pictures" : settings.provider === "copernicus" ? `Copernicus (client ${settings.clientIdHint ?? ""})` : "None"}</dd>
          <dt>Connected</dt>
          <dd>{settings.connectedAt ? `${nzDateTime(settings.connectedAt)}${settings.connectedByEmail ? ` by ${settings.connectedByEmail}` : ""}` : "Not connected"}</dd>
          <dt>Used this month</dt>
          <dd>
            {settings.usage.units} of {Number(settings.monthlyUnitBudget).toLocaleString("en-NZ")} processing units; {settings.usage.requests} of {settings.monthlyRequestBudget.toLocaleString("en-NZ")} requests; {bytesText(settings.usage.bytesFetched)} downloaded
          </dd>
          <dt>Pictures stored</dt>
          <dd>
            {bytesText(settings.usage.storedBytes)} of {bytesText(settings.storageCapBytes)}, kept {settings.retentionDays} days
          </dd>
        </dl>
        <h4>Test one farm</h4>
        <p className={ui.muted}>For the pilot: one picture of one farm, with what it cost. See the pilot checklist in the help.</p>
        <Button variant="secondary" disabled={busy || !firstFarm} onClick={() => act(async () => setTesting(await api<TestAnswer>("/api/farming/vegetation/test", { method: "POST", body: { organisationId, farmId: firstFarm!.farmId } })))}>
          Test {firstFarm?.farmName ?? "one farm"}
        </Button>
        {testing?.result ?? settings.lastTest ? <TestFigures result={(testing?.result ?? settings.lastTest)!} /> : null}
        <p style={{ marginTop: 12, display: "flex", flexWrap: "wrap", gap: 8 }}>
          <Button variant="secondary" onClick={onSetUp}>
            Change the connection
          </Button>
          <Button variant="secondary" disabled={busy} onClick={() => act(() => api("/api/farming/vegetation", { method: "PATCH", body: { organisationId, enabled: !settings.enabled } }))}>
            {settings.enabled ? "Turn off for every farm" : "Turn back on"}
          </Button>
          <Button variant="danger" disabled={busy} onClick={() => (window.confirm("Disconnect? The secret is deleted and fetching stops. Numbers already worked out stay.") ? act(() => api("/api/farming/vegetation/connection", { method: "DELETE", query: { organisationId } })) : undefined)}>
            Disconnect
          </Button>
        </p>
      </details>
    </Card>
  );
}

/** On the farm map, under it: where satellite vegetation is set up (owners and admins), or nothing for others until it's on. */
export function SatelliteVegetationLink({ state }: { state: VegetationState | null }) {
  const { can } = useWorkspace();
  if (!can("admin") && (state === null || state === "not_set_up")) return null;
  return (
    <Card title="Satellite vegetation" description={state === null || state === "not_set_up" ? "Free satellite pictures of how green each paddock is. About 10 minutes to set up." : undefined}>
      <p style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, margin: 0 }}>
        {state ? <StateBadge state={state} /> : null}
        <Link href={VEGETATION_PAGE} className={`${ui.button} ${ui.secondary}`}>
          {state === null || state === "not_set_up" ? "Set up satellite vegetation" : "Satellite vegetation"}
        </Link>
      </p>
    </Card>
  );
}
