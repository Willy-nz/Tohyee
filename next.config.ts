import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // The fonts the server writes PDFs with (src/lib/pdf/writer.ts reads them
  // from the app's folder), so the standalone build and installers have them.
  outputFileTracingIncludes: {
    "/api/**": ["src/lib/pdf/fonts/*.ttf", "src/lib/pdf/fonts/OFL.txt"],
  },
};

export default nextConfig;
