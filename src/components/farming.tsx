"use client";

import Link from "next/link";
import { useState } from "react";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Empty, Field, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage } from "@/lib/client/api";
import { formatDate, todayInBrowser } from "@/lib/format";
import { bounds, linzAerialTileUrl, mapView, type PaddockGeometry, type Position } from "@/lib/farming/geometry";
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
 * The paddocks' outlines to scale, north up, in Web Mercator. With a LINZ
 * Basemaps key, aerial imagery is drawn underneath, loaded by the browser
 * straight from LINZ (nothing is stored by Tohyee).
 */
export function PaddockMap({ paddocks, selected, onSelect, imageryKey }: { paddocks: Paddock[]; selected: string | null; onSelect?: (id: string) => void; imageryKey?: string | null }) {
  const [failed, setFailed] = useState(0);
  const shaped = paddocks.filter((paddock) => paddock.geometry);
  const box = bounds(shaped.map((paddock) => paddock.geometry!));
  if (!box) return <Empty>No paddock shapes yet. Import a GeoJSON file of your paddocks to see them here.</Empty>;
  const view = mapView(box, MAP_WIDTH, MAP_HEIGHT);
  const imagery = Boolean(imageryKey);
  return (
    <>
      <svg
        viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`}
        role="img"
        aria-label={imagery ? "Map of the paddocks over aerial imagery" : "Map of the paddocks"}
        style={{ width: "100%", height: "auto", background: imagery ? "#5b6b4e" : "var(--surface-muted, #eef3ea)", borderRadius: 10 }}
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
                onError={() => setFailed((count) => count + 1)}
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
            <g key={paddock.id} onClick={onSelect ? () => onSelect(paddock.id) : undefined} style={{ cursor: onSelect ? "pointer" : undefined }}>
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
      </svg>
      {imagery ? <LinzAttribution /> : null}
      {imagery && failed > 0 ? (
        <Notice tone="warning">
          {failed === view.tiles.length ? "The aerial imagery didn't load." : "Some of the aerial imagery didn't load."} LINZ may be unavailable, or the key may have expired (standard LINZ keys last 90 days). An admin can change the key below.
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
            {can("bookkeeper") ? (
              <Link className={`${ui.button} ${ui.secondary}`} href={`/operations/farming/import?farm=${farm.id}`}>
                Import paddock shapes
              </Link>
            ) : null}
          </>
        }
      >
        {paddocks.error ? <Notice tone="error">{paddocks.error}</Notice> : null}
        <PaddockMap paddocks={active} selected={selected} onSelect={setSelected} imageryKey={showImagery ? imageryKey : null} />
        <p className={ui.muted}>
          Paddock outlines to scale, north up. Tap one for its details.
          {imageryKey ? null : " An admin can add a LINZ Basemaps key below to show aerial imagery behind them."}
        </p>
      </Card>
      {selected ? <PaddockPanel key={selected} organisationId={organisationId} paddockId={selected} onChanged={reload} onClose={() => setSelected(null)} /> : null}
      <Card
        title="Paddocks"
        description="Plans use each paddock's effective area, the area you farm. The mapped area is worked out from its boundary."
        actions={
          <label className={ui.checkbox}>
            <input type="checkbox" checked={showRetired} onChange={(event) => setShowRetired(event.target.checked)} /> Show retired
          </label>
        }
      >
        {paddocks.data && list.length === 0 ? <Empty>No paddocks yet. Add one below or import a GeoJSON file.</Empty> : null}
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

function PaddockPanel({ organisationId, paddockId, onChanged, onClose }: { organisationId: string; paddockId: string; onChanged: () => void; onClose: () => void }) {
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
                {version.mappedHa} ha · {version.source} · {formatDate(version.createdAt.slice(0, 10))}
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
      {editable ? (
        <div className={ui.actions}>
          <Button variant="secondary" onClick={() => (setEditing(!editing), setSplitting(false))}>
            Rename or change area
          </Button>
          <Button variant="secondary" onClick={() => (setSplitting(!splitting), setEditing(false))}>
            Split
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
          <input type="date" value={onDate} onChange={(event) => setOnDate(event.target.value)} />
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
  const [file, setFile] = useState<{ name: string; content: string } | null>(null);
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
    setFile({ name: picked.name, content: await picked.text() });
  };
  return (
    <>
      <Card
        title="Import paddock shapes"
        description="A GeoJSON file of paddock polygons in longitude and latitude, one per paddock, with a property holding its name. Paddocks are matched by name: new names add paddocks, and a changed shape adds a new boundary version. Nothing is saved until you import."
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
          <Field label="GeoJSON file">
            <input type="file" accept=".geojson,.json,application/geo+json,application/json" onChange={(event) => void pick(event.target.files?.[0])} />
          </Field>
          <Button onClick={() => check({ nameProperty: "", effectiveProperty: "" })} disabled={busy || !file || !chosenFarm}>
            Check the file
          </Button>
        </div>
        <p className={ui.muted}>KML and shapefiles aren&apos;t read yet: export them as GeoJSON (in longitude and latitude, WGS84) from your mapping app first.</p>
      </Card>
      {preview ? (
        <Card
          title={preview.fileName}
          description={`${preview.counts.new} new, ${preview.counts.newBoundary} with a new boundary, ${preview.counts.unchanged} unchanged, ${preview.counts.errors} skipped.`}
        >
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
