import type { NextConfig } from "next";

/**
 * The page Content-Security-Policy (issue #144). Scripts aren't limited yet:
 * the theme script and Next's own page data are inline, and need a nonce
 * first.
 */
const PAGE_CONTENT_SECURITY_POLICY = "frame-ancestors 'self'; base-uri 'self'; object-src 'none'";

const nextConfig: NextConfig = {
  output: "standalone",
  // DuckDB (analytics, decision 354) is a native module: loaded by Node, not bundled.
  serverExternalPackages: ["@duckdb/node-api", "@duckdb/node-bindings"],
  // The fonts the server writes PDFs with (src/lib/pdf/writer.ts reads them
  // from the app's folder), so the standalone build and installers have them.
  outputFileTracingIncludes: {
    "/api/**": ["src/lib/pdf/fonts/*.ttf", "src/lib/pdf/fonts/OFL.txt"],
    // DuckDB's native library sits beside its .node file and is loaded by it
    // (libduckdb.so, duckdb.dll), so tracing doesn't see it (decision 354).
    "/api/analytics/**": ["node_modules/@duckdb/node-api/**", "node_modules/@duckdb/node-bindings/**", "node_modules/@duckdb/node-bindings-*/**"],
  },
  // Only what the server runs goes in the standalone build (issue #155).
  // Folders chosen at run time (backups, analytics, report emails) make the
  // tracer take in the whole project; the source, tests, docs and any data a
  // development server wrote into the working copy (DuckDB copies of real
  // books, backups) must never be published in a release. Applied after the
  // includes above, so the PDF fonts stay.
  outputFileTracingExcludes: {
    "**": [
      "analytics/**",
      "assets/**",
      "backups/**",
      "coverage/**",
      "data/**",
      "deploy/**",
      "dist/**",
      "docs/**",
      "installer/**",
      "relay/**",
      "scripts/**",
      "tests/**",
      "website/**",
      "src/**/*.{ts,tsx,css,md}",
    ],
  },
  // Security headers on every response (issue #144). Only Tohyee's own pages
  // may frame Tohyee (the bills inbox shows a stored file in a frame), so
  // another install on the same shared Tohyee address domain can't frame it
  // and trick someone into clicking Void or Approve. The page policy is set
  // on pages only: API routes that send files set their own stricter one
  // (src/lib/api/upload.ts), and X-Frame-Options covers them.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
        ],
      },
      {
        source: "/((?!api/).*)",
        headers: [{ key: "Content-Security-Policy", value: PAGE_CONTENT_SECURITY_POLICY }],
      },
    ];
  },
  // The CRM moved from /operations/crm to its own app at /crm; old links and
  // bookmarks still reach the same pages (with their ?query). /operations/crm
  // itself listed the companies.
  async redirects() {
    return [
      { source: "/operations/crm", destination: "/crm/companies", permanent: false },
      { source: "/operations/crm/:path+", destination: "/crm/:path+", permanent: false },
    ];
  },
};

export default nextConfig;
