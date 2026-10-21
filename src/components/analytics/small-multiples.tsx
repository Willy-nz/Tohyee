"use client";

import { useMemo } from "react";
import { Chart } from "@/components/analytics/chart";
import type { ChartSpec } from "@/lib/analytics/chart-spec";
import { facetSpec, seriesSwatch, smallMultiples } from "@/lib/analytics/small-multiples";
import styles from "./small-multiples.module.css";

type Props = {
  spec: ChartSpec;
  rows: Array<Record<string, string | number | null>>;
  /** Which values can be added into "Other". */
  additive: boolean[];
  /** Each small chart's height in pixels. */
  height: number;
  compact?: boolean;
};

/** Small multiples (#376 phase 2, decision 681): one small chart per value of the second grouping, on one scale. */
export function SmallMultiplesView({ spec, rows, additive, height, compact }: Props) {
  const multiples = useMemo(
    () => smallMultiples(rows, spec, { max: compact ? Math.min(4, spec.format?.smallMultiples?.max ?? 4) : spec.format?.smallMultiples?.max, additive, format: spec.format }),
    [rows, spec, additive, compact],
  );
  const specs = useMemo(() => multiples.facets.map((_facet, index) => facetSpec(spec, multiples, index)), [multiples, spec]);
  const drawn = spec.series.map((series, index) => ({ series, index })).filter(({ index }) => spec.format?.series?.[index]?.tooltip !== "only");
  const legend = drawn.length > 1 && spec.format?.legend?.show !== "hide";
  return (
    <div>
      {legend ? (
        <ul className={styles.legend} aria-label="Legend">
          {drawn.map(({ series, index }) => (
            <li key={series.field}>
              <span className={`${styles.key} ${spec.kind === "line" ? styles.line : ""}`} style={{ background: seriesSwatch(spec.format, index) }} aria-hidden="true" />
              {series.label}
            </li>
          ))}
        </ul>
      ) : null}
      <div className={`${styles.grid} ${compact ? styles.compact : ""}`}>
        {multiples.facets.map((facet, index) => (
          <figure key={`${facet.name}-${index}`} className={styles.facet}>
            <figcaption className={styles.name} title={facet.name}>{facet.name}</figcaption>
            <Chart spec={specs[index]} rows={facet.rows} height={height} />
          </figure>
        ))}
      </div>
      {multiples.folded > 0 ? (
        <p className={styles.note}>
          {multiples.omitted
            ? `${multiples.folded} more left out: their values can't be added together into "Other".`
            : `"Other" adds up the ${multiples.folded} smaller ones.`}
        </p>
      ) : null}
    </div>
  );
}
