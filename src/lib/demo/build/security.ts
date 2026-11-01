import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DemoContext } from "@/lib/demo/build/context";
import { addCamera, setFarmRetention } from "@/lib/security-cameras/cameras";
import { type MediaKind, sniffMedia } from "@/lib/security-cameras/file-names";
import { ingestUpload } from "@/lib/security-cameras/ingest";
import { keepEvent } from "@/lib/security-cameras/events";
import { incomingFolder } from "@/lib/security-cameras/storage";

/*
 * Security cameras on the demo farm (#508, decision 1225): three made-up
 * cameras, photos drawn by Tohyee (coloured panels saying "Made-up demo
 * photo", not real photos) and a three-second made-up clip (a moving block
 * on green, made with ffmpeg's colour source), taken in through the same
 * code as a camera's upload. The runoff's camera has been quiet for four
 * days, so the gap shows. No upload logins: the demo farm takes no uploads.
 * Skipped (with the rest of the demo farm made) if the server can't draw
 * the photos.
 */

/** The made-up clip: 320x180, 3 seconds, H.264, 2.8 KB. */
const DEMO_CLIP_BASE64 = [
  "AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAOebW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAC7gAAQAAAQAAAAAAAAAAAAAAAAEAAAAA",
  "AAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAsh0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAAB",
  "AAAAAAAAC7gAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAUAAAAC0AAAAAAAkZWR0cwAAABxlbHN0AAAAAAAA",
  "AAEAAAu4AAAAAAABAAAAAAJAbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAAoAAAAeABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRl",
  "b0hhbmRsZXIAAAAB621pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAatzdGJsAAAAu3N0c2QA",
  "AAAAAAAAAQAAAKthdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAUAAtABIAAAASAAAAAAAAAABFUxhdmM2MC4zMS4xMDIgbGlieDI2NAAAAAAAAAAAAAAA",
  "GP//AAAAMWF2Y0MBQsAL/+EAGWdCwAvZAUGfnwEQAAADABAAAAMBQPFCpIABAAVoy4CUsgAAABBwYXNwAAAAAQAAAAEAAAAUYnRydAAAAAAAABPQAAAT0AAA",
  "ABhzdHRzAAAAAAAAAAEAAAAeAAAEAAAAABRzdHNzAAAAAAAAAAEAAAABAAAAHHN0c2MAAAAAAAAAAQAAAAEAAAAeAAAAAQAAAIxzdHN6AAAAAAAAAAAAAAAe",
  "AAAGRwAAAA4AAAALAAAACgAAAAoAAAAKAAAACgAAAAoAAAAKAAAACgAAAAoAAAAKAAAACgAAAAoAAAAKAAAACgAAAAoAAAAKAAAACgAAAAoAAAAKAAAACgAA",
  "AAoAAAAKAAAACgAAAAoAAAAKAAAACgAAAAoAAAAKAAAAFHN0Y28AAAAAAAAAAQAAA84AAABidWR0YQAAAFptZXRhAAAAAAAAACFoZGxyAAAAAAAAAABtZGly",
  "YXBwbAAAAAAAAAAAAAAAAC1pbHN0AAAAJal0b28AAAAdZGF0YQAAAAEAAAAATGF2ZjYwLjE2LjEwMAAAAAhmcmVlAAAHdm1kYXQAAAJxBgX//23cRem95tlI",
  "t5Ys2CDZI+7veDI2NCAtIGNvcmUgMTY0IHIzMTA4IDMxZTE5ZjkgLSBILjI2NC9NUEVHLTQgQVZDIGNvZGVjIC0gQ29weWxlZnQgMjAwMy0yMDIzIC0gaHR0",
  "cDovL3d3dy52aWRlb2xhbi5vcmcveDI2NC5odG1sIC0gb3B0aW9uczogY2FiYWM9MCByZWY9MyBkZWJsb2NrPTE6MDowIGFuYWx5c2U9MHgxOjB4MTExIG1l",
  "PWhleCBzdWJtZT03IHBzeT0xIHBzeV9yZD0xLjAwOjAuMDAgbWl4ZWRfcmVmPTEgbWVfcmFuZ2U9MTYgY2hyb21hX21lPTEgdHJlbGxpcz0xIDh4OGRjdD0w",
  "IGNxbT0wIGRlYWR6b25lPTIxLDExIGZhc3RfcHNraXA9MSBjaHJvbWFfcXBfb2Zmc2V0PS0yIHRocmVhZHM9MyBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNl",
  "ZF90aHJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9MCBibHVyYXlfY29tcGF0PTAgY29uc3RyYWluZWRfaW50cmE9MCBiZnJhbWVzPTAgd2Vp",
  "Z2h0cD0wIGtleWludD0yNTAga2V5aW50X21pbj0xMCBzY2VuZWN1dD00MCBpbnRyYV9yZWZyZXNoPTAgcmNfbG9va2FoZWFkPTQwIHJjPWNyZiBtYnRyZWU9",
  "MSBjcmY9MzUuMCBxY29tcD0wLjYwIHFwbWluPTAgcXBtYXg9NjkgcXBzdGVwPTQgaXBfcmF0aW89MS40MCBhcT0xOjEuMDAAgAAAA85liIQ///3BIKYoAPgI",
  "9ujwMpV44U1Z3ooTIFeRxjg//gxwWFfgCrQRymrVhTGHro955seuv/vG1wBUUVgMYz+X/14hCvBia9+r0Y4s7oTQBGmN2atQWpEzVp/A0x/8OGCQvwAubWLC",
  "+pegqHvJdP30//9eMK8AMN6JmtXgk5GibT673Br6FnQ6mPV4OOsKlgbHf/r8K8Qo5Wb/Zj81hxun4AMC3oWVUH/xDDCpIAVxM2PMy8JUFSw3BD5927vjI4o7",
  "sPhgqMdrT+d/8x1GFe11ujwGL9XLOLf9hrttGT9foVSfHJ/c/+nXCpfwAcPNLYHkov2Yj+kmm///qEK+ADY80tgeSs/QAa+hZ8fmPV4MVb9K6GVP/cADBYVi",
  "umEjrH/4FIWtCVIUvv/Cr9Auf9fYI6PL4Xfe4JO1Pk/6fJCsnJycnJycnJ/2/AOCMLQOmABSxdEYJNMfGgRvDDzEBVBPl5N/iAW3XrRQ74RLxtGqZaXUjEGR",
  "A5T4Ga0+aMzJ1FEAPS99jLdjdgR63HhwlmugOZr11ZoOTR8XrPb233+O3OifibxphjwMZFLb5fBiNqOIMP/C3NgknkzTX030aEuYU7vJ6z2jsW8K4vA4NBLH",
  "NtRdkT9pbHon+GE0Y81pPfqBD24BFzokejfuCu+AY63zeSDXDBHTx7bqLWoI/sTPAAPzEm6NCeAxnIGaPdEr3uOv/KnlnXeEt3u0YeAAb/3lamH8Lb4ABXjA",
  "1fGRKA4NxBPyrqUXkSmZezvfPfT3L7mz09pr/9gTKu/t9IqOEhwDAOEtZYLXfg/4sNdrFa3Y6lyiAAIyw4PEIXUz9iNAb/wtAnAAy3rjKqCBcxnYRp389E9t",
  "E4274ey6H9f/C0n9fre2zImsPDYWgGLJNP0pVBAoYyboIuaLOe+0Wzmmk98sqzYcSvnekX6CwYCOl75zBVQAHbuiWhrHfdwNmNFg1E97qx22+V7oBI/THXwA",
  "AD/+qYb9dddddddddLS0tLXXXS10tdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddf/8fgtC2",
  "ByAwjLKjLCuWS5eFmWTMtr/+PDBVXCuX4WZemF66666666666666665nLADHAAY4bWZgq6pgrrrrrrrrrrrrrrrrrwiGAf8FYYwdAiMNNQY8LMsmZfhXLJcv",
  "2vjD/8FWeFmX8K5f0wzXXXXXXXXXXXXXXXXa2trXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXgAAAApBmjh+AnToMwKkAAAAB0GaVB+A8YAAAAAG",
  "QZpg/AeMAAAABkGagPwHjAAAAAZBmqD8B4wAAAAGQZrA/AeMAAAABkGa4PwHjAAAAAZBmwD8B4wAAAAGQZsg/AeMAAAABkGbQLwHjAAAAAZBm2C8B4wAAAAG",
  "QZuAvAeMAAAABkGboLwHjAAAAAZBm8C8B4wAAAAGQZvgvAeMAAAABkGaAfAeMAAAAAZBmiHwHjAAAAAGQZpB8B4wAAAABkGaYfAeMAAAAAZBmoPAeMAAAAAG",
  "QZqjwHjAAAAABkGaw8B4wAAAAAZBmuFwHjAAAAAGQZsBcB4wAAAABkGbIJwHjAAAAAZBm0CcB4wAAAAGQZtg3AeMAAAABkGbgEcB4wAAAAZBm6BnAeM=",
].join("");

function cameraStamp(instant: Date): string {
  const parts = new Intl.DateTimeFormat("en-NZ", { timeZone: "Pacific/Auckland", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(instant);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${get("year")}${get("month")}${get("day")}${get("hour")}${get("minute")}${get("second")}`;
}

async function demoPhoto(label: string, colour: string): Promise<Buffer | null> {
  try {
    const sharp = (await import("sharp")).default;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="${colour}"/><rect x="0" y="250" width="640" height="110" fill="#5b7b4a"/><text x="24" y="48" font-family="sans-serif" font-size="28" fill="#fff">Made-up demo photo</text><text x="24" y="88" font-family="sans-serif" font-size="22" fill="#fff">${label}</text></svg>`;
    return await sharp(Buffer.from(svg)).jpeg({ quality: 70 }).toBuffer();
  } catch {
    return null;
  }
}

async function receive(ctx: DemoContext, cameraId: string, cameraName: string, bytes: Buffer, receivedAt: Date): Promise<string | null> {
  const media = sniffMedia(bytes.subarray(0, 12)) as MediaKind;
  const folder = incomingFolder();
  await mkdir(folder, { recursive: true });
  const tempPath = path.join(folder, `${randomUUID()}.part`);
  await writeFile(tempPath, bytes);
  const name = `${cameraName.replace(/\s+/g, "")}_00_${cameraStamp(new Date(receivedAt.getTime() - 20_000))}.${media.extension}`;
  const result = await ingestUpload({ organisation: ctx.organisation, cameraId, cameraName }, { name, tempPath, sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), media, receivedAt });
  return result.eventId;
}

export async function farmSecurity(ctx: DemoContext, now = new Date()): Promise<void> {
  const colours = ["#6f8fa8", "#8a7a5c", "#5f7f8f", "#7d6f8f", "#8f6f6f", "#6f8f7a"];
  const photos: Buffer[] = [];
  for (const [index, colour] of colours.entries()) {
    const photo = await demoPhoto(`Picture ${index + 1}`, colour);
    if (!photo) return;
    photos.push(photo);
  }
  const clip = Buffer.from(DEMO_CLIP_BASE64, "base64");
  const home = ctx.id("farm:home");
  const runoff = ctx.id("farm:runoff");
  const cameras = await ctx.as(async (tx) => {
    const gate = await addCamera(tx, { farmId: home, name: "Front gate", model: "Reolink Go PT Plus", notes: "Made up. On the strainer post by the cattle stop.", timeZone: "Pacific/Auckland" });
    const shed = await addCamera(tx, { farmId: home, name: "Calf shed", model: "Reolink Go PT Plus", timeZone: "Pacific/Auckland" });
    const runoffGate = await addCamera(tx, { farmId: runoff, name: "Runoff gate", model: "Reolink Go PT Plus", timeZone: "Pacific/Auckland" });
    await setFarmRetention(tx, home, 30);
    return { gate, shed, runoffGate };
  });
  const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000);
  // The gate: photos and clips over the last two days; one kept as an incident.
  const kept = await receive(ctx, cameras.gate.id, "Front gate", photos[0], hoursAgo(30));
  await receive(ctx, cameras.gate.id, "Front gate", clip, hoursAgo(29.99));
  await receive(ctx, cameras.gate.id, "Front gate", photos[1], hoursAgo(9));
  await receive(ctx, cameras.gate.id, "Front gate", photos[2], hoursAgo(2));
  // The calf shed: photos only.
  await receive(ctx, cameras.shed.id, "Calf shed", photos[3], hoursAgo(20));
  await receive(ctx, cameras.shed.id, "Calf shed", photos[4], hoursAgo(5));
  // The runoff gate: nothing for four days.
  await receive(ctx, cameras.runoffGate.id, "Runoff gate", photos[5], hoursAgo(98));
  if (kept) await ctx.as((tx) => keepEvent(tx, kept, "Made up: a ute we didn't know at the gate."));
}
