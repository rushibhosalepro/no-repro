import { Octokit } from "@octokit/rest";
import type { IssueThread } from "../core/clarity.ts";
import { ALL_LABELS, COMMENT_MARKER, readState, type AgentState } from "../core/render.ts";
import { isBot, type GhIssue } from "./event.ts";

const LABEL_COLORS: Record<string, string> = {
  "needs-info": "fbca04",
  "repro:out-of-scope": "cccccc",
  "report:clear": "0e8a16",
};

/** All GitHub side effects the agent performs on one issue. It only comments and labels; it never closes or deletes. */
export class IssueHandle {
  private botCommentId: number | null = null;

  constructor(
    private readonly octokit: Octokit,
    readonly owner: string,
    readonly repo: string,
    readonly number: number,
  ) {}

  static fromToken(token: string, fullName: string, number: number): IssueHandle {
    const [owner, repo] = fullName.split("/");
    if (!owner || !repo) throw new Error(`Expected owner/repo, got "${fullName}"`);
    return new IssueHandle(new Octokit({ auth: token }), owner, repo, number);
  }

  async getIssue(): Promise<GhIssue> {
    const { data } = await this.octokit.issues.get({ owner: this.owner, repo: this.repo, issue_number: this.number });
    return data as GhIssue;
  }

  private async listComments() {
    return this.octokit.paginate(this.octokit.issues.listComments, {
      owner: this.owner,
      repo: this.repo,
      issue_number: this.number,
      per_page: 100,
    });
  }

  /** Previous agent state from our own comment, or null if we've never run on this issue. */
  async loadState(): Promise<AgentState | null> {
    const mine = (await this.listComments()).find((c) => c.body?.includes(COMMENT_MARKER));
    if (!mine) return null;
    this.botCommentId = mine.id;
    return readState(mine.body);
  }

  /** Issue text plus the reporter's own follow-up comments (their answers to our questions). */
  async loadThread(issue: GhIssue): Promise<IssueThread> {
    const reporter = issue.user?.login;
    const replies = (await this.listComments())
      .filter((c) => !isBot(c.user as never) && !c.body?.includes(COMMENT_MARKER) && c.user?.login === reporter)
      .map((c) => c.body ?? "")
      .filter((b) => b.trim() && !b.trim().startsWith("/norepro"));
    return { title: issue.title, body: issue.body ?? "", replies };
  }

  /** Create our single comment, or edit it in place if it already exists. */
  async upsertComment(body: string): Promise<void> {
    if (this.botCommentId === null) await this.loadState();
    if (this.botCommentId !== null) {
      await this.octokit.issues.updateComment({ owner: this.owner, repo: this.repo, comment_id: this.botCommentId, body });
    } else {
      const { data } = await this.octokit.issues.createComment({
        owner: this.owner,
        repo: this.repo,
        issue_number: this.number,
        body,
      });
      this.botCommentId = data.id;
    }
  }

  /** Swap our status label: remove any other No Repro labels, add this one. Other labels are untouched. */
  async setStatusLabel(label: string, issue: GhIssue): Promise<void> {
    const current = issue.labels.map((l) => (typeof l === "string" ? l : l.name ?? ""));
    for (const stale of current.filter((l) => ALL_LABELS.includes(l) && l !== label)) {
      await this.octokit.issues
        .removeLabel({ owner: this.owner, repo: this.repo, issue_number: this.number, name: stale })
        .catch(() => undefined); // already gone
    }
    await this.ensureLabel(label);
    await this.octokit.issues.addLabels({ owner: this.owner, repo: this.repo, issue_number: this.number, labels: [label] });
  }

  private async ensureLabel(name: string): Promise<void> {
    try {
      await this.octokit.issues.getLabel({ owner: this.owner, repo: this.repo, name });
    } catch {
      await this.octokit.issues
        .createLabel({ owner: this.owner, repo: this.repo, name, color: LABEL_COLORS[name] ?? "ededed" })
        .catch(() => undefined); // created concurrently
    }
  }
}
