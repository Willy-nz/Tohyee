/*
 * Who may frame Tohyee's pages (issue #144, #429). Everything stays
 * frame-ancestors 'self' (and X-Frame-Options SAMEORIGIN), except the
 * PowerPoint add-in's slide page, /office/powerpoint: Office shows a content
 * add-in in a frame, and in PowerPoint on the web that frame sits inside
 * Microsoft's pages (decision 839). Sign-in, consent and every other page
 * still can't be framed, so they can't be overlaid by another site. Used
 * by next.config.ts, so it imports nothing.
 */

/** The page Office frames: exactly this path, nothing under it. */
export const OFFICE_FRAMED_PATH = "/office/powerpoint";

/**
 * The sites PowerPoint on the web runs under, as frame-ancestors sources.
 * frame-ancestors checks every frame up to the top, so both the Office
 * frame (*.officeapps.live.com) and the page around it (Microsoft 365,
 * office.com, SharePoint and OneDrive, Teams) are listed. PowerPoint on
 * Windows and Mac shows the add-in in a webview with no parent page, so
 * nothing is needed for them. Microsoft doesn't publish one list; this one
 * is from the hosts Office on the web is served from (decision 839), and a
 * host missing from it shows as a refused frame rather than a weakness.
 */
export const OFFICE_FRAME_ANCESTORS = [
  "'self'",
  "https://*.officeapps.live.com",
  "https://*.office.com",
  "https://office.com",
  "https://*.office365.com",
  "https://*.microsoft365.com",
  "https://*.cloud.microsoft",
  "https://*.sharepoint.com",
  "https://onedrive.live.com",
  "https://*.onedrive.live.com",
  "https://teams.microsoft.com",
  "https://*.teams.microsoft.com",
] as const;

/** The page policy everywhere (decision 568): only Tohyee frames its pages; forms and images only go to Tohyee (and LINZ's aerial tiles). */
export const PAGE_CONTENT_SECURITY_POLICY =
  "frame-ancestors 'self'; base-uri 'self'; object-src 'none'; form-action 'self'; img-src 'self' data: blob: https://basemaps.linz.govt.nz";

/** The same policy for the add-in's slide page, but framed by Office (and its images include the saved picture, a data: address). */
export const OFFICE_CONTENT_SECURITY_POLICY = `frame-ancestors ${OFFICE_FRAME_ANCESTORS.join(" ")}; base-uri 'self'; object-src 'none'; form-action 'self'; img-src 'self' data: blob:`;

type HeaderRule = { source: string; headers: Array<{ key: string; value: string }> };

/** The security headers for next.config.ts `headers()`. */
export function securityHeaderRules(): HeaderRule[] {
  const framed = OFFICE_FRAMED_PATH.slice(1);
  return [
    {
      source: "/:path*",
      headers: [
        { key: "Referrer-Policy", value: "same-origin" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        // #208 item 6: browsers that reached Tohyee over HTTPS (remote access) use HTTPS for that
        // address from then on. Browsers ignore this header on plain HTTP (RFC 6797 section 8.1),
        // so the local network address isn't affected. No includeSubDomains: other names under
        // your own domain aren't Tohyee's to decide.
        { key: "Strict-Transport-Security", value: "max-age=31536000" },
      ],
    },
    // Every response but the add-in's slide page: only Tohyee may frame it.
    { source: `/:path((?!${framed}$).*)`, headers: [{ key: "X-Frame-Options", value: "SAMEORIGIN" }] },
    { source: `/:path((?!api/|${framed}$).*)`, headers: [{ key: "Content-Security-Policy", value: PAGE_CONTENT_SECURITY_POLICY }] },
    { source: OFFICE_FRAMED_PATH, headers: [{ key: "Content-Security-Policy", value: OFFICE_CONTENT_SECURITY_POLICY }] },
  ];
}
