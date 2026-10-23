import { describe, expect, test } from "bun:test";
import { parseConfig } from "../src/core/config.ts";
import { readState, type AgentState } from "../src/core/render.ts";
import type { BugReport } from "../src/core/report.ts";
import { decide, type GhIssue, type IssueEvent } from "../src/github/event.ts";
import type { IssueHandle } from "../src/github/repo.ts";
import { runOnIssue } from "../src/github/run.ts";

const config = parseConfig("app:\n  name: ShopLite\nlimits:\n  maxRunsPerIssue: 3\n");
const issue: GhIssue = { number: 7, title: "Search is broken", body: "It doesn't work", user: { login: "asha" }, labels: [], state: "open" };
const opened: IssueEvent = { eventName: "issues", action: "opened", issue };
const comment = (login: string, body: string, extra: Partial<NonNullable<IssueEvent["comment"]>> = {}): IssueEvent => ({
  eventName: "issue_comment",
  action: "created",
  issue,
  comment: { id: 1, body, user: { login }, ...extra },
});
const waiting: AgentState = { runs: 1, status: "needs-info" };

describe("event decisions", () => {
  test("new issue runs", () => expect(decide(opened, null, config).act).toBe(true));

  test("pull requests and closed issues are skipped", () => {
    expect(decide({ ...opened, issue: { ...issue, pull_request: {} } }, null, config).act).toBe(false);
    expect(decide({ ...opened, issue: { ...issue, state: "closed" } }, null, config).act).toBe(false);
  });

  test("reporter's reply re-runs only while waiting for info", () => {
    expect(decide(comment("asha", "searched 'shoes '"), waiting, config).act).toBe(true);
    expect(decide(comment("asha", "thanks"), { runs: 1, status: "clear" }, config).act).toBe(false);
  });

  test("other people's replies and bot comments don't trigger", () => {
    expect(decide(comment("someone", "me too"), waiting, config).act).toBe(false);
    expect(decide(comment("github-actions[bot]", "hi"), waiting, config).act).toBe(false);
  });

  test("/norepro retry is maintainer-only", () => {
    expect(decide(comment("max", "/norepro retry", { author_association: "MEMBER" }), { runs: 1, status: "error" }, config).act).toBe(true);
    expect(decide(comment("asha", "/norepro retry", { author_association: "NONE" }), { runs: 1, status: "error" }, config).act).toBe(false);
  });

  test("run limit stops the agent", () => {
    const d = decide(comment("asha", "more info"), { runs: 3, status: "needs-info" }, config);
    expect(d).toMatchObject({ act: false, limitReached: true });
  });

  test("onlyLabels gates triage", () => {
    const gated = parseConfig("app:\n  name: X\nonlyLabels: [bug]\n");
    expect(decide(opened, null, gated).act).toBe(false);
    const labeled: IssueEvent = { eventName: "issues", action: "labeled", label: { name: "bug" }, issue: { ...issue, labels: [{ name: "bug" }] } };
    expect(decide(labeled, null, gated).act).toBe(true);
  });
});

/** In-memory stand-in for IssueHandle that records what the agent would do on GitHub. */
function fakeHandle(initialComment?: string) {
  const record = { comments: [] as string[], labels: [] as string[] };
  let current = initialComment;
  const handle = {
    number: issue.number,
    loadState: async () => (current ? readState(current) : null),
    getIssue: async () => issue,
    loadThread: async () => ({ title: issue.title, body: issue.body ?? "", replies: [] }),
    upsertComment: async (body: string) => {
      current = body;
      record.comments.push(body);
    },
    setStatusLabel: async (label: string) => void record.labels.push(label),
  };
  return { handle: handle as unknown as IssueHandle, record };
}

const vague: BugReport = {
  title: "Search returns nothing",
  page: "/",
  steps: [],
  expected: null,
  actual: "No results",
  environment: { device: "unknown", browser: null },
  testValues: [],
  lastWorkingVersion: null,
  checkable: true,
  notCheckableReason: null,
  question: "What did you search for, and what did you expect to see?",
};

describe("runOnIssue", () => {
  test("posts a working comment, then the question, then labels needs-info", async () => {
    const { handle, record } = fakeHandle();
    const result = await runOnIssue(handle, opened, config, { extract: async () => vague }, () => {});
    expect(result).toMatchObject({ ran: true, outcome: { status: "needs-info" } });
    expect(record.comments[0]).toContain("Automated triage: Checking");
    expect(record.comments[1]).toContain("What did you search for");
    expect(readState(record.comments[1])).toEqual({ runs: 1, status: "needs-info" });
    expect(record.labels).toEqual(["needs-info"]);
  });

  test("extractor failure leaves an error comment instead of crashing", async () => {
    const { handle, record } = fakeHandle();
    const result = await runOnIssue(handle, opened, config, { extract: async () => { throw new Error("rate limited"); } }, () => {});
    expect(result).toMatchObject({ ran: true, error: "rate limited" });
    expect(record.comments.at(-1)).toContain("rate limited");
    expect(record.labels).toEqual([]);
  });

  test("skipped events touch nothing", async () => {
    const { handle, record } = fakeHandle();
    const result = await runOnIssue(handle, comment("someone", "me too"), config, { extract: async () => vague }, () => {});
    expect(result.ran).toBe(false);
    expect(record.comments).toEqual([]);
  });
});

describe("runOnIssue with code locating", () => {
  const clear: BugReport = { ...vague, steps: ["Search for 'shoes '"], expected: "Shoes listed", question: null };
  const suspect = { path: "server.ts", startLine: 10, endLine: 11, reason: "Not trimmed.", confidence: "high" as const, commit: null, link: null };

  test("clear report: verdict first, then the likely cause in the same comment", async () => {
    const { handle, record } = fakeHandle();
    await runOnIssue(handle, opened, config, { extract: async () => clear, locate: async () => ({ sha: "abc1234", filesRead: 2, suspects: [suspect] }) }, () => {});
    expect(record.comments[1]).toContain("Reading the code to find the likely cause");
    expect(record.comments.at(-1)).toContain("`server.ts:10–11` — Not trimmed.");
    expect(record.labels).toEqual(["report:clear"]);
  });

  test("a locate failure keeps the clear verdict", async () => {
    const { handle, record } = fakeHandle();
    const result = await runOnIssue(handle, opened, config, { extract: async () => clear, locate: async () => { throw new Error("blame failed"); } }, () => {});
    expect(result).toMatchObject({ ran: true, outcome: { status: "clear", localizeError: "blame failed" } });
    expect(record.comments.at(-1)).toContain("Clear report");
    expect(record.comments.at(-1)).toContain("Couldn't read the code this time.");
  });

  test("needs-info reports don't read the code", async () => {
    const { handle } = fakeHandle();
    let called = false;
    await runOnIssue(handle, opened, config, { extract: async () => vague, locate: async () => { called = true; return { sha: "", filesRead: 0, suspects: [] }; } }, () => {});
    expect(called).toBe(false);
  });
});

test("retry command tolerates the common typos", () => {
  for (const body of ["/norepro retry", "/norepo retry", "/no-repro retry", "/repro retry", "  /NoRepro Retry please"]) {
    expect(decide(comment("max", body, { author_association: "OWNER" }), { runs: 1, status: "clear" }, config).act).toBe(true);
  }
  expect(decide(comment("max", "/deploy retry", { author_association: "OWNER" }), { runs: 1, status: "clear" }, config).act).toBe(false);
});

test("hitting the run limit leaves the last verdict in place", async () => {
  const verdict = "## Automated triage: Reproduced\n<!-- norepro:comment -->\n<!-- norepro:state {\"runs\":3,\"status\":\"clear\"} -->";
  const { handle, record } = fakeHandle(verdict);
  const result = await runOnIssue(handle, comment("max", "/norepro retry", { author_association: "OWNER" }), config, { extract: async () => vague }, () => {});
  expect(result).toMatchObject({ ran: false });
  expect(record.comments).toEqual([]);
});

describe("runOnIssue with production evidence", () => {
  const evidence = { source: "sentry", matchedBy: "search", issue: { id: "1", shortId: "SHOP-1", title: "t", permalink: "https://acme.sentry.io/issues/1/", events: 3, users: 2, firstSeen: "", lastSeen: "", firstRelease: null }, error: null, frames: [], breadcrumbs: [], url: null, browser: null, os: null, release: null, environment: null } as const;

  test("evidence is handed to the extractor and shown in the comment", async () => {
    const { handle, record } = fakeHandle();
    let seen: unknown = null;
    await runOnIssue(handle, opened, config, { evidence: async () => evidence as any, extract: async (_t, _c, e) => ((seen = e), vague) }, () => {});
    expect(seen).toBe(evidence);
    expect(record.comments.at(-1)).toContain("| Production | 3 events · 2 users");
  });

  test("a Sentry outage doesn't block triage", async () => {
    const { handle, record } = fakeHandle();
    const result = await runOnIssue(handle, opened, config, { evidence: async () => { throw new Error("Sentry 503"); }, extract: async () => vague }, () => {});
    expect(result).toMatchObject({ ran: true, outcome: { status: "needs-info" } });
    expect(record.comments.at(-1)).not.toContain("Production");
  });
});
