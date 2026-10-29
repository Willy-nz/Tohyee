import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as tokensRoute from "@/app/api/ai/tokens/route";
import * as mcpRoute from "@/app/api/mcp/route";
import * as calibrationRoute from "@/app/api/farming/farms/[farmId]/pasture/calibration/route";
import * as estimatesRoute from "@/app/api/farming/farms/[farmId]/pasture/estimates/route";
import * as readingsRoute from "@/app/api/farming/farms/[farmId]/pasture/readings/route";
import * as diaryRoute from "@/app/api/farming/paddocks/[paddockId]/photos/route";
import * as decideRoute from "@/app/api/farming/pasture-estimates/[estimateId]/route";
import * as photoRoute from "@/app/api/farming/pasture-photos/[photoId]/route";
import * as photosRoute from "@/app/api/farming/pasture-photos/route";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { isoDateAt } from "@/lib/dates";
import { coreQuery } from "@/lib/db/transactions";
import { setMemberFarmAccess } from "@/lib/farming/access";
import { addPaddock, saveFarm, setFarmingEnabled } from "@/lib/farming/paddocks";
import { addReading } from "@/lib/farming/pasture";
import { uploadPasturePhoto } from "@/lib/farming/pasture-photos";
import { openQueue, type QueueItem, type Sender, sendOutcome } from "@/lib/offline/queue";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, params, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "pasture-photos";
const noContext = undefined as unknown;
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 2, 0xff, 0xd9]);
const jpeg = (marker: number) => Buffer.concat([JPEG.subarray(0, 6), Buffer.from([marker]), JPEG.subarray(6)]);
type Json = Record<string, unknown>;
type Handler = (request: Request, context: never) => Promise<Response>;
/** Days before today in New Zealand; a phone time at midday there on that day (00:00 UTC). */
const day = (back: number) => isoDateAt(new Date(Date.now() - back * 86_400_000));
const D2 = day(2);
const D0 = day(0);

let rpcId = 0;
/** One MCP tool call; the whole result, so an image can be checked. */
async function mcp(token: string, name: string, args: Json = {}): Promise<{ content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean }> {
  rpcId += 1;
  const response = await mcpRoute.POST(
    new Request("http://tohyee.test/api/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: rpcId, method: "tools/call", params: { name, arguments: args } }) }),
    noContext,
  );
  const body = (await response.json()) as Json;
  if (body.error) throw new Error(`rpc ${(body.error as Json).code}: ${(body.error as Json).message}`);
  return body.result as never;
}
async function call(token: string, name: string, args: Json = {}): Promise<Json> {
  const result = await mcp(token, name, args);
  if (result.isError) throw new Error(result.content[0].text);
  return JSON.parse(result.content[0].text!) as Json;
}
async function toolNames(token: string): Promise<string[]> {
  rpcId += 1;
  const response = await mcpRoute.POST(new Request("http://tohyee.test/api/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: rpcId, method: "tools/list" }) }), noContext);
  return (((await response.json()) as { result: { tools: Array<{ name: string }> } }).result.tools).map((tool) => tool.name);
}

/**
 * Paddock photos and AI cover estimates (#503, decisions 1160-1169): photos
 * through the phone's queue, kept once however often they're sent; the
 * person's own AI looks at them and proposes covers within its key's level
 * and farms; nothing is a reading until a person decides; and estimates are
 * compared with readings, never adjusted. Made-up data only.
 */
describeWithDatabase("paddock photos and AI cover estimates", () => {
  let server: TestServer;
  const users = {} as Record<"owner" | "worker" | "viewer" | "bookkeeper", SessionUser>;
  const cookies = {} as Record<string, string>;
  const tokens = {} as Record<string, string>;
  const w = {} as Record<string, string>;
  const as = (user: SessionUser) => <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: user.id, email: user.email }, work);
  const count = async (sql: string, values: unknown[] = []) => Number((await as(users.owner)((tx) => tx.query<{ n: string }>(sql, values))).rows[0].n);

  async function makeKey(user: SessionUser, accessLevel: string): Promise<string> {
    const response = await tokensRoute.POST(apiRequest("/api/ai/tokens", { method: "POST", cookie: cookies[user.email], body: { organisationId: ORG, name: `${accessLevel} key`, accessLevel } }), noContext);
    return ((await response.json()) as { token: string }).token;
  }

  beforeAll(async () => {
    server = await startTestServer();
    users.owner = await createTestUser("photos-owner@example.com", { serverAdmin: true, displayName: "Jess" });
    users.worker = await createTestUser("photos-worker@example.com", { displayName: "Hemi" });
    users.viewer = await createTestUser("photos-viewer@example.com", { displayName: "Aroha" });
    users.bookkeeper = await createTestUser("photos-bookkeeper@example.com", { displayName: "Sam" });
    await createTestOrganisation(users.owner, ORG);
    for (const [user, role] of [[users.worker, "farm_worker"], [users.viewer, "viewer"], [users.bookkeeper, "bookkeeper"]] as const) {
      await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, $3)", [ORG, user.id, role]);
    }
    for (const user of Object.values(users)) cookies[user.email] = await sessionCookieFor(user);
    await as(users.owner)((tx) => setFarmingEnabled(tx, { enabled: true }));
    const farms = await as(users.owner)((tx) => saveFarm(tx, { name: "Home farm" }));
    w.farm = farms[0].id;
    w.other = (await as(users.owner)((tx) => saveFarm(tx, { name: "Run-off" }))).find((farm) => farm.name === "Run-off")!.id;
    w.p7 = (await as(users.owner)((tx) => addPaddock(tx, { farmId: w.farm, name: "7", effectiveHa: "4" }))).id;
    w.p8 = (await as(users.owner)((tx) => addPaddock(tx, { farmId: w.farm, name: "8", effectiveHa: "5" }))).id;
    w.r1 = (await as(users.owner)((tx) => addPaddock(tx, { farmId: w.other, name: "R1", effectiveHa: "9" }))).id;
    for (const [user, role] of [[users.worker, "farm_worker"], [users.viewer, "viewer"], [users.bookkeeper, "bookkeeper"]] as const) {
      await as(users.owner)((tx) => setMemberFarmAccess(tx, { userId: user.id, role, access: "farms", farmIds: [w.farm] }));
    }
    tokens.viewerRead = await makeKey(users.viewer, "read");
    tokens.bookkeeperRead = await makeKey(users.bookkeeper, "read");
    tokens.bookkeeperDraft = await makeKey(users.bookkeeper, "draft");
    tokens.ownerDraft = await makeKey(users.owner, "draft");
  });

  afterAll(async () => {
    await server?.teardown();
  });

  function handlerFor(path: string): { handler: Handler; params: Record<string, string> } {
    let match: RegExpExecArray | null;
    if (path === "/api/farming/pasture-photos") return { handler: photosRoute.POST as Handler, params: {} };
    if ((match = /^\/api\/farming\/farms\/([^/]+)\/pasture\/readings$/.exec(path))) return { handler: readingsRoute.POST as Handler, params: { farmId: match[1] } };
    throw new Error(`No route for ${path} in this test.`);
  }

  /** Sends as the worker; the first `loseAnswers` sends arrive but their answers are lost. */
  function tohyee(loseAnswers = 0) {
    let lose = loseAnswers;
    const sent: string[] = [];
    const sender: Sender = async (item: QueueItem, body) => {
      const { handler, params: routeParams } = handlerFor(item.request.path);
      const response = await handler(apiRequest(item.request.path, { method: item.request.method, cookie: cookies[users.worker.email], body }), params(routeParams) as never);
      const payload = (await response.json()) as Json;
      sent.push(`${item.kind} ${response.status}`);
      if (lose > 0) {
        lose -= 1;
        return { outcome: "unreachable" };
      }
      return response.ok ? { outcome: "done", result: payload } : sendOutcome(response.status, String(payload.error));
    };
    return { sender, sent };
  }

  const get = async (handler: Handler, path: string, routeParams: Record<string, string>, user: SessionUser) => {
    const response = await handler(apiRequest(path, { cookie: cookies[user.email] }), params(routeParams) as never);
    return { status: response.status, body: response.headers.get("content-type")?.startsWith("application/json") ? ((await response.json()) as Json) : null };
  };
  const decide = async (user: SessionUser, estimateId: string, body: Json) => {
    const response = await decideRoute.POST(apiRequest(`/api/farming/pasture-estimates/${estimateId}`, { method: "POST", cookie: cookies[user.email], body: { organisationId: ORG, ...body } }), params({ estimateId }) as never);
    return { status: response.status, body: (await response.json()) as Json };
  };

  it("sends a walk photo and its reading once each, though answers were lost, and links them whichever arrived first", async () => {
    const queue = await openQueue({ server: "http://tohyee.test", userId: users.worker.id, organisationId: ORG }, { factory: new IDBFactory(), locks: null, channel: false });
    const readingOperation = "6f1d2c3b-4a59-4e68-8a7b-1c2d3e4f5a6b";
    // The photo is taken first; the reading it names is saved after it.
    const { item: photo } = await queue.add({
      kind: "pasture.photo",
      label: "Photo: paddock 7",
      farmId: w.farm,
      farmName: "Home farm",
      request: { method: "POST", path: "/api/farming/pasture-photos", body: { farmId: w.farm, paddockId: w.p7, fileName: "p7.jpg", contentType: "image/jpeg", phoneFileTime: `${D2}T00:00:00.000Z`, place: { latitude: -45.9, longitude: 170.4, accuracyM: 6, at: `${D2}T00:00:00.000Z` }, readingOperationId: readingOperation }, files: [{ blob: "file", field: "contentBase64" }] },
      blobs: { file: new Blob([jpeg(1)], { type: "image/jpeg" }) },
    });
    await queue.add({ operationId: readingOperation, kind: "farm.reading", label: "Paddock 7: 2,450", farmId: w.farm, farmName: "Home farm", request: { method: "POST", path: `/api/farming/farms/${w.farm}/pasture/readings`, body: { paddockId: w.p7, measuredOn: D2, cover: 2450, method: "plate_meter" } } });
    // A paddock photo on its own, for an estimate.
    const { item: alone } = await queue.add({
      kind: "pasture.photo",
      label: "Photo: paddock 8",
      farmId: w.farm,
      farmName: "Home farm",
      request: { method: "POST", path: "/api/farming/pasture-photos", body: { farmId: w.farm, paddockId: w.p8, fileName: "p8.jpg", contentType: "image/jpeg", phoneFileTime: `${D2}T01:00:00.000Z` }, files: [{ blob: "file", field: "contentBase64" }] },
      blobs: { file: new Blob([jpeg(2)], { type: "image/jpeg" }) },
    });
    const lossy = tohyee(2);
    await queue.sync(lossy.sender);
    await queue.sync(lossy.sender);
    expect(await queue.sync(lossy.sender)).toEqual({ sent: 3, refused: 0, stoppedBecause: "done" });
    expect(lossy.sent).toEqual(["pasture.photo 201", "pasture.photo 201", "pasture.photo 201", "farm.reading 201", "pasture.photo 201"]);
    expect(await count("select count(*) as n from pasture_photos")).toBe(2);
    expect(await count("select count(*) as n from pasture_readings where paddock_id = $1", [w.p7])).toBe(1);
    w.photo7 = photo.operationId;
    w.photo8 = alone.operationId;

    const diary = await get(diaryRoute.GET as Handler, `/api/farming/paddocks/${w.p7}/photos?organisationId=${ORG}`, { paddockId: w.p7 }, users.worker);
    const [kept] = (diary.body!.photos as Json[]);
    expect(kept).toMatchObject({ id: w.photo7, takenOn: D2, phoneFileTime: `${D2}T00:00:00.000Z`, place: { latitude: -45.9, longitude: 170.4, accuracyM: 6 }, reading: { cover: 2450, method: "plate_meter", estimate: false }, estimate: null, uploadedByEmail: users.worker.email });
    // The same operation id with a different photo is refused, not written over.
    await expect(as(users.worker)((tx) => uploadPasturePhoto(tx, { paddockId: w.p8, contentType: "image/jpeg", contentBase64: jpeg(3).toString("base64"), operationId: w.photo8 }))).rejects.toThrow("already used for another photo");
  });

  it("keeps photos like readings: farm staff add, viewers look, only on their own farms; removing hides and keeps", async () => {
    const runOff = await as(users.owner)((tx) => uploadPasturePhoto(tx, { paddockId: w.r1, contentType: "image/jpeg", contentBase64: jpeg(4).toString("base64") }));
    w.photoR1 = runOff.id;
    await expect(as(users.worker)((tx) => uploadPasturePhoto(tx, { paddockId: w.r1, contentType: "image/jpeg", contentBase64: jpeg(5).toString("base64") }))).rejects.toThrow("Paddock not found");
    const viewerAdds = await photosRoute.POST(apiRequest("/api/farming/pasture-photos", { method: "POST", cookie: cookies[users.viewer.email], body: { organisationId: ORG, paddockId: w.p8, contentType: "image/jpeg", contentBase64: jpeg(6).toString("base64") } }), noContext as never);
    expect(viewerAdds.status).toBe(403);
    expect((await get(photoRoute.GET as Handler, `/api/farming/pasture-photos/${w.photo8}?organisationId=${ORG}`, { photoId: w.photo8 }, users.viewer)).status).toBe(200);
    expect((await get(photoRoute.GET as Handler, `/api/farming/pasture-photos/${w.photoR1}?organisationId=${ORG}`, { photoId: w.photoR1 }, users.viewer)).status).toBe(404);
    // Not a photo at all.
    await expect(as(users.worker)((tx) => uploadPasturePhoto(tx, { paddockId: w.p8, contentType: "image/jpeg", contentBase64: Buffer.from("not a photo").toString("base64") }))).rejects.toThrow("isn't the kind it says");
    // A mistaken photo is removed by a bookkeeper: hidden, kept, and never changed otherwise.
    const mistake = await as(users.worker)((tx) => uploadPasturePhoto(tx, { paddockId: w.p8, contentType: "image/jpeg", contentBase64: jpeg(7).toString("base64") }));
    const workerRemoves = await photoRoute.DELETE(apiRequest(`/api/farming/pasture-photos/${mistake.id}?organisationId=${ORG}`, { method: "DELETE", cookie: cookies[users.worker.email] }), params({ photoId: mistake.id }) as never);
    expect(workerRemoves.status).toBe(403);
    const removed = await photoRoute.DELETE(apiRequest(`/api/farming/pasture-photos/${mistake.id}?organisationId=${ORG}`, { method: "DELETE", cookie: cookies[users.bookkeeper.email] }), params({ photoId: mistake.id }) as never);
    expect(removed.status).toBe(200);
    expect(await count("select count(*) as n from pasture_photos where id = $1 and status = 'removed'", [mistake.id])).toBe(1);
    await expect(as(users.owner)((tx) => tx.query("update pasture_photos set taken_on = '2020-01-01' where id = $1", [w.photo8]))).rejects.toThrow("only removed");
    await expect(as(users.owner)((tx) => tx.query("delete from pasture_photos where id = $1", [w.photo8]))).rejects.toThrow("only removed");
  });

  it("lets the person's own AI list and look at photos on their farms, and propose covers only with Make drafts", async () => {
    // Look only: listing and looking, no proposing.
    expect(await toolNames(tokens.viewerRead)).toEqual(expect.arrayContaining(["list_pasture_photos_awaiting_estimate", "get_pasture_photo"]));
    expect(await toolNames(tokens.viewerRead)).not.toContain("propose_pasture_cover_estimate");
    const listed = await call(tokens.viewerRead, "list_pasture_photos_awaiting_estimate");
    const ids = (listed.photos as Json[]).map((photo) => photo.photoId);
    expect(ids.sort()).toEqual([w.photo7, w.photo8].sort());
    // No place and no reading in what the AI is given.
    expect(Object.keys((listed.photos as Json[])[0]).sort()).toEqual(["cameraDate", "contentType", "farmId", "farmName", "hectares", "note", "paddockId", "paddockName", "phoneFileTime", "sizeBytes", "takenOn", "tooBigToSend", "photoId"].sort());
    const looked = await mcp(tokens.viewerRead, "get_pasture_photo", { photoId: w.photo8 });
    expect(looked.isError).toBeFalsy();
    expect(looked.content[1]).toEqual({ type: "image", mimeType: "image/jpeg", data: jpeg(2).toString("base64") });
    expect(JSON.parse(looked.content[0].text!).photo).not.toHaveProperty("place");
    // Another farm's photo isn't there for someone without that farm.
    expect((await mcp(tokens.viewerRead, "get_pasture_photo", { photoId: w.photoR1 })).content[0].text).toBe("That photo wasn't found.");
    await expect(mcp(tokens.viewerRead, "propose_pasture_cover_estimate", { photoId: w.photo8, cover: 2000, confidence: "low", reasoning: "Short." })).rejects.toThrow('needs an AI key with "Make drafts" access');
    await expect(mcp(tokens.bookkeeperRead, "propose_pasture_cover_estimate", { photoId: w.photo8, cover: 2000, confidence: "low", reasoning: "Short." })).rejects.toThrow('this key is "Look only"');
    // The owner sees every farm, so their AI sees the run-off's photo too.
    expect(((await call(tokens.ownerDraft, "list_pasture_photos_awaiting_estimate")).photos as Json[]).map((photo) => photo.photoId)).toContain(w.photoR1);

    // Make drafts: a proposal, never a reading.
    const readingsBefore = await count("select count(*) as n from pasture_readings");
    const proposed = await call(tokens.bookkeeperDraft, "propose_pasture_cover_estimate", { photoId: w.photo8, cover: 2100, confidence: "medium", reasoning: "Even ryegrass about 8 cm, some clover.", idempotencyKey: "estimate-p8-1" });
    expect(proposed).toMatchObject({ created: true, estimate: { status: "waiting", cover: 2100, confidence: "medium", aiKeyName: 'AI key "draft key"', proposedByEmail: users.bookkeeper.email, readingId: null } });
    w.estimate8 = String((proposed.estimate as Json).id);
    expect(await call(tokens.bookkeeperDraft, "propose_pasture_cover_estimate", { photoId: w.photo8, cover: 2100, confidence: "medium", reasoning: "Even ryegrass about 8 cm, some clover.", idempotencyKey: "estimate-p8-1" })).toMatchObject({ created: false });
    await expect(call(tokens.bookkeeperDraft, "propose_pasture_cover_estimate", { photoId: w.photo8, cover: 2300, confidence: "high", reasoning: "Again.", idempotencyKey: "estimate-p8-2" })).rejects.toThrow("already has an estimate");
    await expect(call(tokens.bookkeeperDraft, "propose_pasture_cover_estimate", { photoId: w.photoR1, cover: 2300, confidence: "high", reasoning: "Run-off.", idempotencyKey: "estimate-r1" })).rejects.toThrow("That photo wasn't found.");
    await expect(call(tokens.bookkeeperDraft, "propose_pasture_cover_estimate", { photoId: w.photo7, cover: 25000, confidence: "high", reasoning: "Too much." })).rejects.toThrow("from 0 to 20,000");
    expect(await count("select count(*) as n from pasture_readings")).toBe(readingsBefore);
    const proposed7 = await call(tokens.bookkeeperDraft, "propose_pasture_cover_estimate", { photoId: w.photo7, cover: 2250, confidence: "high", reasoning: "Dense sward, little dead matter.", idempotencyKey: "estimate-p7-1" });
    w.estimate7 = String((proposed7.estimate as Json).id);
    expect(((await call(tokens.viewerRead, "list_pasture_photos_awaiting_estimate")).photos as Json[])).toEqual([]);
  });

  it("makes a reading only when a person accepts or changes an estimate, keeps the history, and decides once", async () => {
    const screen = await get(estimatesRoute.GET as Handler, `/api/farming/farms/${w.farm}/pasture/estimates?organisationId=${ORG}`, { farmId: w.farm }, users.bookkeeper);
    expect(screen.body!.ai).toEqual({ connected: true, canPropose: true, roleCanConnect: true, roleCanPropose: true });
    expect((screen.body!.waiting as Json[]).map((estimate) => [estimate.paddockName, estimate.status, (estimate.photoReading as Json | null)?.cover ?? null])).toEqual([
      ["7", "waiting", 2450],
      ["8", "waiting", null],
    ]);
    // Farm staff have no AI of their own: the screen says so.
    expect((await get(estimatesRoute.GET as Handler, `/api/farming/farms/${w.farm}/pasture/estimates?organisationId=${ORG}`, { farmId: w.farm }, users.worker)).body!.ai).toEqual({ connected: false, canPropose: false, roleCanConnect: false, roleCanPropose: false });

    // A photo taken with a reading can't make a second one; it's kept beside it.
    expect((await decide(users.worker, w.estimate7, { action: "accept" })).body.error).toMatch(/taken with a reading of 2,450/);
    expect((await decide(users.worker, w.estimate7, { action: "compare" })).body.estimate).toMatchObject({ status: "compared", readingId: null, decidedByEmail: users.worker.email });

    // A viewer can't decide.
    expect((await decide(users.viewer, w.estimate8, { action: "accept" })).status).toBe(403);
    // Changed, then saved: an estimate reading on the photo's day, labelled as such.
    const changed = await decide(users.worker, w.estimate8, { action: "accept", cover: 2350 });
    expect(changed.body.estimate).toMatchObject({ status: "changed", cover: 2100, decidedCover: 2350, decidedByEmail: users.worker.email });
    const reading = await as(users.owner)((tx) => tx.query<{ cover: number; method: string; measured_on: string; source: string; created_by_email: string }>("select cover, method, measured_on::text, source, created_by_email from pasture_readings where id = $1", [(changed.body.estimate as Json).readingId]));
    expect(reading.rows[0]).toEqual({ cover: 2350, method: "photo_ai", measured_on: D2, source: `AI estimate from a photo (2,100), changed via AI key "draft key"; accepted by ${users.worker.email}`, created_by_email: users.worker.email });
    expect((await decide(users.worker, w.estimate8, { action: "decline" })).status).toBe(409);
    await expect(as(users.owner)((tx) => tx.query("update pasture_photo_estimates set cover = 1 where id = $1", [w.estimate8]))).rejects.toThrow("decided once");
    // The readings list labels it an estimate.
    const listed = await get(readingsRoute.GET as Handler, `/api/farming/farms/${w.farm}/pasture/readings?organisationId=${ORG}&paddockId=${w.p8}`, { farmId: w.farm }, users.viewer);
    expect((listed.body!.readings as Json[])[0]).toMatchObject({ cover: 2350, method: "photo_ai", estimate: true });
    // Readings can't be typed as photo estimates.
    await expect(as(users.worker)((tx) => addReading(tx, { paddockId: w.p8, measuredOn: D2, cover: 2000, method: "photo_ai" }))).rejects.toThrow("Method");

    // Accepted as proposed, and declined, on two more photos.
    const extra = await as(users.worker)((tx) => uploadPasturePhoto(tx, { paddockId: w.p8, contentType: "image/jpeg", contentBase64: jpeg(8).toString("base64"), phoneFileTime: `${D0}T00:00:00Z` }));
    const wrong = await as(users.worker)((tx) => uploadPasturePhoto(tx, { paddockId: w.p8, contentType: "image/jpeg", contentBase64: jpeg(9).toString("base64"), phoneFileTime: `${D0}T00:05:00Z` }));
    const a = await call(tokens.bookkeeperDraft, "propose_pasture_cover_estimate", { photoId: extra.id, cover: 2400, confidence: "low", reasoning: "Hard to see the base.", idempotencyKey: "estimate-extra" });
    const b = await call(tokens.bookkeeperDraft, "propose_pasture_cover_estimate", { photoId: wrong.id, cover: 900, confidence: "low", reasoning: "Mostly the race.", idempotencyKey: "estimate-wrong" });
    expect((await decide(users.bookkeeper, String((a.estimate as Json).id), { action: "accept" })).body.estimate).toMatchObject({ status: "accepted", decidedCover: 2400 });
    expect((await decide(users.bookkeeper, String((b.estimate as Json).id), { action: "decline", reason: "That's the race, not the paddock." })).body.estimate).toMatchObject({ status: "declined", declineReason: "That's the race, not the paddock.", readingId: null });
    const history = await get(estimatesRoute.GET as Handler, `/api/farming/farms/${w.farm}/pasture/estimates?organisationId=${ORG}`, { farmId: w.farm }, users.viewer);
    expect(history.body!.waiting).toEqual([]);
    expect((history.body!.decided as Json[]).map((estimate) => estimate.status).sort()).toEqual(["accepted", "changed", "compared", "declined"]);
  });

  it("compares estimates with other readings close in time, by method, and never changes them", async () => {
    // Paddock 7: the photo (two days ago) is beside its own plate reading (2,450) and a satellite one two days later.
    await as(users.owner)((tx) => addReading(tx, { paddockId: w.p7, measuredOn: D0, cover: 2000, method: "satellite" }));
    const calibration = await get(calibrationRoute.GET as Handler, `/api/farming/farms/${w.farm}/pasture/calibration?organisationId=${ORG}&windowDays=2`, { farmId: w.farm }, users.viewer);
    const groups = (calibration.body!.calibration as Json).groups as Json[];
    expect(groups.map((group) => [group.method, group.count, group.averageDifference])).toEqual([
      ["plate_meter", 1, -200],
      ["satellite", 1, 250],
    ]);
    expect(groups[0].text).toBe("Photo estimates were 200 kg DM/ha lower than plate meter readings on average, over 1 check within 2 days.");
    // The declined estimate is left out; estimates are as the AI gave them.
    expect((calibration.body!.calibration as Json).estimates).toBe(3);
    expect(await count("select count(*) as n from pasture_photo_estimates where cover = 2250")).toBe(1);
    const sameDay = await get(calibrationRoute.GET as Handler, `/api/farming/farms/${w.farm}/pasture/calibration?organisationId=${ORG}&windowDays=0`, { farmId: w.farm }, users.viewer);
    expect(((sameDay.body!.calibration as Json).groups as Json[]).map((group) => group.method)).toEqual(["plate_meter"]);
    expect((await get(calibrationRoute.GET as Handler, `/api/farming/farms/${w.farm}/pasture/calibration?organisationId=${ORG}&windowDays=30`, { farmId: w.farm }, users.viewer)).status).toBe(400);
    expect((await get(calibrationRoute.GET as Handler, `/api/farming/farms/${w.other}/pasture/calibration?organisationId=${ORG}`, { farmId: w.other }, users.viewer)).status).toBe(404);
  });
});
