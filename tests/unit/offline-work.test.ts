import { describe, expect, it } from "vitest";
import { fitWithin, placeText } from "@/lib/offline/photos";
import { parsePhotoPlace } from "@/lib/safety/files";
import { phoneTimeOf } from "@/lib/safety/inductions";

/*
 * Offline work's small rules (#472 stage 4, decisions 1012 and 1014):
 * photo copies' size, a photo's place as the phone gave it, and the phone's
 * time for sign-ins sent later. Made-up data only.
 */

describe("photo copies", () => {
  it("fit within 1600 pixels on the longest side, never enlarged", () => {
    expect(fitWithin(4032, 3024)).toEqual({ width: 1600, height: 1200 });
    expect(fitWithin(3024, 4032)).toEqual({ width: 1200, height: 1600 });
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
  });
});

describe("a photo's place", () => {
  it("keeps what the phone gave, rounded to about 10 cm, or nothing", () => {
    expect(parsePhotoPlace({ latitude: -45.8745123456, longitude: 170.5039061234, accuracyM: 8.6, at: "2026-10-28T08:00:00+13:00" })).toEqual({ latitude: -45.874512, longitude: 170.503906, accuracyM: 9, at: "2026-10-27T19:00:00.000Z" });
    expect(parsePhotoPlace(null)).toBeNull();
    expect(parsePhotoPlace({ latitude: -45.87, longitude: 170.5 })).toEqual({ latitude: -45.87, longitude: 170.5, accuracyM: null, at: null });
    expect(() => parsePhotoPlace({ latitude: 95, longitude: 170 })).toThrow(/isn't a place/);
    expect(() => parsePhotoPlace({ latitude: -45, longitude: 170, accuracyM: -1 })).toThrow(/accuracy/);
    expect(placeText({ latitude: -45.874512, longitude: 170.503906, accuracyM: 9, at: null })).toBe("-45.874512, 170.503906 (± 9 m)");
  });
});

describe("the phone's time for a sign-in or sign-out sent later", () => {
  const now = Date.parse("2026-10-28T09:00:00Z");
  it("is kept when it's in the last 7 days and not in the future", () => {
    expect(phoneTimeOf("2026-10-28T06:30:00Z", now)).toBe("2026-10-28T06:30:00.000Z");
    expect(phoneTimeOf(undefined, now)).toBeNull();
    expect(phoneTimeOf("2026-10-28T09:04:00Z", now)).toBe("2026-10-28T09:04:00.000Z");
    expect(() => phoneTimeOf("2026-10-28T09:10:00Z", now)).toThrow(/future/);
    expect(() => phoneTimeOf("2026-10-20T09:00:00Z", now)).toThrow(/7 days/);
    expect(() => phoneTimeOf("not a time", now)).toThrow(/isn't a date/);
  });
});
