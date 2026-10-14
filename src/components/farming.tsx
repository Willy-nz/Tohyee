"use client";

import { DateInput } from "@/components/date-input";
import Link from "next/link";
import { useRef, useState } from "react";
import { useApiData } from "@/components/hooks";
import { PaddockRecords } from "@/components/soil";
import { Badge, Button, Card, Empty, Field, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage } from "@/lib/client/api";
import { formatDate, formatDateTime, todayInBrowser } from "@/lib/format";
import { areaHectares, bounds, fitBox, hectaresText, linzAerialTileUrl, mapViewAt, outlinesOverlap, type PaddockGeometry, parseGeometry, type Position } from "@/lib/farming/geometry";
import type { BoundaryVersion, Farm, FarmingSettings, ImportPreview, Paddock } from "@/lib/farming/paddocks";

/**
 * Farming, stage 1 (#249): farms, paddocks with their effective and mapped
 * areas, a map of their boundaries, splits and merges that keep history,
 * and importing shapes from GeoJSON with a preview.
 */

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

function useFarms(organisationId: string) {
  return useApiData<{ farms: Farm[] }>("/api/farming/farms", { organisationId });
}

// The map ------------------------------------------------------------------------------------

const MAP_WIDTH = 800;
const MAP_HEIGHT = 520;

function outlines(geometry: PaddockGeometry): Position[][] {
  return geometry.type === "Polygon" ? [geometry.coordinates[0]] : geometry.coordinates.map((polygon) => polygon[0]);
}

/** LINZ's attribution, as its Basemaps guide asks for (with links), shown whenever its imagery is. */
export function LinzAttribution() {
  return (
    <p className={ui.muted}>
      Imagery ©{" "}
      <a href="https://www.linz.govt.nz/linz-copyright" target="_blank" rel="noreferrer">
        LINZ CC BY 4.0
      </a>{" "}
      ©{" "}
      <a href="https://www.linz.govt.nz/data/linz-data/linz-basemaps/data-attribution" target="_blank" rel="noreferrer">
        Imagery Basemap contributors
      </a>
      . Imagery shows the ground, not ownership: paddock lines aren&apos;t legal boundaries.
    </p>
  );
}

/** New Zealand, for a farm with no shapes yet. */
const NZ_VIEW = { centre: [172.6, -41.3] as Position, zoom: 4.6 };
const MIN_ZOOM = 3;
const MAX_ZOOM = 19;

/**
 * The paddocks' outlines to scale, north up, in Web Mercator, with zoom and
 * pan. With a LINZ Basemaps key, aerial imagery is drawn underneath, loaded
 * by the browser straight from LINZ (nothing is stored by Tohyee). While
 * `drawing` is set, a tap adds a corner (`onMapTap`) instead of choosing a
 * paddock.
 */
export function PaddockMap({
  paddocks,
  selected,
  onSelect,
  imageryKey,
  drawing,
  onMapTap,
}: {
  paddocks: Paddock[];
  selected: string | null;
  onSelect?: (id: string) => void;
  imageryKey?: string | null;
  drawing?: Position[] | null;
  onMapTap?: (position: Position) => void;
}) {
  const [moved, setMoved] = useState<{ centre: Position; zoom: number } | null>(null);
  const [failed, setFailed] = useState<{ key: string; count: number }>({ key: "", count: 0 });
  const [locating, setLocating] = useState<string | null>(null);
  const drag = useRef<{ x: number; y: number; centre: Position; moved: boolean } | null>(null);
  // A click follows the end of a drag: it mustn't also choose a paddock.
  const dragged = useRef(false);
  const svg = useRef<SVGSVGElement | null>(null);
  const shaped = paddocks.filter((paddock) => paddock.geometry);
  const box = bounds(shaped.map((paddock) => paddock.geometry!));
  const imagery = Boolean(imageryKey);
  if (!box && !drawing && !imagery) return <Empty>No paddock shapes yet. Import a file of your paddock shapes (GeoJSON, KML or a shapefile), or draw them, to see them here.</Empty>;
  const fitted = box ? fitBox(box, MAP_WIDTH, MAP_HEIGHT) : NZ_VIEW;
  const current = moved ?? fitted;
  const view = mapViewAt(current.centre, current.zoom, MAP_WIDTH, MAP_HEIGHT);
  const viewKey = `${view.centre.join(",")}@${view.zoom}`;
  const failedHere = failed.key === viewKey ? failed.count : 0;
  const zoomBy = (step: number) => setMoved({ centre: current.centre, zoom: Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, current.zoom + step)) });
  const toDrawing = (event: { clientX: number; clientY: number }): [number, number] => {
    const rect = svg.current!.getBoundingClientRect();
    return [((event.clientX - rect.left) * MAP_WIDTH) / rect.width, ((event.clientY - rect.top) * MAP_HEIGHT) / rect.height];
  };
  const locate = () => {
    if (!navigator.geolocation) return setLocating("This browser can't share its location.");
    setLocating("Finding where you are…");
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLocating(null);
        setMoved({ centre: [position.coords.longitude, position.coords.latitude], zoom: 16 });
      },
      () => setLocating("The location wasn't shared, so the map didn't move."),
      { enableHighAccuracy: true, timeout: 15_000 },
    );
  };
  const control: React.CSSProperties = { minWidth: 32, height: 32, padding: "0 8px", borderRadius: 8, border: "1px solid #c4ccd8", background: "#ffffff", color: "#1d2733", fontSize: 13, fontWeight: 600, cursor: "pointer", boxShadow: "0 1px 2px rgba(0, 0, 0, 0.15)" };
  return (
    <>
      <div style={{ position: "relative" }}>
        <svg
          ref={svg}
          viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`}
          role="img"
          aria-label={imagery ? "Map of the paddocks over aerial imagery" : "Map of the paddocks"}
          style={{ width: "100%", height: "auto", background: imagery ? "#5b6b4e" : "var(--surface-muted, #eef3ea)", borderRadius: 10, touchAction: "none", cursor: drawing ? "crosshair" : "grab", display: "block" }}
          onPointerDown={(event) => {
            const [x, y] = toDrawing(event);
            drag.current = { x, y, centre: current.centre, moved: false };
          }}
          onPointerMove={(event) => {
            if (!drag.current || event.buttons === 0) return;
            const [x, y] = toDrawing(event);
            const dx = x - drag.current.x;
            const dy = y - drag.current.y;
            if (!drag.current.moved && Math.hypot(dx, dy) < 6) return;
            drag.current.moved = true;
            const start = mapViewAt(drag.current.centre, current.zoom, MAP_WIDTH, MAP_HEIGHT);
            setMoved({ centre: start.unproject([MAP_WIDTH / 2 - dx, MAP_HEIGHT / 2 - dy]), zoom: current.zoom });
          }}
          onPointerUp={(event) => {
            const tap = drag.current && !drag.current.moved;
            dragged.current = Boolean(drag.current?.moved);
            drag.current = null;
            if (tap && drawing && onMapTap) onMapTap(view.unproject(toDrawing(event)));
          }}
          onPointerLeave={() => {
            drag.current = null;
          }}
        >
          {imagery
            ? view.tiles.map((tile) => (
                <image
                  key={`${tile.z}/${tile.x}/${tile.y}`}
                  href={linzAerialTileUrl(tile, imageryKey!)}
                  x={tile.left}
                  y={tile.top}
                  // A hair larger, so no seams show between scaled tiles.
                  width={tile.size + 0.5}
                  height={tile.size + 0.5}
                  preserveAspectRatio="none"
                  onError={() => setFailed((was) => ({ key: viewKey, count: (was.key === viewKey ? was.count : 0) + 1 }))}
                />
              ))
            : null}
          {shaped.map((paddock) => {
            const rings = outlines(paddock.geometry!);
            const path = rings.map((ring) => `M${ring.map((point) => view.project(point).map((value) => value.toFixed(1)).join(",")).join("L")}Z`).join(" ");
            const ring = rings[0];
            const xs = ring.map((point) => view.project(point)[0]);
            const ys = ring.map((point) => view.project(point)[1]);
            const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
            const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
            const isSelected = paddock.id === selected;
            const fill = imagery ? (isSelected ? "rgba(255, 214, 10, 0.35)" : "rgba(255, 255, 255, 0.08)") : isSelected ? "#9ccf7a" : "#c9e3b4";
            const stroke = imagery ? (isSelected ? "#ffd60a" : "#ffffff") : isSelected ? "#1f5fae" : "#4f7a3a";
            return (
              <g
                key={paddock.id}
                onClick={onSelect && !drawing ? () => (dragged.current ? undefined : onSelect(paddock.id)) : undefined}
                style={{ cursor: onSelect && !drawing ? "pointer" : undefined }}
              >
                <title>{`${paddock.name}: ${paddock.effectiveHa ?? "?"} ha effective, ${paddock.mappedHa} ha mapped`}</title>
                <path d={path} fill={fill} stroke={stroke} strokeWidth={isSelected ? 3 : 1.5} fillRule="evenodd" />
                <text
                  x={cx}
                  y={cy}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fontSize={14}
                  fontWeight={600}
                  fill={imagery ? "#ffffff" : "#203a18"}
                  stroke={imagery ? "rgba(0, 0, 0, 0.7)" : "none"}
                  strokeWidth={imagery ? 3 : 0}
                  paintOrder="stroke"
                  style={{ pointerEvents: "none" }}
                >
                  {paddock.name}
                </text>
              </g>
            );
          })}
          {drawing && drawing.length > 0 ? (
            <g style={{ pointerEvents: "none" }}>
              {drawing.length > 2 ? (
                <polygon points={drawing.map((point) => view.project(point).join(",")).join(" ")} fill="rgba(255, 140, 0, 0.25)" stroke="none" />
              ) : null}
              <polyline points={drawing.map((point) => view.project(point).join(",")).join(" ")} fill="none" stroke="#ff8c00" strokeWidth={3} />
              {drawing.length > 2 ? (
                <line
                  x1={view.project(drawing[drawing.length - 1])[0]}
                  y1={view.project(drawing[drawing.length - 1])[1]}
                  x2={view.project(drawing[0])[0]}
                  y2={view.project(drawing[0])[1]}
                  stroke="#ff8c00"
                  strokeWidth={2}
                  strokeDasharray="6 4"
                />
              ) : null}
              {drawing.map((point, index) => {
                const [x, y] = view.project(point);
                return <circle key={index} cx={x} cy={y} r={index === 0 ? 6 : 4.5} fill={index === 0 ? "#ff8c00" : "#ffffff"} stroke="#ff8c00" strokeWidth={2} />;
              })}
            </g>
          ) : null}
        </svg>
        <div style={{ position: "absolute", top: 8, right: 8, display: "flex", gap: 4 }}>
          <button type="button" style={control} aria-label="Zoom in" onClick={() => zoomBy(1)}>
            +
          </button>
          <button type="button" style={control} aria-label="Zoom out" onClick={() => zoomBy(-1)}>
            −
          </button>
          {moved ? (
            <button type="button" style={control} onClick={() => setMoved(null)}>
              Fit
            </button>
          ) : null}
          <button type="button" style={control} onClick={locate}>
            My location
          </button>
        </div>
      </div>
      {locating ? <p className={ui.muted}>{locating}</p> : null}
      {imagery ? <LinzAttribution /> : null}
      {imagery && failedHere > 0 ? (
        <Notice tone="warning">
          {failedHere === view.tiles.length ? "The aerial imagery didn't load." : "Some of the aerial imagery didn't load."} LINZ may be unavailable, there may be no imagery this close, or the key may have expired (standard LINZ keys last 90 days). An admin can change the key below.
        </Notice>
      ) : null}
    </>
  );
}

// Farms and paddocks ------------------------------------------------------------------------

export function FarmingHome({ organisationId }: { organisationId: string }) {
  const { can } = useWorkspace();
  const farms = useFarms(organisationId);
  const settings = useApiData<{ settings: FarmingSettings }>("/api/farming/settings", { organisationId });
  const [farmId, setFarmId] = useState<string | null>(null);
  if (farms.error) return <Notice tone="error">{farms.error}</Notice>;
  if (!farms.data) return <p className={ui.muted}>Loading…</p>;
  const active = farms.data.farms.filter((farm) => farm.isActive);
  const farm = active.find((entry) => entry.id === farmId) ?? active[0] ?? null;
  return (
    <>
      {active.length > 1 ? (
        <div className={ui.tabs} role="tablist" aria-label="Farms">
          {active.map((entry) => (
            <button key={entry.id} type="button" role="tab" aria-selected={entry.id === farm?.id} className={`${ui.tab} ${entry.id === farm?.id ? ui.tabActive : ""}`} onClick={() => setFarmId(entry.id)}>
              {entry.name}
            </button>
          ))}
        </div>
      ) : null}
      {farm ? <FarmView key={farm.id} organisationId={organisationId} farm={farm} imageryKey={settings.data?.settings.imageryKey ?? null} onChanged={() => farms.reload()} /> : null}
      {can("bookkeeper") ? <AddFarm organisationId={organisationId} first={active.length === 0} onSaved={() => farms.reload()} /> : null}
      {can("admin") && settings.data ? <ImagerySettings organisationId={organisationId} imageryKey={settings.data.settings.imageryKey} onSaved={() => settings.reload()} /> : null}
    </>
  );
}

/** An admin adds the organisation's own LINZ Basemaps key; Tohyee doesn't ship one. */
function ImagerySettings({ organisationId, imageryKey, onSaved }: { organisationId: string; imageryKey: string | null; onSaved: () => void }) {
  const [key, setKey] = useState("");
  const { busy, error, run } = useRun();
  const save = (value: string | null) =>
    void run(
      () => api("/api/farming/settings", { method: "PATCH", body: { organisationId, imageryKey: value } }),
      () => {
        setKey("");
        onSaved();
      },
    );
  return (
    <Card
      title="Aerial imagery"
      description="Aerial photos from LINZ Basemaps, currently free under LINZ's terms of use. Get an API key at basemaps.linz.govt.nz (a standard key lasts 90 days; LINZ issues longer-lasting developer keys on request) and paste it here. The tiles load in each person's browser straight from LINZ, so everyone who can see the map can see the key."
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      {imageryKey ? <p>A key ending {imageryKey.slice(-4)} is set.</p> : null}
      <div className={ui.inlineForm}>
        <Field label={imageryKey ? "New key" : "LINZ Basemaps API key"}>
          <input value={key} autoComplete="off" spellCheck={false} maxLength={128} onChange={(event) => setKey(event.target.value)} />
        </Field>
        <Button disabled={busy || !key.trim()} onClick={() => save(key.trim())}>
          Save key
        </Button>
        {imageryKey ? (
          <Button variant="secondary" disabled={busy} onClick={() => save(null)}>
            Remove key
          </Button>
        ) : null}
      </div>
      <p className={ui.muted}>
        <a href="https://www.linz.govt.nz/guidance/data-service/linz-basemaps-guide/linz-basemaps-terms-use" target="_blank" rel="noreferrer">
          LINZ Basemaps terms of use
        </a>
      </p>
    </Card>
  );
}

/** The controls under the map while a paddock is being drawn: corners so far, its area, and saving it. */
function DrawPaddock({
  organisationId,
  farmId,
  paddock,
  others,
  points,
  onUndo,
  onClear,
  onCancel,
  onSaved,
}: {
  organisationId: string;
  farmId: string;
  paddock: Paddock | null;
  others: Paddock[];
  points: Position[];
  onUndo: () => void;
  onClear: () => void;
  onCancel: () => void;
  onSaved: (paddockId: string) => void;
}) {
  const [name, setName] = useState("");
  const [effectiveHa, setEffectiveHa] = useState("");
  const { busy, error, run } = useRun();
  let geometry: PaddockGeometry | null = null;
  let problem: string | null = null;
  if (points.length >= 3) {
    try {
      geometry = parseGeometry({ type: "Polygon", coordinates: [[...points, points[0]]] });
    } catch (caught) {
      problem = caught instanceof Error ? caught.message.replace("The shape's outline", "The outline") : "The outline isn't a paddock shape.";
    }
  }
  const overlaps = geometry ? others.filter((other) => other.geometry && outlinesOverlap(geometry!, other.geometry)).map((other) => other.name) : [];
  const save = () =>
    void run(
      async () => {
        if (paddock) {
          await api(`/api/farming/paddocks/${paddock.id}/boundary`, { method: "POST", body: { organisationId, geometry, source: "Drawn in Tohyee" } });
          return paddock.id;
        }
        const result = await api<{ paddock: Paddock }>(`/api/farming/farms/${farmId}/paddocks`, { method: "POST", body: { organisationId, name, effectiveHa: effectiveHa || null, geometry } });
        return result.paddock.id;
      },
      onSaved,
    );
  return (
    <div style={{ marginTop: 12 }}>
      <p>
        <strong>{paddock ? `Redrawing ${paddock.name}.` : "Drawing a new paddock."}</strong> Tap the map at each corner, in order around the paddock. Drag to move the map, and zoom in for accuracy.{" "}
        {points.length === 0 ? "" : `${points.length} corner${points.length === 1 ? "" : "s"}`}
        {geometry ? `, ${hectaresText(areaHectares(geometry))} ha.` : points.length > 0 ? "." : ""}
      </p>
      {problem ? <Notice tone="warning">{problem} Undo the last corner, or clear and start again.</Notice> : null}
      {overlaps.length > 0 ? (
        <Notice tone="warning">
          It overlaps {overlaps.length === 1 ? "paddock" : "paddocks"} {overlaps.join(", ")}. You can still save it if that&apos;s right.
        </Notice>
      ) : null}
      {paddock?.geometry ? <p className={ui.muted}>The current boundary is kept in the paddock&apos;s history; the new one becomes current.</p> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.inlineForm}>
        {paddock ? null : (
          <>
            <Field label="Paddock name">
              <input value={name} maxLength={60} onChange={(event) => setName(event.target.value)} />
            </Field>
            <Field label="Effective ha" hint="The area you farm">
              <input inputMode="decimal" size={8} value={effectiveHa} onChange={(event) => setEffectiveHa(event.target.value)} />
            </Field>
          </>
        )}
        <Button disabled={busy || !geometry || (!paddock && !name.trim())} onClick={save}>
          {paddock ? "Save boundary" : "Save paddock"}
        </Button>
        <Button variant="secondary" disabled={points.length === 0} onClick={onUndo}>
          Undo corner
        </Button>
        <Button variant="secondary" disabled={points.length === 0} onClick={onClear}>
          Clear
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function AddFarm({ organisationId, first, onSaved }: { organisationId: string; first: boolean; onSaved: () => void }) {
  const [name, setName] = useState("");
  const { busy, error, run } = useRun();
  return (
    <Card title={first ? "Add your farm" : "Add another farm"} description="A farm holds its paddocks. Use one per property or block you manage separately.">
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.inlineForm}>
        <Field label="Farm name">
          <input value={name} maxLength={100} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Button
          onClick={() =>
            void run(
              () => api("/api/farming/farms", { method: "POST", body: { organisationId, name } }),
              () => {
                setName("");
                onSaved();
              },
            )
          }
          disabled={busy || !name.trim()}
        >
          Add farm
        </Button>
      </div>
    </Card>
  );
}

function FarmView({ organisationId, farm, imageryKey, onChanged }: { organisationId: string; farm: Farm; imageryKey: string | null; onChanged: () => void }) {
  const { can } = useWorkspace();
  const [showRetired, setShowRetired] = useState(false);
  const [showImagery, setShowImagery] = useState(true);
  const paddocks = useApiData<{ paddocks: Paddock[] }>(`/api/farming/farms/${farm.id}/paddocks`, { organisationId, includeRetired: showRetired ? "true" : null });
  const [selected, setSelected] = useState<string | null>(null);
  const [drawing, setDrawing] = useState<{ paddock: Paddock | null; points: Position[] } | null>(null);
  const list = paddocks.data?.paddocks ?? [];
  const active = list.filter((paddock) => paddock.status === "active");
  const reload = () => {
    paddocks.reload();
    onChanged();
  };
  return (
    <>
      <Card
        title={farm.name}
        description={`${farm.activePaddocks} paddock${farm.activePaddocks === 1 ? "" : "s"}, ${farm.effectiveHa} ha effective, ${farm.mappedHa} ha mapped.`}
        actions={
          <>
            {imageryKey ? (
              <label className={ui.checkbox}>
                <input type="checkbox" checked={showImagery} onChange={(event) => setShowImagery(event.target.checked)} /> Aerial imagery
              </label>
            ) : null}
            {can("bookkeeper") && !drawing ? (
              <Button variant="secondary" onClick={() => (setSelected(null), setDrawing({ paddock: null, points: [] }))}>
                Draw a paddock
              </Button>
            ) : null}
            {can("bookkeeper") ? (
              <Link className={`${ui.button} ${ui.secondary}`} href={`/operations/farming/import?farm=${farm.id}`}>
                Import paddock shapes
              </Link>
            ) : null}
          </>
        }
      >
        {paddocks.error ? <Notice tone="error">{paddocks.error}</Notice> : null}
        <PaddockMap
          paddocks={active}
          selected={drawing?.paddock?.id ?? selected}
          onSelect={setSelected}
          imageryKey={showImagery ? imageryKey : null}
          drawing={drawing?.points ?? null}
          onMapTap={(point) => setDrawing((was) => (was ? { ...was, points: [...was.points, point] } : was))}
        />
        {drawing ? (
          <DrawPaddock
            organisationId={organisationId}
            farmId={farm.id}
            paddock={drawing.paddock}
            others={active.filter((paddock) => paddock.id !== drawing.paddock?.id)}
            points={drawing.points}
            onUndo={() => setDrawing({ ...drawing, points: drawing.points.slice(0, -1) })}
            onClear={() => setDrawing({ ...drawing, points: [] })}
            onCancel={() => setDrawing(null)}
            onSaved={(id) => {
              setDrawing(null);
              setSelected(id);
              reload();
            }}
          />
        ) : (
          <p className={ui.muted}>
            Paddock outlines to scale, north up. Drag to move the map, and tap a paddock for its details.
            {imageryKey ? null : " An admin can add a LINZ Basemaps key below to show aerial imagery behind them."}
          </p>
        )}
      </Card>
      {selected && !drawing ? (
        <PaddockPanel
          key={selected}
          organisationId={organisationId}
          paddockId={selected}
          onChanged={reload}
          onClose={() => setSelected(null)}
          onRedraw={(paddock) => setDrawing({ paddock, points: [] })}
        />
      ) : null}
      <Card
        title="Paddocks"
        description="Plans use each paddock's effective area, the area you farm. The mapped area is worked out from its boundary."
        actions={
          <label className={ui.checkbox}>
            <input type="checkbox" checked={showRetired} onChange={(event) => setShowRetired(event.target.checked)} /> Show retired
          </label>
        }
      >
        {paddocks.data && list.length === 0 ? <Empty>No paddocks yet. Add one below or import a file of their shapes.</Empty> : null}
        {list.length > 0 ? (
          <div className={ui.tableWrap}>
            <table className={`${ui.table} ${ui.stackOnPhone}`}>
              <thead>
                <tr>
                  <th>Paddock</th>
                  <th className={ui.num}>Effective ha</th>
                  <th className={ui.num}>Mapped ha</th>
                  <th>Boundary from</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {list.map((paddock) => (
                  <tr key={paddock.id}>
                    <td data-label="Paddock">
                      <strong>{paddock.name}</strong>
                      {paddock.status === "retired" ? (
                        <>
                          {" "}
                          <Badge tone="neutral">Retired {formatDate(paddock.retiredOn!)}</Badge>
                        </>
                      ) : null}
                    </td>
                    <td data-label="Effective ha" className={ui.num}>
                      {paddock.effectiveHa ?? <span className={ui.muted}>Not entered</span>}
                    </td>
                    <td data-label="Mapped ha" className={ui.num}>
                      {paddock.mappedHa ?? <span className={ui.muted}>No boundary</span>}
                    </td>
                    <td data-label="Boundary from">{paddock.boundarySource ?? ""}</td>
                    <td>
                      <Button size="small" variant="secondary" onClick={() => setSelected(paddock.id)}>
                        Details
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {can("bookkeeper") ? <AddPaddock organisationId={organisationId} farmId={farm.id} onAdded={reload} /> : null}
      </Card>
    </>
  );
}

function AddPaddock({ organisationId, farmId, onAdded }: { organisationId: string; farmId: string; onAdded: () => void }) {
  const [name, setName] = useState("");
  const [effectiveHa, setEffectiveHa] = useState("");
  const { busy, error, run } = useRun();
  return (
    <>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.inlineForm}>
        <Field label="New paddock">
          <input value={name} maxLength={60} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label="Effective ha">
          <input inputMode="decimal" value={effectiveHa} onChange={(event) => setEffectiveHa(event.target.value)} />
        </Field>
        <Button
          onClick={() =>
            void run(
              () => api(`/api/farming/farms/${farmId}/paddocks`, { method: "POST", body: { organisationId, name, effectiveHa: effectiveHa || null } }),
              () => {
                setName("");
                setEffectiveHa("");
                onAdded();
              },
            )
          }
          disabled={busy || !name.trim()}
        >
          Add paddock
        </Button>
      </div>
    </>
  );
}

function PaddockPanel({
  organisationId,
  paddockId,
  onChanged,
  onClose,
  onRedraw,
}: {
  organisationId: string;
  paddockId: string;
  onChanged: () => void;
  onClose: () => void;
  onRedraw: (paddock: Paddock) => void;
}) {
  const { can } = useWorkspace();
  const loaded = useApiData<{ paddock: Paddock & { boundaries: BoundaryVersion[] } }>(`/api/farming/paddocks/${paddockId}`, { organisationId });
  const [editing, setEditing] = useState(false);
  const [splitting, setSplitting] = useState(false);
  const paddock = loaded.data?.paddock;
  if (loaded.error) return <Notice tone="error">{loaded.error}</Notice>;
  if (!paddock) return null;
  const editable = paddock.status === "active" && can("bookkeeper");
  const changed = () => {
    loaded.reload();
    onChanged();
  };
  return (
    <Card
      title={`Paddock ${paddock.name}`}
      description={paddock.status === "retired" ? `Retired on ${formatDate(paddock.retiredOn!)}. Its history is kept as it was.` : `Since ${formatDate(paddock.createdOn)}.`}
      actions={
        <Button variant="secondary" size="small" onClick={onClose}>
          Close
        </Button>
      }
    >
      <dl style={{ display: "grid", gridTemplateColumns: "max-content minmax(0, 1fr)", gap: "4px 16px", margin: "0 0 12px" }}>
        <dt>Effective area</dt>
        <dd>{paddock.effectiveHa ? `${paddock.effectiveHa} ha` : "Not entered"}</dd>
        <dt>Mapped area</dt>
        <dd>{paddock.mappedHa ? `${paddock.mappedHa} ha` : "No boundary yet"}</dd>
        {paddock.cameFrom.length > 0 ? (
          <>
            <dt>Came from</dt>
            <dd>
              {paddock.cameFrom.map((entry) => entry.name).join(", ")} ({paddock.cameFrom[0].kind}, {formatDate(paddock.cameFrom[0].onDate)})
            </dd>
          </>
        ) : null}
        {paddock.became.length > 0 ? (
          <>
            <dt>Became</dt>
            <dd>
              {paddock.became.map((entry) => entry.name).join(", ")} ({paddock.became[0].kind}, {formatDate(paddock.became[0].onDate)})
            </dd>
          </>
        ) : null}
      </dl>
      {paddock.boundaries.length > 0 ? (
        <>
          <h3>Boundary history</h3>
          <ul style={{ listStyle: "none", padding: 0, margin: "8px 0 16px", display: "grid", gap: 4 }}>
            {paddock.boundaries.map((version, index) => (
              <li key={version.id}>
                {version.mappedHa} ha · {version.source} · {formatDateTime(version.createdAt)}
                {index === 0 ? (
                  <>
                    {" "}
                    <Badge tone="green">Current</Badge>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <PaddockRecords organisationId={organisationId} paddockId={paddock.id} />
      {editable ? (
        <div className={ui.actions}>
          <Button variant="secondary" onClick={() => (setEditing(!editing), setSplitting(false))}>
            Rename or change area
          </Button>
          <Button variant="secondary" onClick={() => (setSplitting(!splitting), setEditing(false))}>
            Split
          </Button>
          <Button variant="secondary" onClick={() => onRedraw(paddock)}>
            {paddock.geometry ? "Redraw boundary" : "Draw boundary"}
          </Button>
        </div>
      ) : null}
      {editing ? <EditPaddock organisationId={organisationId} paddock={paddock} onSaved={() => (setEditing(false), changed())} /> : null}
      {splitting ? <SplitPaddock organisationId={organisationId} paddock={paddock} onSplit={() => (setSplitting(false), onClose(), onChanged())} /> : null}
    </Card>
  );
}

function EditPaddock({ organisationId, paddock, onSaved }: { organisationId: string; paddock: Paddock; onSaved: () => void }) {
  const [name, setName] = useState(paddock.name);
  const [effectiveHa, setEffectiveHa] = useState(paddock.effectiveHa ?? "");
  const { busy, error, run } = useRun();
  return (
    <>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.inlineForm}>
        <Field label="Name">
          <input value={name} maxLength={60} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label="Effective ha">
          <input inputMode="decimal" value={effectiveHa} onChange={(event) => setEffectiveHa(event.target.value)} />
        </Field>
        <Button
          onClick={() => void run(() => api(`/api/farming/paddocks/${paddock.id}`, { method: "PATCH", body: { organisationId, name, effectiveHa: effectiveHa || null } }), onSaved)}
          disabled={busy || !name.trim()}
        >
          Save
        </Button>
      </div>
    </>
  );
}

function SplitPaddock({ organisationId, paddock, onSplit }: { organisationId: string; paddock: Paddock; onSplit: () => void }) {
  const [onDate, setOnDate] = useState(todayInBrowser());
  const [parts, setParts] = useState([
    { name: `${paddock.name}A`, effectiveHa: "" },
    { name: `${paddock.name}B`, effectiveHa: "" },
  ]);
  const { busy, error, run } = useRun();
  const setPart = (index: number, field: "name" | "effectiveHa", value: string) => setParts(parts.map((part, i) => (i === index ? { ...part, [field]: value } : part)));
  return (
    <>
      <p className={ui.muted} style={{ marginTop: 12 }}>
        {paddock.name} is retired on the date with its history. The new paddocks start that day, linked to it. Import or draw their shapes afterwards.
      </p>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.inlineForm}>
        <Field label="Split on">
          <DateInput value={onDate} onChange={(event) => setOnDate(event.target.value)} />
        </Field>
        {parts.map((part, index) => (
          <div key={index} style={{ display: "contents" }}>
            <Field label={`New paddock ${index + 1}`}>
              <input value={part.name} maxLength={60} onChange={(event) => setPart(index, "name", event.target.value)} />
            </Field>
            <Field label="Effective ha">
              <input inputMode="decimal" value={part.effectiveHa} onChange={(event) => setPart(index, "effectiveHa", event.target.value)} />
            </Field>
          </div>
        ))}
        <Button variant="secondary" onClick={() => setParts([...parts, { name: "", effectiveHa: "" }])} disabled={parts.length >= 10}>
          Another part
        </Button>
        <Button
          onClick={() =>
            void run(
              () =>
                api(`/api/farming/paddocks/${paddock.id}/split`, {
                  method: "POST",
                  body: { organisationId, onDate, parts: parts.map((part) => ({ name: part.name, effectiveHa: part.effectiveHa || null })) },
                }),
              onSplit,
            )
          }
          disabled={busy || parts.some((part) => !part.name.trim())}
        >
          Split {paddock.name}
        </Button>
      </div>
    </>
  );
}

// Import ---------------------------------------------------------------------------------------

const ACTION_TEXT: Record<ImportPreview["rows"][number]["action"], { label: string; tone: "green" | "blue" | "neutral" | "red" }> = {
  new: { label: "New paddock", tone: "green" },
  new_boundary: { label: "New boundary", tone: "blue" },
  unchanged: { label: "Unchanged", tone: "neutral" },
  error: { label: "Skipped", tone: "red" },
};

export function ImportPaddocks({ organisationId, farmId: initialFarm }: { organisationId: string; farmId: string | null }) {
  const farms = useFarms(organisationId);
  const [farmId, setFarmId] = useState(initialFarm ?? "");
  const [file, setFile] = useState<{ name: string; content?: string; contentBase64?: string } | null>(null);
  const [nameProperty, setNameProperty] = useState("");
  const [effectiveProperty, setEffectiveProperty] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const { busy, error, run } = useRun();
  const active = (farms.data?.farms ?? []).filter((farm) => farm.isActive);
  const chosenFarm = farmId || active[0]?.id || "";
  const body = (extra: Record<string, unknown> = {}) => ({
    organisationId,
    fileName: file?.name,
    content: file?.content,
    contentBase64: file?.contentBase64,
    nameProperty: nameProperty || null,
    effectiveProperty: effectiveProperty || null,
    ...extra,
  });
  const check = (names = { nameProperty, effectiveProperty }) =>
    void run(
      () =>
        api<{ preview: ImportPreview }>(`/api/farming/farms/${chosenFarm}/import`, {
          method: "POST",
          body: { ...body(), nameProperty: names.nameProperty || null, effectiveProperty: names.effectiveProperty || null, preview: true },
        }),
      (result) => {
        setPreview(result.preview);
        setNameProperty(result.preview.nameProperty ?? "");
        setEffectiveProperty(result.preview.effectiveProperty ?? "");
      },
    );
  const pick = async (picked: File | undefined) => {
    setPreview(null);
    setDone(null);
    if (!picked) return setFile(null);
    // KMZ and zipped shapefiles are binary: sent as base64. GeoJSON and KML are text.
    if (/\.(kmz|zip|shp)$/i.test(picked.name)) {
      const bytes = new Uint8Array(await picked.arrayBuffer());
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      setFile({ name: picked.name, contentBase64: btoa(binary) });
    } else {
      setFile({ name: picked.name, content: await picked.text() });
    }
  };
  return (
    <>
      <Card
        title="Import paddock shapes"
        description="A file of paddock polygons, one per paddock, with a property holding its name: GeoJSON, KML or KMZ (from Google Earth and most farm mapping apps), or a shapefile zipped with its .dbf and .prj files. Shapes in NZTM2000 are converted. Paddocks are matched by name: new names add paddocks, and a changed shape adds a new boundary version. Nothing is saved until you import."
      >
        {error ? <Notice tone="error">{error}</Notice> : null}
        {done ? <Notice tone="success">{done}</Notice> : null}
        <div className={ui.inlineForm}>
          <Field label="Farm">
            <select value={chosenFarm} onChange={(event) => (setFarmId(event.target.value), setPreview(null))}>
              {active.map((farm) => (
                <option key={farm.id} value={farm.id}>
                  {farm.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="File">
            <input type="file" accept=".geojson,.json,.kml,.kmz,.zip,application/geo+json,application/json,application/vnd.google-earth.kml+xml,application/vnd.google-earth.kmz,application/zip" onChange={(event) => void pick(event.target.files?.[0])} />
          </Field>
          <Button onClick={() => check({ nameProperty: "", effectiveProperty: "" })} disabled={busy || !file || !chosenFarm}>
            Check the file
          </Button>
        </div>
        <p className={ui.muted}>Shapes in other projections (such as the old NZ Map Grid) aren&apos;t converted: export them in WGS84 or NZTM2000 from your mapping app first.</p>
      </Card>
      {preview ? (
        <Card
          title={preview.fileName}
          description={`${preview.counts.new} new, ${preview.counts.newBoundary} with a new boundary, ${preview.counts.unchanged} unchanged, ${preview.counts.errors} skipped.`}
        >
          {preview.note ? <Notice tone="info">{preview.format}: {preview.note}</Notice> : null}
          {preview.alreadyImportedOn ? <Notice tone="warning">This file was already imported on {formatDate(preview.alreadyImportedOn.slice(0, 10))}.</Notice> : null}
          <div className={ui.inlineForm}>
            <Field label="Name is in">
              <select value={nameProperty} onChange={(event) => (setNameProperty(event.target.value), check({ nameProperty: event.target.value, effectiveProperty }))}>
                <option value="">Choose…</option>
                {preview.properties.map((property) => (
                  <option key={property} value={property}>
                    {property}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Effective ha is in">
              <select value={effectiveProperty} onChange={(event) => (setEffectiveProperty(event.target.value), check({ nameProperty, effectiveProperty: event.target.value }))}>
                <option value="">Not in the file</option>
                {preview.properties.map((property) => (
                  <option key={property} value={property}>
                    {property}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className={ui.tableWrap}>
            <table className={`${ui.table} ${ui.stackOnPhone}`}>
              <thead>
                <tr>
                  <th>Paddock</th>
                  <th className={ui.num}>Mapped ha</th>
                  <th className={ui.num}>Effective ha</th>
                  <th>What happens</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((row) => (
                  <tr key={row.index}>
                    <td data-label="Paddock">{row.name ?? <span className={ui.muted}>Shape {row.index + 1}</span>}</td>
                    <td data-label="Mapped ha" className={ui.num}>
                      {row.mappedHa ?? ""}
                    </td>
                    <td data-label="Effective ha" className={ui.num}>
                      {row.effectiveHa ?? ""}
                    </td>
                    <td data-label="What happens">
                      <Badge tone={ACTION_TEXT[row.action].tone}>{ACTION_TEXT[row.action].label}</Badge>
                      {row.error ? <div className={ui.muted}>{row.error}</div> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className={ui.actions} style={{ marginTop: 16 }}>
            <Button
              onClick={() =>
                void run(
                  () => api<{ preview: ImportPreview }>(`/api/farming/farms/${chosenFarm}/import`, { method: "POST", body: body() }),
                  (result) => {
                    setPreview(null);
                    setFile(null);
                    setDone(`Imported: ${result.preview.counts.new} new paddocks and ${result.preview.counts.newBoundary} new boundaries.`);
                    farms.reload();
                  },
                )
              }
              disabled={busy || Boolean(preview.alreadyImportedOn) || preview.counts.new + preview.counts.newBoundary === 0}
            >
              Import {preview.counts.new + preview.counts.newBoundary} shape{preview.counts.new + preview.counts.newBoundary === 1 ? "" : "s"}
            </Button>
            <Link href="/operations/farming">Back to the farm</Link>
          </div>
        </Card>
      ) : null}
    </>
  );
}
