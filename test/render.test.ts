import { describe, expect, test } from "bun:test";
import { readState, renderOutcome, renderScanning, REPRO_LABELS } from "../src/core/render.ts";
import type { BugReport, TriageOutcome } from "../src/core/report.ts";
import type { Plan } from "../src/repro/plan.ts";
import { decideVerdict } from "../src/repro/verdict.ts";

const report: BugReport = {
  title: "Double-tapping Place Order creates duplicate orders",
  page: "/cart",
  steps: ["Add Running Shoes", "Open the cart", "Tap Place Order twice quickly"],
  expected: "One order",
  actual: "Two order requests",
  environment: { device: "mobile", browser: null },
  testValues: [],
  lastWorkingVersion: null,
  checkable: true,
  notCheckableReason: null,
  question: null,
};
const sha = "94b2528f10fea0a52319fbc178f0eb26e17c4bc3";
const link = `https://github.com/rushi/shop/blob/${sha}/server.ts#L96-L102`;
const runUrl = "https://github.com/rushi/shop/actions/runs/39557964353";
const localization = {
  sha,
  filesRead: 2,
  suspects: [
    {
      path: "server.ts",
      startLine: 96,
      endLine: 102,
      reason: "Concurrent requests can both pass the cart check before either creates an order. A second sentence that should not appear.",
      confidence: "high" as const,
      link,
      commit: { sha: "2818c77aaaa", message: "ShopLite", author: "Rushikesh", date: "2026-10-21T10:31:00Z", url: null, addedFile: true },
    },
  ],
};
const plan: Plan = {
  viewport: { width: 390, height: 844 },
  steps: [{ do: "goto", path: "/cart" }, { do: "click", target: { by: "css", value: "#place-order", role: null, nth: null }, times: 2 }],
  check: { type: "request_count", method: "POST", path: "/api/orders", max: 1 },
};
const st = { runs: 1, status: "clear" as const };
const run = (bug: boolean) => ({ ok: true, failedStep: null, error: null, check: { passed: !bug, detail: bug ? "POST /api/orders was sent 2 times" : "sent once" } });
const clear = (extra: Partial<Extract<TriageOutcome, { status: "clear" }>> = {}): TriageOutcome => ({ status: "clear", report, localization, ...extra });
const done = (bugs: boolean[]) => clear({ repro: { status: "done", plan, verdict: decideVerdict(bugs.map(run)), runUrl, baseUrl: "http://localhost:3000" } });

describe("reproduced report", () => {
  const body = renderOutcome(done([true, true, true]), st);

  test("verdict first, then the run count and title", () => {
    expect(body.startsWith("## Automated triage: Reproduced\n\n3/3 runs\n\n**Double-tapping Place Order creates duplicate orders**")).toBe(true);
  });

  test("summary table: where, expected, observed, environment, commit", () => {
    expect(body).toContain("| Field | Result |");
    expect(body).toContain("| Where | `/cart` |");
    expect(body).toContain("| Expected | One order |");
    expect(body).toContain("| Observed | Two order requests |");
    expect(body).toContain("| Environment | Chromium, mobile viewport |");
    expect(body).toContain("| Commit | `94b2528` |");
  });

  test("one row per run", () => {
    expect(body).toContain("| Run | Result |\n| --- | --- |\n| 1 | Reproduced |\n| 2 | Reproduced |\n| 3 | Reproduced |");
  });

  test("likely cause is one line: file:lines, first sentence, commit", () => {
    expect(body).toContain("`server.ts:96–102` — Concurrent requests can both pass the cart check before either creates an order. Last changed in `2818c77` (when the file was created).");
    expect(body).not.toContain("A second sentence");
  });

  test("links to source and run, and a conclusion with no unsupported claims", () => {
    expect(body).toContain(`[View source code](${link}) · [View test run](${runUrl})`);
    expect(body).toContain("**Conclusion:** The reported behavior occurred in all 3 runs. The suspected cause has not yet been verified by testing a fix.");
    expect(body).toContain("Generated automatically by No Repro. A maintainer will review.");
  });

  test("no logs, step lists, generated code or tracking params by default", () => {
    for (const noise of ["<details>", "```", "Steps to reproduce", "utm_source", "@playwright/test"]) expect(body).not.toContain(noise);
  });

  test("state marker survives", () => expect(readState(body)).toEqual(st));
});

describe("other verdicts", () => {
  test("flaky", () => {
    const body = renderOutcome(done([true, false, true]), st);
    expect(body).toContain("## Automated triage: Flaky\n\n2/3 runs");
    expect(body).toContain("| 2 | Not reproduced |");
    expect(body).toContain("occurred in 2 of 3 runs, so it may depend on timing");
    expect(REPRO_LABELS.flaky).toBe("repro:flaky");
  });

  test("not reproduced makes no claim about a cause being verified", () => {
    const body = renderOutcome(done([false, false, false]), st);
    expect(body).toContain("## Automated triage: Not reproduced\n\n0/3 runs");
    expect(body).toContain("The app behaved as expected in all 3 runs.");
    expect(body).not.toContain("has not yet been verified");
  });

  test("inconclusive (steps couldn't be followed) explains what was tried", () => {
    const verdict = decideVerdict([{ ok: false, failedStep: 1, error: "no #place-order" }]);
    const body = renderOutcome(clear({ repro: { status: "done", plan, verdict, runUrl, baseUrl: "http://localhost:3000" } }), st);
    expect(body).toContain("## Automated triage: Inconclusive\n\n0/1 runs completed");
    expect(body).toContain("| 1 | Couldn't do step 2 |");
    expect(body).toContain("<details><summary>What was tried</summary>");
    expect(body).toContain("doesn't show whether the bug is real");
  });

  test("app that didn't start: inconclusive, with the log folded away", () => {
    const body = renderOutcome(clear({ repro: { status: "app-failed", runUrl, log: "Error: GEMINI_API_KEY missing" } }), st);
    expect(body).toContain("## Automated triage: Inconclusive");
    expect(body).toContain("<details><summary>App log (last lines)</summary>");
    expect(body).toContain("GEMINI_API_KEY missing");
  });
});

describe("before or without a run", () => {
  test("running", () => {
    const body = renderOutcome(clear({ repro: { status: "running", plan, round: 1, runUrl } }), st);
    expect(body).toContain("## Automated triage: Reproducing…");
    expect(body).toContain("| Environment | Chromium, mobile viewport |");
    expect(body).toContain(`[View test run](${runUrl})`);
    expect(body).not.toContain("| Run | Result |");
  });

  test("reproduction not enabled: clear report, code-only conclusion", () => {
    const body = renderOutcome(clear({ repro: { status: "disabled" } }), st);
    expect(body).toContain("## Automated triage: Clear report");
    expect(body).toContain("| Environment | mobile |");
    expect(body).toContain("Reproduction isn't enabled for this repo, so nothing was run.");
  });

  test("scanning shows the summary while the code is read", () => {
    const body = renderScanning({ status: "clear", report }, st);
    expect(body).toContain("## Automated triage: Clear report");
    expect(body).toContain("Reading the code to find the likely cause…");
  });

  test("needs information: the question first, missing fields shown as —", () => {
    const body = renderOutcome({ status: "needs-info", report: { ...report, expected: null }, missing: ["expected"], question: "What should happen instead?" }, { runs: 1, status: "needs-info" });
    expect(body.startsWith("## Automated triage: Needs information\n\n> **What should happen instead?**")).toBe(true);
    expect(body).toContain("| Expected | — |");
  });

  test("needs a human", () => {
    const body = renderOutcome({ status: "out-of-scope", report, reason: "'Looks off' is a visual judgement." }, { runs: 1, status: "out-of-scope" });
    expect(body).toContain("## Automated triage: Needs a human");
    expect(body).toContain("'Looks off' is a visual judgement.");
  });
});

describe("text from the issue is neutralised", () => {
  test("exact values keep meaningful spaces visible", () => {
    expect(renderOutcome(clear({ report: { ...report, testValues: ["shoes ", "SAVE10"] } }), st)).toContain('| Exact values | `"shoes "` `SAVE10` |');
  });
  test("no pinging people, no broken tables", () => {
    const body = renderOutcome(clear({ report: { ...report, actual: "ask @octocat | now\nline two" } }), st);
    expect(body).toContain("| Observed | ask @​octocat \\| now line two |");
  });
});

describe("collapsible code", () => {
  const withCode = {
    ...localization,
    suspects: [{ ...localization.suspects[0]!, startLine: 3, endLine: 3, code: { firstLine: 1, lines: ["const a = 1;", "const b = 2;", "  .filter((l) => l.qty >= 0);", "const c = `x`;", "end();"] } }],
  };

  test("likely cause has a collapsed, numbered snippet with the faulty line marked", () => {
    const body = renderOutcome(clear({ localization: withCode }), st);
    expect(body).toContain("<details><summary>Show the code</summary>");
    expect(body).toContain("→ 3 |   .filter((l) => l.qty >= 0);");
    expect(body).toContain("  1 | const a = 1;");
    expect(body).toContain("```ts\n");
  });

  test("backticks in the code can't break out of the block", () => {
    const body = renderOutcome(clear({ localization: { ...withCode, suspects: [{ ...withCode.suspects[0]!, code: { firstLine: 3, lines: ["const md = '```';"] } }] } }), st);
    expect(body).toContain("````ts\n");
  });

  test("bisect result shows the breaking change as a collapsed diff", () => {
    const range = { good: "p".repeat(40), bad: sha, goodLabel: "v1.0, the latest release before this commit", commits: 4 };
    const firstBad = { sha: "2795ce2" + "0".repeat(33), message: "Cart: tidy quantity update", author: "Rushikesh", date: "2026-10-21T10:00:00Z" };
    const patch = "@@ -83,4 +83,4 @@\n-      .filter((l) => l.qty > 0);\n+      .filter((l) => l.qty >= 0);";
    const repro = { status: "done" as const, plan, verdict: decideVerdict([run(true)]), runUrl, baseUrl: "", bisect: { status: "found" as const, range, firstBad, good: { ...firstBad, sha: "p".repeat(40) }, tested: 3, skipped: 0, change: { path: "server.ts", patch } } };
    const body = renderOutcome(clear({ repro }), st);
    expect(body).toContain("<details><summary>Show the change in `2795ce2` (server.ts)</summary>");
    expect(body).toContain("```diff\n@@ -83,4 +83,4 @@\n-      .filter((l) => l.qty > 0);\n+      .filter((l) => l.qty >= 0);\n```");
  });
});
