# No Repro

> **"No repro, no ticket."** A GitHub App that watches your repo's issues. For each new issue it checks the report is clear, points at the likely faulty lines, replays the bug in a real browser on **your own** GitHub Actions runner, and finds the commit that introduced it.

Built for *No Hands: The Wispr Challenge*. Reporters can dictate issues and answers with Wispr Flow; the agent turns them into a structured, checkable report.

## What it does

1. **Clarity check.** Missing where / steps / expected / actual? It asks **one** question and re-runs when the reporter replies (`needs-info`). Subjective reports ("looks weird") are left to a human (`repro:out-of-scope`).
2. **Likely cause.** Reads the repo's source and names the file, lines and the commit that last changed them, with a collapsible code snippet.
3. **Reproduction (optional, per repo).** Writes a plan (browser steps + one check of the *expected* behaviour) and replays it 3 times in fresh browsers on the repo's own GitHub Actions runner, with the repo's own secrets. Plain code decides the verdict: `repro:confirmed`, `repro:flaky`, `repro:not-reproduced` or `repro:inconclusive`.
4. **Introduced in.** For a confirmed bug, `git bisect` on the same runner from a known-good point (the version the reporter says worked, the latest release tag, or the commit before the suspect lines changed) to the exact commit, with its diff.

One comment per issue, edited in place: verdict, summary table, run results, introduced-in, likely cause, links, conclusion. It never closes, edits or deletes issues, and **No Repro never runs your code itself**: the plan is data (clicks, typing, one check) and only your runner executes your app.

### Production evidence (Sentry)

Click **Connect Sentry** on the No Repro home page, accept in Sentry, then point the repo at its project:

```yaml
sentry:
  org: acme          # the Sentry organization slug
  project: shoplite  # the project slug
```

Each issue is matched to its Sentry issue (a pasted Sentry link wins; otherwise the model picks from recent issues, or none). The match feeds every step:
- **Clarity:** fills in what the reporter left out.
- **Likely cause:** always reads the files in the stack trace.
- **Plan:** follows the real user's breadcrumbs.
- **Bisect:** starts from the release before Sentry first saw it.
- **Comment:** adds a **Production** row (events, users, first-seen release) and a **View in Sentry** link.

A Sentry outage never blocks triage.

Host setup (once): register a Sentry **public integration** with redirect URL `<server>/sentry/callback`, *Verify Install* on, and read access to Project, Issue & Event and Organization. Put `SENTRY_CLIENT_ID`, `SENTRY_CLIENT_SECRET` and `SENTRY_INTEGRATION_SLUG` in `.env`.

### Enable reproduction on a repo

Add `.github/workflows/norepro.yml` and `.github/norepro/runner.mjs` (generate both with `bun scripts/enable-runs.ts <checkout>`), and describe how to start the app:

```yaml
app:
  start: npm run dev
  baseUrl: http://localhost:3000
  ready: /health
  reset: POST /__reset     # optional, called before every run
run:
  install: npm ci
  env: [GEMINI_API_KEY]    # repo secrets the app needs; values never leave GitHub
```

## Connect a repo (everyone, including you)

1. Open the No Repro home page and click **Install on GitHub**.
2. On GitHub's page, choose **Only select repositories**, pick the repo, click **Install**.
3. Open an issue in that repo. No Repro comments within a few seconds.

No tokens, API keys or files to add. To add or remove repos later, click **Install on GitHub** again.

Optional: a `.github/norepro.yml` in the repo describes the app (pages, how to start it) to help the agent. Without it, defaults are used.

## Run the server (the host, once)

The person running No Repro does this once. After that they connect repos with the same Install button as everyone else.

```bash
bun install
bun run server          # http://localhost:8787
```

1. Open http://localhost:8787 and click **Create GitHub App**. GitHub shows the app's settings already filled in (permissions: issues write, contents read). Confirm, and GitHub sends the app's credentials back to the server, which saves them in `.norepro/app.json` (gitignored).
2. The home page now shows **Install on GitHub**. Use it like any user would.

`.env` for the host:

```
OPENROUTER_API_KEY=sk-or-v1-...          # the host pays for the model, users never need a key
NOREPRO_MODEL=anthropic/claude-haiku-5.5 # optional; defaults to anthropic/claude-opus-5.5
# NOREPRO_PROVIDER=anthropic + ANTHROPIC_API_KEY to use Claude directly instead
# NOREPRO_PUBLIC_URL=https://norepro.example.com   # when deployed
```

**Local vs deployed.** Locally, GitHub can't reach `localhost`, so the server creates a [smee.io](https://smee.io) channel (saved in `.norepro/dev-channel.json`) and forwards its webhooks to your machine. Deployed, set `NOREPRO_PUBLIC_URL` before the first run and GitHub delivers to `<url>/webhook` directly. Webhook signatures are verified either way.

## Repo config (`.github/norepro.yml`, optional)

```yaml
app:
  name: ShopLite
  description: A small online shop.
  baseUrl: http://localhost:3000
  reset: POST /__reset     # called before every replay run
  pages:
    - path: /cart
      description: Cart, coupon field, Place Order button
replay:
  runs: 3
limits:
  maxRunsPerIssue: 5       # stops a public repo being used to burn API credits
onlyLabels: []             # e.g. [bug] to only triage labelled issues
```

### Commands in issues

- Reporter replies while the issue is `needs-info` → re-run automatically.
- `/norepro retry` (maintainers only) → re-run after an error.

## Develop

```bash
bun test                                                   # unit tests + planted-bug checks
bun run demo                                               # ShopLite on http://localhost:3000
bun run triage examples/issues/2-search-vague.md           # triage a markdown issue, no GitHub
```

## Demo app: ShopLite

Three planted bugs, all silent (no exception, no 500), which is what error monitors miss:

1. **Double submit.** Tapping Place Order twice quickly creates two orders.
2. **Stale coupon.** Apply `SAVE10` to ₹2,000 of shoes (total ₹1,800), raise the quantity to 2, and the total shows ₹3,800 instead of ₹3,600.
3. **Search spaces.** `shoes ` with a trailing space returns 0 results.

## Layout

```
src/server/           GitHub App: setup page, install button, webhooks, background queue
src/core/             GitHub-independent: config, clarity check, prompt, comment rendering
src/core/providers/   openrouter (OpenAI SDK) and anthropic (Anthropic SDK)
src/github/           event filtering, comment/label side effects, the run loop, code + history via the API
src/repro/            planner, verdict, bisect, workflow template, runner.mjs (runs on the repo's own runner)
src/cli.ts            local triage of a markdown issue
demo/shoplite/        demo app with planted bugs
examples/issues/      sample issues, one per outcome
test/                 bun test
```
