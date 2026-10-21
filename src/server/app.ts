// Talking to GitHub as the No Repro GitHub App.
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { parseConfig, DEFAULT_CONFIG_PATH, type NoReproConfig } from "../core/config.ts";
import type { AppCredentials } from "./store.ts";

/**
 * GitHub App manifest: everything GitHub needs to create the app in one click.
 * https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest
 */
export function buildManifest(opts: { name: string; publicUrl: string; webhookUrl: string }) {
  return {
    name: opts.name,
    url: opts.publicUrl,
    description: "No repro, no ticket. Checks whether bug reports are clear and asks one question when they aren't.",
    hook_attributes: { url: opts.webhookUrl, active: true },
    redirect_url: `${opts.publicUrl}/setup/callback`,
    setup_url: `${opts.publicUrl}/installed`,
    setup_on_update: true,
    // Public so anyone (including hackathon judges) can install it on their own repos.
    public: true,
    // actions: start the repo's own No Repro workflow and read its result (optional, per repo).
    default_permissions: { issues: "write", contents: "read", metadata: "read", actions: "write" },
    default_events: ["issues", "issue_comment", "workflow_run"],
  };
}

/** After the user confirms on GitHub, trade the one-time code for the app's credentials. */
export async function exchangeManifestCode(code: string, webhookUrl: string, fetchImpl: typeof fetch = fetch): Promise<AppCredentials> {
  const res = await fetchImpl(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: "POST",
    headers: { accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`GitHub rejected the setup code (HTTP ${res.status}). Start the setup again.`);
  const d = (await res.json()) as Record<string, any>;
  return {
    id: d.id,
    slug: d.slug,
    name: d.name,
    htmlUrl: d.html_url,
    clientId: d.client_id,
    clientSecret: d.client_secret,
    webhookSecret: d.webhook_secret,
    privateKey: d.pem,
    webhookUrl,
  };
}

export function installUrl(app: AppCredentials): string {
  return `https://github.com/apps/${app.slug}/installations/new`;
}

// Octokit logs every non-2xx response (e.g. the expected 404 when a label doesn't exist yet).
// Failures still throw and are logged by our own code, so keep its logger quiet.
const quiet = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/** Octokit acting as the app itself (list installations). */
export function appOctokit(app: AppCredentials): Octokit {
  return new Octokit({ authStrategy: createAppAuth, auth: { appId: app.id, privateKey: app.privateKey }, log: quiet });
}

/** Octokit acting inside one installation (comment and label on that user's repos). Tokens refresh automatically. */
export function installationOctokit(app: AppCredentials, installationId: number): Octokit {
  return new Octokit({ authStrategy: createAppAuth, auth: { appId: app.id, privateKey: app.privateKey, installationId }, log: quiet });
}

export interface ConnectedRepo {
  fullName: string;
  account: string;
}

/** Every repo the app is installed on, for the dashboard. */
export async function listConnectedRepos(app: AppCredentials): Promise<ConnectedRepo[]> {
  const octokit = appOctokit(app);
  const installations = await octokit.paginate(octokit.apps.listInstallations, { per_page: 100 });
  const repos: ConnectedRepo[] = [];
  for (const inst of installations) {
    const inside = installationOctokit(app, inst.id);
    const list = await inside.paginate(inside.apps.listReposAccessibleToInstallation, { per_page: 100 });
    const account = inst.account && "login" in inst.account ? inst.account.login : "unknown";
    for (const r of list) repos.push({ fullName: r.full_name, account });
  }
  return repos;
}

/**
 * The repo's own `.github/norepro.yml` if it has one, otherwise sensible defaults, so a repo
 * works the moment the app is installed. Throws on an invalid file so the owner can be told.
 */
export async function loadRepoConfig(octokit: Octokit, owner: string, repo: string): Promise<NoReproConfig> {
  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path: DEFAULT_CONFIG_PATH });
    if (!Array.isArray(data) && data.type === "file") {
      return parseConfig(Buffer.from(data.content, "base64").toString("utf8"));
    }
  } catch (err: any) {
    if (err?.status !== 404) throw err;
  }
  return parseConfig(`app:\n  name: ${JSON.stringify(repo)}\n`);
}
