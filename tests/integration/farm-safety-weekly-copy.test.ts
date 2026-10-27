import { afterAll, beforeAll, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import type { OutgoingMessage } from "@/lib/email/smtp";
import { saveFarm, setFarmingEnabled } from "@/lib/farming/paddocks";
import { getOrganisation } from "@/lib/organisations/registry";
import { addHazard } from "@/lib/safety/hazards";
import { loadPackData } from "@/lib/safety/pack";
import { appendEntry, checkSafetyHistory } from "@/lib/safety/records";
import { copySettings, saveCopySettings, sendSafetyCopy } from "@/lib/safety/weekly-copy";
import { createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "farm-safety-copy";

/**
 * The weekly copy off the farm (#446; FS35-FS38 in docs/FARM-SAFETY.md,
 * decisions 958-959). Sending is replaced by a stand-in that records what
 * would go to the mail server; the organisation's real email account path
 * is the one document emails use.
 */
describeWithDatabase("farm safety weekly copy", () => {
  let server: TestServer;
  let owner: SessionUser;
  let staff: SessionUser;
  let farmId: string;
  const as = (user: SessionUser) => <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: user.id, email: user.email }, work);
  const sent: Array<Omit<OutgoingMessage, "messageId">> = [];
  const accept = async (_organisation: unknown, message: Omit<OutgoingMessage, "messageId">) => {
    sent.push(message);
    return { messageId: `<copy-${sent.length}@example.com>`, response: "250 OK", rejected: [] };
  };

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("copy-owner@example.com", { serverAdmin: true, displayName: "Jess" });
    staff = await createTestUser("copy-staff@example.com", { displayName: "Mere" });
    await createTestOrganisation(owner, ORG);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'bookkeeper')", [ORG, staff.id]);
    await as(owner)((tx) => setFarmingEnabled(tx, { enabled: true }));
    farmId = (await as(owner)((tx) => saveFarm(tx, { name: "Home farm" })))[0].id;
    const farm = farmId;
    await as(owner)((tx) => addHazard(tx, { farmId: farm, title: "Effluent pond", level: "high", noGo: true }));
    await as(staff)((tx) => appendEntry(tx, { kind: "report_details", change: "created", farmId: farm, data: { injury: "Private injury" } }));
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("FS35 only an owner or admin chooses where it goes; on needs an address", async () => {
    await expect(as(staff)((tx) => saveCopySettings(tx, { on: true, toAddresses: "accountant@example.com" }))).rejects.toThrow(/owner or admin/);
    await expect(as(owner)((tx) => saveCopySettings(tx, { on: true, toAddresses: "" }))).rejects.toThrow(/Send it to/);
    await expect(as(owner)((tx) => saveCopySettings(tx, { on: true, toAddresses: "not an address" }))).rejects.toThrow();
    const saved = await as(owner)((tx) => saveCopySettings(tx, { on: true, toAddresses: "jess.personal@example.com, accountant@example.com" }));
    expect(saved.settings).toMatchObject({ on: true, toAddresses: ["jess.personal@example.com", "accountant@example.com"] });
  });

  it("FS36 a copy carries the latest entry's number and hash, a PDF, and never injury details", async () => {
    const organisation = (await getOrganisation(ORG))!;
    const result = await sendSafetyCopy(organisation, { force: true, send: accept });
    expect(result.problem).toBeNull();
    const head = (await as(owner)((tx) => checkSafetyHistory(tx))).head!;
    expect(result.sent).toMatchObject({ headSeq: head.seq, headHash: head.hash, entries: 2, toAddresses: ["jess.personal@example.com", "accountant@example.com"] });
    const [message] = sent;
    expect(message.to).toEqual(["jess.personal@example.com", "accountant@example.com"]);
    expect(message.subject).toContain(`entry ${head.seq}`);
    expect(message.text).toContain(head.hash);
    expect(message.text).toContain("Injury and medical details are never in this email.");
    expect(message.text).not.toContain("Private injury");
    expect(Buffer.from(message.attachment!.bytes).subarray(0, 5).toString()).toBe("%PDF-");
    // The owner may see restricted details, but the copy withholds them.
    const data = await as(owner)((tx) => loadPackData(tx, { from: "2026-01-01", to: "2099-12-31", withholdRestricted: true, enteredOnly: true }));
    expect(data.entries.find((entry) => entry.kind === "report_details")?.body).toBeNull();
    expect((await as(owner)((tx) => copySettings(tx))).copies.length).toBe(1);
  });

  it("FS37 a copy the mail server didn't accept isn't recorded as sent", async () => {
    const organisation = (await getOrganisation(ORG))!;
    const failing = await sendSafetyCopy(organisation, {
      force: true,
      send: async () => {
        throw new Error("Connection refused");
      },
    });
    expect(failing).toMatchObject({ sent: null, problem: "It wasn't sent: Connection refused" });
    const rejected = await sendSafetyCopy(organisation, { force: true, send: async () => ({ messageId: "<x>", response: "250", rejected: ["accountant@example.com"] }) });
    expect(rejected.problem).toBe("The mail server refused accountant@example.com.");
    const after = await as(owner)((tx) => copySettings(tx));
    expect(after.copies.length).toBe(1);
    expect(after.settings.lastProblem).toBe("The mail server refused accountant@example.com.");
    await expect(as(owner)((tx) => tx.query("delete from safety_copies"))).rejects.toThrow(/append-only/);
  });

  it("FS38 weekly: not again within the week; the next copy picks up after the last one's entry number", async () => {
    const organisation = (await getOrganisation(ORG))!;
    const [last] = (await as(owner)((tx) => copySettings(tx))).copies;
    const soon = await sendSafetyCopy(organisation, { now: new Date(new Date(last.sentAt).getTime() + 2 * 86_400_000), send: accept });
    expect(soon.skipped).toBe(true);
    const nextWeek = new Date(new Date(last.sentAt).getTime() + 7 * 86_400_000 + 3 * 3_600_000);
    const due = (await sendSafetyCopy(organisation, { now: nextWeek, send: accept })).sent ?? (await sendSafetyCopy(organisation, { now: new Date(nextWeek.getTime() + 8 * 3_600_000), send: accept })).sent!;
    // Before 6am in New Zealand the first try waits; either way nothing new went in.
    expect(due).toMatchObject({ entries: 0, headSeq: last.headSeq });
    expect(due.periodFrom <= due.periodTo).toBe(true);
  });

  it("FS38a nothing entered between copies is missed: same day, next day, failed sends and entries made while sending (#461)", async () => {
    const organisation = (await getOrganisation(ORG))!;
    const hazard = (title: string) => as(owner)((tx) => addHazard(tx, { farmId, title, level: "medium" }));
    const headOf = async () => (await as(owner)((tx) => checkSafetyHistory(tx))).head!.seq;
    const before = await headOf();
    // Entered just after a copy went (the same day, whatever the time or season).
    const sameDay = await hazard("Loose gate by the shed");
    const failing = await sendSafetyCopy(organisation, { force: true, now: new Date("2026-06-15T18:00:00Z"), send: async () => { throw new Error("Connection refused"); } });
    expect(failing.sent).toBeNull();
    const nextDay = await hazard("Wasp nest in the hedge");
    // While this copy is being sent someone adds another: it's after the copy's mark, so the next copy has it.
    let duringSend: Awaited<ReturnType<typeof hazard>> | null = null;
    const first = await sendSafetyCopy(organisation, {
      force: true,
      now: new Date("2026-10-27T17:00:00Z"),
      send: async (org, message) => {
        duringSend = await hazard("Broken step on the vat stand");
        return accept(org, message);
      },
    });
    expect(first.sent).toMatchObject({ entries: 2 });
    expect(Number(first.sent!.headSeq)).toBe(Number(before) + 2);
    expect(sent.at(-1)!.text).toContain(`after number ${before} up to number ${first.sent!.headSeq}`);
    expect([sameDay.seq, nextDay.seq].every((seq) => Number(seq) > Number(before) && Number(seq) <= Number(first.sent!.headSeq))).toBe(true);
    // A daylight-time date never skips a day: the next copy starts with the entry made during the last send.
    const second = await sendSafetyCopy(organisation, { force: true, now: new Date("2026-10-28T11:30:00Z"), send: accept });
    expect(second.sent).toMatchObject({ entries: 1, headSeq: duringSend!.seq });
    expect(sent.at(-1)!.text).toContain(`after number ${first.sent!.headSeq} up to number ${duringSend!.seq}`);
    // A change to an older record brings its whole history.
    await as(owner)((tx) => appendEntry(tx, { kind: "hazard", recordId: sameDay.recordId, expectedVersion: 1, change: "updated", farmId, data: { ...sameDay.data, title: "Loose gate by the shed (chained now)" } }));
    const third = await sendSafetyCopy(organisation, { force: true, send: accept });
    expect(third.sent).toMatchObject({ entries: 2 });
    await as(owner)((tx) => saveCopySettings(tx, { on: false, toAddresses: "" }));
    expect((await sendSafetyCopy(organisation, { force: true, send: accept })).skipped).toBe(true);
  });
});
