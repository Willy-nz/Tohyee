import { createHash } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deflateRawSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractReportAttachment, MAX_ATTACHMENT_BYTES, MAX_CHECK_BYTES, ReportCheckBudgetError, reportFileKey, saveReportFile } from "@/lib/analytics/report-email-files";

const roots: string[] = [];
async function root() {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "tohyee-report-email-"));
  roots.push(folder);
  return folder;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((folder) => fs.rm(folder, { recursive: true, force: true })));
});

function crc32(bytes: Buffer) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function zip(entries: { name: string; bytes: Buffer; flags?: number; mode?: number; declaredSize?: number; compress?: boolean }[]) {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const compressed = entry.compress ? deflateRawSync(entry.bytes) : entry.bytes;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(entry.flags ?? 0, 6);
    header.writeUInt16LE(entry.compress ? 8 : 0, 8);
    header.writeUInt32LE(crc32(entry.bytes), 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(entry.declaredSize ?? entry.bytes.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, compressed);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50);
    directory.writeUInt16LE(0x0314, 4);
    header.copy(directory, 6, 4, 30);
    directory.writeUInt32LE(((entry.mode ?? 0o100600) << 16) >>> 0, 38);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, name);
    offset += header.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

describe("report email files (decision 362)", () => {
  it("accepts flat data files and skips unsupported formats", async () => {
    const bytes = Buffer.from("day,sales\n2026-10-03,12\n");
    for (const name of ["report.csv", "report.TSV", "report.txt"]) {
      expect(await extractReportAttachment(name, bytes, 100)).toEqual([{ name, bytes }]);
    }
    expect(await extractReportAttachment("report.pdf", bytes, 100)).toEqual([]);
  });

  it("uses the same safe normalized output key on Windows and Linux", async () => {
    expect(reportFileKey("Sales.CSV")).toBe("sales.csv");
    expect(reportFileKey("cafe\u0301.csv")).toBe("café.csv");
    expect(() => reportFileKey("../sales.csv")).toThrow();
    const folder = await root();
    const first = await saveReportFile(folder, "box", "m1", "2026-10-03", { name: "Sales.CSV", bytes: Buffer.from("old") }, true);
    expect(first).toBe("email/box/sales.csv");
    const second = await saveReportFile(folder, "box", "m2", "2026-10-03T01:00:00Z", { name: "sales.csv", bytes: Buffer.from("new") }, true);
    expect(second).toBe(first);
    expect(await fs.readFile(path.join(folder, first), "utf8")).toBe("new");
    expect(await fs.readdir(path.join(folder, "email", "box"))).toEqual(["sales.csv"]);
  });

  it.each(["../report.csv", "folder/report.csv", "folder\\report.csv", "/report.csv", "C:report.csv", "report..csv", "NUL.csv", "COM1.tsv", "report.csv.", "report.csv ", "report\u0000.csv", "report?.csv"])("rejects unsafe filename %s", async (name) => {
    await expect(extractReportAttachment(name, Buffer.from("x"), 100)).rejects.toThrow();
  });

  it("extracts flat CSV and TSV while skipping safe flat PDF and TXT without expansion", async () => {
    const bytes = Buffer.from("a,b\n1,2");
    let consumed = 0;
    expect(await extractReportAttachment("report.zip", zip([
      { name: "a.csv", bytes }, { name: "b.tsv", bytes },
      { name: "ignored.pdf", bytes }, { name: "ignored.txt", bytes },
    ]), bytes.length * 2, (size) => { consumed += size; })).toEqual([{ name: "a.csv", bytes }, { name: "b.tsv", bytes }]);
    expect(consumed).toBe(bytes.length * 2);
  });

  it("accepts highly repetitive legitimate CSV above a 100:1 compression ratio", async () => {
    const bytes = Buffer.from("date,total\n" + "2026-10-03,0\n".repeat(10_000));
    expect(bytes.length / deflateRawSync(bytes).length).toBeGreaterThan(100);
    expect(await extractReportAttachment("report.zip", zip([{ name: "report.csv", bytes, compress: true }]), MAX_CHECK_BYTES)).toEqual([{ name: "report.csv", bytes }]);
  });

  it.each([
    { name: "../evil.csv" }, { name: "nested/a.csv" }, { name: "nested/" },
    { name: "bad.csv", mode: 0o120777 }, { name: "bad.csv", flags: 1 },
  ])("rejects malicious ZIP entry $name", async (entry) => {
    await expect(extractReportAttachment("report.zip", zip([{ ...entry, bytes: Buffer.from("x") }]), 100)).rejects.toThrow();
  });

  it("rejects duplicate names, excessive entries, compression bombs and false decompression sizes", async () => {
    const bytes = Buffer.from("x");
    await expect(extractReportAttachment("a.zip", zip([{ name: "A.csv", bytes }, { name: "a.csv", bytes }]), 100)).rejects.toThrow();
    await expect(extractReportAttachment("a.zip", zip(Array.from({ length: 101 }, (_, i) => ({ name: `${i}.csv`, bytes }))), 1000)).rejects.toThrow();
    await expect(extractReportAttachment("a.zip", zip([{ name: "a.csv", bytes: Buffer.alloc(1_000_000), compress: true }]), MAX_CHECK_BYTES)).rejects.toThrow();
    await expect(extractReportAttachment("a.zip", zip([{ name: "a.csv", bytes: Buffer.from("abcdefgh"), compress: true, declaredSize: 1 }]), 100)).rejects.toThrow();
  });

  it("bounds direct, ZIP and per-check output", async () => {
    await expect(extractReportAttachment("a.csv", Buffer.alloc(MAX_ATTACHMENT_BYTES + 1), MAX_CHECK_BYTES)).rejects.toThrow();
    await expect(extractReportAttachment("a.csv", Buffer.alloc(2), 1)).rejects.toThrow();
    await expect(extractReportAttachment("a.zip", zip([{ name: "a.csv", bytes: Buffer.alloc(2) }]), 1)).rejects.toThrow();
    await expect(extractReportAttachment("a.csv", Buffer.alloc(1), -1)).rejects.toThrow();
  });

  it("reports actual ZIP expansion on success and on later archive rejection", async () => {
    let consumed = 0;
    const charge = (size: number) => { consumed += size; };
    const bytes = Buffer.from("a,b\n1,2\n");
    await extractReportAttachment("a.csv", bytes, 100, charge);
    expect(consumed).toBe(0);
    await extractReportAttachment("a.zip", zip([{ name: "a.csv", bytes, compress: true }]), 100, charge);
    expect(consumed).toBe(bytes.length);
    consumed = 0;
    await expect(extractReportAttachment("a.zip", zip([{ name: "a.csv", bytes, compress: true }, { name: "../bad.csv", bytes }]), 100, charge)).rejects.toThrow();
    expect(consumed).toBe(bytes.length);
    consumed = 0;
    await expect(extractReportAttachment("a.zip", zip([{ name: "a.csv", bytes, compress: true, declaredSize: 1 }]), 100, charge)).rejects.toThrow();
    expect(consumed).toBe(bytes.length);
  });

  it("distinguishes remaining-check exhaustion so a valid attachment can retry", async () => {
    await expect(extractReportAttachment("a.csv", Buffer.alloc(2), 1)).rejects.toBeInstanceOf(ReportCheckBudgetError);
    let consumed = 0;
    const bytes = Buffer.from("a,b\n1,2\n");
    await expect(extractReportAttachment("a.zip", zip([{ name: "a.csv", bytes }, { name: "b.csv", bytes }]), bytes.length, (size) => { consumed += size; })).rejects.toBeInstanceOf(ReportCheckBudgetError);
    expect(consumed).toBe(bytes.length);
  });

  it("isolates mailboxes, replaces stable names and keeps same-day messages separately", async () => {
    const folder = await root();
    const file = { name: "sales.csv", bytes: Buffer.from("old") };
    const first = await saveReportFile(folder, "mailbox-a", "message-1", "2026-10-03T12:00:00Z", file, true);
    expect(first).toBe("email/mailbox-a/sales.csv");
    await saveReportFile(folder, "mailbox-a", "message-2", "2026-10-03T13:00:00Z", { ...file, bytes: Buffer.from("new") }, true);
    expect(await fs.readFile(path.join(folder, first), "utf8")).toBe("new");
    const second = await saveReportFile(folder, "mailbox-b", "message-1", "2026-10-03T12:00:00Z", file, true);
    expect(second).not.toBe(first);
    const kept = await saveReportFile(folder, "mailbox-a", "message-1", "2026-10-03T12:00:00Z", file, false);
    expect(kept).toContain("2026-10-03");
    expect(await saveReportFile(folder, "mailbox-a", "message-1", "2026-10-03T12:00:00Z", file, false)).toBe(kept);
    expect(await saveReportFile(folder, "mailbox-a", "message-2", "2026-10-03T13:00:00Z", file, false)).not.toBe(kept);
  });

  it("rejects symlinked email, mailbox and target paths without outside writes", async () => {
    const folder = await root();
    const outside = await root();
    const file = { name: "a.csv", bytes: Buffer.from("new") };
    await fs.symlink(outside, path.join(folder, "email"));
    await expect(saveReportFile(folder, "box", "msg", "2026-10-03", file, true)).rejects.toThrow();
    await fs.unlink(path.join(folder, "email"));
    await fs.mkdir(path.join(folder, "email"));
    await fs.symlink(outside, path.join(folder, "email", "box"));
    await expect(saveReportFile(folder, "box", "msg", "2026-10-03", file, true)).rejects.toThrow();
    await fs.unlink(path.join(folder, "email", "box"));
    await fs.mkdir(path.join(folder, "email", "box"));
    await fs.writeFile(path.join(outside, "secret.csv"), "original");
    await fs.symlink(path.join(outside, "secret.csv"), path.join(folder, "email", "box", "a.csv"));
    await expect(saveReportFile(folder, "box", "msg", "2026-10-03", file, true)).rejects.toThrow();
    expect(await fs.readFile(path.join(outside, "secret.csv"), "utf8")).toBe("original");
    expect(await fs.readdir(outside)).toEqual(["secret.csv"]);
  });

  it("rejects unsafe mailbox IDs, dates, and non-data output before creating folders", async () => {
    const folder = await root();
    await expect(saveReportFile(folder, "../box", "msg", "2026-10-03", { name: "a.csv", bytes: Buffer.from("x") }, true)).rejects.toThrow();
    await expect(saveReportFile(folder, "box", "msg", "not-a-date", { name: "a.csv", bytes: Buffer.from("x") }, false)).rejects.toThrow();
    await expect(saveReportFile(folder, "box", "msg", "2026-10-03", { name: "a.zip", bytes: Buffer.from("x") }, true)).rejects.toThrow();
    expect(await fs.readdir(folder)).toEqual([]);
  });

  it("atomic replacement does not write through a hard-linked target or leave staging files", async () => {
    const folder = await root();
    const outside = await root();
    await fs.mkdir(path.join(folder, "email", "box"), { recursive: true });
    await fs.writeFile(path.join(outside, "original.csv"), "original");
    await fs.link(path.join(outside, "original.csv"), path.join(folder, "email", "box", "a.csv"));
    await saveReportFile(folder, "box", "m", "2026-10-03", { name: "a.csv", bytes: Buffer.from("new") }, true);
    expect(await fs.readFile(path.join(outside, "original.csv"), "utf8")).toBe("original");
    expect(await fs.readdir(path.join(folder, "email", "box"))).toEqual(["a.csv"]);
    expect((await fs.readdir(path.join(folder, "email", "box"))).some((name) => name.endsWith(".partial"))).toBe(false);
  });

  it("leaves version ordering to the service without persistent filesystem version state", async () => {
    const folder = await root();
    const file = { name: "sales.csv", bytes: Buffer.from("new") };
    const saved = await saveReportFile(folder, "box", "new", "2026-10-03T14:00:00Z", file, true);
    expect(await saveReportFile(folder, "box", "old", "2026-10-03T12:00:00Z", { ...file, bytes: Buffer.from("old") }, true)).toBe(saved);
    expect(await fs.readFile(path.join(folder, saved), "utf8")).toBe("old");
    expect(await fs.readdir(path.join(folder, "email", "box"))).toEqual(["sales.csv"]);
  });

  it("lets the service choose between different messages with the same receipt time", async () => {
    const folder = await root();
    const ids = ["m1", "m2"].sort((a, b) => createHash("sha256").update(b).digest("hex").localeCompare(createHash("sha256").update(a).digest("hex")));
    const file = { name: "sales.csv", bytes: Buffer.from("old") };
    const saved = await saveReportFile(folder, "box", ids[0], "2026-10-03", file, true);
    await saveReportFile(folder, "box", ids[1], "2026-10-03", { ...file, bytes: Buffer.from("new") }, true);
    expect(await fs.readFile(path.join(folder, saved), "utf8")).toBe("new");
  });

  it("preserves the previous report when atomic replacement fails and permits retry", async () => {
    const folder = await root();
    const file = { name: "sales.csv", bytes: Buffer.from("old") };
    const saved = await saveReportFile(folder, "box", "old", "2026-10-03T12:00:00Z", file, true);
    const originalRename = fs.rename.bind(fs);
    const rename = vi.spyOn(fs, "rename").mockImplementation(async (oldPath, newPath) => {
      if (String(newPath).endsWith("/sales.csv")) throw new Error("simulated crash before data rename");
      await originalRename(oldPath, newPath);
    });
    await expect(saveReportFile(folder, "box", "new", "2026-10-03T14:00:00Z", { ...file, bytes: Buffer.from("new") }, true)).rejects.toThrow();
    rename.mockRestore();
    expect(await fs.readFile(path.join(folder, saved), "utf8")).toBe("old");
    expect(await fs.readdir(path.join(folder, "email", "box"))).toEqual(["sales.csv"]);
    await saveReportFile(folder, "box", "new", "2026-10-03T14:00:00Z", { ...file, bytes: Buffer.from("new") }, true);
    expect(await fs.readFile(path.join(folder, saved), "utf8")).toBe("new");
  });

  it("saves and atomically replaces on the Windows branch without opening directories", async () => {
    const folder = await root();
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    const open = fs.open.bind(fs);
    const opened = vi.spyOn(fs, "open").mockImplementation(async (filename, flags, mode) => {
      if (typeof flags === "number" && (flags & constants.O_DIRECTORY)) throw new Error("Windows directory open is not supported");
      return open(filename, flags, mode);
    });
    try {
      Object.defineProperty(process, "platform", { ...platform, value: "win32" });
      const file = { name: "sales.csv", bytes: Buffer.from("old") };
      const saved = await saveReportFile(folder, "box", "m1", "2026-10-03", file, true);
      await saveReportFile(folder, "box", "m2", "2026-10-04", { ...file, bytes: Buffer.from("new") }, true);
      expect(await fs.readFile(path.join(folder, saved), "utf8")).toBe("new");
      expect(opened.mock.calls.every(([, flags]) => typeof flags !== "number" || !(flags & constants.O_DIRECTORY))).toBe(true);
    } finally {
      Object.defineProperty(process, "platform", platform);
      opened.mockRestore();
    }
  });

  it("rejects a parent junction changed to redirect a Windows-path write", async () => {
    const folder = await root();
    const outside = await root();
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    const realpath = fs.realpath.bind(fs);
    vi.spyOn(fs, "realpath").mockImplementation(async (filename, options) => {
      if (String(filename).endsWith(`${path.sep}email${path.sep}box`)) return outside;
      return realpath(filename, options);
    });
    try {
      Object.defineProperty(process, "platform", { ...platform, value: "win32" });
      await expect(saveReportFile(folder, "box", "m", "2026-10-03", { name: "a.csv", bytes: Buffer.from("x") }, true)).rejects.toThrow();
      expect(await fs.readdir(outside)).toEqual([]);
    } finally { Object.defineProperty(process, "platform", platform); }
  });
});
