/*
 * What the PowerPoint add-in keeps in the presentation (#429, decision
 * 840), in its own settings (Office.context.document.settings), which travel
 * with the file: which report it shows and how, and the saved picture for
 * people who can't sign in. Never a token, a password or any figures other
 * than that picture. Browser-safe and pure, so it's unit tested.
 */

/** The settings' names in the presentation. */
export const SLIDE_SETTING = "tohyee";
export const SNAPSHOT_SETTING = "tohyeeSnapshot";

/** What one add-in on one slide shows. */
export type SlideChoice = {
  v: 1;
  /** The Tohyee server the report is on (its remote access address). */
  server: string;
  organisationId: string;
  /** Names, so the slide can say what it shows before anyone signs in. */
  organisationName: string;
  dashboardId: string;
  reportName: string;
  /** The page it opens on; null: the report's first page. */
  pageId: string | null;
  /** Just one tile of the page; null: the whole page. */
  tileId: string | null;
  tileTitle: string | null;
  /** Power BI's "show the filters pane": the report's dates and slicers above it. */
  showFilters: boolean;
  /** Keep a picture of the report in the presentation for people who can't sign in (Power BI's snapshot). */
  keepSnapshot: boolean;
};

/** The picture shown to someone who isn't signed in: what the last signed-in viewer saw, and when. */
export type SlideSnapshot = {
  /** A data: address (an SVG picture of the report as it was drawn). */
  image: string;
  takenAt: string;
};

/** Office keeps up to about 2 MB of settings per add-in; the picture stays well under that (decision 840). */
export const MAX_SNAPSHOT_CHARACTERS = 1_200_000;

const ID = /^[A-Za-z0-9_-]{1,64}$/;

function text(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}

/** A slide's saved choice, or null when there isn't one or it isn't one this add-in wrote. */
export function parseSlideChoice(raw: unknown): SlideChoice | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (value.v !== 1) return null;
  const server = text(value.server, 300);
  if (!server || !/^https:\/\/[^/?#]+$/.test(server)) return null;
  const organisationId = text(value.organisationId, 64);
  const dashboardId = text(value.dashboardId, 18);
  if (!organisationId || !ID.test(organisationId) || !dashboardId || !/^\d+$/.test(dashboardId)) return null;
  const pageId = value.pageId === null || value.pageId === undefined ? null : text(value.pageId, 64);
  const tileId = value.tileId === null || value.tileId === undefined ? null : text(value.tileId, 64);
  if ((pageId !== null && !ID.test(pageId)) || (tileId !== null && !ID.test(tileId))) return null;
  return {
    v: 1,
    server,
    organisationId,
    organisationName: text(value.organisationName, 150) ?? organisationId,
    dashboardId,
    reportName: text(value.reportName, 100) ?? "Report",
    pageId,
    tileId,
    tileTitle: tileId ? (text(value.tileTitle, 150) ?? null) : null,
    showFilters: value.showFilters === true,
    keepSnapshot: value.keepSnapshot !== false,
  };
}

/** A saved picture, or null when there isn't a usable one (only our own SVG or PNG data addresses). */
export function parseSlideSnapshot(raw: unknown): SlideSnapshot | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const image = typeof value.image === "string" ? value.image : "";
  if (image.length > MAX_SNAPSHOT_CHARACTERS || !/^data:image\/(svg\+xml|png);base64,[A-Za-z0-9+/=]+$/.test(image)) return null;
  const takenAt = typeof value.takenAt === "string" && !Number.isNaN(Date.parse(value.takenAt)) ? value.takenAt : null;
  if (!takenAt) return null;
  return { image, takenAt };
}

/** Where "Open in Tohyee" goes: the report (and page) on its server. */
export function reportAddress(choice: Pick<SlideChoice, "server" | "dashboardId" | "pageId">): string {
  const url = new URL(`/analytics/dashboards/${encodeURIComponent(choice.dashboardId)}`, choice.server);
  if (choice.pageId) url.searchParams.set("page", choice.pageId);
  return url.toString();
}
