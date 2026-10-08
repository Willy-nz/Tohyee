import type { NextConfig } from "next";

/**
 * The page Content-Security-Policy (issue #144): only Tohyee itself may frame
 * its pages, and no <base> or plugin content. Scripts aren't limited yet: the
 * theme script and Next's own page data are inline, and need a nonce first.
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
  // Security headers on every response (issue #144). Framing is limited to
  // Tohyee's own origin, not forbidden: the bills inbox shows a PDF in an
  // iframe of the same origin (InboxItemPreview). 'self' is an origin, so
  // another install on the shared Tohyee address domain (x.<domain> framing
  // y.<domain>) is still refused. Only frame-ancestors for now; a full
  // Content-Security-Policy needs nonces for the inline theme script.
  //
  // The CSP isn't set on /api/ responses here: Next keeps a header set in this
  // config over the same header from a route, which would drop the sandbox
  // policy that stored files and logos are sent with. Those set their own
  // CSP including frame-ancestors (src/lib/api/upload.ts); X-Frame-Options
  // still covers every API response.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          // #208 item 6: browsers that reached Tohyee over HTTPS (remote access) use HTTPS for that
          // address from then on. Browsers ignore this header on plain HTTP (RFC 6797 section 8.1),
          // so the local network address isn't affected. No includeSubDomains: other names under
          // your own domain aren't Tohyee's to decide.
          { key: "Strict-Transport-Security", value: "max-age=31536000" },
        ],
      },
      {
        source: "/:path((?!api/).*)",
        headers: [{ key: "Content-Security-Policy", value: PAGE_CONTENT_SECURITY_POLICY }],
      },
    ];
  },
  // Folders a running copy writes real data into (backups, analytics' DuckDB
  // copies of the books, data) stay out of the routes' traces even if a
  // dynamic path makes the tracer pull in the project folder (issue #155).
  // Only a safety net: it doesn't cover instrumentation.ts's trace. The real
  // fix is the turbopackIgnore hints on the dynamic paths themselves; the
  // build warns ("Dynamic filesystem access causes tracing of the whole
  // project") when a new one needs one. Keep this list to those folders: a
  // wider one (docs/**, dist/**, ...) also matches inside node_modules and
  // dropped Next's own runtime (next/dist) from the standalone build.
  outputFileTracingExcludes: {
    "/*": ["analytics/**", "backups/**", "data/**"],
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
