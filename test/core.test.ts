import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { decide as decideClarity } from "../src/core/clarity.ts";
import { parseConfig } from "../src/core/config.ts";
import { readState, renderOutcome } from "../src/core/render.ts";
import type { BugReport } from "../src/core/report.ts";
import { threadFromMarkdown } from "../src/cli.ts";

const clearReport: BugReport = {
  title: "Double tap on Place Order creates two orders",
  page: "/cart",
  steps: ["Add Running Shoes to cart", "Open the cart", "Tap Place Order twice quickly"],
  expected: "One order is created",
  actual: "Two orders are created and I was charged twice",
  environment: { device: "mobile", browser: null },
  testValues: [],
  lastWorkingVersion: null,
  checkable: true,
  notCheckableReason: null,
  question: null,
};

describe("config", () => {
  test("repo config parses", () => {
    const repo = parseConfig(readFileSync(".github/norepro.yml", "utf8"));
    expect(repo.app.reset).toBe("POST /__reset");
    expect(repo.replay.runs).toBe(3);
  });

  test("minimal config gets defaults", () => {
    const c = parseConfig("app:\n  name: X\n");
    expect(c.model).toBe("claude-opus-5-5");
    expect(c.limits.maxRunsPerIssue).toBe(5);
    expect(c.onlyLabels).toEqual([]);
  });

  test("bad config names the field", () => {
    expect(() => parseConfig("app:\n  name: X\n  reset: /oops\n")).toThrow(/app\.reset/);
  });
});

describe("clarity rubric", () => {
  test("complete report is clear", () => {
    expect(decideClarity(clearReport).status).toBe("clear");
  });

  test("missing expected asks the model's question", () => {
    const out = decideClarity({ ...clearReport, expected: null, question: "What should the total be?" });
    expect(out).toMatchObject({ status: "needs-info", missing: ["expected"], question: "What should the total be?" });
  });

  test("falls back to a canned question when the model gives none", () => {
    const out = decideClarity({ ...clearReport, page: null, steps: [], question: null });
    expect(out.status).toBe("needs-info");
    if (out.status === "needs-info") {
      expect(out.missing).toEqual(["page", "steps"]);
      expect(out.question).toContain("Which page");
    }
  });

  test("subjective reports are out of scope even if fields are missing", () => {
    const out = decideClarity({ ...clearReport, expected: null, checkable: false, notCheckableReason: "'Looks weird' is a visual judgement." });
    expect(out).toMatchObject({ status: "out-of-scope", reason: "'Looks weird' is a visual judgement." });
  });
});

describe("comment state", () => {
  test("state round-trips through the rendered comment", () => {
    const body = renderOutcome(decideClarity(clearReport), { runs: 2, status: "clear" });
    expect(readState(body)).toEqual({ runs: 2, status: "clear" });
  });

  test("table cells escape pipes from user text", () => {
    const body = renderOutcome(decideClarity({ ...clearReport, actual: "a | b" }), { runs: 1, status: "clear" });
    expect(body).toContain("a \\| b");
  });

  test("garbage state falls back to initial", () => {
    expect(readState("<!-- norepro:state {nope} -->")).toEqual({ runs: 0, status: "working" });
  });
});

test("markdown issue file: first heading is the title", () => {
  expect(threadFromMarkdown("# Search broken\n\nNo results.", "x.md")).toEqual({ title: "Search broken", body: "No results.", replies: [] });
  expect(threadFromMarkdown("no heading", "x.md").title).toBe("x.md");
});

