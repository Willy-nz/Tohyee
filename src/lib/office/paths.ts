/*
 * Where the PowerPoint add-in's pages and API are (#429), and which of
 * Analytics' reads the add-in may make through the Analytics API for Office
 * (decision 838). Browser-safe: no Node imports.
 */

/** The page PowerPoint shows on the slide (the content add-in): a live report, or the setup. */
export const OFFICE_CONTENT_PATH = "/office/powerpoint";
/** Where the sign-in dialog lands after Tohyee's sign-in, and hands the code back to the slide. */
export const OFFICE_SIGNED_IN_PATH = "/office/powerpoint/signed-in";
/** The add-in's OAuth client ID metadata document (its client_id). */
export const OFFICE_CLIENT_PATH = "/office/powerpoint/client.json";
/** The manifest an admin downloads (or gives Microsoft 365 the address of). */
export const OFFICE_MANIFEST_PATH = "/office/powerpoint/manifest.xml";
/** The read-only Analytics API the add-in's tokens are for (their audience, RFC 8707). */
export const OFFICE_API_PATH = "/api/office";
/** The add-in's name, as PowerPoint, the consent screen and the connections list show it. */
export const OFFICE_APP_NAME = "Tohyee for PowerPoint";


/**
 * The Analytics API for Office address for one of the reads a report makes
 * in Tohyee (src/lib/client/api.ts), or null when the add-in mustn't make
 * it: only showing a report (the report, its tiles' answers, its slicers'
 * values, its freshness and its images), never a change, a typed question
 * or anything outside Analytics.
 */
export function officeApiPath(path: string, method: string): string | null {
  const url = new URL(path, "https://tohyee.invalid");
  if (url.origin !== "https://tohyee.invalid") return null;
  const pathname = url.pathname;
  const verb = method.toUpperCase();
  if (verb === "POST") return pathname === "/api/analytics/query" ? `${OFFICE_API_PATH}/query` : null;
  if (verb !== "GET") return null;
  if (pathname === "/api/analytics/values") return `${OFFICE_API_PATH}/values`;
  const report = /^\/api\/analytics\/dashboards\/(\d{1,18})(\/freshness|\/images\/([A-Za-z0-9_-]{1,64}))?$/.exec(pathname);
  if (!report) return null;
  return `${OFFICE_API_PATH}/reports/${report[1]}${report[2] ?? ""}`;
}
