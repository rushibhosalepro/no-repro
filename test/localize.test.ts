import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSourceFile, numbered } from "../src/core/code.ts";
import { parseConfig } from "../src/core/config.ts";
import { LocalGitHost } from "../src/core/localgit.ts";
import { localize } from "../src/core/localize.ts";
import type { StructuredModel } from "../src/core/model.ts";
import { renderOutcome } from "../src/core/render.ts";
import type { BugReport } from "../src/core/report.ts";
import { newestOverlapping } from "../src/github/code.ts";

const config = parseConfig("app:\n  name: ShopLite\n");
const report: BugReport = {
  title: "Trailing space in search returns nothing",
  page: "/",
  steps: ["Search for 'shoes '"],
  expected: "Running Shoes is listed",
  actual: "0 results",
  environment: { device: "unknown", browser: null },
  testValues: ["shoes "],
  lastWorkingVersion: null,
  checkable: true,
  notCheckableReason: null,
  question: null,
};

/** A model that answers each call from a script and records what it was asked. */
function scripted(...answers: unknown[]) {
  const asked: string[] = [];
  const model: StructuredModel = {
    generate: async (req) => {
      asked.push(req.name);
      return answers.shift() as never;
    },
  };
  return { model, asked };
}

// A two-commit repo: search.ts is added clean, then a later commit introduces the bug.
let dir = "";
let host: LocalGitHost;
const run = (...args: string[]) => {
  const r = Bun.spawnSync(["git", "-C", dir, "-c", "user.name=Asha", "-c", "user.email=asha@example.com", ...args]);
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
};
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "norepro-loc-"));
  run("init", "-q");
  writeFileSync(join(dir, "search.ts"), ["export function search(items: string[], q: string) {", "  const query = q.trim().toLowerCase();", "  return items.filter((i) => i.toLowerCase().includes(query));", "}", ""].join("\n"));
  writeFileSync(join(dir, "cart.ts"), "export const cart = [];\n");
  run("add", ".");
  run("commit", "-q", "-m", "Add search");
  writeFileSync(join(dir, "search.ts"), ["export function search(items: string[], q: string) {", "  const query = q.toLowerCase();", "  return items.filter((i) => i.toLowerCase().includes(query));", "}", ""].join("\n"));
  run("commit", "-q", "-am", "Simplify search query");
  host = new LocalGitHost(dir);
});

describe("localize", () => {
  test("finds the lines and the later commit that broke them", async () => {
    const { model, asked } = scripted({ suspects: [{ path: "search.ts", startLine: 2, endLine: 2, reason: "The query is no longer trimmed.", confidence: "high" }] });
    const loc = await localize(report, host, model, config);
    expect(asked).toEqual(["bug_location"]); // small repo: no file-picking step
    expect(loc.filesRead).toBe(2);
    const [s] = loc.suspects;
    expect(s).toMatchObject({ path: "search.ts", startLine: 2, endLine: 2, confidence: "high" });
    expect(s!.commit).toMatchObject({ message: "Simplify search query", author: "Asha", addedFile: false });
  });

  test("lines untouched since the file was created are reported as such", async () => {
    const { model } = scripted({ suspects: [{ path: "search.ts", startLine: 3, endLine: 3, reason: "x", confidence: "low" }] });
    const [s] = (await localize(report, host, model, config)).suspects;
    expect(s!.commit).toMatchObject({ message: "Add search", addedFile: true });
  });

  test("made-up files and lines past the end are dropped; long ranges are capped", async () => {
    const { model } = scripted({
      suspects: [
        { path: "nope.ts", startLine: 1, endLine: 2, reason: "x", confidence: "high" },
        { path: "cart.ts", startLine: 50, endLine: 60, reason: "x", confidence: "high" },
        { path: "search.ts", startLine: 1, endLine: 999, reason: "x", confidence: "medium" },
      ],
    });
    const loc = await localize(report, host, model, config);
    expect(loc.suspects.map((s) => [s.path, s.startLine, s.endLine])).toEqual([["search.ts", 1, 5]]);
  });

  test("large repos pick files first, and only known paths are read", async () => {
    const big = {
      headSha: async () => "abc",
      listFiles: async () => [
        { path: "src/search.ts", size: 50_000 },
        { path: "src/other.ts", size: 50_000 },
      ],
      readFile: async () => "line one\nline two\n",
      lastChange: async () => null,
      permalink: () => null,
    };
    const { model, asked } = scripted({ paths: ["src/search.ts", "invented.ts"] }, { suspects: [] });
    const loc = await localize(report, big, model, config);
    expect(asked).toEqual(["file_pick", "bug_location"]);
    expect(loc.filesRead).toBe(1);
  });
});

test("source filter skips dependencies, builds, lockfiles and tests", () => {
  const ok = (path: string, size = 100) => isSourceFile({ path, size });
  expect(ok("server.ts")).toBe(true);
  expect(ok("src/app/page.tsx")).toBe(true);
  expect(ok("node_modules/x/index.js")).toBe(false);
  expect(ok("dist/app.js")).toBe(false);
  expect(ok("bun.lock")).toBe(false);
  expect(ok("server.test.ts")).toBe(false);
  expect(ok("README.md")).toBe(false);
  expect(ok("huge.js", 500_000)).toBe(false);
});

test("numbered source lines line up", () => {
  expect(numbered("a\nb\r\nc")).toBe("1 | a\n2 | b\n3 | c");
});

test("GitHub blame: newest commit among ranges overlapping the lines", () => {
  const c = (oid: string, date: string) => ({ oid, messageHeadline: oid, committedDate: date, url: "", author: null, parents: { nodes: [] } });
  const ranges = [
    { startingLine: 1, endingLine: 4, commit: c("old", "2026-01-01T00:00:00Z") },
    { startingLine: 5, endingLine: 5, commit: c("new", "2026-10-01T00:00:00Z") },
    { startingLine: 6, endingLine: 9, commit: c("newest-elsewhere", "2026-10-20T00:00:00Z") },
  ];
  expect(newestOverlapping(ranges, 3, 5)?.oid).toBe("new");
  expect(newestOverlapping(ranges, 20, 21)).toBeNull();
});

