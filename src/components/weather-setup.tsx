"use client";

import Link from "next/link";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { PaddockMap } from "@/components/farming";
import { useApiData } from "@/components/hooks";
import { InfoTip } from "@/components/info-tip";
import { SetupProgress } from "@/components/store-setup";
import { Badge, Button, Card, Field, Notice, ui } from "@/components/ui";
import { WEATHER_PAGE } from "@/components/weather-forecast";
import { api, ApiError, errorMessage } from "@/lib/client/api";
import type { Position } from "@/lib/farming/geometry";
import type { FarmingSettings, Paddock } from "@/lib/farming/paddocks";
import { formatDate } from "@/lib/format";
import { DEFAULT_CHOICES, estimateUnits, METSERVICE_ATTRIBUTION, REFRESH_CHOICES, WEATHER_CHOICES, type WeatherChoice } from "@/lib/weather/forecast-rules";
import type { WeatherLocation, WeatherSetup, WeatherSetupStep } from "@/lib/weather/service";
import styles from "./weather-setup.module.css";

/*
 * Settings › Farm › Weather (MetService) (decisions 1541-1550): a guided
 * setup, one step at a time, that carries on where it was left. Then the
 * optional records controls with a responsibility acknowledgement. Admins
 * only. The key is pasted here once and never shown again.
 */

const STEPS: WeatherSetupStep[] = ["about", "get_key", "paste", "test", "farms", "choose", "turn_on"];
const STEP_NAMES: Record<WeatherSetupStep, string> = {
  about: "What it does",
  get_key: "Get a key",
  paste: "Paste the key",
  test: "Test",
  farms: "Farms",
  choose: "What to fetch",
  turn_on: "Turn on",
};

/** A purpose to give MetService when it asks what the data is for (decision 1545). */
export const SUGGESTED_PURPOSE =
  "Weather forecasts for our own farm's day-to-day management (rain, temperature, wind and frost for planning farm work), shown only to our own farm team inside our farm records software. Not shared, published or resold.";

export function WeatherSetupPage({ organisationId }: { organisationId: string }) {
  const loaded = useApiData<{ setup: WeatherSetup }>("/api/farming/weather", { organisationId });
  const [setup, setSetup] = useState<WeatherSetup | null>(null);
  const [step, setStep] = useState<WeatherSetupStep | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const current = setup ?? loaded.data?.setup ?? null;
  const shown = step ?? current?.step ?? "about";
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    heading.current?.focus();
  }, [shown]);
  if (loaded.error) return <Notice tone="error">{loaded.error}</Notice>;
  if (!current) return <p className={ui.muted}>Loading…</p>;
  const at = STEPS.indexOf(shown);
  const go = async (next: WeatherSetupStep) => {
    setStep(next);
    try {
      const answer = await api<{ setup: WeatherSetup }>("/api/farming/weather", { method: "PATCH", body: { organisationId, step: next } });
      setSetup(answer.setup);
    } catch {
      // Where the setup is up to is only a convenience.
    }
  };
  const ready: Record<WeatherSetupStep, boolean> = {
    about: true,
    get_key: true,
    paste: current.hasKey,
    test: current.status === "ok",
    farms: current.locations.some((location) => location.point),
    choose: current.choices.length > 0,
    turn_on: true,
  };
  const props = { organisationId, setup: current, onSetup: setSetup };
  return (
    <div className={styles.page}>
      {current.fakeProvider ? <Notice tone="info">This server uses a made-up forecast (TOHYEE_WEATHER_PROVIDER=fake), for trying Tohyee out. Nothing is fetched from MetService.</Notice> : null}
      {!current.secretsAvailable ? <Notice tone="warning">This server can&apos;t keep secrets yet (no TOHYEE_SECRET_KEY), so a key can&apos;t be saved. A server admin needs to set it.</Notice> : null}
      <Card>
        <SetupProgress steps={STEPS} names={STEP_NAMES} current={shown} done={(candidate) => STEPS.indexOf(candidate) < at && ready[candidate]} />
        <h2 ref={heading} tabIndex={-1} className={styles.stepHeading}>
          {at + 1}. {STEP_NAMES[shown]}
        </h2>
        {shown === "about" ? <AboutStep /> : null}
        {shown === "get_key" ? <GetKeyStep /> : null}
        {shown === "paste" ? <PasteStep {...props} /> : null}
        {shown === "test" ? <TestStep {...props} /> : null}
        {shown === "farms" ? <FarmsStep {...props} /> : null}
        {shown === "choose" ? <ChooseStep {...props} /> : null}
        {shown === "turn_on" ? <TurnOnStep {...props} /> : null}
        <div className={styles.nav}>
          {at > 0 ? (
            <Button variant="secondary" onClick={() => void go(STEPS[at - 1])}>
              Back
            </Button>
          ) : null}
          {at < STEPS.length - 1 ? (
            <Button disabled={!ready[shown]} onClick={() => void go(STEPS[at + 1])}>
              Next
            </Button>
          ) : null}
          {!ready[shown] ? <span className={ui.muted}>{WAITING[shown]}</span> : null}
        </div>
      </Card>
      <RecordsCard {...props} />
    </div>
  );
}

const WAITING: Record<WeatherSetupStep, string> = {
  about: "",
  get_key: "",
  paste: "Save a key to go on.",
  test: "The test needs to say Connected to go on.",
  farms: "Place at least one farm's pin to go on.",
  choose: "Choose at least one thing.",
  turn_on: "",
};

type StepProps = { organisationId: string; setup: WeatherSetup; onSetup: (setup: WeatherSetup) => void };

function AboutStep() {
  const example = estimateUnits({ choices: DEFAULT_CHOICES, farms: 1, refreshHours: 3 });
  return (
    <div className={styles.body}>
      <p>Tohyee can show a MetService weather forecast for each of your farms, using your own MetService account.</p>
      <ul>
        <li>A forecast card on Today, and a Weather page for each farm.</li>
        <li>The next 48 hours and the next 7 days: rain, temperature, wind and gusts.</li>
        <li>Frost and heavy rain flagged from the forecast numbers.</li>
      </ul>
      <h3>What it costs</h3>
      <p>
        You pay MetService directly. Tohyee charges nothing for it.{" "}
        <InfoTip label="How MetService counts use">
          MetService counts &quot;API units&quot;: requests × variables × points. Tohyee makes one request for each farm at each refresh. Your plan includes some units, and more are sold in lots of 100. Check the prices on MetService&apos;s pricing page.
        </InfoTip>
      </p>
      <p>
        For example, one farm with rain, temperature and wind (4 variables), refreshed every 3 hours, uses about <strong>{example.perDay} units a day</strong> ({example.per30Days.toLocaleString("en-NZ")} in 30 days). You&apos;ll see your own estimate before you turn it on.
      </p>
      <h3>What Tohyee keeps</h3>
      <ul>
        <li>Only the latest forecast. It&apos;s replaced at each refresh and deleted after 24 hours, or when the key is removed.</li>
        <li>It&apos;s shown in its own card, not mixed into your rainfall, pasture or other records.</li>
        <li>
          MetService&apos;s credit is shown beside it: &quot;{METSERVICE_ATTRIBUTION}&quot;{" "}
          <InfoTip label="Why these rules">
            They come from MetService&apos;s API terms of service: data is stored only for your approved purpose and deleted when it&apos;s no longer needed, not combined with other data without their consent, and credited to MetService. Showing MetService&apos;s forecast doesn&apos;t mean MetService endorses Tohyee.
          </InfoTip>
        </li>
        <li>Your key stays on your Tohyee server, encrypted. It&apos;s never shown again, or sent to a browser or the AI.</li>
      </ul>
    </div>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="secondary"
      size="small"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch {
          setCopied(false);
        }
      }}
    >
      {copied ? "Copied" : label}
    </Button>
  );
}

function GetKeyStep() {
  return (
    <div className={styles.body}>
      <p>Each farm business makes its own key. A key can&apos;t be shared with anyone else. It takes about 10 minutes.</p>
      <ol className={styles.walkthrough}>
        <li>
          Open{" "}
          <a href="https://developer.metservice.com/docs/api-catalog/point-forecast-api/" target="_blank" rel="noreferrer noopener">
            MetService&apos;s Point Forecast API page
          </a>{" "}
          (developer.metservice.com).
        </li>
        <li>
          Choose <strong>Login to Console</strong>. It opens MetService&apos;s API console (console.metoceanapi.com). Sign up with your farm business&apos;s email.
        </li>
        <li>
          If it asks what you&apos;ll use the data for (your &quot;purpose&quot;), you can use this:
          <blockquote className={styles.purpose}>{SUGGESTED_PURPOSE}</blockquote>
          <CopyButton text={SUGGESTED_PURPOSE} label="Copy this purpose" />{" "}
          <InfoTip label="Why the purpose matters">MetService&apos;s terms let you use and keep the data only for the purpose you give them. Change the words to fit how your farm uses it.</InfoTip>
        </li>
        <li>
          In the console, open <strong>Usage &amp; keys</strong> and make a new API key. Copy it.
        </li>
        <li>
          While you&apos;re there, set a <strong>spending limit</strong>, so you&apos;re never charged more than you expect.
        </li>
      </ol>
      <p className={ui.muted}>Page and button names may differ slightly: MetService may change them. Tohyee hasn&apos;t checked these pages with a live account.</p>
    </div>
  );
}

function PasteStep({ organisationId, setup, onSetup }: StepProps) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const answer = await api<{ setup: WeatherSetup }>("/api/farming/weather/key", { method: "PUT", body: { organisationId, key } });
      setKey("");
      onSetup(answer.setup);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      const answer = await api<{ setup: WeatherSetup }>(`/api/farming/weather/key?organisationId=${encodeURIComponent(organisationId)}`, { method: "DELETE" });
      setConfirmRemove(false);
      onSetup(answer.setup);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={styles.body}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {setup.hasKey ? (
        <Notice tone="success">
          A key is saved{setup.keySavedAt ? `, ${formatDate(setup.keySavedAt.slice(0, 10))}` : ""}{setup.keySavedByEmail ? ` by ${setup.keySavedByEmail}` : ""}. For safety it&apos;s never shown again. Paste a new one below to replace it.
        </Notice>
      ) : (
        <p>Paste the key you copied from MetService&apos;s console.</p>
      )}
      <form onSubmit={(event) => void save(event)} className={styles.inline}>
        <Field label={setup.hasKey ? "New MetService API key" : "MetService API key"} hint="Kept encrypted on your Tohyee server.">
          <input type="password" autoComplete="off" spellCheck={false} value={key} onChange={(event) => setKey(event.target.value)} maxLength={400} required />
        </Field>
        <Button type="submit" disabled={busy || !key.trim() || !setup.secretsAvailable}>
          {setup.hasKey ? "Replace key" : "Save key"}
        </Button>
      </form>
      {setup.hasKey ? (
        confirmRemove ? (
          <Notice tone="warning">
            Remove the key? The forecast stops, and the forecast Tohyee has kept is deleted.{" "}
            <span className={styles.inlineButtons}>
              <Button variant="danger" size="small" disabled={busy} onClick={() => void remove()}>
                Remove key
              </Button>
              <Button variant="secondary" size="small" onClick={() => setConfirmRemove(false)}>
                Cancel
              </Button>
            </span>
          </Notice>
        ) : (
          <p>
            <Button variant="secondary" onClick={() => setConfirmRemove(true)}>
              Remove key
            </Button>
          </p>
        )
      ) : null}
    </div>
  );
}

function TestStep({ organisationId, setup, onSetup }: StepProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const test = async () => {
    setBusy(true);
    setError(null);
    try {
      await api("/api/farming/weather/test", { method: "POST", body: { organisationId } });
      const answer = await api<{ setup: WeatherSetup }>("/api/farming/weather", { query: { organisationId } });
      onSetup(answer.setup);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };
  const tone = setup.status === "ok" ? "success" : setup.status === "not_tested" ? "info" : "error";
  return (
    <div className={styles.body}>
      <p>
        Tohyee asks MetService for one hour of one forecast value, to check the key works.{" "}
        <InfoTip label="What a test costs">A test uses 1 API unit.</InfoTip>
      </p>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Notice tone={tone}>
        {setup.statusText}
        {setup.testedAt ? ` (${new Date(setup.testedAt).toLocaleString("en-NZ", { dateStyle: "medium", timeStyle: "short" })})` : ""}
      </Notice>
      {setup.pausedAt ? <p>Refreshing has stopped. A good test starts it again.</p> : null}
      <p>
        <Button onClick={() => void test()} disabled={busy || !setup.hasKey}>
          {busy ? "Testing…" : "Test connection"}
        </Button>
      </p>
    </div>
  );
}

function PinInputs({ point, onPoint }: { point: Position | null; onPoint: (point: Position | null) => void }) {
  const [lat, setLat] = useState(point ? String(point[1]) : "");
  const [lon, setLon] = useState(point ? String(point[0]) : "");
  const typed = () => {
    const latitude = Number(lat);
    const longitude = Number(lon);
    if (lat.trim() && lon.trim() && Number.isFinite(latitude) && Number.isFinite(longitude) && (!point || latitude !== point[1] || longitude !== point[0])) onPoint([longitude, latitude]);
  };
  return (
    <div className={styles.inline}>
      <Field label="Latitude">
        <input inputMode="decimal" value={lat} onChange={(event) => setLat(event.target.value)} onBlur={typed} placeholder="-46.1" />
      </Field>
      <Field label="Longitude">
        <input inputMode="decimal" value={lon} onChange={(event) => setLon(event.target.value)} onBlur={typed} placeholder="169.9" />
      </Field>
    </div>
  );
}

function FarmPin({ organisationId, location, point, onPoint }: { organisationId: string; location: WeatherLocation; point: Position | null; onPoint: (point: Position | null) => void }) {
  const [placing, setPlacing] = useState(false);
  const shapes = useApiData<{ paddocks: Paddock[] }>(placing ? `/api/farming/farms/${location.farmId}/paddocks` : null, { organisationId });
  const imageryKey = useApiData<{ settings: FarmingSettings }>(placing ? "/api/farming/settings" : null, { organisationId }).data?.settings.imageryKey ?? null;
  return (
    <div className={styles.pin}>
      {/* Remade when the pin moves on the map, so the boxes show where it is. */}
      <PinInputs key={point ? point.join(",") : "none"} point={point} onPoint={onPoint} />
      <div className={styles.inlineButtons}>
        <Button variant="secondary" size="small" aria-expanded={placing} onClick={() => setPlacing(!placing)}>
          {placing ? "Done placing" : "Place on the map"}
        </Button>
        {location.centre ? (
          <Button variant="secondary" size="small" onClick={() => onPoint([Number(location.centre!.longitude), Number(location.centre!.latitude)])}>
            Use the middle of the paddocks
          </Button>
        ) : null}
      </div>
      {placing ? (
        shapes.data ? (
          <>
            <p className={ui.muted}>Tap the map where the forecast should be for.</p>
            <PaddockMap
              paddocks={shapes.data.paddocks.filter((paddock) => paddock.status === "active")}
              selected={null}
              imageryKey={imageryKey}
              drawing={point ? [point] : []}
              drawingShape="point"
              onMapTap={(position) => onPoint([Math.round(position[0] * 1e6) / 1e6, Math.round(position[1] * 1e6) / 1e6])}
              label={`Map of ${location.farmName}: tap to place the forecast pin`}
            />
          </>
        ) : (
          <p className={ui.muted}>Loading the map…</p>
        )
      ) : null}
    </div>
  );
}

function FarmsStep({ organisationId, setup, onSetup }: StepProps) {
  const initial = () =>
    Object.fromEntries(
      setup.locations.map((location) => [location.farmId, location.point ? ([Number(location.point.longitude), Number(location.point.latitude)] as Position) : null]),
    ) as Record<string, Position | null>;
  const [points, setPoints] = useState<Record<string, Position | null>>(initial);
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(setup.locations.filter((location) => location.point).map((location) => location.farmId)));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const save = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const locations = setup.locations.map((location) => ({ farmId: location.farmId, point: chosen.has(location.farmId) ? points[location.farmId] : null }));
      if (locations.some((location) => chosen.has(location.farmId) && !location.point)) throw new ApiError("Place a pin for each farm you ticked.", 400);
      const answer = await api<{ setup: WeatherSetup }>("/api/farming/weather", { method: "PATCH", body: { organisationId, locations } });
      onSetup(answer.setup);
      setMessage({ tone: "success", text: "Saved." });
    } catch (caught) {
      setMessage({ tone: "error", text: errorMessage(caught) });
    } finally {
      setBusy(false);
    }
  };
  const saved = initial();
  const changed = setup.locations.some((location) => {
    const was = location.point ? saved[location.farmId] : null;
    const now = chosen.has(location.farmId) ? (points[location.farmId] ?? null) : null;
    return (was === null) !== (now === null) || (was !== null && now !== null && (Math.abs(was[0] - now[0]) > 1e-7 || Math.abs(was[1] - now[1]) > 1e-7));
  });
  if (!setup.locations.length) return <p>No farms yet. Add one under Farms and paddocks first.</p>;
  return (
    <div className={styles.body}>
      <p>
        Pick the farms to get a forecast for, and where on each farm. Each farm uses units at every refresh.{" "}
        <InfoTip label="Where to put the pin">The forecast is for one point on the farm. It starts at the middle of the farm&apos;s paddocks; move it if most of your work is somewhere else, or if the farm is spread out.</InfoTip>
      </p>
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      <ul className={styles.farms}>
        {setup.locations.map((location) => {
          const on = chosen.has(location.farmId);
          return (
            <li key={location.farmId} className={styles.farm}>
              <label className={styles.check}>
                <input
                  type="checkbox"
                  checked={on}
                  onChange={(event) => {
                    const next = new Set(chosen);
                    if (event.target.checked) {
                      next.add(location.farmId);
                      if (!points[location.farmId] && location.centre) setPoints({ ...points, [location.farmId]: [Number(location.centre.longitude), Number(location.centre.latitude)] });
                    } else next.delete(location.farmId);
                    setChosen(next);
                  }}
                />
                <strong>{location.farmName}</strong>
                {location.point ? <Badge tone="green">Pin saved</Badge> : null}
              </label>
              {on ? <FarmPin organisationId={organisationId} location={location} point={points[location.farmId] ?? null} onPoint={(point) => setPoints({ ...points, [location.farmId]: point })} /> : null}
            </li>
          );
        })}
      </ul>
      <p>
        <Button onClick={() => void save()} disabled={busy}>
          Save farms
        </Button>{" "}
        {changed ? <span className={ui.muted}>Not saved yet: save before going on.</span> : null}
      </p>
    </div>
  );
}

function ChooseStep({ organisationId, setup, onSetup }: StepProps) {
  const [choices, setChoices] = useState<WeatherChoice[]>(setup.choices);
  const [refreshHours, setRefreshHours] = useState(setup.refreshHours);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const farms = setup.locations.filter((location) => location.point).length;
  const estimate = estimateUnits({ choices, farms, refreshHours });
  const changed = choices.join() !== setup.choices.join() || refreshHours !== setup.refreshHours;
  const save = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const answer = await api<{ setup: WeatherSetup }>("/api/farming/weather", { method: "PATCH", body: { organisationId, choices, refreshHours } });
      onSetup(answer.setup);
      setMessage({ tone: "success", text: "Saved." });
    } catch (caught) {
      setMessage({ tone: "error", text: errorMessage(caught) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={styles.body}>
      <p>Fewer things and fewer refreshes use fewer units.</p>
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      <fieldset className={styles.fieldset}>
        <legend>What to fetch</legend>
        {WEATHER_CHOICES.map((choice) => (
          <label key={choice.key} className={styles.check}>
            <input
              type="checkbox"
              checked={choices.includes(choice.key)}
              onChange={(event) => setChoices(event.target.checked ? WEATHER_CHOICES.map((entry) => entry.key).filter((key) => key === choice.key || choices.includes(key)) : choices.filter((key) => key !== choice.key))}
            />
            <span>
              <strong>{choice.label}</strong> <span className={ui.muted}>· {choice.note}</span>
            </span>
          </label>
        ))}
        <p className={ui.muted}>Frost risk comes from the temperature, so tick Temperature to get it.</p>
      </fieldset>
      <Field label="Refresh every" hint="Forecasts change a few times a day. Every 3 hours is plenty for most farms.">
        <select value={refreshHours} onChange={(event) => setRefreshHours(Number(event.target.value))}>
          {REFRESH_CHOICES.map((hours) => (
            <option key={hours} value={hours}>
              {hours === 1 ? "hour" : `${hours} hours`}
            </option>
          ))}
        </select>
      </Field>
      <div className={styles.estimate} aria-live="polite">
        <strong>About {estimate.perDay.toLocaleString("en-NZ")} API units a day</strong> ({estimate.per30Days.toLocaleString("en-NZ")} in 30 days)
        <br />
        <span className={ui.muted}>
          {estimate.variables} variable{estimate.variables === 1 ? "" : "s"} × {estimate.points} farm{estimate.points === 1 ? "" : "s"} × {estimate.refreshesPerDay} refreshes a day. Pressing Refresh adds {estimate.perRefresh} each time.
        </span>
      </div>
      <p>
        <Button onClick={() => void save()} disabled={busy || !changed || !choices.length}>
          Save
        </Button>{" "}
        {changed ? <span className={ui.muted}>Not saved yet: save before going on.</span> : null}
      </p>
    </div>
  );
}

function TurnOnStep({ organisationId, setup, onSetup }: StepProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const farms = setup.locations.filter((location) => location.point);
  const toggle = async (enabled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const answer = await api<{ setup: WeatherSetup }>("/api/farming/weather", { method: "PATCH", body: { organisationId, enabled } });
      onSetup(answer.setup);
      if (enabled) await api("/api/farming/weather/refresh", { method: "POST", body: { organisationId } }).catch(() => undefined);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={styles.body}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <dl className={styles.summary}>
        <dt>Key</dt>
        <dd>{setup.hasKey ? setup.statusText : "Not saved"}</dd>
        <dt>Farms</dt>
        <dd>{farms.length ? farms.map((farm) => farm.farmName).join(", ") : "None yet"}</dd>
        <dt>Fetching</dt>
        <dd>{WEATHER_CHOICES.filter((choice) => setup.choices.includes(choice.key)).map((choice) => choice.label).join(", ")}, every {setup.refreshHours === 1 ? "hour" : `${setup.refreshHours} hours`}</dd>
        <dt>Estimate</dt>
        <dd>About {setup.estimate.perDay.toLocaleString("en-NZ")} API units a day</dd>
      </dl>
      {setup.enabled ? (
        <>
          <Notice tone="success">
            The forecast is on. <Link href={WEATHER_PAGE}>See the forecast</Link>
          </Notice>
          {setup.pausedAt ? <Notice tone="warning">{setup.statusText}</Notice> : null}
          <p>
            <Button variant="secondary" disabled={busy} onClick={() => void toggle(false)}>
              Turn the forecast off
            </Button>{" "}
            <span className={ui.muted}>Turning it off deletes the forecast Tohyee has kept.</span>
          </p>
        </>
      ) : (
        <p>
          <Button disabled={busy || !setup.hasKey || setup.status !== "ok" || !farms.length} onClick={() => void toggle(true)}>
            Turn on the forecast
          </Button>
        </p>
      )}
    </div>
  );
}

/** Optional forecast records with a responsibility acknowledgement. Off by default. */
function RecordsCard({ organisationId, setup, onSetup }: StepProps) {
  const permission = setup.permission;
  const [ticked, setTicked] = useState(false);
  const [turningOff, setTurningOff] = useState(false);
  const [deleteRecords, setDeleteRecords] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const run = async (work: () => Promise<WeatherSetup & { recordsDeleted?: number }>, done: (setup: WeatherSetup & { recordsDeleted?: number }) => string) => {
    setBusy(true);
    setMessage(null);
    try {
      const next = await work();
      onSetup(next);
      setMessage({ tone: "success", text: done(next) });
    } catch (caught) {
      setMessage({ tone: "error", text: errorMessage(caught) });
    } finally {
      setBusy(false);
    }
  };
  const turnOn = (event: FormEvent) => {
    event.preventDefault();
    if (!ticked) return;
    void run(
      async () => {
        const answer = await api<{ setup: WeatherSetup }>("/api/farming/weather/records", { method: "POST", body: { organisationId, acknowledged: ticked } });
        setTicked(false);
        return answer.setup;
      },
      () => "Forecast records are kept from the next refresh.",
    );
  };
  const patch = (body: Record<string, unknown>) => api<{ setup: WeatherSetup & { recordsDeleted?: number } }>("/api/farming/weather/records", { method: "PATCH", body: { organisationId, ...body } }).then((answer) => answer.setup);
  return (
    <Card title="Forecast records (optional)">
      <div className={styles.body}>
        {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
        {permission.keepRecords ? (
          <>
            <dl className={styles.summary}>
              <dt>Turned on</dt>
              <dd>
                {permission.setAt ? new Date(permission.setAt).toLocaleString("en-NZ", { dateStyle: "medium", timeStyle: "short" }) : "–"}
                {permission.setByEmail ? ` by ${permission.setByEmail}` : ""}
              </dd>
              {permission.file ? (
                <>
                  <dt>Previously attached document</dt>
                  <dd>
                    <a href={`/api/farming/weather/records/file?organisationId=${encodeURIComponent(organisationId)}`} target="_blank" rel="noreferrer">
                      {permission.file.fileName}
                    </a>
                  </dd>
                </>
              ) : null}
              <dt>Records kept</dt>
              <dd>{permission.records.toLocaleString("en-NZ")} forecasts</dd>
            </dl>
            <label className={styles.check}>
              <input type="checkbox" checked={permission.combine} disabled={busy} onChange={(event) => void run(() => api<{ setup: WeatherSetup }>("/api/farming/weather", { method: "PATCH", body: { organisationId, combine: event.target.checked } }).then((answer) => answer.setup), (next) => (next.permission.combine ? "Combining is on." : "Combining is off."))} />
              <span>
                <strong>Use records in comparisons, Analytics and AI</strong>{" "}
                <InfoTip label="About combining">
                  This enables forecast vs rain gauge comparisons, Analytics and read access for your connected AI, which may send records to an external AI service. Your use remains subject to MetService&apos;s terms.
                </InfoTip>
              </span>
            </label>
            {turningOff ? (
              <Notice tone="warning">
                <div className={styles.body}>
                  <p>Turn off keeping forecast records? Combining goes off too.</p>
                  <label className={styles.check}>
                    <input type="radio" name="weather-records-off" checked={deleteRecords} onChange={() => setDeleteRecords(true)} />
                    <span>
                      Delete the {permission.records.toLocaleString("en-NZ")} kept forecasts now (recommended). MetService&apos;s terms need them deleted once you may no longer keep them.
                    </span>
                  </label>
                  <label className={styles.check}>
                    <input type="radio" name="weather-records-off" checked={!deleteRecords} onChange={() => setDeleteRecords(false)} />
                    <span>Keep them for now, and delete them later here.</span>
                  </label>
                  <span className={styles.inlineButtons}>
                    <Button
                      variant="danger"
                      size="small"
                      disabled={busy}
                      onClick={() =>
                        void run(
                          () => patch({ deleteRecords }),
                          (next) => {
                            setTurningOff(false);
                            return next.recordsDeleted ? `Records are off. ${next.recordsDeleted} kept forecasts were deleted.` : "Records are off.";
                          },
                        )
                      }
                    >
                      Turn off records
                    </Button>
                    <Button variant="secondary" size="small" onClick={() => setTurningOff(false)}>
                      Cancel
                    </Button>
                  </span>
                </div>
              </Notice>
            ) : (
              <p>
                <Button variant="secondary" onClick={() => setTurningOff(true)}>
                  Turn off records
                </Button>
              </p>
            )}
          </>
        ) : (
          <>
            {permission.records > 0 ? (
              <Notice tone="warning">
                {permission.records.toLocaleString("en-NZ")} forecast records are still kept from before.{" "}
                <Button
                  variant="danger"
                  size="small"
                  disabled={busy}
                  onClick={() => void run(() => api<{ setup: WeatherSetup & { recordsDeleted: number } }>(`/api/farming/weather/records?organisationId=${encodeURIComponent(organisationId)}`, { method: "DELETE" }).then((answer) => answer.setup), (next) => `${next.recordsDeleted ?? 0} kept forecasts were deleted.`)}
                >
                  Delete them now
                </Button>
              </Notice>
            ) : null}
            <p className={ui.muted}>Keeping records and using them with other data or external AI remain subject to <a href="https://data.metservice.com/terms-service" target="_blank" rel="noreferrer">MetService&apos;s terms</a>. This acknowledgement does not grant permission.</p>
            <label className={styles.check}>
              <input type="checkbox" checked={ticked} onChange={(event) => setTicked(event.target.checked)} />
              <span>
                <strong>I&apos;m responsible for ensuring my use complies with MetService&apos;s terms.</strong>
              </span>
            </label>
            {ticked ? (
              <form onSubmit={turnOn} className={styles.body}>
                <p className={ui.muted}>With this on, Tohyee keeps every forecast it fetches, with when it was fetched, by farm and pin. Who turned it on, and when, is recorded.</p>
                <p>
                  <Button type="submit" disabled={busy || !ticked}>
                    Keep forecast records
                  </Button>
                </p>
              </form>
            ) : null}
          </>
        )}
      </div>
    </Card>
  );
}
