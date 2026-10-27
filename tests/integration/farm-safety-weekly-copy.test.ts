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
    const farm = (await as(owner)((tx) => saveFarm(tx, { name: "Home farm" })))[0].id;
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

  it("FS38 weekly: not again within the week; the next copy starts the day after the last", async () => {
    const organisation = (await getOrganisation(ORG))!;
    const [last] = (await as(owner)((tx) => copySettings(tx))).copies;
    const soon = await sendSafetyCopy(organisation, { now: new Date(new Date(last.sentAt).getTime() + 2 * 86_400_000), send: accept });
    expect(soon.skipped).toBe(true);
    const nextWeek = new Date(new Date(last.sentAt).getTime() + 7 * 86_400_000 + 3 * 3_600_000);
    const due = await sendSafetyCopy(organisation, { now: nextWeek, send: accept });
    if (due.skipped) {
      // Before 6am in New Zealand at that moment: a few hours later it goes.
      const later = await sendSafetyCopy(organisation, { now: new Date(nextWeek.getTime() + 8 * 3_600_000), send: accept });
      expect(later.sent!.periodFrom > last.periodTo).toBe(true);
    } else {
      expect(due.sent!.periodFrom > last.periodTo).toBe(true);
      expect(due.sent!.entries).toBe(0);
    }
    await as(owner)((tx) => saveCopySettings(tx, { on: false, toAddresses: "" }));
    expect((await sendSafetyCopy(organisation, { force: true, send: accept })).skipped).toBe(true);
  });
});
