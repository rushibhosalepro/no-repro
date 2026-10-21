// Plain code decides whether the bug was reproduced, from what the runner observed.
// The model wrote the plan; it has no say in the verdict.
import type { PageSnapshot } from "./planner.ts";

export interface RunOutcome {
  ok: boolean;
  failedStep: number | null;
  error: string | null;
  check?: { passed: boolean; detail: string };
  requests?: Array<{ method: string; path: string }>;
  errors?: string[];
  url?: string;
  text?: string;
  elements?: PageSnapshot["elements"];
}

export type ReproStatus = "reproduced" | "flaky" | "not-reproduced" | "steps-failed";

export interface Verdict {
  status: ReproStatus;
  /** Runs where the expected behaviour did NOT happen (i.e. the bug showed). */
  failed: number;
  /** Runs that completed every step. */
  completed: number;
  total: number;
  details: string[];
  /** One entry per run, for the results table. */
  runs: Array<{ ok: boolean; failedStep: number | null; bugShowed: boolean }>;
  /** When the steps couldn't be followed: what the page looked like, for re-planning. */
  snapshot?: PageSnapshot;
}

export function decideVerdict(runs: RunOutcome[]): Verdict {
  const completed = runs.filter((r) => r.ok && r.check);
  const failed = completed.filter((r) => !r.check!.passed);
  const details = runs.map((r, i) =>
    !r.ok ? `Run ${i + 1}: couldn't do step ${(r.failedStep ?? 0) + 1} (${r.error ?? "unknown error"})` : `Run ${i + 1}: ${r.check?.passed ? "behaved correctly" : "bug showed"}, ${r.check?.detail ?? ""}`,
  );
  const perRun = runs.map((r) => ({ ok: r.ok, failedStep: r.failedStep, bugShowed: Boolean(r.ok && r.check && !r.check.passed) }));
  if (!completed.length) {
    const stuck = runs.find((r) => !r.ok);
    return {
      status: "steps-failed",
      failed: 0,
      completed: 0,
      total: runs.length,
      details,
      runs: perRun,
      snapshot: stuck ? { url: stuck.url, text: stuck.text, error: stuck.error, failedStep: stuck.failedStep, elements: stuck.elements } : undefined,
    };
  }
  const status: ReproStatus = failed.length === 0 ? "not-reproduced" : failed.length === completed.length ? "reproduced" : "flaky";
  return { status, failed: failed.length, completed: completed.length, total: runs.length, details, runs: perRun };
}
