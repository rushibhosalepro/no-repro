// The one comment No Repro keeps on each issue. Goal: a maintainer understands what
// happened, why it may have happened, and whether to trust it, in under 30 seconds.
// Layout: verdict → summary table → run results → likely cause → links → conclusion.
// Logs and step details appear only when they explain an unusual result.
import type { Suspect } from "./localize.ts";
import { describeStep } from "../repro/plan.ts";
import type { ReproState } from "../repro/state.ts";
import type { ReproStatus, Verdict } from "../repro/verdict.ts";
import type { BugReport, TriageOutcome, TriageStatus } from "./report.ts";

// The agent keeps exactly one comment per issue and edits it in place.
// Its state lives in a hidden marker so no database is needed.
export const COMMENT_MARKER = "<!-- norepro:comment -->";
const STATE_PATTERN = /<!-- norepro:state (\{.*?\}) -->/;

export interface AgentState {
  runs: number;
  status: TriageStatus | "working" | "error";
}

export const INITIAL_STATE: AgentState = { runs: 0, status: "working" };

export function readState(commentBody: string | undefined): AgentState {
  const match = commentBody?.match(STATE_PATTERN);
  if (!match?.[1]) return INITIAL_STATE;
  try {
    const parsed = JSON.parse(match[1]) as Partial<AgentState>;
    return { runs: Number(parsed.runs) || 0, status: parsed.status ?? "working" };
  } catch {
    return INITIAL_STATE;
  }
}

function footer(state: AgentState, note = "Generated automatically by No Repro. A maintainer will review."): string {
  return `\n\n<sub>${note}</sub>\n${COMMENT_MARKER}\n<!-- norepro:state ${JSON.stringify(state)} -->`;
}

/**
 * Text that came from the issue goes back into our comment, so neutralise anything
 * that would change its meaning: table pipes, line breaks, and @mentions (no pinging people).
 */
export function cell(text: string): string {
  return text.replace(/\r?\n+/g, " ").replace(/\|/g, "\\|").replace(/@(?=\w)/g, "@\u200b").trim();
}

/** First sentence, capped, for one-line explanations. */
function brief(text: string, max = 180): string {
  const first = cell(text).split(/(?<=[.!?])\s/)[0] ?? "";
  return first.length > max ? `${first.slice(0, max - 1).trimEnd()}…` : first;
}

/** Show a value exactly; quote it when spaces at the ends matter ("shoes "). */
function exact(value: string): string {
  const shown = value !== value.trim() ? JSON.stringify(value) : value;
  return `\`${shown.replace(/`/g, "'")}\``;
}

const DEVICE: Record<BugReport["environment"]["device"], string> = { mobile: "mobile", desktop: "desktop", tablet: "tablet", unknown: "" };

// ---------- collapsible code ----------

const MAX_DIFF_LINES = 60;

/** A <details> block, collapsed by default, so the comment stays short. */
function dropdown(summary: string, body: string): string {
  return `<details><summary>${summary}</summary>\n\n${body}\n\n</details>`;
}

/** A fenced block that can't be broken out of: the fence is longer than any backtick run inside. */
function fenced(content: string, lang: string): string {
  const longest = Math.max(2, ...(content.match(/`+/g) ?? []).map((m) => m.length));
  const fence = "`".repeat(longest + 1);
  return `${fence}${lang}\n${content}\n${fence}`;
}

function trimLines(text: string, max: number): string {
  const lines = text.trimEnd().split("\n");
  return lines.length > max ? [...lines.slice(0, max), `… ${lines.length - max} more lines`].join("\n") : lines.join("\n");
}

const LANGUAGES: Record<string, string> = {
  ts: "ts", tsx: "tsx", js: "js", jsx: "jsx", mjs: "js", cjs: "js", py: "python", go: "go", rb: "ruby", java: "java",
  kt: "kotlin", php: "php", cs: "csharp", rs: "rust", swift: "swift", vue: "vue", svelte: "svelte", html: "html", css: "css", scss: "scss", sql: "sql",
};

function languageOf(path: string): string {
  return LANGUAGES[path.split(".").pop()?.toLowerCase() ?? ""] ?? "";
}

/** Numbered lines, with the suspect lines marked by "→" so they stand out without colour. */
function codeBlock(s: Suspect): string {
  const code = s.code!;
  const width = String(code.firstLine + code.lines.length - 1).length;
  return code.lines
    .map((line, i) => {
      const n = code.firstLine + i;
      const mark = n >= s.startLine && n <= s.endLine ? "→" : " ";
      return `${mark} ${String(n).padStart(width)} | ${line}`;
    })
    .join("\n");
}

function table(header: [string, string], rows: Array<[string, string]>): string {
  return `| ${header[0]} | ${header[1]} |\n| --- | --- |\n${rows.map(([k, v]) => `| ${k} | ${v} |`).join("\n")}`;
}

type Clear = Extract<TriageOutcome, { status: "clear" }>;

// ---------- verdict ----------

const VERDICT: Record<ReproStatus, string> = {
  reproduced: "Reproduced",
  flaky: "Flaky",
  "not-reproduced": "Not reproduced",
  "steps-failed": "Inconclusive",
};

function heading(outcome: TriageOutcome): string {
  if (outcome.status === "needs-info") return "Needs information";
  if (outcome.status === "out-of-scope") return "Needs a human";
  const repro = outcome.repro;
  if (repro?.status === "done") return VERDICT[repro.verdict.status];
  if (repro?.status === "running") return "Reproducing…";
  if (repro?.status === "app-failed") return "Inconclusive";
  return "Clear report";
}

function runsLine(repro: ReproState | undefined): string {
  if (repro?.status !== "done") return "";
  const v = repro.verdict;
  if (v.status === "steps-failed") return `0/${v.total} runs completed`;
  return `${v.failed}/${v.completed} runs`;
}

// ---------- summary ----------

function environment(outcome: Clear | TriageOutcome): string {
  const r = outcome.report;
  const device = DEVICE[r.environment.device];
  const ran = outcome.status === "clear" && (outcome.repro?.status === "done" || outcome.repro?.status === "running");
  if (ran) {
    const viewport = outcome.status === "clear" && "plan" in outcome.repro! ? (outcome.repro.plan.viewport.width < 600 ? "mobile" : "desktop") : device;
    return `Chromium, ${viewport} viewport`;
  }
  return [device, r.environment.browser ? cell(r.environment.browser) : ""].filter(Boolean).join(", ");
}

function summary(outcome: TriageOutcome): string {
  const r = outcome.report;
  const missing = "—";
  const rows: Array<[string, string]> = [
    ["Where", r.page ? exact(r.page) : missing],
    ["Expected", r.expected ? cell(r.expected) : missing],
    ["Observed", r.actual ? cell(r.actual) : missing],
  ];
  const env = environment(outcome);
  if (env) rows.push(["Environment", env]);
  if (r.testValues.length) rows.push(["Exact values", r.testValues.map(exact).join(" ")]);
  const sha = outcome.status === "clear" ? outcome.localization?.sha : undefined;
  if (sha) rows.push(["Commit", `\`${sha.slice(0, 7)}\``]);
  return table(["Field", "Result"], rows);
}

// ---------- runs ----------

function runResults(v: Verdict): string {
  if (!v.runs.length) return "";
  const rows = v.runs.map((run, i): [string, string] => [
    String(i + 1),
    !run.ok ? `Couldn't do step ${(run.failedStep ?? 0) + 1}` : run.bugShowed ? "Reproduced" : "Not reproduced",
  ]);
  return `**Test results**\n\n${table(["Run", "Result"], rows)}`;
}

// ---------- likely cause ----------

function causeLine(s: Suspect): string {
  const range = s.startLine === s.endLine ? `${s.startLine}` : `${s.startLine}–${s.endLine}`;
  const since = s.commit ? ` Last changed in \`${s.commit.sha.slice(0, 7)}\`${s.commit.addedFile ? " (when the file was created)" : ""}.` : "";
  return `\`${s.path}:${range}\` — ${brief(s.reason)}${since}`;
}

function likelyCause(outcome: Clear): string {
  if (outcome.localizeError) return `**Likely cause**\n\nCouldn't read the code this time.`;
  const loc = outcome.localization;
  if (!loc) return "";
  const top = loc.suspects[0];
  if (!top) return `**Likely cause**\n\nNothing in the ${loc.filesRead} source file${loc.filesRead === 1 ? "" : "s"} read clearly explains this.`;
  const code = top.code ? dropdown("Show the code", fenced(codeBlock(top), languageOf(top.path))) : "";
  return [`**Likely cause**`, causeLine(top), code].filter(Boolean).join("\n\n");
}

function links(outcome: Clear): string {
  const out: string[] = [];
  const top = outcome.localization?.suspects[0];
  if (top?.link) out.push(`[View source code](${top.link})`);
  const repro = outcome.repro;
  if (repro && "runUrl" in repro && repro.runUrl) out.push(`[View test run](${repro.runUrl})`);
  if (repro?.status === "done" && repro.bisectRunUrl) out.push(`[View bisect run](${repro.bisectRunUrl})`);
  return out.join(" · ");
}

// ---------- introduced in (git bisect) ----------

/** https://github.com/owner/repo, from any link we have, for commit links. */
function repoBase(outcome: Clear): string | null {
  const urls = [outcome.localization?.suspects[0]?.link, outcome.repro && "runUrl" in outcome.repro ? outcome.repro.runUrl : null];
  for (const u of urls) {
    const m = u?.match(/^(https:\/\/github\.com\/[^/]+\/[^/]+)\//);
    if (m) return m[1]!;
  }
  return null;
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

function commitRef(sha: string, base: string | null): string {
  const short = `\`${sha.slice(0, 7)}\``;
  return base ? `[${short}](${base}/commit/${sha})` : short;
}

function introducedIn(outcome: Clear): string {
  const repro = outcome.repro;
  if (repro?.status !== "done" || !repro.bisect || repro.bisect.status === "skipped") return "";
  const b = repro.bisect;
  const base = repoBase(outcome);
  switch (b.status) {
    case "running":
      return `**Introduced in**\n\nSearching the ${plural(b.range.commits, "commit")} since ${b.range.goodLabel} with git bisect…`;
    case "not-regression":
      return `**Introduced in**\n\nThe bug is also present at ${commitRef(b.good.sha, base)} (${b.range.goodLabel}), so it isn't a regression since then.`;
    case "inconclusive":
      return `**Introduced in**\n\nCouldn't pin down the commit: ${brief(b.reason)}.`;
    case "found": {
      const f = b.firstBad;
      const rows: Array<[string, string]> = [
        [`Known good (${b.range.goodLabel.split(",")[0]})`, `${commitRef(b.good.sha, base)} · Not reproduced`],
        ["First bad", `${commitRef(f.sha, base)} "${cell(f.message)}" · Reproduced`],
      ];
      if (f.sha !== b.range.bad) rows.push(["Current", `${commitRef(b.range.bad, base)} · Reproduced`]);
      const by = [cell(f.author), shortDate(f.date)].filter(Boolean).join(", ");
      return [
        `**Introduced in**`,
        table(["Version", "Result"], rows),
        `${commitRef(f.sha, base)} "${cell(f.message)}"${by ? ` by ${by}` : ""}, found by git bisect over ${plural(b.range.commits, "commit")} (${b.tested} tested${b.skipped ? `, ${b.skipped} skipped` : ""}).`,
        b.change ? dropdown(`Show the change in \`${f.sha.slice(0, 7)}\` (${cell(b.change.path)})`, fenced(trimLines(b.change.patch, MAX_DIFF_LINES), "diff")) : "",
      ]
        .filter(Boolean)
        .join("\n\n");
    }
  }
}

// ---------- conclusion ----------

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function conclusion(outcome: Clear): string {
  const repro = outcome.repro;
  const unverified = outcome.localization?.suspects.length ? " The suspected cause has not yet been verified by testing a fix." : "";
  if (!repro) return outcome.localization ? "Based on the report and the code only; nothing was run." : "";
  switch (repro.status) {
    case "running":
      return `Replaying the steps in fresh browsers on this repo's own GitHub Actions runner. This usually takes 2–4 minutes.`;
    case "disabled":
      return "Based on the report and the code only. Reproduction isn't enabled for this repo, so nothing was run.";
    case "not-feasible":
      return `Based on the report and the code only. A browser replay wasn't possible: ${brief(repro.reason)}`;
    case "error":
      return `Based on the report and the code only. The replay couldn't run: ${brief(repro.message, 300)}`;
    case "app-failed":
      return `The app didn't start on the runner, so the bug couldn't be replayed. Check the start command and that every secret under \`run.env\` in \`.github/norepro.yml\` is set.`;
    case "done": {
      const v = repro.verdict;
      if (v.status === "reproduced") {
        const b = repro.bisect;
        const first = b?.status === "found" ? `, and it first appears in \`${b.firstBad.sha.slice(0, 7)}\`` : "";
        return `The reported behavior occurred in ${v.completed === 1 ? "the only run" : `all ${plural(v.completed, "run")}`}${first}.${unverified}`;
      }
      if (v.status === "flaky") return `The reported behavior occurred in ${v.failed} of ${plural(v.completed, "run")}, so it may depend on timing.${unverified}`;
      if (v.status === "not-reproduced") {
        return `The app behaved as expected in all ${plural(v.completed, "run")}. The bug may depend on data, timing or a device detail the report doesn't mention.`;
      }
      return "The steps couldn't be completed, so this doesn't show whether the bug is real.";
    }
  }
}

/** Extra detail, only for results that need explaining. */
function unusualDetail(outcome: Clear): string {
  const repro = outcome.repro;
  if (repro?.status === "app-failed") {
    return `<details><summary>App log (last lines)</summary>\n\n\`\`\`\n${repro.log.replace(/```/g, "'''")}\n\`\`\`\n\n</details>`;
  }
  if (repro?.status === "done" && repro.verdict.status === "steps-failed") {
    const steps = repro.plan.steps.map((s, i) => `${i + 1}. ${cell(describeStep(s))}`).join("\n");
    const why = repro.verdict.details.map((d) => `- ${cell(d)}`).join("\n");
    return `<details><summary>What was tried</summary>\n\n${steps}\n\n${why}\n\n</details>`;
  }
  return "";
}

// ---------- states ----------

function block(parts: string[]): string {
  return parts.filter(Boolean).join("\n\n");
}

export function renderWorking(state: AgentState): string {
  return block(["## Automated triage: Checking…", "Reading the report. This takes a few seconds."]) + footer(state, "No Repro");
}

export function renderError(state: AgentState, message: string): string {
  return block([
    "## Automated triage: Error",
    `\`\`\`\n${message.slice(0, 800)}\n\`\`\``,
    "A maintainer can comment `/norepro retry` to try again.",
  ]) + footer(state, "No Repro");
}

export function renderScanning(outcome: Clear, state: AgentState): string {
  return block([`## Automated triage: Clear report`, `**${cell(outcome.report.title)}**`, summary(outcome), "Reading the code to find the likely cause…"]) + footer(state, "No Repro");
}

export function renderOutcome(outcome: TriageOutcome, state: AgentState): string {
  const title = `**${cell(outcome.report.title)}**`;
  switch (outcome.status) {
    case "needs-info":
      return block([
        `## Automated triage: ${heading(outcome)}`,
        `> **${cell(outcome.question)}**`,
        title,
        summary(outcome),
        "Reply to this issue (dictating is fine) and I'll check again.",
      ]) + footer(state);
    case "out-of-scope":
      return block([
        `## Automated triage: ${heading(outcome)}`,
        title,
        `${brief(outcome.reason, 300)} No Repro only checks problems with an objective pass/fail: an error, a wrong value, a duplicate action, or something missing from the page.`,
      ]) + footer(state);
    case "clear": {
      const repro = outcome.repro;
      return block([
        `## Automated triage: ${heading(outcome)}`,
        runsLine(repro),
        title,
        summary(outcome),
        repro?.status === "done" ? runResults(repro.verdict) : "",
        introducedIn(outcome),
        likelyCause(outcome),
        links(outcome),
        `**Conclusion:** ${conclusion(outcome)}`.replace(/\*\*Conclusion:\*\* $/, ""),
        unusualDetail(outcome),
      ]) + footer(state);
    }
  }
}

export const STATUS_LABELS: Record<TriageStatus, string> = {
  "needs-info": "needs-info",
  "out-of-scope": "repro:out-of-scope",
  clear: "report:clear",
};

/** Replaces report:clear once a reproduction run has finished. */
export const REPRO_LABELS: Record<ReproStatus, string> = {
  reproduced: "repro:confirmed",
  flaky: "repro:flaky",
  "not-reproduced": "repro:not-reproduced",
  "steps-failed": "repro:inconclusive",
};

export const ALL_LABELS = [...Object.values(STATUS_LABELS), ...Object.values(REPRO_LABELS)];
