import { describe, expect, test } from "bun:test";
import { strToU8, zipSync } from "fflate";
import { parseConfig } from "../src/core/config.ts";
import type { CodeHost } from "../src/core/code.ts";
import type { StructuredModel } from "../src/core/model.ts";
import { renderOutcome, REPRO_LABELS } from "../src/core/render.ts";
import type { BugReport } from "../src/core/report.ts";
import { parseResultZip, type ActionsClient, type RunResult } from "../src/repro/actions.ts";
import { finishReproduction, startReproduction, type ClearOutcome, type PendingRun } from "../src/repro/index.ts";
import { describeCheck, describeStep, playwrightSpec, type Plan, type Target } from "../src/repro/plan.ts";
import { normalise } from "../src/repro/planner.ts";
// @ts-expect-error plain JS module that runs on the GitHub Actions runner
import { evaluateOffline } from "../src/repro/runner.mjs";
import { decideVerdict, type RunOutcome } from "../src/repro/verdict.ts";
import { parseRunTitle, runWorkflowYaml } from "../src/repro/workflow.ts";
import { memoryStore } from "../src/server/store.ts";
import { runEventFrom } from "../src/server/runs.ts";

const button = (name: string): Target => ({ by: "role", value: name, role: "button", nth: null });
const css = (selector: string): Target => ({ by: "css", value: selector, role: null, nth: null });

const report: BugReport = {
  title: "Double tapping Place Order creates two orders",
  page: "/cart",
  steps: ["Add Running Shoes", "Open cart", "Tap Place Order twice"],
  expected: "One order",
  actual: "Two orders",
  environment: { device: "mobile", browser: null },
  testValues: [],
  lastWorkingVersion: null,
  checkable: true,
  notCheckableReason: null,
  question: null,
};
const outcome: ClearOutcome = { status: "clear", report };
const config = parseConfig(`app:
  name: ShopLite
  start: bun run dev
  baseUrl: http://localhost:3000
  ready: /health
  reset: POST /__reset
run:
  install: bun install
  env: [GEMINI_API_KEY]
`);

const plan: Plan = {
  viewport: { width: 390, height: 844 },
  steps: [
    { do: "goto", path: "/" },
    { do: "click", target: button("Add Running Shoes to cart"), times: 1 },
    { do: "goto", path: "/cart" },
    { do: "click", target: css("#place-order"), times: 2 },
  ],
  check: { type: "request_count", method: "POST", path: "/api/orders", max: 1 },
};

const rawStep = (s: Record<string, unknown>): any => ({ path: null, target: null, times: null, value: null, key: null, ms: null, ...s });
const rawCheck = (c: Record<string, unknown>): any => ({ method: null, path: null, max: null, text: null, target: null, expected: null, ...c });

describe("planner output is validated in code", () => {
  test("a good flat plan becomes a typed plan with the right viewport", () => {
    const out = normalise(
      {
        feasible: true,
        reason: "two quick taps send two POSTs",
        steps: [rawStep({ do: "goto", path: "/cart" }), rawStep({ do: "click", target: css("#place-order"), times: 9 })],
        check: rawCheck({ type: "request_count", method: "post", path: "/api/orders", max: 1 }),
      },
      true,
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.plan.viewport).toEqual({ width: 390, height: 844 });
      expect(out.plan.steps[1]).toMatchObject({ do: "click", times: 3 }); // clamped
      expect(out.plan.check).toEqual({ type: "request_count", method: "POST", path: "/api/orders", max: 1 });
    }
  });

  test("missing fields, bad paths and non-goto starts are rejected", () => {
    const base = { feasible: true, reason: "", check: rawCheck({ type: "no_errors" }) };
    expect(normalise({ ...base, steps: [rawStep({ do: "click", target: css("#x") })] }, false)).toMatchObject({ ok: false });
    expect(normalise({ ...base, steps: [rawStep({ do: "goto", path: "https://evil.example" })] }, false)).toMatchObject({ ok: false });
    expect(normalise({ ...base, steps: [rawStep({ do: "goto", path: "/" }), rawStep({ do: "fill" })] }, false)).toMatchObject({ ok: false });
    expect(normalise({ feasible: false, reason: "visual only", steps: [], check: rawCheck({ type: "no_errors" }) }, false)).toEqual({ ok: false, reason: "visual only" });
  });
});

describe("verdict (plain code)", () => {
  const run = (passed: boolean): RunOutcome => ({ ok: true, failedStep: null, error: null, check: { passed, detail: passed ? "fine" : "POST /api/orders was sent 2 times" } });
  test("3 of 3 failing checks = reproduced", () => expect(decideVerdict([run(false), run(false), run(false)])).toMatchObject({ status: "reproduced", failed: 3, completed: 3 }));
  test("mixed = flaky", () => expect(decideVerdict([run(false), run(true), run(false)])).toMatchObject({ status: "flaky", failed: 2 }));
  test("all passing = not reproduced", () => expect(decideVerdict([run(true), run(true), run(true)]).status).toBe("not-reproduced"));
  test("a step that couldn't be done = steps-failed, with the page for re-planning", () => {
    const v = decideVerdict([{ ok: false, failedStep: 1, error: "locator not found", url: "/cart", text: "Your cart is empty", elements: [] }]);
    expect(v.status).toBe("steps-failed");
    expect(v.snapshot).toMatchObject({ failedStep: 1, error: "locator not found", url: "/cart" });
  });
});

test("runner's offline checks count requests and errors", () => {
  const observed = { requests: [{ method: "POST", path: "/api/orders" }, { method: "POST", path: "/api/orders" }, { method: "GET", path: "/api/cart" }], errors: [] };
  expect(evaluateOffline(plan.check, observed)).toEqual({ passed: false, detail: "POST /api/orders was sent 2 times (expected at most 1)" });
  expect(evaluateOffline({ type: "no_errors" }, { requests: [], errors: ["uncaught: boom"] }).passed).toBe(false);
  expect(evaluateOffline({ type: "text_visible", text: "x" }, observed)).toBeNull();
});

describe("plan descriptions and generated test", () => {
  test("steps read naturally", () => {
    expect(describeStep(plan.steps[3]!)).toBe("Click `#place-order` 2 times quickly");
    expect(describeStep({ do: "fill", target: { by: "placeholder", value: "Search products", role: null, nth: null }, value: "shoes " })).toBe('Type "shoes " into "Search products"');
    expect(describeCheck(plan.check)).toBe("`POST /api/orders` is sent at most 1 time");
  });

  test("Playwright test replays the steps and asserts the expected behaviour", () => {
    const spec = playwrightSpec(plan, report.title, "http://localhost:3000");
    expect(spec).toContain('await page.goto("http://localhost:3000/cart");');
    expect(spec.match(/page\.locator\("#place-order"\)\.click\(\{ noWaitAfter: true \}\)/g)).toHaveLength(2);
    expect(spec).toContain('page.getByRole("button", { name: "Add Running Shoes to cart", exact: true })');
    expect(spec).toContain('expect(sent.filter((r) => r === "POST /api/orders").length).toBeLessThanOrEqual(1);');
  });
});

describe("workflow for the repo owner", () => {
  const yaml = runWorkflowYaml(config);
  test("full history, the owner's commands and secrets go to the runner, results are uploaded", () => {
    expect(yaml).toContain("workflow_dispatch:");
    expect(yaml).toContain("fetch-depth: 0");
    expect(yaml).toContain("uses: oven-sh/setup-bun@v2");
    expect(yaml).toContain('NOREPRO_INSTALL: "bun install"');
    expect(yaml).toContain('NOREPRO_START: "bun run dev"');
    expect(yaml).toContain('NOREPRO_READY_URL: "http://localhost:3000/health"');
    expect(yaml).toContain("GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}");
    expect(yaml).toContain("npm install --no-audit --no-fund playwright@1.64.1");
    expect(yaml).toContain("name: norepro-result");
  });

  test("the plan reaches the shell only through an env variable", () => {
    expect(yaml).toContain("JOB: ${{ inputs.job }}");
    expect(yaml).not.toMatch(/run:.*\$\{\{ inputs\.job \}\}/);
  });

  test("bad secret names are refused", () => {
    expect(() => runWorkflowYaml({ ...config, run: { install: "npm ci", env: ["X; rm -rf /"] } })).toThrow(/secret name/);
  });

  test("run titles round-trip", () => {
    expect(parseRunTitle("No Repro · issue #12 · a1b2c3d4e5f6")).toEqual({ issue: 12, ref: "a1b2c3d4e5f6" });
    expect(parseRunTitle("CI")).toBeNull();
  });
});

test("result artifact zip is parsed", () => {
  const zip = zipSync({ "result.json": strToU8(JSON.stringify({ runs: [{ ok: true, failedStep: null, error: null, check: { passed: false, detail: "d" } }] })), "app.log": strToU8("listening on 3000") });
  const r = parseResultZip(zip);
  expect(r.runs).toHaveLength(1);
  expect(r.appLog).toBe("listening on 3000");
  expect(parseResultZip(zipSync({ "app.log": strToU8("Error: GEMINI_API_KEY missing") }))).toEqual({ runs: null, fatal: null, appLog: "Error: GEMINI_API_KEY missing" });
});

describe("start and finish a reproduction", () => {
  const where = { owner: "rushi", repo: "shop", issue: 1, installationId: 9 };
  const host: CodeHost = { headSha: async () => "abc", listFiles: async () => [], readFile: async () => "", lastChange: async () => null, permalink: () => null };
  const goodPlan = { feasible: true, reason: "r", steps: [rawStep({ do: "goto", path: "/cart" }), rawStep({ do: "click", target: css("#place-order"), times: 2 })], check: rawCheck({ type: "request_count", method: "POST", path: "/api/orders", max: 1 }) };
  const modelReturning = (...plans: unknown[]): StructuredModel => ({ generate: async () => plans.shift() as never });
  function fakeActions(enabled: boolean, results: RunResult[] = []) {
    const dispatched: Array<{ issue: string; ref: string; job: string }> = [];
    const actions: ActionsClient = { enabled: async () => enabled, dispatch: async (i) => void dispatched.push(i), readResult: async () => results.shift()! };
    return { actions, dispatched };
  }

  test("repos without the workflow aren't dispatched", async () => {
    const { actions, dispatched } = fakeActions(false);
    const store = memoryStore();
    expect(await startReproduction(outcome, config, where, { host, model: modelReturning(goodPlan), actions, store: store.runs })).toEqual({ status: "disabled" });
    expect(dispatched).toEqual([]);
  });

  test("dispatch sends the plan as data and remembers the run", async () => {
    const { actions, dispatched } = fakeActions(true);
    const store = memoryStore();
    const state = await startReproduction(outcome, config, where, { host, model: modelReturning(goodPlan), actions, store: store.runs });
    expect(state).toMatchObject({ status: "running", round: 1 });
    const job = JSON.parse(Buffer.from(dispatched[0]!.job, "base64").toString("utf8"));
    expect(job).toMatchObject({ mode: "replay", baseUrl: "http://localhost:3000", reset: "POST /__reset", runs: 3 });
    expect(store.pending.get(dispatched[0]!.ref)).toMatchObject({ issue: 1, round: 1 });
  });

  test("finished run: verdict from the uploaded result", async () => {
    const fail = { ok: true, failedStep: null, error: null, check: { passed: false, detail: "POST /api/orders was sent 2 times" } };
    const { actions } = fakeActions(true, [{ runs: [fail, fail, fail], fatal: null, appLog: "" }]);
    const store = memoryStore();
    const pending: PendingRun = { ref: "a1b2c3d4", kind: "replay", ...where, round: 1, plan, outcome, config, createdAt: "" };
    await store.runs.save(pending);
    const state = await finishReproduction(pending, 77, "https://github.com/rushi/shop/actions/runs/77", { host, model: modelReturning(), actions, store: store.runs });
    expect(state).toMatchObject({ status: "done", verdict: { status: "reproduced", failed: 3 } });
    expect(store.pending.size).toBe(0);
  });

  test("steps that couldn't be followed are re-planned once from the real page", async () => {
    const stuck = { ok: false, failedStep: 3, error: "no element #place-order", url: "/cart", text: "Your cart is empty", elements: [] };
    const { actions, dispatched } = fakeActions(true, [{ runs: [stuck], fatal: null, appLog: "" }]);
    const store = memoryStore();
    const pending: PendingRun = { ref: "a1b2c3d4", kind: "replay", ...where, round: 1, plan, outcome, config, createdAt: "" };
    const state = await finishReproduction(pending, 1, null, { host, model: modelReturning(goodPlan), actions, store: store.runs });
    expect(state).toMatchObject({ status: "running", round: 2 });
    expect(dispatched).toHaveLength(1);
  });

  test("app that never started shows its log", async () => {
    const { actions } = fakeActions(true, [{ runs: null, fatal: null, appLog: "Error: Missing GEMINI_API_KEY" }]);
    const pending: PendingRun = { ref: "a1b2c3d4", kind: "replay", ...where, round: 1, plan, outcome, config, createdAt: "" };
    const state = await finishReproduction(pending, 1, null, { host, model: modelReturning(), actions, store: memoryStore().runs });
    expect(state).toEqual({ status: "app-failed", runUrl: null, log: "Error: Missing GEMINI_API_KEY" });
  });
});

describe("workflow_run events", () => {
  const app = { id: 1, slug: "s", name: "n", htmlUrl: "", clientId: "", clientSecret: "", webhookSecret: "w", privateKey: "", webhookUrl: "" };
  const payload = {
    action: "completed",
    installation: { id: 9 },
    repository: { full_name: "rushi/shop" },
    sender: { login: "no-repro-156c[bot]", type: "Bot" },
    workflow_run: { id: 77, path: ".github/workflows/norepro.yml", display_title: "No Repro · issue #1 · a1b2c3d4", html_url: "https://github.com/rushi/shop/actions/runs/77" },
  };
  test("our runs are recognised", () => expect(runEventFrom(payload, app)).toMatchObject({ runId: 77, ref: "a1b2c3d4", issue: 1, action: "completed" }));
  test("other workflows and other actions are ignored", () => {
    expect(runEventFrom({ ...payload, workflow_run: { ...payload.workflow_run, path: ".github/workflows/ci.yml" } }, app)).toBeNull();
    expect(runEventFrom({ ...payload, action: "requested" }, app)).toBeNull();
  });
});

describe("hardening", () => {
  test("plans can't send the browser to another site", async () => {
    const { isSitePath } = await import("../src/repro/planner.ts");
    expect(isSitePath("/cart")).toBe(true);
    expect(isSitePath("/search?q=a//b")).toBe(true);
    for (const bad of ["//evil.example", "/\\evil.example", "https://evil.example", "cart", "///evil.example"]) expect(isSitePath(bad)).toBe(false);
    const out = normalise({ feasible: true, reason: "", steps: [rawStep({ do: "goto", path: "//evil.example/steal" })], check: rawCheck({ type: "no_errors" }) }, false);
    expect(out.ok).toBe(false);
  });

  test("a failed dispatch doesn't leave an orphaned run behind", async () => {
    const store = memoryStore();
    const actions: ActionsClient = { enabled: async () => true, dispatch: async () => { throw new Error("403"); }, readResult: async () => ({ runs: null, fatal: null, appLog: "" }) };
    const host: CodeHost = { headSha: async () => "abc", listFiles: async () => [], readFile: async () => "", lastChange: async () => null, permalink: () => null };
    const model: StructuredModel = { generate: async () => ({ feasible: true, reason: "", steps: [rawStep({ do: "goto", path: "/" })], check: rawCheck({ type: "no_errors" }) }) as never };
    await expect(startReproduction(outcome, config, { owner: "o", repo: "r", issue: 1, installationId: 1 }, { host, model, actions, store: store.runs })).rejects.toThrow("403");
    expect(store.pending.size).toBe(0);
  });
});

describe("runner waits for requests set off by an action", async () => {
  // @ts-expect-error plain JS module
  const { settle } = await import("../src/repro/runner.mjs");
  const clock = () => {
    let t = 0;
    return { now: () => t, sleep: async (ms: number) => void (t += ms) };
  };

  test("waits while a request is in flight, then for a quiet gap", async () => {
    const c = clock();
    const observed = { inflight: 1, lastActivity: 0 };
    const sleep = async (ms: number) => {
      await c.sleep(ms);
      if (c.now() === 300) Object.assign(observed, { inflight: 0, lastActivity: 300 }); // request finishes at 300ms
    };
    await settle(null, observed, c.now, sleep);
    expect(c.now()).toBeGreaterThanOrEqual(800); // 300ms + 500ms quiet
  });

  test("gives up after the cap if the page never goes quiet", async () => {
    const c = clock();
    await settle(null, { inflight: 3, lastActivity: 0 }, c.now, c.sleep);
    expect(c.now()).toBeGreaterThanOrEqual(6000);
    expect(c.now()).toBeLessThan(6200);
  });
});
