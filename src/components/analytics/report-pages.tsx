"use client";

import { useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ColourInput } from "@/components/analytics/colour-input";
import { Button, Field, ui } from "@/components/ui";
import { adaptForDark } from "@/lib/charts/colour-check";
import { PAGE_MAX_WIDTHS, PAGE_WIDTH_LABELS, PAGE_WIDTHS, reportPages, type PageWidth, type ReportPage } from "@/lib/analytics/pages";
import styles from "./report-pages.module.css";

/**
 * A report's page tabs (#376 phase 3, decision 753), and in edit mode its
 * page settings: name, width, background, shown in the tabs or not, order.
 * The arrow keys move between tabs (the WAI-ARIA tabs pattern).
 */
export function PageTabs({
  pages,
  current,
  onChoose,
  editing,
  onAdd,
  onUpdate,
  onMove,
  onRemove,
  panelId,
  filterEditor,
  pictures,
}: {
  pages: ReportPage[] | undefined;
  current: string;
  onChoose: (pageId: string) => void;
  editing: boolean;
  onAdd?: () => void;
  onUpdate?: (page: ReportPage) => void;
  onMove?: (pageId: string, by: -1 | 1) => void;
  onRemove?: (page: ReportPage) => void;
  /** The element the tabs control (the page's tiles). */
  panelId: string;
  /** Edit mode: the page's own filters (decision 758). */
  filterEditor?: (page: ReportPage) => ReactNode;
  /** Edit mode: where a page's background picture is uploaded to (#707). Left out, pictures aren't offered. */
  pictures?: { organisationId: string; dashboardId: string };
}) {
  const list = reportPages(pages);
  const shown = list.filter((page) => editing || !page.hidden || page.id === current);
  const [settings, setSettings] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const tabs = useRef<HTMLDivElement>(null);
  const page = list.find((entry) => entry.id === current) ?? list[0];
  const index = list.findIndex((entry) => entry.id === page.id);
  // One page and nothing to change: no tabs, as reports always looked.
  if (!editing && shown.length <= 1) return null;
  /** Uploads a picture as one of the report's images and puts it behind the page (kept when the report is saved). */
  async function uploadPicture(file: File | undefined) {
    if (!file || !pictures || !onUpdate) return;
    const form = new FormData();
    form.set("organisationId", pictures.organisationId);
    form.set("file", file, file.name);
    setUploading(true);
    setUploadError(null);
    try {
      const response = await fetch(`/api/analytics/dashboards/${encodeURIComponent(pictures.dashboardId)}/images`, { method: "POST", body: form, credentials: "same-origin" });
      const payload = (await response.json().catch(() => null)) as { image?: { id: string }; error?: string } | null;
      if (!response.ok || !payload?.image) throw new Error(payload?.error ?? `Upload failed (${response.status}).`);
      // Faded by half to start with, so tiles and headings stay readable over it.
      onUpdate({ ...page, picture: { id: payload.image.id, dim: page.picture?.dim ?? 50 } });
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : "The picture couldn't be uploaded.");
    } finally {
      setUploading(false);
    }
  }
  const focus = (at: number) => {
    const next = shown[(at + shown.length) % shown.length];
    onChoose(next.id);
    tabs.current?.querySelector<HTMLButtonElement>(`[data-page="${next.id}"]`)?.focus();
  };
  return (
    <div className={styles.bar}>
      <div className={styles.row}>
        <div ref={tabs} role="tablist" aria-label="Report pages" className={styles.tabs}>
          {shown.map((entry, at) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              data-page={entry.id}
              aria-selected={entry.id === page.id}
              aria-controls={panelId}
              tabIndex={entry.id === page.id ? 0 : -1}
              className={styles.tab}
              onClick={() => onChoose(entry.id)}
              onKeyDown={(event) => {
                if (event.key === "ArrowRight") focus(at + 1);
                else if (event.key === "ArrowLeft") focus(at - 1);
                else if (event.key === "Home") focus(0);
                else if (event.key === "End") focus(shown.length - 1);
                else return;
                event.preventDefault();
              }}
            >
              {entry.name}
              {entry.hidden ? <span className={styles.hiddenNote}> (hidden)</span> : null}
            </button>
          ))}
        </div>
        {editing ? (
          <div className={ui.rowButtons}>
            <Button size="small" variant="secondary" onClick={onAdd} disabled={list.length >= 12}>+ Add page</Button>
            <Button size="small" variant="secondary" aria-expanded={settings} onClick={() => setSettings(!settings)}>Page settings</Button>
          </div>
        ) : null}
      </div>
      {editing && settings && onUpdate ? (
        <fieldset className={styles.settings}>
          <legend>{page.name}</legend>
          <div className={styles.fields}>
            <Field label="Page name">
              <input value={page.name} maxLength={40} onChange={(event) => onUpdate({ ...page, name: event.target.value })} />
            </Field>
            <Field label="Width" hint="On phones every page fits the screen.">
              <select value={page.width ?? "full"} onChange={(event) => onUpdate({ ...withoutKey(page, "width"), ...(event.target.value === "full" ? {} : { width: event.target.value as PageWidth }) })}>
                {PAGE_WIDTHS.map((width) => <option key={width} value={width}>{PAGE_WIDTH_LABELS[width]}</option>)}
              </select>
            </Field>
            <Field label="Background">
              <select
                value={page.background === undefined ? "" : page.background === "tinted" ? "tinted" : "colour"}
                onChange={(event) => onUpdate({ ...withoutKey(page, "background"), ...(event.target.value === "tinted" ? { background: "tinted" } : event.target.value === "colour" ? { background: "#eef3f8" } : {}) })}
              >
                <option value="">As the theme</option>
                <option value="tinted">Shaded</option>
                <option value="colour">A colour</option>
              </select>
            </Field>
            {page.background && page.background !== "tinted" ? (
              <ColourInput label="Background colour" value={page.background} resetLabel="Back to the theme" onChange={(colour) => onUpdate({ ...withoutKey(page, "background"), ...(colour ? { background: colour } : {}) })} />
            ) : null}
            {pictures ? (
              <Field label="Background picture" hint="A JPG or PNG up to 5 MB. It covers the page, behind the tiles.">
                <input type="file" accept="image/png,image/jpeg,image/webp" disabled={uploading} onChange={(event) => void uploadPicture(event.target.files?.[0])} />
              </Field>
            ) : null}
            {pictures && page.picture ? (
              <Field label="Fade the picture" hint="More fade keeps charts and words easier to read.">
                <input
                  type="range"
                  min={0}
                  max={90}
                  step={10}
                  value={page.picture.dim ?? 0}
                  aria-valuetext={`${page.picture.dim ?? 0}%`}
                  onChange={(event) => onUpdate({ ...page, picture: { id: page.picture!.id, ...(Number(event.target.value) ? { dim: Number(event.target.value) } : {}) } })}
                />
              </Field>
            ) : null}
          </div>
          {pictures && page.picture ? (
            <div className={ui.rowButtons}>
              <Button size="small" variant="secondary" onClick={() => onUpdate(withoutKey(page, "picture"))}>Remove the background picture</Button>
            </div>
          ) : null}
          {uploadError ? <p className={ui.muted} role="alert">{uploadError}</p> : null}
          <label className={ui.checkbox}>
            <input type="checkbox" checked={page.hidden === true} disabled={!page.hidden && list.filter((entry) => !entry.hidden).length <= 1} onChange={(event) => onUpdate({ ...withoutKey(page, "hidden"), ...(event.target.checked ? { hidden: true } : {}) })} />{" "}
            Hide from the page tabs (opened by drill-through or a button)
          </label>
          <label className={ui.checkbox}>
            <input type="checkbox" checked={page.drillThrough === true} onChange={(event) => onUpdate({ ...withoutKey(page, "drillThrough"), ...(event.target.checked ? { drillThrough: true } : {}) })} />{" "}
            Drill-through page: a group chosen on another page can open this page, showing only that group
          </label>
          {filterEditor ? filterEditor(page) : null}
          <div className={ui.rowButtons}>
            <Button size="small" variant="secondary" disabled={index === 0} onClick={() => onMove?.(page.id, -1)} aria-label={`Move ${page.name} earlier`}>Move earlier</Button>
            <Button size="small" variant="secondary" disabled={index === list.length - 1} onClick={() => onMove?.(page.id, 1)} aria-label={`Move ${page.name} later`}>Move later</Button>
            <Button size="small" variant="danger" disabled={list.length <= 1} onClick={() => onRemove?.(page)}>Remove page</Button>
          </div>
        </fieldset>
      ) : null}
    </div>
  );
}

function withoutKey<T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

/** How a page is drawn: its width and background (a chosen colour gets a dark version). */
export function pageStyle(page: ReportPage, pictures?: { organisationId: string; dashboardId: string }): { style: CSSProperties; tinted: boolean } {
  const max = PAGE_MAX_WIDTHS[page.width ?? "full"];
  const style: CSSProperties = max ? { maxWidth: `${max}px`, marginInline: "auto" } : {};
  if (page.background && page.background !== "tinted") style.background = `light-dark(${page.background}, ${adaptForDark(page.background, "surface")})`;
  // A picture behind the tiles (#707), washed towards the page colour by its fade so words stay readable.
  if (page.picture && pictures) {
    const address = `/api/analytics/dashboards/${encodeURIComponent(pictures.dashboardId)}/images/${encodeURIComponent(page.picture.id)}?organisationId=${encodeURIComponent(pictures.organisationId)}`;
    const colour = page.background && page.background !== "tinted" ? `light-dark(${page.background}, ${adaptForDark(page.background, "surface")})` : "var(--page, var(--background))";
    const wash = `color-mix(in srgb, ${colour} ${page.picture.dim ?? 0}%, transparent)`;
    style.background = `linear-gradient(${wash}, ${wash}), url("${address}") center / cover no-repeat`;
  }
  return { style, tinted: page.background === "tinted" };
}
