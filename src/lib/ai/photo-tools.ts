import { type AiAccessLevel, effectiveAccessLevel, levelAllows, roleCeiling } from "@/lib/ai/access-levels";
import { type AiTool, schema, ToolFileAnswer } from "@/lib/ai/tools";
import { listAiTokens } from "@/lib/ai/tokens";
import { IDEMPOTENCY, idempotencyKey } from "@/lib/ai/write-tools";
import type { AuthContext } from "@/lib/auth/guard";
import { roleAtLeast } from "@/lib/auth/roles";
import { ESTIMATE_LABEL, MAX_AI_PHOTO_BYTES, photoForAi, photosAwaitingEstimate, proposeCoverEstimate } from "@/lib/farming/pasture-photos";
import { MAX_COVER } from "@/lib/farming/pasture-rules";
import type { Membership } from "@/lib/organisations/registry";

/*
 * Cover estimates from paddock photos by the person's own AI (#503,
 * decisions 1163-1164). Tohyee calls no AI: the person's AI key or
 * connected app (#427) asks for the photos, looks at one, and proposes a
 * cover. Looking needs only "Look only", like the readings; proposing is a
 * draft for a person to accept, so it needs "Make drafts", as proposed IRD
 * figures (decision 549) and suggested livestock movements do. Farms are the
 * ones the key's person can see (decision 744).
 */

export const PHOTO_READ_TOOLS: readonly AiTool[] = [
  {
    name: "list_pasture_photos_awaiting_estimate",
    title: "Paddock photos to estimate",
    level: "read",
    description:
      "Paddock photos people took (on a farm walk, with a cover reading, or on their own) that have no cover estimate yet, newest first: the farm, paddock, its effective area, the day taken (from the phone's clock), and the photo's size. Where the phone was, and any reading, are left out so your estimate is your own. Look at one with get_pasture_photo, then propose a cover with propose_pasture_cover_estimate.",
    inputSchema: schema({
      farmId: { type: "string", description: "One farm only, from list_farms_and_paddocks." },
      limit: { type: "integer", minimum: 1, maximum: 100, description: "At most this many (default 20)." },
    }),
    run: async (tx, args) => ({ photos: await photosAwaitingEstimate(tx, { farmId: args.farmId, limit: args.limit }) }),
  },
  {
    name: "get_pasture_photo",
    title: "Look at a paddock photo",
    level: "read",
    description: `One paddock photo, as an image, with its paddock and the day it was taken. Photos over ${(MAX_AI_PHOTO_BYTES / 1_000_000).toFixed(1)} MB aren't sent.`,
    inputSchema: schema({ photoId: { type: "string", description: "From list_pasture_photos_awaiting_estimate." } }, ["photoId"]),
    async run(tx, args) {
      const found = await photoForAi(tx, args.photoId);
      return new ToolFileAnswer({ photo: found.photo }, { uri: `tohyee://pasture-photos/${found.photo.photoId}/${encodeURIComponent(found.fileName)}`, fileName: found.fileName, contentType: found.contentType, content: found.content });
    },
  },
];

export const PHOTO_WRITE_TOOLS: readonly AiTool[] = [
  {
    name: "propose_pasture_cover_estimate",
    title: "Propose a cover from a photo",
    level: "draft",
    description: `Proposes the pasture cover you estimate from a paddock photo, in kg DM/ha (total dry matter above ground, as a plate meter reads it), with how sure you are and a short reason (sward height and density, clover, dead matter, what's in view). It's saved as "${ESTIMATE_LABEL}" and isn't a reading until a person accepts or changes it in Tohyee. One estimate per photo.`,
    inputSchema: schema(
      {
        photoId: { type: "string", description: "From list_pasture_photos_awaiting_estimate." },
        cover: { type: "integer", minimum: 0, maximum: MAX_COVER, description: "kg DM/ha." },
        confidence: { type: "string", enum: ["low", "medium", "high"], description: "How sure you are." },
        reasoning: { type: "string", maxLength: 500, description: "A sentence or two, for the person checking." },
        idempotencyKey: IDEMPOTENCY,
      },
      ["photoId", "cover", "confidence", "reasoning"],
    ),
    async run(tx, args) {
      const result = await proposeCoverEstimate(tx, { idempotencyKey: idempotencyKey(args.idempotencyKey), photoId: args.photoId, cover: args.cover, confidence: args.confidence, reasoning: args.reasoning });
      return { ...result, note: "Saved as a proposal, not a reading. A person accepts, changes or declines it on Pasture and feed in Tohyee." };
    },
  },
];

export type AiConnection = {
  /** The person has a working AI key or connected AI app in this organisation. */
  connected: boolean;
  /** One of them can propose estimates ("Make drafts" or more, with their role now). */
  canPropose: boolean;
  /** Their role lets them connect an AI at all (viewer or higher), and make drafts with it (bookkeeper or higher). */
  roleCanConnect: boolean;
  roleCanPropose: boolean;
};

/** Whether the signed-in person's own AI can propose estimates here, for the screen (decision 1167). */
export async function aiConnectionFor(auth: AuthContext, membership: Membership): Promise<AiConnection> {
  const roleCanConnect = roleAtLeast(membership.role, "viewer");
  const roleCanPropose = levelAllows(roleCeiling(membership.role), "draft");
  if (!roleCanConnect) return { connected: false, canPropose: false, roleCanConnect, roleCanPropose: false };
  const working = (await listAiTokens(auth, membership.organisation.id)).filter((token) => !token.revokedAt && !token.expired);
  const levels: AiAccessLevel[] = working.map((token) => effectiveAccessLevel(token.accessLevel, membership.role));
  return { connected: working.length > 0, canPropose: levels.some((level) => levelAllows(level, "draft")), roleCanConnect, roleCanPropose };
}
