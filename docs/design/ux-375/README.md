# Workspace and alignment changes — issue #375

Implements Will's 20 October screenshot feedback. This supersedes the earlier
four-column Accountant menu and decorative Home header direction.

## Changed

- Accounting and Tax open focused, permission/module-filtered tool directories.
  Settings opens the existing settings directory. All former destinations remain
  available in the directories and command search. CRM's already simplified
  navigation is retained.
- Home uses a compact sans-serif header, bounded summary cards and attention
  actions before the profit chart. Missing GST data stays distinct from zero.
- Income tax has separate overview, forecast, calculation, payments/IRD figures,
  returns and settings routes. Links preserve the income year; organisation
  selection continues to use the existing tab-scoped workspace context.
- Existing tax calculations, payment allocation, documents and preparation
  components are reused. There is no new filing, payment or scenario engine.
  The forecast page explains the existing actuals/budget basis and links to the
  budget editor. Empty forecast inputs are flagged; entered zero values remain
  valid. Warnings remain visible with expandable detail.
- Inline forms and labelled toolbars align controls independently of helper
  text. Calendar filters use consistent control heights. Mailbox setup is opened
  explicitly; disconnected users see a compact prompt. OAuth instructions move
  to administrator email settings. Private-mail access rules are unchanged.

## Validation and review

Focused render/navigation tests cover incomplete and genuine-zero tax states,
forecast separation, unsupported taxpayer setup, year links, GST presentation
and role/module filtering. No financial formulas or database schemas changed.

Before merging, run the full suite in CI and visually review the actual app at
1440px, 1024px and 390px, and at 200% zoom. In particular check inline forms with
long/wrapped labels, helper text, validation errors and multi-select controls.
Verify keyboard navigation and browser back between tax pages, with a populated
organisation and each relevant role. Test desktop and narrow-screen calendar
filters and connect/cancel/folder-selection flows. Capture before/after screenshots
for #375.

Local Chromium installation failed because its downloaded archive was invalid,
so no browser visual verification or new screenshots are claimed. Automatic
approval review blocked the full test run when an existing public-fetch test
attempted to contact mixed.example.nz; networking code was not changed. Database
integration validation also requires the project's PostgreSQL test environment.
