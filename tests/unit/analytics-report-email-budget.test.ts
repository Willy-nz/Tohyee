import { expect, it } from "vitest";
import { reportZipExpansionBytes } from "@/lib/analytics/report-emails";

function zipWithSizes(sizes: number[]): Buffer {
  const entries = sizes.map((size, index) => {
    const name = Buffer.from(`${index}.csv`);
    const entry = Buffer.alloc(46 + name.length);
    entry.writeUInt32LE(0x02014b50);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(Math.ceil(size / 10), 20);
    entry.writeUInt32LE(size, 24);
    entry.writeUInt16LE(name.length, 28);
    name.copy(entry, 46);
    return entry;
  });
  const directory = Buffer.concat(entries);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(sizes.length, 8);
  end.writeUInt16LE(sizes.length, 10);
  end.writeUInt32LE(directory.length, 12);
  return Buffer.concat([directory, end]);
}

it("reserves every ZIP entry's expansion before any extraction, including ignored files", async () => {
  expect(await reportZipExpansionBytes(zipWithSizes([1000, 2000]))).toBe(3000);
});
it("rejects excessive ZIP entries or expansion before extracting anything", async () => {
  await expect(reportZipExpansionBytes(zipWithSizes([26 * 1024 * 1024]))).rejects.toThrow();
  await expect(reportZipExpansionBytes(zipWithSizes(Array(101).fill(1)))).rejects.toThrow();
  await expect(reportZipExpansionBytes(zipWithSizes(Array(5).fill(25 * 1024 * 1024)))).rejects.toThrow();
});
