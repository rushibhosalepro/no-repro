// Moving a running No Repro to a host (Railway): the GitHub App, Sentry installs and projects
// travel as one secret env var (NOREPRO_SEED), imported once into the host's empty data folder.
// After that the GitHub App's webhook is pointed at the host's public URL.
import { appOctokit } from "./app.ts";
import type { AppCredentials, Store } from "./store.ts";
import type { SentryInstallation } from "../evidence/sentry.ts";
import type { Project } from "./projects.ts";

export interface Seed {
  app: AppCredentials;
  sentry: SentryInstallation[];
  projects: Project[];
}

export async function exportSeed(store: Store): Promise<Seed> {
  const app = await store.loadApp();
  if (!app) throw new Error("No GitHub App on this machine yet, so there's nothing to move.");
  const sentry = (await Promise.all((await store.sentry.list()).map((org) => store.sentry.load(org)))).filter((s): s is SentryInstallation => Boolean(s));
  return { app, sentry, projects: await store.projects.list() };
}

export const encodeSeed = (seed: Seed) => Buffer.from(JSON.stringify(seed)).toString("base64");

/** Import only into an empty store, so restarting the host never overwrites what it has since learned. */
export async function importSeed(store: Store, encoded: string): Promise<boolean> {
  if (await store.loadApp()) return false;
  const seed = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as Seed;
  if (!seed.app?.privateKey) throw new Error("NOREPRO_SEED doesn't contain a GitHub App.");
  await store.saveApp(seed.app);
  for (const inst of seed.sentry ?? []) await store.sentry.save(inst);
  for (const project of seed.projects ?? []) await store.projects.save(project);
  return true;
}

/** Point the GitHub App's webhook at `url` (e.g. off the local smee channel, onto the host). */
export async function syncWebhookUrl(store: Store, url: string): Promise<boolean> {
  const app = await store.loadApp();
  if (!app || app.webhookUrl === url) return false;
  // `data` sets the body directly: Octokit reads a top-level `url` option as the address to call.
  await appOctokit(app).request("PATCH /app/hook/config", { data: { url, content_type: "json", secret: app.webhookSecret } });
  await store.saveApp({ ...app, webhookUrl: url });
  return true;
}
