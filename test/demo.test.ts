import { describe, expect, test } from "bun:test";
import { Admin } from "../src/server/admin.ts";
import { demoFor, newIssueHref } from "../src/server/demo.ts";
import { createServer } from "../src/server/index.ts";
import { encodeSeed, exportSeed, importSeed } from "../src/server/seed.ts";
import { memoryStore, type AppCredentials } from "../src/server/store.ts";

const ghApp: AppCredentials = { id: 1, slug: "no-repro", name: "No Repro", htmlUrl: "", clientId: "", clientSecret: "", webhookSecret: "s", privateKey: "k", webhookUrl: "https://smee.io/x" };
const origin = "http://localhost:8787";

function setup(env: Record<string, string> = { NOREPRO_ADMIN_PASSWORD: "hunter2" }) {
  const store = memoryStore(ghApp);
  const server = createServer({
    store,
    publicUrl: origin,
    webhookUrl: "",
    env,
    listRepos: async () => [{ fullName: "rushibhosalepro/tasks-app", account: "rushibhosalepro", installationId: 0 }],
    log: () => {},
  });
  const get = (path: string, cookie = "") => server.fetch(new Request(`${origin}${path}`, { headers: { cookie } }));
  const post = (path: string, form: Record<string, string> = {}, cookie = "") =>
    server.fetch(new Request(`${origin}${path}`, { method: "POST", headers: { origin, cookie }, body: new URLSearchParams(form) }));
  return { store, server, get, post };
}

const project = { id: "tasks-app", name: "tasks-app", repo: "rushibhosalepro/tasks-app", sentry: null, paused: false, createdAt: "2026-10-23T00:00:00Z" };

describe("hosted demo: visitors read, the admin changes things", () => {
  test("visitors see projects and Try it, but no controls", async () => {
    const { store, get } = setup();
    await store.projects.save({ ...project });
    const list = await (await get("/")).text();
    expect(list).toContain("Live demo");
    expect(list).not.toContain("/projects/new");
    const page = await (await get("/projects/tasks-app")).text();
    expect(page).toContain("Try it");
    expect(page).toContain("https://github.com/rushibhosalepro/tasks-app/issues/new?title=Deleting+a+task");
    expect(page).not.toContain("/pause");
    expect(page).not.toContain('role="switch"');
    expect(page).not.toContain("Add connector");
  });

  test("changes are refused until signed in", async () => {
    const { store, get, post } = setup();
    await store.projects.save({ ...project });
    expect((await post("/projects/tasks-app/pause")).status).toBe(403);
    expect((await get("/projects/new")).headers.get("location")).toBe(`${origin}/admin`);
    expect((await get("/setup")).headers.get("location")).toBe(`${origin}/admin`);
    expect((await store.projects.get("tasks-app"))!.paused).toBe(false);

    expect((await post("/admin", { password: "wrong" })).status).toBe(401);
    const signedIn = await post("/admin", { password: "hunter2" });
    const cookie = signedIn.headers.get("set-cookie")!.split(";")[0]!;
    expect((await post("/projects/tasks-app/pause", {}, cookie)).status).toBe(303);
    expect((await store.projects.get("tasks-app"))!.paused).toBe(true);
    expect(await (await get("/projects/tasks-app", cookie)).text()).toContain("Resume");
  });

  test("without a password (local use) everyone is the admin", async () => {
    const { store, get } = setup({});
    await store.projects.save({ ...project });
    expect(await (await get("/projects/tasks-app")).text()).toContain("/pause");
    expect((await get("/admin")).status).toBe(404);
  });

  test("forged or expired admin cookies don't count", () => {
    const admin = new Admin("hunter2");
    const now = Date.UTC(2026, 9, 23);
    const cookie = admin.sessionCookie(false, now).split(";")[0]!;
    const req = (c: string) => new Request(origin, { headers: { cookie: c } });
    expect(admin.allows(req(cookie), now)).toBe(true);
    expect(admin.allows(req(cookie), now + 8 * 24 * 3600_000)).toBe(false);
    expect(admin.allows(req(cookie.replace(/.$/, (ch) => (ch === "A" ? "B" : "A"))), now)).toBe(false);
    expect(new Admin("other").allows(req(cookie), now)).toBe(false);
  });
});

describe("demo examples", () => {
  test("every demo has examples that open a pre-filled GitHub issue", () => {
    const d = demoFor("rushibhosalepro/notely")!;
    expect(d.examples.length).toBeGreaterThan(0);
    const href = new URL(newIssueHref("rushibhosalepro/notely", d.examples[0]!));
    expect(href.pathname).toBe("/rushibhosalepro/notely/issues/new");
    expect(href.searchParams.get("title")).toBe("Search is broken");
    expect(demoFor("someone/else")).toBeNull();
  });
});

describe("moving to a host", () => {
  test("the seed carries the app, Sentry installs and projects, and only fills an empty store", async () => {
    const from = memoryStore(ghApp);
    await from.projects.save({ ...project });
    await from.sentry.save({ installationId: "i", org: "self-mcf", token: "t", refreshToken: "r", expiresAt: "2026-10-23T08:00:00Z" });
    const seed = encodeSeed(await exportSeed(from));

    const to = memoryStore(null);
    expect(await importSeed(to, seed)).toBe(true);
    expect((await to.loadApp())!.privateKey).toBe("k");
    expect((await to.projects.list()).map((p) => p.repo)).toEqual(["rushibhosalepro/tasks-app"]);
    expect((await to.sentry.load("self-mcf"))!.token).toBe("t");
    expect(await importSeed(to, seed)).toBe(false); // a restart never overwrites
  });
});
