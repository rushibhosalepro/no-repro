// Confirm a clear bug report by replaying it on the repo owner's own GitHub Actions runner,
// then find the commit that introduced it.
//   start:  plan from report + source → dispatch the repo's No Repro workflow → "running"
//   finish: (on workflow_run completed) read the result → plain-code verdict, or re-plan once.
//           A confirmed bug with a known-good earlier commit → dispatch a bisect run.
//   bisect: (on its workflow_run completed) read the first bad commit.
import { randomBytes } from "node:crypto";
import type { CodeHost } from "../core/code.ts";
import type { NoReproConfig } from "../core/config.ts";
import type { StructuredModel } from "../core/model.ts";
import type { TriageOutcome } from "../core/report.ts";
import type { ActionsClient } from "./actions.ts";
import { bisectState, chooseRange, type BisectRange, type HistoryHost } from "./bisect.ts";
import type { Plan } from "./plan.ts";
import { planReproduction, type PageSnapshot } from "./planner.ts";
import type { ReproState } from "./state.ts";
import { decideVerdict, type RunOutcome } from "./verdict.ts";

export type ClearOutcome = Extract<TriageOutcome, { status: "clear" }>;
type Done = Extract<ReproState, { status: "done" }>;

/** A dispatched run waiting for its workflow_run event. */
export interface PendingRun {
  ref: string;
  kind: "replay" | "bisect";
  owner: string;
  repo: string;
  issue: number;
  installationId: number;
  round: number;
  plan: Plan;
  outcome: ClearOutcome;
  config: NoReproConfig;
  createdAt: string;
  /** bisect only: the range, and the replay verdict to show alongside the result */
  range?: BisectRange;
  replay?: Done;
}

export interface RunStore {
  save(run: PendingRun): Promise<void>;
  load(ref: string): Promise<PendingRun | null>;
  delete(ref: string): Promise<void>;
}

export interface ReproDeps {
  host: CodeHost;
  model: StructuredModel;
  actions: ActionsClient;
  store: RunStore;
  /** Without it, confirmed bugs aren't bisected. */
  history?: HistoryHost;
}

export interface IssueRef {
  owner: string;
  repo: string;
  issue: number;
  installationId: number;
}

const MAX_ROUNDS = 2;

async function dispatch(deps: ReproDeps, where: IssueRef, run: Omit<PendingRun, "ref" | "createdAt" | keyof IssueRef>, job: object): Promise<string> {
  const ref = randomBytes(6).toString("hex");
  await deps.store.save({ ref, ...where, ...run, createdAt: new Date().toISOString() });
  try {
    await deps.actions.dispatch({ issue: String(where.issue), ref, job: Buffer.from(JSON.stringify(job)).toString("base64") });
  } catch (err) {
    await deps.store.delete(ref); // a run that never started will never report back
    throw err;
  }
  return ref;
}

function replayJob(config: NoReproConfig, plan: Plan) {
  return { mode: "replay", baseUrl: config.app.baseUrl, reset: config.app.reset ?? null, runs: config.replay.runs, plan };
}

export async function startReproduction(
  outcome: ClearOutcome,
  config: NoReproConfig,
  where: IssueRef,
  deps: ReproDeps,
  round = 1,
  retry?: { previous: Plan; snapshot: PageSnapshot },
): Promise<ReproState> {
  if (!(await deps.actions.enabled())) return { status: "disabled" };

  const planned = await planReproduction(outcome.report, outcome.localization, deps.host, deps.model, config, retry, outcome.evidence);
  if (!planned.ok) return { status: "not-feasible", reason: planned.reason };

  await dispatch(deps, where, { kind: "replay", round, plan: planned.plan, outcome, config }, replayJob(config, planned.plan));
  return { status: "running", plan: planned.plan, round, runUrl: null };
}

/** The errors every run that showed the bug had in common: how bisect tells this bug from other failures. */
export function failureSignature(runs: RunOutcome[]): string[] {
  const failing = runs.filter((r) => r.ok && r.check && !r.check.passed);
  if (!failing.length) return [];
  return [...new Set(failing[0]!.errors ?? [])].filter((e) => failing.every((r) => (r.errors ?? []).includes(e)));
}

/** After a confirmed reproduction: look for the commit that introduced the bug, if there's a range to search. */
async function startBisect(pending: PendingRun, done: Done, deps: ReproDeps, signature: string[] = []): Promise<Done> {
  if (!deps.history) return done;
  const range = await chooseRange(pending.outcome.report, pending.outcome.localization, deps.history, pending.outcome.evidence);
  if ("skip" in range) return { ...done, bisect: { status: "skipped", reason: range.skip } };
  const where = { owner: pending.owner, repo: pending.repo, issue: pending.issue, installationId: pending.installationId };
  const job = { ...replayJob(pending.config, pending.plan), mode: "bisect", bisect: { good: range.good, bad: range.bad, runsPerCommit: 2, maxSteps: 12, signature } };
  const withBisect: Done = { ...done, bisect: { status: "running", range } };
  await dispatch(deps, where, { kind: "bisect", round: 1, plan: pending.plan, outcome: pending.outcome, config: pending.config, range, replay: withBisect }, job);
  return withBisect;
}

function tail(text: string, lines = 25): string {
  return text.trimEnd().split("\n").slice(-lines).join("\n");
}

/** Called when the repo's No Repro workflow run has finished. */
export async function finishReproduction(pending: PendingRun, runId: number, runUrl: string | null, deps: ReproDeps): Promise<ReproState> {
  await deps.store.delete(pending.ref);
  const result = await deps.actions.readResult(runId);

  if (pending.kind === "bisect" && pending.replay && pending.range) {
    const bisect = bisectState(pending.range, result.bisect);
    if (bisect.status === "found" && deps.history) {
      // The edit that broke it, for the collapsible "Show the change" in the comment.
      const path = pending.outcome.localization?.suspects[0]?.path ?? null;
      const change = await deps.history.changeIn(bisect.firstBad.sha, path).catch(() => null);
      if (change) bisect.change = change;
    }
    return { ...pending.replay, bisect, bisectRunUrl: runUrl };
  }

  if (!result.runs) {
    if (result.fatal && !result.appLog) return { status: "error", message: result.fatal, runUrl };
    return { status: "app-failed", runUrl, log: tail(result.appLog) || result.fatal || "No log was captured." };
  }

  const verdict = decideVerdict(result.runs);
  if (verdict.status === "steps-failed" && verdict.snapshot && pending.round < MAX_ROUNDS) {
    // The page didn't look the way the source suggested; correct the plan from what was really there.
    const where = { owner: pending.owner, repo: pending.repo, issue: pending.issue, installationId: pending.installationId };
    return startReproduction(pending.outcome, pending.config, where, deps, pending.round + 1, { previous: pending.plan, snapshot: verdict.snapshot });
  }
  const done: Done = { status: "done", plan: pending.plan, verdict, runUrl, baseUrl: pending.config.app.baseUrl };
  if (verdict.status === "reproduced" || verdict.status === "flaky") {
    try {
      return await startBisect(pending, done, deps, failureSignature(result.runs));
    } catch (err) {
      return { ...done, bisect: { status: "skipped", reason: `couldn't start the search: ${err instanceof Error ? err.message : err}` } };
    }
  }
  return done;
}
