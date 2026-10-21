"use client";

import { useMemo, useRef, useState } from "react";
import { Chart } from "@/components/analytics/chart";
import { useConfirm } from "@/components/confirm-dialog";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Field, Notice, ui } from "@/components/ui";
import type { ChartSpec } from "@/lib/analytics/chart-spec";
import type { SavedTheme } from "@/lib/analytics/themes";
import { isHex, type ColourWarning, type Mode } from "@/lib/charts/colour-check";
import {
  BUILT_IN_IDS,
  BUILT_IN_THEMES,
  CUSTOM_PREFIX,
  FONTS,
  checkTheme,
  deriveDark,
  exportTheme,
  importTheme,
  themeVariables,
  type FontId,
  type ReportTheme,
  type ThemeColours,
} from "@/lib/charts/report-themes";
import { api, errorMessage } from "@/lib/client/api";
import styles from "./theme-panel.module.css";

type Props = {
  organisationId: string;
  /** The report's choice: a built-in id, "custom:<id>", or nothing for Tohyee. */
  choice: string | undefined;
  /** The theme it shows now. */
  current: ReportTheme;
  onChoose: (choice: string | undefined, theme: ReportTheme) => void;
  onClose: () => void;
};

const SAMPLE_ROWS = [
  { category: "Jul", a: "420", b: "310", c: "190", d: "260" },
  { category: "Aug", a: "380", b: "350", c: "230", d: "210" },
  { category: "Sep", a: "510", b: "290", c: "270", d: "300" },
];
const SAMPLE_SPEC: ChartSpec = {
  kind: "column",
  category: "category",
  series: [
    { field: "a", label: "Sales", kind: "number" },
    { field: "b", label: "Costs", kind: "number" },
    { field: "c", label: "Wages", kind: "number" },
    { field: "d", label: "Other", kind: "number" },
  ],
  valueFormat: "number",
  format: { labels: { show: false } },
};

function Swatches({ colours }: { colours: string[] }) {
  return (
    <span className={styles.swatches} aria-hidden="true">
      {colours.slice(0, 8).map((colour, index) => <span key={index} style={{ background: colour }} />)}
    </span>
  );
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${name.trim().replace(/[^a-z0-9-]+/gi, "-").replace(/^-|-$/g, "") || "theme"}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

/** Choosing a report's theme, and making, importing and exporting the organisation's own (#376, decision 668). */
export function ThemePanel({ organisationId, choice, current, onChoose, onClose }: Props) {
  const confirm = useConfirm();
  const themes = useApiData<{ themes: SavedTheme[] }>("/api/analytics/themes", { organisationId });
  const [editing, setEditing] = useState<{ id: string | null; theme: ReportTheme } | null>(null);
  const [message, setMessage] = useState<{ tone: "error" | "success"; text: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const saved = themes.data?.themes ?? [];
  const chosenCustom = choice?.startsWith(CUSTOM_PREFIX) ? saved.find((entry) => `${CUSTOM_PREFIX}${entry.id}` === choice) : undefined;
  const selected = choice ?? "tohyee";

  async function remove(entry: SavedTheme) {
    if (!(await confirm(`Remove the ${entry.theme.name} theme? Reports using it need another theme first.`, { title: "Remove theme?", confirmLabel: "Remove", danger: true }))) return;
    setMessage(null);
    try {
      await api(`/api/analytics/themes/${entry.id}`, { method: "DELETE", query: { organisationId } });
      themes.reload();
      setMessage({ tone: "success", text: `${entry.theme.name} removed.` });
    } catch (error) {
      setMessage({ tone: "error", text: errorMessage(error) });
    }
  }

  async function importFile(file: File) {
    setMessage(null);
    try {
      const theme = importTheme(await file.text());
      setEditing({ id: null, theme });
    } catch (error) {
      setMessage({ tone: "error", text: errorMessage(error) });
    }
  }

  if (editing) {
    return (
      <ThemeEditor
        organisationId={organisationId}
        id={editing.id}
        initial={editing.theme}
        taken={saved.filter((entry) => entry.id !== editing.id).map((entry) => entry.theme.name.toLowerCase())}
        onCancel={() => setEditing(null)}
        onSaved={(entry) => {
          themes.reload();
          setEditing(null);
          onChoose(`${CUSTOM_PREFIX}${entry.id}`, entry.theme);
          setMessage({ tone: "success", text: `${entry.theme.name} saved for the organisation and chosen for this report. Save the report to keep it.` });
        }}
      />
    );
  }

  return (
    <Card
      title="Report theme"
      description="Colours, font and cards for this report's charts. Tohyee is the default, and what charts everywhere else use. Your own themes are saved for the whole organisation."
      actions={<Button size="small" variant="secondary" onClick={onClose}>Close</Button>}
    >
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      {themes.error ? <Notice tone="error">{themes.error}</Notice> : null}
      <fieldset className={styles.choices}>
        <legend>Built-in themes</legend>
        {BUILT_IN_IDS.map((id) => (
          <label key={id} className={styles.choice}>
            <input type="radio" name="report-theme" checked={selected === id} onChange={() => onChoose(id === "tohyee" ? undefined : id, BUILT_IN_THEMES[id])} />
            <span>
              <strong>{BUILT_IN_THEMES[id].name}{id === "tohyee" ? " (default)" : ""}</strong>
              <Swatches colours={BUILT_IN_THEMES[id].light.series} />
            </span>
          </label>
        ))}
      </fieldset>
      <fieldset className={styles.choices}>
        <legend>This organisation&apos;s themes</legend>
        {!themes.data ? <p className={ui.muted}>Loading…</p> : saved.length === 0 ? <p className={ui.muted}>None yet. Make one with New theme, or import a theme file.</p> : null}
        {saved.map((entry) => (
          <label key={entry.id} className={styles.choice}>
            <input type="radio" name="report-theme" checked={selected === `${CUSTOM_PREFIX}${entry.id}`} onChange={() => onChoose(`${CUSTOM_PREFIX}${entry.id}`, entry.theme)} />
            <span>
              <strong>{entry.theme.name}</strong>
              <Swatches colours={entry.theme.light.series} />
              <span className={ui.muted}>
                {entry.reports === 1 ? "Used by 1 report" : `Used by ${entry.reports} reports`}
                {entry.warnings.length ? <> · <Badge tone="amber">{entry.warnings.length} colour {entry.warnings.length === 1 ? "warning" : "warnings"}</Badge></> : null}
              </span>
            </span>
          </label>
        ))}
      </fieldset>
      <div className={styles.buttons}>
        <Button size="small" variant="secondary" onClick={() => setEditing({ id: null, theme: { ...structuredClone(current), name: `${current.name} copy` } })}>
          New theme from {current.name}
        </Button>
        {chosenCustom ? (
          <>
            <Button size="small" variant="secondary" onClick={() => setEditing({ id: chosenCustom.id, theme: structuredClone(chosenCustom.theme) })}>Edit {chosenCustom.theme.name}</Button>
            <Button size="small" variant="danger" onClick={() => void remove(chosenCustom)}>Remove {chosenCustom.theme.name}</Button>
          </>
        ) : null}
        <Button size="small" variant="secondary" onClick={() => download(current.name, exportTheme(current))}>Export {current.name}</Button>
        <Button size="small" variant="secondary" onClick={() => fileInput.current?.click()}>Import a theme file</Button>
        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          className={styles.hiddenInput}
          aria-label="Theme file to import"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void importFile(file);
          }}
        />
      </div>
    </Card>
  );
}

/** Problems that stop a theme being saved (the server refuses them too). */
function blockers(theme: ReportTheme): string[] {
  const problems: string[] = [];
  if (!theme.name.trim()) problems.push("Give the theme a name.");
  for (const mode of ["light", "dark"] as Mode[]) {
    const colours = theme[mode];
    const label = mode === "light" ? "Light" : "Dark";
    colours.series.forEach((colour, index) => {
      if (!isHex(colour)) problems.push(`${label}: chart colour ${index + 1} should be a colour like #1f5fae.`);
    });
    for (const [key, name] of [["page", "page background"], ["card", "card background"], ["text", "text"], ["mutedText", "muted text"]] as const) {
      if (!isHex(colours[key])) problems.push(`${label}: ${name} should be a colour like #1f5fae.`);
    }
  }
  return problems;
}

function ColourField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <div className={styles.colourField}>
      <input type="color" aria-label={`${label} picker`} value={isHex(value) ? value : "#000000"} onChange={(event) => onChange(event.target.value)} />
      <Field label={label}>
        <input value={value} maxLength={7} spellCheck={false} onChange={(event) => onChange(event.target.value.trim().toLowerCase())} />
      </Field>
    </div>
  );
}

function sizeValue(value: string): number | undefined {
  return value === "" ? undefined : Number(value);
}

function ThemeEditor({
  organisationId,
  id,
  initial,
  taken,
  onCancel,
  onSaved,
}: {
  organisationId: string;
  id: string | null;
  initial: ReportTheme;
  taken: string[];
  onCancel: () => void;
  onSaved: (entry: SavedTheme) => void;
}) {
  const [theme, setTheme] = useState<ReportTheme>(initial);
  const [mode, setMode] = useState<Mode>("light");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const colours = theme[mode];
  const problems = blockers(theme);
  if (taken.includes(theme.name.trim().toLowerCase())) problems.push(`There's already a theme called ${theme.name.trim()}.`);
  const warnings: ColourWarning[] = useMemo(() => (blockers(theme).length ? [] : checkTheme(theme)), [theme]);
  const preview = useMemo(() => (blockers(theme).length ? null : themeVariables(theme, mode)), [theme, mode]);

  const setColours = (patch: Partial<ThemeColours>) => setTheme({ ...theme, [mode]: { ...colours, ...patch } });
  const setSeries = (index: number, value: string) => setColours({ series: colours.series.map((colour, at) => (at === index ? value : colour)) });

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const body = { organisationId, theme };
      const result = id
        ? await api<{ theme: SavedTheme }>(`/api/analytics/themes/${id}`, { method: "PATCH", body })
        : await api<{ theme: SavedTheme }>("/api/analytics/themes", { method: "POST", body });
      onSaved(result.theme);
    } catch (caught) {
      setError(errorMessage(caught));
      setBusy(false);
    }
  }

  return (
    <Card
      title={id ? `Edit ${initial.name}` : "New theme"}
      description="Any colours you like. Tohyee checks them for colour-blind readers, contrast and light and dark, and warns you, but it's your choice. Changing a saved theme changes every report that uses it."
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={styles.editor}>
        <div className={styles.fields}>
          <Field label="Theme name">
            <input value={theme.name} maxLength={60} onChange={(event) => setTheme({ ...theme, name: event.target.value })} />
          </Field>
          <div className={styles.modes} role="group" aria-label="Colours for">
            <Button size="small" variant="secondary" aria-pressed={mode === "light"} onClick={() => setMode("light")}>Light</Button>
            <Button size="small" variant="secondary" aria-pressed={mode === "dark"} onClick={() => setMode("dark")}>Dark</Button>
            {mode === "dark" ? (
              <Button size="small" variant="secondary" disabled={blockers({ ...theme, dark: theme.light }).length > 0} onClick={() => setTheme({ ...theme, dark: deriveDark(theme.light) })}>
                Work out dark from light
              </Button>
            ) : null}
          </div>
          <fieldset className={styles.group}>
            <legend>Chart colours ({mode}), in order</legend>
            <div className={styles.seriesGrid}>
              {colours.series.map((colour, index) => (
                <div key={index} className={styles.seriesItem}>
                  <ColourField label={`Colour ${index + 1}`} value={colour} onChange={(value) => setSeries(index, value)} />
                  <Button
                    size="small"
                    variant="secondary"
                    aria-label={`Remove colour ${index + 1}`}
                    disabled={colours.series.length <= 2}
                    onClick={() => {
                      // Both modes keep the same number of colours, so a series has a colour in each.
                      const drop = (list: string[]) => list.filter((_colour, at) => at !== index);
                      setTheme({ ...theme, light: { ...theme.light, series: drop(theme.light.series) }, dark: { ...theme.dark, series: drop(theme.dark.series) } });
                    }}
                  >
                    ×
                  </Button>
                </div>
              ))}
            </div>
            <div>
              <Button
                size="small"
                variant="secondary"
                disabled={colours.series.length >= 12}
                onClick={() => {
                  const next = (list: string[], fallback: string[]) => [...list, fallback[list.length % fallback.length]];
                  setTheme({
                    ...theme,
                    light: { ...theme.light, series: next(theme.light.series, BUILT_IN_THEMES.bright.light.series) },
                    dark: { ...theme.dark, series: next(theme.dark.series, BUILT_IN_THEMES.bright.dark.series) },
                  });
                }}
              >
                Add a colour (up to 12)
              </Button>
            </div>
          </fieldset>
          <fieldset className={styles.group}>
            <legend>Backgrounds and text ({mode})</legend>
            <div className={styles.pair}>
              <ColourField label="Page background" value={colours.page} onChange={(page) => setColours({ page })} />
              <ColourField label="Card background" value={colours.card} onChange={(card) => setColours({ card, grid: undefined, border: undefined })} />
              <ColourField label="Text" value={colours.text} onChange={(text) => setColours({ text, grid: undefined, border: undefined })} />
              <ColourField label="Muted text" value={colours.mutedText} onChange={(mutedText) => setColours({ mutedText })} />
            </div>
          </fieldset>
          <fieldset className={styles.group}>
            <legend>Text</legend>
            <div className={styles.pair}>
              <Field label="Font">
                <select value={theme.font ?? "app"} onChange={(event) => setTheme({ ...theme, font: event.target.value === "app" ? undefined : (event.target.value as FontId) })}>
                  {(Object.keys(FONTS) as FontId[]).map((font) => <option key={font} value={font}>{FONTS[font].label}</option>)}
                </select>
              </Field>
              <Field label="Title size" hint="12 to 28">
                <input type="number" min={12} max={28} placeholder="Automatic" value={theme.sizes?.title ?? ""} onChange={(event) => setTheme({ ...theme, sizes: { ...theme.sizes, title: sizeValue(event.target.value) } })} />
              </Field>
              <Field label="Label and legend size" hint="9 to 18">
                <input type="number" min={9} max={18} placeholder="12" value={theme.sizes?.labels ?? ""} onChange={(event) => setTheme({ ...theme, sizes: { ...theme.sizes, labels: sizeValue(event.target.value) } })} />
              </Field>
              <Field label="Axis text size" hint="9 to 18">
                <input type="number" min={9} max={18} placeholder="12" value={theme.sizes?.axes ?? ""} onChange={(event) => setTheme({ ...theme, sizes: { ...theme.sizes, axes: sizeValue(event.target.value) } })} />
              </Field>
            </div>
          </fieldset>
          <fieldset className={styles.group}>
            <legend>Cards</legend>
            <div className={styles.pair}>
              <Field label="Corner radius" hint="0 to 24 pixels">
                <input type="number" min={0} max={24} placeholder="Automatic" value={theme.card?.radius ?? ""} onChange={(event) => setTheme({ ...theme, card: { ...theme.card, radius: sizeValue(event.target.value) } })} />
              </Field>
              <Field label="Border width" hint="0 to 4 pixels">
                <input type="number" min={0} max={4} placeholder="1" value={theme.card?.border ?? ""} onChange={(event) => setTheme({ ...theme, card: { ...theme.card, border: sizeValue(event.target.value) } })} />
              </Field>
              <Field label="Shadow">
                <select value={theme.card?.shadow ?? "none"} onChange={(event) => setTheme({ ...theme, card: { ...theme.card, shadow: event.target.value === "none" ? undefined : (event.target.value as "soft" | "strong") } })}>
                  <option value="none">None</option>
                  <option value="soft">Soft</option>
                  <option value="strong">Strong</option>
                </select>
              </Field>
              <Field label="Padding" hint="4 to 32 pixels">
                <input type="number" min={4} max={32} placeholder="16" value={theme.card?.padding ?? ""} onChange={(event) => setTheme({ ...theme, card: { ...theme.card, padding: sizeValue(event.target.value) } })} />
              </Field>
            </div>
          </fieldset>
        </div>
        <div className={styles.side}>
          <h3 className={styles.sideHeading}>Preview ({mode})</h3>
          {preview ? (
            <div className={styles.preview} style={{ ...(preview as React.CSSProperties), background: preview["--report-page"] }}>
              <div className={styles.previewCard} style={{ background: preview["--report-card"], color: preview["--report-text"], borderRadius: preview["--report-radius"], boxShadow: preview["--report-shadow"], padding: preview["--report-padding"], borderWidth: preview["--report-border-width"], borderColor: preview["--report-border"], fontFamily: preview["--report-font"] }}>
                <strong style={{ fontSize: preview["--report-title-size"] }}>Sample chart</strong>
                <p style={{ color: preview["--report-text-muted"], margin: "2px 0 8px" }}>Muted text</p>
                <PreviewChart themeKey={JSON.stringify(preview)} />
              </div>
            </div>
          ) : (
            <p className={ui.muted}>Fix the colours to see a preview.</p>
          )}
          <h3 className={styles.sideHeading}>Colour checks</h3>
          {problems.length ? (
            <Notice tone="error">
              <ul className={styles.list}>{problems.map((problem) => <li key={problem}>{problem}</li>)}</ul>
            </Notice>
          ) : warnings.length ? (
            <Notice tone="warning">
              <p>You can still save these; charts will show them as they are.</p>
              <ul className={styles.list}>{warnings.map((warning) => <li key={warning.message}>{warning.message}</li>)}</ul>
            </Notice>
          ) : (
            <Notice tone="success">These colours pass every check in light and dark.</Notice>
          )}
        </div>
      </div>
      <div className={styles.buttons}>
        <Button disabled={busy || problems.length > 0} onClick={() => void save()}>{busy ? "Saving…" : id ? "Save theme" : "Save theme for the organisation"}</Button>
        <Button variant="secondary" disabled={problems.length > 0} onClick={() => download(theme.name, exportTheme(theme))}>Export</Button>
        <Button variant="secondary" onClick={onCancel}>Cancel</Button>
      </div>
    </Card>
  );
}

/** A small chart drawn in the preview's colours (a key so it reads them again on every change). */
function PreviewChart({ themeKey }: { themeKey: string }) {
  return <Chart key={themeKey} spec={SAMPLE_SPEC} rows={SAMPLE_ROWS} height={180} />;
}
