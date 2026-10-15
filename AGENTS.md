<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Tohyee project rules

The rules for coding agents are in `.github/copilot-instructions.md`. Read it,
and the docs it lists, before changing anything. The short version:

- One PostgreSQL database per organisation. Don't change the tenancy model.
- Accounting behaviour needs a worked example in `docs/ACCOUNTING-EXAMPLES.md`
  and a test before it's built. If there's no example, see the Xero rule below.
- When a behaviour question has no answer from Jess, do what Xero does (or
  NetSuite where Xero has nothing), and mark the worked example "as Xero
  does, not yet reviewed" rather than stopping to ask (decision 537). Law,
  irreversible changes and real disagreements between the two still go to
  Jess.
- Money and quantities use `src/lib/money/decimal.ts`, never floats.
- Don't add screens or APIs that only record a status someone types in.
- `npm run lint`, `npm run typecheck`, `npm test` and `npm run build` must all
  pass.
