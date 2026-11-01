import { describe, expect, it } from "vitest";
import { baseName, parseCameraFileName, sniffMedia, stampToLocal } from "@/lib/security-cameras/file-names";

/*
 * Reolink upload names (#508, decision 1217). The examples are the shapes
 * reported by Reolink users (see docs/FARM-SECURITY.md); the camera names
 * are made up. Not checked against a real Go PT Plus.
 */
describe("Reolink file names", () => {
  it("reads device, channel and camera time from device_channel_stamp.ext", () => {
    expect(parseCameraFileName("K3TA_00_20220307125142.mp4")).toEqual({ cameraLocalTime: "2022-03-07T12:51:42", pattern: "reolink", deviceName: "K3TA", channel: "00", extensionKind: "clip" });
    expect(parseCameraFileName("K3TA_00_20220307125217.jpg")).toMatchObject({ cameraLocalTime: "2022-03-07T12:52:17", extensionKind: "snapshot" });
    expect(parseCameraFileName("NVR_01_20251002011659.mp4")).toMatchObject({ deviceName: "NVR", channel: "01" });
  });

  it("keeps underscores and spaces in the camera's name", () => {
    expect(parseCameraFileName("Front gate_cam_2_00_20261101063015.jpg")).toMatchObject({ deviceName: "Front gate_cam_2", channel: "00", cameraLocalTime: "2026-11-01T06:30:15" });
  });

  it("uses only the file's own name, whatever folders the camera made", () => {
    expect(parseCameraFileName("farm/cam1/2026/11/01/Gate_00_20261101063015.JPG")).toMatchObject({ pattern: "reolink", deviceName: "Gate", extensionKind: "snapshot" });
    expect(parseCameraFileName("..\\..\\Gate_00_20261101063015.jpg")).toMatchObject({ deviceName: "Gate" });
    expect(baseName("/a/b/")).toBe("b");
  });

  it("falls back to any 14-digit date and time, then to none", () => {
    expect(parseCameraFileName("Rec_20261101063015.mp4")).toMatchObject({ pattern: "stamp", cameraLocalTime: "2026-11-01T06:30:15", deviceName: null });
    expect(parseCameraFileName("snapshot.jpg")).toEqual({ cameraLocalTime: null, pattern: "none", deviceName: null, channel: null, extensionKind: "snapshot" });
  });

  it("refuses dates that don't exist rather than guessing", () => {
    expect(stampToLocal("20260230120000")).toBeNull();
    expect(stampToLocal("20261301120000")).toBeNull();
    expect(stampToLocal("20261101246000")).toBeNull();
    expect(stampToLocal("19991231235959")).toBeNull();
    expect(stampToLocal("20240229000000")).toBe("2024-02-29T00:00:00");
    expect(parseCameraFileName("Gate_00_20260230120000.jpg").cameraLocalTime).toBeNull();
  });
});

describe("what a file really is", () => {
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
  const mp4 = Uint8Array.from([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);

  it("knows a JPEG and an MP4 by their first bytes", () => {
    expect(sniffMedia(jpeg)).toEqual({ kind: "snapshot", contentType: "image/jpeg", extension: "jpg" });
    expect(sniffMedia(mp4)).toEqual({ kind: "clip", contentType: "video/mp4", extension: "mp4" });
  });

  it("refuses everything else, whatever the name says", () => {
    expect(sniffMedia(new TextEncoder().encode("<html><script>"))).toBeNull();
    expect(sniffMedia(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]))).toBeNull(); // PNG
    expect(sniffMedia(Uint8Array.from([0xff, 0xd8]))).toBeNull();
    // "ftyp" with an impossible box size.
    expect(sniffMedia(Uint8Array.from([0, 0, 0, 4, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]))).toBeNull();
    expect(sniffMedia(new Uint8Array())).toBeNull();
  });
});
