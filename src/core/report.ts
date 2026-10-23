import { z } from "zod";
import type { Evidence } from "../evidence/index.ts";
import type { ReproState } from "../repro/state.ts";
import type { Localization } from "./localize.ts";

// What the model extracts from an issue. The model only fills these fields;
// the decision about whether the report is clear is made in code (clarity.ts).
export const BugReportSchema = z.object({
  title: z.string().describe("A short, specific title for the bug, under 80 characters."),
  page: z
    .string()
    .nullable()
    .describe(
      "Where the bug happens: a URL path from the known pages list (e.g. '/cart') if it can be matched, otherwise the reporter's own words. null if the report gives no location.",
    ),
  steps: z
    .array(z.string())
    .describe("Concrete actions the reporter took, in order. Empty if none are given."),
  expected: z
    .string()
    .nullable()
    .describe("What the reporter expected to happen. null if not stated or clearly implied."),
  actual: z
    .string()
    .nullable()
    .describe("What actually happened instead. null if not stated."),
  environment: z
    .object({
      device: z.enum(["mobile", "desktop", "tablet", "unknown"]),
      browser: z.string().nullable(),
    })
    .describe("Device and browser if mentioned."),
  testValues: z
    .array(z.string())
    .describe(
      "Exact values the reporter typed or saw (search terms, coupon codes, totals, quantities), quoted exactly including whitespace.",
    ),
  lastWorkingVersion: z
    .string()
    .nullable()
    .describe(
      "If the reporter says an earlier version worked (e.g. 'works in 4.22.0', 'fine before v2.1', 'worked at commit abc123'), that version, tag or commit exactly as written. null otherwise.",
    ),
  checkable: z
    .boolean()
    .describe(
      "Judge the KIND of problem, not how much detail was given. true if, once the details are known, an automated browser could check pass/fail objectively (an error, a failure, a wrong value, a duplicate action, a missing element) — including vague reports like 'checkout fails', where missing details belong in `question`. false only for inherently subjective reports like 'looks ugly' or 'feels slow'.",
    ),
  notCheckableReason: z
    .string()
    .nullable()
    .describe("If checkable is false, one sentence explaining why. Otherwise null."),
  question: z
    .string()
    .nullable()
    .describe(
      "If something needed to reproduce the bug is missing, the ONE most important question to ask the reporter, in plain friendly words, quoting their words where helpful. null if nothing important is missing.",
    ),
});

export type BugReport = z.infer<typeof BugReportSchema>;

export type MissingField = "page" | "steps" | "expected" | "actual";

export type TriageOutcome = (
  | { status: "needs-info"; report: BugReport; missing: MissingField[]; question: string }
  | { status: "out-of-scope"; report: BugReport; reason: string }
  // "clear" is the hand-off point to locating the bug in the code (and, next, reproduction).
  | { status: "clear"; report: BugReport; localization?: Localization; localizeError?: string; repro?: ReproState }
) & {
  /** The matching production error, when the repo has Sentry connected. */
  evidence?: Evidence;
};

export type TriageStatus = TriageOutcome["status"];
