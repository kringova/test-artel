#!/usr/bin/env node
// Локальный дашборд Артель. Без зависимостей: читает markdown-vault и отдаёт веб-страницу.
// Запуск из корня vault:  node dashboard/serve.js  [--port 4321] [--root PATH] [--open]
// Страницы: /  (Проекты)  /kanban  /rice  /inbox  /analytics  /search?q=…  /t/<id>  /p/<slug>

import { createServer } from "node:http";
import { readFileSync, readdirSync, existsSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync } from "node:child_process";

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
          const raw = readFileSync(join(tdir, f), "utf8");
          const { data, body } = parseFrontmatter(raw);
          if (!(data.tags || []).includes("task")) continue;
          // имя папки — источник правды для проекта (frontmatter project — wiki-ссылка)
          tasks.push({ ...data, project: slug, file: f.replace(/\.md$/, ""), _rice: rice(data), _body: body });
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
const STATUS_LABEL = { todo: "Todo", doing: "В работе", done: "Готово", blocked: "Блок", cancelled: "Отменено", idea: "Идея", active: "Активен", paused: "Пауза", review: "На ревью" };
const PRIORITY_LABEL = { high: "Высокий", medium: "Средний", low: "Низкий" };
const isOpen = (t) => t.status === "todo" || t.status === "doing" || t.status === "blocked";

function progressColor(pct) {
  if (pct === 0) return "#d4d4d4";
  if (pct < 34) return "#fb7185";
  if (pct < 67) return "#fbbf24";
  if (pct < 100) return "#84cc16";
  return "#10b981";
}

function projectCard(p, tasks, clickable) {
  const pt = tasks.filter((t) => t.project === p.slug);
  const done = pt.filter((t) => t.status === "done").length;
  const considered = pt.filter((t) => t.status !== "cancelled").length;
  const open = pt.filter(isOpen).length;
  const pct = considered ? Math.round((done / considered) * 100) : 0;
  const top = pt.filter(isOpen).sort((a, b) => (b._rice ?? -1) - (a._rice ?? -1))[0];
  const inner = `
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
    ${p.updated ? `<div class="card-upd">обновлён ${esc(p.updated)}</div>` : ""}`;
  if (clickable) {
    return `<a class="card card-link" href="/p/${esc(p.slug)}">${inner}</a>`;
  }
  return `<div class="card">${inner}</div>`;
}

function taskCard(t) {
  return `<a class="kc kc-link" href="/t/${esc(t.id)}">
    <div class="kc-top"><span class="kc-id">${ticket(t.id)}</span>${t._rice != null ? `<span class="rice">${fmtRice(t._rice)}</span>` : ""}</div>
    <div class="kc-sum">${sumtext(t)}</div>
    <div class="kc-foot"><span class="badge b-soft">${esc(t.project)}</span>${(t.tags || []).includes("bug") ? `<span class="badge s-blocked">bug</span>` : ""}${t.status === "review" ? `<span class="badge s-review">ревью</span>` : ""}</div>
  </a>`;
}

// ── Минимальный markdown-рендер (без библиотек) ──
function renderMarkdown(text) {
  if (!text) return "";
  const lines = text.split("\n");
  const out = [];
  let inList = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Заголовки
    if (/^#{1,3}\s/.test(line)) {
      if (inList) { out.push("</ul>"); inList = false; }
      const lvl = line.match(/^(#+)/)[1].length;
      const content = esc(line.slice(lvl + 1));
      out.push(`<h${Math.min(lvl + 1, 6)} class="md-h">${content}</h${Math.min(lvl + 1, 6)}>`);
      continue;
    }
    // Чекбоксы
    const cbDone = line.match(/^[-*]\s+\[x\]\s+(.*)/i);
    const cbOpen = line.match(/^[-*]\s+\[ \]\s+(.*)/);
    if (cbDone || cbOpen) {
      if (!inList) { out.push("<ul class='md-ul'>"); inList = true; }
      const content = esc((cbDone || cbOpen)[1]);
      const checked = !!cbDone;
      out.push(`<li class="md-cb${checked ? " md-cb-done" : ""}"><span class="md-cbx">${checked ? "☑" : "☐"}</span> ${content}</li>`);
      continue;
    }
    // Обычные списки
    const li = line.match(/^[-*]\s+(.*)/);
    if (li) {
      if (!inList) { out.push("<ul class='md-ul'>"); inList = true; }
      out.push(`<li>${esc(li[1])}</li>`);
      continue;
    }
    if (inList) { out.push("</ul>"); inList = false; }
    // Пустая строка
    if (!line.trim()) { out.push("<br>"); continue; }
    out.push(`<p class="md-p">${esc(line)}</p>`);
  }
  if (inList) out.push("</ul>");
  return out.join("\n");
}

// ── Кнопка апрува (используется на страницах задачи и канбана) ──
function approveButton(id) {
  return `<button class="btn-approve" onclick="doApprove(${Number(id)},this)">Принять</button>`;
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
    (active.length ? section("Активные", active.length, "#10b981", active.map((p) => projectCard(p, tasks, true)).join("")) : "") +
    (others.length ? section("Остальные <span class='sub'>готовы · пауза · идеи</span>", others.length, "#d4d4d4", others.map((p) => projectCard(p, tasks, true)).join("")) : "") ||
    '<p class="empty-box">Проектов пока нет — заведите первый.</p>'
  );
}

function kanbanPage({ tasks }) {
  const open = tasks.filter(isOpen);
  const byRice = [...open].sort((a, b) => (b._rice ?? -1) - (a._rice ?? -1));
  const todo = byRice.filter((t) => t.status === "todo" || t.status === "blocked");
  const doing = open.filter((t) => t.status === "doing");
  const review = tasks.filter((t) => t.status === "review");
  const allDone = tasks.filter((t) => t.status === "done").sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
  const doneShown = allDone.slice(0, 15);

  const reviewCards = review.map((t) => `<a class="kc kc-link" href="/t/${esc(t.id)}">
    <div class="kc-top"><span class="kc-id">${ticket(t.id)}</span></div>
    <div class="kc-sum">${sumtext(t)}</div>
    <div class="kc-foot"><span class="badge b-soft">${esc(t.project)}</span></div>
    <div class="kc-approve">${approveButton(t.id)}</div>
  </a>`).join("") || '<div class="kempty">пусто</div>';

  const col = (title, list, bg, fg, total, extra = "") => `<div class="kcol">
    <div class="kcol-h"><span class="kpill" style="background:${bg};color:${fg}">${title}</span><span class="kcount">${total ?? list.length}</span></div>
    ${list.map(taskCard).join("") || '<div class="kempty">пусто</div>'}${extra}
  </div>`;

  return `<div class="kanban kanban-4">
    ${col("Todo", todo, "#f1f5f9", "#475569")}
    ${col("В работе", doing, "#eff6ff", "#1d4ed8")}
    <div class="kcol">
      <div class="kcol-h"><span class="kpill" style="background:#fdf4ff;color:#7e22ce">На ревью</span><span class="kcount">${review.length}</span></div>
      ${reviewCards}
    </div>
    ${col("Готово", doneShown, "#ecfdf5", "#047857", allDone.length, allDone.length > doneShown.length ? `<div class="kmore">+ ещё ${allDone.length - doneShown.length} (показаны 15 свежих)</div>` : "")}
  </div>`;
}

function ricePage({ tasks }) {
  const byRice = tasks.filter(isOpen).sort((a, b) => (b._rice ?? -1) - (a._rice ?? -1));
  const max = byRice[0]?._rice || 1;
  const rows = byRice.slice(0, 60).map((t) => `<tr onclick="location.href='/t/${esc(t.id)}'" style="cursor:pointer">
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

function inboxForm({ projects }) {
  const opts = projects.map((p) => `<option value="${esc(p.slug)}">${esc(p.slug)}</option>`).join("");
  return `<form id="ibf" class="ibf" onsubmit="return ibSubmit(event)">
    <textarea id="ibtext" rows="3" placeholder="Кинуть мысль… (Cmd/Ctrl+Enter — отправить)"
      onkeydown="if((event.metaKey||event.ctrlKey)&&event.key==='Enter')ibSubmit(event)"></textarea>
    <div class="ibf-row">
      <select id="ibproj"><option value="">Без проекта</option>${opts}</select>
      <div class="ibf-act"><span id="ibmsg" class="ibf-msg"></span><button type="submit">В инбокс</button></div>
    </div>
  </form>`;
}

function inboxPage(data) {
  const { inbox } = data;
  const list = inbox.length
    ? `<div class="inbox">${inbox.map((e) => `<div class="ie"><p class="ie-text">${esc(e.text)}</p><div class="ie-meta">${e.project ? `<span class="badge b-soft">${esc(e.project)}</span>` : ""}<span>${esc(e.created.slice(0, 16).replace("T", " "))}</span></div></div>`).join("")}</div>`
    : '<p class="empty-box">Инбокс пуст</p>';
  return `${inboxForm(data)}${list}
    <p class="hint">Записи копятся в <code>_inbox/</code>. Разобрать: скажите агенту «разбери инбокс» (навык inbox).</p>`;
}

// ── #284 Аналитика ──
function analyticsPage({ projects, tasks }) {
  const allTasks = tasks;
  const doneTasks = allTasks.filter((t) => t.status === "done");
  const openTasks = allTasks.filter(isOpen);
  const reviewTasks = allTasks.filter((t) => t.status === "review");

  // --- Сводка ---
  const totalProjects = projects.length;
  const totalOpen = openTasks.length;
  const totalDoing = allTasks.filter((t) => t.status === "doing").length;
  const totalDone = doneTasks.length;

  // --- Распределение грейдов по всем задачам ---
  const gradeCount = { junior: 0, middle: 0, senior: 0 };
  for (const t of allTasks) {
    const tier = String(t.model_tier || "").toLowerCase();
    if (tier === "junior" || tier === "middle" || tier === "senior") gradeCount[tier]++;
  }
  const gradeTotal = gradeCount.junior + gradeCount.middle + gradeCount.senior;

  // --- Покрытие тиринга: done-задачи с model_tier ---
  const doneWithTier = doneTasks.filter((t) => t.model_tier);
  const tierByGrade = { junior: 0, middle: 0, senior: 0 };
  for (const t of doneWithTier) {
    const tier = String(t.model_tier).toLowerCase();
    if (tier in tierByGrade) tierByGrade[tier]++;
  }
  const coveragePct = totalDone > 0 ? Math.round((doneWithTier.length / totalDone) * 100) : 0;

  // --- Скорость: задачи, закрытые по неделям (из closed_at, последние 12 недель) ---
  const now = new Date();
  const weekBuckets = [];
  for (let w = 11; w >= 0; w--) {
    const end = new Date(now);
    end.setDate(end.getDate() - w * 7);
    const start = new Date(end);
    start.setDate(start.getDate() - 7);
    weekBuckets.push({ label: `${String(start.getMonth() + 1).padStart(2, "0")}/${String(start.getDate()).padStart(2, "0")}`, count: 0, start, end });
  }
  for (const t of doneTasks) {
    const ca = t.closed_at || t.updated || "";
    if (!ca) continue;
    const d = new Date(ca);
    if (isNaN(d.getTime())) continue;
    for (const b of weekBuckets) {
      if (d >= b.start && d < b.end) { b.count++; break; }
    }
  }
  const maxWeekCount = Math.max(...weekBuckets.map((b) => b.count), 1);

  // --- Токены по грейдам: только если есть хотя бы одна задача с cost_by_model ---
  const hasCostByModel = allTasks.some((t) => t.cost_by_model && String(t.cost_by_model).trim());

  // Бар-хелпер
  const barPct = (n, total) => total > 0 ? Math.max(Math.round((n / total) * 100), 2) : 0;
  const GRADE_COLORS = { junior: "#86efac", middle: "#93c5fd", senior: "#d8b4fe" };

  const gradeBar = (grade, count) => {
    const pct = barPct(count, gradeTotal || 1);
    return `<div class="an-grade-row">
      <span class="an-grade-label">${grade}</span>
      <div class="an-bar-track"><div class="an-bar-fill" style="width:${pct}%;background:${GRADE_COLORS[grade] || "#e5e5e5"}"></div></div>
      <span class="an-grade-cnt">${count}</span>
    </div>`;
  };

  const tierBar = (grade, count) => {
    const pct = barPct(count, doneWithTier.length || 1);
    return `<div class="an-grade-row">
      <span class="an-grade-label">${grade}</span>
      <div class="an-bar-track"><div class="an-bar-fill" style="width:${pct}%;background:${GRADE_COLORS[grade] || "#e5e5e5"}"></div></div>
      <span class="an-grade-cnt">${count}</span>
    </div>`;
  };

  const weekBars = weekBuckets.map((b) => {
    const pct = barPct(b.count, maxWeekCount);
    return `<div class="an-week-col">
      <div class="an-week-bar-wrap">
        <div class="an-week-bar-fill" style="height:${pct}%;background:${b.count > 0 ? "var(--accent)" : "#e5e5e5"}"></div>
      </div>
      <span class="an-week-cnt">${b.count > 0 ? b.count : ""}</span>
      <span class="an-week-lbl">${esc(b.label)}</span>
    </div>`;
  }).join("");

  return `
  <div class="an-grid">

    <div class="an-card">
      <div class="an-card-title">Сводка</div>
      <div class="an-stats-row">
        <div class="an-stat"><span class="an-stat-num">${totalProjects}</span><span class="an-stat-lbl">проектов</span></div>
        <div class="an-stat"><span class="an-stat-num">${totalOpen}</span><span class="an-stat-lbl">открытых</span></div>
        <div class="an-stat"><span class="an-stat-num">${totalDoing}</span><span class="an-stat-lbl">в работе</span></div>
        <div class="an-stat"><span class="an-stat-num">${reviewTasks.length}</span><span class="an-stat-lbl">на ревью</span></div>
        <div class="an-stat"><span class="an-stat-num">${totalDone}</span><span class="an-stat-lbl">готово</span></div>
      </div>
    </div>

    <div class="an-card">
      <div class="an-card-title">Распределение грейдов</div>
      <div class="an-card-hint">все задачи (${allTasks.length} всего, ${gradeTotal} с грейдом)</div>
      ${gradeTotal === 0
        ? '<p class="an-empty">Нет задач с полем model_tier</p>'
        : ["junior", "middle", "senior"].map((g) => gradeBar(g, gradeCount[g])).join("")}
    </div>

    <div class="an-card">
      <div class="an-card-title">Покрытие тиринга</div>
      <div class="an-card-hint">done-задачи с полем model_tier — ${doneWithTier.length} из ${totalDone} (${coveragePct}%)</div>
      ${totalDone === 0
        ? '<p class="an-empty">Нет закрытых задач</p>'
        : `<div class="an-coverage-bar-wrap">
            <div class="an-coverage-bar" style="width:${coveragePct}%;background:#10b981"></div>
           </div>
           <div class="an-coverage-num">${coveragePct}%</div>
           ${doneWithTier.length > 0
             ? ["junior", "middle", "senior"].map((g) => tierBar(g, tierByGrade[g])).join("")
             : '<p class="an-empty">Ни одна done-задача не имеет model_tier</p>'}`}
    </div>

  </div>

  <div class="an-card an-card-wide">
    <div class="an-card-title">Скорость закрытия задач</div>
    <div class="an-card-hint">по неделям из поля closed_at (последние 12 недель)</div>
    ${doneTasks.length === 0
      ? '<p class="an-empty">Нет закрытых задач</p>'
      : `<div class="an-weeks">${weekBars}</div>`}
  </div>

  ${hasCostByModel ? `<div class="an-card an-card-wide">
    <div class="an-card-title">Токены по грейдам</div>
    <div class="an-card-hint">из поля cost_by_model задач</div>
    <p class="an-empty">Данные есть, но агрегация токенов требует расширенного формата.</p>
  </div>` : ""}`;
}

// ── #286 Поиск ──
function searchPage(data, q) {
  const { projects, tasks } = data;
  if (!q || !q.trim()) {
    return `<form class="search-form" method="get" action="/search">
      <input class="search-input" name="q" placeholder="Поиск по задачам и проектам…" autofocus>
      <button class="search-btn" type="submit">Найти</button>
    </form>
    <p class="hint">Введите запрос для поиска по задачам (summary, тело, id) и проектам.</p>`;
  }
  const ql = q.toLowerCase();
  const matchedTasks = tasks.filter((t) => {
    return (
      String(t.id).includes(ql) ||
      String(t.summary || "").toLowerCase().includes(ql) ||
      String(t.file || "").toLowerCase().includes(ql) ||
      String(t._body || "").toLowerCase().includes(ql)
    );
  });
  const matchedProjects = projects.filter((p) => {
    return (
      String(p.slug || "").toLowerCase().includes(ql) ||
      String(p.summary || "").toLowerCase().includes(ql) ||
      String(p.audience || "").toLowerCase().includes(ql)
    );
  });

  const taskItems = matchedTasks.length
    ? `<div class="search-group">
        <h2 class="sec-h"><span class="dot" style="background:#ef6b5b"></span>Задачи · ${matchedTasks.length}</h2>
        <div class="search-list">${matchedTasks.map((t) => `
          <a class="search-item" href="/t/${esc(t.id)}">
            <span class="kc-id">${ticket(t.id)}</span>
            <span class="search-sum">${sumtext(t)}</span>
            <span class="badge b-soft">${esc(t.project)}</span>
            <span class="badge s-${esc(t.status)}">${esc(STATUS_LABEL[t.status] || t.status)}</span>
          </a>`).join("")}
        </div>
      </div>`
    : "";

  const projItems = matchedProjects.length
    ? `<div class="search-group">
        <h2 class="sec-h"><span class="dot" style="background:#10b981"></span>Проекты · ${matchedProjects.length}</h2>
        <div class="search-list">${matchedProjects.map((p) => `
          <a class="search-item" href="/p/${esc(p.slug)}">
            <span class="search-sum">${esc(p.slug)}</span>
            <span class="badge s-${esc(p.status)}">${esc(STATUS_LABEL[p.status] || p.status)}</span>
          </a>`).join("")}
        </div>
      </div>`
    : "";

  const noResults = !taskItems && !projItems ? '<p class="empty-box">Ничего не найдено</p>' : "";

  return `<form class="search-form" method="get" action="/search">
    <input class="search-input" name="q" value="${esc(q)}" autofocus>
    <button class="search-btn" type="submit">Найти</button>
  </form>
  ${taskItems}${projItems}${noResults}`;
}

// ── #286 Страница задачи ──
function taskPage(data, idStr) {
  const idNum = parseInt(idStr, 10);
  const t = data.tasks.find((x) => Number(x.id) === idNum);
  if (!t) return null;
  const project = data.projects.find((p) => p.slug === t.project);

  const riceVal = rice(t);
  const riceFields = ["rice_reach", "rice_impact", "rice_confidence", "rice_effort"].map((k) =>
    t[k] != null ? `<span class="meta-item"><span class="meta-key">${k.replace("rice_", "").toUpperCase()}</span> ${esc(t[k])}</span>` : ""
  ).join("");

  const roles = Array.isArray(t.roles) ? t.roles : (t.roles ? String(t.roles).split(",").map((s) => s.trim()) : []);

  return `<div class="task-page">
    <div class="task-breadcrumb">
      <a href="/p/${esc(t.project)}">${esc(t.project)}</a>
      <span class="muted"> / </span>
      <span class="kc-id">${ticket(t.id)}</span>
    </div>
    <h1 class="task-title">${sumtext(t)}</h1>
    <div class="task-meta">
      <span class="badge s-${esc(t.status)}">${esc(STATUS_LABEL[t.status] || t.status)}</span>
      ${t.model_tier ? `<span class="badge b-soft">tier: ${esc(t.model_tier)}</span>` : ""}
      ${t.sp != null ? `<span class="badge b-soft">SP: ${esc(t.sp)}</span>` : ""}
      ${t.priority ? `<span class="badge pri-${esc(t.priority)}">${esc(PRIORITY_LABEL[t.priority] || t.priority)}</span>` : ""}
      ${roles.map((r) => `<span class="badge b-soft">${esc(r)}</span>`).join("")}
    </div>
    ${riceFields ? `<div class="task-rice-row">${riceVal != null ? `<span class="rice">RICE ${fmtRice(riceVal)}</span>` : ""} ${riceFields}</div>` : ""}
    <div class="task-dates">
      ${t.created_at ? `<span class="meta-item"><span class="meta-key">создана</span> ${esc(String(t.created_at).slice(0, 10))}</span>` : ""}
      ${t.closed_at ? `<span class="meta-item"><span class="meta-key">закрыта</span> ${esc(String(t.closed_at).slice(0, 10))}</span>` : ""}
      ${t.updated ? `<span class="meta-item"><span class="meta-key">обновлена</span> ${esc(String(t.updated).slice(0, 10))}</span>` : ""}
    </div>
    ${t.status === "review" ? `<div class="task-approve-row">${approveButton(t.id)}<span class="muted" style="font-size:13px">Задача ожидает подтверждения</span></div>` : ""}
    ${t._body ? `<div class="task-body">${renderMarkdown(t._body)}</div>` : ""}
  </div>`;
}

// ── #286 Страница проекта ──
function projectPage(data, slug) {
  const p = data.projects.find((x) => x.slug === slug);
  if (!p) return null;
  const pt = data.tasks.filter((t) => t.project === slug);
  const done = pt.filter((t) => t.status === "done").length;
  const considered = pt.filter((t) => t.status !== "cancelled").length;
  const pct = considered ? Math.round((done / considered) * 100) : 0;

  const STATUS_ORDER = ["doing", "review", "todo", "blocked", "done", "cancelled"];
  const groups = {};
  for (const t of pt) { (groups[t.status] ??= []).push(t); }

  const groupsHtml = STATUS_ORDER.filter((s) => groups[s]?.length).map((s) => `
    <div class="p-group">
      <h3 class="p-group-h"><span class="badge s-${esc(s)}">${esc(STATUS_LABEL[s] || s)}</span> · ${groups[s].length}</h3>
      <div class="p-task-list">${groups[s].map((t) => `
        <a class="p-task-item" href="/t/${esc(t.id)}">
          <span class="kc-id">${ticket(t.id)}</span>
          <span class="p-task-sum">${sumtext(t)}</span>
          ${t._rice != null ? `<span class="rice">${fmtRice(t._rice)}</span>` : ""}
        </a>`).join("")}
      </div>
    </div>`).join("");

  return `<div class="proj-page">
    <div class="proj-header">
      <h1 class="proj-title">${esc(p.slug)}</h1>
      <div class="chips">
        <span class="badge s-${esc(p.status)}">${esc(STATUS_LABEL[p.status] || p.status)}</span>
        ${p.priority ? `<span class="badge pri-${esc(p.priority)}">${esc(PRIORITY_LABEL[p.priority] || p.priority)}</span>` : ""}
        ${p.type ? `<span class="badge b-soft">${esc(p.type)}</span>` : ""}
      </div>
      ${p.audience ? `<p class="card-aud">${esc(p.audience)}</p>` : ""}
    </div>
    <div class="prog">
      <div class="prog-meta"><span>${done}/${considered} готово</span><span class="prog-pct">${pct}%</span></div>
      <div class="prog-track"><div class="prog-fill" style="width:${Math.max(pct, 2)}%;background:${progressColor(pct)}"></div></div>
    </div>
    <div class="p-groups">${groupsHtml || '<p class="empty-box">Задач нет</p>'}</div>
  </div>`;
}

const PAGES = {
  projects: { title: "Проекты", build: projectsPage },
  kanban: { title: "Канбан", build: kanbanPage },
  rice: { title: "RICE-приоритеты", build: ricePage },
  inbox: { title: "Инбокс", build: inboxPage },
  analytics: { title: "Аналитика", build: analyticsPage },
};

function render(data, page, extra = {}) {
  const { projects, tasks, inbox } = data;
  projects.sort((a, b) => (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9) || String(b.updated).localeCompare(String(a.updated)));
  const open = tasks.filter(isOpen);
  const def = PAGES[page] || PAGES.projects;

  let subtitle = "";
  let content = "";

  if (page === "task") {
    const t = data.tasks.find((x) => Number(x.id) === extra.id);
    const title = t ? cleanWiki(t.summary || t.file) : "Задача не найдена";
    subtitle = t ? `${t.project} / ${ticket(t.id)}` : "";
    content = taskPage(data, String(extra.id));
    if (!content) {
      return render404(`Задача #${extra.id} не найдена`);
    }
    return renderShell(data, "task", title, subtitle, content, extra);
  }

  if (page === "project") {
    const p = data.projects.find((x) => x.slug === extra.slug);
    const title = p ? p.slug : "Проект не найден";
    subtitle = p ? `${STATUS_LABEL[p.status] || p.status}` : "";
    content = projectPage(data, extra.slug);
    if (!content) {
      return render404(`Проект «${extra.slug}» не найден`);
    }
    return renderShell(data, "project", title, subtitle, content, extra);
  }

  if (page === "search") {
    subtitle = extra.q ? `поиск: «${extra.q}»` : "поиск по vault";
    content = searchPage(data, extra.q || "");
    return renderShell(data, "search", "Поиск", subtitle, content, extra);
  }

  subtitle =
    page === "kanban" ? `${open.length} открытых · ${tasks.filter((t) => t.status === "done").length} готово`
    : page === "rice" ? "открытые задачи по убыванию RICE"
    : page === "inbox" ? `${inbox.length} записей на разбор`
    : page === "analytics" ? `${projects.length} проектов · ${tasks.length} задач`
    : `${projects.length} проектов · ${open.length} открытых задач`;

  content = def.build(data);
  return renderShell(data, page, def.title, subtitle, content, extra);
}

function render404(msg) {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>404 — Артель</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>body{font:15px/1.5 ui-sans-serif,sans-serif;margin:0;background:#fafafa;color:#262626;display:flex;align-items:center;justify-content:center;min-height:100vh}
  .box{text-align:center;padding:40px}.h{font-size:72px;font-weight:700;color:#e5e5e5;margin:0}p{color:#737373}</style>
  </head><body><div class="box"><div class="h">404</div><p>${esc(msg)}</p><p><a href="/">← На главную</a></p></div></body></html>`;
}

function renderShell(data, page, title, subtitle, content) {
  const link = (href, label, key) => `<a class="link${page === key ? " active" : ""}" href="${href}">${label}</a>`;
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Артель — ${esc(title)}</title>
<style>
  :root { --accent:#ef6b5b; --ink:#262626; --muted:#737373; --line:#e5e5e5; --bg:#fafafa; }
  * { box-sizing:border-box; }
  html,body { overflow-x:hidden; }
  body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.5 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; -webkit-font-smoothing:antialiased; }
  a { color:inherit; text-decoration:none; }
  .nav { position:sticky; top:0; z-index:50; background:rgba(255,255,255,.95); backdrop-filter:blur(6px); border-bottom:1px solid var(--line); }
  .nav-in { max-width:1120px; margin:0 auto; display:flex; align-items:center; gap:14px; padding:12px 20px; flex-wrap:wrap; }
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
  .card-link { display:flex; flex-direction:column; min-width:0; background:#fff; border:1px solid var(--line); border-radius:14px; box-shadow:0 1px 2px rgba(0,0,0,.04); padding:16px; transition:box-shadow .15s,border-color .15s; }
  .card-link:hover { border-color:#d4d4d4; box-shadow:0 3px 8px rgba(0,0,0,.08); }
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
  .s-review { background:#fdf4ff; color:#7e22ce; }
  .pri-high { background:#fff1f2; color:#be123c; } .pri-medium { background:#fffbeb; color:#b45309; } .pri-low { background:#f5f5f5; color:#737373; }
  .kanban { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:16px; margin-top:22px; }
  .kanban-4 { grid-template-columns:repeat(4,minmax(0,1fr)); }
  .kcol { background:rgba(245,245,245,.55); border:1px solid var(--line); border-radius:14px; padding:12px; min-width:0; }
  .kcol-h { display:flex; align-items:center; gap:8px; margin-bottom:10px; }
  .kpill { font-size:11px; font-weight:500; padding:2px 9px; border-radius:999px; }
  .kcount { color:#a3a3a3; font-size:12px; }
  .kc { display:block; background:#fff; border:1px solid var(--line); border-radius:10px; box-shadow:0 1px 2px rgba(0,0,0,.04); padding:10px 11px; margin-bottom:8px; min-width:0; }
  .kc-link { transition:border-color .12s,box-shadow .12s; }
  .kc-link:hover { border-color:#d4d4d4; box-shadow:0 2px 6px rgba(0,0,0,.08); }
  .kc-top { display:flex; align-items:center; justify-content:space-between; gap:6px; }
  .kc-id { font-family:ui-monospace,monospace; font-size:11px; color:#a3a3a3; }
  .kc-sum { font-size:14px; font-weight:500; color:#262626; margin-top:3px; overflow-wrap:anywhere; }
  .kc-foot { display:flex; flex-wrap:wrap; gap:6px; margin-top:8px; }
  .kc-approve { margin-top:8px; }
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
  .ibf { max-width:680px; margin:22px 0 14px; background:#fff; border:1px solid var(--line); border-radius:12px; box-shadow:0 1px 2px rgba(0,0,0,.04); padding:14px; }
  .ibf textarea { width:100%; resize:none; border:1px solid var(--line); border-radius:9px; padding:9px 11px; font:inherit; font-size:14px; color:var(--ink); outline:none; }
  .ibf textarea:focus { border-color:var(--accent); box-shadow:0 0 0 1px var(--accent); }
  .ibf-row { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-top:11px; flex-wrap:wrap; }
  .ibf select { min-height:38px; border:1px solid var(--line); border-radius:9px; padding:6px 9px; font:inherit; font-size:14px; color:var(--muted); background:#fff; outline:none; }
  .ibf select:focus { border-color:var(--accent); }
  .ibf-act { display:flex; align-items:center; gap:12px; }
  .ibf-msg { font-size:13px; color:var(--muted); }
  .ibf button { min-height:38px; border:0; border-radius:9px; background:var(--accent); color:#fff; font:inherit; font-size:14px; font-weight:500; padding:8px 16px; cursor:pointer; transition:opacity .15s; }
  .ibf button:hover { opacity:.9; }
  .ibf button:disabled { opacity:.4; cursor:not-allowed; }
  .empty-box { border:1px dashed var(--line); border-radius:14px; padding:30px; text-align:center; color:#a3a3a3; font-size:14px; margin-top:22px; }
  .hint { color:#a3a3a3; font-size:12px; margin:14px 0 0; }
  /* Кнопка апрува */
  .btn-approve { display:inline-flex; align-items:center; border:0; border-radius:8px; background:#7e22ce; color:#fff; font:inherit; font-size:13px; font-weight:500; padding:6px 14px; cursor:pointer; transition:opacity .15s; }
  .btn-approve:hover { opacity:.85; }
  .btn-approve:disabled { opacity:.4; cursor:not-allowed; }
  /* Аналитика */
  .an-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:16px; margin-top:22px; }
  .an-card { background:#fff; border:1px solid var(--line); border-radius:14px; padding:16px; min-width:0; }
  .an-card-wide { margin-top:16px; background:#fff; border:1px solid var(--line); border-radius:14px; padding:16px; }
  .an-card-title { font-size:12px; text-transform:uppercase; letter-spacing:.04em; color:#a3a3a3; font-weight:600; margin-bottom:4px; }
  .an-card-hint { font-size:12px; color:#a3a3a3; margin-bottom:12px; }
  .an-stats-row { display:flex; flex-wrap:wrap; gap:12px; margin-top:8px; }
  .an-stat { display:flex; flex-direction:column; min-width:0; }
  .an-stat-num { font-size:28px; font-weight:700; line-height:1; color:var(--ink); }
  .an-stat-lbl { font-size:12px; color:var(--muted); margin-top:2px; }
  .an-grade-row { display:flex; align-items:center; gap:8px; margin-bottom:8px; min-width:0; }
  .an-grade-label { font-size:13px; width:56px; flex:none; color:var(--ink); }
  .an-bar-track { flex:1; min-width:0; height:10px; border-radius:999px; background:#f5f5f5; overflow:hidden; }
  .an-bar-fill { height:100%; border-radius:999px; }
  .an-grade-cnt { font-size:13px; width:32px; text-align:right; flex:none; font-variant-numeric:tabular-nums; }
  .an-coverage-bar-wrap { height:10px; border-radius:999px; background:#f5f5f5; overflow:hidden; margin:8px 0 4px; }
  .an-coverage-bar { height:100%; border-radius:999px; }
  .an-coverage-num { font-size:22px; font-weight:700; margin-bottom:12px; }
  .an-weeks { display:flex; align-items:flex-end; gap:6px; height:120px; margin-top:8px; overflow-x:auto; padding-bottom:4px; }
  .an-week-col { display:flex; flex-direction:column; align-items:center; gap:2px; flex:1; min-width:40px; }
  .an-week-bar-wrap { flex:1; width:100%; display:flex; flex-direction:column; justify-content:flex-end; }
  .an-week-bar-fill { width:100%; border-radius:4px 4px 0 0; min-height:2px; }
  .an-week-cnt { font-size:11px; font-weight:600; color:var(--ink); height:16px; }
  .an-week-lbl { font-size:10px; color:var(--muted); text-align:center; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; width:100%; }
  .an-empty { font-size:13px; color:#a3a3a3; margin:4px 0; }
  /* Поиск */
  .search-form { display:flex; gap:8px; margin-bottom:22px; flex-wrap:wrap; }
  .search-input { flex:1; min-width:0; border:1px solid var(--line); border-radius:9px; padding:9px 13px; font:inherit; font-size:15px; outline:none; background:#fff; }
  .search-input:focus { border-color:var(--accent); box-shadow:0 0 0 1px var(--accent); }
  .search-btn { border:0; border-radius:9px; background:var(--accent); color:#fff; font:inherit; font-size:14px; font-weight:500; padding:8px 18px; cursor:pointer; }
  .search-group { margin-top:20px; }
  .search-list { display:flex; flex-direction:column; gap:6px; margin-top:8px; }
  .search-item { display:flex; align-items:center; gap:8px; background:#fff; border:1px solid var(--line); border-radius:10px; padding:10px 13px; transition:border-color .12s; flex-wrap:wrap; min-width:0; }
  .search-item:hover { border-color:#d4d4d4; }
  .search-sum { flex:1; min-width:0; font-weight:500; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; overflow-wrap:anywhere; }
  /* Страница задачи */
  .task-page { max-width:760px; }
  .task-breadcrumb { font-size:13px; color:var(--muted); margin-bottom:8px; }
  .task-breadcrumb a:hover { text-decoration:underline; }
  .task-title { font-size:22px; font-weight:700; margin:0 0 10px; overflow-wrap:anywhere; }
  .task-meta { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:10px; }
  .task-rice-row { display:flex; flex-wrap:wrap; gap:10px; align-items:center; margin-bottom:8px; font-size:13px; color:var(--muted); }
  .task-dates { display:flex; flex-wrap:wrap; gap:12px; margin-bottom:14px; }
  .meta-item { font-size:13px; color:var(--muted); }
  .meta-key { font-weight:600; color:#a3a3a3; text-transform:uppercase; font-size:11px; margin-right:4px; }
  .task-approve-row { display:flex; align-items:center; gap:12px; margin-bottom:14px; padding:12px 16px; background:#fdf4ff; border:1px solid #e9d5ff; border-radius:10px; }
  .task-body { background:#fff; border:1px solid var(--line); border-radius:12px; padding:16px 18px; margin-top:16px; }
  .md-h { font-size:15px; font-weight:600; margin:14px 0 4px; color:var(--ink); }
  .md-p { margin:4px 0; font-size:14px; }
  .md-ul { margin:4px 0; padding-left:18px; font-size:14px; }
  .md-cb { list-style:none; margin-left:-18px; padding-left:0; }
  .md-cb-done { color:var(--muted); text-decoration:line-through; }
  .md-cbx { font-style:normal; margin-right:4px; }
  /* Страница проекта */
  .proj-page { max-width:860px; }
  .proj-header { margin-bottom:12px; }
  .proj-title { font-size:22px; font-weight:700; margin:0 0 8px; }
  .p-groups { margin-top:20px; display:flex; flex-direction:column; gap:16px; }
  .p-group-h { font-size:13px; font-weight:600; margin:0 0 8px; display:flex; align-items:center; gap:6px; }
  .p-task-list { display:flex; flex-direction:column; gap:6px; }
  .p-task-item { display:flex; align-items:center; gap:8px; background:#fff; border:1px solid var(--line); border-radius:9px; padding:9px 13px; transition:border-color .12s; min-width:0; }
  .p-task-item:hover { border-color:#d4d4d4; }
  .p-task-sum { flex:1; min-width:0; font-size:14px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; overflow-wrap:anywhere; }
  @media (max-width:880px){ .grid,.kanban{grid-template-columns:1fr 1fr} .kanban-4{grid-template-columns:1fr 1fr} .an-grid{grid-template-columns:1fr 1fr} }
  @media (max-width:580px){ .grid,.kanban,.kanban-4,.an-grid{grid-template-columns:1fr} .link{padding:6px 8px} }
</style></head><body>
<nav class="nav"><div class="nav-in">
  <a class="logo" href="/"><i>ll</i> Артель</a>
  ${link("/", "Проекты", "projects")}
  ${link("/kanban", "Канбан", "kanban")}
  ${link("/rice", "RICE", "rice")}
  ${link("/inbox", "Инбокс", "inbox")}
  ${link("/analytics", "Аналитика", "analytics")}
  ${link("/search", "Поиск", "search")}
</div></nav>
<div class="wrap">
  <h1>${esc(title)}</h1>
  <p class="stats">${subtitle}</p>
  ${content}
  <p class="hint">Обновляется автоматически каждые 30 c. Данные читаются из markdown при каждом запросе.</p>
</div>
<script>
  // Авто-обновление, но не пока пользователь печатает в инбоксе.
  setInterval(function(){
    var t=document.getElementById('ibtext');
    if(t&&(t===document.activeElement||t.value.trim()))return;
    // Не обновляем если фокус в поиске
    var s=document.querySelector('.search-input');
    if(s&&s===document.activeElement)return;
    location.reload();
  },30000);
  function ibSubmit(e){
    e.preventDefault();
    var t=document.getElementById('ibtext'),p=document.getElementById('ibproj'),
        m=document.getElementById('ibmsg'),btn=document.querySelector('#ibf button');
    var text=t.value.trim(); if(!text)return false;
    btn.disabled=true; m.textContent='';
    fetch('/api/inbox',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({text:text,project:p.value})})
      .then(function(r){if(!r.ok)return r.json().then(function(j){throw new Error(j.error||'ошибка')});return r.json()})
      .then(function(){t.value='';p.value='';m.textContent='Записано ✓';setTimeout(function(){location.reload()},500)})
      .catch(function(err){m.textContent=err.message;btn.disabled=false});
    return false;
  }
  function doApprove(id,btn){
    if(!confirm('Принять задачу #'+id+' (review → done)?'))return;
    btn.disabled=true;btn.textContent='…';
    fetch('/api/approve',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({id:id})})
      .then(function(r){
        if(r.status===409)return r.json().then(function(j){throw new Error(j.error||'уже не в review')});
        if(!r.ok)return r.json().then(function(j){throw new Error(j.error||'ошибка '+r.status)});
        return r.json();
      })
      .then(function(){btn.textContent='Принято ✓';setTimeout(function(){location.reload()},700)})
      .catch(function(err){alert(err.message);btn.disabled=false;btn.textContent='Принять'});
  }
</script>
</body></html>`;
}

// ── Быстрый захват в инбокс (POST /api/inbox) ──
const pad = (n) => String(n).padStart(2, "0");
function writeInbox(text, project) {
  const t = (text || "").trim();
  if (!t) throw new Error("пустая запись");
  const idir = join(ROOT, "_inbox");
  mkdirSync(idir, { recursive: true });
  const d = new Date();
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  const slug = `${stamp}-${Math.random().toString(36).slice(2, 6)}`;
  const fm = ["---", `created: ${d.toISOString()}`, (project || "").trim() ? `project: ${String(project).trim()}` : null, "tags: [inbox]", "---", "", t, ""].filter((l) => l !== null).join("\n");
  writeFileSync(join(idir, `${slug}.md`), fm, "utf8");
  return slug;
}

// ── #285 Апрув задачи (POST /api/approve) ──
function approveTask(id) {
  const numId = Number(id);
  if (!numId) throw Object.assign(new Error("некорректный id"), { status: 400 });

  // Ищем файл задачи
  const projectsDir = join(ROOT, "projects");
  let taskFile = null;
  let taskData = null;
  if (existsSync(projectsDir)) {
    outer: for (const slug of readdirSync(projectsDir)) {
      const pdir = join(projectsDir, slug);
      if (!statSync(pdir).isDirectory()) continue;
      const tdir = join(pdir, "tasks");
      if (!existsSync(tdir)) continue;
      for (const f of readdirSync(tdir)) {
        if (!f.endsWith(".md") || f === "tasks.md") continue;
        const fp = join(tdir, f);
        const { data } = parseFrontmatter(readFileSync(fp, "utf8"));
        if (!(data.tags || []).includes("task")) continue;
        if (Number(data.id) === numId) { taskFile = fp; taskData = data; break outer; }
      }
    }
  }
  if (!taskFile) throw Object.assign(new Error("задача не найдена"), { status: 404 });
  if (taskData.status !== "review") throw Object.assign(new Error(`статус не review (${taskData.status})`), { status: 409 });

  const now = new Date().toISOString();
  const today = now.slice(0, 10);
  let md = readFileSync(taskFile, "utf8");

  // Меняем status: review → status: done
  let changed = md.replace(/^status:\s*review\s*$/m, "status: done");
  if (changed === md) throw Object.assign(new Error("status: review не найден в файле"), { status: 409 });

  // updated
  if (/^updated:\s*.*$/m.test(changed)) {
    changed = changed.replace(/^updated:\s*.*$/m, `updated: ${today}`);
  } else {
    changed = changed.replace(/^(status:\s*done)$/m, `$1\nupdated: ${today}`);
  }

  // closed_at
  if (/^closed_at:\s*.*$/m.test(changed)) {
    changed = changed.replace(/^closed_at:\s*.*$/m, `closed_at: ${now}`);
  } else {
    changed = changed.replace(/^updated:\s*.*$/m, (m) => `${m}\nclosed_at: ${now}`);
  }

  writeFileSync(taskFile, changed, "utf8");

  // Git (опционально)
  let pushed = false;
  if (process.env.ARTEL_GIT_PUSH) {
    try {
      const git = (...a) => execFileSync("git", a, {
        cwd: ROOT, stdio: "pipe",
        env: { ...process.env, ARTEL_APPROVE: "1" },
      });
      git("add", taskFile);
      git("commit", "-m", `close: #${numId} approved`);
      git("pull", "--rebase", "--autostash");
      git("push");
      pushed = true;
    } catch (e) {
      console.error("approve git push failed:", e);
      throw Object.assign(new Error("git push failed"), { status: 500 });
    }
  }
  return { ok: true, id: numId, pushed };
}

const sendJson = (res, code, obj) => {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
};

// ── Сервер ──
const server = createServer((req, res) => {
  const urlObj = new URL(req.url || "/", `http://localhost:${PORT}`);
  const path = urlObj.pathname.replace(/\/+$/, "") || "/";

  // POST /api/inbox
  if (req.method === "POST" && path === "/api/inbox") {
    let raw = "";
    req.on("data", (c) => { raw += c; if (raw.length > 1e5) req.destroy(); });
    req.on("end", () => {
      try {
        const { text, project } = JSON.parse(raw || "{}");
        const slug = writeInbox(text, project);
        sendJson(res, 200, { ok: true, slug });
      } catch (e) {
        sendJson(res, 400, { error: e.message || "ошибка записи" });
      }
    });
    return;
  }

  // POST /api/approve
  if (req.method === "POST" && path === "/api/approve") {
    let raw = "";
    req.on("data", (c) => { raw += c; if (raw.length > 1e5) req.destroy(); });
    req.on("end", () => {
      try {
        const { id } = JSON.parse(raw || "{}");
        const result = approveTask(id);
        sendJson(res, 200, result);
      } catch (e) {
        sendJson(res, e.status || 500, { error: e.message || "ошибка апрува" });
      }
    });
    return;
  }

  try {
    const data = scan();
    let page = "projects";
    let extra = {};

    if (path === "/kanban") page = "kanban";
    else if (path === "/rice") page = "rice";
    else if (path === "/inbox") page = "inbox";
    else if (path === "/analytics") page = "analytics";
    else if (path === "/search") {
      page = "search";
      extra.q = urlObj.searchParams.get("q") || "";
    } else if (/^\/t\/(\d+)$/.test(path)) {
      page = "task";
      extra.id = parseInt(path.match(/^\/t\/(\d+)$/)[1], 10);
      // Проверяем существование задачи → 404
      const t = data.tasks.find((x) => Number(x.id) === extra.id);
      if (!t) {
        res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
        res.end(render404(`Задача #${extra.id} не найдена`));
        return;
      }
    } else if (/^\/p\/([^/]+)$/.test(path)) {
      page = "project";
      extra.slug = path.match(/^\/p\/([^/]+)$/)[1];
      const p = data.projects.find((x) => x.slug === extra.slug);
      if (!p) {
        res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
        res.end(render404(`Проект «${extra.slug}» не найден`));
        return;
      }
    }

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(render(data, page, extra));
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
