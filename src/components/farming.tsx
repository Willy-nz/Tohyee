"use client";

import { DateInput } from "@/components/date-input";
import Link from "next/link";
import { FarmSelector, useSelectedFarm } from "@/components/farm-selector";
import { AddAerialPhotos, AerialPhotosCard, AerialPhotosFailed } from "@/components/farm-imagery";
import { FarmRowList, farmRowStyles } from "@/components/farm-rows";
import { useEffect, useRef, useState } from "react";
import { useApiData } from "@/components/hooks";
import { PaddockPastureSummary } from "@/components/pasture";
import { PaddockRecords } from "@/components/soil";
import { Badge, Button, Card, Empty, Field, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage } from "@/lib/client/api";
import { resolveSelectedFarm } from "@/lib/client/farm-selection";
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

/**
 * Something drawn over the paddocks, e.g. a hazard or no-go zone (#446): a
 * point (a warning triangle) or a zone (an outline). "danger" is red (no-go
 * or high), "warning" amber.
 */
export type MapOverlay = { id: string; label: string; tone: "danger" | "warning"; point?: Position | null; ring?: Position[] | null; onSelect?: () => void };

const OVERLAY_COLOURS = { danger: { fill: "rgba(200, 30, 30, 0.28)", stroke: "#c81e1e" }, warning: { fill: "rgba(230, 150, 0, 0.25)", stroke: "#b86e00" } } as const;

/** New Zealand, for a farm with no shapes yet. */
const NZ_VIEW = { centre: [172.6, -41.3] as Position, zoom: 4.6 };
const MIN_ZOOM = 3;
const MAX_ZOOM = 19;

/**
 * The paddocks' outlines to scale, north up, in Web Mercator, with zoom and
 * pan. With a LINZ Basemaps key, aerial imagery is drawn underneath, loaded
 * by the browser straight from LINZ (Tohyee's server stores none; a phone
 * keeps the farm's area, #485). While
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
  fills,
  label = "Map of the paddocks",
  overlays = [],
  offerImagery = false,
}: {
  /** No key is set: say "Add aerial photos (free, 1 minute)" under the outlines (decision 1060). */
  offerImagery?: boolean;
  /** A colour (a CSS colour or var()) for each paddock id, for the farm map's bands (decision 907). */
  fills?: Record<string, string>;
  /** What the map shows, for screen readers. */
  label?: string;
  paddocks: Pick<Paddock, "id" | "name" | "geometry" | "effectiveHa" | "mappedHa">[];
  selected: string | null;
  onSelect?: (id: string) => void;
  imageryKey?: string | null;
  drawing?: Position[] | null;
  onMapTap?: (position: Position) => void;
  overlays?: MapOverlay[];
}) {
  const [moved, setMoved] = useState<{ centre: Position; zoom: number } | null>(null);
  const [failed, setFailed] = useState<{ key: string; count: number }>({ key: "", count: 0 });
  const [locating, setLocating] = useState<string | null>(null);
  const drag = useRef<{ x: number; y: number; centre: Position; moved: boolean } | null>(null);
  // A click follows the end of a drag: it mustn't also choose a paddock.
  const dragged = useRef(false);
  const svg = useRef<SVGSVGElement | null>(null);
  // Paddock numbers stay about 13px on screen however narrow the map is (#447: they were too small to read on a phone).
  const [shownWidth, setShownWidth] = useState(MAP_WIDTH);
  useEffect(() => {
    const element = svg.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => setShownWidth(entries[0]?.contentRect.width || MAP_WIDTH));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const labelSize = Math.max(14, Math.min(36, (13 * MAP_WIDTH) / Math.max(shownWidth, 1)));
  const shaped = paddocks.filter((paddock) => paddock.geometry);
  const overlayShapes: PaddockGeometry[] = overlays.flatMap((overlay) =>
    overlay.ring && overlay.ring.length > 3 ? [{ type: "Polygon" as const, coordinates: [overlay.ring] }] : overlay.point ? [{ type: "Polygon" as const, coordinates: [[overlay.point, overlay.point, overlay.point, overlay.point]] }] : [],
  );
  const box = bounds([...shaped.map((paddock) => paddock.geometry!), ...overlayShapes]);
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
      {/* Above the map, where it's seen, rather than under a tall map. */}
      {imagery && failedHere > 0 ? <AerialPhotosFailed all={failedHere === view.tiles.length} online={typeof navigator === "undefined" || navigator.onLine} /> : null}
      <div style={{ position: "relative" }}>
        <svg
          ref={svg}
          viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`}
          role="img"
          aria-label={imagery ? `${label}, over aerial imagery` : label}
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
            const banded = fills?.[paddock.id];
            const fill = banded ?? (imagery ? (isSelected ? "rgba(255, 214, 10, 0.35)" : "rgba(255, 255, 255, 0.08)") : isSelected ? "#9ccf7a" : "#c9e3b4");
            const stroke = banded ? (isSelected ? "var(--text)" : "var(--surface)") : imagery ? (isSelected ? "#ffd60a" : "#ffffff") : isSelected ? "#1f5fae" : "#4f7a3a";
            return (
              <g
                key={paddock.id}
                onClick={onSelect && !drawing ? () => (dragged.current ? undefined : onSelect(paddock.id)) : undefined}
                style={{ cursor: onSelect && !drawing ? "pointer" : undefined }}
              >
                <title>{`${paddock.name}: ${paddock.effectiveHa ?? "?"} ha effective, ${paddock.mappedHa} ha mapped`}</title>
                {/* Theme colours are CSS variables, so they go in style (an SVG attribute can't use var()). */}
                <path d={path} style={{ fill, fillOpacity: banded && imagery ? 0.75 : undefined, stroke }} strokeWidth={isSelected ? 4 : 1.5} fillRule="evenodd" />
                <text
                  x={cx}
                  y={cy}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fontSize={labelSize}
                  fontWeight={600}
                  fill={imagery || banded ? "#ffffff" : "#203a18"}
                  stroke={imagery || banded ? "rgba(0, 0, 0, 0.75)" : "none"}
                  strokeWidth={imagery || banded ? 3 : 0}
                  paintOrder="stroke"
                  style={{ pointerEvents: "none" }}
                >
                  {paddock.name}
                </text>
              </g>
            );
          })}
          {overlays.map((overlay) => {
            const colours = OVERLAY_COLOURS[overlay.tone];
            const selectable = Boolean(overlay.onSelect) && !drawing;
            return (
              <g key={overlay.id} onClick={selectable ? () => (dragged.current ? undefined : overlay.onSelect!()) : undefined} style={{ cursor: selectable ? "pointer" : undefined }}>
                <title>{overlay.label}</title>
                {overlay.ring && overlay.ring.length > 3 ? (
                  <path d={`M${overlay.ring.map((point) => view.project(point).map((value) => value.toFixed(1)).join(",")).join("L")}Z`} fill={colours.fill} stroke={colours.stroke} strokeWidth={2.5} strokeDasharray="8 4" />
                ) : null}
                {overlay.point
                  ? (() => {
                      const [x, y] = view.project(overlay.point);
                      return (
                        <g transform={`translate(${x.toFixed(1)},${y.toFixed(1)})`}>
                          <path d="M0,-15 L13,9 L-13,9 Z" fill={colours.stroke} stroke="#ffffff" strokeWidth={2} strokeLinejoin="round" />
                          <text y={6} textAnchor="middle" fontSize={14} fontWeight={700} fill="#ffffff" style={{ pointerEvents: "none" }}>
                            !
                          </text>
                        </g>
                      );
                    })()
                  : null}
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
      {imagery ? <LinzAttribution /> : offerImagery ? <AddAerialPhotos /> : null}
    </>
  );
}

// Farms and paddocks ------------------------------------------------------------------------

export function FarmingHome({ organisationId, farmId = null }: { organisationId: string; farmId?: string | null }) {
  const { can } = useWorkspace();
  const farms = useFarms(organisationId);
  const settings = useApiData<{ settings: FarmingSettings }>("/api/farming/settings", { organisationId });
  const { farm, stale, deciding, selectFarm } = useSelectedFarm(organisationId, farms.data?.farms ?? [], farmId);
  if (farms.error) return <Notice tone="error">{farms.error}</Notice>;
  if (!farms.data) return <p className={ui.muted}>Loading…</p>;
  const active = farms.data.farms.filter((farm) => farm.isActive);
  return (
    <>
      <FarmSelector farms={active} farm={farm} stale={stale} deciding={deciding} onChange={selectFarm} />
      {farm ? <FarmView key={farm.id} organisationId={organisationId} farm={farm} imageryKey={settings.data?.settings.imageryKey ?? null} onChanged={() => farms.reload()} /> : null}
      {can("bookkeeper") ? <AddFarm organisationId={organisationId} first={active.length === 0} knownIds={farms.data.farms.map((entry) => entry.id)} onSaved={(added) => { if (added) selectFarm(added); farms.reload(); }} /> : null}
      {can("admin") && settings.data ? <AerialPhotosCard organisationId={organisationId} settings={settings.data.settings} onSaved={() => settings.reload()} /> : null}
    </>
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
            <Field label="Paddock area (ha)" hint="The area you farm">
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

function AddFarm({ organisationId, first, knownIds, onSaved }: { organisationId: string; first: boolean; knownIds: string[]; onSaved: (addedFarmId: string | null) => void }) {
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
              () => api<{ farms: Farm[] }>("/api/farming/farms", { method: "POST", body: { organisationId, name } }),
              (result) => {
                setName("");
                // Show the farm just added, rather than leaving the page on another one.
                onSaved(result.farms.find((entry) => !knownIds.includes(entry.id))?.id ?? null);
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
          offerImagery={!imageryKey}
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
        description="Paddock area is the area you farm; plans use it. The mapped area comes from the boundary."
        actions={
          <label className={ui.checkbox}>
            <input type="checkbox" checked={showRetired} onChange={(event) => setShowRetired(event.target.checked)} /> Show retired
          </label>
        }
      >
        {paddocks.data && list.length === 0 ? <Empty>No paddocks yet. Add one below or import a file of their shapes.</Empty> : null}
        {list.length > 0 ? (
          <div className={farmRowStyles.phoneOnly}>
            <FarmRowList
              label="Paddocks"
              rows={list.map((paddock) => ({
                key: paddock.id,
                title: paddock.name,
                parts: [paddock.effectiveHa ? `${paddock.effectiveHa} ha` : paddock.mappedHa ? `${paddock.mappedHa} ha mapped` : "No area yet", paddock.status === "retired" ? `Retired ${formatDate(paddock.retiredOn!)}` : null],
                onOpen: () => setSelected(paddock.id),
              }))}
            />
          </div>
        ) : null}
        {list.length > 0 ? (
          <div className={`${ui.tableWrap} ${farmRowStyles.wideOnly}`}>
            <table className={ui.table}>
              <thead>
                <tr>
                  <th>Paddock</th>
                  <th className={ui.num}>Paddock area (ha)</th>
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
                    <td data-label="Paddock area" className={ui.num}>
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
        <Field label="Paddock area (ha)">
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
      <PaddockPastureSummary organisationId={organisationId} paddockId={paddock.id} />
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
        <Field label="Paddock area (ha)">
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
            <Field label="Paddock area (ha)">
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
  const { farm: rememberedFarm, selectFarm } = useSelectedFarm(organisationId, farms.data?.farms ?? []);
  const [farmId, setFarmId] = useState<string | null>(initialFarm);
  const [file, setFile] = useState<{ name: string; content?: string; contentBase64?: string } | null>(null);
  const [nameProperty, setNameProperty] = useState("");
  const [effectiveProperty, setEffectiveProperty] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [previewFarmId, setPreviewFarmId] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const { busy, error, run } = useRun();
  const active = (farms.data?.farms ?? []).filter((farm) => farm.isActive);
  const destination = farmId === null ? rememberedFarm : resolveSelectedFarm(active, farmId);
  const chosenFarm = destination?.id ?? "";
  const body = (extra: Record<string, unknown> = {}) => ({
    organisationId,
    fileName: file?.name,
    content: file?.content,
    contentBase64: file?.contentBase64,
    nameProperty: nameProperty || null,
    effectiveProperty: effectiveProperty || null,
    ...extra,
  });
  const check = (names = { nameProperty, effectiveProperty }) => {
    if (!chosenFarm || !file || busy) return;
    selectFarm(chosenFarm);
    setPreview(null);
    void run(
      () =>
        api<{ preview: ImportPreview }>(`/api/farming/farms/${chosenFarm}/import`, {
          method: "POST",
          body: { ...body(), nameProperty: names.nameProperty || null, effectiveProperty: names.effectiveProperty || null, preview: true },
        }),
      (result) => {
        setPreview(result.preview);
        setPreviewFarmId(chosenFarm);
        setNameProperty(result.preview.nameProperty ?? "");
        setEffectiveProperty(result.preview.effectiveProperty ?? "");
      },
    );
  };
  const pick = (picked: File | undefined) => {
    setPreview(null);
    setDone(null);
    setFile(null);
    if (!picked) return;
    void run(async () => {
      // Binary mapping formats are sent as base64; no stale file can be checked while reading.
      if (/\.(kmz|zip|shp)$/i.test(picked.name)) {
        const bytes = new Uint8Array(await picked.arrayBuffer());
        let binary = "";
        for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return { name: picked.name, contentBase64: btoa(binary) };
      }
      return { name: picked.name, content: await picked.text() };
    }, setFile);
  };
  if (farms.error) return <Notice tone="error">{farms.error}</Notice>;
  if (!farms.data) return <p className={ui.muted}>Loading…</p>;
  if (!active.length) return <Empty>Add a farm under <Link href="/operations/farming">Farms and paddocks</Link> before importing.</Empty>;

  return (
    <>
      <Card
        title="Import paddock shapes"
        description="A file of paddock polygons, one per paddock, with a property holding its name: GeoJSON, KML or KMZ (from Google Earth and most farm mapping apps), or a shapefile zipped with its .dbf and .prj files. Shapes in NZTM2000 are converted. Paddocks are matched by name: new names add paddocks, and a changed shape adds a new boundary version. Nothing is saved until you import."
      >
        {error ? <Notice tone="error">{error}</Notice> : null}
        {done ? <Notice tone="success">{done}</Notice> : null}
        {farmId !== null && farmId === initialFarm && !destination ? <Notice tone="warning">The farm in that link is archived or isn&apos;t in this organisation. Choose the destination farm.</Notice> : null}
        <div className={ui.inlineForm}>
          <Field label="Farm">
            <select value={chosenFarm} disabled={busy} onChange={(event) => { setFarmId(event.target.value); selectFarm(event.target.value); setPreview(null); setDone(null); }}>
              <option value="" disabled>Choose the destination farm…</option>
              {active.map((farm) => (
                <option key={farm.id} value={farm.id}>
                  {farm.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="File">
            <input type="file" disabled={busy} accept=".geojson,.json,.kml,.kmz,.zip,application/geo+json,application/json,application/vnd.google-earth.kml+xml,application/vnd.google-earth.kmz,application/zip" onChange={(event) => void pick(event.target.files?.[0])} />
          </Field>
          <Button onClick={() => check({ nameProperty: "", effectiveProperty: "" })} disabled={busy || !file || !chosenFarm}>
            Check the file
          </Button>
        </div>
        <p className={ui.muted}>Shapes in other projections (such as the old NZ Map Grid) aren&apos;t converted: export them in WGS84 or NZTM2000 from your mapping app first.</p>
      </Card>
      {preview && destination && previewFarmId === chosenFarm ? (
        <Card
          title={`${preview.fileName} → ${destination.name}`}
          description={`${preview.counts.new} new, ${preview.counts.newBoundary} with a new boundary, ${preview.counts.unchanged} unchanged, ${preview.counts.errors} skipped.`}
        >
          {preview.note ? <Notice tone="info">{preview.format}: {preview.note}</Notice> : null}
          {preview.alreadyImportedOn ? <Notice tone="warning">This file was already imported on {formatDate(preview.alreadyImportedOn.slice(0, 10))}.</Notice> : null}
          <div className={ui.inlineForm}>
            <Field label="Name is in">
              <select disabled={busy} value={nameProperty} onChange={(event) => (setNameProperty(event.target.value), check({ nameProperty: event.target.value, effectiveProperty }))}>
                <option value="">Choose…</option>
                {preview.properties.map((property) => (
                  <option key={property} value={property}>
                    {property}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Effective ha is in">
              <select disabled={busy} value={effectiveProperty} onChange={(event) => (setEffectiveProperty(event.target.value), check({ nameProperty, effectiveProperty: event.target.value }))}>
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
                    setDone(`Imported into ${destination.name}: ${result.preview.counts.new} new paddocks and ${result.preview.counts.newBoundary} new boundaries.`);
                    farms.reload();
                  },
                )
              }
              disabled={busy || Boolean(preview.alreadyImportedOn) || preview.counts.new + preview.counts.newBoundary === 0}
            >
              Import {preview.counts.new + preview.counts.newBoundary} shape{preview.counts.new + preview.counts.newBoundary === 1 ? "" : "s"} into {destination.name}
            </Button>
            <Link href="/operations/farming" onClick={() => selectFarm(chosenFarm)}>Back to the farm</Link>
          </div>
        </Card>
      ) : null}
    </>
  );
}
