# No Repro — Product Discovery: Answers to the 36 Questions

> Research date: 21 Oct 2026 · Method: 4 parallel research agents (Sentry audit, competitor map, problem/buyer evidence, feasibility/design) using official docs, academic papers, changelogs, GitHub issues and HN.
> Numbers marked **[vendor]** come from companies selling into this space. Treat them as directional.
> Where nothing solid was found, the answer says so.

---

## TL;DR

1. **Sentry captures a bug; it does not prove the bug.** Sentry can't re-run a session in a fresh browser, give a reproduced/not-reproduced verdict, or turn a replay into a Playwright test.
2. **The June 2026 Sentry blog post is real but internal.** "Works on my machine: how we use AI to reproduce reported bugs" (Neel Shah, 8 Jun 2026) describes a Claude Code skill used by Sentry's SDK team. It builds a minimal reproduction *app* from a GitHub issue. It doesn't drive a browser, generate tests, or ship as a product. It shows Sentry thinks the problem is worth solving.
3. **No Repro is mostly a recombination of existing pieces.** The closest products are **TraceBug** (in-browser capture plus a failing Playwright spec in each report; free) and **Metabase's Repro-Bot** (GitHub issue → Playwright, up to 3 attempts, writes a failing test; no published success rate). Microsoft's `playwright-triage` skill also aims to "verify" issues.
4. **What nobody ships as a product:**
   - (a) **No ticket without proof:** filing is blocked unless a deterministic verdict from N fresh-browser replays says the bug reproduced.
   - (b) **The reporter's own words set the pass/fail check,** which catches bugs that throw no error (double submit, wrong total, missing result).
   - (c) **When it can't reproduce, it asks the reporter a follow-up question** instead of filing a vague ticket.
5. **The pain is real but occasional and severe, not daily.**
   - 17% of bug reports get closed non-reproducible (12% for web apps).
   - Those reports stay open about 3 months longer, and only about 2% ever get a fix (Joorabchi et al., MSR 2014).
6. **Defensibility at the technology level is low.** Jam or Sentry could add this in a quarter. The lasting advantages would be:
   - Handling login and app state well, which is the hard part.
   - A trust brand built on "zero false filings".
7. **Recommendation:** build it, positioned as **"the verification layer that refuses to file what it can't prove,"** not as a capture tool. Don't compete with Sentry on capture. Scope is in §7.

---

## 1. What problem are we actually solving?

| # | Question | Answer | Evidence |
|---|---|---|---|
| 1 | Specific problem existing tools don't solve | Capture tools (Sentry, Jam, LogRocket) record *what happened*. Nobody re-runs it to confirm the bug recurs before it reaches the tracker. Trackers fill with unproven reports, and the developer still has to reproduce by hand. | Sentry audit (§2); Rahman et al. recommend "a sandbox for bug reproduction" |
| 2 | Biggest pain: collecting, reproducing, root cause, or fixing? | **Reproducing, when the bug came from someone else.** For bugs a developer found themselves, finding the faulty code is harder. | Undo/Cambridge [vendor]: 41% name reproduction the #1 barrier (vs 23% tests, 23% fix). A small survey (arXiv 2103.12447) found 71% rate repro "easy" on their own bugs |
| 3 | Developer time spent reproducing | About 26% of dev time goes to "reproducing and fixing failing tests" [vendor]. No rigorous figure exists for repro alone. Don't cite "Rollbar 38%" or "17.4 h/week"; neither could be verified. | https://devops.com/report-debugging-efforts-cost-companies-61b-annually/ |
| 4 | How often reports lack detail | Common. Developers most want steps to reproduce, stack traces and test cases. Reporters find those the hardest things to supply. | Bettenburg et al., FSE 2008 (n=466) |
| 5 | How often bugs can be reproduced with logs/recordings | No data. Indirect signs: replays silently missing (getsentry/sentry-javascript #10935, #9173, #17903); masking hides values by default. **Needs interviews.** | Sentry audit |
| 6 | Painful enough to pay for? | Unproven. Adjacent tools sell (Jam $14/creator/mo, Marker.io $39–199/mo, LogRocket median ~$25K/yr). Metabase built its own Repro-Bot, so at least some teams have the problem badly enough to build tooling for it. | §5 |
| 7 | Frequent or occasional? | **Occasional but severe per incident.** About 17% of reports end up non-reproducible, they stay open ~3 months longer, and only ~2% get patched. High volume only for teams with an inbound bug channel (support, QA, open source). | Joorabchi et al. MSR 2014: https://people.ece.ubc.ca/amesbah/resources/papers/mona-msr14.pdf |

Causes of non-reproducible reports (Joorabchi):

| Cause | Share | What it means for No Repro |
|---|---|---|
| Interbug dependencies | 45% | — |
| Environment differences | 24% | Partly addressable (viewport, browser) |
| Insufficient information | 14% | This is what the follow-up question loop targets |
| Conflicting expectations | 12% | The **Refused / not-a-bug** verdict targets this |
| Non-deterministic | 3% | The **Flaky** verdict targets this |

---

## 2. What does Sentry already do?

| # | Capability | Sentry today | Tier | Source |
|---|---|---|---|---|
| 1 | Session Replay: clicks, inputs, navigation, console, network, errors, rage/dead clicks | **Yes** | Native, all plans (50 replays included; overage paid) | docs.sentry.io/product/explore/session-replay/web/ |
| 1a | Network bodies/headers | **Opt-in** per URL (`networkDetailAllowUrls`), truncated at 150k chars | Native | …/session-replay/configuration/ |
| 1b | Masking defaults | `maskAllText`, `maskAllInputs` and `blockAllMedia` all **true** | Native | …/session-replay/privacy/ |
| 2 | Link an error to the actions before it | **Yes.** Error-buffer mode uploads "up to a minute" before the error. **Sampled, not guaranteed.** | Native | config docs |
| 3 | Root-cause context | **Yes.** Traces, breadcrumbs and logs are native. Seer root-cause analysis is a paid add-on and doesn't list Session Replay among its inputs. | Seer: paid, per active contributor | docs.sentry.io/product/ai-in-sentry/seer/ |
| 4 | Automatic reproduction in a fresh browser | **No.** Neither the Seer nor the Autofix docs mention running a browser. The "local dev" Seer feature (Jan 2026) expects the developer's own agent to reproduce. | — | Sentry press release, Jan 2026 |
| 5 | Executable regression test from a replay | **Partial / No.** Autofix can write an LLM *unit* test on request, with no proof it fails before the fix. No replay → Playwright/Cypress export exists. | Seer (paid) | changelog Mar 2025; autofix docs |
| 6 | GitHub issues and PRs | Issues: auto-create through alert action (Business+), manual on Team+. PRs: Autofix fix-PRs or handoff to Claude Code/Cursor/Copilot. Gates: ≥10 events, seen within 14 days, enough "fixability". Tests only if requested. | Integration + Seer | docs …/integrations/source-code-mgmt/github/ |
| 7 | Native vs paid | Free on all plans: Replay, User Feedback, breadcrumbs, tracing. Paid add-on: Seer (third-party estimate ~$40/contributor/mo). Beta: Seer Agent (28 Apr 2026). | — | sentry.io/pricing |
| 8 | Developer-reported limitations | (a) Replays missing even at 100% sampling (#10935, #9173, #17873). (b) Bugs that throw no error get no replay unless the session was already sampled. (c) Masking hides the values that caused the bug. (d) Bundle size: ~36KB and ~373ms TBT [vendor]. (e) Little independent data on Seer accuracy; Sentry's 94.5% figure is [vendor]. | — | GitHub issues; HN 34903596 |
| — | User Feedback widget | **Yes, native.** Typed description + screenshot + email, plus up to 60s of replay if Replay is enabled. AI groups and flags spam. **Nothing reproduces or verifies the report.** | All plans | docs.sentry.io/product/user-feedback/ |
| — | The "June 2026 AI bug-repro" claim | **Verified but overstated.** It's an internal Claude Code `repro` skill: GitHub issue URL → minimal repro app on a branch → run → PR. No browser automation, no test generation, one worked example, human review required. Sentry says full automation is held back by "bot noise" concerns. | Internal tool | https://blog.sentry.io/ai-bug-reproduction/ |

### Gap table

| Capability | Sentry | No Repro |
|---|---|---|
| Capture the last ~60s of actions, console and network | ✅ (sampled, masked) | ✅ (always-on local buffer) |
| Reporter describes the bug | ✅ typed | ✅ voice (Wispr Flow) |
| AI root cause | ✅ Seer (paid) | ❌ not the focus |
| **Re-run the session in a fresh browser** | ❌ | ✅ Playwright, N runs |
| **Deterministic reproduced / flaky / not-reproduced verdict** | ❌ | ✅ |
| **Bugs with no error event** (double submit, wrong value, missing result) | ⚠️ rage/dead clicks only | ✅ explicit checks + the reporter's stated expectation |
| **Executable e2e regression test proven to fail** | ❌ (LLM unit test on request, unverified) | ✅ |
| Auto GitHub issue | ✅ (Business+) | ✅ only after it reproduces |
| **Ask the reporter a follow-up when it can't reproduce** | ❌ (Seer asks the developer) | ✅ |

**Conclusion:** don't compete on capture or root cause. The gap is **verification by re-running the bug, plus going back to the reporter when it fails.**

---

## 3. What is genuinely different about No Repro?

### Competitor matrix

(a) accepts a written or spoken description · (b) uses a recorded session · (c) re-runs in a clean browser · (d) gives a verdict · (e) produces an executable test · (f) flags unreproducible reports · (g) opens a GitHub issue/PR

| Tool | a | b | c | d | e | f | g |
|---|---|---|---|---|---|---|---|
| Jam.dev (AI + MCP beta) | P | Y | N | N | N | N | P |
| Bird Eats Bug (2-min buffer) | P | Y | N | N | N | N | Y |
| Marker.io / BugHerd / Userback | P | P | N | N | N | N | Y |
| LogRocket Galileo (auto-dispatches coding agents, Jun 2026) | N | Y | N | N | ? | N | Y |
| PostHog | P | Y | N | N | N | N | P |
| Datadog RUM → Synthetics (manual) | N | Y | Y | P | Y | N | N |
| Meticulous (replays on PRs, visual diff) | N | Y | Y | P | P | N | P |
| Replay.io / Nut | P | Y | N | N | N | N | P |
| QA Wolf / Checksum / Octomind / Momentic | P | P | Y | Y | Y | N | P |
| Playwright Test Agents / MCP | Y | N | Y | P | Y | N | N |
| Microsoft `playwright-triage` skill | Y | N | Y | **Y** | ? | P | — |
| **TraceBug** (free) | N | **Y** | P | ? | **Y** | ? | N (MCP) |
| **Metabase Repro-Bot** (internal/OSS) | **Y** | N | **Y** | P | **Y** | ? | P |
| Copilot coding agent / Devin / Cursor / SWE-agent | Y | N | P | N | P | N | Y |
| **No Repro** | **Y (voice)** | **Y** | **Y** | **Y** | **Y** | **Y** | **Y** |

Research on the same task: **ReBug** reproduced ~50% of 667 GitHub bugs in a browser from written reports (arXiv 2608.03598). **ViBR** reproduced bugs from video at 72% (arXiv 2604.19905).

| # | Question | Answer |
|---|---|---|
| 9 | Something new, or a recombination? | **Mostly a recombination.** Every individual piece exists. What isn't shipped as a product: (1) **blocking the ticket** on a deterministic multi-run verdict; (2) the **reporter's spoken expectation** as the pass/fail check; (3) a **follow-up question** instead of filing. The new part is the policy and the experience, not the technology. |
| 10 | Spoken complaint → verified test with less manual work? | Plausibly, for simple, stateless web flows. Realistic success is 30–60% on clean reports (LIBRO 33%, ReBug ~50%, SWT-Bench agents 18–70%). Because filing is blocked without a pass, failures cost little: it just asks a question. |
| 11 | Bugs that throw no error? | **Yes, and this is the strongest differentiator.** Session-replay tools are triggered by errors. No Repro checks duplicate requests and missing elements or text against what the reporter *said* should happen ("it should be ₹18"). |
| 12 | Replay with the original session's state, login and data? | **No, not in the MVP.** Use a seeded demo database with a reset endpoint per run, a seeded test user via `storageState`, `page.route` mocks for third parties, and `page.clock` for timing. Cut HAR replay (too brittle) and production database snapshots. When a bug depends on specific data, say so instead of guessing. |
| 13 | Tell the reported failure from an unrelated one? | Yes, with a **failure signature** (signal type + endpoint template + normalized error + top stack frame) that must match the original session. Adapted from LIBRO's clustering, which reached 0.63–0.84 precision depending on the threshold. |
| 14 | A useful test with no existing test suite? | Yes. Output a standalone Playwright `.spec.ts`. Scaffold `playwright.config` if it's missing. |
| 15 | Alongside Sentry, or a replacement? | **Alongside Sentry, LogRocket and PostHog,** which own production telemetry. It **competes with Jam, Marker and Bird Eats Bug** for the "report a bug" moment; teams won't run two capture tools. The realistic opening is **internal QA and dogfooding on staging.** |
| 16 | What's defensible if Sentry adds it? | Little at the technology level. Possible moats: (1) **handling app state** (login, seeding, network stubbing), since repro rates sit around 50% and whoever solves state wins; (2) data on which follow-up questions turn "not reproduced" into "reproduced"; (3) a **"zero false filings" trust brand** with published precision; (4) **regression tests that live in the customer's repo**, not a vendor dashboard. |

**Closest competitor: TraceBug.**

| | TraceBug | No Repro |
|---|---|---|
| Capture | In-browser clicks, inputs, failed requests, console | Same kind of local buffer |
| Test | Playwright spec that fails until the bug is fixed | Same |
| Replay | Replays the capture literally | The reporter's intent drives the plan, so it can test what they expected |
| Gate on filing | Not confirmed | Runs N times in a fresh browser; files only on a pass |
| When it can't reproduce | — | Asks the reporter a follow-up |
| Price | **Free** | — (TraceBug being free caps pricing power) |

Check Metabase Repro-Bot (https://www.metabase.com/blog/reprobot-github-issue-triage-agent) before you pitch. It's the closest public precedent for issue → Playwright → failing test.

---

## 4. How should the product work?

| # | Question | Recommendation | Why |
|---|---|---|---|
| 17 | Report inside the website where the bug happened? | **Yes:** an in-page report box, typed or dictated with Wispr | The recording is already there; no context switch |
| 18 | Separate dashboard connected to GitHub? | **Yes, minimal:** a verdict page (runs, trace, video, generated spec) plus a "connected repo" setting | Judges and developers need to see the evidence |
| 19 | SDK, browser extension, or both? | **SDK only for the MVP** (one `<script>`). Extension goes on the roadmap. | Judges won't install an extension. Long term, an extension avoids SDK fatigue (Sentry replay ~36KB / ~373ms TBT [vendor]). |
| 20 | Work without Sentry, or integrate? | **Standalone for the MVP.** Sentry import is a later feature. | Sentry's segment API exists, but masked values and opt-in bodies make it a weak source for replay |
| 21 | File automatically, or approve first? | **Human approval:** "Reproduced 3/3 → Approve & file" | GitHub added PR/issue caps and contribution controls over AI-generated junk (Feb and Jun 2026); curl reports ~20% of submissions are AI junk. Being visibly careful is a selling point. |
| 22 | Tests only, or fixes too? | **Tests only.** An optional "suggested fix" in the PR body is a stretch goal. | A failing test can be checked. LLMs rarely produce tests that fail before a fix and pass after it (SWT-Bench: 3.6% direct prompting, ~19% agents). |
| 23 | When it can't reproduce? | Files nothing. Asks **one** targeted question, which the reporter answers by voice, then retries. Logs it as "not reproduced" with the reason. | Targets the 14% "insufficient information" cause |
| 24 | Protecting passwords, payments, personal data | Mask all inputs by default. Send the LLM only **input shape** (length, trailing space, numeric), not values. Strip `Authorization`/cookie headers and bodies. Unmask only fields marked `data-norepro-unmask`. Template IDs out of URL paths. | Mirrors Sentry's defaults. rrweb masks only passwords by default, so don't rely on it. |

---

## 5. Who would use and pay for it?

| # | Question | Answer |
|---|---|---|
| 25 | Solo developers or small teams? | **Small to mid B2B SaaS web teams (~10–50 engineers)** that already pay for Sentry or LogRocket and get bugs through **support or QA**. Second choice: popular **open-source maintainers** (Metabase built a Repro-Bot for itself). Solo developers mostly find their own bugs, so the pain is lower. |
| 26 | Who feels the pain most? | The **person receiving the report:** developer or maintainer. The **cause** sits with the reporter (QA, support, end users), per Bettenburg. No evidence ranks engineering managers. |
| 27 | How often? | Weekly or more only for teams with an inbound bug channel. Otherwise occasional. No rigorous data by team type; **needs interviews.** |
| 28 | Pricing model? | The market prices per seat (Jam $14/creator/mo; Marker $39–199/mo bundles) or by volume (LogRocket by sessions, $69–295+/mo). A natural fit: **per verified reproduction** or **per project with a run quota**, since browser minutes are the real cost. |
| 29 | Would developers install another SDK? | Reluctantly. Third parties make up 45% of web requests (Web Almanac 2022). The long-term answer is an extension or reading replays from Sentry/LogRocket. For the hackathon, one script tag on your own app is fine. |
| 30 | What would it displace? | **It sits beside** Sentry and LogRocket. **It partly displaces** Jam or Marker for capture, some triage time, and some hand-written regression tests. It overlaps Meticulous on replay-to-test. |

---

## 6. Can we prove the idea works?

| # | Question | Answer |
|---|---|---|
| 31 | Benchmark against manual reproduction | No standard benchmark for web UI bugs exists (BugsJS is server-side Node). **Build your own:** 8–10 planted bugs in the demo app, each with a fix commit, plus decoy reports. Measure time-to-verified-repro against doing it by hand. |
| 32 | How often is the test correct rather than misleading? | Use the **fail-to-pass rule** (LIBRO, SWT-Bench): a test counts only if it fails on the buggy commit **and** passes on the fixed one. Publish **precision** (false-reproduction rate) separately from recall. |
| 33 | Time saved vs Sentry plus a coding assistant | Unmeasured. Run a small A/B on your planted bugs: Sentry replay + Claude Code by hand vs No Repro, timing to a committed failing test. |
| 34 | Real bugs, not just planted ones? | Yes, partly: (1) a **dogfood log** of real bugs found while building, Oct 21–30; (2) optionally, a few real web bugs from GitHub (e.g. issues in small open-source React apps) run through it. Be honest that planted bugs reproduce 100% of the time by design. |
| 35 | Bugs that depend on accounts, database state, timing or third parties | In scope: seeded DB with reset, `storageState` test user, `page.route` mocks, `page.clock`. Out of scope, stated openly: production data, real user accounts, HAR replay. |
| 36 | Smallest demo that proves what competitors can't do | **Three bugs that throw no error, plus a decoy:** (1) **double submit** → 2 POSTs → test asserts 1; (2) **wrong total** after coupon + quantity change, checked against "should be ₹18" from the dictation; (3) **trailing-space search** ("shoes " → 0 results), which first comes back "not reproduced", then a voice follow-up gets it reproduced; (4) a **decoy** report that comes back "not reproduced" and files nothing. Sentry wouldn't even record #1–#3, because no error fires. |

---

## 7. Recommended MVP (9 days, deadline 30 Oct)

**Must have**
- ShopLite demo app with the 3 planted bugs that throw no error. Seed and reset endpoint per run.
- Custom ~50-line recorder: clicks, inputs, routes, console, patched `fetch`/XHR (`response.clone()` for bodies), viewport, 60s rolling buffer, several selector candidates per element.
- Report box that Wispr types into, plus the follow-up question loop.
- Claude turns the description + recording + selector candidates into a **JSON plan**, validated against a schema, with one re-plan if a locator fails or matches several elements.
- Playwright replay, **N=3**, a fresh context each run; trace and video saved.
- Deterministic judge: 5 signals + **failure-signature match**.
- Verdict page: reproduced, flaky, not reproduced or refused.
- Generated `.spec.ts`, plus **Approve → open issue + PR** to a public sandbox repo.

**Should have**
- Decoy "refused" and "not reproduced" cases on screen.
- `page.clock` control.
- Mini evaluation table: recall on planted bugs, false-reproduction rate on decoys.

**Cut**
- Browser extension, Sentry import, HAR replay, auto-fix, arbitrary third-party sites, multi-tenant auth, auto-close (mention in the README only).

**Hosting**
- **Container:** official `mcr.microsoft.com/playwright` image on Fly or Railway, ≥1GB RAM, `--shm-size=1gb`.
- **Warm:** keep one machine always running during judging.
- **Load:** queue with concurrency 2.
- **Limits:** 5 runs per 10 minutes and 50 per day, per IP. 60s timeout.
- **Lock-down:** replay only against an allowlist of your own app's origin. Daily Claude spend cap.
- **Fallback:** a pre-recorded video of the demo.

### Top 5 risks

| Risk | Mitigation |
|---|---|
| The AI picks the wrong selector or steps | Give it recorded selector candidates, not raw DOM. Validate against a schema; one re-plan. |
| "Reproduced" verdict from an unrelated failure | Exact signature match + agreement across N runs |
| Hosted Chromium is flaky or slow | Warm machine, shm fix, a context per run, queue, fallback video |
| Abuse or runaway cost on a public link | Origin allowlist, rate limits, spend cap, sandbox repo |
| Personal data in recordings | Mask by default, send input shape only, strip headers and bodies |

---

## 8. Positioning, and things to fix in the pitch

- **One line:** *"Sentry shows you the bug. No Repro proves it — and refuses to file what it can't."*
- **Don't claim** uniqueness on capture, AI root cause, or "bug → test" alone; TraceBug and Repro-Bot exist. **Do claim:**
  - No ticket without proof.
  - The reporter's own words set the pass/fail check, so it catches bugs that throw no error.
  - A spoken follow-up question when it can't reproduce.
- **Remove** the 30/30/25/15 "judging weights" table from the idea doc. The hackathon page publishes no rubric.
- **Fix in the spec:**
  - The demo plan must add an item to the cart before visiting `/cart` (clean browser = empty cart).
  - Redefine "double action" as two identical requests within about 500ms from repeated clicks on one control, when the reporter said they expected one result.
  - `test.fail` turns CI red once the bug is fixed. Either document that this flip is the auto-close signal, or generate a normal test that's skipped in CI.
- **Best facts to cite in the pitch:**
  1. 17% of bug reports are closed non-reproducible, they stay open about 3 months longer, and only about 2% are ever fixed (Joorabchi et al., MSR 2014).
  2. Steps to reproduce are what developers want most and what reporters struggle most to supply (Bettenburg et al., FSE 2008).
  3. Reproduction is the #1 barrier to fixing bugs, cited by 41% (Undo/Cambridge) [vendor].

## 9. Still unanswered (needs 3–5 developer interviews, not desk research)

- How many inbound bugs per week can't be reproduced, even with Sentry or LogRocket replay?
- Would they let a bot open issues if every one came with a failing test? Or do they need Approve?
- Would they run this on staging with a seeded test account?
- What would they pay, and would it replace Jam or Marker?

---

## Key sources

- Sentry
  - Replay: https://docs.sentry.io/product/explore/session-replay/web/
  - Replay privacy: https://docs.sentry.io/platforms/javascript/session-replay/privacy/
  - Seer: https://docs.sentry.io/product/ai-in-sentry/seer/
  - User Feedback: https://docs.sentry.io/product/user-feedback/
  - Blog post: https://blog.sentry.io/ai-bug-reproduction/
- Joorabchi et al., MSR 2014: https://people.ece.ubc.ca/amesbah/resources/papers/mona-msr14.pdf
- Rahman et al. (Mozilla): https://www.mozillafoundation.org/en/research/library/why-are-some-bugs-non-reproducible-an-empirical-investigation-using-data-fusion/
- Bettenburg et al., FSE 2008: https://www.st.cs.uni-saarland.de/publications/files/bettenburg-tr-2007.pdf
- Undo/Cambridge [vendor]: https://devops.com/report-debugging-efforts-cost-companies-61b-annually/
- LIBRO: https://arxiv.org/abs/2209.11515 · SWT-Bench: https://arxiv.org/html/2406.12952v2 · ReBug: https://arxiv.org/html/2608.03598v1
- TraceBug: https://tracebug.dev/blog/failing-playwright-test-from-bug-report · Metabase Repro-Bot: https://www.metabase.com/blog/reprobot-github-issue-triage-agent
- Jam: https://jam.dev/docs/jam-ai · LogRocket Galileo: https://www.globenewswire.com/fr/news-release/2026/06/23/3316370/0/en/
- GitHub contribution controls: https://visualstudiomagazine.com/articles/2026/06/30/github-extends-contribution-controls-from-prs-to-issues.aspx
- Playwright clock: https://playwright.dev/docs/clock · locators: https://playwright.dev/docs/locators · Railway Playwright: https://docs.railway.com/guides/playwright
