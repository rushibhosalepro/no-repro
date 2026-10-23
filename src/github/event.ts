import type { NoReproConfig } from "../core/config.ts";
import { COMMENT_MARKER, type AgentState } from "../core/render.ts";

// Just the parts of GitHub webhook payloads we read.
export interface GhUser {
  login: string;
  type?: string;
}
export interface GhIssue {
  number: number;
  title: string;
  body: string | null;
  user: GhUser | null;
  labels: Array<{ name?: string } | string>;
  pull_request?: unknown;
  html_url?: string;
  created_at?: string;
  state?: string;
}
export interface GhComment {
  id: number;
  body: string | null;
  user: GhUser | null;
  author_association?: string;
}
export interface IssueEvent {
  eventName: "issues" | "issue_comment" | string;
  action: string;
  issue: GhIssue;
  comment?: GhComment;
  label?: { name: string };
}

export type Decision =
  | { act: true; reason: string }
  | { act: false; reason: string; limitReached?: boolean };

const MAINTAINERS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
// Also accepts the easy typos (/norepo, /no-repro, /repro), which otherwise fail silently.
const RETRY_COMMAND = /^\s*\/(no-?repr?o|repro)\s+retry\b/i;

export function isBot(user: GhUser | null | undefined): boolean {
  return !user || user.type === "Bot" || user.login.endsWith("[bot]");
}

export function labelNames(issue: GhIssue): string[] {
  return issue.labels.map((l) => (typeof l === "string" ? l : (l.name ?? ""))).filter(Boolean);
}

/** Pure: given an event and the agent's previous state on this issue, should the agent run? */
export function decide(event: IssueEvent, state: AgentState | null, config: NoReproConfig): Decision {
  const { issue } = event;
  if (issue.pull_request) return { act: false, reason: "pull requests are not triaged" };
  if (issue.state === "closed") return { act: false, reason: "issue is closed" };

  if (config.onlyLabels.length > 0 && !labelNames(issue).some((l) => config.onlyLabels.includes(l))) {
    return { act: false, reason: `issue has none of the labels ${config.onlyLabels.join(", ")}` };
  }

  const wanted = wantsRun(event, state);
  if (!wanted.act) return wanted;

  if (state && state.runs >= config.limits.maxRunsPerIssue) {
    // The existing comment (with the last verdict) is left exactly as it is.
    return { act: false, reason: `run limit of ${config.limits.maxRunsPerIssue} reached`, limitReached: true };
  }
  return wanted;
}

function wantsRun(event: IssueEvent, state: AgentState | null): Decision {
  const { issue } = event;

  if (event.eventName === "issues") {
    switch (event.action) {
      case "opened":
      case "reopened":
        return { act: true, reason: `issue ${event.action}` };
      case "labeled":
        // Lets `onlyLabels` repos trigger triage by adding the label later.
        return state ? { act: false, reason: "already triaged" } : { act: true, reason: `labeled ${event.label?.name}` };
      case "edited":
        if (!state || state.status === "needs-info" || state.status === "error") {
          return { act: true, reason: "issue edited while waiting for info" };
        }
        return { act: false, reason: "edit after triage finished" };
      default:
        return { act: false, reason: `ignored issues.${event.action}` };
    }
  }

  if (event.eventName === "issue_comment" && event.action === "created" && event.comment) {
    const { comment } = event;
    if (isBot(comment.user) || comment.body?.includes(COMMENT_MARKER)) {
      return { act: false, reason: "comment from a bot" };
    }
    const body = comment.body ?? "";
    if (RETRY_COMMAND.test(body)) {
      return MAINTAINERS.has(comment.author_association ?? "")
        ? { act: true, reason: "maintainer asked for a retry" }
        : { act: false, reason: "/norepro retry is maintainer-only" };
    }
    const fromReporter = comment.user?.login === issue.user?.login;
    if (fromReporter && state?.status === "needs-info") {
      return { act: true, reason: "reporter answered the question" };
    }
    return { act: false, reason: "comment doesn't need a re-run" };
  }

  return { act: false, reason: `ignored ${event.eventName}.${event.action}` };
}
