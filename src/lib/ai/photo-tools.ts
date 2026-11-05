import { type AiAccessLevel, effectiveAccessLevel, levelAllows, roleCeiling } from "@/lib/ai/access-levels";
import { boundedLimit, CURSOR, limitInput, pageByOffset } from "@/lib/ai/limits";
import { type AiTool, schema, ToolFileAnswer } from "@/lib/ai/tools";
import { listAiTokens } from "@/lib/ai/tokens";
import { IDEMPOTENCY, idempotencyKey } from "@/lib/ai/write-tools";
import type { AuthContext } from "@/lib/auth/guard";
import { roleAtLeast } from "@/lib/auth/roles";
import { ESTIMATE_LABEL, MAX_AI_PHOTO_BYTES, photoForAi, photosAwaitingEstimate, proposeCoverEstimate } from "@/lib/farming/pasture-photos";
import { MAX_COVER } from "@/lib/farming/pasture-rules";
import { bcsPhotoContent, photosToScore, referencePhotos, scaleInfo, suggestBcs } from "@/lib/farming/bcs";
import { AI_ESTIMATE_LABEL } from "@/lib/farming/bcs-rules";
import { NotFoundError, ValidationError } from "@/lib/errors";
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
      limit: limitInput(20, 100),
      cursor: CURSOR,
    }),
    async run(tx, args) {
      const page = await pageByOffset(args.cursor, boundedLimit(args.limit, 20, 100), (offset, limit) => photosAwaitingEstimate(tx, { farmId: args.farmId, limit, offset }));
      return { photos: page.rows, more: page.more, nextCursor: page.nextCursor };
    },
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
  {
    name: "list_bcs_photos_to_score",
    title: "Animal photos to condition score",
    level: "read",
    description:
      "Photos of animals or mobs people took for body condition scoring that nobody has scored yet and that have no suggestion, newest first: the farm, the animal's tag or the mob, the kind of stock and the day taken. Look at them with get_bcs_photos_to_score, which also gives the farm's scale and its own reference photos, then suggest a score with suggest_bcs.",
    inputSchema: schema({ farmId: { type: "string", description: "One farm only, from list_farms_and_paddocks." }, animalId: { type: "string" }, mobId: { type: "string" }, limit: limitInput(20, 100), cursor: CURSOR }),
    async run(tx, args) {
      const page = await pageByOffset(args.cursor, boundedLimit(args.limit, 20, 100), (offset, limit) => photosToScore(tx, { farmId: args.farmId, animalId: args.animalId, mobId: args.mobId, limit, offset }));
      return { photos: page.rows, more: page.more, nextCursor: page.nextCursor };
    },
  },
  {
    name: "get_bcs_photos_to_score",
    title: "Look at photos to condition score",
    level: "read",
    description: `Up to 3 photos to score (from list_bcs_photos_to_score) for one animal or mob, as images, then the farm's own reference photos for that kind of stock (photos a person scored by eye; up to 2 for each score, newest first), with the farm's scale and what each score looks like. The answer lists every image in order with its photo id and, for references, its score. Photos over ${(MAX_AI_PHOTO_BYTES / 1_000_000).toFixed(1)} MB aren't sent. Tell suggest_bcs which references you compared against.`,
    inputSchema: schema({ photoIds: { type: "array", items: { type: "string" }, maxItems: 3, description: "1 to 3 photos of the same animal or mob." }, referencesPerScore: { type: "integer", minimum: 0, maximum: 3, description: "Reference photos for each score (default 2)." } }, ["photoIds"]),
    async run(tx, args) {
      const ids = Array.isArray(args.photoIds) ? [...new Set(args.photoIds.map(String))].slice(0, 3) : [];
      if (!ids.length) throw new ValidationError("photoIds: give 1 to 3 photo ids from list_bcs_photos_to_score.");
      const all = await photosToScore(tx, { limit: 5000 });
      const chosen = ids.map((id) => all.find((photo) => photo.photoId === id));
      if (chosen.some((photo) => !photo)) throw new NotFoundError("One of those photos wasn't found, or is scored already. list_bcs_photos_to_score lists them.");
      const first = chosen[0]!;
      if (chosen.some((photo) => photo!.animalId !== first.animalId || photo!.mobId !== first.mobId)) throw new ValidationError("Give photos of one animal or one mob at a time.");
      const scale = await scaleInfo(tx, first.farmId, first.kind);
      const perScore = typeof args.referencesPerScore === "number" ? Math.max(0, Math.min(3, Math.trunc(args.referencesPerScore))) : 2;
      const refs = perScore ? await referencePhotos(tx, { kind: first.kind, scale: scale.scale, perScore, farmId: first.farmId }) : [];
      const images: Array<{ uri: string; fileName: string; contentType: string; content: Buffer }> = [];
      const order: Array<Record<string, unknown>> = [];
      const skipped: string[] = [];
      let total = 0;
      for (const [index, photo] of [...chosen.map((entry) => ({ id: entry!.photoId, ref: null as null | (typeof refs)[number] })), ...refs.map((ref) => ({ id: ref.photoId, ref }))].entries()) {
        const file = await bcsPhotoContent(tx, photo.id);
        if (file.sizeBytes > MAX_AI_PHOTO_BYTES || total + file.sizeBytes > 16_000_000) {
          skipped.push(photo.id);
          continue;
        }
        total += file.sizeBytes;
        images.push({ uri: `tohyee://bcs-photos/${photo.id}/${encodeURIComponent(file.fileName)}`, fileName: file.fileName, contentType: file.contentType, content: file.content });
        order.push(photo.ref ? { image: images.length, photoId: photo.id, reference: true, score: photo.ref.score, takenOn: photo.ref.takenOn } : { image: images.length, photoId: photo.id, toScore: true, takenOn: chosen[index]!.takenOn });
      }
      if (!images.length) throw new ValidationError("Those photos are too big to send. A person can score them in Tohyee.");
      const answer = {
        subject: first.animalId ? { animalId: first.animalId, tag: first.animalTag } : { mobId: first.mobId, mob: first.mobName },
        scale,
        images: order,
        referencesNote: refs.length ? "References are the farm's own stock, scored by eye by a person." : "This farm has no reference photos for this kind yet. Say so in your reasoning.",
        notSent: skipped,
        label: AI_ESTIMATE_LABEL,
      };
      return new ToolFileAnswer(answer, images[0], images.slice(1));
    },
  },
];

export const PHOTO_WRITE_TOOLS: readonly AiTool[] = [
  {
    name: "suggest_bcs",
    title: "Suggest a body condition score",
    level: "draft",
    description: `Suggests the body condition score you see in a photo, on the farm's scale in half points, optionally an estimated liveweight in kg, your reason (what you looked at: spine, ribs, hips, tail head; the angle and light), and the reference photo ids you compared against. It's saved as "${AI_ESTIMATE_LABEL}" and counts for nothing until a person accepts or changes it in Tohyee. One suggestion per photo. Liveweight from a photo is rough: say how sure you are.`,
    inputSchema: schema(
      {
        photoId: { type: "string", description: "From list_bcs_photos_to_score." },
        animalId: { type: "string", description: "The animal in the photo (a check), if it's an animal's photo." },
        mobId: { type: "string", description: "The mob in the photo (a check), if it's a mob's photo." },
        score: { type: "number", minimum: 1, maximum: 10, description: "On the farm's scale (get_bcs_photos_to_score), in half points." },
        estimatedKg: { type: "number", minimum: 1, maximum: 2000, description: "Optional liveweight estimate in kg." },
        reasoning: { type: "string", maxLength: 500, description: "A sentence or two, for the person checking." },
        referencePhotoIds: { type: "array", items: { type: "string" }, maxItems: 50, description: "The reference photos you compared against." },
        idempotencyKey: IDEMPOTENCY,
      },
      ["photoId", "score", "reasoning"],
    ),
    async run(tx, args) {
      const result = await suggestBcs(tx, { ...args, idempotencyKey: idempotencyKey(args.idempotencyKey) });
      return { ...result, note: "Saved as a suggestion, not a score. A person accepts, changes or declines it on the animal or mob in Tohyee." };
    },
  },
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
