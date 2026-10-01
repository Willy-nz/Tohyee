import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // The fonts the server writes PDFs with (src/lib/pdf/writer.ts reads them
  // from the app's folder), so the standalone build and installers have them.
  outputFileTracingIncludes: {
    "/api/**": ["src/lib/pdf/fonts/*.ttf", "src/lib/pdf/fonts/OFL.txt"],
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
