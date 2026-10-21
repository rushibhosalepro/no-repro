import { checkClarity, type ReportExtractor } from "../core/clarity.ts";
import type { NoReproConfig } from "../core/config.ts";
import type { Localization } from "../core/localize.ts";
import type { BugReport, TriageOutcome } from "../core/report.ts";
import type { ClearOutcome } from "../repro/index.ts";
import type { ReproState } from "../repro/state.ts";
import { renderError, renderOutcome, renderScanning, renderWorking, STATUS_LABELS, type AgentState } from "../core/render.ts";
import { decide, type IssueEvent } from "./event.ts";
import type { IssueHandle } from "./repo.ts";

export type RunResult =
  | { ran: false; reason: string }
  | { ran: true; outcome: TriageOutcome }
  | { ran: true; error: string };

type Log = (msg: string) => void;

/** What the agent can do. `locate` is optional: without it, clear reports stop at the summary. */
export interface Agent {
  extract: ReportExtractor;
  locate?: (report: BugReport) => Promise<Localization>;
  /** Start a browser reproduction on the repo's own GitHub Actions runner. Finishes later via workflow_run. */
  reproduce?: (outcome: ClearOutcome) => Promise<ReproState>;
}

/**
 * One agent pass over one issue: decide whether to act, post a "working" comment straight away,
 * triage, then replace the comment with the verdict and set the status label.
 * `event` is null for manual runs (CLI), which always act.
 */
export async function runOnIssue(
  handle: IssueHandle,
  event: IssueEvent | null,
  config: NoReproConfig,
  agent: Agent,
  log: Log = console.log,
): Promise<RunResult> {
  const previous = await handle.loadState();

  if (event) {
    const decision = decide(event, previous, config);
    log(`#${handle.number}: ${decision.act ? "acting" : "skipping"} (${decision.reason})`);
    if (!decision.act) {
      return { ran: false, reason: decision.reason };
    }
  }

  const state: AgentState = { runs: (previous?.runs ?? 0) + 1, status: "working" };
  await handle.upsertComment(renderWorking(state));

  try {
    const issue = await handle.getIssue(); // fresh copy: the body may have been edited since the event fired
    const thread = await handle.loadThread(issue);
    const outcome = await checkClarity(thread, config, agent.extract);
    const done: AgentState = { runs: state.runs, status: outcome.status };
    await handle.setStatusLabel(STATUS_LABELS[outcome.status], issue);

    if (outcome.status === "clear" && agent.locate && config.localize) {
      // Show the clear verdict straight away, then fill in the likely cause.
      await handle.upsertComment(renderScanning(outcome, done));
      try {
        outcome.localization = await agent.locate(outcome.report);
        const top = outcome.localization.suspects[0];
        log(`#${handle.number}: located ${top ? `${top.path}:${top.startLine}-${top.endLine} (${top.confidence})` : "nothing"}`);
      } catch (err) {
        // Locating is a bonus; a failure here must not hide the verdict.
        outcome.localizeError = err instanceof Error ? err.message : String(err);
        log(`#${handle.number}: locate failed: ${outcome.localizeError}`);
      }
    }
    if (outcome.status === "clear" && agent.reproduce) {
      try {
        outcome.repro = await agent.reproduce(outcome);
        log(`#${handle.number}: reproduction ${outcome.repro.status}`);
      } catch (err) {
        outcome.repro = { status: "error", message: err instanceof Error ? err.message : String(err), runUrl: null };
        log(`#${handle.number}: reproduction failed to start: ${outcome.repro.message}`);
      }
    }
    await handle.upsertComment(renderOutcome(outcome, done));
    log(`#${handle.number}: ${outcome.status}`);
    return { ran: true, outcome };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`#${handle.number}: error: ${message}`);
    await handle.upsertComment(renderError({ runs: state.runs, status: "error" }, message));
    return { ran: true, error: message };
  }
}
