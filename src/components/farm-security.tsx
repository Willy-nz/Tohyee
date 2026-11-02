"use client";

import { useEffect, useRef, useState } from "react";
import { useConfirm } from "@/components/confirm-dialog";
import { DateInput } from "@/components/date-input";
import { type MapOverlay, PaddockMap } from "@/components/farming";
import { useApiData } from "@/components/hooks";
import { PostboxScreen } from "@/components/farm-security-postbox";
import { InfoPara, InfoTip } from "@/components/info-tip";
import { Badge, Button, Card, Empty, Field, Notice, ui } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import type { Farm, FarmingSettings, Paddock } from "@/lib/farming/paddocks";
import { formatDateTime } from "@/lib/format";
import {
  type Camera,
  cameraHealth,
  CLOCK_NOTE_TEXT,
  DETECTION_LABELS,
  formatBytes,
  type SecurityAccess,
  type SecurityEvent,
  SECURITY_LEVEL_LABELS,
  type SecurityLevel,
  SECURITY_LEVELS,
} from "@/lib/security-cameras/shared";
import styles from "./farm-security.module.css";

/*
 * Farm security cameras (#508, decisions 1216-1225): Farm › More ›
 * Security. Events as photos and clips (not a table), each camera's last
 * upload, keeping and deleting, and for owners and admins the cameras,
 * their upload logins and how long media is kept. What the server allows
 * is decided there; these screens only hide what would be refused.
 */

type CamerasAnswer = { cameras: Camera[]; access: SecurityAccess; uploads: { on: boolean; why: string | null; port: number | null; ftps: boolean; publicAddress: string | null } | null };
type EventsAnswer = { events: SecurityEvent[]; access: SecurityAccess; more: boolean };
type Screen = "events" | "cameras" | "postbox" | "settings";

const mediaUrl = (organisationId: string, eventId: string, query: string) => `/api/farming/security/events/${eventId}/media?organisationId=${encodeURIComponent(organisationId)}&${query}`;

/** Always in sight on the Security pages (decision 1225): who is recorded, and what to do about it. Not legal advice. */
export function CameraPrivacyNotice() {
  return (
    <Notice tone="warning">
      These cameras record staff, contractors and visitors. Put up signs where they are, and tell your staff.{" "}
      <InfoTip label="Cameras and people's privacy">
        <InfoPara>Photos and clips of people are personal information under New Zealand&apos;s Privacy Act 2020. In general, people should know a camera is there and why: signs at the entrances and near each camera, and telling staff in writing (for example in their employment agreement or the farm induction).</InfoPara>
        <InfoPara>Use the footage for security and safety, keep it only as long as you need it (the retention setting), and let only the people who need it see it (People and roles). People can ask to see footage of themselves.</InfoPara>
        <InfoPara>Tohyee doesn&apos;t track staff, recognise faces or follow anyone. This is general information, not legal advice: the Privacy Commissioner&apos;s guidance on CCTV is the place to check.</InfoPara>
      </InfoTip>
    </Notice>
  );
}

export function FarmSecurity({ organisationId, farm, farms }: { organisationId: string; farm: Farm; farms: Farm[] }) {
  const [screen, setScreen] = useState<Screen>("events");
  const [allFarms, setAllFarms] = useState(false);
  const cameras = useApiData<CamerasAnswer>("/api/farming/security/cameras", { organisationId, farmId: allFarms ? null : farm.id });
  const access = cameras.data?.access ?? null;
  if (cameras.error) {
    return (
      <div className={styles.stack}>
        <CameraPrivacyNotice />
        <Notice tone="info">{cameras.error}</Notice>
      </div>
    );
  }
  if (!cameras.data || !access) return <p className={ui.muted}>Loading…</p>;
  const screens: Array<[Screen, string]> = [["events", "Events"], ["cameras", "Cameras"], ...(access.configure ? ([["postbox", "Post box"], ["settings", "Settings"]] as Array<[Screen, string]>) : [])];
  return (
    <div className={styles.stack}>
      <CameraPrivacyNotice />
      <div className={styles.row}>
        <div className={ui.tabs} role="group" aria-label="Security screens">
          {screens.map(([key, label]) => (
            <button key={key} type="button" aria-pressed={screen === key} className={`${ui.tab} ${screen === key ? ui.tabActive : ""}`} onClick={() => setScreen(key)}>
              {label}
            </button>
          ))}
        </div>
        {farms.length > 1 && screen !== "settings" && screen !== "postbox" ? (
          <label className={ui.checkbox}>
            <input type="checkbox" checked={allFarms} onChange={(event) => setAllFarms(event.target.checked)} /> All farms
          </label>
        ) : null}
      </div>
      <CameraHealth cameras={cameras.data.cameras} showFarm={allFarms} />
      {screen === "events" ? <EventBrowser organisationId={organisationId} farm={farm} allFarms={allFarms} cameras={cameras.data.cameras} access={access} /> : null}
      {screen === "cameras" ? <CamerasScreen organisationId={organisationId} farm={farm} allFarms={allFarms} answer={cameras.data} onChanged={cameras.reload} /> : null}
      {screen === "postbox" && access.configure ? <PostboxScreen organisationId={organisationId} onChanged={cameras.reload} /> : null}
      {screen === "settings" && access.configure ? <SettingsScreen organisationId={organisationId} farm={farm} /> : null}
    </div>
  );
}

// Health -------------------------------------------------------------------------------------

function CameraHealth({ cameras, showFarm }: { cameras: Camera[]; showFarm: boolean }) {
  const active = cameras.filter((camera) => camera.isActive);
  const [now] = useState(() => new Date());
  if (!active.length) return null;
  return (
    <section aria-label="Cameras' last uploads">
      <ul className={styles.health}>
        {active.map((camera) => {
          const health = cameraHealth(camera, now);
          return (
            <li key={camera.id} className={`${styles.healthItem} ${health.state === "quiet" ? styles.quiet : ""}`}>
              <strong>
                <span>
                  {camera.name}
                  {showFarm ? <span className={ui.muted}> · {camera.farmName}</span> : null}
                </span>
                {health.state === "ok" ? <Badge tone="green">Uploading</Badge> : health.state === "quiet" ? <Badge tone="amber">Quiet</Badge> : <Badge>Nothing yet</Badge>}
              </strong>
              <span>{health.text}</span>
              {camera.lastUploadAt ? <small className={ui.muted}>Last file {formatDateTime(camera.lastUploadAt)}</small> : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// Events -------------------------------------------------------------------------------------

function EventBrowser({ organisationId, farm, allFarms, cameras, access }: { organisationId: string; farm: Farm; allFarms: boolean; cameras: Camera[]; access: SecurityAccess }) {
  const [cameraId, setCameraId] = useState("");
  const [kind, setKind] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [keptOnly, setKeptOnly] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const query = { organisationId, farmId: allFarms ? null : farm.id, cameraId: cameraId || null, kind: kind || null, from: from || null, to: to || null, kept: keptOnly ? "1" : null };
  const first = useApiData<EventsAnswer>("/api/farming/security/events", query);
  const [more, setMore] = useState<{ key: string; events: SecurityEvent[]; more: boolean } | null>(null);
  const key = JSON.stringify(query);
  const extra = more && more.key === key ? more : null;
  const events = [...(first.data?.events ?? []), ...(extra?.events ?? [])];
  const hasMore = extra ? extra.more : (first.data?.more ?? false);
  const loadMore = async () => {
    const last = events[events.length - 1];
    if (!last) return;
    const answer = await api<EventsAnswer>("/api/farming/security/events", { query: { ...query, before: last.id } });
    setMore({ key, events: [...(extra?.events ?? []), ...answer.events], more: answer.more });
  };
  const reload = () => {
    setMore(null);
    first.reload();
  };
  const open = events.find((event) => event.id === selected) ?? null;
  return (
    <>
      <Card title="Events" description="Each photo or clip a camera sent. Newest first.">
        <div className={styles.filters}>
          <Field label="Camera">
            <select value={cameraId} onChange={(event) => setCameraId(event.target.value)}>
              <option value="">All cameras</option>
              {cameras.map((camera) => (
                <option key={camera.id} value={camera.id}>
                  {camera.name}
                  {allFarms ? ` (${camera.farmName})` : ""}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Show">
            <select value={kind} onChange={(event) => setKind(event.target.value)}>
              <option value="">Photos and clips</option>
              <option value="snapshot">Photos only</option>
              <option value="clip">Clips only</option>
            </select>
          </Field>
          <Field label="From">
            <DateInput value={from} onChange={(event) => setFrom(event.target.value)} />
          </Field>
          <Field label="To">
            <DateInput value={to} onChange={(event) => setTo(event.target.value)} />
          </Field>
          <label className={ui.checkbox}>
            <input type="checkbox" checked={keptOnly} onChange={(event) => setKeptOnly(event.target.checked)} /> Kept only
          </label>
        </div>
      </Card>
      {open ? <EventViewer organisationId={organisationId} event={open} access={access} onClose={() => setSelected(null)} onChanged={reload} /> : null}
      {first.error ? <Notice tone="error">{first.error}</Notice> : null}
      {first.loading ? <p className={ui.muted}>Loading…</p> : null}
      {first.data && !events.length ? <Empty>{cameras.length ? "No events for these choices." : "No cameras yet. An owner or admin adds them under Cameras."}</Empty> : null}
      {events.length ? (
        <ul className={styles.grid} aria-label="Camera events">
          {events.map((event) => (
            <li key={event.id}>
              <EventTile organisationId={organisationId} event={event} showFarm={allFarms} selected={event.id === selected} onOpen={() => setSelected(event.id)} />
            </li>
          ))}
        </ul>
      ) : null}
      {hasMore ? (
        <Button variant="secondary" onClick={() => void loadMore()}>
          Show older events
        </Button>
      ) : null}
    </>
  );
}

function KindBadge({ event }: { event: SecurityEvent }) {
  // A photo is only a photo: it never means a clip was recorded or saved (decision 1221).
  return event.kind === "clip" ? <Badge tone="green">Clip saved</Badge> : <Badge>Photo only</Badge>;
}

function EventTile({ organisationId, event, showFarm, selected, onOpen }: { organisationId: string; event: SecurityEvent; showFarm: boolean; selected: boolean; onOpen: () => void }) {
  return (
    <button type="button" className={`${styles.tile} ${selected ? styles.tileSelected : ""}`} onClick={onOpen} aria-label={`${event.kind === "clip" ? "Clip" : "Photo"} from ${event.cameraName}, ${formatDateTime(event.occurredAt)}${event.kept ? ", kept" : ""}`}>
      <span className={styles.thumb}>
        {event.kind === "snapshot" ? (
          // eslint-disable-next-line @next/next/no-img-element -- served by Tohyee's own media route with permission checks, not a static image
          <img src={mediaUrl(organisationId, event.id, "variant=thumbnail")} alt="" loading="lazy" />
        ) : (
          <span className={styles.play}>
            <span className={styles.playIcon} aria-hidden="true">
              ▶
            </span>
            {formatBytes(event.sizeBytes)}
          </span>
        )}
      </span>
      <span className={styles.tileText}>
        <strong>{event.cameraName}</strong>
        <span>{formatDateTime(event.occurredAt)}</span>
        {showFarm ? <span className={ui.muted}>{event.farmName}</span> : null}
        <span className={styles.badges}>
          <KindBadge event={event} />
          {event.kept ? <Badge tone="blue">Kept</Badge> : null}
          {event.clockNote !== "ok" ? <Badge tone="amber">Check time</Badge> : null}
        </span>
      </span>
    </button>
  );
}

function EventViewer({ organisationId, event, access, onClose, onChanged }: { organisationId: string; event: SecurityEvent; access: SecurityAccess; onClose: () => void; onChanged: () => void }) {
  const confirm = useConfirm();
  const [note, setNote] = useState(event.keptNote ?? "");
  const [keeping, setKeeping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      onChanged();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };
  const keep = () =>
    act(async () => {
      await api(`/api/farming/security/events/${event.id}/keep`, { method: "PUT", body: { organisationId, note } });
      setKeeping(false);
    });
  const unkeep = () => act(() => api(`/api/farming/security/events/${event.id}/keep`, { method: "DELETE", query: { organisationId } }));
  const remove = async () => {
    const sure = await confirm(`Delete this ${event.kind === "clip" ? "clip" : "photo"} from ${event.cameraName} (${formatDateTime(event.occurredAt)})? It's removed from Tohyee for good and can't be got back.`, { title: "Delete for good?", confirmLabel: "Delete", danger: true });
    if (!sure) return;
    await act(async () => {
      await api(`/api/farming/security/events/${event.id}`, { method: "DELETE", query: { organisationId } });
      onClose();
    });
  };
  const clockText = CLOCK_NOTE_TEXT[event.clockNote];
  // Opened from a tile further down: bring it into view (on a phone it's otherwise above the screen).
  const top = useRef<HTMLDivElement>(null);
  useEffect(() => {
    top.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [event.id]);
  return (
    <div ref={top} style={{ scrollMarginTop: 72 }}>
    <Card
      title={`${event.cameraName} · ${formatDateTime(event.occurredAt)}`}
      actions={
        <Button variant="secondary" size="small" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className={styles.viewer}>
        {event.kind === "clip" ? (
          <video key={event.id} className={styles.media} src={mediaUrl(organisationId, event.id, "variant=full")} controls preload="metadata" playsInline>
            Your browser can&apos;t play this clip. Download it to watch.
          </video>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element -- served by Tohyee's own media route with permission checks
          <img className={styles.media} src={mediaUrl(organisationId, event.id, "variant=full")} alt={`Photo from ${event.cameraName} at ${formatDateTime(event.occurredAt)}`} />
        )}
        <div className={styles.badges}>
          <KindBadge event={event} />
          {event.kept ? <Badge tone="blue">Kept</Badge> : null}
        </div>
        {event.kind === "snapshot" ? <p className={ui.muted}>A photo only. It doesn&apos;t mean a clip was recorded or saved.</p> : null}
        {clockText ? <Notice tone="warning">{clockText}</Notice> : null}
        <dl className={styles.facts}>
          <dt>Camera&apos;s time</dt>
          <dd>{event.cameraLocalTime ? `${event.cameraLocalTime.replace("T", " ")} (${event.cameraTimeZone})` : "Not in the file name"}</dd>
          <dt>Tohyee got it</dt>
          <dd>{formatDateTime(event.receivedAt)}</dd>
          <dt>Detected</dt>
          <dd>
            {DETECTION_LABELS[event.detection]}{" "}
            <InfoTip label="What the camera detected">Reolink&apos;s uploads don&apos;t say whether it was a person, vehicle or animal, so Tohyee doesn&apos;t guess.</InfoTip>
          </dd>
          <dt>Farm</dt>
          <dd>{event.farmName}</dd>
          <dt>File</dt>
          <dd>
            {event.fileName} · {formatBytes(event.sizeBytes)}
          </dd>
          {event.kept ? (
            <>
              <dt>Kept</dt>
              <dd>
                {event.keptNote || "No note"} ({event.keptByEmail}, {formatDateTime(event.keptAt)})
              </dd>
            </>
          ) : null}
        </dl>
        {error ? <Notice tone="error">{error}</Notice> : null}
        {keeping ? (
          <div className={styles.viewer}>
            <Field label="Why it's kept" hint="For example: ute at the gate, not ours.">
              <textarea value={note} maxLength={1000} rows={2} onChange={(entry) => setNote(entry.target.value)} />
            </Field>
            <div className={styles.row}>
              <Button disabled={busy} onClick={() => void keep()}>
                {event.kept ? "Save note" : "Keep this"}
              </Button>
              <Button variant="secondary" onClick={() => setKeeping(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className={styles.row}>
            <Button variant={event.kept ? "secondary" : "primary"} disabled={busy} onClick={() => setKeeping(true)}>
              {event.kept ? "Change note" : "Keep (incident)"}
            </Button>
            {access.download ? (
              <a className={`${ui.button} ${ui.secondary}`} href={mediaUrl(organisationId, event.id, "download=1")} download>
                Download
              </a>
            ) : null}
            {event.kept && access.delete ? (
              <Button variant="secondary" disabled={busy} onClick={() => void unkeep()}>
                Stop keeping
              </Button>
            ) : null}
            {!event.kept && access.delete ? (
              <Button variant="danger" disabled={busy} onClick={() => void remove()}>
                Delete
              </Button>
            ) : null}
          </div>
        )}
        {!event.kept ? <p className={ui.muted}>Kept events aren&apos;t removed by the clean-up.</p> : null}
      </div>
    </Card>
    </div>
  );
}

// Cameras ------------------------------------------------------------------------------------

function CamerasScreen({ organisationId, farm, allFarms, answer, onChanged }: { organisationId: string; farm: Farm; allFarms: boolean; answer: CamerasAnswer; onChanged: () => void }) {
  const { cameras, access, uploads } = answer;
  const [editing, setEditing] = useState<Camera | "new" | null>(null);
  const [login, setLogin] = useState<{ cameraName: string; username: string; password: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const confirm = useConfirm();
  const run = async (work: () => Promise<unknown>) => {
    setError(null);
    try {
      await work();
      onChanged();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };
  const makeLogin = async (camera: Camera) => {
    if (camera.uploadUsername && !(await confirm(`Make a new upload login for ${camera.name}? The old one stops working straight away, so the camera won't upload until you enter the new one in the Reolink app.`, { title: "Replace the upload login?", confirmLabel: "Make a new login" }))) return;
    await run(async () => {
      const made = await api<{ username: string; password: string }>(`/api/farming/security/cameras/${camera.id}/upload-login`, { method: "POST", body: { organisationId } });
      setLogin({ cameraName: camera.name, ...made });
    });
  };
  const archive = async (camera: Camera, active: boolean) => {
    if (!active && !(await confirm(`Archive ${camera.name}? Its upload login is removed, so it can't upload. Its photos and clips stay until they're cleaned up or deleted.`, { title: "Archive this camera?", confirmLabel: "Archive" }))) return;
    await run(() => api(`/api/farming/security/cameras/${camera.id}`, { method: "PATCH", body: { organisationId, active } }));
  };
  return (
    <>
      {access.configure && uploads && !uploads.on ? (
        <Notice tone="warning">
          Cameras have nowhere to upload yet. For 4G cameras, set up a camera post box (the Post box tab).{" "}
          <InfoTip label="Where cameras upload">
            <InfoPara>A camera post box is a small rented server cameras send to, and Tohyee collects from. It works without opening anything at home.</InfoPara>
            <InfoPara>Or, with a public address at home, the server&apos;s administrator can take uploads directly: TOHYEE_CAMERA_FTP_PORT, an FTPS certificate and ports forwarded on the router. See docs/FARM-SECURITY.md. Why direct uploads are off: {uploads.why}.</InfoPara>
          </InfoTip>
        </Notice>
      ) : null}
      {login ? (
        <Card title={`Upload login for ${login.cameraName}`} description="Copy these into the Reolink app now. The password isn't shown again.">
          <dl className={styles.login}>
            <dt>FTP server</dt>
            <dd>{uploads?.publicAddress ?? "This server's public address"}</dd>
            <dt>Port</dt>
            <dd>{uploads?.port ?? "As set on the server"}</dd>
            <dt>User name</dt>
            <dd>{login.username}</dd>
            <dt>Password</dt>
            <dd>{login.password}</dd>
          </dl>
          <p>
            In the Reolink app: the camera › Settings › FTP. Turn on <strong>FTPS only</strong> (encrypted), transport mode <strong>Auto</strong> or <strong>Pasv</strong>, and Overwrite <strong>No</strong>.{" "}
            <InfoTip label="Setting up the camera">
              <InfoPara>Leave Directory empty (or any folder name: Tohyee only reads the file names). Choose what to upload: video, pictures or both. For a battery camera, start with motion only, to save battery and mobile data.</InfoPara>
              <InfoPara>Tohyee only takes uploads: the camera can&apos;t read or delete anything. None of this has been tried with a real Reolink camera yet, so check the first few uploads arrive.</InfoPara>
            </InfoTip>
          </p>
          <Button variant="secondary" onClick={() => setLogin(null)}>
            I&apos;ve copied it
          </Button>
        </Card>
      ) : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {editing ? (
        <CameraForm organisationId={organisationId} farm={farm} camera={editing === "new" ? null : editing} cameras={cameras} onDone={() => {
          setEditing(null);
          onChanged();
        }} onCancel={() => setEditing(null)} />
      ) : null}
      <Card
        title={`Cameras (${cameras.filter((camera) => camera.isActive).length})`}
        description={allFarms ? "On every farm you work on." : `On ${farm.name}.`}
        actions={
          access.configure && !editing && !allFarms ? (
            <Button size="small" onClick={() => setEditing("new")}>
              Add a camera
            </Button>
          ) : null
        }
      >
        {!cameras.length ? <Empty>No cameras yet.{access.configure ? " Add one, then make its upload login." : ""}</Empty> : null}
        <ul className={styles.cameraList}>
          {cameras.map((camera) => (
            <li key={camera.id} className={styles.cameraItem}>
              <div className={styles.row}>
                <strong>{camera.name}</strong>
                {camera.model ? <span className={ui.muted}>{camera.model}</span> : null}
                {allFarms ? <span className={ui.muted}>· {camera.farmName}</span> : null}
                {!camera.isActive ? <Badge>Archived</Badge> : null}
                {camera.isActive && access.configure ? camera.uploadUsername ? <Badge tone="green">Upload login made</Badge> : <Badge tone="amber">No upload login</Badge> : null}
              </div>
              <span className={ui.muted}>
                {camera.eventCount} event{camera.eventCount === 1 ? "" : "s"} · clock in {camera.timeZone} · warns after {camera.quietAlertHours} hours quiet{camera.point ? " · on the map" : ""}
              </span>
              {camera.notes ? <span>{camera.notes}</span> : null}
              {access.configure && camera.uploadUsername ? (
                <span className={ui.muted}>
                  User name <code>{camera.uploadUsername}</code>, made {formatDateTime(camera.uploadLoginMadeAt)}
                </span>
              ) : null}
              {access.configure ? (
                <div className={styles.row}>
                  {camera.isActive ? (
                    <>
                      <Button size="small" variant="secondary" onClick={() => setEditing(camera)}>
                        Change
                      </Button>
                      <Button size="small" variant="secondary" onClick={() => void makeLogin(camera)}>
                        {camera.uploadUsername ? "New upload login" : "Make upload login"}
                      </Button>
                      <Button size="small" variant="secondary" onClick={() => void archive(camera, false)}>
                        Archive
                      </Button>
                    </>
                  ) : (
                    <Button size="small" variant="secondary" onClick={() => void archive(camera, true)}>
                      Restore
                    </Button>
                  )}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}

function CameraForm({ organisationId, farm, camera, cameras, onDone, onCancel }: { organisationId: string; farm: Farm; camera: Camera | null; cameras: Camera[]; onDone: () => void; onCancel: () => void }) {
  const [form, setForm] = useState({ name: camera?.name ?? "", model: camera?.model ?? "Reolink Go PT Plus", notes: camera?.notes ?? "", timeZone: camera?.timeZone ?? "Pacific/Auckland", quietAlertHours: String(camera?.quietAlertHours ?? 24) });
  const [point, setPoint] = useState<[number, number] | null>(camera?.point ?? null);
  const [placing, setPlacing] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const paddocks = useApiData<{ paddocks: Paddock[] }>(`/api/farming/farms/${farm.id}/paddocks`, { organisationId });
  const imageryKey = useApiData<{ settings: FarmingSettings }>("/api/farming/settings", { organisationId }).data?.settings.imageryKey ?? null;
  const overlays: MapOverlay[] = cameras
    .filter((entry) => entry.point && entry.isActive && entry.farmId === farm.id && entry.id !== camera?.id)
    .map((entry) => ({ id: entry.id, label: entry.name, tone: "effluent", point: entry.point, marker: "dot", short: entry.name.slice(0, 12) }));
  if (point) overlays.push({ id: "this", label: form.name || "This camera", tone: "warning", point, marker: "dot", short: (form.name || "Here").slice(0, 12) });
  const locate = () => {
    if (!navigator.geolocation) return setStatus("This phone or browser can't share its location.");
    setStatus("Finding where you are…");
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setStatus(null);
        setPoint([position.coords.longitude, position.coords.latitude]);
      },
      () => setStatus("The location wasn't shared."),
      { enableHighAccuracy: true, timeout: 15_000 },
    );
  };
  const save = async () => {
    setError(null);
    try {
      const body = { organisationId, farmId: farm.id, ...form, quietAlertHours: Number(form.quietAlertHours), point };
      if (camera) await api(`/api/farming/security/cameras/${camera.id}`, { method: "PATCH", body });
      else await api("/api/farming/security/cameras", { method: "POST", body });
      onDone();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };
  const set = (key: keyof typeof form) => (event: { target: { value: string } }) => setForm({ ...form, [key]: event.target.value });
  return (
    <Card title={camera ? `Change ${camera.name}` : `Add a camera to ${farm.name}`}>
      <div className={styles.viewer}>
        <Field label="Name" hint="As you call it, e.g. Front gate.">
          <input value={form.name} maxLength={60} onChange={set("name")} />
        </Field>
        <Field label="Model">
          <input value={form.model} maxLength={60} onChange={set("model")} />
        </Field>
        <Field label="Camera clock's time zone" hint="As set in the Reolink app. Used to read the time in the file names.">
          <input value={form.timeZone} maxLength={64} onChange={set("timeZone")} />
        </Field>
        <Field label="Warn after this many hours with no uploads" hint="A quiet camera may only mean nothing moved.">
          <input type="number" min={1} max={720} value={form.quietAlertHours} onChange={set("quietAlertHours")} />
        </Field>
        <Field label="Notes">
          <textarea value={form.notes} maxLength={1000} rows={2} onChange={set("notes")} />
        </Field>
        <div>
          <strong>Place on the map</strong> <span className={ui.muted}>{point ? "Placed." : "Not placed."}</span>
          <div className={styles.row}>
            <Button size="small" variant="secondary" onClick={() => setPlacing(!placing)}>
              {placing ? "Stop" : "Tap the map"}
            </Button>
            <Button size="small" variant="secondary" onClick={locate}>
              Where I&apos;m standing
            </Button>
            {point ? (
              <Button size="small" variant="secondary" onClick={() => setPoint(null)}>
                Remove from map
              </Button>
            ) : null}
          </div>
          {status ? <p className={ui.muted}>{status}</p> : null}
          {placing ? <Notice tone="info">Tap the map where the camera is.</Notice> : null}
          {paddocks.data ? (
            <PaddockMap
              paddocks={paddocks.data.paddocks}
              selected={null}
              imageryKey={imageryKey}
              overlays={overlays}
              label={`Map of ${farm.name} with ${overlays.length} cameras`}
              onMapTap={(position) => {
                if (!placing) return;
                setPoint([position[0], position[1]]);
                setPlacing(false);
              }}
            />
          ) : null}
        </div>
        {error ? <Notice tone="error">{error}</Notice> : null}
        <div className={styles.row}>
          <Button onClick={() => void save()}>{camera ? "Save" : "Add camera"}</Button>
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    </Card>
  );
}

// Settings -----------------------------------------------------------------------------------

function SettingsScreen({ organisationId, farm }: { organisationId: string; farm: Farm }) {
  const settings = useApiData<{ settings: { retentionDays: number; isDefault: boolean } }>("/api/farming/security/settings", { organisationId, farmId: farm.id });
  const [days, setDays] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const shown = days ?? String(settings.data?.settings.retentionDays ?? "");
  const save = async () => {
    setMessage(null);
    try {
      await api("/api/farming/security/settings", { method: "PUT", body: { organisationId, farmId: farm.id, retentionDays: Number(shown) } });
      setDays(null);
      settings.reload();
      setMessage({ tone: "success", text: "Saved." });
    } catch (caught) {
      setMessage({ tone: "error", text: errorMessage(caught) });
    }
  };
  return (
    <>
      <Card title={`How long media is kept on ${farm.name}`} description="Photos and clips older than this are removed every hour, unless they're kept.">
        <Field label="Keep for (days)" hint={settings.data?.settings.isDefault ? "Not chosen yet: 30 days." : undefined}>
          <input type="number" min={1} max={3650} value={shown} onChange={(event) => setDays(event.target.value)} />
        </Field>
        {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
        <Button onClick={() => void save()}>Save</Button>
      </Card>
      <CameraAccessNote />
    </>
  );
}

function CameraAccessNote() {
  return (
    <Card title="Who sees the cameras" description="Owners and admins see everything. Choose anyone else on People and roles.">
      <p className={ui.muted}>
        <a href="/operations/members">People and roles</a>
      </p>
    </Card>
  );
}

// People and roles ----------------------------------------------------------------------------

type AccessAnswer = { farming: boolean; access: Array<{ userId: string; level: SecurityLevel }> };
type MemberLike = { userId: string; displayName: string; role: string };

/** Camera access for each member (decision 1220); on People and roles when Farming is on. */
export function MemberCameraAccess({ organisationId, members }: { organisationId: string; members: MemberLike[] }) {
  const loaded = useApiData<AccessAnswer>("/api/farming/security/access", { organisationId });
  const [error, setError] = useState<string | null>(null);
  if (!loaded.data || !loaded.data.farming) return null;
  const byUser = new Map(loaded.data.access.map((entry) => [entry.userId, entry.level]));
  const people = members.filter((member) => ["farm_worker", "viewer", "bookkeeper"].includes(member.role));
  const save = async (userId: string, level: string) => {
    setError(null);
    try {
      await api("/api/farming/security/access", { method: "PUT", body: { organisationId, userId, level } });
      loaded.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };
  return (
    <Card title="Security cameras" description="Owners and admins see, download and delete camera media. Anyone else sees nothing unless chosen here, and only on their farms.">
      {error ? <Notice tone="error">{error}</Notice> : null}
      {!people.length ? <p className={ui.muted}>No farm staff, viewers or bookkeepers to choose.</p> : null}
      <ul className={styles.cameraList}>
        {people.map((member) => (
          <li key={member.userId}>
            <Field label={member.displayName}>
              <select value={byUser.get(member.userId) ?? "none"} onChange={(event) => void save(member.userId, event.target.value)}>
                <option value="none">No camera access</option>
                {SECURITY_LEVELS.map((level) => (
                  <option key={level} value={level}>
                    {SECURITY_LEVEL_LABELS[level]}
                  </option>
                ))}
              </select>
            </Field>
          </li>
        ))}
      </ul>
    </Card>
  );
}
