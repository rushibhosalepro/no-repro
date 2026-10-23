import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { parseConfig } from "../src/core/config.ts";
import { buildManifest, exchangeManifestCode } from "../src/server/app.ts";
import { createServer, withServerModel, type IssueJob } from "../src/server/index.ts";
import { memoryStore, type AppCredentials } from "../src/server/store.ts";
import { KeyedQueue, verifySignature } from "../src/server/webhook.ts";

const app: AppCredentials = {
  id: 1,
  slug: "no-repro-ab12",
  name: "No Repro ab12",
  htmlUrl: "https://github.com/apps/no-repro-ab12",
  clientId: "Iv1.x",
  clientSecret: "cs",
  webhookSecret: "whsec",
  privateKey: "pem",
  webhookUrl: "https://smee.io/abc",
};
const sign = (body: string, secret = app.webhookSecret) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

function server(initial: AppCredentials | null = app) {
  const jobs: IssueJob[] = [];
  const store = memoryStore(initial);
  const s = createServer({
    store,
    publicUrl: "http://localhost:8787",
    webhookUrl: "https://smee.io/abc",
    env: {},
    processIssue: async (job) => void jobs.push(job),
    listRepos: async () => [{ fullName: "rushi/shoplite", account: "rushi", installationId: 42 }],
    fetchImpl: (async () =>
      Response.json({ id: 9, slug: "no-repro-new", name: "No Repro new", html_url: "https://github.com/apps/no-repro-new", client_id: "c", client_secret: "s", webhook_secret: "w", pem: "k" })) as unknown as typeof fetch,
    log: () => {},
  });
  return { ...s, jobs, store };
}

function delivery(event: string, payload: object, signature?: string) {
  const body = JSON.stringify(payload);
  return new Request("http://localhost:8787/webhook", {
    method: "POST",
    headers: { "x-github-event": event, "x-hub-signature-256": signature ?? sign(body) },
    body,
  });
}

const issuePayload = {
  action: "opened",
  installation: { id: 42 },
  repository: { full_name: "rushi/shoplite" },
  sender: { login: "asha", type: "User" },
  issue: { number: 7, title: "Search broken", body: "", user: { login: "asha" }, labels: [] },
};

describe("webhook", () => {
  test("signature check", () => {
    expect(verifySignature("s", "body", sign("body", "s"))).toBe(true);
    expect(verifySignature("s", "body", sign("other", "s"))).toBe(false);
    expect(verifySignature("s", "body", null)).toBe(false);
  });

  test("signed issue event is accepted at once and queued with the installation", async () => {
    const s = server();
    const res = await s.fetch(delivery("issues", issuePayload));
    expect(res.status).toBe(202);
    await s.queue.idle();
    expect(s.jobs).toHaveLength(1);
    expect(s.jobs[0]).toMatchObject({ installationId: 42, owner: "rushi", repo: "shoplite", event: { eventName: "issues", action: "opened" } });
  });

  test("forged or unsigned deliveries are rejected", async () => {
    const s = server();
    expect((await s.fetch(delivery("issues", issuePayload, sign("x", "wrong")))).status).toBe(401);
    expect(s.jobs).toHaveLength(0);
  });

  test("events caused by bots (including our own comments) are ignored", async () => {
    const s = server();
    const res = await s.fetch(delivery("issue_comment", { ...issuePayload, action: "created", sender: { login: "no-repro-ab12[bot]", type: "Bot" } }));
    expect(res.status).toBe(204);
    await s.queue.idle();
    expect(s.jobs).toHaveLength(0);
  });

  test("no app yet means webhooks are refused", async () => {
    expect((await server(null).fetch(delivery("issues", issuePayload))).status).toBe(503);
  });
});

describe("pages", () => {
  test("before setup, home offers the one-time setup; it posts the manifest to GitHub", async () => {
    const s = server(null);
    const home = await s.fetch(new Request("http://localhost:8787/"));
    expect(home.status).toBe(200);
    const page = await home.text();
    expect(page).toContain("Welcome to No Repro");
    expect(page).toContain('href="http://localhost:8787/setup"');
    const html = await (await s.fetch(new Request("http://localhost:8787/setup"))).text();
    expect(html).toContain("https://github.com/settings/apps/new?state=");
    expect(html).toContain("&quot;issues&quot;:&quot;write&quot;");
    expect(html).not.toContain("<input id=\"name\"");
  });

  test("NOREPRO_SETUP_KEY keeps strangers out of setup", async () => {
    const s = createServer({ store: memoryStore(null), publicUrl: "http://x", webhookUrl: "https://smee.io/a", env: { NOREPRO_SETUP_KEY: "k" }, log: () => {} });
    expect((await s.fetch(new Request("http://x/setup"))).status).toBe(503);
    expect(await (await s.fetch(new Request("http://x/setup?key=k"))).text()).toContain("settings/apps/new");
  });

  test("after setup, home lists projects and offers New project", async () => {
    const html = await (await server().fetch(new Request("http://localhost:8787/"))).text();
    expect(html).toContain("<h1>Projects</h1>");
    expect(html).toContain('href="/projects/new"');
  });

  test("the repo step lists connected repos and links to GitHub to add more", async () => {
    const html = await (await server().fetch(new Request("http://localhost:8787/projects/new?name=Shop&step=repo"))).text();
    expect(html).toContain('value="rushi/shoplite"');
    expect(html).toContain("https://github.com/apps/no-repro-ab12/installations/new");
  });

  test("setup callback needs the state we issued, then saves the app", async () => {
    const s = server(null);
    const bad = await s.fetch(new Request("http://localhost:8787/setup/callback?code=abc&state=forged"));
    expect(bad.status).toBe(400);

    const home = await (await s.fetch(new Request("http://localhost:8787/setup"))).text();
    const state = home.match(/state=([0-9a-f]+)/)![1];
    const ok = await s.fetch(new Request(`http://localhost:8787/setup/callback?code=abc&state=${state}`));
    expect(ok.status).toBe(302);
    expect(ok.headers.get("location")).toBe("https://github.com/apps/no-repro-new/installations/new");
    expect(s.store.app?.slug).toBe("no-repro-new");
    expect(s.store.app?.webhookUrl).toBe("https://smee.io/abc");
  });
});

test("manifest asks only for what the agent uses", () => {
  const m = buildManifest({ name: "No Repro", publicUrl: "https://norepro.example", webhookUrl: "https://norepro.example/webhook" });
  expect(m.default_permissions).toEqual({ issues: "write", contents: "read", metadata: "read", actions: "write" });
  expect(m.default_events).toEqual(["issues", "issue_comment", "workflow_run"]);
  expect(m.redirect_url).toBe("https://norepro.example/setup/callback");
  expect(m.public).toBe(true);
});

test("manifest exchange maps GitHub's fields", async () => {
  const f = (async () => Response.json({ id: 3, slug: "s", name: "n", html_url: "h", client_id: "c", client_secret: "cs", webhook_secret: "w", pem: "p" })) as unknown as typeof fetch;
  expect(await exchangeManifestCode("code", "https://smee.io/x", f)).toMatchObject({ id: 3, privateKey: "p", webhookSecret: "w", webhookUrl: "https://smee.io/x" });
});

test("the host's env picks the model, not the repo", () => {
  const repoConfig = parseConfig("app:\n  name: X\nprovider: anthropic\nmodel: claude-opus-5-5\n");
  expect(withServerModel(repoConfig, {})).toMatchObject({ provider: "openrouter", model: "anthropic/claude-opus-5.5" });
  expect(withServerModel(repoConfig, { NOREPRO_MODEL: "anthropic/claude-haiku-5.5" }).model).toBe("anthropic/claude-haiku-5.5");
});

test("queue runs one issue's jobs in order and keeps going after a failure", async () => {
  const order: string[] = [];
  const q = new KeyedQueue();
  void q.push("a", async () => { await Bun.sleep(20); order.push("a1"); });
  void q.push("a", async () => { throw new Error("boom"); });
  void q.push("a", async () => void order.push("a3"));
  void q.push("b", async () => void order.push("b1"));
  await q.idle();
  expect(order).toEqual(["b1", "a1", "a3"]);
});
