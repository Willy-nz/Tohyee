# PowerPoint add-in for Analytics

Tohyee's PowerPoint add-in puts a live Analytics report on a slide, like
Power BI's add-in (#429, decisions 830-843). It hasn't been tried in real
PowerPoint yet; see decision 843 for what may need changing.

## What people see

- **On a slide:** a report page (or one tile) that works as it does in
  Analytics: dates and slicers (if the filters pane is on), click to filter,
  drill down, tooltips, page tabs. It works while editing and in the slide
  show.
- **Each viewer signs in as themselves** and sees only what they can see in
  Tohyee. A report viewer sees only reports shared with them.
- **Not signed in:** the picture saved the last time someone signed in
  looked at the slide, with "Sign in to see live data". It can be turned
  off per slide; anyone with the file can see it.
- **While editing:** Refresh, Show/Hide filters, Open in Tohyee, Change, Sign
  out. In the slide show only a small Refresh in the corner.

## Installing it

Remote access must be on with an https address. An admin opens
**Settings › PowerPoint add-in** and downloads the manifest
(`tohyee-powerpoint-addin.xml`), then either:

- **Just you:** in PowerPoint, Home › Add-ins (or Insert › Add-ins) › My
  Add-ins › Upload My Add-in, and pick the file.
- **Everyone:** a Microsoft 365 admin goes to the Microsoft 365 admin center ›
  Settings › Integrated apps › Upload custom apps › Office Add-in, and
  uploads the file (or gives its address,
  `<remote>/office/powerpoint/manifest.xml`).

Then in PowerPoint: Add-ins › Tohyee Analytics, sign in, choose an
organisation, a report and a page or tile.

## How it fits together

| Piece | Where |
| --- | --- |
| Manifest (XML, content add-in) | `src/lib/office/addin.ts`, served at `/office/powerpoint/manifest.xml` |
| Slide page (the only page Office may frame) | `src/app/office/powerpoint/page.tsx`, `src/components/office/powerpoint-addin.tsx`, CSP in `src/lib/office/csp.ts` |
| Sign-in | #427's OAuth as a built-in app: `/oauth/authorize` in Office's dialog, back to `/office/powerpoint/signed-in`; `src/lib/office/client/auth.ts` |
| Tokens | kind `office` in `ai_access_tokens`, audience `<remote>/api/office` (never MCP's) |
| Read-only API | `/api/office/*`, `src/lib/office/api.ts`, sharing `src/lib/analytics/read-routes.ts` with Analytics |
| What's kept in the presentation | `src/lib/office/settings.ts` (the choice and the saved picture; never tokens) |
| Saved picture | `src/lib/office/client/snapshot.ts` |
| Sign-ins list | Your account › Connected apps (`/api/auth/connected-apps`) |

Tests: `tests/unit/office-addin.test.ts`, `tests/unit/security-headers.test.ts`,
`tests/integration/office-addin.test.ts`.
