import { officeResourceMetadataRoute } from "@/lib/ai/oauth/http";

/** RFC 9728 protected resource metadata for /api/office, the PowerPoint add-in's read-only Analytics API (#429, decision 833). */
export const dynamic = "force-dynamic";
export const GET = officeResourceMetadataRoute;
