import { afterEach, describe, expect, it } from "vitest";
import { exifDegrees, exifTime, nativePhoto, photoFacts } from "@/lib/native/camera";

/*
 * Photos from the Android app's camera and picker (#502, decision 1149):
 * when they were taken and, if the camera wrote it, where, read from what
 * the camera plugin hands back. Made-up positions.
 */

describe("photoFacts", () => {
  it("reads the camera's time and GPS from Android's EXIF", () => {
    const exif = JSON.stringify({ DateTimeOriginal: "2026:10:30 14:05:09", OffsetTimeOriginal: "+13:00", GPSLatitude: "45/1,52/1,2850/100", GPSLatitudeRef: "S", GPSLongitude: "170/1,30/1,0/1", GPSLongitudeRef: "E", GPSHPositioningError: "6.4" });
    const facts = photoFacts({ format: "jpeg", exif });
    expect(new Date(facts.takenAt!).toISOString()).toBe("2026-10-30T01:05:09.000Z");
    expect(facts.place).toEqual({ latitude: -(45 + 52 / 60 + 28.5 / 3600), longitude: 170.5, accuracyM: 6, at: "2026-10-30T01:05:09.000Z" });
  });

  it("falls back to the file's creation date, and has no place without GPS", () => {
    expect(photoFacts({ format: "jpg", creationDate: "2026-10-30T01:00:00Z", exif: "{}" })).toEqual({ takenAt: Date.parse("2026-10-30T01:00:00Z"), place: null });
    expect(photoFacts(undefined)).toEqual({ takenAt: null, place: null });
    expect(photoFacts({ format: "jpg", exif: "not json" })).toEqual({ takenAt: null, place: null });
    // 0,0 is a camera with no fix, not the Gulf of Guinea.
    expect(photoFacts({ format: "jpg", exif: { GPSLatitude: "0/1,0/1,0/1", GPSLongitude: "0/1,0/1,0/1" } }).place).toBeNull();
  });

  it("reads degrees written several ways", () => {
    expect(exifDegrees("45/1,30/1,0/1")).toBe(45.5);
    expect(exifDegrees("45,30,0")).toBe(45.5);
    expect(exifDegrees([45, 30, 36])).toBeCloseTo(45.51);
    expect(exifDegrees(-45.25)).toBe(-45.25);
    expect(exifDegrees("abc")).toBeNull();
    expect(exifDegrees("1,2,3,4")).toBeNull();
    expect(exifTime("2026:10:30 14:05:09")).toBe(new Date(2026, 9, 30, 14, 5, 9).getTime());
    expect(exifTime("yesterday")).toBeNull();
  });
});

describe("nativePhoto", () => {
  const original = (globalThis as { window?: unknown }).window;
  afterEach(() => {
    (globalThis as { window?: unknown }).window = original;
  });
  const withCamera = (camera: Record<string, unknown>) => {
    (globalThis as { window?: unknown }).window = { Capacitor: { isNativePlatform: () => true, getPlatform: () => "android", Plugins: { Camera: camera }, PluginHeaders: [{ name: "Camera" }] } };
  };
  const photoFetch = (async () => new Response(new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: "image/jpeg" }))) as unknown as typeof fetch;

  it("hands back a file timed when the photo was taken, at the size the web app keeps", async () => {
    let asked: Record<string, unknown> | null = null;
    withCamera({
      takePhoto: async (options: Record<string, unknown>) => {
        asked = options;
        return { webPath: "https://tohyee.example.nz/_capacitor_file_/photo.jpg", metadata: { format: "jpeg", exif: JSON.stringify({ DateTimeOriginal: "2026:10:30 14:05:09", OffsetTimeOriginal: "+13:00" }) } };
      },
    });
    const photo = await nativePhoto("camera", photoFetch);
    expect(asked).toMatchObject({ targetWidth: 1600, targetHeight: 1600, includeMetadata: true, saveToGallery: false });
    expect(photo!.file.type).toBe("image/jpeg");
    expect(photo!.file.lastModified).toBe(Date.parse("2026-10-30T01:05:09Z"));
    expect(photo!.file.name).toBe("photo-20261030-010509.jpg");
  });

  it("is null when the person cancels, and says why when the camera isn't allowed", async () => {
    withCamera({ chooseFromGallery: async () => { throw new Error("User cancelled photos app"); }, takePhoto: async () => { throw new Error("Camera permission denied"); } });
    expect(await nativePhoto("gallery", photoFetch)).toBeNull();
    await expect(nativePhoto("camera", photoFetch)).rejects.toThrow(/isn't allowed to use the camera/);
  });
});
