import { authorizationServerMetadataRoute } from "@/lib/ai/oauth/http";

/** RFC 8414 authorisation server metadata for AI apps signing in (#427, decision 810). */
export const dynamic = "force-dynamic";
export const GET = authorizationServerMetadataRoute;
