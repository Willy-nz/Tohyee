import { MAP_IDS } from "@/lib/analytics/maps";

let loading: Promise<void> | null = null;

/**
 * Registers the New Zealand boundaries with ECharts (decision 687), once,
 * the first time a map is drawn. The files ship with Tohyee, so nothing is
 * fetched from outside it.
 */
export function loadNzMaps(): Promise<void> {
  loading ??= Promise.all([import("echarts"), import("@/lib/analytics/maps/nz-regions.json"), import("@/lib/analytics/maps/nz-districts.json")]).then(
    ([echarts, regions, districts]) => {
      echarts.registerMap(MAP_IDS.regions, regions.default as unknown as Parameters<typeof echarts.registerMap>[1]);
      echarts.registerMap(MAP_IDS.districts, districts.default as unknown as Parameters<typeof echarts.registerMap>[1]);
    },
    (error: unknown) => {
      loading = null;
      throw error;
    },
  );
  return loading;
}

export const isMapKind = (kind: string) => kind === "filledmap" || kind === "pointmap";
