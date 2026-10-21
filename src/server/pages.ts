// The server's few HTML pages. Plain strings, no framework.
import type { ConnectedRepo } from "./app.ts";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root { --bg:#f6f6f3; --card:#fff; --ink:#1c1c1a; --muted:#66665f; --accent:#1f6f50; --line:#e3e3dd; }
  @media (prefers-color-scheme: dark) { :root { --bg:#151514; --card:#1f1f1d; --ink:#ececE6; --muted:#a3a39a; --accent:#5cc49a; --line:#33332f; } }
  * { box-sizing:border-box; }
  body { margin:0; font:16px/1.55 system-ui, sans-serif; background:var(--bg); color:var(--ink); }
  main { max-width:640px; margin:0 auto; padding:48px 16px; }
  h1 { font-size:1.9rem; margin:0 0 4px; }
  .tag { color:var(--muted); margin:0 0 28px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:20px; margin-bottom:16px; }
  .btn { display:inline-block; font:inherit; font-weight:600; padding:11px 18px; border-radius:9px; border:0; background:var(--accent); color:#fff; text-decoration:none; cursor:pointer; }
  ol { padding-left:20px; margin:8px 0 0; } li { margin:4px 0; }
  ul.repos { list-style:none; padding:0; margin:8px 0 0; } ul.repos li { padding:6px 0; border-top:1px solid var(--line); }
  .muted { color:var(--muted); } code { font-size:.92em; }
  input { font:inherit; padding:9px 10px; border:1px solid var(--line); border-radius:8px; width:100%; background:var(--bg); color:var(--ink); margin:6px 0 14px; }
</style></head>
<body><main><h1>🔁 No Repro</h1><p class="tag">No repro, no ticket. A GitHub bot that checks whether bug reports are clear, and asks one question when they aren't.</p>
${body}
</main></body></html>`;
}

/**
 * One-time app registration. Not a page anyone reads: it posts the manifest to GitHub
 * straight away, so the host only ever sees GitHub's own "Create GitHub App" screen.
 */
export function setupRedirectPage(manifest: object, state: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Opening GitHub…</title></head>
<body style="font:16px system-ui,sans-serif;padding:40px">
<form action="https://github.com/settings/apps/new?state=${esc(state)}" method="post" id="f">
  <input type="hidden" name="manifest" value="${esc(JSON.stringify(manifest))}">
  <noscript><button type="submit">Continue to GitHub</button></noscript>
</form>
<p>Opening GitHub…</p>
<script>document.getElementById("f").submit();</script>
</body></html>`;
}

/** The only page users see: connect a repo, and the repos already connected. */
export function homePage(installHref: string, repos: ConnectedRepo[] | null): string {
  const list =
    repos === null
      ? `<p class="muted">Couldn't load connected repos right now.</p>`
      : repos.length
        ? `<ul class="repos">${repos.map((r) => `<li><a href="https://github.com/${esc(r.fullName)}/issues">${esc(r.fullName)}</a></li>`).join("")}</ul>`
        : `<p class="muted">No repos connected yet.</p>`;
  return page(
    "No Repro",
    `<div class="card">
  <p style="margin-top:0">Pick a repo on GitHub and No Repro starts checking its new issues.</p>
  <a class="btn" href="${esc(installHref)}">${repos?.length ? "Connect another repo" : "Connect a repo"}</a>
</div>
<div class="card"><h2>Connected repos</h2>${list}</div>`,
  );
}

export function installedPage(): string {
  return page(
    "Installed",
    `<div class="card"><h2>✅ Connected</h2><p>Open a new issue in the repo you picked. No Repro will comment on it within a few seconds.</p><p><a href="/">Back to No Repro</a></p></div>`,
  );
}

export function messagePage(title: string, message: string): string {
  return page(title, `<div class="card"><h2>${esc(title)}</h2><p>${esc(message)}</p><p><a href="/">Back</a></p></div>`);
}
