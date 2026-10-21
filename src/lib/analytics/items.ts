import { hexColour } from "@/lib/analytics/chart-format";
import { ValidationError } from "@/lib/errors";

/**
 * A report's non-data items (#376 phase 2, decisions 683-686): text (rich,
 * with values), an image, a shape or line, and a button. They sit in the
 * report's grid like charts and are saved on the tile, checked here. Shared
 * with the browser.
 */

export const ITEM_VISUALS = ["text", "image", "shape", "button"] as const;
export type ItemVisual = (typeof ITEM_VISUALS)[number];

export function isItemVisual(visual: string): visual is ItemVisual {
  return (ITEM_VISUALS as readonly string[]).includes(visual);
}

export type ImageItem = {
  /** The stored image's id (one of this report's images). */
  id: string;
  /** Words for people who can't see it; blank for a purely decorative image. */
  alt?: string;
  /** Fit inside the tile (all of it shows) or fill it (edges may be cut off). */
  fit?: "contain" | "cover";
};

export const SHAPE_KINDS = ["rectangle", "rounded", "ellipse", "line", "arrow"] as const;
export type ShapeKind = (typeof SHAPE_KINDS)[number];
export type ShapeItem = {
  kind: ShapeKind;
  /** Inside colour (not for lines); left out, a wash of the theme's first colour. */
  fill?: string;
  /** Outline (or line) colour; left out, the theme's first colour. */
  stroke?: string;
  /** Outline or line width in pixels, 0 to 12. */
  strokeWidth?: number;
  /** A line or arrow can run across (the default), down, or corner to corner. */
  direction?: "across" | "down" | "diagonal";
  /** Words on the shape. */
  text?: string;
};

/**
 * What a button does. Only resetting the filters works today; going to
 * another page and opening a bookmark come with #376 phase 3 (pages and
 * bookmarks), so they're listed here as not yet available and refused when
 * saved. Adding one: give it a label here, accept it in `parseButton`, and
 * handle it in the report's `runButtonAction` (analytics-dashboards.tsx).
 */
export const BUTTON_ACTIONS = {
  reset_filters: { label: "Reset the filters", available: true },
  go_to_page: { label: "Go to a page (coming with report pages)", available: false },
  bookmark: { label: "Open a bookmark (coming with bookmarks)", available: false },
} as const;
export type ButtonAction = keyof typeof BUTTON_ACTIONS;
export type ButtonItem = { label: string; action: ButtonAction };

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function parseImage(input: unknown, what: string): ImageItem {
  const raw = object(input);
  if (typeof raw.id !== "string" || !/^\d{1,18}$/.test(raw.id)) throw new ValidationError(`${what}: upload an image.`);
  const alt = typeof raw.alt === "string" ? raw.alt.trim() : "";
  if (alt.length > 250) throw new ValidationError(`${what}: the description can be up to 250 characters.`);
  const fit = raw.fit === "cover" ? "cover" : raw.fit === "contain" || raw.fit === undefined || raw.fit === null ? undefined : null;
  if (fit === null) throw new ValidationError(`${what}: choose how the image fits.`);
  return { id: raw.id, ...(alt ? { alt } : {}), ...(fit ? { fit } : {}) };
}

export function parseShape(input: unknown, what: string): ShapeItem {
  const raw = object(input);
  const kind = raw.kind as ShapeKind;
  if (!SHAPE_KINDS.includes(kind)) throw new ValidationError(`${what}: choose a shape.`);
  let strokeWidth: number | undefined;
  if (raw.strokeWidth !== undefined && raw.strokeWidth !== null && raw.strokeWidth !== "") {
    strokeWidth = Number(raw.strokeWidth);
    if (!Number.isInteger(strokeWidth) || strokeWidth < 0 || strokeWidth > 12) throw new ValidationError(`${what}: the line width is a whole number from 0 to 12.`);
  }
  const direction = raw.direction === undefined || raw.direction === null || raw.direction === "" ? undefined : raw.direction;
  if (direction !== undefined && !["across", "down", "diagonal"].includes(direction as string)) throw new ValidationError(`${what}: choose which way the line runs.`);
  const text = typeof raw.text === "string" ? raw.text.trim() : "";
  if (text.length > 120) throw new ValidationError(`${what}: the words on a shape can be up to 120 characters.`);
  const lineLike = kind === "line" || kind === "arrow";
  return {
    kind,
    ...(!lineLike && raw.fill ? { fill: hexColour(raw.fill, `${what} fill colour`) } : {}),
    ...(raw.stroke ? { stroke: hexColour(raw.stroke, `${what} line colour`) } : {}),
    ...(strokeWidth !== undefined ? { strokeWidth } : {}),
    ...(lineLike && direction ? { direction: direction as ShapeItem["direction"] } : {}),
    ...(text && !lineLike ? { text } : {}),
  };
}

export function parseButton(input: unknown, what: string): ButtonItem {
  const raw = object(input);
  const label = typeof raw.label === "string" ? raw.label.trim() : "";
  if (!label || label.length > 40) throw new ValidationError(`${what}: give the button a label (up to 40 characters).`);
  const action = raw.action as ButtonAction;
  if (!(action in BUTTON_ACTIONS)) throw new ValidationError(`${what}: choose what the button does.`);
  if (!BUTTON_ACTIONS[action].available) throw new ValidationError(`${what}: "${BUTTON_ACTIONS[action].label}" isn't available yet.`);
  return { label, action };
}
