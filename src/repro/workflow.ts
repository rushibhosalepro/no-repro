// The GitHub Actions workflow a repo owner adds to let No Repro confirm bugs.
// It runs on THEIR runner with THEIR secrets. No Repro sends a plan (plain data: browser
// steps + one check); the runner installs and starts their app (once, or once per commit
// when bisecting) and uploads the result. No Repro never executes the repo's code itself.
import type { NoReproConfig } from "../core/config.ts";

export const RUN_WORKFLOW_FILE = "norepro.yml";
export const RUN_WORKFLOW_PATH = `.github/workflows/${RUN_WORKFLOW_FILE}`;
export const RUNNER_PATH = ".github/norepro/runner.mjs";
export const RESULT_ARTIFACT = "norepro-result";
export const PLAYWRIGHT_VERSION = "1.64.1";

/** `run-name` carries the issue and our run id, so the finished run can be matched back. */
export function parseRunTitle(title: string): { issue: number; ref: string } | null {
  const m = title.match(/^No Repro · issue #(\d+) · ([a-f0-9]{8,})$/);
  return m ? { issue: Number(m[1]), ref: m[2]! } : null;
}

const secretName = /^[A-Z_][A-Z0-9_]*$/;
/** GitHub Actions expression, written out literally (keeps `${{ }}` out of template literals). */
const gh = (expr: string) => "${{ " + expr + " }}";
/** JSON strings are valid YAML double-quoted scalars, so commands with quotes or colons survive. */
const q = (v: string) => JSON.stringify(v);

export function runWorkflowYaml(config: NoReproConfig): string {
  const start = config.app.start;
  if (!start) throw new Error("app.start is required in .github/norepro.yml to run reproductions.");
  const install = config.run.install;
  const url = new URL(config.app.ready, config.app.baseUrl).toString();
  const port = new URL(config.app.baseUrl).port || "80";
  const usesBun = /\bbun\b/.test(`${install} ${start}`);
  for (const name of config.run.env) if (!secretName.test(name)) throw new Error(`run.env: "${name}" isn't a valid secret name`);

  const lines = [
    "# Added by No Repro. Lets No Repro confirm reported bugs by replaying them in a browser",
    "# on this repo's own runner, with this repo's own secrets. No Repro starts this workflow with a",
    "# plan (browser steps + one check). The runner installs and starts the app (once, or once per",
    "# commit when finding the commit that introduced a bug with git bisect) and uploads the result.",
    "name: No Repro",
    `run-name: "No Repro · issue #${gh("inputs.issue")} · ${gh("inputs.ref")}"`,
    "",
    "on:",
    "  workflow_dispatch:",
    "    inputs:",
    "      issue:",
    "        description: Issue number",
    "        required: true",
    "      ref:",
    "        description: No Repro run id",
    "        required: true",
    "      job:",
    "        description: Reproduction plan written by No Repro (base64 JSON)",
    "        required: true",
    "",
    "permissions:",
    "  contents: read",
    "",
    "concurrency:",
    `  group: norepro-${gh("inputs.issue")}`,
    "  cancel-in-progress: false",
    "",
    "jobs:",
    "  reproduce:",
    "    runs-on: ubuntu-latest",
    "    timeout-minutes: 30",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "        with:",
    "          fetch-depth: 0 # full history, for git bisect",
    "      - uses: actions/setup-node@v4",
    "        with:",
    "          node-version: 22",
    ...(usesBun ? ["      - uses: oven-sh/setup-bun@v2"] : []),
    "",
    "      - name: Set up browser",
    "        run: |",
    '          mkdir -p "$RUNNER_TEMP/norepro"',
    `          cp ${RUNNER_PATH} "$RUNNER_TEMP/norepro/"`,
    '          cd "$RUNNER_TEMP/norepro"',
    "          npm init -y > /dev/null",
    `          npm install --no-audit --no-fund playwright@${PLAYWRIGHT_VERSION}`,
    "          npx playwright install --with-deps chromium",
    "",
    "      - name: Reproduce",
    `        working-directory: ${gh("runner.temp")}/norepro`,
    "        env:",
    "          # Passed through env, never pasted into the script, so the plan can't inject shell.",
    `          JOB: ${gh("inputs.job")}`,
    `          NOREPRO_APP_DIR: ${gh("github.workspace")}`,
    `          NOREPRO_APP_LOG: ${gh("runner.temp")}/norepro/app.log`,
    `          NOREPRO_INSTALL: ${q(install)}`,
    `          NOREPRO_START: ${q(start)}`,
    `          NOREPRO_READY_URL: ${q(url)}`,
    `          PORT: "${port}"`,
    "          # What the app needs to start. The values stay in this repo's secrets.",
    ...config.run.env.map((n) => `          ${n}: ${gh(`secrets.${n}`)}`),
    "        run: |",
    '          echo "$JOB" | base64 -d > job.json',
    "          node runner.mjs job.json result.json || true",
    "",
    "      - uses: actions/upload-artifact@v4",
    "        if: always()",
    "        with:",
    `          name: ${RESULT_ARTIFACT}`,
    "          path: |",
    `            ${gh("runner.temp")}/norepro/result.json`,
    `            ${gh("runner.temp")}/norepro/app.log`,
    "          if-no-files-found: ignore",
    "          retention-days: 7",
    "",
  ];
  return lines.join("\n");
}
