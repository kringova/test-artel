#!/usr/bin/env node
// Локальный дашборд Артель. Без зависимостей: читает markdown-vault и отдаёт веб-страницу.
// Запуск из корня vault:  node dashboard/serve.js  [--port 4321] [--root PATH] [--open]
// Страницы: /  (Проекты)  /kanban  /rice  /inbox — навигация как на «продовом» дашборде.

import { createServer } from "node:http";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const portArg = args.indexOf("--port");
const PORT = portArg !== -1 ? Number(args[portArg + 1]) : 4321;
const rootArg = args.indexOf("--root");
const ROOT = rootArg !== -1 ? resolve(args[rootArg + 1]) : resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OPEN = args.includes("--open");

// ── Парсер YAML-frontmatter (плоский, под наши поля) ──
function parseFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return { data: {}, body: text };
  const data = {};
  for (const line of m[1].split("\n")) {
    const mm = line.match(/^([A-Za-z_][\w]*):\s*(.*)$/);
    if (!mm) continue;
    let [, key, val] = mm;
    val = val.trim();
    if (val === "") { data[key] = ""; continue; }
    if (val.startsWith("[") && val.endsWith("]")) {
      data[key] = val.slice(1, -1).split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
      continue;
    }
    val = val.replace(/^["']|["']$/g, "");
    const num = Number(val);
    data[key] = val !== "" && !Number.isNaN(num) && /^-?\d+(\.\d+)?$/.test(val) ? num : val;
  }
  return { data, body: text.slice(m[0].length) };
}

// RICE = (reach × impact × confidence%) / effort; для done/cancelled — null
const rice = (t) => {
  if (t.status === "done" || t.status === "cancelled") return null;
  const { rice_reach: r, rice_impact: i, rice_confidence: c, rice_effort: e } = t;
  if (![r, i, c, e].every((x) => typeof x === "number") || !e) return null;
  return (r * i * (c / 100)) / e;
};

// ── Сканер vault ──
function scan() {
  const projectsDir = join(ROOT, "projects");
  const projects = [];
  const tasks = [];
  if (existsSync(projectsDir)) {
    for (const slug of readdirSync(projectsDir)) {
      const pdir = join(projectsDir, slug);
      if (!statSync(pdir).isDirectory()) continue;
      const card = join(pdir, `${slug}.md`);
      if (existsSync(card)) {
        const { data } = parseFrontmatter(readFileSync(card, "utf8"));
        if ((data.tags || []).includes("project")) projects.push({ ...data, slug });
      }
      const tdir = join(pdir, "tasks");
      if (existsSync(tdir)) {
        for (const f of readdirSync(tdir)) {
          if (!f.endsWith(".md") || f === "tasks.md") continue;
          const { data } = parseFrontmatter(readFileSync(join(tdir, f), "utf8"));
          if (!(data.tags || []).includes("task")) continue;
          // имя папки — источник правды для проекта (frontmatter project — wiki-ссылка)
          tasks.push({ ...data, project: slug, file: f.replace(/\.md$/, ""), _rice: rice(data) });
        }
      }
    }
  }
  const inbox = [];
  const idir = join(ROOT, "_inbox");
  if (existsSync(idir)) {
    for (const f of readdirSync(idir)) {
      if (!f.endsWith(".md")) continue;
      const { data, body } = parseFrontmatter(readFileSync(join(idir, f), "utf8"));
      inbox.push({ file: f, created: data.created || "", project: data.project || "", text: body.trim() });
    }
  }
  return { projects, tasks, inbox };
}

// ── Хелперы рендера ──
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const cleanWiki = (s) => String(s ?? "").replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2").replace(/\[\[([^\]]+)\]\]/g, (_m, p) => p.split("/").pop());
const sumtext = (t) => esc(cleanWiki(t.summary || t.file));
const fmtRice = (v) => (v == null ? "—" : v.toFixed(1));
const ticket = (id) => (id != null && id !== "" ? `#${esc(id)}` : "");
const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };
const STATUS_LABEL = { todo: "Todo", doing: "В работе", done: "Готово", blocked: "Блок", cancelled: "Отменено", idea: "Идея", active: "Активен", paused: "Пауза" };
const PRIORITY_LABEL = { high: "Высокий", medium: "Средний", low: "Низкий" };
const isOpen = (t) => t.status === "todo" || t.status === "doing" || t.status === "blocked";

function progressColor(pct) {
  if (pct === 0) return "#d4d4d4";
  if (pct < 34) return "#fb7185";
  if (pct < 67) return "#fbbf24";
  if (pct < 100) return "#84cc16";
  return "#10b981";
}

function projectCard(p, tasks) {
  const pt = tasks.filter((t) => t.project === p.slug);
  const done = pt.filter((t) => t.status === "done").length;
  const considered = pt.filter((t) => t.status !== "cancelled").length;
  const open = pt.filter(isOpen).length;
  const pct = considered ? Math.round((done / considered) * 100) : 0;
  const top = pt.filter(isOpen).sort((a, b) => (b._rice ?? -1) - (a._rice ?? -1))[0];
  return `<div class="card">
    <div class="card-h">
      <span class="card-name">${esc(p.slug)}</span>
      <span class="badge s-${esc(p.status)}">${esc(STATUS_LABEL[p.status] || p.status || "")}</span>
    </div>
    <div class="chips">
      <span class="badge pri-${esc(p.priority)}">${esc(PRIORITY_LABEL[p.priority] || p.priority || "")}</span>
      ${p.type ? `<span class="badge b-soft">${esc(p.type)}</span>` : ""}
    </div>
    ${p.audience ? `<p class="card-aud">${esc(p.audience)}</p>` : ""}
    <div class="card-top">${top ? `<span class="ct-sum"><span class="muted">Топ:</span> ${sumtext(top)}</span><span class="rice">${fmtRice(top._rice)}</span>` : `<span class="muted">нет открытых задач</span>`}</div>
    <div class="prog">
      <div class="prog-meta"><span>${done}/${considered} готово · ${open} открытых</span><span class="prog-pct">${pct}%</span></div>
      <div class="prog-track"><div class="prog-fill" style="width:${Math.max(pct, 2)}%;background:${progressColor(pct)}"></div></div>
    </div>
    ${p.updated ? `<div class="card-upd">обновлён ${esc(p.updated)}</div>` : ""}
  </div>`;
}

function taskCard(t) {
  return `<div class="kc">
    <div class="kc-top"><span class="kc-id">${ticket(t.id)}</span>${t._rice != null ? `<span class="rice">${fmtRice(t._rice)}</span>` : ""}</div>
    <div class="kc-sum">${sumtext(t)}</div>
    <div class="kc-foot"><span class="badge b-soft">${esc(t.project)}</span>${(t.tags || []).includes("bug") ? `<span class="badge s-blocked">bug</span>` : ""}</div>
  </div>`;
}

// ── Контент страниц ──
function projectsPage({ projects, tasks }) {
  const active = projects.filter((p) => p.status === "active");
  const otherRank = (s) => (s === "done" ? 2 : s === "idea" ? 1 : 0);
  const others = projects.filter((p) => p.status !== "active").sort((a, b) => otherRank(a.status) - otherRank(b.status));
  const section = (title, count, dot, cards) => `<section class="block">
    <h2 class="sec-h"><span class="dot" style="background:${dot}"></span>${title} · ${count}</h2>
    <div class="grid">${cards}</div>
  </section>`;
  return (
    (active.length ? section("Активные", active.length, "#10b981", active.map((p) => projectCard(p, tasks)).join("")) : "") +
    (others.length ? section("Остальные <span class='sub'>готовы · пауза · идеи</span>", others.length, "#d4d4d4", others.map((p) => projectCard(p, tasks)).join("")) : "") ||
    '<p class="empty-box">Проектов пока нет — заведите первый.</p>'
  );
}

function kanbanPage({ tasks }) {
  const open = tasks.filter(isOpen);
  const byRice = [...open].sort((a, b) => (b._rice ?? -1) - (a._rice ?? -1));
  const todo = byRice.filter((t) => t.status === "todo" || t.status === "blocked");
  const doing = open.filter((t) => t.status === "doing");
  const allDone = tasks.filter((t) => t.status === "done").sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
  const doneShown = allDone.slice(0, 15);
  const col = (title, list, bg, fg, total, extra = "") => `<div class="kcol">
    <div class="kcol-h"><span class="kpill" style="background:${bg};color:${fg}">${title}</span><span class="kcount">${total ?? list.length}</span></div>
    ${list.map(taskCard).join("") || '<div class="kempty">пусто</div>'}${extra}
  </div>`;
  return `<div class="kanban">
    ${col("Todo", todo, "#f1f5f9", "#475569")}
    ${col("В работе", doing, "#eff6ff", "#1d4ed8")}
    ${col("Готово", doneShown, "#ecfdf5", "#047857", allDone.length, allDone.length > doneShown.length ? `<div class="kmore">+ ещё ${allDone.length - doneShown.length} (показаны 15 свежих)</div>` : "")}
  </div>`;
}

function ricePage({ tasks }) {
  const byRice = tasks.filter(isOpen).sort((a, b) => (b._rice ?? -1) - (a._rice ?? -1));
  const max = byRice[0]?._rice || 1;
  const rows = byRice.slice(0, 60).map((t) => `<tr>
      <td class="kc-id-cell">${ticket(t.id)}</td>
      <td class="tname">${sumtext(t)}</td>
      <td class="muted">${esc(t.project)}</td>
      <td class="ricecell">
        <span class="rice-bar"><span style="width:${Math.round(((t._rice ?? 0) / max) * 100)}%"></span></span>
        <span class="rice">${fmtRice(t._rice)}</span>
      </td>
    </tr>`).join("");
  return `<table><thead><tr><th>#</th><th>Задача</th><th>Проект</th><th style="text-align:right">RICE</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="4" class="muted">Открытых задач нет.</td></tr>'}</tbody></table>`;
}

function inboxPage({ inbox }) {
  if (!inbox.length) return '<p class="empty-box">Инбокс пуст</p>';
  return `<div class="inbox">${inbox.map((e) => `<div class="ie"><p class="ie-text">${esc(e.text)}</p><div class="ie-meta">${e.project ? `<span class="badge b-soft">${esc(e.project)}</span>` : ""}<span>${esc(e.created.slice(0, 16).replace("T", " "))}</span></div></div>`).join("")}</div>
    <p class="hint">Разобрать: скажите агенту «разбери инбокс» (навык inbox).</p>`;
}

const PAGES = {
  projects: { title: "Проекты", build: projectsPage },
  kanban: { title: "Канбан", build: kanbanPage },
  rice: { title: "RICE-приоритеты", build: ricePage },
  inbox: { title: "Инбокс", build: inboxPage },
};

function render(data, page) {
  const { projects, tasks, inbox } = data;
  projects.sort((a, b) => (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9) || String(b.updated).localeCompare(String(a.updated)));
  const open = tasks.filter(isOpen);
  const def = PAGES[page] || PAGES.projects;
  const subtitle =
    page === "kanban" ? `${open.length} открытых · ${tasks.filter((t) => t.status === "done").length} готово`
    : page === "rice" ? "открытые задачи по убыванию RICE"
    : page === "inbox" ? `${inbox.length} записей на разбор`
    : `${projects.length} проектов · ${open.length} открытых задач`;

  const link = (href, label, key) => `<a class="link${page === key ? " active" : ""}" href="${href}">${label}</a>`;

  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Артель — ${esc(def.title)}</title>
<style>
  :root { --accent:#ef6b5b; --ink:#262626; --muted:#737373; --line:#e5e5e5; --bg:#fafafa; }
  * { box-sizing:border-box; }
  html,body { overflow-x:hidden; }
  body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.5 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; -webkit-font-smoothing:antialiased; }
  a { color:inherit; text-decoration:none; }
  .nav { position:sticky; top:0; z-index:50; background:rgba(255,255,255,.95); backdrop-filter:blur(6px); border-bottom:1px solid var(--line); }
  .nav-in { max-width:1120px; margin:0 auto; display:flex; align-items:center; gap:14px; padding:12px 20px; }
  .logo { display:flex; align-items:center; gap:8px; font-weight:600; margin-right:6px; }
  .logo i { display:grid; place-items:center; width:24px; height:24px; border-radius:7px; background:var(--accent); color:#fff; font-style:normal; font-size:11px; font-weight:800; }
  .link { color:var(--muted); font-size:14px; padding:6px 11px; border-radius:8px; }
  .link:hover { background:#f5f5f5; color:var(--ink); }
  .link.active { background:#f5f5f5; color:var(--ink); font-weight:500; }
  .wrap { max-width:1120px; margin:0 auto; padding:24px 20px 70px; }
  h1 { font-size:24px; margin:0; letter-spacing:-.01em; }
  .stats { color:var(--muted); font-size:14px; margin-top:4px; }
  .block { margin-top:26px; }
  .sec-h { display:flex; align-items:center; gap:8px; font-size:12px; text-transform:uppercase; letter-spacing:.04em; color:#a3a3a3; font-weight:600; margin:0 0 12px; }
  .sec-h .sub { font-weight:400; text-transform:none; letter-spacing:0; color:#d4d4d4; }
  .dot { width:8px; height:8px; border-radius:50%; flex:none; }
  .grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:16px; }
  .card { display:flex; flex-direction:column; min-width:0; background:#fff; border:1px solid var(--line); border-radius:14px; box-shadow:0 1px 2px rgba(0,0,0,.04); padding:16px; }
  .card-h { display:flex; align-items:flex-start; justify-content:space-between; gap:8px; min-width:0; }
  .card-name { font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .chips { display:flex; flex-wrap:wrap; gap:6px; margin-top:8px; }
  .card-aud { margin:12px 0 0; font-size:14px; color:var(--muted); display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
  .card-top { margin-top:14px; padding-top:12px; border-top:1px solid #f5f5f5; font-size:14px; display:flex; align-items:center; justify-content:space-between; gap:8px; min-width:0; }
  .ct-sum { flex:1; min-width:0; color:#525252; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .prog { margin-top:14px; }
  .prog-meta { display:flex; justify-content:space-between; font-size:12px; color:#a3a3a3; margin-bottom:5px; }
  .prog-pct { font-weight:500; color:var(--muted); }
  .prog-track { height:6px; border-radius:999px; background:#f5f5f5; overflow:hidden; }
  .prog-fill { height:100%; border-radius:999px; }
  .card-upd { margin-top:8px; text-align:right; font-size:12px; color:#a3a3a3; }
  .badge { display:inline-flex; align-items:center; font-size:11px; font-weight:500; padding:2px 9px; border-radius:999px; line-height:1.5; white-space:nowrap; }
  .b-soft { background:#f5f5f5; color:var(--muted); }
  .rice { font-variant-numeric:tabular-nums; font-weight:600; color:var(--accent); font-size:13px; flex:none; }
  .muted { color:var(--muted); }
  .s-todo,.s-cancelled { background:#f1f5f9; color:#475569; } .s-doing { background:#eff6ff; color:#1d4ed8; }
  .s-done,.s-active { background:#ecfdf5; color:#047857; } .s-blocked { background:#fff1f2; color:#be123c; }
  .s-idea { background:#fffbeb; color:#b45309; } .s-paused { background:#f5f5f5; color:#737373; }
  .pri-high { background:#fff1f2; color:#be123c; } .pri-medium { background:#fffbeb; color:#b45309; } .pri-low { background:#f5f5f5; color:#737373; }
  .kanban { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:16px; margin-top:22px; }
  .kcol { background:rgba(245,245,245,.55); border:1px solid var(--line); border-radius:14px; padding:12px; min-width:0; }
  .kcol-h { display:flex; align-items:center; gap:8px; margin-bottom:10px; }
  .kpill { font-size:11px; font-weight:500; padding:2px 9px; border-radius:999px; }
  .kcount { color:#a3a3a3; font-size:12px; }
  .kc { background:#fff; border:1px solid var(--line); border-radius:10px; box-shadow:0 1px 2px rgba(0,0,0,.04); padding:10px 11px; margin-bottom:8px; min-width:0; }
  .kc-top { display:flex; align-items:center; justify-content:space-between; gap:6px; }
  .kc-id { font-family:ui-monospace,monospace; font-size:11px; color:#a3a3a3; }
  .kc-sum { font-size:14px; font-weight:500; color:#262626; margin-top:3px; overflow-wrap:anywhere; }
  .kc-foot { display:flex; flex-wrap:wrap; gap:6px; margin-top:8px; }
  .kempty { color:#c2c8d0; font-size:12px; text-align:center; padding:14px 0; }
  .kmore { color:#a3a3a3; font-size:12px; text-align:center; padding:6px 0 2px; }
  table { width:100%; border-collapse:collapse; background:#fff; border:1px solid var(--line); border-radius:14px; overflow:hidden; margin-top:22px; table-layout:fixed; }
  th { text-align:left; font-size:11px; text-transform:uppercase; letter-spacing:.03em; color:#a3a3a3; font-weight:500; padding:10px 14px; background:#fafafa; border-bottom:1px solid var(--line); }
  td { padding:10px 14px; border-bottom:1px solid #f5f5f5; vertical-align:middle; overflow:hidden; text-overflow:ellipsis; }
  tr:last-child td { border-bottom:0; }
  .kc-id-cell { font-family:ui-monospace,monospace; font-size:11px; color:#a3a3a3; width:56px; }
  .tname { font-weight:500; white-space:nowrap; }
  .ricecell { display:flex; align-items:center; justify-content:flex-end; gap:8px; width:150px; }
  .rice-bar { height:6px; width:64px; border-radius:999px; background:#f5f5f5; overflow:hidden; flex:none; }
  .rice-bar span { display:block; height:100%; background:var(--accent); border-radius:999px; }
  .inbox { display:grid; gap:8px; max-width:680px; margin-top:22px; }
  .ie { background:#fff; border:1px solid var(--line); border-radius:10px; padding:11px 13px; }
  .ie-text { margin:0; font-size:14px; white-space:pre-wrap; }
  .ie-meta { display:flex; align-items:center; gap:8px; margin-top:8px; font-size:12px; color:#a3a3a3; }
  .empty-box { border:1px dashed var(--line); border-radius:14px; padding:30px; text-align:center; color:#a3a3a3; font-size:14px; margin-top:22px; }
  .hint { color:#a3a3a3; font-size:12px; margin:14px 0 0; }
  @media (max-width:880px){ .grid,.kanban{grid-template-columns:1fr 1fr} }
  @media (max-width:580px){ .grid,.kanban{grid-template-columns:1fr} .link{padding:6px 8px} }
</style></head><body>
<nav class="nav"><div class="nav-in">
  <a class="logo" href="/"><i>ll</i> Артель</a>
  ${link("/", "Проекты", "projects")}
  ${link("/kanban", "Канбан", "kanban")}
  ${link("/rice", "RICE", "rice")}
  ${link("/inbox", "Инбокс", "inbox")}
</div></nav>
<div class="wrap">
  <h1>${esc(def.title)}</h1>
  <p class="stats">${subtitle}</p>
  ${def.build(data)}
  <p class="hint">Обновляется автоматически каждые 5 c. Данные читаются из markdown при каждом запросе.</p>
</div>
<script>setTimeout(()=>location.reload(),5000)</script>
</body></html>`;
}

// ── Сервер ──
const server = createServer((req, res) => {
  try {
    const path = (req.url || "/").split("?")[0].replace(/\/+$/, "") || "/";
    const page = path === "/kanban" ? "kanban" : path === "/rice" ? "rice" : path === "/inbox" ? "inbox" : "projects";
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(render(scan(), page));
  } catch (e) {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Ошибка чтения vault: " + e.message);
  }
});

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\n  Артель дашборд → ${url}\n  vault: ${ROOT}\n  Ctrl+C для остановки\n`);
  if (OPEN) {
    const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    spawn(cmd, [url], { stdio: "ignore", detached: true, shell: process.platform === "win32" }).unref();
  }
});
