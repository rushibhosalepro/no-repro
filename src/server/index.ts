// The No Repro server: hosts the GitHub App. Users connect a repo by installing the app;
// GitHub then sends issue events here, and each issue is triaged in the background.
//
//   bun src/server/index.ts      (or: bun run server)
//
// First start: open the printed URL and click "Create GitHub App" (one time, for the host).
// After that the home page shows the "Install on GitHub" button that everyone uses.
import { randomBytes } from "node:crypto";
import SmeeClient from "smee-client";
import { DEFAULT_MODELS, type NoReproConfig, type Provider } from "../core/config.ts";
import { reportExtractor } from "../core/clarity.ts";
import { localize } from "../core/localize.ts";
import { modelFor } from "../core/providers/index.ts";
import { GitHubCodeHost } from "../github/code.ts";
import { renderError } from "../core/render.ts";
import type { BugReport } from "../core/report.ts";
import { isBot, type IssueEvent } from "../github/event.ts";
import { IssueHandle } from "../github/repo.ts";
import { runOnIssue } from "../github/run.ts";
import { GitHubActions } from "../repro/actions.ts";
import { startReproduction, type ClearOutcome, type RunStore } from "../repro/index.ts";
import { buildManifest, exchangeManifestCode, installationOctokit, installUrl, listConnectedRepos, loadRepoConfig, type ConnectedRepo } from "./app.ts";
import { homePage, installedPage, messagePage, setupRedirectPage } from "./pages.ts";
import { fileStore, type AppCredentials, type Store } from "./store.ts";
import { defaultProcessRun, runEventFrom, type RunEventJob } from "./runs.ts";
import { KeyedQueue, verifySignature } from "./webhook.ts";

export interface IssueJob {
  app: AppCredentials;
  installationId: number;
  owner: string;
  repo: string;
  event: IssueEvent;
}

export interface ServerDeps {
  store: Store;
  publicUrl: string;
  /** Where GitHub should deliver webhooks when the app is first created. */
  webhookUrl: string;
  env: Record<string, string | undefined>;
  processIssue?: (job: IssueJob) => Promise<void>;
  processRun?: (job: RunEventJob) => Promise<void>;
  listRepos?: (app: AppCredentials) => Promise<ConnectedRepo[]>;
  fetchImpl?: typeof fetch;
  log?: (msg: string) => void;
}

const MAX_BODY = 5 * 1024 * 1024; // GitHub caps payloads at 25 MB; issues are far smaller.

/** The host pays for the model, so the host picks it (env), not each repo. */
export function withServerModel(config: NoReproConfig, env: Record<string, string | undefined>): NoReproConfig {
  const provider = (env.NOREPRO_PROVIDER ?? "openrouter") as Provider;
  return { ...config, provider, model: env.NOREPRO_MODEL ?? DEFAULT_MODELS[provider] };
}

export async function defaultProcessIssue(job: IssueJob, runs: RunStore, env: Record<string, string | undefined>, log: (m: string) => void): Promise<void> {
  const octokit = installationOctokit(job.app, job.installationId);
  const handle = new IssueHandle(octokit, job.owner, job.repo, job.event.issue.number);
  let config: NoReproConfig;
  try {
    config = withServerModel(await loadRepoConfig(octokit, job.owner, job.repo), env);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`${job.owner}/${job.repo}#${job.event.issue.number}: bad config: ${msg}`);
    await handle.upsertComment(renderError({ runs: 0, status: "error" }, `.github/norepro.yml couldn't be used:\n${msg}`));
    return;
  }
  const model = modelFor(config, env);
  const code = new GitHubCodeHost(octokit, job.owner, job.repo);
  const where = { owner: job.owner, repo: job.repo, issue: job.event.issue.number, installationId: job.installationId };
  const actions = new GitHubActions(octokit, job.owner, job.repo);
  const agent = {
    extract: reportExtractor(model),
    locate: (report: BugReport) => localize(report, code, model, config),
    reproduce: (outcome: ClearOutcome) => startReproduction(outcome, config, where, { host: code, model, actions, store: runs }),
  };
  await runOnIssue(handle, job.event, config, agent, (m) => log(`${job.owner}/${job.repo} ${m}`));
}

export function createServer(deps: ServerDeps) {
  const log = deps.log ?? ((m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`));
  const queue = new KeyedQueue((key, err) => log(`${key}: failed: ${err instanceof Error ? err.message : err}`));
  const runJob = deps.processIssue ?? ((job: IssueJob) => defaultProcessIssue(job, deps.store.runs, deps.env, log));
  const runEvent = deps.processRun ?? ((job: RunEventJob) => defaultProcessRun(job, deps.store.runs, deps.env, log));
  const listRepos = deps.listRepos ?? listConnectedRepos;
  const pendingStates = new Set<string>(); // protects the setup callback from forged requests
  const html = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });

  async function handleWebhook(req: Request): Promise<Response> {
    const app = await deps.store.loadApp();
    if (!app) {
      log("webhook refused: the GitHub App isn't set up yet");
      return new Response("app not set up", { status: 503 });
    }
    const body = await req.text();
    if (body.length > MAX_BODY) return new Response("too large", { status: 413 });
    if (!verifySignature(app.webhookSecret, body, req.headers.get("x-hub-signature-256"))) {
      log("webhook refused: bad signature");
      return new Response("bad signature", { status: 401 });
    }

    const eventName = req.headers.get("x-github-event") ?? "";
    const payload = JSON.parse(body);
    if (eventName === "installation" || eventName === "installation_repositories") {
      log(`installation ${payload.action} by ${payload.sender?.login}`);
      return new Response(null, { status: 204 });
    }
    if (eventName === "workflow_run") {
      // Checked before the bot filter: our own dispatched runs are sent by our bot.
      const run = runEventFrom(payload, app);
      if (!run) return new Response(null, { status: 204 });
      log(`${run.owner}/${run.repo}#${run.issue}: reproduction run ${run.action}`);
      void queue.push(`${run.owner}/${run.repo}#${run.issue}`, () => runEvent(run));
      return new Response(null, { status: 202 });
    }
    // Our own comments and label changes come back as events; never react to bots.
    if (!payload.issue || !payload.installation?.id || isBot(payload.sender)) return new Response(null, { status: 204 });

    const [owner, repo] = String(payload.repository?.full_name ?? "").split("/");
    if (!owner || !repo) return new Response(null, { status: 204 });
    const job: IssueJob = {
      app,
      installationId: payload.installation.id,
      owner,
      repo,
      event: { eventName, action: payload.action, issue: payload.issue, comment: payload.comment, label: payload.label },
    };
    log(`${owner}/${repo}#${payload.issue.number}: ${eventName}.${payload.action} queued`);
    void queue.push(`${owner}/${repo}#${payload.issue.number}`, () => runJob(job));
    return new Response(null, { status: 202 }); // answer GitHub now; the work runs in the background
  }

  /**
   * First run only: register No Repro on GitHub. The host lands directly on GitHub's confirm
   * screen; there's nothing to fill in. If NOREPRO_SETUP_KEY is set (do this when deployed),
   * /setup?key=... is required so a stranger can't register the app first.
   */
  async function handleSetup(url: URL): Promise<Response> {
    if (await deps.store.loadApp()) return Response.redirect(`${deps.publicUrl}/`, 302);
    const key = deps.env.NOREPRO_SETUP_KEY;
    if (key && url.searchParams.get("key") !== key) {
      return html(messagePage("Not set up yet", "No Repro isn't ready yet. Please check back soon."), 503);
    }
    const state = randomBytes(16).toString("hex");
    pendingStates.add(state);
    // GitHub App names are global, so add a short suffix to avoid collisions.
    const name = `No Repro ${randomBytes(2).toString("hex")}`;
    return html(setupRedirectPage(buildManifest({ name, publicUrl: deps.publicUrl, webhookUrl: deps.webhookUrl }), state));
  }

  async function handleHome(): Promise<Response> {
    const app = await deps.store.loadApp();
    // Before the app is registered, Connect goes through the one-time GitHub setup first.
    if (!app) return html(homePage(`${deps.publicUrl}/setup`, []));
    const repos = await listRepos(app).catch((err) => {
      log(`couldn't list repos: ${err instanceof Error ? err.message : err}`);
      return null;
    });
    return html(homePage(installUrl(app), repos));
  }

  async function handleSetupCallback(url: URL): Promise<Response> {
    if (await deps.store.loadApp()) return Response.redirect(`${deps.publicUrl}/`, 302);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state") ?? "";
    if (!code || !pendingStates.has(state)) {
      return html(messagePage("Setup link expired", "Open the home page again to restart setup."), 400);
    }
    pendingStates.delete(state);
    const app = await exchangeManifestCode(code, deps.webhookUrl, deps.fetchImpl);
    await deps.store.saveApp(app);
    log(`GitHub App "${app.name}" created (${app.htmlUrl})`);
    // Carry on with what the click was for: picking a repo to connect.
    return Response.redirect(installUrl(app), 302);
  }

  async function fetchHandler(req: Request): Promise<Response> {
    const url = new URL(req.url);
    try {
      if (req.method === "POST" && url.pathname === "/webhook") return await handleWebhook(req);
      if (req.method === "GET" && url.pathname === "/") return await handleHome();
      if (req.method === "GET" && url.pathname === "/setup") return await handleSetup(url);
      if (req.method === "GET" && url.pathname === "/setup/callback") return await handleSetupCallback(url);
      if (req.method === "GET" && url.pathname === "/installed") return html(installedPage());
      if (req.method === "GET" && url.pathname === "/health") return Response.json({ ok: true });
      return new Response("not found", { status: 404 });
    } catch (err) {
      log(`${req.method} ${url.pathname}: ${err instanceof Error ? err.message : err}`);
      return html(messagePage("Something went wrong", err instanceof Error ? err.message : String(err)), 500);
    }
  }

  return { fetch: fetchHandler, queue };
}

/** Local dev has no public URL, so GitHub delivers to a smee.io channel that forwards to this machine. */
async function resolveWebhookUrl(store: Store, env: Record<string, string | undefined>, publicUrl: string): Promise<string> {
  const app = await store.loadApp();
  if (app) return app.webhookUrl;
  if (env.NOREPRO_PUBLIC_URL) return `${publicUrl}/webhook`;
  const saved = await store.loadDevChannel();
  if (saved) return saved;
  const channel = await SmeeClient.createChannel();
  await store.saveDevChannel(channel);
  return channel;
}

if (import.meta.main) {
  const env = process.env;
  const port = Number(env.PORT ?? 8787);
  const publicUrl = (env.NOREPRO_PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, "");
  const store = fileStore();
  const webhookUrl = await resolveWebhookUrl(store, env, publicUrl);

  const server = createServer({ store, publicUrl, webhookUrl, env });
  Bun.serve({ port, fetch: server.fetch });

  if (webhookUrl.startsWith("https://smee.io/")) {
    const smee = new SmeeClient({ source: webhookUrl, target: `http://localhost:${port}/webhook`, logger: { info: () => {}, error: console.error } });
    await smee.start();
    console.log(`Webhooks: ${webhookUrl} → this machine`);
  }
  const app = await store.loadApp();
  console.log(`No Repro server on ${publicUrl}`);
  console.log(app ? `Connect a repo: ${publicUrl}` : `First run: open ${publicUrl}, then click "Create GitHub App" on GitHub (one time).`);
  console.log(`Model: ${withServerModel({ provider: "openrouter" } as NoReproConfig, env).model}`);
}
