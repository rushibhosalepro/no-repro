import { describe, expect, test } from "bun:test";
import { parseConfig } from "../src/core/config.ts";
import { framePaths } from "../src/core/localize.ts";
import type { StructuredModel } from "../src/core/model.ts";
import { renderOutcome } from "../src/core/render.ts";
import type { BugReport } from "../src/core/report.ts";
import { describeEvidence, findEvidence, findSentryLink, toEvidence, type Evidence } from "../src/evidence/index.ts";
import { completeInstall, freshInstallation, SentryClient, sentryAppFromEnv, sentryInstallUrl, type SentryEvent, type SentryIssue } from "../src/evidence/sentry.ts";
import { chooseRange, type HistoryHost } from "../src/repro/bisect.ts";
import { createServer } from "../src/server/index.ts";
import { memoryStore } from "../src/server/store.ts";

const app = { clientId: "cid", clientSecret: "csecret", slug: "no-repro-abc" };

/** Fake fetch: answers by "METHOD path" and records every call. */
function fakeFetch(routes: Record<string, (body: any) => { status?: number; json: unknown }>) {
  const calls: Array<{ method: string; path: string; body: any; auth: string | null }> = [];
  const impl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const headers = new Headers(init?.headers);
    calls.push({ method, path: url.pathname + url.search, body, auth: headers.get("authorization") });
    const key = Object.keys(routes).find((k) => `${method} ${url.pathname}`.startsWith(k));
    if (!key) return new Response("not found", { status: 404 });
    const { status = 200, json } = routes[key]!(body);
    return Response.json(json, { status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const issue: SentryIssue = {
  id: "4401",
  shortId: "SHOPLITE-1A",
  title: "TypeError: Cannot read properties of undefined (reading 'price')",
  culprit: "totals(server)",
  permalink: "https://acme.sentry.io/issues/4401/",
  count: "37",
  userCount: 12,
  firstSeen: "2026-10-18T09:00:00Z",
  lastSeen: "2026-10-21T08:00:00Z",
  firstRelease: { version: "1.4.0" },
};
const event: SentryEvent = {
  entries: [
    {
      type: "exception",
      data: {
        values: [
          {
            type: "TypeError",
            value: "Cannot read properties of undefined (reading 'price')",
            stacktrace: {
              frames: [
                { filename: "node:internal/process", lineNo: 1, inApp: false },
                { filename: "app:///server.ts", lineNo: 120, function: "handle", inApp: true },
                { filename: "app:///server.ts", lineNo: 48, function: "totals", inApp: true },
              ],
            },
          },
        ],
      },
    },
    {
      type: "breadcrumbs",
      data: { values: [{ category: "navigation", message: "/cart" }, { category: "fetch", data: { method: "PATCH", url: "/api/cart/glasses", status_code: 500 } }] },
    },
    { type: "request", data: { url: "https://shop.example.com/api/cart/glasses", method: "PATCH" } },
  ],
  tags: [
    { key: "browser", value: "Chrome 141" },
    { key: "os", value: "Android 16" },
    { key: "environment", value: "production" },
  ],
  release: { version: "1.4.2" },
};

describe("Sentry integration install", () => {
  test("install URL and env config", () => {
    expect(sentryInstallUrl(app)).toBe("https://sentry.io/sentry-apps/no-repro-abc/external-install/");
    expect(sentryAppFromEnv({ SENTRY_CLIENT_ID: "a", SENTRY_CLIENT_SECRET: "b" })).toBeNull();
  });

  test("code → token, install verified, org found from the token when the redirect has none", async () => {
    const f = fakeFetch({
      "POST /api/0/sentry-app-installations/inst-1/authorizations/": () => ({ json: { token: "tok", refreshToken: "ref", expiresAt: "2026-10-21T18:00:00Z" } }),
      "PUT /api/0/sentry-app-installations/inst-1/": () => ({ json: {} }),
      "GET /api/0/organizations/": () => ({ json: [{ slug: "acme" }] }),
    });
    const inst = await completeInstall(app, "inst-1", "code-1", null, f.impl);
    expect(inst).toEqual({ installationId: "inst-1", org: "acme", token: "tok", refreshToken: "ref", expiresAt: "2026-10-21T18:00:00Z" });
    expect(f.calls[0]!.body).toEqual({ grant_type: "authorization_code", code: "code-1", client_id: "cid", client_secret: "csecret" });
    expect(f.calls[1]).toMatchObject({ method: "PUT", body: { status: "installed" }, auth: "Bearer tok" });
  });

  test("tokens are refreshed only near expiry", async () => {
    const f = fakeFetch({ "POST /api/0/sentry-app-installations/": () => ({ json: { token: "new", refreshToken: "ref2", expiresAt: "2026-10-22T02:00:00Z" } }) });
    const inst = { installationId: "inst-1", org: "acme", token: "old", refreshToken: "ref", expiresAt: "2026-10-21T18:00:00Z" };
    expect(await freshInstallation(app, inst, f.impl, Date.parse("2026-10-21T12:00:00Z"))).toBe(inst);
    const refreshed = await freshInstallation(app, inst, f.impl, Date.parse("2026-10-21T17:58:00Z"));
    expect(refreshed.token).toBe("new");
    expect(f.calls[0]!.body).toMatchObject({ grant_type: "refresh_token", refresh_token: "ref" });
  });

  test("a revoked installation says so", async () => {
    const f = fakeFetch({ "GET /api/0/organizations/acme/issues/": () => ({ status: 401, json: {} }) });
    await expect(new SentryClient("tok", "acme", f.impl).issue("1")).rejects.toThrow(/uninstalled/);
  });
});

describe("evidence from an event", () => {
  const e = toEvidence(issue, event, "search");

  test("in-app frames only, innermost first, paths cleaned", () => {
    expect(e.frames).toEqual([
      { file: "server.ts", line: 48, function: "totals" },
      { file: "server.ts", line: 120, function: "handle" },
    ]);
  });

  test("error, breadcrumbs, environment and impact", () => {
    expect(e.error).toEqual({ type: "TypeError", value: "Cannot read properties of undefined (reading 'price')" });
    expect(e.breadcrumbs).toEqual([
      { category: "navigation", message: "/cart" },
      { category: "fetch", message: "PATCH /api/cart/glasses → 500" },
    ]);
    expect(e).toMatchObject({ browser: "Chrome 141", os: "Android 16", release: "1.4.2", environment: "production", url: "https://shop.example.com/api/cart/glasses" });
    expect(e.issue).toMatchObject({ events: 37, users: 12, firstRelease: "1.4.0" });
  });

  test("prompt summary is fenced as data", () => {
    const text = describeEvidence(e);
    expect(text.startsWith('<production_evidence source="sentry">')).toBe(true);
    expect(text).toContain("server.ts:48 in totals");
    expect(text).toContain("[fetch] PATCH /api/cart/glasses → 500");
  });
});

describe("matching a GitHub issue to Sentry", () => {
  test("links in both URL styles", () => {
    expect(findSentryLink("see https://acme.sentry.io/issues/4401/?project=1")).toEqual({ org: "acme", issueId: "4401" });
    expect(findSentryLink("https://sentry.io/organizations/acme/issues/77/")).toEqual({ org: "acme", issueId: "77" });
    expect(findSentryLink("no link")).toBeNull();
  });

  const thread = { title: "Cart crashes when changing quantity", body: "PATCH fails", replies: [] };
  const routes = {
    "GET /api/0/projects/acme/shoplite/": () => ({ json: { id: "9" } }),
    "GET /api/0/organizations/acme/issues/4401/events/latest/": () => ({ json: event }),
    "GET /api/0/organizations/acme/issues/4401/": () => ({ json: issue }),
    "GET /api/0/organizations/acme/issues/": () => ({ json: [{ ...issue, firstRelease: undefined }, { ...issue, id: "5500", title: "Unrelated" }] }),
  };
  const model = (issueId: string | null): StructuredModel => ({ generate: async () => ({ issueId, reason: "" }) as never });

  test("a pasted link is used directly, without asking the model", async () => {
    const f = fakeFetch(routes);
    let asked = false;
    const m: StructuredModel = { generate: async () => ((asked = true), { issueId: null, reason: "" }) as never };
    const e = await findEvidence({ ...thread, body: "https://acme.sentry.io/issues/4401/" }, new SentryClient("t", "acme", f.impl), "shoplite", m);
    expect(e).toMatchObject({ matchedBy: "link", issue: { shortId: "SHOPLITE-1A" } });
    expect(asked).toBe(false);
  });

  test("otherwise the model picks among recent issues", async () => {
    const f = fakeFetch(routes);
    const e = await findEvidence(thread, new SentryClient("t", "acme", f.impl), "shoplite", model("4401"));
    expect(e).toMatchObject({ matchedBy: "search", issue: { id: "4401", firstRelease: "1.4.0" } }); // from the full issue, not the list
    expect(f.calls.some((c) => c.path.includes("project=9"))).toBe(true);
  });

  test("each candidate carries where it failed and what the user did, so vague reports can match", async () => {
    const withRoute = { ...event, tags: [...event.tags, { key: "route", value: "PATCH /api/cart/:id" }] };
    const f = fakeFetch({ ...routes, "GET /api/0/organizations/acme/issues/4401/events/latest/": () => ({ json: withRoute }) });
    let prompt = "";
    const m: StructuredModel = { generate: async (req) => ((prompt = req.user), { issueId: "4401", reason: "" }) as never };
    await findEvidence(thread, new SentryClient("t", "acme", f.impl), "shoplite", m);
    expect(prompt).toContain("where: PATCH /api/cart/:id");
    expect(prompt).toContain("PATCH /api/cart/glasses → 500");
  });

  test("no confident match, or an id we never offered, means no evidence", async () => {
    expect(await findEvidence(thread, new SentryClient("t", "acme", fakeFetch(routes).impl), "shoplite", model(null))).toBeNull();
    expect(await findEvidence(thread, new SentryClient("t", "acme", fakeFetch(routes).impl), "shoplite", model("999"))).toBeNull();
  });
});

describe("evidence used downstream", () => {
  const e: Evidence = toEvidence(issue, event, "search");

  test("stack-trace files are matched to repo paths", () => {
    expect(framePaths(e, ["server.ts", "pages.ts"])).toEqual(["server.ts"]);
    expect(framePaths({ ...e, frames: [{ file: "src/app/cart.ts", line: 1, function: null }] }, ["apps/web/src/app/cart.ts"])).toEqual(["apps/web/src/app/cart.ts"]);
  });

  test("bisect starts from the release before Sentry first saw it", async () => {
    const report = { lastWorkingVersion: null } as BugReport;
    const history: HistoryHost = {
      resolveRef: async (r) => (r === "v1.4.0" ? "r".repeat(40) : null),
      latestTagBefore: async (sha) => (sha === "r".repeat(40) ? { name: "v1.3.0", sha: "g".repeat(40) } : null),
      parentOf: async () => null,
      commitsBetween: async () => 9,
      changeIn: async () => null,
    };
    const range = await chooseRange(report, { sha: "h".repeat(40), filesRead: 1, suspects: [] }, history, e);
    expect(range).toMatchObject({ good: "g".repeat(40), goodLabel: "v1.3.0, the release before Sentry first saw this in 1.4.0", commits: 9 });
  });

  test("comment shows production impact and a Sentry link", () => {
    const report: BugReport = { title: "Cart crash", page: "/cart", steps: ["x"], expected: "y", actual: "z", environment: { device: "mobile", browser: null }, testValues: [], lastWorkingVersion: null, checkable: true, notCheckableReason: null, question: null };
    const body = renderOutcome({ status: "clear", report, evidence: e }, { runs: 1, status: "clear" });
    expect(body).toContain("| Production | 37 events · 12 users · first seen in 1.4.0 · `SHOPLITE-1A` |");
    expect(body).toContain("[View in Sentry](https://acme.sentry.io/issues/4401/)");
  });
});

describe("server routes", () => {
  const ghApp = { id: 1, slug: "no-repro-ab12", name: "n", htmlUrl: "", clientId: "", clientSecret: "", webhookSecret: "w", privateKey: "", webhookUrl: "" };
  const env = { SENTRY_CLIENT_ID: "cid", SENTRY_CLIENT_SECRET: "csecret", SENTRY_INTEGRATION_SLUG: "no-repro-abc" };
  const f = fakeFetch({
    "POST /api/0/sentry-app-installations/inst-9/authorizations/": () => ({ json: { token: "tok", refreshToken: "r", expiresAt: "2026-10-21T18:00:00Z" } }),
    "PUT /api/0/sentry-app-installations/inst-9/": () => ({ json: {} }),
  });
  const store = memoryStore(ghApp);
  const server = createServer({ store, publicUrl: "http://localhost:8787", webhookUrl: "", env, fetchImpl: f.impl, listRepos: async () => [], log: () => {} });

  test("the Sentry link page offers Connect Sentry; connect goes to Sentry's install page", async () => {
    await store.projects.save({ id: "shop", name: "shop", repo: "rushi/shop", sentry: null, paused: false, createdAt: "" });
    const step = await (await server.fetch(new Request("http://localhost:8787/projects/shop/sentry"))).text();
    expect(step).toContain('href="http://localhost:8787/sentry/connect"');
    const res = await server.fetch(new Request("http://localhost:8787/sentry/connect"));
    expect(res.headers.get("location")).toBe("https://sentry.io/sentry-apps/no-repro-abc/external-install/");
  });

  test("callback stores the installation and lists the org", async () => {
    const res = await server.fetch(new Request("http://localhost:8787/sentry/callback?code=c&installationId=inst-9&orgSlug=acme"));
    expect(res.status).toBe(302);
    expect(await store.sentry.load("acme")).toMatchObject({ token: "tok", installationId: "inst-9" });
    const step = await (await server.fetch(new Request("http://localhost:8787/projects/shop/sentry"))).text();
    expect(step).toContain("<option selected>acme</option>");
  });

  test("an incomplete callback is refused", async () => {
    expect((await server.fetch(new Request("http://localhost:8787/sentry/callback?code=c"))).status).toBe(400);
  });

  test("repo config accepts a sentry section", () => {
    expect(parseConfig("app:\n  name: X\nsentry:\n  org: acme\n  project: shoplite\n").sentry).toEqual({ org: "acme", project: "shoplite" });
  });
});

test("frame paths from any platform match repo files", async () => {
  const { framePath } = await import("../src/evidence/index.ts");
  expect(framePath(String.raw`D:\projects\hackathons\repro-test\server.ts`)).toBe("projects/hackathons/repro-test/server.ts");
  expect(framePath("app:///src/cart.ts")).toBe("src/cart.ts");
  expect(framePath("./server.ts")).toBe("server.ts");
  expect(framePath("webpack://shop/./src/a.ts")).toBe("shop/./src/a.ts");
  const e = { frames: [{ file: framePath(String.raw`D:\projects\hackathons\repro-test\server.ts`), line: 87, function: "handle" }] } as any;
  expect(framePaths(e, ["server.ts", "pages.ts"])).toEqual(["server.ts"]);
});

test("a Sentry install redirected to the home page still connects", async () => {
  const ghApp = { id: 1, slug: "s", name: "n", htmlUrl: "", clientId: "", clientSecret: "", webhookSecret: "w", privateKey: "", webhookUrl: "" };
  const f = fakeFetch({
    "POST /api/0/sentry-app-installations/inst-7/authorizations/": () => ({ json: { token: "tok", refreshToken: "r", expiresAt: "2026-10-21T18:00:00Z" } }),
    "PUT /api/0/sentry-app-installations/inst-7/": () => ({ json: {} }),
  });
  const store = memoryStore(ghApp);
  const env = { SENTRY_CLIENT_ID: "cid", SENTRY_CLIENT_SECRET: "cs", SENTRY_INTEGRATION_SLUG: "no-repro" };
  const server = createServer({ store, publicUrl: "http://localhost:8787", webhookUrl: "", env, fetchImpl: f.impl, listRepos: async () => [], log: () => {} });
  const res = await server.fetch(new Request("http://localhost:8787/?code=c&installationId=inst-7&orgSlug=self-mcf"));
  expect(res.status).toBe(302);
  expect(await store.sentry.load("self-mcf")).toMatchObject({ installationId: "inst-7" });
});
