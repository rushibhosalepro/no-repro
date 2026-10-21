// Local state for the server that hosts No Repro, kept in .norepro/ (gitignored).
// app.json holds the GitHub App's credentials, created once by the "Create GitHub App" button.
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import type { PendingRun, RunStore } from "../repro/index.ts";
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
}

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
  };
}

export function memoryStore(initial: AppCredentials | null = null): Store & { app: AppCredentials | null; pending: Map<string, PendingRun> } {
  let channel: string | null = null;
  const pending = new Map<string, PendingRun>();
  const store = {
    pending,
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
