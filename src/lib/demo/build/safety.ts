import { PDFDocument, StandardFonts } from "pdf-lib";
import { addDays } from "@/lib/financial-year";
import { addHazard, saveEmergency } from "@/lib/safety/hazards";
import { addEquipment, addChecklist, recordCheck } from "@/lib/safety/equipment";
import { addInduction, changeInduction, makeSiteLink, publicSignIn, signInduction } from "@/lib/safety/inductions";
import { uploadSafetyFile } from "@/lib/safety/files";
import { safetyPeopleMap } from "@/lib/safety/people";
import { addTraining, addChemical } from "@/lib/safety/register";
import { addAction, addReport, changeAction } from "@/lib/safety/reports";
import { saveCopySettings } from "@/lib/safety/weekly-copy";
import type { PaddockGeometry } from "@/lib/farming/geometry";
import type { DemoContext } from "@/lib/demo/build/context";
import type { Farm } from "@/lib/demo/build/farm";

/*
 * Farm safety on the demo farm (#446; decisions 1040-1042): hazards and
 * no-go zones, each farm's emergency details, an induction with two
 * versions and sign-offs (one through the farm's gate sign-in link),
 * equipment with checklists and pre-start checks (one critical fault left
 * out of use), the training register, chemicals with safety data sheets, a
 * near miss and a minor incident with actions, and the weekly copy's
 * settings. Entered through the safety services as the demo farm's owner,
 * so it's dated by the database like any safety record: everything shows
 * as entered on the day the demo farm was made, with the day it happened
 * beside it (decision 932). Made up throughout: names, phone numbers,
 * products and the address. No real injury or medical details.
 */

/** A paddock's outline from the map, for placing hazards and zones on it. */
async function outline(ctx: DemoContext, paddockId: string): Promise<{ west: number; south: number; east: number; north: number }> {
  const row = await ctx.as((tx) => tx.query<{ geometry: PaddockGeometry }>("select geometry from paddock_boundaries where paddock_id = $1 order by paddock_boundaries.id desc limit 1", [paddockId]));
  const geometry = row.rows[0].geometry;
  const ring = geometry.type === "Polygon" ? geometry.coordinates[0] : geometry.coordinates[0][0];
  const lons = ring.map((position) => position[0]);
  const lats = ring.map((position) => position[1]);
  return { west: Math.min(...lons), south: Math.min(...lats), east: Math.max(...lons), north: Math.max(...lats) };
}

const r6 = (value: number) => Math.round(value * 1e6) / 1e6;

/** A small zone inside a paddock: from (fx0, fy0) to (fx1, fy1) as fractions of its width and height. */
function zoneIn(box: { west: number; south: number; east: number; north: number }, fx0: number, fy0: number, fx1: number, fy1: number) {
  const x = (f: number) => r6(box.west + (box.east - box.west) * f);
  const y = (f: number) => r6(box.south + (box.north - box.south) * f);
  return {
    type: "Polygon",
    coordinates: [
      [
        [x(fx0), y(fy0)],
        [x(fx1), y(fy0)],
        [x(fx1), y(fy1)],
        [x(fx0), y(fy1)],
        [x(fx0), y(fy0)],
      ],
    ],
  };
}

function pointIn(box: { west: number; south: number; east: number; north: number }, fx: number, fy: number): [number, number] {
  return [r6(box.west + (box.east - box.west) * fx), r6(box.south + (box.north - box.south) * fy)];
}

/** A one-page safety data sheet for a made-up product, so the chemicals register has real PDFs to open. */
async function madeUpDataSheet(product: string, lines: string[], issued: string): Promise<string> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Safety data sheet: ${product} (made up)`);
  pdf.setCreator("Tohyee demo farm");
  // A fixed date keeps the file the same for the same farm.
  pdf.setCreationDate(new Date(`${issued}T00:00:00Z`));
  pdf.setModificationDate(new Date(`${issued}T00:00:00Z`));
  const page = pdf.addPage([595, 842]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  page.drawText("SAFETY DATA SHEET", { x: 50, y: 780, size: 18, font: bold });
  page.drawText(`${product}`, { x: 50, y: 752, size: 14, font: bold });
  page.drawText(`Issued ${issued}. MADE UP for the Tohyee demo farm: not a real product or sheet.`, { x: 50, y: 730, size: 9, font });
  let y = 700;
  for (const line of lines) {
    page.drawText(line, { x: 50, y, size: 11, font });
    y -= 20;
  }
  return Buffer.from(await pdf.save({ useObjectStreams: false })).toString("base64");
}

export async function farmSafety(ctx: DemoContext, farm: Farm): Promise<void> {
  const on = (days: number) => addDays(ctx.today, days);
  const home = ctx.id("farm:home");
  const runoff = ctx.id("farm:runoff");
  const members = await safetyPeopleMap(ctx.organisation.id);
  const owner = ctx.actor.userId;
  const paddock = (name: string) => [...farm.home, ...farm.runoff].find((entry) => entry.name === name)!.id;
  const shedPaddock = await outline(ctx, paddock("1"));
  const creekPaddock = await outline(ctx, paddock("14"));
  const linesPaddock = await outline(ctx, paddock("9"));
  const tomoPaddock = await outline(ctx, paddock("R3"));

  // Emergency details for both farms (one version each; the home farm's changed once).
  await ctx.as(async (tx) => {
    const homeDetails = {
      farmId: home,
      address: "412 Kōwhai Valley Road, RD 2, Otago (made up)",
      entrance: "Main gate by the tanker track, 400 m past the bridge. Yellow gate, number on the post.",
      assemblyPoint: "The yard in front of the dairy shed, by the fire extinguisher sign",
      contacts: [
        { name: "Farm owner", role: "Owner", phone: "021 000 0101" },
        { name: "Tama Whitfield", role: "Herd manager", phone: "021 000 0102" },
        { name: "Ridgeview Vets (after hours)", role: "Vet", phone: "03 000 0103" },
        { name: "Kererū Power faults", role: "Power lines", phone: "0800 000 104" },
      ],
      firstAiders: ["Tama Whitfield", "Ella Brodie"],
      equipment: [
        { what: "First aid kit", where: "Dairy shed office, on the wall by the door" },
        { what: "Fire extinguisher", where: "Dairy shed vat room and the implement shed" },
        { what: "Eye wash", where: "Chemical store, beside the door" },
      ],
      noCoveragePlan: "No signal in the gully paddocks (13 to 15) or the back of the runoff. Say where you're going on the whiteboard; the UHF radio is on channel 12.",
      medicalCentre: "Kōwhai Valley Medical Centre (made up), 25 minutes by road",
      notes: "Made up: this is the demo farm.",
    };
    const first = await saveEmergency(tx, { ...homeDetails, contacts: homeDetails.contacts.slice(0, 3) });
    await saveEmergency(tx, { ...homeDetails, expectedVersion: first.version, why: "Added the power company's fault line" });
    await saveEmergency(tx, {
      farmId: runoff,
      address: "88 Ridge Road, RD 2, Otago (made up)",
      entrance: "Gate at the end of Ridge Road; the code is on the whiteboard in the dairy shed office",
      assemblyPoint: "The runoff yards",
      contacts: [
        { name: "Farm owner", role: "Owner", phone: "021 000 0101" },
        { name: "Tama Whitfield", role: "Herd manager", phone: "021 000 0102" },
      ],
      firstAiders: ["Tama Whitfield"],
      equipment: [{ what: "First aid kit", where: "In the runoff shed and on the quad" }],
      noCoveragePlan: "Patchy at the back of R5 to R8: use the UHF radio, channel 12.",
      medicalCentre: "Kōwhai Valley Medical Centre (made up)",
      notes: "Made up: this is the demo farm.",
    });
  });

  // Hazards and no-go zones, with review dates (one overdue).
  const overdue = await ctx.as(async (tx) => {
    await addHazard(tx, {
      farmId: home,
      title: "Effluent pond",
      description: "Deep, steep-sided pond below the dairy shed.",
      level: "high",
      noGo: true,
      controls: "Fenced, with a locked gate and a sign. Nobody goes inside the fence on their own.",
      paddockIds: [paddock("1")],
      zone: zoneIn(shedPaddock, 0.05, 0.08, 0.3, 0.38),
      reviewDue: on(150),
      identifiedOn: addDays(ctx.start, -200),
    });
    const face = await addHazard(tx, {
      farmId: home,
      title: "Steep face above the creek",
      description: "The face in 14 drops to the creek. Wet in winter.",
      level: "high",
      noGo: false,
      controls: "No quads or tractors on the face: walk it. Graze it with the young stock only.",
      paddockIds: [paddock("14")],
      zone: zoneIn(creekPaddock, 0.55, 0.0, 1.0, 0.45),
      reviewDue: on(-20),
      identifiedOn: addDays(ctx.start, -120),
    });
    await addHazard(tx, {
      farmId: home,
      title: "Overhead power lines",
      description: "The 11 kV line crosses 9 and 10. Low sag in the middle of 9.",
      level: "medium",
      controls: "Booms and tipping trailers down before you cross. The spreader contractor is told at the gate.",
      paddockIds: [paddock("9"), paddock("10")],
      point: pointIn(linesPaddock, 0.5, 0.5),
      reviewDue: on(75),
      identifiedOn: addDays(ctx.start, -300),
    });
    await addHazard(tx, {
      farmId: home,
      title: "Rotary platform and yard",
      description: "Moving platform, cows and wet concrete.",
      level: "medium",
      controls: "Platform stop buttons at the bail and the exit; non-slip boots in the shed.",
      paddockIds: [paddock("1")],
      point: pointIn(shedPaddock, 0.45, 0.2),
      reviewDue: on(200),
    });
    await addHazard(tx, {
      farmId: runoff,
      title: "Tomo (sinkhole) in R3",
      description: "A hole opened up after the winter rain, about a metre across.",
      level: "high",
      noGo: true,
      controls: "Fenced off with waratahs and tape. Filling it is booked with the contractor.",
      paddockIds: [paddock("R3")],
      zone: zoneIn(tomoPaddock, 0.6, 0.55, 0.72, 0.7),
      reviewDue: on(14),
      identifiedOn: on(-12),
    });
    return face;
  });

  // An induction, changed once so everyone signs again; sign-offs on both versions.
  const induction = await ctx.as(async (tx) => {
    const sections = [
      { heading: "Welcome", text: "Kōwhai Dairies is a made-up demo farm. Sign in at the dairy shed office, or with the QR code on the gate." },
      { heading: "Vehicles", text: "Helmets on quads, always. 20 km/h on the races. No passengers on quads." },
      { heading: "Hazards", text: "Read the farm's hazards and no-go zones below before you go out. Ask if you're not sure where something is." },
      { heading: "In an emergency", text: "Call 111, then the farm owner. Meet at the assembly point." },
    ];
    const made = await addInduction(tx, { title: "Kōwhai Dairies farm induction", audiences: ["worker", "contractor", "visitor"], sections });
    const tama = { name: "Tama Whitfield", company: null, phone: null };
    await signInduction(tx, { inductionId: made.recordId, inductionVersion: made.version, farmId: home, acknowledged: true, person: tama, audience: "worker" });
    await signInduction(tx, { inductionId: made.recordId, inductionVersion: made.version, farmId: home, acknowledged: true, audience: "worker" });
    const changed = await changeInduction(tx, made.recordId, {
      expectedVersion: made.version,
      sections: [...sections, { heading: "Tomo on the runoff", text: "There's a fenced-off tomo in R3. Keep out of the fenced area." }],
      needsResign: true,
      why: "Added the tomo on the runoff",
    });
    // The owner signs the new version; Tama and Ella's are still to do (Tama's on the old one).
    await signInduction(tx, { inductionId: changed.recordId, inductionVersion: changed.version, farmId: home, acknowledged: true, audience: "worker" });
    await signInduction(tx, { inductionId: changed.recordId, inductionVersion: changed.version, farmId: runoff, acknowledged: true, person: { name: "Ella Brodie", company: null, phone: null }, audience: "worker" });
    const link = await makeSiteLink(tx, { farmId: home }, "https://demo-farm.invalid");
    return { id: changed.recordId, version: changed.version, link: link.url };
  });
  // A contractor signs in at the gate with the QR code: self-declared, no login (decision 965).
  const [organisationId, token] = induction.link.split("/site/")[1].split("/");
  await publicSignIn(organisationId, token, {
    person: { name: "Rob Tane", company: "Kaka Valley Spreading", phone: "021 000 0105" },
    audience: "contractor",
    purpose: "Spreading urea",
    inductionId: induction.id,
    inductionVersion: induction.version,
    acknowledged: true,
  });

  // Equipment with checklists, linked to the fixed assets, and some pre-start checks.
  await ctx.as(async (tx) => {
    const quadList = await addChecklist(tx, {
      title: "Quad bike pre-start",
      items: [
        { text: "Brakes work (front and rear)", critical: true },
        { text: "Throttle springs back", critical: true },
        { text: "Helmet on and done up", critical: true },
        { text: "Tyres look right (no bulges, pressures even)", critical: false },
        { text: "Lights and horn", critical: false },
      ],
    });
    const tractorList = await addChecklist(tx, {
      title: "Tractor pre-start",
      items: [
        { text: "Brakes and park brake", critical: true },
        { text: "Rollover frame and seatbelt", critical: true },
        { text: "PTO guard in place", critical: true },
        { text: "Oil, water and fuel", critical: false },
        { text: "Mirrors, lights and beacon", critical: false },
      ],
    });
    const implementList = await addChecklist(tx, {
      title: "Spreader and sprayer pre-start",
      items: [
        { text: "Guards on the spinners or pump", critical: true },
        { text: "Hitch pin and safety chain", critical: true },
        { text: "No leaks from hoses or the tank", critical: false },
        { text: "Rate set for today's job", critical: false },
      ],
    });
    const common = { farmId: home, owner: "owned", responsibleUserId: owner };
    const quad1 = await addEquipment(tx, { ...common, name: "Quad bike 1", type: "Quad bike", checklistId: quadList.recordId, fixedAssetId: ctx.id("asset:Farm bikes (two)") }, members);
    const quad2 = await addEquipment(tx, { ...common, name: "Quad bike 2", type: "Quad bike", checklistId: quadList.recordId, fixedAssetId: ctx.id("asset:Farm bikes (two)") }, members);
    const tractor = await addEquipment(tx, { ...common, name: "Tractor (110 hp)", type: "Tractor", checklistId: tractorList.recordId, fixedAssetId: ctx.id("asset:Tractor (110 hp)") }, members);
    const spreader = await addEquipment(tx, { ...common, name: "Fertiliser spreader", type: "Spreader", checklistId: implementList.recordId, notes: "Twin-disc, 18 m bout. Made up." }, members);
    await addEquipment(tx, { farmId: home, owner: "contractor", ownerName: "Tūī Contracting Ltd", name: "Boom sprayer", type: "Sprayer", checklistId: implementList.recordId, notes: "The contractor's; checked by them before each job." }, members);
    ctx.ids.set("safety:spreader", spreader.recordId);
    const answer = (list: typeof quadList, fault?: { key: number; note: string }) =>
      list.data.items.map((item, index) => ({ key: item.key, result: fault && fault.key === index ? "fault" : "ok", note: fault && fault.key === index ? fault.note : null }));
    for (const [equipment, list, hours] of [
      [quad1, quadList, "3412"],
      [tractor, tractorList, "5120"],
      [spreader, implementList, null],
      [quad1, quadList, "3418"],
    ] as const) {
      await recordCheck(tx, { equipmentId: equipment.recordId, checklistId: list.recordId, checklistVersion: list.version, answers: answer(list), hoursOrKm: hours }, members);
    }
    // A non-critical fault: it's still in use, the fault is noted.
    await recordCheck(tx, { equipmentId: tractor.recordId, checklistId: tractorList.recordId, checklistVersion: tractorList.version, answers: answer(tractorList, { key: 4, note: "Beacon not working" }), hoursOrKm: "5126" }, members);
    // A critical fault: Quad bike 2 is out of use until someone allowed releases it (decision 955).
    await recordCheck(tx, { equipmentId: quad2.recordId, checklistId: quadList.recordId, checklistVersion: quadList.version, answers: answer(quadList, { key: 0, note: "Rear brake doesn't hold on the slope" }), hoursOrKm: "2875" }, members);
  });

  // The training register: one expiring soon, one expired.
  await ctx.as(async (tx) => {
    const entries: Array<Record<string, unknown>> = [
      { person: { name: "Tama Whitfield" }, what: "Quad bike (ATV) rider training", provider: "Southern Rural Training (made up)", completedOn: on(-500), expiresOn: on(595), canDo: "Quad bikes on the farm, including the hill paddocks" },
      { person: { name: "Tama Whitfield" }, what: "Workplace first aid", provider: "Southern Rural Training (made up)", completedOn: on(-690), expiresOn: on(40), certificate: "FA-000123 (made up)" },
      { person: { name: "Ella Brodie" }, what: "Tractor and trailed implements", provider: "Southern Rural Training (made up)", completedOn: on(-200), canDo: "Tractor with the spreader and the feed wagon. Not the hill paddocks yet." },
      { person: { name: "Ella Brodie" }, what: "Agrichemical handling (introductory)", provider: "Southern Rural Training (made up)", completedOn: on(-1100), expiresOn: on(-5) },
      { person: owner ? { userId: owner } : { name: "Farm owner" }, what: "Approved handler (made-up course)", provider: "Southern Rural Training (made up)", completedOn: on(-400), expiresOn: on(1425), canDo: "Signs off spraying jobs" },
    ];
    for (const entry of entries) await addTraining(tx, entry, members);
  });

  // Chemicals, with made-up products and safety data sheets (one missing, one over five years old).
  const sheets = [
    { name: "Paddock Clear 360 (made-up herbicide)", un: "3082", most: "40", unit: "L", where: "Chemical store, top shelf", storage: "Locked store, bunded shelf", hazards: "Harmful to aquatic life. Eye irritant.", issued: on(-800), handler: true },
    { name: "TeatGuard Plus (made-up teat spray)", un: null, most: "200", unit: "L", where: "Dairy shed vat room", storage: "Drum on a bund", hazards: "Mild skin irritant.", issued: on(-2100), handler: false },
    { name: "Zinc Shield (made-up zinc drench)", un: null, most: "60", unit: "L", where: "Calf shed", storage: "Off the ground, out of the sun", hazards: "Harmful if swallowed.", issued: on(-400), handler: false },
  ];
  for (const sheet of sheets) {
    const pdf = await madeUpDataSheet(sheet.name, [`Use: ${sheet.name.includes("herbicide") ? "weed control" : "animal health"}`, `Hazards: ${sheet.hazards}`, `Storage: ${sheet.storage}`, "First aid: see a doctor if unwell. (Made up.)"], sheet.issued);
    await ctx.as(async (tx) => {
      const file = await uploadSafetyFile(tx, { farmId: home, fileName: `SDS ${sheet.name.split(" (")[0]}.pdf`, contentType: "application/pdf", contentBase64: pdf });
      await addChemical(tx, {
        farmId: home,
        name: sheet.name,
        unNumber: sheet.un,
        maxQuantity: sheet.most,
        unit: sheet.unit,
        location: sheet.where,
        storage: sheet.storage,
        hazards: sheet.hazards,
        sds: { id: file.id },
        sdsDate: sheet.issued,
        approvedHandler: sheet.handler,
      });
    });
  }
  await ctx.as((tx) => addChemical(tx, { farmId: home, name: "Diesel", unNumber: "1202", maxQuantity: "2000", unit: "L", location: "Fuel tank by the implement shed", storage: "Above-ground tank with a bund", hazards: "Flammable. Harmful to aquatic life." }));

  // A near miss and a minor incident, each with an action (generic details only).
  await ctx.as(async (tx) => {
    const nearMiss = await addReport(
      tx,
      {
        farmId: home,
        type: "near_miss",
        title: "Quad slid on the wet track above the creek",
        whatHappened: "Coming down the track in 14 after rain, the quad slid sideways towards the face. The rider stopped it and walked it down.",
        where: "Track above the creek in 14",
        paddockIds: [paddock("14")],
        time: "07:40",
        immediateAction: "Track closed to quads until it dries.",
        severity: "moderate",
        happenedOn: on(-9),
        action: { title: "Put gravel on the steep part of the track and a sign at the top", assignedToName: "Tama Whitfield", due: on(10) },
      },
      members,
    );
    const incident = await addReport(
      tx,
      {
        farmId: home,
        type: "incident",
        title: "Cut hand on a broken gate latch",
        whatHappened: "A broken latch on the gate into 6 cut someone's hand while they opened it.",
        where: "Gate into 6",
        paddockIds: [paddock("6")],
        time: "15:10",
        immediateAction: "First aid from the shed kit; the gate tied shut with wire.",
        severity: "minor",
        injured: true,
        happenedOn: on(-4),
        details: { injuredPerson: "A farm worker (made up)", injury: "Minor cut (made up for the demo)", treatment: "First aid on the farm" },
        action: { title: "Replace the latch on the gate into 6", assignedToName: "Ella Brodie", due: on(3) },
      },
      members,
    );
    // The latch is done and waiting to be checked.
    if (incident.action) await changeAction(tx, incident.action.recordId, { step: "done", note: "New latch fitted.", expectedVersion: incident.action.version }, members);
    // An action on the overdue hazard, from its review.
    await addAction(tx, { hazardId: overdue.recordId, title: "Review the face in 14 and the fence line", assignedToUserId: owner, due: on(2) }, members);
    ctx.ids.set("safety:nearMiss", nearMiss.report.recordId);
  });

  // The weekly copy off the farm, on, to a made-up address. It never sends: the demo farm's jobs are paused and it refuses email.
  await ctx.as((tx) => saveCopySettings(tx, { on: true, toAddresses: ["safety-copy@example.com"] }));
}
