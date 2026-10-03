import { Readable } from "node:stream";
import { ImapFlow } from "imapflow";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setMailFetchForTests } from "@/lib/crm/mail/providers";
import { imapReportMessages, listImapFolders, listReportFolders, reportMessages, setImapFactoryForTests } from "@/lib/analytics/report-email-providers";
import { MAX_ATTACHMENT_BYTES } from "@/lib/analytics/report-email-files";

afterEach(() => { setMailFetchForTests(null); setImapFactoryForTests(null); vi.useRealTimers(); });
const json = (value: unknown) => new Response(JSON.stringify(value));
const credentials = { host: "imap.example.com", port: 993, username: "owner@example.com", password: "private-password" };
async function collect<T>(values: AsyncIterable<T>) {
  const result: T[] = [];
  for await (const value of values) result.push(value);
  return result;
}

describe("report email providers (decision 362)", () => {
  it("lists Gmail labels and lazily downloads chosen-label attachments read-only", async () => {
    const calls: string[] = [];
    setMailFetchForTests(async (url, init) => {
      calls.push(url);
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("error");
      expect(init?.signal).toBeDefined();
      if (url.endsWith("/labels")) return json({ labels: [{ id: "Label_1", name: "Reports" }] });
      if (url.includes("/attachments/")) return json({ size: 3, data: "YSxi" });
      if (url.includes("/messages/m1?")) return json({ id: "m1", internalDate: "1791028800000", payload: { parts: [{ filename: "sales.csv", body: { attachmentId: "a1", size: 3 } }] } });
      expect(new URL(url).searchParams.get("labelIds")).toBe("Label_1");
      return json({ messages: [{ id: "m1" }] });
    });
    expect(await listReportFolders("google", "token")).toEqual([{ id: "Label_1", name: "Reports" }]);
    const messages = await collect(reportMessages("google", "token", "Label_1"));
    expect(calls.some((url) => url.includes("/attachments/"))).toBe(false);
    expect(messages[0].receivedAt).toBe("2026-10-03T12:00:00.000Z");
    expect(await messages[0].attachments[0].read()).toEqual(Buffer.from("a,b"));
  });

  it("skips saved Gmail messages before downloading them, and reports a bad one without stopping", async () => {
    const fetched: string[] = [];
    setMailFetchForTests(async (url) => {
      if (url.includes("/messages?")) return json({ messages: [{ id: "saved" }, { id: "deep" }, { id: "fine" }] });
      fetched.push(url);
      if (url.includes("/messages/deep?")) {
        const deep = { parts: [] as unknown[] };
        let node = deep;
        for (let level = 0; level < 25; level++) { const child = { parts: [] as unknown[] }; node.parts.push(child); node = child; }
        return json({ internalDate: "1791028800000", payload: deep });
      }
      return json({ internalDate: "1791028800000", payload: {} });
    });
    const messages = await collect(reportMessages("google", "token", "reports", (id) => id === "saved"));
    expect(fetched.some((url) => url.includes("/messages/saved?"))).toBe(false);
    expect(messages.map((message) => [message.id, message.problem ?? null])).toEqual([
      ["deep", "The report email has too many MIME parts."],
      ["fine", null],
    ]);
  });

  it("streams beyond 500 Gmail messages and stops fetching when the consumer stops", async () => {
    let listed = 0;
    setMailFetchForTests(async (url) => {
      if (url.includes("/messages?")) {
        const page = listed++;
        return json({ messages: Array.from({ length: 100 }, (_, i) => ({ id: `${page * 100 + i}` })), ...(page < 5 ? { nextPageToken: `page-${page + 1}` } : {}) });
      }
      return json({ internalDate: "1791028800000", payload: {} });
    });
    expect((await collect(reportMessages("google", "token", "reports"))).length).toBe(600);
    listed = 0;
    for await (const message of reportMessages("google", "token", "reports")) { expect(message.id).toBe("0"); break; }
    expect(listed).toBe(1);
  });

  it("lists paginated Graph child folders and scopes messages and attachments to the selected folder", async () => {
    const calls: string[] = [];
    setMailFetchForTests(async (url, init) => {
      calls.push(url);
      expect(init?.method).toBe("GET");
      if (url.includes("/attachments/a")) return json({ name: "sales.csv", contentBytes: "YSxi", size: 3, "@odata.type": "#microsoft.graph.fileAttachment" });
      if (url.includes("/attachments")) return json({ value: [{ id: "a", name: "sales.csv", size: 3, "@odata.type": "#microsoft.graph.fileAttachment" }] });
      if (url.includes("/messages")) return json({ value: [{ id: "m", receivedDateTime: "2026-10-03T12:00:00Z", hasAttachments: true }] });
      if (url.includes("/childFolders")) return json({ value: [{ id: "child", displayName: "Reports", childFolderCount: 0 }] });
      return json({ value: [{ id: "parent", displayName: "Inbox", childFolderCount: 1 }], ...(url.includes("page=2") ? {} : { "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/mailFolders?page=2" }) });
    });
    expect(await listReportFolders("microsoft", "token")).toContainEqual({ id: "child", name: "Reports" });
    const messages = await collect(reportMessages("microsoft", "token", "child"));
    expect(await messages[0].attachments[0].read()).toEqual(Buffer.from("a,b"));
    expect(calls.filter((url) => url.includes("/messages")).every((url) => url.includes("/mailFolders/child/messages"))).toBe(true);
  });

  it.each(["https://evil.example/mailFolders", "https://graph.microsoft.com.evil.example/v1.0/me/mailFolders", "https://graph.microsoft.com/v1.0/users/other/mailFolders"])("refuses unsafe Graph next links %s before sending credentials", async (next) => {
    const fetcher = vi.fn(async () => json({ value: [], "@odata.nextLink": next }));
    setMailFetchForTests(fetcher);
    await expect(listReportFolders("microsoft", "secret-token")).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("bounds responses/downloads and never exposes provider errors or tokens", async () => {
    setMailFetchForTests(async () => new Response("private-password secret-token", { status: 401 }));
    await expect(listReportFolders("google", "secret-token")).rejects.toThrow(/connect|mailbox/i);
    try { await listReportFolders("google", "secret-token"); } catch (error) { expect(String(error)).not.toMatch(/private-password|secret-token/); }
    setMailFetchForTests(async () => new Response("{}", { headers: { "content-length": "999999999" } }));
    await expect(listReportFolders("google", "token")).rejects.toThrow();
    setMailFetchForTests(async (url) => url.includes("/messages?") ? json({ messages: [{ id: "m" }] }) : json({ internalDate: "1791028800000", payload: { filename: "a.csv", body: { size: MAX_ATTACHMENT_BYTES + 1, attachmentId: "a" } } }));
    const messages = await collect(reportMessages("google", "token", "reports"));
    await expect(messages[0].attachments[0].read()).rejects.toThrow();
  });

  it("bounds streamed JSON and times out even when a provider never responds", async () => {
    setMailFetchForTests(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(Buffer.alloc(2 * 1024 * 1024 + 1)); controller.close(); },
    })));
    await expect(listReportFolders("google", "token")).rejects.toThrow(/size limit/);
    vi.useFakeTimers();
    setMailFetchForTests(() => new Promise(() => {}));
    const timeout = expect(listReportFolders("google", "token")).rejects.toThrow(/too long/);
    await vi.advanceTimersByTimeAsync(30_000);
    await timeout;
  });

  it("rejects repeated pagination and invalid base64 rather than accepting a partial report", async () => {
    setMailFetchForTests(async (url) => url.includes("/messages?")
      ? json({ messages: [], nextPageToken: "same-page" })
      : json({ internalDate: "1791028800000" }));
    await expect(collect(reportMessages("google", "token", "reports"))).rejects.toThrow(/repeated/);
    setMailFetchForTests(async (url) => url.includes("/messages?")
      ? json({ messages: [{ id: "m" }] })
      : json({ internalDate: "1791028800000", payload: { filename: "a.csv", body: { size: 1, data: "!" } } }));
    const [message] = await collect(reportMessages("google", "token", "reports"));
    await expect(message.attachments[0].read()).rejects.toThrow(/decoded/);
  });

  it("validates IMAP TLS settings before connecting", async () => {
    const factory = vi.fn();
    setImapFactoryForTests(factory);
    await expect(listImapFolders({ ...credentials, port: 143 })).rejects.toThrow();
    await expect(listImapFolders({ ...credentials, host: "imap://bad" })).rejects.toThrow();
    expect(factory).not.toHaveBeenCalled();
  });

  it("uses read-only IMAP locks, UIDVALIDITY identities, bounded single-part reads and closes connections", async () => {
    const lock = vi.fn(async () => ({ release: vi.fn() }));
    const download = vi.fn(async () => ({ content: Readable.from(Buffer.from("a,b")), meta: {} }));
    const logout = vi.fn(async () => {});
    const options: unknown[] = [];
    const client = {
      connect: vi.fn(async () => {}), logout, close: vi.fn(), getMailboxLock: lock, download,
      list: vi.fn(async () => [{ path: "Reports", name: "Reports", flags: new Set<string>() }, { path: "Parent", name: "Parent", flags: new Set(["\\Noselect"]) }]),
      mailbox: { uidValidity: BigInt(7), exists: 1 },
      fetch: async function* () { yield { uid: 12, seq: 1, size: 1000, internalDate: new Date("2026-10-03T12:00:00Z"), bodyStructure: { type: "text/csv", size: 3, encoding: "8bit", disposition: "attachment", dispositionParameters: { filename: "sales.csv" } } }; },
    };
    setImapFactoryForTests((config) => { options.push(config); return client; });
    expect(await listImapFolders(credentials)).toEqual([{ id: "Reports", name: "Reports" }]);
    const messages = await collect(imapReportMessages(credentials, "Reports"));
    expect(messages[0].id).toBe("7:12");
    expect(download).not.toHaveBeenCalled();
    expect(await messages[0].attachments[0].read()).toEqual(Buffer.from("a,b"));
    expect(lock).toHaveBeenCalledWith("Reports", expect.objectContaining({ readOnly: true }));
    expect(download).toHaveBeenCalledWith("12", "1", { uid: true, maxBytes: MAX_ATTACHMENT_BYTES + 1 });
    expect(options[0]).toMatchObject({ secure: true, port: 993, logger: false, tls: { rejectUnauthorized: true } });
    expect(logout).toHaveBeenCalledTimes(3);
    client.mailbox.uidValidity = BigInt(8);
    await expect(messages[0].attachments[0].read()).rejects.toThrow();
  });

  it("rejects oversized declared parts and bounds actual decoded bytes when the declaration is dishonest", async () => {
    let declaredSize = MAX_ATTACHMENT_BYTES + 1;
    const download = vi.fn(async () => ({ content: Readable.from([Buffer.alloc(MAX_ATTACHMENT_BYTES + 1)]) }));
    const client = {
      connect: async () => {}, logout: async () => {}, close: () => {},
      list: async () => [],
      mailbox: { uidValidity: BigInt(7), exists: 1 },
      getMailboxLock: async () => ({ release: () => {} }),
      download,
      fetch: async function* () {
        yield { seq: 1, uid: 1, internalDate: new Date("2026-10-03"), size: 1000, bodyStructure: { type: "text/csv", part: "2", size: declaredSize, encoding: "8bit", dispositionParameters: { filename: "a.csv" } } };
      },
    };
    setImapFactoryForTests(() => client);
    const [oversized] = await collect(imapReportMessages(credentials, "Reports"));
    await expect(oversized.attachments[0].read()).rejects.toThrow(/size limit/);
    expect(download).not.toHaveBeenCalled();
    declaredSize = 1;
    const [dishonest] = await collect(imapReportMessages(credentials, "Reports"));
    await expect(dishonest.attachments[0].read()).rejects.toThrow(/size limit/);
  });

  it("reads two valid 25MiB attachments individually despite aggregate MIME over 40MiB, without reading PDFs", async () => {
    const encodedSize = Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4;
    const download = vi.fn(async (_uid: string, part: string) => {
      expect(["1", "2"]).toContain(part);
      return { content: Readable.from(Buffer.alloc(MAX_ATTACHMENT_BYTES)), meta: { encoding: "base64" } };
    });
    const client = {
      connect: async () => {}, logout: async () => {}, close: () => {},
      list: async () => [], mailbox: { uidValidity: BigInt(7), exists: 1 },
      getMailboxLock: async () => ({ release: () => {} }), download,
      fetch: async function* () {
        yield {
          seq: 1, uid: 1, internalDate: new Date("2026-10-03"), size: encodedSize * 3,
          bodyStructure: { type: "multipart/mixed", childNodes: [
            { part: "1", type: "text/csv", size: encodedSize, encoding: "base64", dispositionParameters: { filename: "sales.csv" } },
            { part: "2", type: "text/tab-separated-values", size: encodedSize, encoding: "base64", dispositionParameters: { filename: "trends.tsv" } },
            { part: "3", type: "application/pdf", size: encodedSize, encoding: "base64", dispositionParameters: { filename: "ignored.pdf" } },
          ] },
        };
      },
    };
    setImapFactoryForTests(() => client);
    const [message] = await collect(imapReportMessages(credentials, "Reports"));
    expect(message.attachments.map((file) => file.name)).toEqual(["sales.csv", "trends.tsv"]);
    expect(download).not.toHaveBeenCalled();
    expect((await message.attachments[0].read()).length).toBe(MAX_ATTACHMENT_BYTES);
    expect((await message.attachments[1].read()).length).toBe(MAX_ATTACHMENT_BYTES);
    expect(download.mock.calls.map(([, part]) => part)).toEqual(["1", "2"]);
  });

  it("refuses decoded content exceeding a part's declared size", async () => {
    const client = {
      connect: async () => {}, logout: async () => {}, close: () => {}, list: async () => [],
      mailbox: { uidValidity: BigInt(7), exists: 1 },
      getMailboxLock: async () => ({ release: () => {} }),
      download: async () => ({ content: Readable.from(Buffer.from("longer")), meta: { encoding: "8bit" } }),
      fetch: async function* () {
        yield { seq: 1, uid: 1, internalDate: new Date("2026-10-03"), bodyStructure: { type: "text/csv", part: "2", size: 3, encoding: "8bit", dispositionParameters: { filename: "a.csv" } } };
      },
    };
    setImapFactoryForTests(() => client);
    const [message] = await collect(imapReportMessages(credentials, "Reports"));
    await expect(message.attachments[0].read()).rejects.toThrow(/declared size|incorrect size/);
  });

  it.each([["base64", "YSxi"], ["quoted-printable", "a=2Cb"]])("uses installed ImapFlow transfer decoding for %s parts", async (encoding, encoded) => {
    const headers = Buffer.from(`Content-Type: text/csv\r\nContent-Disposition: attachment; filename="a.csv"\r\nContent-Transfer-Encoding: ${encoding}\r\n\r\n`);
    const sdk = {
      mailbox: { uidValidity: BigInt(7), exists: 1 }, _openDownloads: 0, autoidle: () => {},
      log: { warn: vi.fn(), error: vi.fn() },
      fetchOne: vi.fn(async () => ({
        uid: 1, seq: 1, size: 1000, bodyParts: new Map([["2", Buffer.from(encoded)], ["2.mime", headers]]),
      })),
    };
    const client = {
      connect: async () => {}, logout: async () => {}, close: () => {}, list: async () => [],
      mailbox: sdk.mailbox, getMailboxLock: async () => ({ release: () => {} }),
      download: (uid: string, part: string, options: { uid: boolean; maxBytes: number }) => ImapFlow.prototype.download.call(sdk as unknown as ImapFlow, uid, part, options),
      fetch: async function* () {
        yield { seq: 1, uid: 1, internalDate: new Date("2026-10-03"), bodyStructure: { type: "text/csv", part: "2", size: encoded.length, encoding, dispositionParameters: { filename: "a.csv" } } };
      },
    };
    setImapFactoryForTests(() => client);
    const [message] = await collect(imapReportMessages(credentials, "Reports"));
    expect(await message.attachments[0].read()).toEqual(Buffer.from("a,b"));
    expect(sdk.fetchOne).toHaveBeenCalledWith("1", expect.objectContaining({ bodyParts: expect.arrayContaining(["2.mime"]) }), expect.objectContaining({ uid: true, maxBytes: MAX_ATTACHMENT_BYTES + 1 }));
  });
});
