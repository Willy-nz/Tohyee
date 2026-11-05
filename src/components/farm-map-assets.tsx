"use client";

import { useEffect, useState } from "react";
import type { MapOverlay } from "@/components/farming";
import { useApiData } from "@/components/hooks";
import { InfoTip } from "@/components/info-tip";
import { Badge, Button, Card, Field, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage } from "@/lib/client/api";
import type { Position } from "@/lib/farming/geometry";
import type { MapAsset } from "@/lib/farming/map-assets";
import { ASSET_KIND_LABELS, ASSET_KIND_SHORT, ASSET_KINDS, areaText, type AssetKind, distanceMetres, distanceText, drawnHectares, isLineKind, LINE_KINDS, lengthMetres, MAP_LAYERS, type MapLayer, overlayLayer, POINT_KINDS } from "@/lib/farming/map-assets-rules";
import type { Farm } from "@/lib/farming/paddocks";
import styles from "./farm-workspace.module.css";

/*
 * The Map tab's tools (decisions 1462-1465): layers to turn on and off,
 * farm assets (troughs, gates, water points, sheds and the like as dots;
 * fences, pipes and races as lines) with a name and a note, and a measure
 * tool for a distance (m and km) or a drawn area (m² and ha). Measuring
 * saves nothing. Everything uses the farm map and geometry.ts's geodesic
 * maths, like paddock areas.
 */

const LAYER_KEY = "tohyee.farmMapLayers.v1";

/** Which layers are on: all of them until someone turns one off (remembered on this device only). */
export function useMapLayers() {
  const [off, setOff] = useState<MapLayer[]>([]);
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(LAYER_KEY) ?? "[]");
      // eslint-disable-next-line react-hooks/set-state-in-effect -- read once from this device's storage after hydration
      if (Array.isArray(saved)) setOff(saved.filter((key): key is MapLayer => MAP_LAYERS.some((layer) => layer.key === key)));
    } catch {
      // Storage blocked: every layer stays on.
    }
  }, []);
  const toggle = (key: MapLayer) => {
    const next = off.includes(key) ? off.filter((entry) => entry !== key) : [...off, key];
    setOff(next);
    try {
      localStorage.setItem(LAYER_KEY, JSON.stringify(next));
    } catch {
      // Not remembered on this device; still changed on screen.
    }
  };
  return { isOn: (key: MapLayer) => !off.includes(key), toggle };
}

/** The layer buttons, for the layers that have something on this farm's map. */
export function MapLayerToggles({ present, isOn, toggle }: { present: MapLayer[]; isOn: (key: MapLayer) => boolean; toggle: (key: MapLayer) => void }) {
  const shown = MAP_LAYERS.filter((layer) => present.includes(layer.key));
  if (!shown.length) return null;
  return (
    <div role="group" aria-label="Show on the map" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, margin: "8px 0" }}>
      <span className={ui.muted}>Show:</span>
      {shown.map((layer) => (
        <Button key={layer.key} size="small" variant="secondary" aria-pressed={isOn(layer.key)} onClick={() => toggle(layer.key)} style={isOn(layer.key) ? { borderColor: "var(--accent)", boxShadow: "inset 0 0 0 1px var(--accent)" } : { opacity: 0.7, textDecoration: "line-through" }}>
          {isOn(layer.key) ? "✓ " : ""}
          {layer.label}
        </Button>
      ))}
    </div>
  );
}

/** Overlays on the layers that are on. */
export function shownOverlays(overlays: MapOverlay[], isOn: (key: MapLayer) => boolean): MapOverlay[] {
  return overlays.filter((overlay) => isOn(overlayLayer(overlay)));
}

export function useMapAssets(organisationId: string, farmId: string) {
  return useApiData<{ assets: MapAsset[] }>(`/api/farming/farms/${farmId}/map-assets`, { organisationId });
}

/** Assets as overlays: a dot with its letter for a point, a line for a fence or pipe. Ids start "asset-" (the Farm assets layer). */
export function assetOverlays(assets: MapAsset[], onSelect?: (id: string) => void): MapOverlay[] {
  return assets.map((asset) => ({
    id: `asset-${asset.id}`,
    label: `${ASSET_KIND_LABELS[asset.kind]}: ${asset.name}${asset.lengthMetres !== null ? `, ${distanceText(asset.lengthMetres)}` : ""}${asset.note ? `. ${asset.note}` : ""}`,
    tone: "asset" as const,
    marker: "dot" as const,
    short: ASSET_KIND_SHORT[asset.kind],
    point: asset.point,
    line: asset.line,
    onSelect: onSelect ? () => onSelect(asset.id) : undefined,
  }));
}

// Drawing on the map: measuring, placing an asset ------------------------------------------------------

export type MapDrawing = { points: Position[]; shape: "line" | "area" | "point"; onTap: (position: Position) => void };

const round = (position: Position): Position => [Math.round(position[0] * 1e6) / 1e6, Math.round(position[1] * 1e6) / 1e6];

/** The measure tool (MA4-MA5): tap points for a distance, or corners for an area. Nothing is saved. */
export function MeasureCard({ onDrawing, onClose }: { onDrawing: (drawing: MapDrawing | null) => void; onClose: () => void }) {
  const [mode, setMode] = useState<"distance" | "area">("distance");
  const [points, setPoints] = useState<Position[]>([]);
  useEffect(() => {
    onDrawing({ points, shape: mode === "area" ? "area" : "line", onTap: (position) => setPoints((was) => [...was, round(position)]) });
  }, [points, mode, onDrawing]);
  useEffect(() => () => onDrawing(null), [onDrawing]);
  const legs = points.slice(1).map((point, index) => distanceMetres(points[index], point));
  const total = lengthMetres(points);
  const hectares = drawnHectares(points);
  return (
    <Card
      title="Measure"
      description={
        <>
          Tap the map to add points. Nothing is saved.{" "}
          <InfoTip label="About measuring">Distances and areas are worked out on the earth&apos;s curve, like paddock areas. A tap is only as exact as where you tap: zoom in for a closer measure.</InfoTip>
        </>
      }
      actions={
        <Button variant="secondary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className={ui.tabs} role="group" aria-label="Measure">
        {(["distance", "area"] as const).map((entry) => (
          <button key={entry} type="button" aria-pressed={mode === entry} className={`${ui.tab} ${mode === entry ? ui.tabActive : ""}`} onClick={() => setMode(entry)}>
            {entry === "distance" ? "Distance" : "Area"}
          </button>
        ))}
      </div>
      <div role="status" aria-live="polite" style={{ margin: "12px 0", fontSize: "var(--text-xl, 20px)", fontWeight: 700 }}>
        {mode === "distance" ? (points.length < 2 ? "Tap two or more points" : distanceText(total)) : points.length < 3 ? "Tap three or more corners" : areaText(hectares)}
      </div>
      {mode === "distance" && legs.length > 1 ? <p className={ui.muted}>Legs: {legs.map((leg) => distanceText(leg)).join(", ")}</p> : null}
      {mode === "area" && points.length >= 3 ? <p className={ui.muted}>Around the edge: {distanceText(lengthMetres([...points, points[0]]))}</p> : null}
      <div className={styles.actions}>
        <Button variant="secondary" disabled={!points.length} onClick={() => setPoints(points.slice(0, -1))}>
          Undo last point
        </Button>
        <Button variant="secondary" disabled={!points.length} onClick={() => setPoints([])}>
          Clear
        </Button>
      </div>
    </Card>
  );
}

/** The farm's assets: a list, add one (tap the map, or tap along a line), change or remove one (MA1-MA3). */
export function FarmAssetsCard({ organisationId, farm, assets, selected, onSelect, onChanged, onDrawing }: { organisationId: string; farm: Farm; assets: MapAsset[]; selected: string | null; onSelect: (id: string | null) => void; onChanged: () => void; onDrawing: (drawing: MapDrawing | null) => void }) {
  const { can, current } = useWorkspace();
  const canRecord = current?.role === "farm_worker" || can("bookkeeper");
  const [editing, setEditing] = useState<MapAsset | "new" | null>(null);
  return (
    <Card
      title="Farm assets"
      description="Troughs, gates, water, sheds, fences and pipes on the map."
      actions={
        canRecord && !editing ? (
          <Button variant="secondary" onClick={() => setEditing("new")}>
            Add an asset
          </Button>
        ) : null
      }
    >
      {editing ? (
        <AssetForm
          key={editing === "new" ? "new" : editing.id}
          organisationId={organisationId}
          farm={farm}
          asset={editing === "new" ? null : editing}
          onDrawing={onDrawing}
          onClose={() => setEditing(null)}
          onSaved={onChanged}
        />
      ) : null}
      {!assets.length && !editing ? <p className={ui.muted}>No assets on the map yet.</p> : null}
      {assets.length ? (
        <ul className={styles.links} aria-label="Farm assets">
          {assets.map((asset) => (
            <li key={asset.id} style={{ display: "grid", gap: 4, padding: "8px 0", borderBottom: "1px solid var(--border)", background: asset.id === selected ? "var(--surface-muted, transparent)" : undefined }}>
              <span style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "baseline", justifyContent: "space-between" }}>
                <button type="button" className={ui.linkButton} style={{ textAlign: "left" }} aria-pressed={asset.id === selected} onClick={() => onSelect(asset.id === selected ? null : asset.id)}>
                  <strong>{asset.name}</strong>
                </button>
                <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <Badge>{ASSET_KIND_LABELS[asset.kind]}</Badge>
                  {asset.lengthMetres !== null ? <span className={ui.muted}>{distanceText(asset.lengthMetres)}</span> : null}
                  {canRecord ? (
                    <button type="button" className={ui.linkButton} onClick={() => setEditing(asset)}>
                      Change<span className={styles.hiddenLabel}> {asset.name}</span>
                    </button>
                  ) : null}
                </span>
              </span>
              {asset.note ? <span className={ui.muted}>{asset.note}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

function AssetForm({ organisationId, farm, asset, onDrawing, onClose, onSaved }: { organisationId: string; farm: Farm; asset: MapAsset | null; onDrawing: (drawing: MapDrawing | null) => void; onClose: () => void; onSaved: () => void }) {
  const [kind, setKind] = useState<AssetKind>(asset?.kind ?? "trough");
  const [name, setName] = useState(asset?.name ?? "");
  const [note, setNote] = useState(asset?.note ?? "");
  const [points, setPoints] = useState<Position[]>(asset ? (asset.line ?? (asset.point ? [asset.point] : [])) : []);
  const [moved, setMoved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const line = isLineKind(kind);
  useEffect(() => {
    onDrawing({
      points,
      shape: line ? "line" : "point",
      onTap: (position) => {
        setMoved(true);
        setPoints((was) => (line ? [...was, round(position)] : [round(position)]));
      },
    });
  }, [points, line, onDrawing]);
  useEffect(() => () => onDrawing(null), [onDrawing]);
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      onSaved();
      onClose();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };
  const ready = name.trim() && (line ? points.length >= 2 : points.length === 1);
  const kinds = asset ? (line ? LINE_KINDS : POINT_KINDS) : ASSET_KINDS;
  return (
    <form
      style={{ display: "grid", gap: 12, marginBottom: 12 }}
      onSubmit={(event) => {
        event.preventDefault();
        const place = !asset || moved ? (line ? { line: points } : { point: points[0] }) : {};
        void run(() =>
          asset
            ? api(`/api/farming/map-assets/${asset.id}`, { method: "PATCH", body: { organisationId, kind, name, note: note.trim() || null, ...place } })
            : api(`/api/farming/farms/${farm.id}/map-assets`, { method: "POST", body: { organisationId, kind, name, note: note.trim() || null, ...place } }),
        );
      }}
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.inlineForm}>
        <Field label="What it is">
          <select
            value={kind}
            onChange={(event) => {
              const next = event.target.value as AssetKind;
              if (isLineKind(next) !== line) setPoints([]);
              setKind(next);
            }}
          >
            {kinds.map((entry) => (
              <option key={entry} value={entry}>
                {ASSET_KIND_LABELS[entry]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Name">
          <input value={name} maxLength={100} required onChange={(event) => setName(event.target.value)} placeholder={line ? "Boundary fence" : "Trough in 12"} />
        </Field>
        <Field label="Note">
          <input value={note} maxLength={500} onChange={(event) => setNote(event.target.value)} />
        </Field>
      </div>
      <p className={ui.muted} role="status">
        {line
          ? points.length < 2
            ? `Tap the map along the ${ASSET_KIND_LABELS[kind].toLowerCase()}, point by point (${points.length} so far).`
            : `${points.length} points, ${distanceText(lengthMetres(points))}. Keep tapping to carry it on.`
          : points.length
            ? asset && !moved
              ? "Tap the map to move it."
              : "Placed. Tap again to move it."
            : "Tap the map where it is."}
      </p>
      <div className={styles.actions}>
        <Button type="submit" disabled={busy || !ready}>
          {asset ? "Save" : "Add to the map"}
        </Button>
        {line && points.length ? (
          <Button
            variant="secondary"
            onClick={() => {
              setMoved(true);
              setPoints(points.slice(0, -1));
            }}
          >
            Undo last point
          </Button>
        ) : null}
        {asset ? (
          confirming ? (
            <>
              <span>Remove {asset.name} from the map? It&apos;s kept in the history.</span>
              <Button variant="danger" disabled={busy} onClick={() => void run(() => api(`/api/farming/map-assets/${asset.id}`, { method: "DELETE", query: { organisationId } }))}>
                Remove
              </Button>
              <Button variant="secondary" onClick={() => setConfirming(false)}>
                Keep it
              </Button>
            </>
          ) : (
            <Button variant="secondary" onClick={() => setConfirming(true)}>
              Remove…
            </Button>
          )
        ) : null}
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
