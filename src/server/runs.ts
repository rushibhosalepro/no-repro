// Handling workflow_run events for reproduction runs started by No Repro.
import { modelFor } from "../core/providers/index.ts";
import { renderOutcome, REPRO_LABELS } from "../core/render.ts";
import { GitHubCodeHost, GitHubHistory } from "../github/code.ts";
import { IssueHandle } from "../github/repo.ts";
import { GitHubActions } from "../repro/actions.ts";
import { finishReproduction, type RunStore } from "../repro/index.ts";
import { parseRunTitle, RUN_WORKFLOW_PATH } from "../repro/workflow.ts";
import { installationOctokit } from "./app.ts";
import type { AppCredentials } from "./store.ts";

export interface RunEventJob {
  app: AppCredentials;
  installationId: number;
  owner: string;
  repo: string;
  action: "in_progress" | "completed";
  runId: number;
  runUrl: string;
  ref: string;
  issue: number;
}

/** Pick out workflow_run events that belong to a No Repro reproduction run; ignore everything else. */
export function runEventFrom(payload: any, app: AppCredentials): RunEventJob | null {
  const run = payload?.workflow_run;
  if (!run || run.path !== RUN_WORKFLOW_PATH) return null;
  if (payload.action !== "in_progress" && payload.action !== "completed") return null;
  const parsed = parseRunTitle(String(run.display_title ?? ""));
  const [owner, repo] = String(payload.repository?.full_name ?? "").split("/");
  if (!parsed || !owner || !repo || !payload.installation?.id) return null;
  return {
    app,
    installationId: payload.installation.id,
    owner,
    repo,
    action: payload.action,
    runId: run.id,
    runUrl: run.html_url,
    ref: parsed.ref,
    issue: parsed.issue,
  };
}

export async function defaultProcessRun(job: RunEventJob, runs: RunStore, env: Record<string, string | undefined>, log: (m: string) => void): Promise<void> {
  const pending = await runs.load(job.ref);
  // Unknown ref: a stale run, or one someone started by hand. Only act on runs we dispatched for this repo and issue.
  if (!pending || pending.owner !== job.owner || pending.repo !== job.repo || pending.issue !== job.issue) return;

  const octokit = installationOctokit(job.app, job.installationId);
  const handle = new IssueHandle(octokit, job.owner, job.repo, pending.issue);
  const state = (await handle.loadState()) ?? { runs: 1, status: "clear" as const };
  const at = `${job.owner}/${job.repo} #${pending.issue}`;

  if (job.action === "in_progress") {
    // Now that the run exists, link to it so people can watch.
    const repro =
      pending.kind === "bisect" && pending.replay
        ? { ...pending.replay, bisectRunUrl: job.runUrl }
        : { status: "running" as const, plan: pending.plan, round: pending.round, runUrl: job.runUrl };
    const outcome = { ...pending.outcome, repro };
    await handle.upsertComment(renderOutcome(outcome, { runs: state.runs, status: "clear" }));
    log(`${at}: run started ${job.runUrl}`);
    return;
  }

  const model = modelFor(pending.config, env);
  const deps = {
    host: new GitHubCodeHost(octokit, job.owner, job.repo),
    history: new GitHubHistory(octokit, job.owner, job.repo),
    model,
    actions: new GitHubActions(octokit, job.owner, job.repo),
    store: runs,
  };
  const repro = await finishReproduction(pending, job.runId, job.runUrl, deps);
  const outcome = { ...pending.outcome, repro };
  await handle.upsertComment(renderOutcome(outcome, { runs: state.runs, status: "clear" }));
  if (repro.status === "done") {
    await handle.setStatusLabel(REPRO_LABELS[repro.verdict.status], await handle.getIssue());
    const b = repro.bisect;
    log(`${at}: ${repro.verdict.status} (${repro.verdict.failed}/${repro.verdict.completed})${b ? `, bisect ${b.status}${b.status === "found" ? ` ${b.firstBad.sha.slice(0, 7)}` : ""}` : ""}`);
  } else {
    log(`${at}: run finished: ${repro.status}`);
  }
}
