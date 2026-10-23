// Finding the commit that introduced a confirmed bug. The repo owner's runner does the
// actual `git bisect` (see runner.mjs); this module picks the range and reads the result.
import type { Localization } from "../core/localize.ts";
import type { BugReport } from "../core/report.ts";
import type { Evidence } from "../evidence/index.ts";

export interface CommitRef {
  sha: string;
  message: string;
  author: string;
  date: string;
}

/** Read-only repo history, enough to choose a known-good commit. */
export interface HistoryHost {
  /** A tag, branch or (short) sha → full sha, or null. */
  resolveRef(ref: string): Promise<string | null>;
  /** Newest tag that is an ancestor of `sha` (and isn't `sha` itself). */
  latestTagBefore(sha: string): Promise<{ name: string; sha: string } | null>;
  parentOf(sha: string): Promise<string | null>;
  /** Commits in good..bad (reachable from bad, not from good). 0 means good isn't behind bad. */
  commitsBetween(good: string, bad: string): Promise<number>;
  /** The diff a commit made, preferring `path` (the suspect file) if that commit touched it. */
  changeIn(sha: string, path: string | null): Promise<FileChange | null>;
}

export interface FileChange {
  path: string;
  patch: string;
}

export interface BisectRange {
  good: string;
  bad: string;
  /** Why this commit is believed to be good, for the comment. */
  goodLabel: string;
  commits: number;
}

export type BisectState =
  | { status: "running"; range: BisectRange }
  | { status: "found"; range: BisectRange; firstBad: CommitRef; good: CommitRef; tested: number; skipped: number; change?: FileChange }
  | { status: "not-regression"; range: BisectRange; good: CommitRef }
  | { status: "inconclusive"; range: BisectRange; reason: string }
  | { status: "skipped"; reason: string };

/** What the runner uploads for a bisect job. */
export interface BisectResult {
  status: "found" | "not-regression" | "inconclusive";
  reason?: string;
  good: CommitRef;
  bad: CommitRef;
  firstBad?: CommitRef;
  steps: Array<{ sha: string; result: "good" | "bad" | "skip"; why?: string }>;
}

const MAX_COMMITS = 500; // ~9 bisect steps; beyond that a run would take too long

/**
 * Pick a commit believed to be free of the bug, most trustworthy first:
 *   1. the version the reporter says worked ("works in 4.22.0")
 *   1b. the release before Sentry first saw the error
 *   2. the newest release tag before the current commit
 *   3. the commit just before the suspected lines last changed
 * Returns null when there's no sensible range (e.g. the lines have been there since the file was created).
 */
export async function chooseRange(
  report: BugReport,
  localization: Localization | undefined,
  history: HistoryHost,
  evidence?: Evidence | null,
): Promise<BisectRange | { skip: string }> {
  const bad = localization?.sha;
  if (!bad) return { skip: "the code wasn't read, so there's no commit to start from" };

  const candidates: Array<{ sha: string | null; label: string }> = [];
  if (report.lastWorkingVersion) {
    const v = report.lastWorkingVersion.trim();
    const sha = (await history.resolveRef(v)) ?? (await history.resolveRef(`v${v.replace(/^v/i, "")}`));
    candidates.push({ sha, label: `${v}, which the reporter says worked` });
  }
  const firstSeen = evidence?.issue.firstRelease;
  if (firstSeen) {
    // Sentry first saw it in this release, so the release before it is the best guess for "good".
    const seenAt = (await history.resolveRef(firstSeen)) ?? (await history.resolveRef(`v${firstSeen.replace(/^v/i, "")}`));
    const before = seenAt ? await history.latestTagBefore(seenAt) : null;
    if (before) candidates.push({ sha: before.sha, label: `${before.name}, the release before Sentry first saw this in ${firstSeen}` });
  }
  const tag = await history.latestTagBefore(bad);
  if (tag) candidates.push({ sha: tag.sha, label: `${tag.name}, the latest release before this commit` });
  const suspect = localization.suspects[0];
  if (suspect?.commit && !suspect.commit.addedFile) {
    candidates.push({ sha: await history.parentOf(suspect.commit.sha), label: `the commit before \`${suspect.commit.sha.slice(0, 7)}\`, which last changed the suspected lines` });
  }

  for (const c of candidates) {
    if (!c.sha || c.sha === bad) continue;
    const commits = await history.commitsBetween(c.sha, bad);
    if (commits < 1) continue; // not an ancestor of the current commit
    if (commits > MAX_COMMITS) return { skip: `${commits} commits since ${c.label} is too many to bisect` };
    return { good: c.sha, bad, goodLabel: c.label, commits };
  }
  if (suspect?.commit?.addedFile) return { skip: "the suspected lines have been there since the file was created" };
  return { skip: "no earlier version is known to work" };
}

/** Turn the runner's bisect output into what the comment shows. */
export function bisectState(range: BisectRange, result: BisectResult | undefined): BisectState {
  if (!result) return { status: "inconclusive", range, reason: "the run uploaded no bisect result" };
  const tested = result.steps.filter((s) => s.result !== "skip").length;
  const skipped = result.steps.length - tested;
  if (result.status === "found" && result.firstBad) return { status: "found", range, firstBad: result.firstBad, good: result.good, tested, skipped };
  if (result.status === "not-regression") return { status: "not-regression", range, good: result.good };
  return { status: "inconclusive", range, reason: result.reason ?? "bisect didn't finish" };
}
