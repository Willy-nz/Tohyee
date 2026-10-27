/**
 * The date a camera wrote into a JPEG photo (EXIF DateTimeOriginal, with its
 * time-zone offset when the camera wrote one), as "YYYY-MM-DD HH:MM:SS" or
 * "YYYY-MM-DD HH:MM:SS +13:00" (#446, decision 945). Kept beside the photo
 * exactly as found, never used as the entry time: a phone's clock can be
 * wrong, and the date can be edited before a photo is sent. Null when
 * there's none or it can't be read.
 */
export function photoTakenAt(bytes: Uint8Array): string | null {
  try {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
    let at = 2;
    while (at + 4 <= bytes.length) {
      if (bytes[at] !== 0xff) return null;
      const marker = bytes[at + 1];
      if (marker === 0xda || marker === 0xd9) return null;
      const length = (bytes[at + 2] << 8) | bytes[at + 3];
      if (length < 2) return null;
      if (marker === 0xe1 && at + 10 <= bytes.length && String.fromCharCode(...bytes.subarray(at + 4, at + 8)) === "Exif") {
        return readExif(bytes.subarray(at + 10, Math.min(bytes.length, at + 2 + length)));
      }
      at += 2 + length;
    }
    return null;
  } catch {
    return null;
  }
}

function readExif(tiff: Uint8Array): string | null {
  if (tiff.length < 8) return null;
  const little = tiff[0] === 0x49 && tiff[1] === 0x49;
  if (!little && !(tiff[0] === 0x4d && tiff[1] === 0x4d)) return null;
  const u16 = (offset: number) => (little ? tiff[offset] | (tiff[offset + 1] << 8) : (tiff[offset] << 8) | tiff[offset + 1]);
  const u32 = (offset: number) => (little ? (tiff[offset] | (tiff[offset + 1] << 8) | (tiff[offset + 2] << 16)) + tiff[offset + 3] * 0x1000000 : tiff[offset] * 0x1000000 + ((tiff[offset + 1] << 16) | (tiff[offset + 2] << 8) | tiff[offset + 3]));
  const entries = (ifd: number): Map<number, number> => {
    const found = new Map<number, number>();
    if (ifd + 2 > tiff.length) return found;
    const count = u16(ifd);
    for (let index = 0; index < count; index += 1) {
      const entry = ifd + 2 + index * 12;
      if (entry + 12 > tiff.length) break;
      found.set(u16(entry), entry);
    }
    return found;
  };
  const ascii = (entry: number): string | null => {
    const type = u16(entry + 2);
    const count = u32(entry + 4);
    if (type !== 2 || count < 2 || count > 64) return null;
    const offset = count <= 4 ? entry + 8 : u32(entry + 8);
    if (offset + count > tiff.length) return null;
    return String.fromCharCode(...tiff.subarray(offset, offset + count - 1)).replace(/\0+$/, "");
  };
  const ifd0 = entries(u32(4));
  const exifPointer = ifd0.get(0x8769);
  if (exifPointer === undefined) return null;
  const exif = entries(u32(exifPointer + 8));
  const original = exif.get(0x9003);
  if (original === undefined) return null;
  const text = ascii(original);
  const match = text?.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!match) return null;
  const offsetEntry = exif.get(0x9011);
  const zone = offsetEntry === undefined ? null : ascii(offsetEntry);
  const when = `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]}:${match[6]}`;
  return zone && /^[+-]\d{2}:\d{2}$/.test(zone) ? `${when} ${zone}` : when;
}
