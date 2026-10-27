import { describe, expect, it } from "vitest";
import { createDraftStore, sendDraft, sendOutcome } from "@/lib/client/safety-drafts";

function memoryStorage() {
  const map = new Map<string, string>();
  return { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => void map.set(key, value) };
}

const draft = { operationId: "op-1234567890", userId: "u1", organisationId: "org", farmId: "1", farmName: "Home", label: "Near miss: tractor", path: "/api/farming/safety/reports", body: { farmId: "1", type: "near_miss", title: "Tractor" } };

/** Reports saved on the phone until sent (#446, FS19, decision 944). */
describe("safety drafts on the phone", () => {
  it("survive reopening (a new store on the same storage) and belong to one person and organisation", () => {
    const storage = memoryStorage();
    createDraftStore(() => storage).save(draft);
    const reopened = createDraftStore(() => storage);
    expect(reopened.list("u1", "org").map((each) => [each.operationId, each.status])).toEqual([["op-1234567890", "saved"]]);
    expect(reopened.list("u2", "org")).toEqual([]);
    expect(reopened.list("u1", "other")).toEqual([]);
  });

  it("are sent once with their own operation id, and only removed when recorded", async () => {
    const storage = memoryStorage();
    const store = createDraftStore(() => storage);
    store.save(draft);
    const sent: Array<Record<string, unknown>> = [];
    const offline = await sendDraft(store, store.list("u1", "org")[0], async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(offline).toEqual({ result: "kept", reason: "No connection to Tohyee." });
    expect(store.list("u1", "org")[0].status).toBe("saved");
    const ok = await sendDraft(store, store.list("u1", "org")[0], async (_path, body) => void sent.push(body));
    expect(ok).toEqual({ result: "sent" });
    expect(sent).toEqual([{ ...draft.body, operationId: "op-1234567890" }]);
    expect(store.list("u1", "org")).toEqual([]);
  });

  it("need attention when refused, and stay until dealt with", async () => {
    const storage = memoryStorage();
    const store = createDraftStore(() => storage);
    store.save(draft);
    const outcome = await sendDraft(store, store.list("u1", "org")[0], async () => {
      throw Object.assign(new Error("Someone changed this record"), { status: 409 });
    });
    expect(outcome.result).toBe("needs_attention");
    expect(store.list("u1", "org")[0]).toMatchObject({ status: "needs_attention", problem: "Someone changed this record" });
  });

  it("treat a busy or broken server as try again later", () => {
    expect(sendOutcome(Object.assign(new Error("Busy"), { status: 503 })).result).toBe("kept");
    expect(sendOutcome(Object.assign(new Error("Slow down"), { status: 429 })).result).toBe("kept");
    expect(sendOutcome(Object.assign(new Error("Bad"), { status: 400 })).result).toBe("needs_attention");
  });

  it("are dropped after 14 days, and a phone that won't store them says so", () => {
    const storage = memoryStorage();
    let now = new Date("2026-10-01T00:00:00Z");
    const store = createDraftStore(() => storage, () => now);
    store.save(draft);
    now = new Date("2026-10-16T00:00:01Z");
    expect(store.list("u1", "org")).toEqual([]);
    const full = createDraftStore(() => ({ getItem: () => null, setItem: () => { throw new Error("QuotaExceeded"); } }));
    expect(full.save(draft)).toBe(false);
  });
});
