import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeHost } from "../src/core/code.ts";
import { parseConfig } from "../src/core/config.ts";
import { LocalGitHistory } from "../src/core/localgit.ts";
import type { Localization } from "../src/core/localize.ts";
import type { StructuredModel } from "../src/core/model.ts";
import { renderOutcome } from "../src/core/render.ts";
import type { BugReport } from "../src/core/report.ts";
import type { ActionsClient, RunResult } from "../src/repro/actions.ts";
import { bisectState, chooseRange, type BisectRange, type HistoryHost } from "../src/repro/bisect.ts";
import { finishReproduction, type ClearOutcome, type PendingRun } from "../src/repro/index.ts";
import type { Plan } from "../src/repro/plan.ts";
// @ts-expect-error plain JS module that runs on the GitHub Actions runner
import { classify, firstBadFrom } from "../src/repro/runner.mjs";
import { decideVerdict } from "../src/repro/verdict.ts";
import { memoryStore } from "../src/server/store.ts";

const HEAD = "h".repeat(40);
const report: BugReport = {
  title: "Removing an item leaves it in the cart",
  page: "/cart",
  steps: ["Add Running Shoes", "Press − until 0"],
  expected: "Item removed",
  actual: "Item stays with quantity 0",
  environment: { device: "desktop", browser: null },
  testValues: [],
  lastWorkingVersion: null,
  checkable: true,
  notCheckableReason: null,
  question: null,
};
const suspect = (addedFile: boolean) => ({
  path: "server.ts",
  startLine: 80,
  endLine: 82,
  reason: "Filters qty >= 0 instead of > 0.",
  confidence: "high" as const,
  link: `https://github.com/rushi/shop/blob/${HEAD}/server.ts#L80-L82`,
  commit: { sha: "c".repeat(40), message: "Cart: tidy quantity update", author: "Rushikesh", date: "2026-10-21T10:00:00Z", url: null, addedFile },
});
const loc = (addedFile = false): Localization => ({ sha: HEAD, filesRead: 2, suspects: [suspect(addedFile)] });

function history(over: Partial<HistoryHost> = {}): HistoryHost {
  return {
    resolveRef: async () => null,
    latestTagBefore: async () => null,
    parentOf: async (sha) => (sha === "c".repeat(40) ? "p".repeat(40) : null),
    commitsBetween: async () => 4,
    changeIn: async () => ({ path: "server.ts", patch: "@@ -84 +84 @@\n-      .filter((l) => l.qty > 0);\n+      .filter((l) => l.qty >= 0);" }),
    ...over,
  };
}

describe("choosing what to bisect", () => {
  test("the reporter's working version wins, with or without a v prefix", async () => {
    const h = history({ resolveRef: async (r) => (r === "v4.22.0" ? "g".repeat(40) : null) });
    expect(await chooseRange({ ...report, lastWorkingVersion: "4.22.0" }, loc(), h)).toEqual({ good: "g".repeat(40), bad: HEAD, goodLabel: "4.22.0, which the reporter says worked", commits: 4 });
  });

  test("then the latest release tag", async () => {
    const h = history({ latestTagBefore: async () => ({ name: "v1.2.0", sha: "t".repeat(40) }) });
    expect(await chooseRange(report, loc(), h)).toMatchObject({ good: "t".repeat(40), goodLabel: "v1.2.0, the latest release before this commit" });
  });

  test("then the commit before the suspected lines last changed", async () => {
    expect(await chooseRange(report, loc(), history())).toMatchObject({ good: "p".repeat(40), goodLabel: expect.stringContaining("which last changed the suspected lines") });
  });

  test("lines present since the file was created: nothing to bisect", async () => {
    expect(await chooseRange(report, loc(true), history())).toEqual({ skip: "the suspected lines have been there since the file was created" });
  });

  test("candidates that aren't behind the current commit are passed over; huge ranges are refused", async () => {
    const notAncestor = history({ latestTagBefore: async () => ({ name: "v9", sha: "t".repeat(40) }), commitsBetween: async (good) => (good === "t".repeat(40) ? 0 : 3) });
    expect(await chooseRange(report, loc(), notAncestor)).toMatchObject({ good: "p".repeat(40), commits: 3 });
    expect(await chooseRange(report, loc(), history({ commitsBetween: async () => 5000 }))).toMatchObject({ skip: expect.stringContaining("too many to bisect") });
  });
});

describe("runner helpers", () => {
  test("a commit is bad if the bug showed, good if not, skipped if steps failed", () => {
    const run = (passed: boolean, ok = true) => ({ ok, check: { passed } });
    expect(classify([run(true), run(true)])).toBe("good");
    expect(classify([run(true), run(false)])).toBe("bad");
    expect(classify([run(true, false)])).toBe("skip");
    expect(classify([])).toBe("skip");
  });

  test("reads the first bad commit from real git bisect output", () => {
    const dir = mkdtempSync(join(tmpdir(), "norepro-bisect-"));
    const git = (...args: string[]) => {
      const r = Bun.spawnSync(["git", "-C", dir, "-c", "user.name=T", "-c", "user.email=t@example.com", ...args]);
      return r.stdout.toString();
    };
    git("init", "-q");
    const shas: string[] = [];
    for (let i = 0; i < 6; i++) {
      writeFileSync(join(dir, "app.txt"), i >= 3 ? "broken\n" : "fine\n");
      writeFileSync(join(dir, `f${i}.txt`), `${i}\n`);
      git("add", ".");
      git("commit", "-q", "-m", `commit ${i}`);
      shas.push(git("rev-parse", "HEAD").trim());
    }
    git("bisect", "start", shas[5]!, shas[0]!);
    let out = "";
    for (let i = 0; i < 10 && !firstBadFrom(out); i++) {
      const broken = Bun.file(join(dir, "app.txt"));
      out = git("bisect", (Bun.spawnSync(["git", "-C", dir, "show", "HEAD:app.txt"]).stdout.toString().trim() === "broken") ? "bad" : "good");
      void broken;
    }
    expect(firstBadFrom(out)).toBe(shas[3]!);
    git("bisect", "reset");
    const h = new LocalGitHistory(dir);
    return Promise.all([h.commitsBetween(shas[0]!, shas[5]!), h.parentOf(shas[3]!)]).then(([n, parent]) => {
      expect(n).toBe(5);
      expect(parent).toBe(shas[2]!);
    });
  });
});

const plan: Plan = { viewport: { width: 1280, height: 800 }, steps: [{ do: "goto", path: "/cart" }], check: { type: "element_text", target: { by: "css", value: "#lines", role: null, nth: null }, expected: "Your cart is empty" } };
const config = parseConfig("app:\n  name: ShopLite\n  start: bun run dev\n");
const where = { owner: "rushi", repo: "shop", issue: 4, installationId: 9 };
const host: CodeHost = { headSha: async () => HEAD, listFiles: async () => [], readFile: async () => "", lastChange: async () => null, permalink: () => null };
const model: StructuredModel = { generate: async () => ({}) as never };
const fail = { ok: true, failedStep: null, error: null, check: { passed: false, detail: "shows 0" } };

function actionsWith(results: RunResult[]) {
  const dispatched: Array<{ job: any; ref: string }> = [];
  const actions: ActionsClient = {
    enabled: async () => true,
    dispatch: async (i) => void dispatched.push({ ref: i.ref, job: JSON.parse(Buffer.from(i.job, "base64").toString("utf8")) }),
    readResult: async () => results.shift()!,
  };
  return { actions, dispatched };
}

describe("bisect after a confirmed reproduction", () => {
  const outcome: ClearOutcome = { status: "clear", report, localization: loc() };
  const replayPending: PendingRun = { ref: "a1b2c3d4", kind: "replay", ...where, round: 1, plan, outcome, config, createdAt: "" };

  test("reproduced → a bisect run is started over the chosen range", async () => {
    const { actions, dispatched } = actionsWith([{ runs: [fail, fail, fail], fatal: null, appLog: "" }]);
    const store = memoryStore();
    const state = await finishReproduction(replayPending, 1, "https://github.com/rushi/shop/actions/runs/1", { host, model, actions, store: store.runs, history: history() });
    expect(state).toMatchObject({ status: "done", verdict: { status: "reproduced" }, bisect: { status: "running", range: { good: "p".repeat(40), bad: HEAD } } });
    expect(dispatched[0]!.job).toMatchObject({ mode: "bisect", bisect: { good: "p".repeat(40), bad: HEAD, runsPerCommit: 2 }, plan });
    expect([...store.pending.values()][0]).toMatchObject({ kind: "bisect", replay: { status: "done" } });
  });

  test("not reproduced → no bisect", async () => {
    const pass = { ...fail, check: { passed: true, detail: "" } };
    const { actions, dispatched } = actionsWith([{ runs: [pass, pass, pass], fatal: null, appLog: "" }]);
    const state = await finishReproduction(replayPending, 1, null, { host, model, actions, store: memoryStore().runs, history: history() });
    expect(state).toMatchObject({ status: "done", verdict: { status: "not-reproduced" } });
    expect(state).not.toHaveProperty("bisect");
    expect(dispatched).toEqual([]);
  });

  test("bisect finished → the replay verdict plus the first bad commit", async () => {
    const range: BisectRange = { good: "p".repeat(40), bad: HEAD, goodLabel: "the commit before `ccccccc`, which last changed the suspected lines", commits: 4 };
    const replay = { status: "done" as const, plan, verdict: decideVerdict([fail, fail, fail]), runUrl: "https://github.com/rushi/shop/actions/runs/1", baseUrl: "http://localhost:3000", bisect: { status: "running" as const, range } };
    const pending: PendingRun = { ...replayPending, ref: "b1b2c3d4", kind: "bisect", range, replay };
    const firstBad = { sha: "c".repeat(40), message: "Cart: tidy quantity update", author: "Rushikesh", date: "2026-10-21T10:00:00Z" };
    const bisect = { status: "found" as const, good: { sha: "p".repeat(40), message: "Add Sun Glasses", author: "R", date: "" }, bad: { ...firstBad, sha: HEAD }, firstBad, steps: [{ sha: "p".repeat(40), result: "good" as const }, { sha: "c".repeat(40), result: "bad" as const }, { sha: "x".repeat(40), result: "skip" as const }] };
    const { actions } = actionsWith([{ runs: null, fatal: null, appLog: "", bisect }]);
    const state = await finishReproduction(pending, 2, "https://github.com/rushi/shop/actions/runs/2", { host, model, actions, store: memoryStore().runs, history: history() });
    expect(state).toMatchObject({ status: "done", bisect: { status: "found", firstBad, tested: 2, skipped: 1 }, bisectRunUrl: "https://github.com/rushi/shop/actions/runs/2" });

    const body = renderOutcome({ ...outcome, repro: state }, { runs: 1, status: "clear" });
    expect(body).toContain("**Introduced in**");
    expect(body).toContain('| First bad | [`ccccccc`](https://github.com/rushi/shop/commit/' + "c".repeat(40) + ') "Cart: tidy quantity update" · Reproduced |');
    expect(body).toContain("found by git bisect over 4 commits (2 tested, 1 skipped)");
    expect(body).toContain("[View bisect run](https://github.com/rushi/shop/actions/runs/2)");
    expect(body).toContain("and it first appears in `ccccccc`.");
  });

  test("bisect states that aren't a clean answer say so plainly", () => {
    const range: BisectRange = { good: "p".repeat(40), bad: HEAD, goodLabel: "v1.2.0, the latest release before this commit", commits: 7 };
    const ref = { sha: "p".repeat(40), message: "", author: "", date: "" };
    expect(bisectState(range, undefined)).toEqual({ status: "inconclusive", range, reason: "the run uploaded no bisect result" });
    const render = (b: any) =>
      renderOutcome({ ...outcome, repro: { status: "done", plan, verdict: decideVerdict([fail]), runUrl: null, baseUrl: "", bisect: b } }, { runs: 1, status: "clear" });
    expect(render({ status: "running", range })).toContain("Searching the 7 commits since v1.2.0, the latest release before this commit with git bisect…");
    expect(render({ status: "not-regression", range, good: ref })).toContain("so it isn't a regression since then");
    expect(render({ status: "skipped", reason: "x" })).not.toContain("Introduced in");
  });
});
