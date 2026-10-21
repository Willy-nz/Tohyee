"use client";

import { useId, useMemo, useState, type ReactNode } from "react";
import { ColourInput } from "@/components/analytics/colour-input";
import { useTileResult, type TileFilters } from "@/components/analytics/use-tile-result";
import { Button, Card, Field, Notice, ui } from "@/components/ui";
import { adaptForDark } from "@/lib/charts/colour-check";
import { showValue } from "@/lib/analytics/display";
import { BUTTON_ACTIONS, SHAPE_KINDS, type ButtonAction, type ButtonItem, type ImageItem, type ItemVisual, type ShapeItem, type ShapeKind } from "@/lib/analytics/items";
import { fieldLabel, measureLabel, tableLabel } from "@/lib/analytics/labels";
import { CHART_HEIGHTS, HEIGHT_LABELS, TILE_HEIGHTS, TILE_WIDTHS, WIDTH_LABELS, paragraphs, type TileHeight, type TileWidth } from "@/lib/analytics/layout";
import { MAX_RICH_TEXT, parseRichText, valueNames, type Block, type Inline } from "@/lib/analytics/rich-text";
import type { Tile } from "@/lib/analytics/dashboards";
import type { ChartFormat } from "@/lib/analytics/chart-format";
import type { Aggregate, ColumnInfo, Measure, QueryResult, TileQuery } from "@/lib/analytics/query";
import { errorMessage } from "@/lib/client/api";
import styles from "./items.module.css";

/**
 * A report's non-data items (#376 phase 2, decisions 683-686): rich text
 * with values, an image, a shape or line, and a button; how they're drawn
 * and the editor for them.
 */

// ---------------------------------------------------------------- Rich text

function InlineView({ list, value }: { list: Inline[]; value: (name: string) => string | null }): ReactNode {
  return list.map((inline, index) => {
    switch (inline.kind) {
      case "text":
        return inline.text;
      case "break":
        return <br key={index} />;
      case "strong":
        return <strong key={index}><InlineView list={inline.children} value={value} /></strong>;
      case "em":
        return <em key={index}><InlineView list={inline.children} value={value} /></em>;
      case "link":
        return (
          <a key={index} href={inline.href} target="_blank" rel="noopener noreferrer nofollow">
            <InlineView list={inline.children} value={value} />
          </a>
        );
      case "value": {
        const shown = value(inline.name);
        // An unknown name stays as typed, so the person can see what to fix.
        return shown === null ? `{${inline.name}}` : <span key={index} className={styles.value}>{shown}</span>;
      }
    }
  });
}

/** Rich text as React elements: whatever was typed stays text (React escapes it), so no HTML can be injected. */
export function RichText({ blocks, value }: { blocks: Block[]; value: (name: string) => string | null }) {
  return (
    <div className={styles.rich}>
      {blocks.map((block, index) =>
        block.kind === "p" ? (
          <p key={index}><InlineView list={block.children} value={value} /></p>
        ) : block.kind === "ul" ? (
          <ul key={index}>{block.items.map((item, at) => <li key={at}><InlineView list={item} value={value} /></li>)}</ul>
        ) : (
          <ol key={index}>{block.items.map((item, at) => <li key={at}><InlineView list={item} value={value} /></li>)}</ol>
        ),
      )}
    </div>
  );
}

/** A value's figure by its label (e.g. "Sales"), formatted as in a table; a blank total shows as a dash. */
export function valueLookup(result: QueryResult | null | undefined): (name: string) => string | null {
  const measures = (result?.columns ?? []).filter((column) => column.role === "measure");
  const row = result?.rows[0];
  return (name: string) => {
    const column = measures.find((entry) => entry.label.toLowerCase() === name.toLowerCase());
    if (!column) return null;
    const raw = row?.[column.key] ?? null;
    return raw === null ? "—" : showValue(raw, column);
  };
}

export function TextItemView({ organisationId, dashboardId, tile, filters, saved = true }: { organisationId: string; dashboardId: string; tile: Tile; filters: TileFilters; saved?: boolean }) {
  const blocks = useMemo(() => (tile.textFormat === "rich" ? parseRichText(tile.text) : null), [tile.text, tile.textFormat]);
  const state = useTileResult(organisationId, blocks && tile.query ? tile.query : null, filters, saved ? { dashboardId, tileId: tile.id } : undefined);
  if (!blocks) {
    return (
      <div className={styles.plain}>
        {paragraphs(tile.text).map((paragraph, index) => <p key={index}>{paragraph}</p>)}
      </div>
    );
  }
  if (tile.query && state?.error) return <Notice tone="error">{state.error}</Notice>;
  const lookup = tile.query ? (state ? valueLookup(state.result) : () => "…") : () => null;
  return <RichText blocks={blocks} value={lookup} />;
}

// -------------------------------------------------------------------- Image

export function imageUrl(organisationId: string, dashboardId: string, imageId: string): string {
  return `/api/analytics/dashboards/${encodeURIComponent(dashboardId)}/images/${encodeURIComponent(imageId)}?organisationId=${encodeURIComponent(organisationId)}`;
}

export function ImageItemView({ organisationId, dashboardId, image, height }: { organisationId: string; dashboardId: string; image: ImageItem; height: number }) {
  return (
    <div className={styles.imageBox} style={{ height }}>
      {/* eslint-disable-next-line @next/next/no-img-element -- served from Tohyee's own API with the report's access check, not a static asset */}
      <img src={imageUrl(organisationId, dashboardId, image.id)} alt={image.alt ?? ""} className={image.fit === "cover" ? styles.cover : styles.contain} />
    </div>
  );
}

// -------------------------------------------------------------------- Shape

/** A chosen colour for both modes (its dark version worked out, decision 672), or the theme's. */
function both(hex: string | undefined, fallback: string): string {
  return hex ? `light-dark(${hex}, ${adaptForDark(hex, "mark")})` : fallback;
}

export function ShapeItemView({ shape, height }: { shape: ShapeItem; height: number }) {
  const markerId = useId().replace(/:/g, "");
  const stroke = both(shape.stroke, "var(--chart-1)");
  const fill = shape.kind === "line" || shape.kind === "arrow" ? "none" : both(shape.fill, "color-mix(in srgb, var(--chart-1) 14%, transparent)");
  const width = shape.strokeWidth ?? 2;
  const inset = Math.max(width, 1);
  const line = shape.kind === "line" || shape.kind === "arrow";
  const direction = shape.direction ?? "across";
  // Drawn in a 1000 x height box that stretches to the tile's width; lines keep their width.
  const box = { w: 1000, h: Math.max(40, height) };
  const ends =
    direction === "down"
      ? { x1: box.w / 2, y1: inset * 2, x2: box.w / 2, y2: box.h - inset * 2 }
      : direction === "diagonal"
        ? { x1: inset * 2, y1: box.h - inset * 2, x2: box.w - inset * 2, y2: inset * 2 }
        : { x1: inset * 2, y1: box.h / 2, x2: box.w - inset * 2, y2: box.h / 2 };
  return (
    <div className={styles.shape} style={{ height }}>
      <svg viewBox={`0 0 ${box.w} ${box.h}`} preserveAspectRatio="none" width="100%" height="100%" aria-hidden="true" focusable="false">
        {shape.kind === "arrow" ? (
          <defs>
            <marker id={markerId} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse" markerUnits="strokeWidth">
              <path d="M0,0 L10,5 L0,10 z" style={{ fill: stroke }} />
            </marker>
          </defs>
        ) : null}
        {line ? (
          <line {...ends} style={{ stroke }} strokeWidth={Math.max(1, width)} vectorEffect="non-scaling-stroke" strokeLinecap="round" markerEnd={shape.kind === "arrow" ? `url(#${markerId})` : undefined} />
        ) : shape.kind === "ellipse" ? (
          <ellipse cx={box.w / 2} cy={box.h / 2} rx={box.w / 2 - inset} ry={box.h / 2 - inset} style={{ fill, stroke }} strokeWidth={width} vectorEffect="non-scaling-stroke" />
        ) : (
          <rect x={inset} y={inset} width={box.w - inset * 2} height={box.h - inset * 2} rx={shape.kind === "rounded" ? 24 : 0} style={{ fill, stroke }} strokeWidth={width} vectorEffect="non-scaling-stroke" />
        )}
      </svg>
      {shape.text ? <span className={styles.shapeText}>{shape.text}</span> : null}
    </div>
  );
}

// ------------------------------------------------------------------- Button

export function ButtonItemView({ button, onAction }: { button: ButtonItem; onAction?: (action: ButtonAction, target?: string) => void }) {
  return (
    <div className={styles.buttonBox}>
      <Button variant="secondary" onClick={() => onAction?.(button.action, button.target)} disabled={!onAction}>
        {button.label}
      </Button>
    </div>
  );
}

// ------------------------------------------------------------------- Editor

const KINDS: Array<{ value: ItemVisual; label: string }> = [
  { value: "text", label: "Text" },
  { value: "image", label: "Image" },
  { value: "shape", label: "Shape or line" },
  { value: "button", label: "Button" },
];

const AGGREGATES: Array<{ value: Aggregate; label: string }> = [
  { value: "sum", label: "Total" },
  { value: "avg", label: "Average" },
  { value: "min", label: "Smallest" },
  { value: "max", label: "Largest" },
  { value: "count", label: "Count of rows" },
  { value: "count_distinct", label: "Count of different values" },
];

const SHAPE_LABELS: Record<ShapeKind, string> = { rectangle: "Rectangle", rounded: "Rounded rectangle", ellipse: "Circle or oval", line: "Line", arrow: "Arrow" };

const isDate = (type: string) => type === "DATE" || type.startsWith("TIMESTAMP");
const isNumber = (type: string) => /^(DECIMAL|BIGINT|INTEGER|SMALLINT|TINYINT|HUGEINT|DOUBLE|FLOAT|UBIGINT|UINTEGER)/.test(type);

type TableInfo = { name: string; columns: ColumnInfo[] };

function valuesQuery(table: TableInfo | undefined, measures: Measure[], previous: TileQuery | null): TileQuery {
  return {
    table: table?.name ?? "",
    groupBy: null,
    pivot: null,
    measures,
    filters: previous?.table === table?.name ? previous?.filters ?? [] : [],
    dateField: previous?.table === table?.name ? previous?.dateField ?? null : table?.columns.find((column) => isDate(column.type))?.name ?? null,
    sort: { by: "category", direction: "asc" },
    limit: null,
  };
}

/** Adding or changing a text item, image, shape or button (#376 phase 2). */
export function ItemEditor({
  saving,
  tile,
  organisationId,
  dashboardId,
  tables,
  filters,
  onSave,
  onCancel,
  targets = { pages: [], bookmarks: [] },
}: {
  saving: boolean;
  tile: Tile | null;
  organisationId: string;
  dashboardId: string;
  tables: TableInfo[];
  filters: TileFilters;
  onSave: (tile: Tile) => void;
  onCancel: () => void;
  /** The report's pages and bookmarks, for a button that opens one (decision 759). */
  targets?: { pages: Array<{ id: string; name: string }>; bookmarks: Array<{ id: string; name: string }> };
}) {
  const [kind, setKind] = useState<ItemVisual>(tile && (tile.visual === "text" || tile.visual === "image" || tile.visual === "shape" || tile.visual === "button") ? tile.visual : "text");
  const [title, setTitle] = useState(tile?.title ?? "");
  const [showTitle, setShowTitle] = useState(tile?.format?.card?.showTitle !== false);
  const [width, setWidth] = useState<TileWidth>(tile?.width ?? (tile ? "half" : "full"));
  const [height, setHeight] = useState<TileHeight>(tile?.height ?? "small");
  const [text, setText] = useState(tile?.text ?? "");
  // New text is rich; old notes stay plain until it's turned on, so they look as they always have.
  const [rich, setRich] = useState(tile ? tile.textFormat === "rich" : true);
  const [query, setQuery] = useState<TileQuery | null>(tile?.query ?? null);
  const [image, setImage] = useState<ImageItem | null>(tile?.image ?? null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [shape, setShape] = useState<ShapeItem>(tile?.shape ?? { kind: "rounded" });
  const [button, setButton] = useState<ButtonItem>(tile?.button ?? { label: "Reset filters", action: "reset_filters" });
  const table = tables.find((entry) => entry.name === query?.table);
  const blocks = useMemo(() => parseRichText(text), [text]);
  const names = valueNames(blocks);
  const preview = useTileResult(organisationId, rich && query && query.measures.length ? query : null, filters);
  const lookup = query && query.measures.length ? (preview?.result ? valueLookup(preview.result) : () => "…") : () => null;
  const missing = names.filter((name) => !query?.measures.some((measure) => measure.label.toLowerCase() === name.toLowerCase()));

  async function upload(file: File) {
    setUploadError(null);
    if (file.size > 5 * 1024 * 1024) {
      setUploadError(`${file.name} is more than 5 MB. A report's images can be up to 5 MB.`);
      return;
    }
    const form = new FormData();
    form.set("organisationId", organisationId);
    form.set("file", file, file.name);
    setUploading(true);
    try {
      const response = await fetch(`/api/analytics/dashboards/${encodeURIComponent(dashboardId)}/images`, { method: "POST", body: form, credentials: "same-origin" });
      const payload = (await response.json().catch(() => null)) as { image?: { id: string }; error?: string } | null;
      if (!response.ok || !payload?.image) throw new Error(payload?.error ?? `Upload failed (${response.status}).`);
      setImage({ ...image, id: payload.image.id, alt: image?.alt ?? file.name.replace(/\.[^.]+$/, "") });
    } catch (error) {
      setUploadError(errorMessage(error));
    } finally {
      setUploading(false);
    }
  }

  const setMeasure = (index: number, patch: Partial<Measure>) => {
    if (!query) return;
    setQuery({ ...query, measures: query.measures.map((measure, at) => (at === index ? { ...measure, ...patch } : measure)) });
  };
  const ready = kind === "image" ? Boolean(image) : kind === "button" ? button.label.trim().length > 0 && (!BUTTON_ACTIONS[button.action].target || Boolean(button.target)) : true;
  const save = () => {
    // The heading can be hidden (the card's "show the title"); the rest of a saved look is kept.
    const format: ChartFormat = { ...tile?.format };
    const card = { ...format.card };
    if (showTitle) delete card.showTitle;
    else card.showTitle = false;
    if (Object.keys(card).length) format.card = card;
    else delete format.card;
    const cleanFormat = Object.keys(format).length ? format : undefined;
    const base = { id: tile?.id ?? `t${Date.now().toString(36)}`, title: title.trim() || KINDS.find((entry) => entry.value === kind)!.label, visual: kind, width, ...(cleanFormat ? { format: cleanFormat } : {}) };
    if (kind === "text") {
      const values = rich && query && query.table && query.measures.length ? query : null;
      onSave({ ...base, query: values, ...(text.trim() ? { text: text.trim() } : {}), ...(rich ? { textFormat: "rich" as const } : {}) });
    } else if (kind === "image" && image) {
      onSave({ ...base, height, query: null, image });
    } else if (kind === "shape") {
      onSave({ ...base, height, query: null, shape });
    } else if (kind === "button") {
      onSave({ ...base, height: "small", query: null, button: { ...button, label: button.label.trim() } });
    }
  };

  return (
    <Card title={tile ? "Change the item" : "Add text or an item"} description="Text with bold, links, lists and values; an image; a shape or line; or a button.">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (ready) save();
        }}
      >
        <fieldset disabled={saving} className={styles.fields}>
          <div className={styles.grid}>
            <Field label="Kind">
              <select value={kind} onChange={(event) => setKind(event.target.value as ItemVisual)} disabled={Boolean(tile)}>
                {KINDS.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
              </select>
            </Field>
            <Field label="Heading">
              <input value={title} maxLength={100} placeholder={kind === "text" ? "e.g. Sales" : "Shown above it unless hidden"} onChange={(event) => setTitle(event.target.value)} />
            </Field>
            <label className={ui.checkbox}>
              <input type="checkbox" checked={showTitle} onChange={(event) => setShowTitle(event.target.checked)} /> Show the heading
            </label>
            <Field label="Width">
              <select value={width} onChange={(event) => setWidth(event.target.value as TileWidth)}>
                {TILE_WIDTHS.map((entry) => <option key={entry} value={entry}>{WIDTH_LABELS[entry]}</option>)}
              </select>
            </Field>
            {kind === "image" || kind === "shape" ? (
              <Field label="Height">
                <select value={height} onChange={(event) => setHeight(event.target.value as TileHeight)}>
                  {TILE_HEIGHTS.map((entry) => <option key={entry} value={entry}>{HEIGHT_LABELS[entry]}</option>)}
                </select>
              </Field>
            ) : null}
          </div>

          {kind === "text" ? (
            <>
              <label className={ui.checkbox}>
                <input type="checkbox" checked={rich} onChange={(event) => setRich(event.target.checked)} /> Formatting: bold, links, lists and values
              </label>
              <Field
                label="Text"
                hint={
                  rich
                    ? `**bold**, *italic*, [words](https://link), lines starting "- " or "1. " for lists, a blank line between paragraphs, {Value name} for a value below. Up to ${MAX_RICH_TEXT.toLocaleString("en-NZ")} characters.`
                    : "Plain text. Leave a blank line between paragraphs. Up to 2,000 characters."
                }
              >
                <textarea rows={6} maxLength={rich ? MAX_RICH_TEXT : 2000} value={text} onChange={(event) => setText(event.target.value)} />
              </Field>
              {rich ? (
                <fieldset className={styles.group}>
                  <legend>Values to use in the text</legend>
                  <p className={styles.note}>Each value is one total over the report&apos;s dates and filters. Use its name in braces, e.g. Sales this month: {"{Sales}"}.</p>
                  <Field label="Data source">
                    <select
                      value={query?.table ?? ""}
                      onChange={(event) => {
                        const chosen = tables.find((entry) => entry.name === event.target.value);
                        setQuery(chosen ? valuesQuery(chosen, query?.table === chosen.name ? query.measures : [], query) : null);
                      }}
                    >
                      <option value="">None (no values)</option>
                      {[...tables].sort((a, b) => tableLabel(a.name).localeCompare(tableLabel(b.name))).map((entry) => <option key={entry.name} value={entry.name}>{tableLabel(entry.name)}</option>)}
                    </select>
                  </Field>
                  {query && table ? (
                    <>
                      <Field label="Date range applies to">
                        <select value={query.dateField ?? ""} onChange={(event) => setQuery({ ...query, dateField: event.target.value || null })}>
                          <option value="">No date</option>
                          {table.columns.filter((column) => isDate(column.type)).map((column) => <option key={column.name} value={column.name}>{fieldLabel(column.name)}</option>)}
                        </select>
                      </Field>
                      {query.measures.map((measure, index) => (
                        <div key={index} className={styles.measure}>
                          <input aria-label={`Value ${index + 1} name`} value={measure.label} maxLength={80} onChange={(event) => setMeasure(index, { label: event.target.value })} />
                          <select aria-label={`Value ${index + 1} how`} value={measure.aggregate} onChange={(event) => setMeasure(index, { aggregate: event.target.value as Aggregate })}>
                            {AGGREGATES.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
                          </select>
                          {measure.aggregate !== "count" ? (
                            <select aria-label={`Value ${index + 1} of`} value={measure.field ?? ""} onChange={(event) => setMeasure(index, { field: event.target.value || undefined })}>
                              <option value="">Choose a column</option>
                              {table.columns.filter((column) => (measure.aggregate === "sum" || measure.aggregate === "avg" ? isNumber(column.type) : true)).map((column) => <option key={column.name} value={column.name}>{fieldLabel(column.name)}</option>)}
                            </select>
                          ) : null}
                          <Button size="small" variant="danger" onClick={() => setQuery({ ...query, measures: query.measures.filter((_entry, at) => at !== index) })}>Remove</Button>
                        </div>
                      ))}
                      <div>
                        <Button
                          size="small"
                          variant="secondary"
                          disabled={query.measures.length >= 6}
                          onClick={() => {
                            const money = table.columns.find((column) => /^DECIMAL\(\d+,2\)$/.test(column.type));
                            const next: Measure = money ? { label: "", aggregate: "sum", field: money.name } : { label: "", aggregate: "count" };
                            setQuery({ ...query, measures: [...query.measures, { ...next, label: measureLabel(next, query.table) }] });
                          }}
                        >
                          Add a value
                        </Button>
                      </div>
                    </>
                  ) : null}
                  {missing.length ? <Notice tone="warning">No value is called {missing.map((name) => `{${name}}`).join(", ")}; it shows as typed.</Notice> : null}
                  {preview?.error ? <Notice tone="error">{preview.error}</Notice> : null}
                </fieldset>
              ) : null}
              <h3 className={styles.previewHeading}>Preview</h3>
              <div className={styles.preview}>
                {rich ? <RichText blocks={blocks} value={lookup} /> : <div className={styles.plain}>{paragraphs(text).map((paragraph, index) => <p key={index}>{paragraph}</p>)}</div>}
              </div>
            </>
          ) : null}

          {kind === "image" ? (
            <>
              <Field label="Image" hint="JPG or PNG, up to 5 MB. Only people who can see this report can see it.">
                <input type="file" accept=".jpg,.jpeg,.png,image/jpeg,image/png" disabled={uploading} onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void upload(file);
                }} />
              </Field>
              {uploading ? <p className={ui.muted}>Uploading…</p> : null}
              {uploadError ? <Notice tone="error">{uploadError}</Notice> : null}
              {image ? (
                <>
                  <Field label="Description" hint="What it shows, for people who can't see it. Leave blank only if it's decoration.">
                    <input maxLength={250} value={image.alt ?? ""} onChange={(event) => setImage({ ...image, alt: event.target.value || undefined })} />
                  </Field>
                  <Field label="Fit">
                    <select value={image.fit ?? "contain"} onChange={(event) => setImage({ ...image, fit: event.target.value === "cover" ? "cover" : undefined })}>
                      <option value="contain">Show all of it</option>
                      <option value="cover">Fill the space (edges may be cut off)</option>
                    </select>
                  </Field>
                  <div className={styles.preview}><ImageItemView organisationId={organisationId} dashboardId={dashboardId} image={image} height={CHART_HEIGHTS[height]} /></div>
                </>
              ) : null}
            </>
          ) : null}

          {kind === "shape" ? (
            <>
              <div className={styles.grid}>
                <Field label="Shape">
                  <select value={shape.kind} onChange={(event) => setShape({ ...shape, kind: event.target.value as ShapeKind })}>
                    {SHAPE_KINDS.map((entry) => <option key={entry} value={entry}>{SHAPE_LABELS[entry]}</option>)}
                  </select>
                </Field>
                {shape.kind === "line" || shape.kind === "arrow" ? (
                  <Field label="Runs">
                    <select value={shape.direction ?? "across"} onChange={(event) => setShape({ ...shape, direction: event.target.value === "across" ? undefined : (event.target.value as ShapeItem["direction"]) })}>
                      <option value="across">Across</option>
                      <option value="down">Down</option>
                      <option value="diagonal">Corner to corner</option>
                    </select>
                  </Field>
                ) : null}
                <Field label="Line width" hint="0 to 12 pixels">
                  <input type="number" min={0} max={12} value={shape.strokeWidth ?? 2} onChange={(event) => {
                    const value = Number(event.target.value);
                    if (Number.isInteger(value) && value >= 0 && value <= 12) setShape({ ...shape, strokeWidth: value === 2 ? undefined : value });
                  }} />
                </Field>
              </div>
              {shape.kind !== "line" && shape.kind !== "arrow" ? <ColourInput label="Fill colour" value={shape.fill} onChange={(fill) => setShape({ ...shape, fill })} /> : null}
              <ColourInput label="Line colour" value={shape.stroke} onChange={(stroke) => setShape({ ...shape, stroke })} />
              {shape.kind !== "line" && shape.kind !== "arrow" ? (
                <Field label="Words on the shape">
                  <input maxLength={120} value={shape.text ?? ""} onChange={(event) => setShape({ ...shape, text: event.target.value || undefined })} />
                </Field>
              ) : null}
              <div className={styles.preview}><ShapeItemView shape={shape} height={CHART_HEIGHTS[height]} /></div>
            </>
          ) : null}

          {kind === "button" ? (
            <>
              <Field label="Label">
                <input maxLength={40} value={button.label} onChange={(event) => setButton({ ...button, label: event.target.value })} />
              </Field>
              <Field label="When it's pressed" hint={button.action === "back" ? "Back to the page shown before (after a drill-through or another button)." : button.action === "reset_filters" ? "The report's own dates and slicers, nothing clicked, drilled or hidden." : undefined}>
                <select value={button.action} onChange={(event) => {
                  const action = event.target.value as ButtonAction;
                  const list = BUTTON_ACTIONS[action].target === "page" ? targets.pages : BUTTON_ACTIONS[action].target === "bookmark" ? targets.bookmarks : [];
                  setButton({ label: button.label, action, ...(list.length ? { target: list[0].id } : {}) });
                }}>
                  {(Object.keys(BUTTON_ACTIONS) as ButtonAction[]).map((action) => (
                    <option key={action} value={action} disabled={(BUTTON_ACTIONS[action].target === "page" && targets.pages.length < 2) || (BUTTON_ACTIONS[action].target === "bookmark" && !targets.bookmarks.length)}>{BUTTON_ACTIONS[action].label}</option>
                  ))}
                </select>
              </Field>
              {BUTTON_ACTIONS[button.action].target ? (
                <Field label={BUTTON_ACTIONS[button.action].target === "page" ? "Page" : "Bookmark"}>
                  <select value={button.target ?? ""} onChange={(event) => setButton({ ...button, target: event.target.value })}>
                    {(BUTTON_ACTIONS[button.action].target === "page" ? targets.pages : targets.bookmarks).map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
                  </select>
                </Field>
              ) : null}
            </>
          ) : null}

          <div className={ui.rowButtons}>
            <Button type="submit" disabled={!ready || uploading}>{saving ? "Saving…" : tile ? "Apply changes" : "Add to report"}</Button>
            <Button variant="secondary" onClick={onCancel}>Cancel</Button>
          </div>
        </fieldset>
      </form>
    </Card>
  );
}
