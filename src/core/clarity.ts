import type { NoReproConfig } from "./config.ts";
import type { Evidence } from "../evidence/index.ts";
import type { StructuredModel } from "./model.ts";
import { SYSTEM_PROMPT, userPrompt } from "./prompt.ts";
import { BugReportSchema, type BugReport, type MissingField, type TriageOutcome } from "./report.ts";

export interface IssueThread {
  title: string;
  body: string;
  /** Follow-up answers from the reporter, oldest first. Bot comments are excluded. */
  replies: string[];
}

/** Anything that can turn an issue thread into a structured report. Swapped for a fake in tests. */
export type ReportExtractor = (thread: IssueThread, config: NoReproConfig, evidence?: Evidence | null) => Promise<BugReport>;

export function reportExtractor(model: StructuredModel): ReportExtractor {
  return (thread, config, evidence) =>
    model.generate({ name: "bug_report", system: SYSTEM_PROMPT, user: userPrompt(thread, config, evidence), schema: BugReportSchema });
}

const QUESTION_FALLBACKS: Record<MissingField, string> = {
  page: "Which page were you on when this happened?",
  steps: "What did you do right before it happened? A short list of clicks or inputs is perfect.",
  expected: "What did you expect to happen instead?",
  actual: "What actually happened? For example an error message, a wrong number, or nothing at all.",
};

/** Plain-code rubric. The model extracts; this decides. */
export function decide(report: BugReport): TriageOutcome {
  if (!report.checkable) {
    return {
      status: "out-of-scope",
      report,
      reason: report.notCheckableReason ?? "This can't be checked automatically in a browser.",
    };
  }

  const missing: MissingField[] = [];
  if (!report.page) missing.push("page");
  if (report.steps.length === 0) missing.push("steps");
  if (!report.expected) missing.push("expected");
  if (!report.actual) missing.push("actual");

  if (missing.length > 0) {
    // missing is non-empty here, so missing[0] is defined.
    const question = report.question ?? QUESTION_FALLBACKS[missing[0]!];
    return { status: "needs-info", report, missing, question };
  }
  return { status: "clear", report };
}

export async function checkClarity(
  thread: IssueThread,
  config: NoReproConfig,
  extract: ReportExtractor,
  evidence?: Evidence | null,
): Promise<TriageOutcome> {
  const outcome = decide(await extract(thread, config, evidence));
  return evidence ? { ...outcome, evidence } : outcome;
}
