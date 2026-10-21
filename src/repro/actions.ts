// Starting the No Repro workflow on the repo owner's GitHub Actions, and reading its result.
import type { Octokit } from "@octokit/rest";
import { unzipSync, strFromU8 } from "fflate";
import type { BisectResult } from "./bisect.ts";
import type { RunOutcome } from "./verdict.ts";
import { RESULT_ARTIFACT, RUN_WORKFLOW_FILE } from "./workflow.ts";

export interface RunResult {
  /** null when the runner produced no result (e.g. the app never started). */
  runs: RunOutcome[] | null;
  /** bisect runs only */
  bisect?: BisectResult;
  fatal: string | null;
  appLog: string;
}

/** Everything reproduction needs from GitHub Actions. Faked in tests. */
export interface ActionsClient {
  /** Has the repo added the No Repro workflow on its default branch? */
  enabled(): Promise<boolean>;
  dispatch(inputs: { issue: string; ref: string; job: string }): Promise<void>;
  readResult(runId: number): Promise<RunResult>;
}

export class GitHubActions implements ActionsClient {
  constructor(
    private readonly octokit: Octokit,
    private readonly owner: string,
    private readonly repo: string,
  ) {}

  async enabled(): Promise<boolean> {
    try {
      const { data } = await this.octokit.actions.getWorkflow({ owner: this.owner, repo: this.repo, workflow_id: RUN_WORKFLOW_FILE });
      return data.state === "active";
    } catch (err: any) {
      if (err?.status === 404) return false;
      throw err;
    }
  }

  async dispatch(inputs: { issue: string; ref: string; job: string }): Promise<void> {
    const { data: repo } = await this.octokit.repos.get({ owner: this.owner, repo: this.repo });
    try {
      await this.octokit.actions.createWorkflowDispatch({
        owner: this.owner,
        repo: this.repo,
        workflow_id: RUN_WORKFLOW_FILE,
        ref: repo.default_branch,
        inputs,
      });
    } catch (err: any) {
      if (err?.status === 403) {
        throw new Error(
          "No Repro isn't allowed to start workflows in this repo yet. The repo owner needs to accept No Repro's updated permissions (Actions: read and write) in the repo's GitHub App settings.",
        );
      }
      throw err;
    }
  }

  async readResult(runId: number): Promise<RunResult> {
    const { data } = await this.octokit.actions.listWorkflowRunArtifacts({ owner: this.owner, repo: this.repo, run_id: runId, per_page: 100 });
    const artifact = data.artifacts.find((a) => a.name === RESULT_ARTIFACT && !a.expired);
    if (!artifact) return { runs: null, fatal: "The run uploaded no result.", appLog: "" };
    const zip = await this.octokit.actions.downloadArtifact({ owner: this.owner, repo: this.repo, artifact_id: artifact.id, archive_format: "zip" });
    return parseResultZip(new Uint8Array(zip.data as ArrayBuffer));
  }
}

/** The artifact zip holds result.json (from runner.mjs) and app.log. */
export function parseResultZip(zip: Uint8Array): RunResult {
  const files = unzipSync(zip);
  const find = (name: string) => Object.entries(files).find(([path]) => path === name || path.endsWith(`/${name}`))?.[1];
  const appLog = find("app.log") ? strFromU8(find("app.log")!) : "";
  const raw = find("result.json");
  if (!raw) return { runs: null, fatal: null, appLog };
  const result = JSON.parse(strFromU8(raw)) as { runs?: RunOutcome[]; fatal?: string; bisect?: BisectResult };
  return { runs: result.runs ?? null, fatal: result.fatal ?? null, appLog, ...(result.bisect ? { bisect: result.bisect } : {}) };
}
