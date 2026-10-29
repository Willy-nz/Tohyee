import { describe, expect, it } from "vitest";
import {
  accuracyText,
  AVATAR_COLOURS,
  avatarColour,
  initialsOf,
  isPrecise,
  positionLabel,
  positionState,
  shareHours,
  timeAgo,
} from "@/lib/farming/locations-shared";

/** Farm members on the map (#498 item 7, decisions 1129-1130): how old a position may be before it's not live. */
describe("shared location staleness", () => {
  const now = new Date("2026-10-30T02:00:00.000Z");
  const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();

  it("is recent up to 5 minutes, then last known, and unavailable with no position", () => {
    expect(positionState({ at: ago(0) }, now)).toBe("recent");
    expect(positionState({ at: ago(5) }, now)).toBe("recent");
    expect(positionState({ at: ago(5.1) }, now)).toBe("stale");
    expect(positionState({ at: ago(300) }, now)).toBe("stale");
    expect(positionState(null, now)).toBe("unavailable");
    expect(positionState({ at: "not a time" }, now)).toBe("unavailable");
  });

  it("never says an old position is live", () => {
    const position = (minutes: number) => ({ latitude: -45.9, longitude: 170.5, accuracyMetres: 8, at: ago(minutes) });
    expect(positionLabel(position(2), now, false)).toBe("Updated 2 min ago");
    expect(positionLabel(position(12), now, false)).toBe("Last known 12 min ago (not live)");
    expect(positionLabel(null, now, false)).toBe("No position yet");
  });

  it("marks everything not live while the viewer is offline, however new", () => {
    const fresh = { latitude: -45.9, longitude: 170.5, accuracyMetres: 8, at: ago(0) };
    expect(positionLabel(fresh, now, true)).toBe("Last known just now (not live: you're offline)");
    expect(positionLabel(null, now, true)).toBe("No position (you're offline)");
  });

  it("words ages plainly, and a clock a little ahead is just now", () => {
    expect(timeAgo(ago(0.5), now)).toBe("just now");
    expect(timeAgo(ago(-1), now)).toBe("just now");
    expect(timeAgo(ago(1), now)).toBe("1 min ago");
    expect(timeAgo(ago(59), now)).toBe("59 min ago");
    expect(timeAgo(ago(60), now)).toBe("1 h ago");
    expect(timeAgo(ago(125), now)).toBe("2 h 5 min ago");
  });

  it("shows a rough fix as an area, not a precise dot", () => {
    expect(isPrecise(8)).toBe(true);
    expect(isPrecise(100)).toBe(true);
    expect(isPrecise(101)).toBe(false);
    expect(accuracyText(7.6)).toBe("about 8 m");
    expect(accuracyText(450)).toBe("about 450 m");
    expect(accuracyText(1500)).toBe("about 1.5 km");
  });
});

describe("sharing choices and avatars", () => {
  it("shares for 1 to 12 whole hours, 4 when not chosen", () => {
    expect(shareHours(undefined)).toBe(4);
    expect(shareHours(1)).toBe(1);
    expect(shareHours("12")).toBe(12);
    expect(shareHours(13)).toBeNull();
    expect(shareHours(0)).toBeNull();
    expect(shareHours(2.5)).toBeNull();
    expect(shareHours("forever")).toBeNull();
  });

  it("makes initials from a name or an email", () => {
    expect(initialsOf("Mere Tane")).toBe("MT");
    expect(initialsOf("Aroha Ngaio Smith")).toBe("AS");
    expect(initialsOf("rangi")).toBe("R");
    expect(initialsOf("jess.kelly@example.com")).toBe("JK");
    expect(initialsOf("")).toBe("?");
  });

  it("gives each person the same colour every time", () => {
    const id = "6f1c1b0e-2a1d-4c5e-9a7b-0d3e5f6a7b8c";
    expect(avatarColour(id)).toBe(avatarColour(id));
    expect(AVATAR_COLOURS).toContain(avatarColour(id));
  });
});
