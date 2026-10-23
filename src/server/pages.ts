// The server's pages: plain strings, no framework. Layout follows one rule: a maintainer
// (or a judge) should see what each project is connected to and what No Repro concluded
// about each issue at a glance.
import type { CheckRecord, Project, ProjectStats, Verdict } from "./projects.ts";
import { demoFor, newIssueHref, type Demo } from "./demo.ts";

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const LOGO = `<svg viewBox="0 0 512 512" width="30" height="30" aria-hidden="true"><rect x="10" y="10" width="492" height="492" rx="113" fill="var(--accent)"/><circle cx="256" cy="256" r="155" fill="none" stroke="var(--accent-ink)" stroke-width="40"/><path d="M197 261 L241 305 L325 212" fill="none" stroke="var(--accent-ink)" stroke-width="46" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const ICON = {
  github: `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.6" d="M6 3h11a1 1 0 0 1 1 1v16H7a2 2 0 0 1-2-2V5a2 2 0 0 1 1-2Zm0 13h12M9 3v13"/></svg>`,
  sentry: `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" d="M3 12h4l2-6 4 12 2-6h6"/></svg>`,
  run: `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" d="M7 4.5v15l12-7.5-12-7.5Z"/></svg>`,
  check: `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" d="m5 12.5 4.5 4.5L19 7.5"/></svg>`,
  replay: `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><rect x="3" y="5" width="18" height="13" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="m10 9 5 2.5-5 2.5Z" fill="currentColor"/></svg>`,
  plus: `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M12 5v14M5 12h14"/></svg>`,
};

const STYLE = `
:root {
  --bg:#f5f5f2; --surface:#ffffff; --surface-2:#f0f0ec; --line:#e2e2dc; --ink:#1b1b19; --muted:#66665f;
  --accent:#1f8a5f; --accent-ink:#ffffff; --accent-soft:#e3f3ea; --accent-text:#156b49;
  --warn:#8a6100; --warn-soft:#fbf0d6; --danger:#b4382c; --danger-soft:#fbe5e2; --info:#2f5fa8; --info-soft:#e3ecfa;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --bg:#121212; --surface:#1b1b1b; --surface-2:#222; --line:#2c2c2c; --ink:#ededea; --muted:#9b9b94;
  --accent:#5cc49a; --accent-ink:#0d2a1e; --accent-soft:#163a2b; --accent-text:#7fd8b2;
  --warn:#f0c35a; --warn-soft:#3a2f12; --danger:#ef8a7f; --danger-soft:#3b1e1b; --info:#8db4f0; --info-soft:#1b2a40;
  color-scheme: dark;
} }
* { box-sizing:border-box; }
html, body { margin:0; background:var(--bg); color:var(--ink); }
body { font:15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
a { color:var(--accent-text); }
.mono, code { font-family:ui-monospace, "JetBrains Mono", "Cascadia Code", Menlo, monospace; font-size:.92em; }
header.top { border-bottom:1px solid var(--line); background:var(--surface); }
header.top .in { max-width:1160px; margin:0 auto; padding:12px 16px; display:flex; align-items:center; gap:28px; }
.brand { display:flex; align-items:center; gap:10px; font-weight:700; font-size:1.05rem; color:var(--ink); text-decoration:none; }
nav.tabs { display:flex; gap:4px; }
nav.tabs a { color:var(--muted); text-decoration:none; padding:6px 12px; border-radius:8px; font-weight:500; }
nav.tabs a[aria-current="page"] { color:var(--ink); background:var(--surface-2); }
main { max-width:1160px; margin:0 auto; padding:36px 16px 64px; }
h1 { font-size:2rem; line-height:1.2; margin:0; letter-spacing:-.01em; }
h2 { font-size:1.15rem; margin:0; }
.lede { color:var(--muted); max-width:620px; margin:8px 0 0; }
.crumbs { color:var(--muted); font-size:.9rem; margin-bottom:10px; } .crumbs a { color:var(--muted); text-decoration:none; }
.head { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; flex-wrap:wrap; margin-bottom:28px; }
.head .title { display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
.row { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
.grid { display:grid; gap:16px; grid-template-columns:repeat(auto-fill, minmax(320px, 1fr)); }
.card { background:var(--surface); border:1px solid var(--line); border-radius:14px; padding:20px; }
.card.dashed { border-style:dashed; background:transparent; display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; gap:10px; min-height:220px; text-decoration:none; color:var(--ink); }
.card.dashed p { color:var(--muted); margin:0; max-width:260px; }
.iconbox { width:40px; height:40px; border-radius:10px; display:grid; place-items:center; background:var(--surface-2); border:1px solid var(--line); color:var(--ink); }
.btn { display:inline-flex; align-items:center; gap:8px; font:inherit; font-weight:600; padding:9px 16px; border-radius:10px; border:1px solid transparent; background:var(--accent); color:var(--accent-ink); text-decoration:none; cursor:pointer; }
.btn.ghost { background:var(--surface-2); color:var(--ink); border-color:var(--line); }
.btn.link { background:none; border:0; color:var(--accent-text); padding:9px 4px; text-decoration:underline; }
.btn.danger { background:none; border:0; color:var(--danger); padding:9px 4px; }
form.inline { display:inline; margin:0; }
.pill { display:inline-flex; align-items:center; gap:6px; font-size:.8rem; font-weight:600; padding:3px 10px; border-radius:999px; white-space:nowrap; }
.pill::before { content:""; width:6px; height:6px; border-radius:50%; background:currentColor; }
.pill.nodot::before { display:none; }
.ok { color:var(--accent-text); background:var(--accent-soft); }
.warn { color:var(--warn); background:var(--warn-soft); }
.bad { color:var(--danger); background:var(--danger-soft); }
.info { color:var(--info); background:var(--info-soft); }
.neutral { color:var(--muted); background:var(--surface-2); }
.conn { display:flex; align-items:center; gap:12px; padding:10px 12px; border:1px solid var(--line); border-radius:10px; background:var(--surface-2); margin-top:10px; }
.conn .k { font-size:.78rem; color:var(--muted); } .conn .v { font-weight:600; }
.conn .end { margin-left:auto; color:var(--accent-text); }
.conn.missing { background:transparent; border-style:dashed; }
.stats { display:flex; gap:28px; margin-top:16px; padding-top:16px; border-top:1px solid var(--line); }
.stats b { display:block; font-size:1.5rem; line-height:1.1; } .stats span { color:var(--muted); font-size:.85rem; }
.card-head { display:flex; align-items:flex-start; gap:12px; margin-bottom:12px; }
.card-head .sub { color:var(--muted); font-size:.88rem; } .card-head .pill { margin-left:auto; }
dl.kv { display:grid; grid-template-columns:110px 1fr; gap:6px 12px; margin:0 0 16px; font-size:.93rem; }
dl.kv dt { color:var(--muted); } dl.kv dd { margin:0; }
.section { margin-top:36px; } .section .bar { display:flex; justify-content:space-between; align-items:baseline; gap:12px; margin-bottom:14px; }
.section .bar small { color:var(--muted); }
table.list { width:100%; border-collapse:separate; border-spacing:0; background:var(--surface); border:1px solid var(--line); border-radius:14px; overflow:hidden; }
table.list th { text-align:left; font-size:.75rem; letter-spacing:.06em; text-transform:uppercase; color:var(--muted); font-weight:600; padding:12px 18px; border-bottom:1px solid var(--line); }
table.list td { padding:14px 18px; border-bottom:1px solid var(--line); vertical-align:top; }
table.list tr:last-child td { border-bottom:0; }
table.list .t { font-weight:600; } table.list .t a { color:var(--ink); text-decoration:none; } table.list .n { color:var(--muted); font-size:.85rem; }
.muted { color:var(--muted); } .small { font-size:.85rem; }
.split { display:grid; gap:16px; grid-template-columns:minmax(0, 2fr) minmax(0, 1fr); }
.eyebrow { font-size:.75rem; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); font-weight:600; margin:0 0 10px; }
pre.trace { background:var(--bg); border:1px solid var(--line); border-radius:10px; padding:14px; overflow:auto; margin:12px 0; font-size:.85rem; line-height:1.6; }
.stat-row { display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid var(--line); } .stat-row:last-of-type { border-bottom:0; }
.empty { text-align:center; padding:40px 20px; color:var(--muted); }
/* wizard */
.wizard { display:grid; gap:20px; grid-template-columns:minmax(0, 1fr) 320px; align-items:start; }
.steps { display:flex; gap:22px; flex-wrap:wrap; margin:22px 0 26px; }
.steps .s { display:flex; align-items:center; gap:10px; color:var(--muted); font-weight:500; }
.steps .dot { width:28px; height:28px; border-radius:50%; display:grid; place-items:center; border:1.5px solid var(--line); font-size:.85rem; }
.steps .done .dot { background:var(--accent-soft); color:var(--accent-text); border-color:transparent; }
.steps .now { color:var(--ink); font-weight:700; } .steps .now .dot { background:var(--accent); color:var(--accent-ink); border-color:transparent; }
.summary { display:flex; justify-content:space-between; align-items:center; gap:12px; margin-bottom:12px; }
.summary .k { color:var(--muted); font-size:.85rem; } .summary .v { font-weight:600; }
label.f { display:block; font-weight:600; margin:18px 0 8px; }
input[type=text], select { width:100%; font:inherit; padding:11px 12px; border:1px solid var(--line); border-radius:10px; background:var(--bg); color:var(--ink); }
.choice { display:flex; align-items:center; gap:12px; padding:14px 16px; border:1px solid var(--line); border-radius:12px; margin-top:10px; cursor:pointer; background:var(--bg); }
.choice:has(input:checked) { border-color:var(--accent); background:var(--accent-soft); }
.choice input { accent-color:var(--accent); width:18px; height:18px; } .choice .hint { margin-left:auto; font-size:.85rem; color:var(--accent-text); }
.actions { display:flex; justify-content:space-between; align-items:center; gap:12px; margin-top:24px; padding-top:18px; border-top:1px solid var(--line); }
ol.next { list-style:none; padding:0; margin:0; counter-reset:n; } ol.next li { counter-increment:n; display:flex; gap:12px; margin:0 0 14px; }
ol.next li::before { content:counter(n, decimal-leading-zero); font-family:ui-monospace, monospace; color:var(--accent-text); }
.notice { padding:12px 14px; border-radius:10px; margin-bottom:16px; }
/* project page */
.meta { display:flex; flex-wrap:wrap; align-items:center; gap:8px; color:var(--muted); font-size:.9rem; }
.meta a { display:inline-flex; align-items:center; gap:6px; color:var(--ink); text-decoration:none; } .meta a svg { width:15px; height:15px; }
.meta .sep { opacity:.5; }
.live { display:inline-flex; align-items:center; gap:6px; color:var(--accent-text); font-weight:600; }
.live::before { content:""; width:8px; height:8px; border-radius:50%; background:var(--accent); box-shadow:0 0 0 3px var(--accent-soft); }
.clist { display:flex; flex-direction:column; }
.crow { display:flex; align-items:center; gap:14px; padding:16px 18px; border-top:1px solid var(--line); }
.clist > .crow:first-child { border-top:0; }
.crow .cbody { display:flex; flex-direction:column; min-width:0; } .crow .cbody span { color:var(--muted); font-size:.88rem; }
.crow .cend { margin-left:auto; display:flex; align-items:center; gap:10px; flex-shrink:0; }
.crow.off { opacity:.6; }
a.prow { text-decoration:none; color:inherit; } a.prow:hover { background:var(--accent-soft); }
.clist.card { overflow:hidden; }
.chev { color:var(--muted); font-size:1.3rem; line-height:1; }
.toggle { width:42px; height:24px; border-radius:999px; border:0; padding:3px; background:var(--line); cursor:pointer; display:flex; }
.toggle span { width:18px; height:18px; border-radius:50%; background:var(--surface); transition:transform .15s; }
.toggle[aria-checked="true"] { background:var(--accent); } .toggle[aria-checked="true"] span { transform:translateX(18px); background:var(--accent-ink); }
dialog.sheet { width:min(560px, calc(100vw - 32px)); border:1px solid var(--line); border-radius:16px; background:var(--surface); color:var(--ink); padding:22px; }
dialog.sheet::backdrop { background:rgb(0 0 0 / .55); }
dialog.sheet .clist { border:1px solid var(--line); border-radius:12px; margin-top:14px; }
.sheet-head { display:flex; justify-content:space-between; align-items:center; margin:0; }
.logo { display:inline-grid; place-items:center; border-radius:9px; flex-shrink:0; box-shadow:inset 0 0 0 1px rgb(255 255 255 / .08); }
.tryit .crow .cbody span { font-size:.85rem; }
.tryit .btn svg { width:16px; height:16px; }
/* two-column project page */
.pgrid { display:grid; gap:28px; grid-template-columns:minmax(0, 1fr) 320px; align-items:start; margin-top:32px; }
.pgrid .bar { display:flex; justify-content:space-between; align-items:baseline; gap:12px; margin-bottom:10px; }
.pgrid .bar .eyebrow { margin:0; }
.pgrid .clist.card { padding:0; }
details.issue { border-top:1px solid var(--line); } .clist > details.issue:first-child { border-top:0; }
details.issue summary { list-style:none; display:flex; align-items:center; gap:14px; padding:14px 18px; cursor:pointer; }
details.issue summary::-webkit-details-marker { display:none; }
details.issue summary:hover { background:var(--surface-2); }
details.issue summary .cbody { display:flex; flex-direction:column; min-width:0; } details.issue summary .cbody span { color:var(--muted); font-size:.85rem; }
details.issue summary .cend { margin-left:auto; flex-shrink:0; }
details.issue .reply { padding:4px 18px 16px; border-top:1px dashed var(--line); background:var(--surface-2); }
details.issue .reply .eyebrow { margin-top:12px; }
.card.side .crow { padding:13px 16px; }
button.addrow { width:100%; font:inherit; font-weight:600; text-align:left; background:none; border:0; border-top:1px solid var(--line); color:var(--accent-text); cursor:pointer; }
button.addrow:hover { background:var(--accent-soft); }
.danger-text { color:var(--danger) !important; }
h1.live-title { display:flex; align-items:center; gap:10px; }
h1.live-title::before { content:""; width:10px; height:10px; border-radius:50%; background:var(--accent); box-shadow:0 0 0 4px var(--accent-soft); }
@media (max-width:860px) { .pgrid { grid-template-columns:1fr; } }
@media (max-width:600px) { .crow { flex-wrap:wrap; } .crow .cend { margin-left:54px; } }
@media (max-width:860px) { .split, .wizard { grid-template-columns:1fr; } header.top .in { gap:12px; } }
@media (max-width:600px) { table.list th:nth-child(3), table.list td:nth-child(3), table.list th:nth-child(4), table.list td:nth-child(4) { display:none; } .stats { gap:18px; } h1 { font-size:1.6rem; } }
`;

type Tab = "projects" | "activity" | "how";

export function layout(title: string, body: string, active: Tab | null = "projects"): string {
  const tab = (id: Tab, href: string, label: string) => `<a href="${href}"${active === id ? ' aria-current="page"' : ""}>${label}</a>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(LOGO.replace(/var\(--accent\)/g, "#1f8a5f").replace(/var\(--accent-ink\)/g, "#fff"))}">
<style>${STYLE}</style></head>
<body>
<header class="top"><div class="in">
  <a class="brand" href="/">${LOGO}<span>No Repro</span></a>
  <nav class="tabs">${tab("projects", "/", "Projects")}${tab("activity", "/activity", "Activity")}${tab("how", "/how-it-works", "How it works")}</nav>
</div></header>
<main>${body}</main>
</body></html>`;
}


// Brand marks from Simple Icons, drawn white on the brand's colour so each connector is recognisable at a glance.
const BRAND = {
  github: { color: "#24292f", d: "M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" },
  sentry: { color: "#362d59", d: "M13.91 2.505c-.873-1.448-2.972-1.448-3.844 0L6.904 7.92a15.478 15.478 0 0 1 8.53 12.811h-2.221A13.301 13.301 0 0 0 5.784 9.814l-2.926 5.06a7.65 7.65 0 0 1 4.435 5.848H2.194a.365.365 0 0 1-.298-.534l1.413-2.402a5.16 5.16 0 0 0-1.614-.913L.296 19.275a2.182 2.182 0 0 0 .812 2.999 2.24 2.24 0 0 0 1.086.288h6.983a9.322 9.322 0 0 0-3.845-8.318l1.11-1.922a11.47 11.47 0 0 1 4.95 10.24h5.915a17.242 17.242 0 0 0-7.885-15.28l2.244-3.845a.37.37 0 0 1 .504-.13c.255.14 9.75 16.708 9.928 16.9a.365.365 0 0 1-.327.543h-2.287c.029.612.029 1.223 0 1.831h2.297a2.206 2.206 0 0 0 1.922-3.31z" },
  actions: { color: "#2088ff", d: "M10.984 13.836a.5.5 0 0 1-.353-.146l-.745-.743a.5.5 0 1 1 .706-.708l.392.391 1.181-1.18a.5.5 0 0 1 .708.707l-1.535 1.533a.504.504 0 0 1-.354.146zm9.353-.147l1.534-1.532a.5.5 0 0 0-.707-.707l-1.181 1.18-.392-.391a.5.5 0 1 0-.706.708l.746.743a.497.497 0 0 0 .706-.001zM4.527 7.452l2.557-1.585A1 1 0 0 0 7.09 4.17L4.533 2.56A1 1 0 0 0 3 3.406v3.196a1.001 1.001 0 0 0 1.527.85zm2.03-2.436L4 6.602V3.406l2.557 1.61zM24 12.5c0 1.93-1.57 3.5-3.5 3.5a3.503 3.503 0 0 1-3.46-3h-2.08a3.503 3.503 0 0 1-3.46 3 3.502 3.502 0 0 1-3.46-3h-.558c-.972 0-1.85-.399-2.482-1.042V17c0 1.654 1.346 3 3 3h.04c.244-1.693 1.7-3 3.46-3 1.93 0 3.5 1.57 3.5 3.5S13.43 24 11.5 24a3.502 3.502 0 0 1-3.46-3H8c-2.206 0-4-1.794-4-4V9.899A5.008 5.008 0 0 1 0 5c0-2.757 2.243-5 5-5s5 2.243 5 5a5.005 5.005 0 0 1-4.952 4.998A2.482 2.482 0 0 0 7.482 12h.558c.244-1.693 1.7-3 3.46-3a3.502 3.502 0 0 1 3.46 3h2.08a3.503 3.503 0 0 1 3.46-3c1.93 0 3.5 1.57 3.5 3.5zm-15 8c0 1.378 1.122 2.5 2.5 2.5s2.5-1.122 2.5-2.5-1.122-2.5-2.5-2.5S9 19.122 9 20.5zM5 9c2.206 0 4-1.794 4-4S7.206 1 5 1 1 2.794 1 5s1.794 4 4 4zm9 3.5c0-1.378-1.122-2.5-2.5-2.5S9 11.122 9 12.5s1.122 2.5 2.5 2.5 2.5-1.122 2.5-2.5zm9 0c0-1.378-1.122-2.5-2.5-2.5S18 11.122 18 12.5s1.122 2.5 2.5 2.5 2.5-1.122 2.5-2.5zm-13 8a.5.5 0 1 0 1 0 .5.5 0 0 0-1 0zm2 0a.5.5 0 1 0 1 0 .5.5 0 0 0-1 0zm12 0c0 1.93-1.57 3.5-3.5 3.5a3.503 3.503 0 0 1-3.46-3.002c-.007.001-.013.005-.021.005l-.506.017h-.017a.5.5 0 0 1-.016-.999l.506-.017c.018-.002.035.006.052.007A3.503 3.503 0 0 1 20.5 17c1.93 0 3.5 1.57 3.5 3.5zm-1 0c0-1.378-1.122-2.5-2.5-2.5S18 19.122 18 20.5s1.122 2.5 2.5 2.5 2.5-1.122 2.5-2.5z" },
  posthog: { color: "#1d4aff", d: "M9.854 14.5 5 9.647.854 5.5A.5.5 0 0 0 0 5.854V8.44a.5.5 0 0 0 .146.353L5 13.647l.147.146L9.854 18.5l.146.147v-.049c.065.03.134.049.207.049h2.586a.5.5 0 0 0 .353-.854L9.854 14.5zm0-5-4-4a.487.487 0 0 0-.409-.144.515.515 0 0 0-.356.21.493.493 0 0 0-.089.288V8.44a.5.5 0 0 0 .147.353l9 9a.5.5 0 0 0 .853-.354v-2.585a.5.5 0 0 0-.146-.354l-5-5zm1-4a.5.5 0 0 0-.854.354V8.44a.5.5 0 0 0 .147.353l4 4a.5.5 0 0 0 .853-.354V9.854a.5.5 0 0 0-.146-.354l-4-4zm12.647 11.515a3.863 3.863 0 0 1-2.232-1.1l-4.708-4.707a.5.5 0 0 0-.854.354v6.585a.5.5 0 0 0 .5.5H23.5a.5.5 0 0 0 .5-.5v-.6c0-.276-.225-.497-.499-.532zm-5.394.032a.8.8 0 1 1 0-1.6.8.8 0 0 1 0 1.6zM.854 15.5a.5.5 0 0 0-.854.354v2.293a.5.5 0 0 0 .5.5h2.293c.222 0 .39-.135.462-.309a.493.493 0 0 0-.109-.545L.854 15.501zM5 14.647.854 10.5a.5.5 0 0 0-.854.353v2.586a.5.5 0 0 0 .146.353L4.854 18.5l.146.147h2.793a.5.5 0 0 0 .353-.854L5 14.647z" },
} as const;

function logo(name: keyof typeof BRAND, size = 32): string {
  const b = BRAND[name];
  return `<span class="logo" style="background:${b.color};width:${size}px;height:${size}px"><svg viewBox="0 0 24 24" width="${Math.round(size * 0.56)}" height="${Math.round(size * 0.56)}" aria-hidden="true"><path fill="#fff" d="${b.d}"/></svg></span>`;
}

// ---------- small pieces ----------

export function timeAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "—";
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (Number.isNaN(s)) return "—";
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d < 30 ? `${d} d ago` : new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

const VERDICTS: Record<Verdict, [string, string]> = {
  checking: ["Checking…", "neutral"],
  "needs-info": ["Asked 1 question", "warn"],
  "out-of-scope": ["Needs a human", "neutral"],
  clear: ["Clear report", "info"],
  reproducing: ["Reproducing…", "info"],
  reproduced: ["Reproduced", "ok"],
  flaky: ["Flaky", "warn"],
  "not-reproduced": ["Not reproduced", "neutral"],
  inconclusive: ["Inconclusive", "neutral"],
  error: ["Error", "bad"],
};

export function verdictPill(v: Verdict): string {
  const [text, kind] = VERDICTS[v];
  return `<span class="pill nodot ${kind}">${text}</span>`;
}

function plural(n: number, w: string): string {
  return `${n} ${w}${n === 1 ? "" : "s"}`;
}

function sentryMatch(c: CheckRecord): string {
  if (!c.sentry) return `<span class="muted">No match</span>`;
  const meta = [plural(c.sentry.users, "user"), c.sentry.firstRelease ? `first seen in ${esc(c.sentry.firstRelease)}` : null].filter(Boolean).join(" · ");
  return `<div class="mono">${esc(c.sentry.title.slice(0, 70))}</div><div class="n">${meta}</div>`;
}

function issueTable(checks: CheckRecord[], showRepo: boolean, now: number): string {
  if (!checks.length) return `<div class="card empty">No issues checked yet. Open an issue in the repo and No Repro replies within seconds.</div>`;
  const rows = checks
    .map(
      (c) => `<tr>
  <td><div class="t"><a href="${esc(c.url)}">${esc(c.title)}</a></div><div class="n">${showRepo ? `<span class="mono">${esc(c.repo)}</span> ` : ""}#${c.number}</div></td>
  <td>${verdictPill(c.verdict)}</td>
  <td>${sentryMatch(c)}</td>
  <td class="muted">${timeAgo(c.openedAt, now)}</td>
</tr>`,
    )
    .join("");
  return `<table class="list"><thead><tr><th>Issue</th><th>Verdict</th><th>Sentry match</th><th>Opened</th></tr></thead><tbody>${rows}</tbody></table>`;
}

// ---------- pages ----------

export interface ProjectCard {
  project: Project;
  stats: ProjectStats;
}

/** First run, before the GitHub App exists. */
export function welcomePage(setupHref: string): string {
  return layout(
    "Set up No Repro",
    `<div class="head"><div><h1>Welcome to No Repro</h1><p class="lede">No repro, no ticket. No Repro checks every new GitHub issue for a clear report, points at the likely faulty code, replays the bug on your own GitHub Actions runner, and matches it to the real error in Sentry.</p></div></div>
<div class="card" style="max-width:560px">
  <h2>One-time setup</h2>
  <p class="muted">Register No Repro with GitHub. GitHub shows the app's settings, already filled in; you confirm, and you're ready to create your first project.</p>
  <a class="btn" href="${esc(setupHref)}">Set up No Repro on GitHub</a>
</div>`,
  );
}

export function projectsPage(cards: ProjectCard[], admin = true): string {
  // Busiest first, then newest: the projects people actually use sit at the top.
  const sorted = [...cards].sort(
    (a, b) => b.stats.checked - a.stats.checked || b.project.createdAt.localeCompare(a.project.createdAt),
  );
  const row = ({ project: p }: ProjectCard) =>
    `<a class="crow prow" href="/projects/${esc(p.id)}">${logo("github", 40)}
  <div class="cbody"><b>${esc(p.name)}</b><span class="mono">${esc(p.repo)}</span>${demoFor(p.repo) ? `<span>${esc(demoFor(p.repo)!.shows)}</span>` : ""}</div>
  <div class="cend">${p.paused ? `<span class="pill neutral">Paused</span>` : `<span class="pill ok">Active</span>`}<span class="chev" aria-hidden="true">›</span></div></a>`;
  return layout(
    "Projects · No Repro",
    `<div class="head">
  <div><h1>Projects</h1><p class="lede">${
    admin
      ? "One project per GitHub repo. No Repro checks every new issue in it."
      : "Live demo. Open a project and use <b>Try it</b> to file a sample bug report from your own GitHub account. No Repro replies on the issue in about 20 seconds."
  }</p></div>
  ${admin ? `<a class="btn" href="/projects/new">${ICON.plus} New project</a>` : ""}
</div>
${
  sorted.length
    ? `<div class="clist card" style="padding:0">${sorted.map(row).join("")}</div>`
    : `<div class="card empty"><b style="color:var(--ink)">No projects yet</b>${admin ? `<br>Pick a repo and No Repro starts checking its new issues.<br><br><a class="btn" href="/projects/new">${ICON.plus} New project</a>` : ""}</div>`
}`,
  );
}

export interface ProjectView {
  project: Project;
  checks: CheckRecord[];
  stats: ProjectStats;
  /** null = unknown (couldn't check) */
  reproductionEnabled: boolean | null;
  sentryConnectHref: string | null;
  /** May change settings. Visitors to a hosted demo get a read-only page. */
  admin?: boolean;
}

/** Example reports that open GitHub's new-issue form pre-filled. */
function tryIt(repo: string, demo: Demo): string {
  const rows = demo.examples
    .map(
      (ex) => `<div class="crow"><div class="cbody"><b>${esc(ex.title)}</b><span>${esc(ex.expect)}</span></div>
  <div class="cend"><a class="btn" href="${esc(newIssueHref(repo, ex))}" target="_blank" rel="noopener"><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="${BRAND.github.d}"/></svg> Open issue</a></div></div>`,
    )
    .join("");
  return `<div class="bar"><h2 class="eyebrow">Try it</h2><small class="muted">Opens GitHub with the report filled in. Submit it from your account.</small></div>
<div class="clist card tryit">${rows}</div>`;
}

const REPLY: Record<Verdict, string> = {
  checking: "No Repro is reading this report.",
  "needs-info": "Something essential was missing, so No Repro asked the reporter one question.",
  "out-of-scope": "This is a judgement call a browser can't check, so it was left to a human.",
  clear: "The report is clear, and the likely cause was found in the code.",
  reproducing: "The report is clear and is being replayed on the repo's own runner.",
  reproduced: "The bug was reproduced on the repo's own GitHub Actions runner.",
  flaky: "The bug showed in some runs but not all, so it may depend on timing.",
  "not-reproduced": "The app behaved as expected when the steps were replayed.",
  inconclusive: "The steps couldn't be completed, so this doesn't show whether the bug is real.",
  error: "No Repro hit an error while checking this issue.",
};

/** One issue, folded: title and verdict; open it to see what No Repro replied. */
function issueReply(c: CheckRecord, open: boolean, now: number): string {
  const meta = [`#${c.number}`, c.sentry ? "matched in Sentry" : null, timeAgo(c.openedAt, now)].filter(Boolean).join(" · ");
  const question = c.question ? `<p><span class="muted">Asked:</span> “${esc(c.question)}”</p>` : "";
  const trace = c.sentry
    ? `<pre class="trace">${esc(c.sentry.title)}${c.sentry.frames.map((f) => `\n  at ${esc(f.function ?? "<anonymous>")} (${esc(f.file.split("/").slice(-2).join("/"))}${f.line ? `:${f.line}` : ""})`).join("")}</pre>`
    : "";
  const cause = c.cause ? `<p><span class="muted">Likely cause:</span> <span class="mono">${esc(c.cause.path)}:${c.cause.startLine}${c.cause.endLine !== c.cause.startLine ? `–${c.cause.endLine}` : ""}</span> — ${esc(c.cause.reason.split(/(?<=\.)\s/)[0] ?? "")}</p>` : "";
  const introduced = c.introducedIn ? `<p><span class="muted">Introduced in:</span> <span class="mono">${esc(c.introducedIn.sha.slice(0, 7))}</span> “${esc(c.introducedIn.message)}”</p>` : "";
  const before = c.sentry?.breadcrumbs.length ? `<p class="muted small">Before the error: ${c.sentry.breadcrumbs.map(esc).join(" → ")}</p>` : "";
  const evidence = c.sentry
    ? `<p class="muted small">${plural(c.sentry.users, "user")} · ${plural(c.sentry.events, "event")}${c.sentry.firstRelease ? ` · first seen in <span class="mono">${esc(c.sentry.firstRelease)}</span>` : ""}</p>`
    : "";
  const links = [`<a href="${esc(c.url)}">Open on GitHub</a>`, c.sentry ? `<a href="${esc(c.sentry.permalink)}">Open in Sentry</a>` : null].filter(Boolean).join(" · ");
  return `<details class="issue"${open ? " open" : ""}>
  <summary><div class="cbody"><b>${esc(c.title)}</b><span>${meta}</span></div><div class="cend">${verdictPill(c.verdict)}</div></summary>
  <div class="reply"><p class="eyebrow">No Repro replied</p><p>${REPLY[c.verdict]}</p>${question}${trace}${cause}${introduced}${before}${evidence}<p class="small">${links}</p></div>
</details>`;
}

export function projectPage(v: ProjectView, now = Date.now()): string {
  const p = v.project;
  const admin = v.admin ?? true;
  const demo = demoFor(p.repo);
  const repoUrl = `https://github.com/${esc(p.repo)}`;
  const reproOn = p.reproduce !== false;
  const post = (path: string, label: string, cls = "btn ghost") =>
    `<form class="inline" method="post" action="/projects/${esc(p.id)}/${path}"><button class="${cls}" type="submit">${label}</button></form>`;

  const sentryRow = p.sentry
    ? `<div class="crow">${logo("sentry")}<div class="cbody"><b>Sentry</b><span class="mono">${esc(p.sentry.org)}/${esc(p.sentry.project)}${p.sentry.environment ? ` · ${esc(p.sentry.environment)}` : ""}</span></div>
       <div class="cend">${admin ? `<a class="small" href="/projects/${esc(p.id)}/sentry">Manage</a>` : `<span class="pill ok">Connected</span>`}</div></div>`
    : `<div class="crow">${logo("sentry")}<div class="cbody"><b>Sentry</b><span>Match issues to production errors</span></div>
       <div class="cend">${admin ? `<a class="btn" href="/projects/${esc(p.id)}/sentry">Connect</a>` : `<span class="pill neutral nodot">Not connected</span>`}</div></div>`;
  const reproRow =
    v.reproductionEnabled === false
      ? `<div class="crow">${logo("actions")}<div class="cbody"><b>Reproduction</b><span>Add the workflow to your repo</span></div>
         <div class="cend"><a class="btn ghost" href="${repoUrl}/actions">Set up</a></div></div>`
      : !admin
        ? `<div class="crow">${logo("actions")}<div class="cbody"><b>Reproduction</b><span>On GitHub Actions</span></div>
         <div class="cend">${reproOn ? `<span class="pill ok">On</span>` : `<span class="pill neutral">Off</span>`}</div></div>`
      : `<div class="crow">${logo("actions")}<div class="cbody"><b>Reproduction</b><span>On GitHub Actions</span></div>
         <div class="cend"><form class="inline" method="post" action="/projects/${esc(p.id)}/reproduction/${reproOn ? "off" : "on"}">
           <button class="toggle" type="submit" role="switch" aria-checked="${reproOn}" aria-label="Reproduction ${reproOn ? "on" : "off"}"><span></span></button></form></div></div>`;

  const dialog = `<dialog id="add-connector" class="sheet" aria-labelledby="add-title">
  <form method="dialog" class="sheet-head"><h2 id="add-title">Add connector</h2><button class="btn link" aria-label="Close">Close</button></form>
  <p class="muted">Optional. Each connector brings more context into every check.</p>
  <div class="clist">
    <div class="crow">${logo("sentry", 40)}<div class="cbody"><b>Sentry</b><span>Stack traces, affected users and the release an error first appeared in.</span></div>
      <div class="cend">${p.sentry ? `<span class="pill ok">Connected</span>` : `<a class="btn" href="/projects/${esc(p.id)}/sentry">Connect</a>`}</div></div>
    <div class="crow">${logo("actions", 40)}<div class="cbody"><b>Reproduction</b><span>Replay bugs on the repo's own GitHub Actions runner.</span></div>
      <div class="cend">${v.reproductionEnabled === false ? `<a class="btn ghost" href="${repoUrl}/actions">Set up</a>` : `<span class="pill ok">Added</span>`}</div></div>
    <div class="crow off"><div class="iconbox">${ICON.replay}</div><div class="cbody"><b>LogRocket</b><span>Session replays of what the user saw.</span></div><div class="cend"><span class="pill neutral nodot">Coming soon</span></div></div>
    <div class="crow off">${logo("posthog", 40)}<div class="cbody"><b>PostHog</b><span>Session recordings and product events.</span></div><div class="cend"><span class="pill neutral nodot">Coming soon</span></div></div>
  </div>
</dialog>`;

  const issues = v.checks.length
    ? `<div class="clist card">${v.checks.slice(0, 20).map((c, i) => issueReply(c, i === 0, now)).join("")}</div>`
    : `<div class="card empty"><b style="color:var(--ink)">Nothing yet</b><br>${demo ? "Use Try it above to file the first report." : "Open an issue in the repo and No Repro replies within seconds."}</div>`;

  return layout(
    `${p.name} · No Repro`,
    `<div class="crumbs"><a href="/">← Projects</a></div>
<div class="head" style="margin-bottom:8px">
  <h1 class="${p.paused ? "" : "live-title"}">${esc(p.name)}</h1>
  ${admin ? post(p.paused ? "resume" : "pause", p.paused ? "Resume" : "Pause") : ""}
</div>
<div class="meta">${p.paused ? `<span class="pill neutral">Paused</span><span class="sep">·</span>` : ""}<a class="mono" href="${repoUrl}">github.com/${esc(p.repo)} ↗</a></div>

<div class="pgrid">
  <section>
    ${demo ? `<p class="lede" style="margin:0 0 18px">${esc(demo.shows)}</p>${tryIt(p.repo, demo)}<div style="height:28px"></div>` : ""}
    <div class="bar"><h2 class="eyebrow">New issues</h2><small class="muted">${v.stats.checked} checked · ${v.stats.reproduced} reproduced · ${v.stats.matchedInSentry} matched</small></div>
    ${issues}
  </section>
  <aside>
    <div class="bar"><h2 class="eyebrow">Connectors</h2></div>
    <div class="clist card side">${sentryRow}${reproRow}
      ${admin ? `<button class="crow addrow" type="button" onclick="document.getElementById('add-connector').showModal()">+ Add connector</button>` : ""}</div>
    <div class="bar" style="margin-top:28px"><h2 class="eyebrow">Settings</h2></div>
    <div class="clist card side">
      <div class="crow"><div class="cbody"><b>Status</b><span>${p.paused ? "Paused" : "Checking new issues"}</span></div></div>
      <div class="crow"><div class="cbody"><b>Watches</b><span>New issues and replies</span></div></div>
      <div class="crow">${logo("actions", 28)}<div class="cbody"><b>Runner</b><span>Your repo's GitHub Actions</span></div><div class="cend"><a class="small" href="${repoUrl}/actions">Open</a></div></div>
      ${p.sentry && admin ? `<div class="crow"><div class="cbody"><b>Sentry link</b><span>Stop matching this repo</span></div><div class="cend">${post("sentry/disconnect", "Disconnect", "btn link danger-text")}</div></div>` : ""}
    </div>
  </aside>
</div>
${admin ? dialog : ""}`,
  );
}

export function signInPage(error: string | null): string {
  return layout(
    "Sign in · No Repro",
    `<div class="card" style="max-width:420px;margin:40px auto">
  <h1 style="font-size:1.5rem">Admin sign-in</h1>
  <p class="muted">Only needed to change projects. Everything else is open to view.</p>
  ${error ? `<p class="notice bad">${esc(error)}</p>` : ""}
  <form method="post" action="/admin">
    <label class="f" for="pw">Password</label>
    <input id="pw" name="password" type="password" autocomplete="current-password" required style="width:100%;font:inherit;padding:11px 12px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--ink)">
    <div class="actions"><a href="/">Cancel</a><button class="btn" type="submit">Sign in</button></div>
  </form>
</div>`,
    null,
  );
}

export function activityPage(checks: CheckRecord[], now = Date.now()): string {
  return layout(
    "Activity · No Repro",
    `<div class="head"><div><h1>Activity</h1><p class="lede">Every issue No Repro checked, across all projects, newest first.</p></div></div>
${issueTable(checks, true, now)}`,
    "activity",
  );
}

export function howItWorksPage(): string {
  const step = (n: string, t: string, d: string) => `<div class="card"><p class="eyebrow mono">${n}</p><h2>${t}</h2><p class="muted">${d}</p></div>`;
  return layout(
    "How it works · No Repro",
    `<div class="head"><div><h1>How it works</h1><p class="lede">No repro, no ticket. Every new issue goes through the same steps, and each one only uses what the repo owner connected.</p></div></div>
<div class="grid">
  ${step("01", "Is the report clear?", "The model pulls out where it happened, the steps, and what was expected versus what happened. Plain code decides: anything essential missing means one specific question to the reporter.")}
  ${step("02", "Match the production error", "With Sentry linked, the issue is matched to the real error: stack trace, what the user did just before, how many people hit it, and the release it first appeared in.")}
  ${step("03", "Find the likely cause", "No Repro reads the repo's code, always including the files in the stack trace, and points at the lines and the commit that last changed them.")}
  ${step("04", "Reproduce on your runner", "A plan of browser steps and one check is sent to the repo's own GitHub Actions runner, which starts the app with its own secrets and replays it 3 times. Plain code decides the verdict.")}
  ${step("05", "Find the commit that broke it", "For a confirmed bug, git bisect on the same runner, from a known-good release to the exact commit, with its diff.")}
  ${step("06", "One clear comment", "Verdict, run results, likely cause, the commit, and links to the code, the run and Sentry, in one comment a maintainer can read in under 30 seconds.")}
</div>`,
    "how",
  );
}

// ---------- new project: just pick a repo ----------

export interface NewProjectView {
  repos: string[] | null;
  /** Repos already in a project (lowercase). */
  takenRepos: string[];
  installHref: string;
  error: string | null;
}

const NEXT_STEPS = `<aside class="card"><p class="eyebrow">What happens next</p><ol class="next">
  <li>Someone opens an issue on the repo.</li>
  <li>No Repro checks whether it has steps, expected and actual behavior.</li>
  <li>It points at the likely faulty code, and replays the bug on the repo's own runner if that's set up.</li>
  <li>It comments with the evidence, or asks one question if the report is unclear.</li></ol>
  <p class="muted small" style="margin:6px 0 0">Optional: link a Sentry project afterwards to match issues to real production errors.</p></aside>`;

export function newProjectPage(w: NewProjectView): string {
  const repos = w.repos ?? [];
  const free = repos.filter((r) => !w.takenRepos.includes(r.toLowerCase()));
  const options = repos.length
    ? repos
        .map((r) => {
          const taken = w.takenRepos.includes(r.toLowerCase());
          return `<label class="choice"><input type="radio" name="repo" value="${esc(r)}"${r === free[0] ? " checked" : ""}${taken ? " disabled" : ""} required><span class="mono">${esc(r)}</span>${taken ? `<span class="hint muted">already a project</span>` : ""}</label>`;
        })
        .join("")
    : `<p class="muted">${w.repos === null ? "Couldn't load your repos from GitHub right now." : "No Repro doesn't have access to any repos yet."}</p>`;
  return layout(
    "New project · No Repro",
    `<div class="head"><div><h1>New project</h1><p class="lede">Pick the GitHub repo to watch. The project is named after it, and you can link Sentry later.</p></div><a class="btn link" href="/">Cancel</a></div>
<div class="wizard"><div>${w.error ? `<div class="notice bad">${esc(w.error)}</div>` : ""}
<form class="card" method="post" action="/projects">
  <h2>Connect a repo</h2><p class="muted">New issues in this repo get checked. Don't see it? Give No Repro access to it on GitHub.</p>
  ${options}
  <div class="actions"><a class="btn ghost" href="${esc(w.installHref)}">${ICON.github} Add a repo on GitHub</a><button class="btn" type="submit"${free.length ? "" : " disabled"}>Create project</button></div>
</form></div>
${NEXT_STEPS}</div>`,
  );
}

/** "repro-test", or "repro-test-2" if that name is taken. */
export function uniqueName(base: string, taken: string[]): string {
  const lower = taken.map((t) => t.toLowerCase());
  let name = base;
  for (let i = 2; lower.includes(name.toLowerCase()); i++) name = `${base}-${i}`;
  return name;
}

/** The Sentry project whose name best matches the repo name ("repro_test" ↔ "repro-test"). */
export function suggestProject(repo: string, projects: Array<{ slug: string; name: string }>): string | null {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const name = norm(repo.split("/").pop() ?? "");
  return projects.find((p) => norm(p.slug) === name || norm(p.name) === name)?.slug ?? null;
}

// ---------- optional: link a Sentry project ----------

export interface SentryLinkView {
  project: Project;
  orgs: string[];
  org: string;
  projects: Array<{ slug: string; name: string }> | null;
  selected: string;
  environments: string[];
  env: string;
  connectHref: string | null;
  error: string | null;
}

export function sentryLinkPage(v: SentryLinkView): string {
  const p = v.project;
  let body: string;
  if (!v.orgs.length) {
    body = `<div class="card"><h2>Connect Sentry first</h2><p class="muted">No Sentry organization is connected to No Repro yet. Connect one, then come back to pick its project.</p>
  ${v.connectHref ? `<a class="btn" href="${esc(v.connectHref)}">Connect Sentry</a>` : `<p class="muted">The person running No Repro hasn't set up the Sentry integration on this server.</p>`}</div>`;
  } else {
    const suggested = v.projects ? suggestProject(p.repo, v.projects) : null;
    const list = v.projects?.length
      ? v.projects
          .map(
            (s) =>
              `<label class="choice"><input type="radio" name="sproject" value="${esc(s.slug)}"${s.slug === v.selected ? " checked" : ""} required><span class="mono">${esc(s.slug)}</span>${s.slug === suggested ? `<span class="hint">Suggested · name matches repo</span>` : ""}</label>`,
          )
          .join("")
      : `<p class="muted">This organization has no projects.</p>`;
    const envs = v.environments.length
      ? `<label class="f" for="env">Environment</label><select id="env" name="env"><option value="">All environments</option>${v.environments
          .map((e) => `<option${e === v.env ? " selected" : ""}>${esc(e)}</option>`)
          .join("")}</select>`
      : "";
    body = `<form class="card" method="get" action="/projects/${esc(p.id)}/sentry" id="pick"><label class="f" for="org" style="margin-top:0">Organization</label>
  <div class="row" style="flex-wrap:nowrap"><select id="org" name="org" onchange="this.form.submit()">${v.orgs.map((o) => `<option${o === v.org ? " selected" : ""}>${esc(o)}</option>`).join("")}</select>
  ${v.connectHref ? `<a class="btn ghost" href="${esc(v.connectHref)}" style="white-space:nowrap">Connect another org</a>` : ""}</div></form>
<form class="card" method="post" action="/projects/${esc(p.id)}/sentry" style="margin-top:12px"><input type="hidden" name="org" value="${esc(v.org)}">
  <label class="f" style="margin-top:0">Project</label>${list}${envs}
  <div class="actions"><a class="btn link" href="/projects/${esc(p.id)}">Cancel</a><button class="btn" type="submit"${v.projects?.length ? "" : " disabled"}>Link Sentry project</button></div></form>`;
  }
  return layout(
    `Link Sentry · ${p.name} · No Repro`,
    `<div class="crumbs"><a href="/">Projects</a> / <a href="/projects/${esc(p.id)}">${esc(p.name)}</a> / Sentry</div>
<div class="head"><div><h1>Link a Sentry project</h1><p class="lede">Optional. No Repro then matches each issue in <span class="mono">${esc(p.repo)}</span> to the real production error: stack trace, what the user did before it, how many people hit it, and the release it first appeared in.</p></div></div>
<div class="wizard"><div>${v.error ? `<div class="notice bad">${esc(v.error)}</div>` : ""}${body}</div>
<aside class="card"><p class="eyebrow">What Sentry adds</p><ol class="next"><li>Fills in what the reporter left out.</li><li>Points straight at the line that threw.</li><li>Follows the real user's steps when replaying.</li><li>Starts bisect from the release before the error first appeared.</li></ol></aside></div>`,
  );
}

// ---------- system pages ----------

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

export function messagePage(title: string, message: string): string {
  return layout(title, `<div class="card" style="max-width:560px"><h2>${esc(title)}</h2><p class="muted">${esc(message)}</p><a class="btn ghost" href="/">Back to projects</a></div>`, null);
}
