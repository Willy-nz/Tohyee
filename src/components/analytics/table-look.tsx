"use client";

import type { CSSProperties, ReactNode } from "react";
import type { ChartFormat, TableStyle } from "@/lib/analytics/chart-format";
import { cellLook, inkOn, type CellLook } from "@/lib/analytics/conditional";
import { adaptForDark } from "@/lib/charts/colour-check";
import styles from "./table-look.module.css";

/**
 * Table and pivot styling and conditional formatting (#376). Colours are
 * given for light and dark with CSS light-dark(): a chosen colour gets its
 * dark version (decision 672), and text on a coloured cell is picked to
 * read on it in each mode.
 */

function both(hex: string, role: "surface" | "text" | "mark"): string {
  return `light-dark(${hex}, ${adaptForDark(hex, role)})`;
}

/** The class for a totals or subtotal row: bold (the usual) or shaded. */
export function totalRowClass(style: TableStyle | undefined, bold: string): string {
  return style?.totalsStyle === "shaded" ? styles.totalShaded : bold;
}

/** The table's own CSS variables and classes. */
export function tableLook(style: TableStyle | undefined): { className: string; style: CSSProperties } {
  const variables: Record<string, string> = {};
  if (style?.headerBackground) variables["--table-header-bg"] = both(style.headerBackground, "surface");
  if (style?.headerColor) variables["--table-header-text"] = both(style.headerColor, "text");
  else if (style?.headerBackground) variables["--table-header-text"] = `light-dark(${inkOn(style.headerBackground)}, ${inkOn(adaptForDark(style.headerBackground, "surface"))})`;
  if (style?.bandColor) variables["--table-band"] = both(style.bandColor, "surface");
  if (style?.fontSize) variables["--table-size"] = `${style.fontSize}px`;
  if (style?.columnWidth) variables["--table-column"] = `${style.columnWidth}px`;
  const className = [
    styles.table,
    style?.headerBackground || style?.headerColor ? styles.header : "",
    style?.banded ? styles.banded : "",
    style?.gridlines === "rows" ? styles.rowLines : style?.gridlines === "none" ? styles.noLines : style?.gridlines === "all" ? styles.allLines : "",
    style?.fontSize ? styles.sized : "",
    style?.columnWidth ? styles.widths : "",
    style?.wrap ? styles.wrap : "",
  ].filter(Boolean).join(" ");
  return { className, style: variables as CSSProperties };
}

function cellCss(look: CellLook): CSSProperties | undefined {
  if (!look.background && !look.color) return undefined;
  const css: CSSProperties = {};
  if (look.background) css.background = both(look.background, "surface");
  if (look.color) {
    css.color = look.autoInk && look.background
      ? `light-dark(${look.color}, ${inkOn(adaptForDark(look.background, "surface"))})`
      : both(look.color, "text");
  }
  return css;
}

const ICON_TONES = { good: styles.good, same: styles.same, bad: styles.bad } as const;

/** A value's cell contents with its data bar and icon (the words are there for screen readers). */
export function FormattedCell({
  format,
  valueIndex,
  value,
  range,
  field,
  children,
  className,
  as: Tag = "td",
}: {
  format: ChartFormat | undefined;
  valueIndex: number;
  value: string | null;
  range: { low: number; high: number } | null;
  field: string | null;
  children: ReactNode;
  className?: string;
  as?: "td" | "th";
}) {
  const look = cellLook(format, valueIndex, value, range, field);
  return (
    <Tag className={`${className ?? ""} ${look.bar ? styles.barCell : ""}`} style={cellCss(look)}>
      {look.bar ? (
        <span
          className={styles.bar}
          style={{ width: `${look.bar.percent}%`, ...(look.bar.color ? { background: both(look.bar.color, "mark") } : {}) }}
          aria-hidden="true"
        />
      ) : null}
      <span className={styles.cellText}>
        {look.icon ? (
          <>
            <span className={`${styles.icon} ${ICON_TONES[look.icon.tone]}`} aria-hidden="true">{look.icon.glyph}</span>
            <span className={styles.visuallyHidden}>({look.icon.label}) </span>
          </>
        ) : null}
        {children}
      </span>
    </Tag>
  );
}
