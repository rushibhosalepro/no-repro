import { describe, expect, test } from "bun:test";
import { parseConfig } from "../src/core/config.ts";
import type { BugReport, TriageOutcome } from "../src/core/report.ts";
import { decideVerdict } from "../src/repro/verdict.ts";
import { createServer } from "../src/server/index.ts";
import { suggestProject, timeAgo, uniqueName } from "../src/server/pages.ts";
import { applyProject, checkRecordFrom, projectId, statsFor, type CheckRecord, type Project } from "../src/server/projects.ts";
import { memoryStore } from "../src/server/store.ts";

const report: BugReport = {
  title: "Can't add the hoodie to my cart",
  page: "/cart",
  steps: ["Add Cotton Hoodie"],
  expected: "Added",
  actual: "Error",
  environment: { device: "desktop", browser: null },
  testValues: [],
  lastWorkingVersion: null,
  checkable: true,
  notCheckableReason: null,
  question: null,
};
const issue = { repo: "rushi/repro-test", number: 7, title: "Can't add the hoodie", url: "https://github.com/rushi/repro-test/issues/7", openedAt: "2026-10-23T05:00:00Z" };
const evidence = {
  source: "sentry" as const,
  matchedBy: "search" as const,
  issue: { id: "1", shortId: "SHOPLITE-1", title: "TypeError: STOCK[productId] is undefined", permalink: "https://self-mcf.sentry.io/issues/1/", events: 5, users: 3, firstSeen: "", lastSeen: "", firstRelease: "v1.2.0" },
  error: null,
  frames: [{ file: "server.ts", line: 87, function: "handle" }],
  breadcrumbs: [{ category: "fetch", message: "POST /api/cart → 500" }],
  url: null,
  browser: null,
  os: null,
  release: null,
  environment: null,
};

describe("check records", () => {
  test("a clear, reproduced, bisected issue with Sentry evidence", () => {
    const fail = { ok: true, failedStep: null, error: null, check: { passed: false, detail: "" } };
    const outcome: TriageOutcome = {
      status: "clear",
      report,
      evidence,
      localization: { sha: "abc", filesRead: 2, suspects: [{ path: "server.ts", startLine: 87, endLine: 87, reason: "STOCK has no hoodie. More.", confidence: "high", commit: null, link: null }] },
      repro: {
        status: "done",
        plan: { viewport: { width: 1280, height: 800 }, steps: [{ do: "goto", path: "/" }], check: { type: "no_errors" } },
        verdict: decideVerdict([fail, fail, fail]),
        runUrl: null,
        baseUrl: "",
        bisect: { status: "found", range: { good: "g", bad: "b", goodLabel: "v1.1.0", commits: 2 }, firstBad: { sha: "eb5aceb000", message: "Track stock for products", author: "", date: "" }, good: { sha: "g", message: "", author: "", date: "" }, tested: 2, skipped: 0 },
      },
    };
    const r = checkRecordFrom(outcome, issue, "2026-10-23T05:01:00Z");
    expect(r).toMatchObject({
      verdict: "reproduced",
      cause: { path: "server.ts", startLine: 87 },
      sentry: { shortId: "SHOPLITE-1", users: 3, firstRelease: "v1.2.0", breadcrumbs: ["POST /api/cart → 500"] },
      introducedIn: { sha: "eb5aceb000", message: "Track stock for products" },
      checkedAt: "2026-10-23T05:01:00Z",
    });
  });

  test("needs-info keeps the question; running reproduction reads as reproducing", () => {
    const asked = checkRecordFrom({ status: "needs-info", report, missing: ["steps"], question: "What did you click?" }, issue);
    expect(asked).toMatchObject({ verdict: "needs-info", question: "What did you click?", sentry: null });
    const running = checkRecordFrom({ status: "clear", report, repro: { status: "running", plan: { viewport: { width: 1, height: 1 }, steps: [], check: { type: "no_errors" } }, round: 1, runUrl: null } }, issue);
    expect(running.verdict).toBe("reproducing");
    expect(checkRecordFrom({ status: "clear", report, repro: { status: "disabled" } }, issue).verdict).toBe("clear");
  });

  test("stats", () => {
    const base = checkRecordFrom({ status: "clear", report }, issue);
    const list: CheckRecord[] = [{ ...base, verdict: "reproduced", sentry: null }, { ...base, verdict: "needs-info" }, { ...base, verdict: "flaky", sentry: checkRecordFrom({ status: "clear", report, evidence }, issue).sentry }];
    expect(statsFor(list)).toEqual({ checked: 3, askedForInfo: 1, matchedInSentry: 1, reproduced: 2 });
  });
});

describe("helpers", () => {
  test("project ids are slugs and unique", () => {
    expect(projectId("Repro Test", [])).toBe("repro-test");
    expect(projectId("Repro Test", ["repro-test"])).toBe("repro-test-2");
    expect(projectId("New", ["new"])).toBe("new-2");
    expect(projectId("!!!", [])).toBe("project");
  });

  test("a project's Sentry link overrides the repo's yml", () => {
    const config = parseConfig("app:\n  name: X\nsentry:\n  org: old\n  project: old\n");
    const p: Project = { id: "x", name: "X", repo: "a/b", sentry: { org: "self-mcf", project: "shoplite", environment: "production" }, paused: false, createdAt: "" };
    expect(applyProject(config, p).sentry).toEqual({ org: "self-mcf", project: "shoplite" });
    expect(applyProject(config, { ...p, sentry: null }).sentry).toEqual({ org: "old", project: "old" });
  });

  test("Sentry project suggestion ignores case and punctuation", () => {
    expect(suggestProject("rushi/repro_test", [{ slug: "shoplite", name: "ShopLite" }, { slug: "repro-test", name: "Repro Test" }])).toBe("repro-test");
    expect(suggestProject("rushi/zzz", [{ slug: "shoplite", name: "ShopLite" }])).toBeNull();
  });

  test("project names are unique, with a number on clashes", () => {
    expect(uniqueName("repro-test", [])).toBe("repro-test");
    expect(uniqueName("repro-test", ["Repro-Test"])).toBe("repro-test-2");
    expect(uniqueName("app", ["app", "app-2"])).toBe("app-3");
  });

  test("relative times", () => {
    const now = Date.parse("2026-10-23T12:00:00Z");
    expect(timeAgo("2026-10-23T11:59:30Z", now)).toBe("just now");
    expect(timeAgo("2026-10-23T11:15:00Z", now)).toBe("45 min ago");
    expect(timeAgo("2026-10-23T09:00:00Z", now)).toBe("3 h ago");
    expect(timeAgo("2026-10-20T12:00:00Z", now)).toBe("3 d ago");
    expect(timeAgo(null, now)).toBe("—");
  });
});

describe("project pages", () => {
  const ghApp = { id: 1, slug: "no-repro-ab12", name: "n", htmlUrl: "", clientId: "", clientSecret: "", webhookSecret: "w", privateKey: "", webhookUrl: "" };
  const origin = "http://localhost:8787";
  function setup() {
    const store = memoryStore(ghApp);
    const server = createServer({
      store,
      publicUrl: origin,
      webhookUrl: "",
      env: {},
      listRepos: async () => [{ fullName: "rushi/repro-test", account: "rushi", installationId: 0 }],
      log: () => {},
    });
    const post = (path: string, form: Record<string, string> = {}, from: string | null = origin) =>
      server.fetch(new Request(`${origin}${path}`, { method: "POST", headers: from ? { origin: from } : {}, body: new URLSearchParams(form) }));
    return { store, server, post };
  }

  test("pick a repo → project created, named after the repo, no Sentry needed", async () => {
    const { server, post, store } = setup();
    const page = await (await server.fetch(new Request(`${origin}/projects/new`))).text();
    expect(page).toContain("Connect a repo");
    expect(page).toContain('value="rushi/repro-test" checked');
    expect(page).not.toContain('name="name"');
    const res = await post("/projects", { repo: "rushi/repro-test" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${origin}/projects/repro-test`);
    expect(await store.projects.get("repro-test")).toMatchObject({ name: "repro-test", repo: "rushi/repro-test", sentry: null });
  });

  test("the same repo name from another owner gets a number", async () => {
    const store = memoryStore(ghApp);
    const server = createServer({
      store,
      publicUrl: origin,
      webhookUrl: "",
      env: {},
      listRepos: async () => [
        { fullName: "rushi/app", account: "rushi", installationId: 0 },
        { fullName: "acme/app", account: "acme", installationId: 0 },
      ],
      log: () => {},
    });
    const post = (repo: string) => server.fetch(new Request(`${origin}/projects`, { method: "POST", headers: { origin }, body: new URLSearchParams({ repo }) }));
    await post("rushi/app");
    const res = await post("acme/app");
    expect(res.headers.get("location")).toBe(`${origin}/projects/app-2`);
    expect((await store.projects.list()).map((p) => p.name)).toEqual(["app", "app-2"]);
    // Picking a repo that already has a project just opens it.
    expect((await post("rushi/app")).headers.get("location")).toBe(`${origin}/projects/app`);
  });

  test("cross-site posts and unconnected repos are refused", async () => {
    const { post, store } = setup();
    expect((await post("/projects", { repo: "rushi/repro-test" }, "https://evil.example")).status).toBe(403);
    expect((await post("/projects", { repo: "rushi/repro-test" }, null)).status).toBe(403);
    expect((await post("/projects", { repo: "someone/else" })).status).toBe(400);
    expect(await store.projects.list()).toHaveLength(0);
  });

  test("Sentry is linked later, from the project page", async () => {
    const { server, post, store } = setup();
    await post("/projects", { repo: "rushi/repro-test" });
    const page = await (await server.fetch(new Request(`${origin}/projects/repro-test`))).text();
    expect(page).toContain('href="/projects/repro-test/sentry"');
    expect(page).toContain("Add connector");
    expect(page.toLowerCase()).toContain("optional");
    // No Sentry org connected yet: the link page says so instead of failing.
    expect(await (await server.fetch(new Request(`${origin}/projects/repro-test/sentry`))).text()).toContain("Connect Sentry first");
    await store.sentry.save({ installationId: "i", org: "self-mcf", token: "t", refreshToken: "r", expiresAt: "2099-01-01T00:00:00Z" });
    expect((await post("/projects/repro-test/sentry", { org: "self-mcf", sproject: "shoplite", env: "production" })).status).toBe(303);
    expect((await store.projects.get("repro-test"))!.sentry).toEqual({ org: "self-mcf", project: "shoplite", environment: "production" });
    expect((await post("/projects/repro-test/sentry", { org: "not-connected", sproject: "x" })).status).toBe(400);
  });

  test("project page shows connectors, recent issues and the latest check; pause and disconnect work", async () => {
    const { server, post, store } = setup();
    await post("/projects", { repo: "rushi/repro-test" });
    await store.projects.save({ ...(await store.projects.get("repro-test"))!, sentry: { org: "self-mcf", project: "shoplite", environment: null } });
    await store.checks.record({ ...checkRecordFrom({ status: "clear", report, evidence }, issue), repo: "rushi/repro-test", verdict: "reproduced" });
    const html = await (await server.fetch(new Request(`${origin}/projects/repro-test`))).text();
    expect(html).toContain("Checking new issues");
    expect(html).toContain("self-mcf");
    expect(html).toContain("Can&#39;t add the hoodie");
    expect(html).toContain("Reproduced");
    expect(html).toContain("No Repro replied");
    expect(html).toContain("#7 · matched in Sentry");
    expect(html).toContain("at handle (server.ts:87)");
    expect(html).toContain("Open in Sentry");

    expect(html).not.toContain("Link Sentry <span"); // already linked: no optional button
    await post("/projects/repro-test/pause");
    expect((await store.projects.get("repro-test"))!.paused).toBe(true);
    await post("/projects/repro-test/sentry/disconnect");
    expect((await store.projects.get("repro-test"))!.sentry).toBeNull();
    expect(await (await server.fetch(new Request(`${origin}/`))).text()).toContain("Paused");
  });

  test("activity lists checks across projects; unknown projects 404", async () => {
    const { server, store } = setup();
    await store.checks.record(checkRecordFrom({ status: "needs-info", report, missing: ["steps"], question: "q" }, issue));
    const html = await (await server.fetch(new Request(`${origin}/activity`))).text();
    expect(html).toContain("Asked 1 question");
    expect(html).toContain("rushi/repro-test");
    expect((await server.fetch(new Request(`${origin}/projects/nope`))).status).toBe(404);
  });
});

test("reproduction can be switched off per project, and back on", async () => {
  const ghApp = { id: 1, slug: "s", name: "n", htmlUrl: "", clientId: "", clientSecret: "", webhookSecret: "w", privateKey: "", webhookUrl: "" };
  const origin = "http://localhost:8787";
  const store = memoryStore(ghApp);
  const server = createServer({ store, publicUrl: origin, webhookUrl: "", env: {}, listRepos: async () => [{ fullName: "rushi/repro-test", account: "rushi", installationId: 0 }], log: () => {} });
  const post = (path: string, form: Record<string, string> = {}) => server.fetch(new Request(`${origin}${path}`, { method: "POST", headers: { origin }, body: new URLSearchParams(form) }));
  await post("/projects", { repo: "rushi/repro-test" });
  const on = await (await server.fetch(new Request(`${origin}/projects/repro-test`))).text();
  expect(on).toContain('role="switch" aria-checked="true"');
  await post("/projects/repro-test/reproduction/off");
  expect((await store.projects.get("repro-test"))!.reproduce).toBe(false);
  expect(await (await server.fetch(new Request(`${origin}/projects/repro-test`))).text()).toContain('aria-checked="false"');
  await post("/projects/repro-test/reproduction/on");
  expect((await store.projects.get("repro-test"))!.reproduce).toBe(true);
});
