import { protectedResourceMetadataRoute } from "@/lib/ai/oauth/http";

/** RFC 9728 protected resource metadata for /api/mcp (the well-known part goes before the path; #427, decision 810). */
export const dynamic = "force-dynamic";
export const GET = protectedResourceMetadataRoute;
