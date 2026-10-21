// A local git checkout as a CodeHost, so `bun run triage --repo-dir` can locate bugs
// (and the tests can use a real repo) without calling GitHub.
import type { HistoryHost } from "../repro/bisect.ts";
import { lineAnchor, type CodeHost, type CommitInfo, type SourceFile } from "./code.ts";

function git(dir: string, args: string[]): { ok: boolean; out: string } {
  const res = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  return { ok: res.exitCode === 0, out: res.stdout.toString() };
}

function must(dir: string, args: string[]): string {
  const res = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  if (res.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr.toString().trim()}`);
  return res.stdout.toString();
}

/** Parse `git blame --porcelain` into the newest commit among the blamed lines. */
export function newestFromPorcelain(porcelain: string): { sha: string; author: string; time: number; summary: string; boundary: boolean } | null {
  const commits = new Map<string, { sha: string; author: string; time: number; summary: string; boundary: boolean }>();
  let current: { sha: string; author: string; time: number; summary: string; boundary: boolean } | null = null;
  for (const line of porcelain.split("\n")) {
    const header = line.match(/^([0-9a-f]{40}) \d+ \d+/);
    if (header) {
      current = commits.get(header[1]!) ?? { sha: header[1]!, author: "", time: 0, summary: "", boundary: false };
      commits.set(current.sha, current);
    } else if (current) {
      if (line.startsWith("author ")) current.author = line.slice(7);
      else if (line.startsWith("author-time ")) current.time = Number(line.slice(12));
      else if (line.startsWith("summary ")) current.summary = line.slice(8);
      else if (line === "boundary") current.boundary = true;
    }
  }
  return [...commits.values()].sort((a, b) => b.time - a.time)[0] ?? null;
}

export class LocalGitHost implements CodeHost {
  private readonly webBase: string | null;

  constructor(private readonly dir: string) {
    // Link to GitHub when the checkout's origin is a GitHub repo.
    const origin = git(dir, ["remote", "get-url", "origin"]).out.trim();
    const m = origin.match(/github\.com[:/]([^/]+)\/(.+?)(\.git)?$/);
    this.webBase = m ? `https://github.com/${m[1]}/${m[2]}` : null;
  }

  async headSha(): Promise<string> {
    return must(this.dir, ["rev-parse", "HEAD"]).trim();
  }

  async listFiles(sha: string): Promise<SourceFile[]> {
    return must(this.dir, ["ls-tree", "-r", "-l", sha])
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [meta, path] = line.split("\t");
        const size = Number(meta!.trim().split(/\s+/)[3]);
        return { path: path!, size: Number.isFinite(size) ? size : 0 };
      });
  }

  async readFile(path: string, sha: string): Promise<string> {
    return must(this.dir, ["show", `${sha}:${path}`]);
  }

  async lastChange(path: string, start: number, end: number, sha: string): Promise<CommitInfo | null> {
    const newest = newestFromPorcelain(must(this.dir, ["blame", "--porcelain", "-L", `${start},${end}`, sha, "--", path]));
    if (!newest) return null;
    const hasParent = git(this.dir, ["rev-parse", "--verify", "--quiet", `${newest.sha}^`]).ok;
    const existedBefore = hasParent && git(this.dir, ["cat-file", "-e", `${newest.sha}^:${path}`]).ok;
    return {
      sha: newest.sha,
      message: newest.summary,
      author: newest.author,
      date: new Date(newest.time * 1000).toISOString(),
      url: this.webBase ? `${this.webBase}/commit/${newest.sha}` : null,
      addedFile: !existedBefore,
    };
  }

  permalink(path: string, start: number, end: number, sha: string): string | null {
    return this.webBase ? `${this.webBase}/blob/${sha}/${path}${lineAnchor(start, end)}` : null;
  }
}

/** Repo history from a local checkout, for choosing a bisect range. */
export class LocalGitHistory implements HistoryHost {
  constructor(private readonly dir: string) {}

  async resolveRef(ref: string): Promise<string | null> {
    const res = git(this.dir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return res.ok ? res.out.trim() : null;
  }

  async latestTagBefore(sha: string): Promise<{ name: string; sha: string } | null> {
    const res = git(this.dir, ["describe", "--tags", "--abbrev=0", `${sha}^`]);
    if (!res.ok) return null;
    const name = res.out.trim();
    const tagSha = await this.resolveRef(name);
    return tagSha ? { name, sha: tagSha } : null;
  }

  async parentOf(sha: string): Promise<string | null> {
    return this.resolveRef(`${sha}^`);
  }

  async changeIn(sha: string, path: string | null): Promise<{ path: string; patch: string } | null> {
    const touched = must(this.dir, ["show", "--format=", "--name-only", sha]).split("\n").filter(Boolean);
    const file = path && touched.includes(path) ? path : touched[0];
    if (!file) return null;
    // Drop the file header (diff --git / index / --- / +++) so it reads like GitHub's patch.
    const patch = must(this.dir, ["show", "--format=", "--unified=3", sha, "--", file]).replace(/^[\s\S]*?(?=^@@)/m, "");
    return { path: file, patch: patch.trimEnd() };
  }

  async commitsBetween(good: string, bad: string): Promise<number> {
    if (!git(this.dir, ["merge-base", "--is-ancestor", good, bad]).ok) return 0;
    return Number(must(this.dir, ["rev-list", "--count", `${good}..${bad}`]).trim());
  }
}
