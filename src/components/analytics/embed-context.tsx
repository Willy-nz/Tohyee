"use client";

import { createContext, useContext } from "react";

/**
 * A report shown somewhere other than Tohyee's own pages: on a PowerPoint
 * slide (#429, decision 838). The report is read-only there (no editing,
 * sharing, pinning or exports), opens on the chosen page or shows just one
 * tile, and shows its dates and slicers only when asked to. Its reads go
 * through the add-in's own API (src/lib/client/api.ts setApiTransport).
 */
export type AnalyticsEmbed = {
  pageId: string | null;
  tileId: string | null;
  showFilters: boolean;
  /** A report image as an address the page can show (the add-in fetches it with its token). */
  imageSource(path: string): Promise<string>;
};

export const AnalyticsEmbedContext = createContext<AnalyticsEmbed | null>(null);

export function useAnalyticsEmbed(): AnalyticsEmbed | null {
  return useContext(AnalyticsEmbedContext);
}
