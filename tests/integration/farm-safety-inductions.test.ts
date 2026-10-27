import { afterAll, beforeAll, expect, it } from "vitest";
import * as siteRoute from "@/app/api/safety-site/[organisationId]/[token]/route";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { setMemberFarmAccess } from "@/lib/farming/access";
import { saveFarm, setFarmingEnabled } from "@/lib/farming/paddocks";
import { addHazard, changeHazard, saveEmergency } from "@/lib/safety/hazards";
import { addInduction, changeInduction, inductionToRead, listInductions, listSignoffs, makeSiteLink, onSite, publicSignIn, publicSignOut, publicSite, signIn, signInduction, signOut, turnOffSiteLink } from "@/lib/safety/inductions";
import { addReport } from "@/lib/safety/reports";
import { checkSafetyHistory, recordHistory } from "@/lib/safety/records";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, params, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "farm-safety-inductions";

/**
 * Inductions, sign-offs and signing in on site, including the farm's
 * sign-in link for people without a login (#446; FS21-FS27 in
 * docs/FARM-SAFETY.md, decisions 948-952).
 */
describeWithDatabase("farm safety inductions and sign-in", () => {
  let server: TestServer;
  let owner: SessionUser;
  let staff: SessionUser;
  let viewer: SessionUser;
  const as = (user: SessionUser) => <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: user.id, email: user.email }, work);
  const w = {} as Record<string, string>;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("ind-owner@example.com", { serverAdmin: true, displayName: "Jess" });
    staff = await createTestUser("ind-staff@example.com", { displayName: "Mere" });
    viewer = await createTestUser("ind-viewer@example.com", { displayName: "Tama" });
    await createTestOrganisation(owner, ORG);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'bookkeeper'), ($1, $3, 'viewer')", [ORG, staff.id, viewer.id]);
    await as(owner)((tx) => setFarmingEnabled(tx, { enabled: true }));
    w.home = (await as(owner)((tx) => saveFarm(tx, { name: "Home farm" })))[0].id;
    w.runoff = (await as(owner)((tx) => saveFarm(tx, { name: "Runoff" }))).find((farm) => farm.name === "Runoff")!.id;
    await as(owner)((tx) => setMemberFarmAccess(tx, { userId: staff.id, role: "bookkeeper", access: "farms", farmIds: [w.home] }));
    await as(owner)((tx) => setMemberFarmAccess(tx, { userId: viewer.id, role: "viewer", access: "farms", farmIds: [w.home] }));
    w.pond = (await as(owner)((tx) => addHazard(tx, { farmId: w.home, title: "Effluent pond", level: "high", noGo: true }))).recordId;
    w.gate = (await as(owner)((tx) => addHazard(tx, { farmId: w.home, title: "Sticky gate", level: "low" }))).recordId;
    await as(owner)((tx) => addHazard(tx, { farmId: w.runoff, title: "Runoff quarry", level: "high" }));
    await as(owner)((tx) => saveEmergency(tx, { farmId: w.home, address: "1 Example Road", assemblyPoint: "Cowshed yard" }));
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("FS21 an induction shared by every farm is read with each farm's own hazards and emergency details", async () => {
    const induction = await as(owner)((tx) => addInduction(tx, { title: "Farm induction", audiences: ["worker", "contractor", "visitor"], sections: [{ heading: "Rules", text: "Helmets on bikes. 20 km/h on races." }] }));
    w.induction = induction.recordId;
    expect(induction.farmId).toBeNull();
    const home = await as(staff)((tx) => inductionToRead(tx, w.induction, w.home));
    expect(home.hazards.map((hazard) => hazard.title)).toEqual(["Effluent pond", "Sticky gate"]);
    expect(home.emergency?.data.assemblyPoint).toBe("Cowshed yard");
    expect(home.induction.signVersion).toBe(1);
    await expect(as(staff)((tx) => inductionToRead(tx, w.induction, w.runoff))).rejects.toThrow(/Farm not found/);
    await expect(as(owner)((tx) => addInduction(tx, { title: "x", audiences: ["boss"], sections: [{ heading: "a", text: "b" }] }))).rejects.toThrow(/who it's for/);
  });

  it("FS22 a worker signs on their own login: the version and hazards they saw are kept", async () => {
    await expect(as(staff)((tx) => signInduction(tx, { inductionId: w.induction, inductionVersion: 1, farmId: w.home }))).rejects.toThrow(/read and understood/);
    await expect(as(staff)((tx) => signInduction(tx, { inductionId: w.induction, inductionVersion: 0, farmId: w.home, acknowledged: true }))).rejects.toThrow(/changed since it was opened/);
    const signed = await as(staff)((tx) => signInduction(tx, { inductionId: w.induction, inductionVersion: 1, farmId: w.home, acknowledged: true, audience: "worker" }));
    expect(signed.enteredByEmail).toBe("ind-staff@example.com");
    expect(signed.data).toMatchObject({ signedHow: "self", inductionVersion: 1, person: { userId: staff.id, name: "Mere" }, hazards: [{ id: w.pond, version: 1 }, { id: w.gate, version: 1 }], emergencyVersion: 1 });
    const [mere] = await as(owner)((tx) => listSignoffs(tx, w.home));
    expect(mere).toMatchObject({ current: true, reasons: [] });
  });

  it("FS24 someone without a login is recorded, not signed; a viewer can't record for others", async () => {
    const recorded = await as(staff)((tx) => signInduction(tx, { inductionId: w.induction, inductionVersion: 1, farmId: w.home, acknowledged: true, audience: "contractor", person: { name: "Hemi", company: "Hemi Fencing" } }));
    expect(recorded.data).toMatchObject({ signedHow: "recorded", person: { userId: null, name: "Hemi", company: "Hemi Fencing" } });
    expect(recorded.enteredByEmail).toBe("ind-staff@example.com");
    await expect(as(viewer)((tx) => signInduction(tx, { inductionId: w.induction, inductionVersion: 1, farmId: w.home, acknowledged: true, person: { name: "X" } }))).rejects.toThrow(/bookkeeper/);
    // A viewer can sign for themselves.
    expect((await as(viewer)((tx) => signInduction(tx, { inductionId: w.induction, inductionVersion: 1, farmId: w.home, acknowledged: true }))).data.signedHow).toBe("self");
  });

  it("FS23 they must sign again after a 'sign again' version or a new or changed high or no-go hazard, not a minor change", async () => {
    await as(owner)((tx) => changeHazard(tx, w.gate, { change: "updated", expectedVersion: 1, controls: "Lift as you open" }));
    expect((await as(owner)((tx) => listSignoffs(tx, w.home))).every((signoff) => signoff.current)).toBe(true);
    await as(owner)((tx) => changeInduction(tx, w.induction, { expectedVersion: 1, sections: [{ heading: "Rules", text: "Helmets on bikes. 20 km/h on races." }, { heading: "Dogs", text: "Ask before bringing a dog." }] }));
    expect((await as(owner)((tx) => listSignoffs(tx, w.home))).every((signoff) => signoff.current)).toBe(true);
    await as(owner)((tx) => addHazard(tx, { farmId: w.home, title: "Bull in paddock 9", level: "high" }));
    const afterBull = await as(owner)((tx) => listSignoffs(tx, w.home));
    expect(afterBull.find((signoff) => signoff.data.person.name === "Mere")?.reasons).toEqual(["New since they signed: Bull in paddock 9."]);
    await as(owner)((tx) => changeInduction(tx, w.induction, { expectedVersion: 2, needsResign: true, why: "New dog rule" }));
    const mere = (await as(owner)((tx) => listSignoffs(tx, w.home))).find((signoff) => signoff.data.person.name === "Mere")!;
    expect(mere.current).toBe(false);
    expect(mere.reasons[0]).toBe("The induction has changed and needs signing again.");
    expect((await as(owner)((tx) => listInductions(tx, w.home)))[0].signVersion).toBe(3);
    await as(staff)((tx) => signInduction(tx, { inductionId: w.induction, inductionVersion: 3, farmId: w.home, acknowledged: true }));
    expect((await as(owner)((tx) => listSignoffs(tx, w.home))).find((signoff) => signoff.data.person.name === "Mere")?.current).toBe(true);
  });

  it("FS25 signing in and out on site, and a missed sign-out fixed later as a correction", async () => {
    const mine = await as(staff)((tx) => signIn(tx, { farmId: w.home, purpose: "Milking" }));
    const visitor = await as(staff)((tx) => signIn(tx, { farmId: w.home, person: { name: "Ana", company: "Vet clinic" }, audience: "visitor", purpose: "Herd test" }));
    expect((await as(viewer)((tx) => onSite(tx, w.home))).here.map((visit) => visit.data.person.name)).toEqual(["Mere", "Ana"]);
    await expect(as(viewer)((tx) => signOut(tx, visitor.recordId))).rejects.toThrow(/bookkeeper/);
    const out = await as(staff)((tx) => signOut(tx, mine.recordId));
    expect(out).toMatchObject({ version: 2, change: "updated", data: { signedOut: true, leftAt: null } });
    await expect(as(staff)((tx) => signOut(tx, mine.recordId))).rejects.toThrow(/already signed out/);
    await expect(as(staff)((tx) => signOut(tx, visitor.recordId, { leftAt: "2099-01-01T00:00:00Z", why: "Forgot" }))).rejects.toThrow(/future/);
    await expect(as(staff)((tx) => signOut(tx, visitor.recordId, { leftAt: "2000-01-01T00:00:00Z", why: "Forgot" }))).rejects.toThrow(/before they signed in/);
    await expect(as(staff)((tx) => signOut(tx, visitor.recordId, { leftAt: new Date().toISOString() }))).rejects.toThrow(/Why it's corrected/);
    const fixed = await as(staff)((tx) => signOut(tx, visitor.recordId, { leftAt: new Date().toISOString(), why: "Ana left without signing out" }));
    expect(fixed).toMatchObject({ change: "corrected", data: { signedOut: true, why: "Ana left without signing out" } });
    const site = await as(viewer)((tx) => onSite(tx, w.home));
    expect(site.here).toEqual([]);
    expect(site.leftToday.length).toBe(2);
  });

  it("FS26 the farm's sign-in link: that farm's hazards and emergency details, never people or reports; sign in and out once", async () => {
    await as(staff)((tx) => addReport(tx, { farmId: w.home, type: "incident", title: "Secret incident", injured: true, details: { injury: "Private injury" } }));
    const made = await as(staff)((tx) => makeSiteLink(tx, { farmId: w.home }, "https://farm.example"));
    expect(made.url).toMatch(new RegExp(`^https://farm\\.example/site/${ORG}/[A-Za-z0-9_-]{43}$`));
    expect(made.qrSvg).toContain("<svg");
    const token = made.url.split("/").pop()!;
    const response = await siteRoute.GET(apiRequest(`/api/safety-site/${ORG}/${token}`), params({ organisationId: ORG, token }) as never);
    expect(response.status).toBe(200);
    const text = await response.text();
    const site = JSON.parse(text) as Awaited<ReturnType<typeof publicSite>>;
    expect(site!.farmName).toBe("Home farm");
    expect(site!.hazards.map((hazard) => hazard.title)).toEqual(["Effluent pond", "Sticky gate", "Bull in paddock 9"]);
    expect(site!.inductions.map((induction) => [induction.title, induction.audiences])).toEqual([["Farm induction", ["contractor", "visitor"]]]);
    for (const secret of ["Runoff quarry", "Secret incident", "Private injury", "Mere", "Hemi", "Ana", "ind-staff@example.com"]) expect(text).not.toContain(secret);

    const signedIn = await publicSignIn(ORG, token, { person: { name: "Rawiri", company: "Spray Co", phone: "021 000 111" }, audience: "contractor", purpose: "Spraying thistles", inductionId: w.induction, inductionVersion: 3, acknowledged: true });
    expect(signedIn!.signOutToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const rawiri = (await as(owner)((tx) => listSignoffs(tx, w.home))).find((signoff) => signoff.data.person.name === "Rawiri")!;
    expect(rawiri).toMatchObject({ enteredByEmail: "site sign-in link", via: "farm sign-in link", data: { signedHow: "link", audience: "contractor" } });
    expect((await as(owner)((tx) => onSite(tx, w.home))).here.map((visit) => visit.data.person.name)).toEqual(["Rawiri"]);
    await expect(publicSignIn(ORG, token, { person: { name: "X" }, inductionId: w.induction, inductionVersion: 3 })).rejects.toThrow(/read and understood/);
    await expect(publicSignOut(ORG, token, "x".repeat(43))).rejects.toThrow(/wasn't found/);
    expect(await publicSignOut(ORG, token, signedIn!.signOutToken)).toMatchObject({ signedOutAt: expect.any(String) });
    await expect(publicSignOut(ORG, token, signedIn!.signOutToken)).rejects.toThrow(/already signed out/);
    expect((await as(owner)((tx) => onSite(tx, w.home))).here).toEqual([]);

    // Wrong, turned off or expired links are all "not found".
    expect(await publicSite(ORG, "y".repeat(43))).toBeNull();
    expect(await publicSite("no-such-org", token)).toBeNull();
    const links = await as(staff)((tx) => turnOffSiteLink(tx, made.links[0].id));
    expect(links[0].on).toBe(false);
    expect(await publicSite(ORG, token)).toBeNull();
    const notFound = await siteRoute.GET(apiRequest(`/api/safety-site/${ORG}/${token}`), params({ organisationId: ORG, token }) as never);
    expect(notFound.status).toBe(404);
    await expect(as(owner)((tx) => makeSiteLink(tx, { farmId: w.home, expiresOn: "2000-01-01" }, "https://farm.example"))).rejects.toThrow(/past/);
    // A member on Home farm only can't make one for the runoff.
    await expect(as(staff)((tx) => makeSiteLink(tx, { farmId: w.runoff }, "https://farm.example"))).rejects.toThrow(/Farm not found/);
  });

  it("FS27 sign-offs and visits are safety records like the rest: versions, in the chain", async () => {
    const [visit] = (await as(owner)((tx) => onSite(tx, w.home))).leftToday;
    expect((await as(owner)((tx) => recordHistory(tx, visit.recordId))).length).toBe(2);
    await expect(as(staff)((tx) => listSignoffs(tx, w.runoff))).rejects.toThrow(/Farm not found/);
    expect((await as(owner)((tx) => checkSafetyHistory(tx))).problems).toEqual([]);
  });
});
