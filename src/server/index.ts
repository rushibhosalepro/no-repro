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
import { reportExtractor, type IssueThread } from "../core/clarity.ts";
import { findEvidence, type Evidence } from "../evidence/index.ts";
import { completeInstall, freshInstallation, SentryClient, sentryAppFromEnv, sentryInstallUrl } from "../evidence/sentry.ts";
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
import {
  activityPage,
  howItWorksPage,
  messagePage,
  newProjectPage,
  projectPage,
  projectsPage,
  sentryLinkPage,
  setupRedirectPage,
  signInPage,
  suggestProject,
  uniqueName,
  welcomePage,
  type SentryLinkView,
} from "./pages.ts";
import { fileStore, type AppCredentials, type SentryStore, type Store } from "./store.ts";
import { applyProject, checkRecordFrom, projectId, statsFor, type Project } from "./projects.ts";
import { defaultProcessRun, runEventFrom, type RunEventJob } from "./runs.ts";
import { KeyedQueue, verifySignature } from "./webhook.ts";
import { Admin } from "./admin.ts";
import { importSeed, syncWebhookUrl } from "./seed.ts";

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

/** A Sentry client for the repo's configured org, refreshing (and saving) its token when needed. */
async function sentryFor(
  config: NoReproConfig,
  store: SentryStore | undefined,
  env: Record<string, string | undefined>,
  log: (m: string) => void,
): Promise<SentryClient | null> {
  const app = sentryAppFromEnv(env);
  if (!config.sentry || !store || !app) return null;
  const saved = await store.load(config.sentry.org);
  if (!saved) {
    log(`sentry: org "${config.sentry.org}" hasn't installed the integration; skipping evidence`);
    return null;
  }
  const inst = await freshInstallation(app, saved);
  if (inst !== saved) await store.save(inst);
  return new SentryClient(inst.token, inst.org);
}

export async function defaultProcessIssue(job: IssueJob, store: Store, env: Record<string, string | undefined>, log: (m: string) => void): Promise<void> {
  const fullName = `${job.owner}/${job.repo}`;
  const project = await store.projects.byRepo(fullName);
  if (project?.paused) {
    log(`${fullName}#${job.event.issue.number}: project "${project.name}" is paused; skipping`);
    return;
  }
  // A public demo pays for every model call, so each repo gets a few checks an hour.
  const limit = Number(env.NOREPRO_MAX_CHECKS_PER_HOUR ?? 0);
  if (limit > 0) {
    const hourAgo = Date.now() - 3600_000;
    const recent = (await store.checks.list(fullName, 500)).filter((c) => c.number !== job.event.issue.number && Date.parse(c.checkedAt) > hourAgo);
    if (recent.length >= limit) {
      log(`${fullName}#${job.event.issue.number}: ${recent.length} issues checked in the last hour (limit ${limit}); skipping`);
      const handle = new IssueHandle(installationOctokit(job.app, job.installationId), job.owner, job.repo, job.event.issue.number);
      await handle.upsertComment(`## Automated triage: paused for now\n\nNo Repro has already checked ${recent.length} issues in this repo in the last hour, which is this demo's limit. Try again in a little while.`);
      return;
    }
  }
  const runs = store.runs;
  const sentryStore = store.sentry;
  const octokit = installationOctokit(job.app, job.installationId);
  const handle = new IssueHandle(octokit, job.owner, job.repo, job.event.issue.number);
  let config: NoReproConfig;
  try {
    config = applyProject(withServerModel(await loadRepoConfig(octokit, job.owner, job.repo), env), project);
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
  const sentry = await sentryFor(config, sentryStore, env, log);
  const agent = {
    extract: reportExtractor(model),
    evidence:
      sentry && config.sentry
        ? (thread: IssueThread) => findEvidence(thread, sentry, config.sentry!.project, model, project?.sentry?.environment ?? null)
        : undefined,
    locate: (report: BugReport, evidence?: Evidence | null) => localize(report, code, model, config, evidence),
    // The project can switch reproduction off; without a project it's on whenever the repo has the workflow.
    reproduce:
      project?.reproduce === false ? undefined : (outcome: ClearOutcome) => startReproduction(outcome, config, where, { host: code, model, actions, store: runs }),
  };
  const result = await runOnIssue(handle, job.event, config, agent, (m) => log(`${job.owner}/${job.repo} ${m}`));
  if (result.ran && "outcome" in result) {
    const i = job.event.issue;
    await store.checks.record(
      checkRecordFrom(result.outcome, {
        repo: fullName,
        number: i.number,
        title: i.title,
        url: i.html_url ?? `https://github.com/${fullName}/issues/${i.number}`,
        openedAt: i.created_at ?? new Date().toISOString(),
      }),
    );
  }
}

export function createServer(deps: ServerDeps) {
  const log = deps.log ?? ((m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`));
  const queue = new KeyedQueue((key, err) => log(`${key}: failed: ${err instanceof Error ? err.message : err}`));
  const runJob = deps.processIssue ?? ((job: IssueJob) => defaultProcessIssue(job, deps.store, deps.env, log));
  const runEvent = deps.processRun ?? ((job: RunEventJob) => defaultProcessRun(job, deps.store.runs, deps.env, log, deps.store.checks));
  const listRepos = deps.listRepos ?? listConnectedRepos;
  const pendingStates = new Set<string>(); // protects the setup callback from forged requests
  const html = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
  const admin = new Admin(deps.env.NOREPRO_ADMIN_PASSWORD);

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

  const redirect = (path: string) => Response.redirect(`${deps.publicUrl}${path}`, 303);

  /** Forms only post from our own pages: refuse cross-site posts (no CSRF tokens needed for that). */
  function sameOrigin(req: Request): boolean {
    const origin = req.headers.get("origin") ?? req.headers.get("referer");
    if (!origin) return false;
    try {
      return new URL(origin).origin === new URL(deps.publicUrl).origin;
    } catch {
      return false;
    }
  }

  async function sentryClient(org: string): Promise<SentryClient | null> {
    const app = sentryAppFromEnv(deps.env);
    const saved = app ? await deps.store.sentry.load(org) : null;
    if (!app || !saved) return null;
    const inst = await freshInstallation(app, saved, deps.fetchImpl);
    if (inst !== saved) await deps.store.sentry.save(inst);
    return new SentryClient(inst.token, inst.org, deps.fetchImpl);
  }

  async function handleProjects(req: Request): Promise<Response> {
    const app = await deps.store.loadApp();
    // Before the app is registered, the only thing to do is the one-time GitHub setup.
    if (!app) {
      if (!admin.allows(req)) return html(messagePage("Not set up yet", "No Repro hasn't been connected to GitHub on this server yet."), 503);
      return html(welcomePage(`${deps.publicUrl}/setup`));
    }
    const projects = await deps.store.projects.list();
    const cards = await Promise.all(projects.map(async (project) => ({ project, stats: statsFor(await deps.store.checks.list(project.repo, 500)) })));
    return html(projectsPage(cards, admin.allows(req)));
  }

  async function handleNewProject(): Promise<Response> {
    const app = await deps.store.loadApp();
    if (!app) return redirect("/");
    const repos = await listRepos(app)
      .then((r) => r.map((x) => x.fullName))
      .catch((err) => (log(`couldn't list repos: ${err instanceof Error ? err.message : err}`), null));
    const takenRepos = (await deps.store.projects.list()).map((p) => p.repo.toLowerCase());
    return html(newProjectPage({ repos, takenRepos, installHref: installUrl(app), error: null }));
  }

  /** Pick a repo → the project exists, named after the repo. Sentry is linked later, if at all. */
  async function handleCreateProject(req: Request): Promise<Response> {
    if (!sameOrigin(req)) return new Response("cross-site request refused", { status: 403 });
    const repo = String((await req.formData()).get("repo") ?? "").trim();
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return html(messagePage("Pick a repo", "Choose the GitHub repo for this project."), 400);
    const app = await deps.store.loadApp();
    const connected = app ? await listRepos(app).catch(() => []) : [];
    const match = connected.find((r) => r.fullName.toLowerCase() === repo.toLowerCase());
    if (!match) return html(messagePage("Repo not connected", `No Repro doesn't have access to ${repo}. Add it on GitHub first.`), 400);
    const existing = await deps.store.projects.byRepo(match.fullName);
    if (existing) return redirect(`/projects/${existing.id}`);
    const all = await deps.store.projects.list();
    const name = uniqueName(match.fullName.split("/")[1]!, all.map((p) => p.name));
    const project: Project = {
      id: projectId(name, ["new", ...all.map((p) => p.id)]),
      name,
      repo: match.fullName,
      sentry: null,
      paused: false,
      createdAt: new Date().toISOString(),
    };
    await deps.store.projects.save(project);
    log(`project "${project.name}" created for ${project.repo}`);
    return redirect(`/projects/${project.id}`);
  }

  async function handleSentryLink(id: string, url: URL): Promise<Response> {
    const project = await deps.store.projects.get(id);
    if (!project) return html(messagePage("Project not found", "It may have been deleted."), 404);
    const sentryApp = sentryAppFromEnv(deps.env);
    const orgs = sentryApp ? await deps.store.sentry.list() : [];
    const wanted = url.searchParams.get("org") ?? project.sentry?.org ?? "";
    const org = orgs.includes(wanted) ? wanted : (orgs[0] ?? "");
    const view: SentryLinkView = {
      project,
      orgs,
      org,
      projects: null,
      selected: "",
      environments: [],
      env: project.sentry?.org === org ? (project.sentry.environment ?? "") : "",
      connectHref: sentryApp ? `${deps.publicUrl}/sentry/connect` : null,
      error: null,
    };
    if (org) {
      try {
        const client = await sentryClient(org);
        view.projects = client ? (await client.listProjects()).map((p) => ({ slug: p.slug, name: p.name })) : [];
        view.selected =
          (project.sentry?.org === org ? project.sentry.project : "") || suggestProject(project.repo, view.projects) || view.projects[0]?.slug || "";
        if (client && view.selected) view.environments = await client.environments(view.selected).catch(() => []);
        if (!view.env && view.environments.includes("production")) view.env = "production";
      } catch (err) {
        view.error = `Couldn't read projects from Sentry: ${err instanceof Error ? err.message : err}`;
        view.projects = [];
      }
    }
    return html(sentryLinkPage(view));
  }

  async function handleSaveSentryLink(req: Request, id: string): Promise<Response> {
    if (!sameOrigin(req)) return new Response("cross-site request refused", { status: 403 });
    const project = await deps.store.projects.get(id);
    if (!project) return html(messagePage("Project not found", "It may have been deleted."), 404);
    const form = await req.formData();
    const org = String(form.get("org") ?? "").trim();
    const sproject = String(form.get("sproject") ?? "").trim();
    if (!org || !sproject) return html(messagePage("Pick a Sentry project", "Choose the organization and project to link."), 400);
    if (!(await deps.store.sentry.list()).includes(org)) return html(messagePage("Sentry not connected", `The Sentry organization ${org} isn't connected.`), 400);
    project.sentry = { org, project: sproject, environment: String(form.get("env") ?? "").trim() || null };
    await deps.store.projects.save(project);
    log(`project "${project.name}" linked to Sentry ${org}/${sproject}`);
    return redirect(`/projects/${project.id}`);
  }

  async function handleProject(req: Request, id: string): Promise<Response> {
    const project = await deps.store.projects.get(id);
    if (!project) return html(messagePage("Project not found", "It may have been deleted."), 404);
    const checks = await deps.store.checks.list(project.repo, 500);
    let reproductionEnabled: boolean | null = null;
    const app = await deps.store.loadApp();
    if (app) {
      const repo = (await listRepos(app).catch(() => [])).find((r) => r.fullName.toLowerCase() === project.repo.toLowerCase());
      const [owner, name] = project.repo.split("/");
      if (repo?.installationId && owner && name) {
        reproductionEnabled = await new GitHubActions(installationOctokit(app, repo.installationId), owner, name).enabled().catch(() => null);
      }
    }
    return html(
      projectPage({ project, checks, stats: statsFor(checks), reproductionEnabled, sentryConnectHref: sentryAppFromEnv(deps.env) ? `${deps.publicUrl}/sentry/connect` : null, admin: admin.allows(req) }),
    );
  }

  async function handleProjectAction(req: Request, id: string, action: string): Promise<Response> {
    if (!sameOrigin(req)) return new Response("cross-site request refused", { status: 403 });
    const project = await deps.store.projects.get(id);
    if (!project) return html(messagePage("Project not found", "It may have been deleted."), 404);
    if (action === "pause" || action === "resume") project.paused = action === "pause";
    else if (action === "sentry/disconnect") project.sentry = null;
    else if (action === "reproduction/on" || action === "reproduction/off") project.reproduce = action === "reproduction/on";
    else return new Response("not found", { status: 404 });
    await deps.store.projects.save(project);
    log(`project "${project.name}": ${action}`);
    return redirect(`/projects/${project.id}`);
  }

  /** Sentry's install page; after the owner accepts, Sentry redirects to /sentry/callback. */
  function handleSentryConnect(): Response {
    const sentryApp = sentryAppFromEnv(deps.env);
    if (!sentryApp) return html(messagePage("Sentry isn't set up", "The person running No Repro hasn't registered the Sentry integration yet."), 503);
    return Response.redirect(sentryInstallUrl(sentryApp), 302);
  }

  async function handleSentryCallback(url: URL): Promise<Response> {
    const sentryApp = sentryAppFromEnv(deps.env);
    const code = url.searchParams.get("code");
    const installationId = url.searchParams.get("installationId");
    if (!sentryApp || !code || !installationId) {
      return html(messagePage("Sentry connection failed", "The link from Sentry was incomplete. Try Connect Sentry again."), 400);
    }
    // The code can only be exchanged with our client secret, so a forged callback gets nothing.
    const inst = await completeInstall(sentryApp, installationId, code, url.searchParams.get("orgSlug"), deps.fetchImpl);
    await deps.store.sentry.save(inst);
    log(`Sentry organization "${inst.org}" connected`);
    return Response.redirect(`${deps.publicUrl}/`, 302);
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

  async function handleSignIn(req: Request): Promise<Response> {
    if (!sameOrigin(req)) return new Response("cross-site request refused", { status: 403 });
    const password = String((await req.formData()).get("password") ?? "");
    if (!admin.checkPassword(password)) {
      log("admin sign-in: wrong password");
      return html(signInPage("That password isn't right."), 401);
    }
    const res = redirect("/");
    res.headers.append("set-cookie", admin.sessionCookie(deps.publicUrl.startsWith("https://")));
    return res;
  }

  /** Routes that change things, or start the one-time setup. Visitors to a hosted demo can't use them. */
  function adminOnly(req: Request, url: URL): boolean {
    const p = url.pathname;
    if (req.method === "POST") return p === "/projects" || p.startsWith("/projects/");
    if (p === "/" && url.searchParams.has("installationId") && url.searchParams.has("code")) return true;
    return (
      p === "/projects/new" ||
      /^\/projects\/[a-z0-9-]+\/sentry$/.test(p) ||
      p === "/setup" ||
      p === "/setup/callback" ||
      p === "/installed" ||
      p === "/sentry/connect" ||
      p === "/sentry/callback"
    );
  }

  async function fetchHandler(req: Request): Promise<Response> {
    const url = new URL(req.url);
    try {
      if (req.method === "POST" && url.pathname === "/webhook") return await handleWebhook(req);
      if (admin.enabled) {
        if (req.method === "GET" && url.pathname === "/admin") return html(signInPage(null));
        if (req.method === "POST" && url.pathname === "/admin") return await handleSignIn(req);
        if (req.method === "POST" && url.pathname === "/admin/logout") {
          if (!sameOrigin(req)) return new Response("cross-site request refused", { status: 403 });
          const res = redirect("/");
          res.headers.append("set-cookie", admin.clearCookie());
          return res;
        }
        if (adminOnly(req, url) && !admin.allows(req)) {
          return req.method === "GET" ? Response.redirect(`${deps.publicUrl}/admin`, 302) : new Response("sign in as the admin first", { status: 403 });
        }
      }
      // A Sentry install that comes back to the home page (Redirect URL set to the site root) still connects.
      if (req.method === "GET" && url.pathname === "/" && url.searchParams.has("installationId") && url.searchParams.has("code")) {
        return await handleSentryCallback(url);
      }
      if (req.method === "GET" && url.pathname === "/") return await handleProjects(req);
      if (req.method === "GET" && url.pathname === "/projects/new") return await handleNewProject();
      if (req.method === "POST" && url.pathname === "/projects") return await handleCreateProject(req);
      const sentryRoute = url.pathname.match(/^\/projects\/([a-z0-9-]+)\/sentry$/);
      if (sentryRoute && req.method === "GET") return await handleSentryLink(sentryRoute[1]!, url);
      if (sentryRoute && req.method === "POST") return await handleSaveSentryLink(req, sentryRoute[1]!);
      const projectRoute = url.pathname.match(/^\/projects\/([a-z0-9-]+)(?:\/(pause|resume|sentry\/disconnect|reproduction\/on|reproduction\/off))?$/);
      if (projectRoute && req.method === "GET" && !projectRoute[2]) return await handleProject(req, projectRoute[1]!);
      if (projectRoute && req.method === "POST" && projectRoute[2]) return await handleProjectAction(req, projectRoute[1]!, projectRoute[2]);
      if (req.method === "GET" && url.pathname === "/activity") return html(activityPage(await deps.store.checks.list(undefined, 100)));
      if (req.method === "GET" && url.pathname === "/how-it-works") return html(howItWorksPage());
      if (req.method === "GET" && url.pathname === "/setup") return await handleSetup(url);
      if (req.method === "GET" && url.pathname === "/setup/callback") return await handleSetupCallback(url);
      // GitHub sends people here after they pick repos: carry on creating a project.
      if (req.method === "GET" && url.pathname === "/installed") return redirect("/projects/new");
      if (req.method === "GET" && url.pathname === "/sentry/connect") return handleSentryConnect();
      if (req.method === "GET" && url.pathname === "/sentry/callback") return await handleSentryCallback(url);
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
  const store = fileStore(env.NOREPRO_DATA_DIR ?? ".norepro");
  if (env.NOREPRO_SEED && (await importSeed(store, env.NOREPRO_SEED))) console.log("Imported the GitHub App, Sentry installs and projects from NOREPRO_SEED");
  // On a host with a public URL, GitHub should deliver straight here, not to a local smee channel.
  if (env.NOREPRO_PUBLIC_URL) {
    // A failure here shouldn't take the dashboard down; the webhook can also be changed in the GitHub App's settings.
    await syncWebhookUrl(store, `${publicUrl}/webhook`).then(
      (moved) => moved && console.log(`GitHub App webhook now points at ${publicUrl}/webhook`),
      (err) => console.error(`Couldn't point the GitHub App webhook at ${publicUrl}/webhook: ${err instanceof Error ? err.message : err}`),
    );
  }
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
