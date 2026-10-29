import { describe, expect, it } from "vitest";
import { APP_API, checkServerAddress, identifyUrl, normaliseServerAddress, readIdentity, unreachableText } from "@/lib/native/server-address";

/*
 * The Android app's "Your Tohyee address" screen (#502, decisions
 * 1140-1142): HTTPS only, the server's origin only, and the address must
 * answer as a Tohyee server.
 */

describe("normaliseServerAddress", () => {
  it("adds https:// and keeps only the origin", () => {
    expect(normaliseServerAddress("tohyee.example.nz")).toEqual({ ok: true, origin: "https://tohyee.example.nz" });
    expect(normaliseServerAddress("  https://Tohyee.Example.NZ/operations/farm?x=1#y ")).toEqual({ ok: true, origin: "https://tohyee.example.nz" });
    expect(normaliseServerAddress("farm-pc.tail1a2b3c.ts.net")).toEqual({ ok: true, origin: "https://farm-pc.tail1a2b3c.ts.net" });
    expect(normaliseServerAddress("tohyee.example.nz:8443")).toEqual({ ok: true, origin: "https://tohyee.example.nz:8443" });
    expect(normaliseServerAddress("https://tohyee.example.nz:443")).toEqual({ ok: true, origin: "https://tohyee.example.nz" });
  });

  it("refuses plain http, other schemes, a name and password, and localhost", () => {
    const problem = (input: string) => {
      const result = normaliseServerAddress(input);
      return result.ok ? null : result.problem;
    };
    expect(problem("http://192.168.1.20:3000")).toMatch(/http:\/\/, which isn't secure/);
    expect(problem("ftp://tohyee.example.nz")).toMatch(/only opens HTTPS/);
    expect(problem("https://jess:secret@tohyee.example.nz")).toMatch(/Leave out any name or password/);
    expect(problem("localhost:3000")).toMatch(/localhost is the phone itself/);
    expect(problem("")).toMatch(/Type your Tohyee address/);
    expect(problem("tohyee")).toMatch(/whole address/);
    expect(problem("not an address!")).toMatch(/doesn't look like a web address/);
  });

  it("asks /api/app/identify on that origin", () => {
    expect(identifyUrl("https://tohyee.example.nz")).toBe("https://tohyee.example.nz/api/app/identify");
  });
});

describe("readIdentity", () => {
  it("accepts a Tohyee server, with or without its version", () => {
    expect(readIdentity(200, { app: "tohyee", api: 1, name: "Tohyee", version: "0.19.0" })).toEqual({ ok: true, identity: { app: "tohyee", api: 1, name: "Tohyee", version: "0.19.0" } });
    expect(readIdentity(200, { app: "tohyee", api: 1, name: "", version: null })).toEqual({ ok: true, identity: { app: "tohyee", api: 1, name: "Tohyee", version: null } });
  });

  it("says when it's another website, an older Tohyee, an error, or a newer protocol", () => {
    expect(readIdentity(404, null)).toMatchObject({ ok: false, problem: expect.stringMatching(/isn't a Tohyee server/) });
    expect(readIdentity(200, { hello: "world" })).toMatchObject({ ok: false, problem: expect.stringMatching(/isn't a Tohyee server/) });
    expect(readIdentity(200, "<html>")).toMatchObject({ ok: false });
    expect(readIdentity(502, null)).toMatchObject({ ok: false, problem: expect.stringMatching(/error \(502\)/) });
    expect(readIdentity(200, { app: "tohyee", api: APP_API + 1, name: "Tohyee" })).toMatchObject({ ok: false, problem: expect.stringMatching(/newer than this copy of the app/) });
  });
});

describe("checkServerAddress", () => {
  const answering = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

  it("checks the address end to end without cookies", async () => {
    const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetcher = (async (url: string, init?: RequestInit) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({ app: "tohyee", api: 1, name: "Tohyee", version: null }), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await checkServerAddress("tohyee.example.nz/", fetcher)).toEqual({ ok: true, origin: "https://tohyee.example.nz", identity: { app: "tohyee", api: 1, name: "Tohyee", version: null } });
    expect(seen[0].url).toBe("https://tohyee.example.nz/api/app/identify");
    expect(seen[0].init?.credentials).toBe("omit");
  });

  it("never fetches an address it refused", async () => {
    let called = false;
    const fetcher = (async () => {
      called = true;
      return new Response("{}");
    }) as unknown as typeof fetch;
    expect(await checkServerAddress("http://192.168.1.20:3000", fetcher)).toMatchObject({ ok: false });
    expect(called).toBe(false);
  });

  it("says why it couldn't reach it", async () => {
    expect(await checkServerAddress("tohyee.example.nz", answering(404, {}))).toMatchObject({ ok: false, problem: expect.stringMatching(/isn't a Tohyee server/) });
    const failing = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    expect(await checkServerAddress("tohyee.example.nz", failing, { online: false })).toMatchObject({ ok: false, problem: expect.stringMatching(/no connection/) });
    expect(await checkServerAddress("tohyee.example.nz", failing)).toMatchObject({ ok: false, problem: expect.stringMatching(/Couldn't reach that address/) });
    const timeout = Object.assign(new Error("aborted"), { name: "AbortError" });
    expect(unreachableText(timeout, true)).toMatch(/didn't answer within 15 seconds/);
  });

  it("gives up after the time allowed", async () => {
    const hanging = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      })) as unknown as typeof fetch;
    expect(await checkServerAddress("tohyee.example.nz", hanging, { timeoutMs: 10 })).toMatchObject({ ok: false, problem: expect.stringMatching(/15 seconds/) });
  });
});
