import { describe, expect, it } from "vitest";
import { photoTakenAt } from "@/lib/safety/photo-date";

/** A small JPEG start with an EXIF block holding DateTimeOriginal (and its offset), little- or big-endian. */
function jpegWithExif(date: string, offset: string | null, little = true): Uint8Array {
  const tiff: number[] = [];
  const u16 = (value: number) => (little ? [value & 0xff, value >> 8] : [value >> 8, value & 0xff]);
  const u32 = (value: number) => (little ? [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, value >>> 24] : [value >>> 24, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]);
  const entries = offset ? 2 : 1;
  const exifIfd = 26;
  const dateAt = exifIfd + 2 + entries * 12 + 4;
  const offsetAt = dateAt + date.length + 1;
  tiff.push(...(little ? [0x49, 0x49] : [0x4d, 0x4d]), ...u16(42), ...u32(8));
  tiff.push(...u16(1), ...u16(0x8769), ...u16(4), ...u32(1), ...u32(exifIfd), ...u32(0));
  tiff.push(...u16(entries), ...u16(0x9003), ...u16(2), ...u32(date.length + 1), ...u32(dateAt));
  if (offset) tiff.push(...u16(0x9011), ...u16(2), ...u32(offset.length + 1), ...u32(offsetAt));
  tiff.push(...u32(0), ...[...date].map((c) => c.charCodeAt(0)), 0);
  if (offset) tiff.push(...[...offset].map((c) => c.charCodeAt(0)), 0);
  const app1 = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe1, (app1.length + 2) >> 8, (app1.length + 2) & 0xff, ...app1, 0xff, 0xda, 0, 2]);
}

describe("a photo's own date (#446, decision 945)", () => {
  it("reads the camera's date and offset", () => {
    expect(photoTakenAt(jpegWithExif("2026:10:27 14:03:11", "+13:00"))).toBe("2026-10-27 14:03:11 +13:00");
    expect(photoTakenAt(jpegWithExif("2026:10:27 14:03:11", null, false))).toBe("2026-10-27 14:03:11");
  });

  it("gives nothing for a photo without one, or something that isn't a JPEG", () => {
    expect(photoTakenAt(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2]))).toBeNull();
    expect(photoTakenAt(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
    expect(photoTakenAt(jpegWithExif("not a date at all!!", null))).toBeNull();
    // Cut short part-way through: no error, just nothing.
    expect(photoTakenAt(jpegWithExif("2026:10:27 14:03:11", "+13:00").subarray(0, 30))).toBeNull();
  });
});
