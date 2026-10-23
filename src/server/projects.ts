// Projects pair one GitHub repo with (optionally) one Sentry project, so the link lives in
// No Repro instead of the repo's .github/norepro.yml. Each issue No Repro checks is kept as
// a CheckRecord for the project page: verdict, Sentry match, likely cause.
import type { NoReproConfig } from "../core/config.ts";
import type { TriageOutcome } from "../core/report.ts";
import type { ReproState } from "../repro/state.ts";

export interface Project {
  id: string;
  name: string;
  /** owner/name */
  repo: string;
  sentry: { org: string; project: string; environment: string | null } | null;
  paused: boolean;
  /** Replay clear reports on the repo's own runner (when its workflow exists). Missing = on. */
  reproduce?: boolean;
  createdAt: string;
}

export type Verdict =
  | "checking"
  | "needs-info"
  | "out-of-scope"
  | "clear"
  | "reproducing"
  | "reproduced"
  | "flaky"
  | "not-reproduced"
  | "inconclusive"
  | "error";

export interface CheckRecord {
  repo: string;
  number: number;
  title: string;
  url: string;
  verdict: Verdict;
  question: string | null;
  cause: { path: string; startLine: number; endLine: number; reason: string } | null;
  sentry: {
    shortId: string;
    title: string;
    events: number;
    users: number;
    firstRelease: string | null;
    permalink: string;
    frames: Array<{ file: string; line: number | null; function: string | null }>;
    breadcrumbs: string[];
  } | null;
  introducedIn: { sha: string; message: string } | null;
  openedAt: string;
  checkedAt: string;
}

export interface ProjectStore {
  list(): Promise<Project[]>;
  get(id: string): Promise<Project | null>;
  byRepo(repo: string): Promise<Project | null>;
  save(project: Project): Promise<void>;
  remove(id: string): Promise<void>;
}

export interface CheckStore {
  /** Insert or replace the record for repo#number. */
  record(check: CheckRecord): Promise<void>;
  get(repo: string, number: number): Promise<CheckRecord | null>;
  /** Newest first. */
  list(repo?: string, limit?: number): Promise<CheckRecord[]>;
}

/** "Repro Test" → "repro-test", unique among `taken`. */
export function projectId(name: string, taken: string[]): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "project";
  let id = base;
  for (let i = 2; taken.includes(id); i++) id = `${base}-${i}`;
  return id;
}

/** The project's Sentry link wins over the repo's own .github/norepro.yml. */
export function applyProject(config: NoReproConfig, project: Project | null): NoReproConfig {
  if (!project?.sentry) return config;
  return { ...config, sentry: { org: project.sentry.org, project: project.sentry.project } };
}

function verdictOf(outcome: TriageOutcome): Verdict {
  if (outcome.status !== "clear") return outcome.status;
  return reproVerdict(outcome.repro) ?? "clear";
}

export function reproVerdict(repro: ReproState | undefined): Verdict | null {
  if (!repro) return null;
  switch (repro.status) {
    case "running":
      return "reproducing";
    case "done":
      return repro.verdict.status === "steps-failed" ? "inconclusive" : repro.verdict.status;
    case "app-failed":
      return "inconclusive";
    case "error":
      return "error";
    default:
      return null; // disabled / not-feasible: stays a clear report
  }
}

/** Boil a triage outcome down to what the project page shows. */
export function checkRecordFrom(
  outcome: TriageOutcome,
  issue: { repo: string; number: number; title: string; url: string; openedAt: string },
  now = new Date().toISOString(),
): CheckRecord {
  const top = outcome.status === "clear" ? outcome.localization?.suspects[0] : undefined;
  const e = outcome.evidence;
  const bisect = outcome.status === "clear" && outcome.repro?.status === "done" ? outcome.repro.bisect : undefined;
  return {
    ...issue,
    verdict: verdictOf(outcome),
    question: outcome.status === "needs-info" ? outcome.question : null,
    cause: top ? { path: top.path, startLine: top.startLine, endLine: top.endLine, reason: top.reason } : null,
    sentry: e
      ? {
          shortId: e.issue.shortId,
          title: e.issue.title,
          events: e.issue.events,
          users: e.issue.users,
          firstRelease: e.issue.firstRelease,
          permalink: e.issue.permalink,
          frames: e.frames.slice(0, 3),
          breadcrumbs: e.breadcrumbs.slice(-4).map((b) => b.message).filter(Boolean),
        }
      : null,
    introducedIn: bisect?.status === "found" ? { sha: bisect.firstBad.sha, message: bisect.firstBad.message } : null,
    checkedAt: now,
  };
}

export interface ProjectStats {
  checked: number;
  askedForInfo: number;
  matchedInSentry: number;
  reproduced: number;
}

export function statsFor(checks: CheckRecord[]): ProjectStats {
  return {
    checked: checks.length,
    askedForInfo: checks.filter((c) => c.verdict === "needs-info").length,
    matchedInSentry: checks.filter((c) => c.sentry).length,
    reproduced: checks.filter((c) => c.verdict === "reproduced" || c.verdict === "flaky").length,
  };
}
