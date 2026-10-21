import type { BisectState } from "./bisect.ts";
import type { Plan } from "./plan.ts";
import type { Verdict } from "./verdict.ts";

/** Where the browser reproduction stands, shown in the issue comment. */
export type ReproState =
  | { status: "disabled" } // the repo hasn't added the No Repro workflow
  | { status: "not-feasible"; reason: string }
  | { status: "running"; plan: Plan; round: number; runUrl: string | null }
  | { status: "done"; plan: Plan; verdict: Verdict; runUrl: string | null; baseUrl: string; bisect?: BisectState; bisectRunUrl?: string | null }
  | { status: "app-failed"; runUrl: string | null; log: string }
  | { status: "error"; message: string; runUrl: string | null };
