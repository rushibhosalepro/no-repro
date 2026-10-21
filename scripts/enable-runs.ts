// Dev helper: add the No Repro run workflow and browser runner to a local checkout.
//   bun scripts/enable-runs.ts ../repro-test
// (Later, No Repro will open this as a PR itself.)
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DEFAULT_CONFIG_PATH, loadConfig } from "../src/core/config.ts";
import { RUN_WORKFLOW_PATH, RUNNER_PATH, runWorkflowYaml } from "../src/repro/workflow.ts";

const arg = process.argv[2];
if (!arg) throw new Error("usage: bun scripts/enable-runs.ts <repo-dir>");
const dir = resolve(arg);
const config = await loadConfig(join(dir, DEFAULT_CONFIG_PATH));
const files: Array<[string, string]> = [
  [RUN_WORKFLOW_PATH, runWorkflowYaml(config)],
  [RUNNER_PATH, await readFile(new URL("../src/repro/runner.mjs", import.meta.url), "utf8")],
];
for (const [path, content] of files) {
  const folder = dirname(join(dir, path));
  if (!existsSync(folder)) await mkdir(folder, { recursive: true });
  await writeFile(join(dir, path), content);
  console.log(`wrote ${join(dir, path)}`);
}
