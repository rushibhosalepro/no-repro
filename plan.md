# No Repro — Build Plan

> **"No repro, no ticket."** An agent that sits on your GitHub repo. When someone opens an issue, it checks whether the report is clear, tries to reproduce it in a real browser, and posts a verdict with evidence.
>
> Stage 1 (hackathon, due **30 Oct 2026, 11:59 pm IST**): GitHub issues only.
> Stage 2 (after): add evidence from Sentry and other error-monitoring tools.
>
> Research behind this plan: [no-repro-discovery.md](no-repro-discovery.md)

---

## 1. What Stage 1 does

Someone opens an issue, typing it or dictating it with Wispr Flow. The agent then does four things:

1. **Checks whether the report is clear.** Does it say where it happened, what the reporter did, what they expected, and what happened instead?
   - If not, it asks **one** specific question in a comment, labels the issue `needs-info`, and waits.
   - The reporter answers in a comment (dictated with Wispr), and the agent tries again.
2. **Tries to reproduce it.** It explores the app in a real browser to find the page and the controls the issue mentions. Then it writes a fixed step-by-step plan and runs it **3 times in fresh browsers** against the repo's app.
3. **Decides with plain code, not AI.** It checks the result against the issue's own expected-vs-actual statement and 5 failure signals. The verdict is one of:
   - `repro:confirmed` (3/3)
   - `repro:flaky` (1–2/3)
   - `repro:not-reproduced` (0/3)
   - `needs-info`
   - `repro:out-of-scope` (visual or speed problems a test can't check)
4. **Reports back** with one comment: the verdict, numbered steps, the environment, a screenshot, a link to the trace and video, and the generated Playwright test. If a maintainer comments `/norepro pr`, it opens a PR with the failing test.

It **never closes or deletes issues**. It only labels and comments. A human makes the decisions.

### What makes it different (the pitch)
- The closest prior work turns issues into tests: Metabase Repro-Bot and TraceBug. No Repro adds three things:
  - **(a) A clarity check that asks the reporter a question,** instead of guessing.
  - **(b) A verdict decided by plain code** across several fresh runs, not "the AI thinks it reproduced".
  - **(c) It catches bugs that throw no error** (double submit, wrong total, missing result) by checking the reporter's stated expectation.
- One line: *"Triage that proves it, or asks."*

---

## 2. Key design decisions

| Decision | Choice for Stage 1 | Why |
|---|---|---|
| How it runs | **GitHub Action** in the user's repo (`uses: norepro/action@v1`), triggered on `issues.opened`, `issues.edited` and `issue_comment.created` | No hosting, no Chromium server to run. It builds the app from source in CI. Secrets stay in the user's repo, and Actions minutes are free on public repos. A GitHub App plus hosted worker comes later (§6). |
| Which app it tests | Configured in `.github/norepro.yml`: either a `start` command (build and run the app inside the Action) or a `baseUrl` (staging/preview) | Most small repos can boot in CI; staging covers the rest |
| App state | `seed`/`reset` command or URL run before **each** run. Optional test account from repo secrets, logged in once and saved with `storageState`. | Fresh browsers have empty carts and no login. Seeding is what makes clean replays work. |
| How it finds elements | **Explore, then freeze.** A bounded agent loop (≤15 browser actions) reads the page's accessibility tree to find what the issue describes. Its output is a **JSON plan**: `goto`/`click`/`fill`/`select`/`viewport`/`wait` plus assertions. The replay then runs that plan with **no AI** in the loop. | With no session recording, the agent has to look at the app to find "the button". Freezing the plan makes the 3 runs comparable. |
| Who decides "reproduced" | Plain code. 5 signals: uncaught error, console error, 5xx, duplicate request, expected element/text/value mismatch. Plus a **failure signature** (signal + endpoint + normalized message) that must match across runs. | The AI can be wrong about the steps, but never about the verdict |
| AI model | Claude API, structured JSON output. Model set by config (`claude-sonnet-5-5` by default for cost, `claude-opus-5-5` optional). | |
| Safety | Issue text is **untrusted input** (prompt injection). The agent can only output the allowed actions; there's no shell or code execution. The browser only visits the configured origin (`page.route` blocks everything else). There's a run limit per issue and per day. Secrets are never put in comments. Inputs are masked in screenshots. | Anyone on the internet can open an issue on a public repo |
| Evidence hosting | Screenshot committed to an orphan `norepro-evidence` branch and embedded by raw URL. Trace/video uploaded as an Action artifact. Test inlined in the comment. | GitHub's API can't attach images to comments |

---

## 3. Architecture

```
GitHub issue event
      │
      ▼
GitHub Action (norepro)
  1. Load config ── .github/norepro.yml
  2. Clarity check (LLM → structured fields + missing list)   ── unclear → ask 1 question, label needs-info, stop
  3. Boot app (start cmd / baseUrl) + seed
  4. Explore (bounded agent, accessibility tree) → JSON plan + expectations
  5. Replay ×3 (Playwright, fresh context each, seed before each) ── trace, video, network log
  6. Judge (plain code: signals + signature + expectation)
  7. Report: comment + labels + evidence; optional /norepro pr → failing test PR
```

**Code layout (TypeScript, Node 20)**
```
packages/core/      clarity.ts  explore.ts  plan.schema.ts  replay.ts  judge.ts  testgen.ts  report.ts
packages/action/    action.yml  main.ts  (Octokit, @actions/core)
demo/shoplite/      demo app with planted bugs + seed/reset + norepro.yml
eval/               labelled issue set + runner script + results.md
```
`core` doesn't depend on GitHub, so the same pieces can power a CLI and the Stage 2 GitHub App.

### Clarity check: deterministic rubric, LLM-extracted fields
The AI pulls these fields out of the issue: `where` (URL/page), `steps[]`, `expected`, `actual`, `environment`. Then code decides:
- **Clear:** `where` + at least 1 step + `expected` + `actual`.
- **Unclear:** ask for the single most important missing field, in plain words, quoting the reporter. Example: *"Which page were you on, and what did you expect the total to be?"*
- **Out of scope:** the expected result is subjective ("looks off", "feels slow").

---

## 4. Demo setup (what judges see)

- **Public demo repo `norepro-demo`:** the ShopLite app + the No Repro Action installed. Judges open an issue with no setup (any GitHub account works).
- **The README has 4 ready-to-paste issues,** each showing a different outcome:
  1. "Double-tapping Place Order on mobile creates two orders" → **confirmed 3/3**, Playwright test in the comment, PR on `/norepro pr`.
  2. "Search is broken" → **needs-info** question → reply *"searched 'shoes ' with a trailing space, got 0 results"* → **confirmed**.
  3. "Coupon total wrong, should be ₹18 after changing quantity" → **confirmed** (bug that throws no error; Sentry would never see it).
  4. "Checkout button doesn't work" (it does) → **not reproduced**, with steps it tried and evidence.
- **Where voice comes in:** the video shows issues and follow-up answers being **dictated into GitHub with Wispr Flow**. Building is dictated too: prompts, specs, README, commits.
- **Fallback:** pinned issues with finished runs already on them, so judges see results even if Actions is slow.

---

## 5. 9-day schedule (today is Wed 21 Oct)

| Day | Date | Deliverable | Done when |
|---|---|---|---|
| 1 | Wed 21 | ShopLite with 3 planted bugs that throw no error + seed/reset; `norepro.yml` schema; Action skeleton that comments "received" on new issues | Opening an issue gets a bot comment |
| 2 | Thu 22 | **Clarity check** + `needs-info` question loop (re-runs on reporter comment) | "Search is broken" gets a good question; the answer re-triggers it |
| 3 | Fri 23 | **Explore → JSON plan** (riskiest piece, so it goes early). Schema validation, one re-plan on locator failure. | The plan for issue #1 is correct 4 out of 5 times |
| 4 | Sat 24 | **Replay ×3 + judge** (5 signals + signature + expectation check) | Issues #1–#4 get the right verdicts locally |
| 5 | Sun 25 | **Report:** comment template, labels, screenshot branch, trace/video artifact, Playwright test generation, `/norepro pr`. **Feature freeze.** Weekly #NoHandsChallenge post. | Full flow works end to end in GitHub Actions |
| 6 | Mon 26 | **Eval set:** ~15 labelled issues (6 clear real bugs, 3 vague, 3 not-a-bug, 3 out-of-scope). Run, fix, publish `eval/results.md`. | Recall and false-confirm rate published |
| 7 | Tue 27 | Hardening: injection tests, origin lock, run limits, timeouts. **Dogfood on one real repo of yours.** | One real bug triaged on a non-demo repo |
| 8 | Wed 28 | 2-minute video (hook in the first 15s), README, demo issues, pinned fallback runs | Video recorded |
| 9 | Thu 29 | Buffer + test in incognito with a fresh GitHub account | A stranger can try it end to end |
| — | **Fri 30** | **Submit by noon IST:** link, video, Wispr usage card, problem write-up | Submitted |

**Cut in this order if behind:** `/norepro pr` → screenshot branch (link the artifact only) → flaky verdict → out-of-scope verdict.
**Never cut:** clarity question loop, the 3-run verdict by plain code, the comment with evidence.

---

## 6. Stage 2: more evidence (after the hackathon)

Goal: ground the plan in **what actually happened**, not just the issue text. That raises the reproduction rate on vague reports and on bugs that depend on state.

| Step | What | Notes |
|---|---|---|
| 2.1 | **GitHub App + hosted worker** (replaces the Action for teams that want zero CI setup) | Playwright container ≥1GB, `--shm-size=1gb`, a queue, origin allowlist |
| 2.2 | **Sentry connector:** find the Sentry issue/replay that matches a GitHub issue (error message, URL, time window, user email if given). Pull breadcrumbs, the stack top, replay recording segments (`/replays/.../recording-segments/`) and network spans. Feed them to the planner as "observed steps". | Sentry masks inputs and leaves out bodies by default, so it gives the *path* but not the values. The issue text still supplies the values. |
| 2.3 | Other sources: **LogRocket, PostHog, Datadog RUM** behind the same `EvidenceSource` interface | `core/evidence/*.ts`. Each one returns steps, errors and requests in one shared format. |
| 2.4 | **Own recorder SDK** (one script tag, 60s buffer, input *shape* not values) for teams without session replay | Covers bugs that throw no error, which Sentry doesn't record |
| 2.5 | **Duplicate detection:** same failure signature as an open issue → comment there instead | |
| 2.6 | **Auto-close loop:** when the generated test starts passing on `main`, comment "fixed" with the commit | |
| 2.7 | Learning loop: track which clarity questions turn `needs-info` into `confirmed` | This data is the long-term advantage (see discovery §3, Q16) |

---

## 7. Risks

| Risk | Mitigation |
|---|---|
| Exploring finds the wrong element or page | Accessibility-tree input, bounded steps, one re-plan, and the verdict needs the expectation to match, not just "something failed" |
| The app won't boot in CI for real repos | Support `baseUrl` (staging/preview) as the alternative. The demo repo is guaranteed to boot. |
| False "confirmed" from an unrelated error | Signature must match across runs and match the issue's stated actual behaviour |
| Prompt injection through issue text / abuse of a public repo | No shell, allowed actions only, origin lock, run limits, secrets never echoed, maintainer-only `/norepro pr` |
| GitHub Actions is slow during judging (cold runner ~1–2 min) | Comment "working on it…" right away, pinned finished runs, and the demo video |
| Close to Metabase Repro-Bot / TraceBug | Lead with the clarity check + question loop and bugs that throw no error. Credit prior work openly in the README. |

## 8. Open questions (none block Day 1)
- Repo/brand name `norepro` on GitHub and the Marketplace: check availability today.
- Which real repo to dogfood on Day 7 (one of your own past projects).
- A model budget cap for the demo repo (e.g. a daily Claude API spend limit set in the console).
