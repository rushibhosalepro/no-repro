import type { Octokit } from "@octokit/rest";
import { lineAnchor, type CodeHost, type CommitInfo, type SourceFile } from "../core/code.ts";
import type { HistoryHost } from "../repro/bisect.ts";

interface BlameRange {
  startingLine: number;
  endingLine: number;
  commit: {
    oid: string;
    messageHeadline: string;
    committedDate: string;
    url: string;
    author: { name: string | null } | null;
    parents: { nodes: Array<{ oid: string }> };
  };
}

const BLAME_QUERY = `query($owner: String!, $repo: String!, $sha: GitObjectID!, $path: String!) {
  repository(owner: $owner, name: $repo) {
    object(oid: $sha) {
      ... on Commit {
        blame(path: $path) {
          ranges {
            startingLine
            endingLine
            commit { oid messageHeadline committedDate url author { name } parents(first: 1) { nodes { oid } } }
          }
        }
      }
    }
  }
}`;

/** Of the commits that touched lines start..end, the most recent one. */
export function newestOverlapping(ranges: BlameRange[], start: number, end: number): BlameRange["commit"] | null {
  return (
    ranges
      .filter((r) => r.startingLine <= end && r.endingLine >= start)
      .map((r) => r.commit)
      .sort((a, b) => b.committedDate.localeCompare(a.committedDate))[0] ?? null
  );
}

/** A repo's code read through the GitHub API, as the installed app (contents: read). */
export class GitHubCodeHost implements CodeHost {
  constructor(
    private readonly octokit: Octokit,
    private readonly owner: string,
    private readonly repo: string,
  ) {}

  async headSha(): Promise<string> {
    const { data: repo } = await this.octokit.repos.get({ owner: this.owner, repo: this.repo });
    const { data: ref } = await this.octokit.git.getRef({ owner: this.owner, repo: this.repo, ref: `heads/${repo.default_branch}` });
    return ref.object.sha;
  }

  async listFiles(sha: string): Promise<SourceFile[]> {
    const { data } = await this.octokit.git.getTree({ owner: this.owner, repo: this.repo, tree_sha: sha, recursive: "true" });
    return data.tree.filter((e) => e.type === "blob" && e.path).map((e) => ({ path: e.path!, size: e.size ?? 0 }));
  }

  async readFile(path: string, sha: string): Promise<string> {
    const { data } = await this.octokit.repos.getContent({ owner: this.owner, repo: this.repo, path, ref: sha });
    if (Array.isArray(data) || data.type !== "file") throw new Error(`${path} is not a file`);
    return Buffer.from(data.content, "base64").toString("utf8");
  }

  async lastChange(path: string, start: number, end: number, sha: string): Promise<CommitInfo | null> {
    const res = await this.octokit.graphql<{ repository: { object: { blame: { ranges: BlameRange[] } } | null } }>(BLAME_QUERY, {
      owner: this.owner,
      repo: this.repo,
      sha,
      path,
    });
    const commit = newestOverlapping(res.repository.object?.blame.ranges ?? [], start, end);
    if (!commit) return null;
    const parent = commit.parents.nodes[0]?.oid;
    return {
      sha: commit.oid,
      message: commit.messageHeadline,
      author: commit.author?.name ?? "unknown",
      date: commit.committedDate,
      url: commit.url,
      addedFile: parent ? !(await this.exists(path, parent)) : true,
    };
  }

  permalink(path: string, start: number, end: number, sha: string): string {
    return `https://github.com/${this.owner}/${this.repo}/blob/${sha}/${path.split("/").map(encodeURIComponent).join("/")}${lineAnchor(start, end)}`;
  }

  private async exists(path: string, ref: string): Promise<boolean> {
    try {
      await this.octokit.repos.getContent({ owner: this.owner, repo: this.repo, path, ref });
      return true;
    } catch (err: any) {
      if (err?.status === 404) return false;
      throw err;
    }
  }
}

/** Repo history through the GitHub API, for choosing a bisect range. */
export class GitHubHistory implements HistoryHost {
  constructor(
    private readonly octokit: Octokit,
    private readonly owner: string,
    private readonly repo: string,
  ) {}

  async resolveRef(ref: string): Promise<string | null> {
    try {
      const { data } = await this.octokit.repos.getCommit({ owner: this.owner, repo: this.repo, ref });
      return data.sha;
    } catch (err: any) {
      if (err?.status === 404 || err?.status === 422) return null;
      throw err;
    }
  }

  async latestTagBefore(sha: string): Promise<{ name: string; sha: string } | null> {
    const { data: tags } = await this.octokit.repos.listTags({ owner: this.owner, repo: this.repo, per_page: 30 });
    // Tags come newest-ish first; take the first that is strictly behind `sha`.
    for (const t of tags) {
      if (t.commit.sha !== sha && (await this.commitsBetween(t.commit.sha, sha)) > 0) return { name: t.name, sha: t.commit.sha };
    }
    return null;
  }

  async parentOf(sha: string): Promise<string | null> {
    const { data } = await this.octokit.repos.getCommit({ owner: this.owner, repo: this.repo, ref: sha });
    return data.parents[0]?.sha ?? null;
  }

  async changeIn(sha: string, path: string | null): Promise<{ path: string; patch: string } | null> {
    const { data } = await this.octokit.repos.getCommit({ owner: this.owner, repo: this.repo, ref: sha });
    const files = (data.files ?? []).filter((f) => f.patch);
    const file = files.find((f) => f.filename === path) ?? files[0];
    return file ? { path: file.filename, patch: file.patch! } : null;
  }

  async commitsBetween(good: string, bad: string): Promise<number> {
    try {
      const { data } = await this.octokit.repos.compareCommitsWithBasehead({ owner: this.owner, repo: this.repo, basehead: `${good}...${bad}`, per_page: 1 });
      return data.status === "ahead" ? data.ahead_by : 0;
    } catch (err: any) {
      if (err?.status === 404) return 0;
      throw err;
    }
  }
}
