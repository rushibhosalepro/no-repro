// Local dev tool: triage an issue written in a markdown file, without GitHub.
//   bun src/cli.ts triage <issue.md> [--model <id>] [--repo-dir <git checkout>]
// With --repo-dir it also reads that checkout's code to point at the likely faulty lines.
// Repos are connected through the GitHub App (see src/server), not from here.
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { parseArgs } from "node:util";
import { checkClarity, reportExtractor, type IssueThread } from "./core/clarity.ts";
import { DEFAULT_CONFIG_PATH, loadConfig } from "./core/config.ts";
import { LocalGitHost } from "./core/localgit.ts";
import { localize } from "./core/localize.ts";
import { modelFor } from "./core/providers/index.ts";
import { renderOutcome } from "./core/render.ts";
import { withServerModel } from "./server/index.ts";

const USAGE = `usage: bun src/cli.ts triage <issue.md> [--config ${DEFAULT_CONFIG_PATH}] [--model <id>] [--repo-dir <path>]`;

/** A markdown file whose first `# heading` is the issue title and the rest is the body. */
export function threadFromMarkdown(text: string, fallbackTitle: string): IssueThread {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const headingIndex = lines.findIndex((l) => l.startsWith("# "));
  if (headingIndex === -1) return { title: fallbackTitle, body: text.trim(), replies: [] };
  const title = lines[headingIndex]!.slice(2).trim();
  const body = lines.filter((_, i) => i !== headingIndex).join("\n").trim();
  return { title, body, replies: [] };
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: "string", default: DEFAULT_CONFIG_PATH },
      model: { type: "string" },
      "repo-dir": { type: "string" },
    },
  });
  const [command, target] = positionals;
  if (command !== "triage" || !target) {
    console.log(USAGE);
    process.exitCode = command ? 1 : 0;
    return;
  }
  // Same model choice as the server: NOREPRO_PROVIDER / NOREPRO_MODEL, or --model.
  const env = { ...process.env, ...(values.model ? { NOREPRO_MODEL: values.model } : {}) };
  const config = withServerModel(await loadConfig(values.config!), env);
  const model = modelFor(config, env);
  const thread = threadFromMarkdown(await readFile(target, "utf8"), basename(target));
  const outcome = await checkClarity(thread, config, reportExtractor(model));
  if (outcome.status === "clear" && values["repo-dir"]) {
    outcome.localization = await localize(outcome.report, new LocalGitHost(values["repo-dir"]), model, config);
  }
  console.log(JSON.stringify(outcome, null, 2));
  console.log("\n--- comment preview ---\n");
  console.log(renderOutcome(outcome, { runs: 1, status: outcome.status }));
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
