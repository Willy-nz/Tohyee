import { protectedResourceMetadataRoute } from "@/lib/ai/oauth/http";

/** RFC 9728 protected resource metadata, at the root for clients that look there first (#427, decision 810). */
export const dynamic = "force-dynamic";
export const GET = protectedResourceMetadataRoute;
