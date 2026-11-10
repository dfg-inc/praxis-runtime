#!/usr/bin/env node
/**
 * Real-browser acceptance of prototype patterns that are not tables. AUTOMATED: a real Chrome driven by Playwright; the "user"
 * is the script clicking and typing. The page is served by this Runtime's own review service on 127.0.0.1 (its content security
 * policy, link token and save token), and Save writes the work item on disk. It says nothing about Claude Desktop or Claude Code.
 *
 * P01-P03, the agronomist journal (tools/fixtures/agronomist-journal.json, an anonymized reproduction of an external report): the
 * note feed asked for as a chat. Each criterion of the report's acceptance scenario is measured on the rendered page at desktop and
 * phone width, and the reported table is measured the same way, so the check is shown to tell the two apart.
 * P04-P07, a custom part: hostile markup and script in the sandboxed frame must not reach the page, its token, the review server or
 * the network (also in the offline copy, navigation included), must not catch what the person types in the page or take the full screen, may only point
 * at a declared part in Inspect and Review, and a busy loop in it must not freeze the page.
 *
 * Needs a build whose @praxis/contracts knows the conversation and custom kinds (praxis-core vendor refresh).
 * Usage: node tools/scripts/prototype-patterns-browser-acceptance.mjs [--chrome <path>] [--shots <dir>]
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const arg = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
const chromePath = arg("--chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
const shots = arg("--shots", "");
if (!existsSync(chromePath)) {
  console.error(`no Chrome at ${chromePath}; pass --chrome <path>`);
  process.exit(2);
}
process.env.PRAXIS_TEST_REVIEW_NO_BROWSER = "1";
const C = await import("@praxis/contracts");
if (!C.ELEMENT_KINDS.includes("conversation") || !C.ELEMENT_KINDS.includes("custom")) {
  console.error("this build's @praxis/contracts has no conversation/custom element kinds: refresh the praxis-core vendor first");
  process.exit(2);
}
const { renderReviewTool, reviewDir, stopReviewServer } = await import(pathToFileURL(join(root, "packages/mcp/dist/review-service.js")).href);
const { applyRuntimeCommand, loadWorkflow } = await import(pathToFileURL(join(root, "packages/mcp/dist/workflow-store.js")).href);
const F = JSON.parse(readFileSync(join(root, "tools/fixtures/agronomist-journal.json"), "utf8"));
const ME = "Ирина Ковалёва";
if (shots) mkdirSync(shots, { recursive: true });
// the page's action bar is fixed to the bottom of the window; it is hidden only in the screenshots, never in the checks
const SHOT_STYLE = ".bar{display:none!important}";

const results = [];
let cur;
const check = (cond, msg) => {
  if (!cond) throw new Error(msg);
  cur.checks += 1;
};
const eq = (a, b, msg) => check(JSON.stringify(a) === JSON.stringify(b), `${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
async function scenario(id, title, fn) {
  cur = { id, title, checks: 0, status: "PASS", error: null };
  try {
    await fn();
  } catch (e) {
    cur.status = "FAIL";
    cur.error = String(e.message ?? e).slice(0, 900);
  }
  results.push(cur);
  console.error(`${cur.status === "PASS" ? "  ok  " : "  FAIL"} ${id} ${title}${cur.error ? `\n        ${cur.error}` : ` (${cur.checks} checks)`}`);
}

// --- the work item: requirements accepted on the page's channel, then the prototype as the agent writes it ---------------------
const screenOf = (feed, extra = []) => ({ ...F.screen, elements: [...F.header, feed, ...F.footer, ...extra] });
function chatPrototype(extra = []) {
  return { kind: "ui", title: "Журнал агронома: лента в виде чата", startScreen: "journal", styles: F.styles, mock: [F.mock.notes, F.mock.attachments, F.mock.fields], datasets: F.datasets, screens: [screenOf(F.chat.feed, extra)], scenarios: F.chat.scenarios, limitations: ["Голосовые заметки воспроизводятся как имитация: в прототипе нет звука.", "Фото во вложениях показаны заглушками с именем файла."] };
}
function reportedPrototype() {
  const rows = F.mock.notes.rows.map((n) => ({ id: n.id, author: n.author, side: n.author === ME ? "Исходящее" : "Входящее", created: n.createdAt.slice(11), voice: n.voice ? `Да (${n.voice} с)` : "Нет", text: n.text, attachments: F.mock.attachments.rows.filter((a) => a.noteId === n.id).map((a) => a.name).join(", ") || null, date: n.createdAt.slice(0, 10), field: n.field, kind: n.kind }));
  const s = screenOf(F.reported.feed);
  s.elements = s.elements.map((e) => (e.id === "card" ? { ...e, detailFields: [{ field: "date" }, { field: "created" }, { field: "author" }, { field: "text" }] } : e));
  return { kind: "ui", title: "Журнал агронома", startScreen: "journal", styles: F.styles, notes: F.reported.notes, mock: [{ ...F.reported.mock, rows }, F.mock.attachments, F.mock.fields], screens: [s] };
}
function workItem(prototype) {
  const repo = mkdtempSync(join(tmpdir(), "praxis-patterns-"));
  const id = applyRuntimeCommand(repo, F.open).workItemId;
  applyRuntimeCommand(repo, F.repository, id);
  for (const r of F.requirements) applyRuntimeCommand(repo, { action: "add-requirement", ...r }, id);
  applyRuntimeCommand(repo, F.impact, id);
  applyRuntimeCommand(repo, { action: "accept-requirements", via: "html-review" }, id, { via: "html-review" });
  applyRuntimeCommand(repo, { action: "advance-phase", to: "prototype" }, id);
  applyRuntimeCommand(repo, { action: "set-prototype", prototype, summary: "browser acceptance" }, id);
  return { repo, id, state: () => loadWorkflow(repo, id) };
}
async function link(wi) {
  const r = await renderReviewTool(wi.repo, { view: "prototype", workItemId: wi.id, reopen: true });
  return { url: readFileSync(join(reviewDir(wi.repo, wi.id), "prototype.url"), "utf8").trim(), port: new URL(r.url).port, file: r.file };
}

const browser = await chromium.launch({ executablePath: chromePath, headless: true });
const outside = [];
async function tab(width, height, port) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  // nothing may leave the machine; requests to the review server itself are allowed and listed
  const seen = [];
  await ctx.route("**/*", (route) => {
    const u = route.request().url();
    seen.push({ url: u, frame: route.request().frame()?.url() ?? "" });
    if (u.startsWith(`http://127.0.0.1:${port}/`) || u.startsWith("about:") || u.startsWith("data:")) return route.continue();
    outside.push(u);
    return route.abort();
  });
  return { ctx, page, errors, seen };
}

/** The report's acceptance scenario, measured on the rendered page. Returns the criteria that fail. */
async function acceptance(page, phone) {
  return page.evaluate(
    ({ ME, phone }) => {
      const fail = [];
      const feedEl = document.querySelector('[data-el="journal#feed"]');
      if (!feedEl) return ["the note feed is missing"];
      const box = (n) => n.getBoundingClientRect();
      const visible = (n) => !!n && box(n).width > 0 && box(n).height > 0 && getComputedStyle(n).visibility !== "hidden";
      if (!visible(document.querySelector('[data-el="journal#tabs"]')) || !visible(document.querySelector('select[data-filter="field"]')) || !visible(document.querySelector('select[data-filter="type"]')) || !visible(document.querySelector("[data-search]")) || document.querySelector("#proto-screen h2")?.textContent !== "Журнал агронома")
        fail.push("existing header and controls remain");
      if (feedEl.querySelector("table,tr,th,[role=table],[role=grid]")) fail.push("the feed is NOT a table");
      const msgs = [...feedEl.querySelectorAll("li.cv-msg")];
      if (msgs.length !== 12 || !msgs.every((m) => m.querySelector(".cv-b"))) fail.push("notes render as message bubbles");
      const times = msgs.map((m) => m.querySelector("time")?.getAttribute("datetime") ?? "");
      if (times.join() !== [...times].sort().join()) fail.push("chronological");
      const feed = feedEl.querySelector(".cv-feed");
      if (!feed) return fail;
      // alignment is measured, not read from a class: incoming bubbles share one left edge, outgoing ones one right edge at the
      // feed's edge that no incoming one reaches, and a short message sits on its own half of the feed
      const fb = box(feed);
      const edges = msgs.map((m) => {
        const b = box(m.querySelector(".cv-b"));
        return { id: m.getAttribute("data-row"), out: m.getAttribute("data-author") === ME, left: b.left - fb.left, right: fb.right - b.right, width: b.width, center: (b.left + b.right) / 2 - (fb.left + fb.right) / 2 };
      });
      const ins = edges.filter((e) => !e.out), outs = edges.filter((e) => e.out);
      const same = (list, k) => list.every((e) => Math.abs(e[k] - list[0][k]) <= 1);
      const short = edges.filter((e) => e.width < fb.width * 0.5);
      if (!ins.length || !outs.length || !same(ins, "left") || ins[0].left > 60 || !same(outs, "right") || outs[0].right > 30 || Math.min(...ins.map((e) => e.right)) < outs[0].right + 4 || !short.every((e) => (e.out ? e.center > 0 : e.center < 0)))
        fail.push(`incoming left, outgoing right (${JSON.stringify(edges.map((e) => [e.id, Math.round(e.left), Math.round(e.right)]))})`);
      if (!phone && edges.some((e) => e.width > fb.width * 0.72)) fail.push("desktop bubble at most about two thirds of the feed");
      for (const m of msgs.filter((x) => x.classList.contains("first"))) {
        m.scrollIntoView();
        const who = m.querySelector(".cv-who"), time = m.querySelector("time");
        if (!visible(who) || who.textContent !== m.getAttribute("data-author") || !visible(time) || !/^\d{2}:\d{2}$/.test(time.textContent) || parseFloat(getComputedStyle(time).fontSize) < 10) { fail.push("author and timestamp readable"); break; }
      }
      const voice = feedEl.querySelector('li[data-row="N-105"]');
      if (!visible(voice?.querySelector("button.cv-play")) || !/mock/i.test(voice.querySelector(".cv-mock")?.textContent ?? "")) fail.push("voice: playback control, marked as a mock");
      const att = feedEl.querySelectorAll('li[data-row="N-107"] [data-att]');
      if (att.length !== 2 || ![...att].every(visible)) fail.push("attachments represented");
      if (feedEl.querySelectorAll(".cv-day").length !== 3) fail.push("date separators");
      if (!(feed.scrollHeight > feed.clientHeight)) fail.push("the feed scrolls");
      if (document.documentElement.scrollWidth > window.innerWidth + 1) fail.push(`no horizontal overflow (${document.documentElement.scrollWidth} > ${window.innerWidth})`);
      const compose = feedEl.querySelector(".cv-compose");
      if (!visible(compose) || box(compose).top < box(feed).bottom - 1) fail.push("composer under the feed");
      return fail;
    },
    { ME, phone },
  );
}

const chat = workItem(chatPrototype());
const before = JSON.stringify(chat.state().prototype);

await scenario("P01", "Journal chat at desktop width: every criterion of the acceptance scenario, filters, tabs, deep link, Back, the note card", async () => {
  const { url, port } = await link(chat);
  const { ctx, page, errors } = await tab(1440, 1000, port);
  await page.goto(url);
  await page.waitForSelector("li.cv-msg");
  // opened at the newest message, like a chat
  const scroll = await page.locator(".cv-feed").evaluate((f) => ({ top: f.scrollTop, max: f.scrollHeight - f.clientHeight }));
  check(scroll.max > 0 && Math.abs(scroll.top - scroll.max) <= 2, `the feed opens at the newest message (${scroll.top} of ${scroll.max})`);
  check(await page.locator('li[data-row="N-112"]').isVisible(), "the newest message is in view");
  if (shots) await page.locator("#proto-frame").screenshot({ path: join(shots, "P01-desktop.png"), style: SHOT_STYLE });
  eq(await acceptance(page, false), [], "acceptance criteria that fail at desktop width");
  // voice: plays and stops in place
  const play = page.locator('li[data-row="N-105"] button.cv-play');
  await play.scrollIntoViewIfNeeded();
  await play.click();
  eq(await play.getAttribute("aria-pressed"), "true", "the mock player plays");
  check(await page.locator('li[data-row="N-105"] .cv-voice[data-playing]').count() === 1, "the waveform shows the playback");
  if (shots) await page.locator('li[data-row="N-105"]').screenshot({ path: join(shots, "P01-voice-playing.png"), style: SHOT_STYLE });
  await play.click();
  eq(await play.getAttribute("aria-pressed"), "false", "and stops");
  check(!(await page.evaluate(() => location.hash)).includes("note="), "the player does not open the card");
  // filters and tabs
  await page.selectOption('select[data-filter="field"]', "Поле 7");
  eq(await page.locator("li.cv-msg").evaluateAll((l) => l.map((x) => x.getAttribute("data-row"))), ["N-105", "N-106", "N-107", "N-108", "N-109"], "field filter narrows the chat");
  await page.selectOption('select[data-filter="type"]', "Задача");
  eq(await page.locator("li.cv-msg").count(), 1, "type filter narrows it further");
  eq(decodeURIComponent(await page.evaluate(() => location.hash)), "#/journal?field=Поле 7&type=Задача", "both live in the address");
  await page.goBack();
  await page.waitForFunction(() => document.querySelectorAll("li.cv-msg").length === 5);
  check(true, "Back returns to the field filter alone");
  await page.click('button[data-tab="fields"]');
  eq(await page.locator('[data-el="journal#feed"]').count(), 0, "the Fields tab hides the feed");
  eq(await page.locator('[data-el="journal#fieldsTable"] tr[data-row]').count(), 3, "and shows the fields table");
  await page.click('button[data-tab="journal"]');
  // the note card
  await page.click('li[data-row="N-107"] .cv-text');
  const card = page.locator('[data-overlay="journal#card"]');
  eq(await card.getAttribute("data-state"), "open", "a click on a message opens the note card");
  check((await card.textContent()).includes("skhema-ochagov.png"), "the card lists the attachments");
  if (shots) await page.locator("#proto-frame").screenshot({ path: join(shots, "P01-card.png"), style: SHOT_STYLE });
  await page.keyboard.press("Escape");
  eq(await card.count(), 0, "Escape closes it");
  eq(await page.evaluate(() => document.activeElement?.getAttribute("data-row")), "N-107", "focus returns to the message");
  // deep link
  const deep = await ctx.newPage();
  await deep.goto(`${url}#/journal?field=${encodeURIComponent("Поле 12")}`);
  check((await deep.locator('[data-el="journal#feed"]').textContent()).includes("Нет записей по выбранным условиям."), "a deep link to an empty field shows the empty feed");
  await deep.click("text=Сбросить фильтры");
  eq(await deep.locator("li.cv-msg").count(), 12, "and its reset shows every note again");
  eq(errors, [], "no script errors");
  await ctx.close();
});

await scenario("P02", "Journal chat at phone width: the acceptance scenario, the composer, Inspect, Review, Save and acceptance", async () => {
  const { url, port } = await link(chat);
  const { ctx, page, errors } = await tab(390, 844, port);
  await page.goto(url);
  await page.click('#pv-vp button[data-vp="mobile"]');
  await page.waitForSelector("li.cv-msg");
  eq(await acceptance(page, true), [], "acceptance criteria that fail at phone width");
  const widths = await page.locator("li.cv-msg .cv-b").evaluateAll((l) => l.map((b) => b.getBoundingClientRect().width));
  const feedW = await page.locator(".cv-feed").evaluate((f) => f.clientWidth);
  check(Math.max(...widths) > feedW * 0.8, `on a phone a long message takes almost the whole width (${Math.round(Math.max(...widths))} of ${feedW})`);
  if (shots) await page.locator("#proto-frame").screenshot({ path: join(shots, "P02-phone.png"), style: SHOT_STYLE });
  // composer
  await page.fill('[data-fk="compose:journal#feed"]', "Проверю краевые ряды через три дня.");
  await page.keyboard.press("Enter");
  const last = page.locator("li.cv-msg").last();
  eq(await last.getAttribute("data-side"), "out", "the new message is outgoing");
  check((await last.textContent()).includes("Проверю краевые ряды через три дня."), "and carries the text");
  check(await last.isVisible(), "the feed scrolled to it");
  const lb = await last.locator(".cv-b").boundingBox(), fb = await page.locator(".cv-feed").boundingBox();
  check(fb.x + fb.width - (lb.x + lb.width) < 30, "it sits on the right");
  if (shots) await page.locator("#proto-frame").screenshot({ path: join(shots, "P02-phone-sent.png"), style: SHOT_STYLE });
  // Inspect, Review, Save
  await page.click('#pv-mode button[data-mode="inspect"]');
  // in Inspect and Review a click where a message is lands on the feed element as a whole (its inside does not take clicks)
  await page.locator('li[data-row="N-104"]').click({ force: true });
  const inspector = await page.locator("#pv-inspector").textContent();
  check(inspector.includes("REQ-JRN-001") && inspector.includes("REQ-JRN-002-AC-02"), "Inspect shows the requirements and criteria of the feed");
  check(!(await page.evaluate(() => location.hash)).includes("note="), "Inspect does not operate the prototype");
  await page.click('#pv-mode button[data-mode="review"]');
  await page.locator('li[data-row="N-104"]').click({ force: true });
  await page.fill('textarea[data-fb="journal#feed"]', "Разделитель дат сделать заметнее");
  await page.check("#accept-proto");
  eq(chat.state().prototype.feedback.length, 0, "nothing is written before Save");
  await page.click("#btn-save");
  await page.waitForFunction(() => /Saved/.test(document.querySelector("#toast")?.textContent ?? ""));
  const s = chat.state();
  eq(s.prototype.feedback.map((f) => [f.target, f.comment]), [["journal#feed", "Разделитель дат сделать заметнее"]], "the comment is saved against the feed");
  eq(s.phaseAcceptance.prototype?.via, "html-review", "accepted by the user's Save");
  eq(s.prototype.revision, 1, "reviewing does not make a new revision");
  const { feedback: _f, status: _s, ...after } = s.prototype;
  const { feedback: _bf, status: _bs, ...was } = JSON.parse(before);
  eq(JSON.stringify(after), JSON.stringify(was), "using the prototype (the new message included) did not change it");
  eq(errors, [], "no script errors");
  await ctx.close();
});

await scenario("P03", "The same measurement on the reported table fails it: the check tells a table from a chat", async () => {
  const wi = workItem(reportedPrototype());
  const { url, port } = await link(wi);
  const { ctx, page } = await tab(1440, 1000, port);
  await page.goto(url);
  await page.waitForSelector('[data-el="journal#feed"] table');
  const failed = await acceptance(page, false);
  check(failed.includes("the feed is NOT a table"), `the table is recognised as a table (${failed.join("; ")})`);
  check(failed.includes("notes render as message bubbles"), "and as not being bubbles");
  if (shots) await page.locator("#proto-frame").screenshot({ path: join(shots, "P03-reported-table.png"), style: SHOT_STYLE });
  await ctx.close();
});

// --- custom ----------------------------------------------------------------------------------------------------------------------
const HOSTILE = String.raw`
var out=document.getElementById('report'),r={};
function done(k,v){r[k]=v;out.textContent=JSON.stringify(r)}
try{done('parentDocument',String(parent.document.body.innerHTML.length))}catch(e){done('parentDocument','blocked')}
try{done('token',parent.document.getElementById('praxis-data').textContent.slice(0,20))}catch(e){done('token','blocked')}
try{top.location.href='https://example.test/phish';done('topNavigation','allowed')}catch(e){done('topNavigation','blocked')}
try{done('popup',window.open('https://example.test/')?'opened':'blocked')}catch(e){done('popup','blocked')}
try{localStorage.setItem('x','1');done('storage','allowed')}catch(e){done('storage','blocked')}
try{done('cookie',document.cookie)}catch(e){done('cookie','blocked')}
fetch(REVIEW+'/submit',{method:'POST',headers:{'content-type':'application/json'},body:'{"prototype":{"accept":true}}'}).then(function(){done('fetchReview','sent')},function(){done('fetchReview','blocked')});
fetch('https://example.test/x').then(function(){done('fetchOutside','sent')},function(){done('fetchOutside','blocked')});
var img=new Image();img.onload=function(){done('image','loaded')};img.onerror=function(){done('image','blocked')};img.src='https://example.test/pixel.png';
var f=document.createElement('form');f.action='https://example.test/form';f.method='post';document.body.appendChild(f);try{f.submit();done('form','called, no error')}catch(e){done('form','blocked')}
// it tries to decide for the person, and to pick a part nobody clicked
parent.postMessage({type:'praxis:accept'},'*');parent.postMessage({type:'praxis:save',comment:'spoof'},'*');
setInterval(function(){parent.postMessage({type:'praxis:pick',part:'legend'},'*')},150);
// it takes the keyboard focus without being clicked, and asks for the full screen when clicked
setTimeout(function(){window.focus();document.getElementById('trap').focus();done('focusTaken',document.hasFocus())},400);
setInterval(function(){if(!document.hasFocus()){window.focus();document.getElementById('trap').focus()}},1000);
document.addEventListener('click',function(){try{document.documentElement.requestFullscreen().then(function(){done('fullscreen','entered')},function(){done('fullscreen','blocked')})}catch(e){done('fullscreen','blocked')}});
praxis.onData=function(d){document.getElementById('count').textContent=(d.rows.notes||[]).length+' notes; field='+(d.query.field||'all')};
`;
const BOARD = {
  id: "board",
  kind: "custom",
  label: "Доска по полям",
  collection: "notes",
  filters: [{ param: "field", field: "field" }],
  showWhen: { param: "tab", equals: "journal" },
  custom: {
    reason: "A board with a column of cards per field: no structured element shows columns of cards.",
    html: '<h3 data-praxis-part="legend">Легенда доски</h3><p id="count">no data yet</p><pre id="report"></pre><input id="trap" aria-label="trap"><img src="https://example.test/inline.png" alt="">',
    css: "body{padding:8px}#report{white-space:pre-wrap;font-size:11px}",
    script: "",
    height: 240,
    parts: [{ id: "legend", label: "Легенда доски", requirementIds: ["REQ-JRN-003"], acIds: ["REQ-JRN-003-AC-01"] }],
  },
};
const hostile = (review) => [{ ...BOARD, custom: { ...BOARD.custom, script: `var REVIEW=${JSON.stringify(review)};${HOSTILE}` } }, NAV("https://example.test")];
/** A part that tries to leave: it navigates its own frame, by script and by a meta refresh, to the given address. */
const NAV = (to) => ({ id: "nav", kind: "custom", label: "Уход со страницы", custom: { reason: "probe", height: 120, html: `<meta http-equiv="refresh" content="1;url=${to}/meta-refresh"><p id="stay">still here</p>`, script: `setTimeout(function(){location.href=${JSON.stringify(to + "/self-nav?q=1")}},300)` } });

await scenario("P04", "Custom part in the served page: hostile script cannot reach the page, its token, the review server or the network", async () => {
  // the frame is told the real review address; it does not get the save token
  const wi = workItem(chatPrototype(hostile("http://127.0.0.1:0/r/0")));
  const { url, port } = await link(wi);
  applyRuntimeCommand(wi.repo, { action: "update-prototype", operations: [{ op: "update-element", screenId: "journal", id: "board", patch: { custom: { ...BOARD.custom, script: `var REVIEW=${JSON.stringify(new URL(url).origin + new URL(url).pathname)};${HOSTILE}` } } }], summary: "real address" }, wi.id);
  const fresh = await link(wi);
  const { ctx, page, errors, seen } = await tab(1440, 1000, fresh.port);
  const hrefBefore = fresh.url;
  await page.goto(fresh.url);
  const frame = page.frameLocator('iframe[data-frame="journal#board"]');
    await frame.locator("#report").filter({ hasText: "image" }).waitFor({ timeout: 8000 });
  // The person types in the page while the part keeps taking the focus: every attempt is undone and the text arrives in the page.
  // (Under automation Chrome reports a user activation all the time, so the "no activation" half of the focus guard is not tested here.)
  await page.focus("[data-search]");
  const typed = "известкование почвы";
  await page.keyboard.type(typed, { delay: 150 });
  await page.waitForTimeout(300);
  eq(await page.evaluate(() => document.activeElement?.getAttribute("data-search")), "find", "the search box still has the focus after typing");
  eq(await page.inputValue("[data-search]"), typed, "every keystroke reached the page, not the part");
  check((await page.locator('[data-custom-cap="journal#board"] .stolen').count()) === 1, "the page says above the part that it tried to take the focus");
  await page.fill("[data-search]", "");
  await page.waitForTimeout(1600); // within 1.5 s of typing in the page, the page keeps the keyboard focus even on a click into a part
  await frame.locator("#count").click();
  await page.waitForTimeout(400);
  eq(await page.evaluate(() => document.activeElement?.getAttribute("data-frame")), "journal#board", "a click into the part gives it the focus");
  const report = JSON.parse(await frame.locator("#report").textContent());
  eq({ ...report, focusTaken: undefined }, { parentDocument: "blocked", token: "blocked", topNavigation: "blocked", popup: "blocked", storage: "blocked", cookie: "blocked", form: report.form, fetchReview: "blocked", fetchOutside: "blocked", image: "blocked", focusTaken: undefined, fullscreen: "blocked" }, "what the frame could do");
  check(!(await page.evaluate(() => !!document.fullscreenElement)), "the page is not in full screen");
  check(!seen.some((r) => /self-nav|meta-refresh/.test(r.url)), "the part that navigates its own frame did not get out");
  check(page.url() === hrefBefore, "the page was not navigated");
  check(!seen.some((r) => /example\.test/.test(r.url)), `no request to the outside was even attempted past the policy (${seen.filter((r) => /example/.test(r.url)).map((r) => r.url)})`);
  check(!seen.some((r) => r.url.endsWith("/submit")), "nothing reached the review server's save address");
  eq(await frame.locator("#count").textContent(), "12 notes; field=all", "the part received the mock rows and the address as data");
  await page.selectOption('select[data-filter="field"]', "Поле 7");
  await frame.locator("#count").filter({ hasText: "5 notes" }).waitFor({ timeout: 4000 });
  check(true, "and follows the native filter");
  const s = wi.state();
  eq([s.prototype.feedback.length, s.phaseAcceptance.prototype ?? null], [0, null], "the frame's messages recorded nothing");
  eq(await page.isChecked("#accept-proto"), false, "and ticked nothing");
  eq(await page.locator("#pv-inspector").textContent(), "Switch to Inspect and click anything in the prototype to see which requirement and criteria it covers.", "picks sent in Preview are ignored");
  if (shots) await page.locator('[data-el="journal#board"]').screenshot({ path: join(shots, "P04-custom-hostile.png"), style: SHOT_STYLE });
  eq(errors, [], "no script errors in the page");
  await ctx.close();
});

await scenario("P05", "Custom part in Inspect and Review: only a click into the frame selects a declared part; the comment is saved against it", async () => {
  const wi = workItem(chatPrototype([{ ...BOARD, custom: { ...BOARD.custom, script: "praxis.onData=function(d){document.getElementById('count').textContent=(d.rows.notes||[]).length+' notes'}" } }]));
  const { url, port } = await link(wi);
  const { ctx, page, errors } = await tab(1440, 1000, port);
  await page.goto(url);
  const frame = page.frameLocator('iframe[data-frame="journal#board"]');
  await frame.locator("#count").filter({ hasText: "12 notes" }).waitFor();
  await page.click('#pv-mode button[data-mode="inspect"]');
  await frame.locator('[data-praxis-part="legend"]').click();
  await page.locator("#pv-inspector").filter({ hasText: "Легенда доски" }).waitFor({ timeout: 4000 });
  const inspector = await page.locator("#pv-inspector").textContent();
  check(inspector.includes("REQ-JRN-003-AC-01") && inspector.includes("part of the custom element"), "Inspect shows the part and its criterion");
  await frame.locator("#count").click();
  await page.locator("#pv-inspector").filter({ hasText: "Praxis does not check its behaviour or look" }).waitFor({ timeout: 4000 });
  check(true, "a click outside the declared parts selects the custom element, and says Praxis does not check it");
  await page.click('#pv-mode button[data-mode="review"]');
  await frame.locator('[data-praxis-part="legend"]').click();
  await page.waitForSelector('textarea[data-fb="journal#board@legend"]');
  await page.fill('textarea[data-fb="journal#board@legend"]', "Легенду перенести вниз");
  if (shots) await page.locator(".pv-grid").screenshot({ path: join(shots, "P05-custom-review.png"), style: SHOT_STYLE });
  await page.click("#btn-save");
  await page.waitForFunction(() => /Saved/.test(document.querySelector("#toast")?.textContent ?? ""));
  eq(wi.state().prototype.feedback.map((f) => f.target), ["journal#board@legend"], "the comment is saved against the part");
  eq(errors, [], "no script errors");
  await ctx.close();
});

await scenario("P06", "Offline copy (file, no server header): the page's and the frame's own policies keep the part off the network, navigation included", async () => {
  const hits = [];
  const probe = createServer((req, res) => {
    hits.push(req.url);
    res.writeHead(200, { "access-control-allow-origin": "*" });
    res.end("ok");
  });
  await new Promise((ok) => probe.listen(0, "127.0.0.1", ok));
  const probeUrl = `http://127.0.0.1:${probe.address().port}`;
  const script = `var r={};function d(k,v){r[k]=v;document.getElementById('report').textContent=JSON.stringify(r)}fetch('${probeUrl}/fetch').then(function(){d('fetch','sent')},function(){d('fetch','blocked')});var i=new Image();i.onload=function(){d('image','loaded')};i.onerror=function(){d('image','blocked')};i.src='${probeUrl}/img.png';`;
  const wi = workItem(chatPrototype([{ ...BOARD, custom: { ...BOARD.custom, html: '<pre id="report"></pre>', script } }, NAV(probeUrl)]));
  const { file } = await link(wi);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(pathToFileURL(file).href);
  const frame = page.frameLocator('iframe[data-frame="journal#board"]');
  await frame.locator("#report").filter({ hasText: "image" }).waitFor({ timeout: 8000 });
  await page.waitForTimeout(2000); // the navigating part has had time to leave, by script and by meta refresh
  eq(JSON.parse(await frame.locator("#report").textContent()), { fetch: "blocked", image: "blocked" }, "what the frame could reach from the offline copy");
  eq(hits, [], "requests that reached a local server (fetch, image, self-navigation, meta refresh)");
  await ctx.close();
  await new Promise((ok) => probe.close(ok));
});

await scenario("P07", "A part that spins its script for five seconds does not freeze the review page (Chrome runs it apart)", async () => {
  const wi = workItem(chatPrototype([{ ...BOARD, custom: { ...BOARD.custom, html: "<p>busy</p>", script: "setTimeout(function(){var t=Date.now();while(Date.now()-t<5000){}},300)" } }]));
  const { url, port } = await link(wi);
  const { ctx, page, errors } = await tab(1440, 1000, port);
  await page.goto(url);
  await page.waitForSelector('iframe[data-frame="journal#board"]');
  await page.waitForTimeout(600); // the part is now spinning
  const t0 = Date.now();
  await page.selectOption('select[data-filter="field"]', "Поле 7");
  await page.waitForFunction(() => document.querySelectorAll("li.cv-msg").length === 5, null, { timeout: 2000 });
  const ms = Date.now() - t0;
  check(ms < 2000, `the page answered while the part was busy (${ms} ms)`);
  eq(errors, [], "no script errors");
  await ctx.close();
});

await browser.close();
stopReviewServer();
const passed = results.filter((r) => r.status === "PASS").length;
const report = { generatedAt: new Date().toISOString(), chrome: chromePath.split("/").pop(), scenarios: results, outsideRequestsAborted: outside, summary: `${passed} of ${results.length} scenarios passed, ${results.reduce((n, r) => n + r.checks, 0)} checks` };
if (shots) writeFileSync(join(shots, "results.json"), JSON.stringify(report, null, 2));
console.error(report.summary);
process.exit(passed === results.length ? 0 : 1);
