// Local state for the server that hosts No Repro, kept in .norepro/ (gitignored).
// app.json holds the GitHub App's credentials, created once by the "Create GitHub App" button.
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import type { SentryInstallation } from "../evidence/sentry.ts";
import type { PendingRun, RunStore } from "../repro/index.ts";
import type { CheckRecord, CheckStore, Project, ProjectStore } from "./projects.ts";
import { dirname, join } from "node:path";

export interface AppCredentials {
  id: number;
  slug: string;
  name: string;
  htmlUrl: string;
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
  privateKey: string;
  /** Where GitHub sends webhooks: the public URL, or a smee.io channel in local dev. */
  webhookUrl: string;
}

export interface Store {
  loadApp(): Promise<AppCredentials | null>;
  saveApp(app: AppCredentials): Promise<void>;
  loadDevChannel(): Promise<string | null>;
  saveDevChannel(url: string): Promise<void>;
  /** Reproduction runs dispatched to a repo's GitHub Actions, waiting for their result. */
  runs: RunStore;
  /** Sentry organizations that installed No Repro's Sentry integration, by org slug. */
  sentry: SentryStore;
  projects: ProjectStore;
  checks: CheckStore;
}

const MAX_CHECKS = 500;

/** Shared by both stores: projects and checks as plain arrays behind load/save. */
function projectAndCheckStores(
  loadProjects: () => Promise<Project[]>,
  saveProjects: (p: Project[]) => Promise<void>,
  loadChecks: () => Promise<CheckRecord[]>,
  saveChecks: (c: CheckRecord[]) => Promise<void>,
): { projects: ProjectStore; checks: CheckStore } {
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  return {
    projects: {
      list: async () => (await loadProjects()).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      get: async (id) => (await loadProjects()).find((p) => p.id === id) ?? null,
      byRepo: async (repo) => (await loadProjects()).find((p) => same(p.repo, repo)) ?? null,
      save: async (project) => saveProjects([...(await loadProjects()).filter((p) => p.id !== project.id), project]),
      remove: async (id) => saveProjects((await loadProjects()).filter((p) => p.id !== id)),
    },
    checks: {
      record: async (check) => {
        const rest = (await loadChecks()).filter((c) => !(same(c.repo, check.repo) && c.number === check.number));
        await saveChecks([check, ...rest].slice(0, MAX_CHECKS));
      },
      get: async (repo, number) => (await loadChecks()).find((c) => same(c.repo, repo) && c.number === number) ?? null,
      list: async (repo, limit = 50) =>
        (await loadChecks())
          .filter((c) => !repo || same(c.repo, repo))
          .sort((a, b) => b.checkedAt.localeCompare(a.checkedAt))
          .slice(0, limit),
    },
  };
}

export interface SentryStore {
  save(inst: SentryInstallation): Promise<void>;
  load(org: string): Promise<SentryInstallation | null>;
  list(): Promise<string[]>;
}

const safeSlug = (org: string) => {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(org)) throw new Error("bad Sentry org slug");
  return org.toLowerCase();
};

const safeRef = (ref: string) => {
  if (!/^[a-f0-9]{8,32}$/.test(ref)) throw new Error("bad run ref");
  return ref;
};

export function fileStore(dir = ".norepro"): Store {
  const read = async <T>(name: string): Promise<T | null> => {
    const path = join(dir, name);
    return existsSync(path) ? (JSON.parse(await readFile(path, "utf8")) as T) : null;
  };
  const write = async (name: string, data: unknown) => {
    const path = join(dir, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(data, null, 2), { mode: 0o600 });
  };
  return {
    loadApp: () => read<AppCredentials>("app.json"),
    saveApp: (app) => write("app.json", app),
    loadDevChannel: async () => (await read<{ url: string }>("dev-channel.json"))?.url ?? null,
    saveDevChannel: (url) => write("dev-channel.json", { url }),
    runs: {
      save: (run) => write(`runs/${safeRef(run.ref)}.json`, run),
      load: (ref) => read<PendingRun>(`runs/${safeRef(ref)}.json`),
      delete: (ref) => rm(join(dir, "runs", `${safeRef(ref)}.json`), { force: true }),
    },
    ...projectAndCheckStores(
      async () => (await read<Project[]>("projects.json")) ?? [],
      (p) => write("projects.json", p),
      async () => (await read<CheckRecord[]>("checks.json")) ?? [],
      (c) => write("checks.json", c),
    ),
    sentry: {
      save: (inst) => write(`sentry/${safeSlug(inst.org)}.json`, inst),
      load: (org) => read<SentryInstallation>(`sentry/${safeSlug(org)}.json`),
      list: async () => {
        const { readdir } = await import("node:fs/promises");
        return existsSync(join(dir, "sentry")) ? (await readdir(join(dir, "sentry"))).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)) : [];
      },
    },
  };
}

export function memoryStore(initial: AppCredentials | null = null): Store & { app: AppCredentials | null; pending: Map<string, PendingRun> } {
  let channel: string | null = null;
  const pending = new Map<string, PendingRun>();
  const sentry = new Map<string, SentryInstallation>();
  let projects: Project[] = [];
  let checks: CheckRecord[] = [];
  const store = {
    pending,
    sentryInstalls: sentry,
    ...projectAndCheckStores(
      async () => projects,
      async (p) => void (projects = p),
      async () => checks,
      async (c) => void (checks = c),
    ),
    sentry: {
      save: async (inst: SentryInstallation) => void sentry.set(inst.org.toLowerCase(), inst),
      load: async (org: string) => sentry.get(org.toLowerCase()) ?? null,
      list: async () => [...sentry.keys()],
    },
    runs: {
      save: async (run: PendingRun) => void pending.set(run.ref, run),
      load: async (ref: string) => pending.get(ref) ?? null,
      delete: async (ref: string) => void pending.delete(ref),
    },
    app: initial,
    loadApp: async () => store.app,
    saveApp: async (app: AppCredentials) => void (store.app = app),
    loadDevChannel: async () => channel,
    saveDevChannel: async (url: string) => void (channel = url),
  };
  return store;
}
