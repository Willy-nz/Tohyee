"use client";

import { createContext, useContext, type ReactNode } from "react";
import { Button } from "@/components/ui";
import type { ChartFormat } from "@/lib/analytics/chart-format";
import { settingSource, sourceText, type SettingPath } from "@/lib/analytics/editor-panels";
import styles from "./chart-format-panel.module.css";

/**
 * Where each setting in the Style panel comes from (#387, decision 750):
 * the chart's own override, the report's default for the chart type, or the
 * report theme, with a Reset at the level that set it.
 */
export type SourceInfo = {
  /** The chart's own settings (not merged with the default). */
  own: ChartFormat | undefined;
  /** The report's default for the chart type. */
  inherited: ChartFormat | undefined;
  chartTypeName: string;
  themeName: string;
  /** Takes these settings off the chart, so its default or the theme shows. */
  resetOwn: (paths: SettingPath[]) => void;
  /** Takes these settings off the chart type default, for every chart of the type that doesn't set them. */
  resetDefault?: (paths: SettingPath[]) => void;
};

const SourceContext = createContext<SourceInfo | null>(null);

export function SourceProvider({ value, children }: { value: SourceInfo; children: ReactNode }) {
  return <SourceContext.Provider value={value}>{children}</SourceContext.Provider>;
}

function asList(paths: SettingPath | SettingPath[]): SettingPath[] {
  return (Array.isArray(paths[0]) ? paths : [paths]) as SettingPath[];
}

/** The source of a setting, or null outside a provider. */
export function useSettingSource(paths: SettingPath | SettingPath[] | undefined) {
  const info = useContext(SourceContext);
  if (!info || !paths) return null;
  return { info, source: settingSource(paths, info.own, info.inherited) };
}

/** "Changed on this chart · Reset", "From this report's columns default · Reset the default" or "From the theme". */
export function SourceTag({ paths, what, name }: { paths: SettingPath | SettingPath[]; what: string; /** Says which setting, e.g. "Number format". */ name?: string }) {
  const found = useSettingSource(paths);
  if (!found) return null;
  const { info, source } = found;
  const list = asList(paths);
  const behind = settingSource(paths, undefined, info.inherited) === "default" ? `the ${info.chartTypeName.toLowerCase()} default` : "the theme";
  return (
    <p className={styles.source} data-source={source}>
      <span className={styles.sourceText}>{name ? `${name}: ${sourceText(source, info.chartTypeName, info.themeName).replace(/^./, (letter) => letter.toLowerCase())}` : sourceText(source, info.chartTypeName, info.themeName)}</span>
      {source === "chart" ? (
        <Button size="small" variant="secondary" aria-label={`Reset ${what} to ${behind}`} title={`Back to ${behind}; nothing else changes`} onClick={() => info.resetOwn(list)}>
          Reset
        </Button>
      ) : source === "default" && info.resetDefault ? (
        <Button
          size="small"
          variant="secondary"
          aria-label={`Reset ${what} in the ${info.chartTypeName.toLowerCase()} default`}
          title={`Every ${info.chartTypeName.toLowerCase()} chart in this report that doesn't set its own goes back to the theme`}
          onClick={() => info.resetDefault?.(list)}
        >
          Reset the default
        </Button>
      ) : null}
    </p>
  );
}

/** A folding section of the Style panel; with `paths`, it says where its settings come from, even folded. */
export function SettingSection({ title, children, open, paths }: { title: string; children: ReactNode; open?: boolean; paths?: SettingPath | SettingPath[] }) {
  const found = useSettingSource(paths);
  return (
    <details className={styles.section} open={open}>
      <summary>
        {title}
        {found?.source === "chart" ? <span className={styles.changed}> · changed</span> : found?.source === "default" ? <span className={styles.changed}> · default</span> : null}
      </summary>
      <div className={styles.body}>
        {paths ? <SourceTag paths={paths} what={title.toLowerCase()} /> : null}
        {children}
      </div>
    </details>
  );
}
