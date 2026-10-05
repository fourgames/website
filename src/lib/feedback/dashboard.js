// The player feedback dashboard behind /fb-dash (src/views/FeedbackView.vue). Plain DOM code, loaded
// only when that page opens, so the rest of the site never ships it. It reads feedback/data straight
// from the repo (written by .github/workflows/feedback.yml), so new data shows up without a deploy.
// Add ?data=<base url> to read another copy of the data, e.g. a local test run.
import CSS from "./dashboard.css?inline";

// The data is read from the newest commit that touched it (see dataBase), never from "main": raw
// GitHub caches a branch's files for minutes, so "main" can serve a stale copy.
const DATA_OVERRIDE = new URLSearchParams(location.search).get("data")?.replace(/\/$/, "");
const RAW = "https://raw.githubusercontent.com/fourgames/website";
let DATA = DATA_OVERRIDE || `${RAW}/main/feedback/data`;
const DAY = 86400;
const URGENCY = { urgent: "Urgent", high: "High", medium: "Medium", low: "Low" };
const KIND = { review: "Review", topic: "Thread", reply: "Reply" };
const state = { index: null, games: {}, game: null, tab: "overview", filters: { issues: { status: "active", q: "", sort: "priority" }, suggestions: { status: "active", q: "", sort: "priority" }, feed: { kind: "all", category: "all", q: "", shown: 50 }, stats: { range: 0 }, replies: { show: "open" }, media: { source: "all", shown: 30 }, sales: { range: 90 } }, sales: null };

const store = {
  get(k) { try { return localStorage.getItem("fb-dash:" + k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem("fb-dash:" + k, v); } catch {} },
  del(k) { try { localStorage.removeItem("fb-dash:" + k); } catch {} },
};

// DOM helper: h("div.card", {onclick}, child, "text"…). Text always goes in as text nodes.
function h(tag, props, ...kids) {
  const [name, ...classes] = tag.split(".");
  const el = document.createElement(name);
  if (classes.length) el.className = classes.join(" ");
  // A first argument that isn't a props object (text, a number like 0, a node, a list) is a child.
  if (props != null && (typeof props !== "object" || props instanceof Node || Array.isArray(props))) { kids.unshift(props); props = null; }
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className += " " + v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}
const svgEl = (tag, attrs = {}) => { const el = document.createElementNS("http://www.w3.org/2000/svg", tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); return el; };
const now = () => Math.floor(Date.now() / 1000);
const fmtDate = (t) => new Date(t * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
const fmtShort = (t) => new Date(t * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
function ago(t) {
  const s = now() - t;
  if (s < 3600) return Math.max(1, Math.round(s / 60)) + " min ago";
  if (s < DAY) return Math.round(s / 3600) + " h ago";
  if (s < 30 * DAY) return Math.round(s / DAY) + " d ago";
  return fmtDate(t);
}
// The same in words, for menus: "today", "yesterday", "2 days ago", "3 weeks ago"…
function agoWords(t) {
  const days = Math.floor((now() - t) / DAY);
  if (days < 1) return "today";
  if (days < 2) return "yesterday";
  const [n, unit] = days < 14 ? [days, "day"] : days < 60 ? [Math.round(days / 7), "week"] : days < 730 ? [Math.round(days / 30), "month"] : [Math.round(days / 365), "year"];
  return `${plural(n, unit)} ago`;
}
// Posted or reported in the last 48 hours: tagged "New", like recent posts on the rest of the site.
const isRecent = (t) => t && now() - t < 2 * DAY;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function toast(msg) {
  const el = document.getElementById("fb-toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove("show"), 1600);
}
async function copy(text, button) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h("textarea", { style: "position:fixed;opacity:0" }, text);
    document.body.append(ta); ta.select(); document.execCommand("copy"); ta.remove();
  }
  toast("Copied");
  if (button) { const old = button.textContent; button.textContent = "Copied ✓"; button.classList.add("done"); setTimeout(() => { button.textContent = old; button.classList.remove("done"); }, 1500); }
}

async function getJson(path) {
  const res = await fetch(`${DATA}/${path}`, { cache: "no-store", signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Ticking off bugs and ideas you've fixed, to get the bug count to 0. Saved in
// feedback/data/cleared.json ({appId: {issueId: {as: "fixed", at, title, note, release}}}, release
// being the gid of the update it's in, or null for the next one) so every browser sees it; the
// collecting workflow only reads that file, so the two never conflict. The site is static, so saving
// goes straight to GitHub's API with a fine-grained token you paste once per browser: the token is
// the password, and only someone who can write to the repo has one. "[skip ci]" keeps a save from
// redeploying the site. With ?data= (a test copy) nothing is saved.
// The next collecting run has Claude judge your line like a patch-notes line (feedback/run.py:
// apply_manual_fixes, which records its verdict in the game's manualFixes): a real fix becomes
// "likely fixed", with reply drafts (once the update is out) and "still happening" as after a
// release; anything less is "partly addressed" and back on the list.
// ---------------------------------------------------------------------------

const REPO_API = "https://api.github.com/repos/fourgames/website";
const CLEARED_PATH = "feedback/data/cleared.json";
const TOKEN_URL = "https://github.com/settings/personal-access-tokens/new?name=Feedback%20dashboard&target_name=fourgames&expires_in=366&contents=write";

// The files only the dashboard writes: what you marked fixed, your Claude credit, the games you
// want to bundle with and the games you compare with.
async function loadCleared() {
  const [cleared, credit, bundleWith, compareWith] = await Promise.allSettled([getJson("cleared.json"), getJson("credit.json"), getJson("bundles.json"), getJson("competitors.json")]);
  // None saved yet (or a test copy of the data without them): keep what's on screen.
  state.cleared = cleared.value || state.cleared || {};
  state.credit = credit.value || state.credit || null;
  state.bundleWith = bundleWith.value || state.bundleWith || {};
  state.compareWith = compareWith.value || state.compareWith || {};
}

// Steam's sales for every game (feedback/sales.py), one file; kept as it was if it can't be read.
async function loadSales() {
  try { state.sales = await getJson("sales.json"); } catch {}
}

const clearedEntry = (issue) => state.cleared?.[state.game.appId]?.[issue.id] || null;
const fixKey = (issue, c) => `${issue.id}@${c.at}`;
// The updates you can say a fix is in, newest first.
const releaseLabel = (r) => r.version ? `v${r.version}` : r.name;
const updates = () => (state.game.releases || []).slice().sort((a, b) => b.time - a.time);
const fixedWhere = (c) => {
  const r = c.release && updates().find((u) => u.gid === c.release);
  return r ? `in ${releaseLabel(r)}` : "in the next update";
};

// Your fix, while it's waiting for Claude (after that, Claude's verdict shows instead), and not once
// a player has reported it again.
function clearedAs(issue) {
  const c = clearedEntry(issue);
  if (!c || c.as === "wontfix" || issue.lastSeen > c.at) return null;
  return state.game.manualFixes?.[fixKey(issue, c)] ? null : c;
}
// Your fix, waiting for Claude or taken by Claude as the fix: the check button shows it ticked.
const ticked = (issue) => {
  const c = clearedEntry(issue);
  return !!(clearedAs(issue) || (c && issue.status === "likely_fixed" && issue.manualFix === fixKey(issue, c)));
};

const b64 = {
  encode: (text) => { let s = ""; for (const b of new TextEncoder().encode(text)) s += String.fromCharCode(b); return btoa(s); },
  decode: (data) => new TextDecoder().decode(Uint8Array.from(atob(data.replace(/\s/g, "")), (c) => c.charCodeAt(0))),
};

async function github(path, token, options = {}) {
  return fetch(path ? `${REPO_API}/${path}` : REPO_API, { ...options, cache: "no-store", signal: AbortSignal.timeout(15000),
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, ...(options.body ? { "Content-Type": "application/json" } : {}) } });
}

// A small form in a dialog. `check(form)` returns what to resolve with, or throws an Error whose
// message is shown; cancelling resolves to null.
function formDialog(title, body, submitLabel, check) {
  return new Promise((resolve) => {
    let result = null;
    const error = h("p.dlg-error", { hidden: true });
    const submit = h("button.btn.primary", { type: "submit" }, submitLabel);
    const form = h("form", h("h3", title), ...body, error,
      h("div.actions", h("button.btn", { type: "button", onclick: () => dlg.close() }, "Cancel"), submit));
    const dlg = h("dialog.fb-dialog", form);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      submit.disabled = true;
      error.hidden = true;
      try {
        result = await check(form);
        dlg.close();
      } catch (err) {
        error.textContent = err.name === "TimeoutError" ? "GitHub didn't answer; try again." : err.message;
        error.hidden = false;
        submit.disabled = false;
      }
    });
    dlg.addEventListener("close", () => { dlg.remove(); resolve(result); });
    document.querySelector(".fb:has(#fb-view)").append(dlg);
    dlg.showModal();
    form.querySelector("input, textarea")?.focus();
  });
}

function askToken() {
  const input = h("input.dlg-input", { type: "password", placeholder: "github_pat_…", autocomplete: "off", spellcheck: "false", required: true });
  return formDialog("Unlock clearing", [
    h("p", "Clearing saves to the website repo on GitHub, so it needs a GitHub token that can write to it. It's kept in this browser only."),
    h("ol",
      h("li", h("a", { href: TOKEN_URL, target: "_blank", rel: "noopener" }, "Create a fine-grained token ↗"), " with owner ", h("b", "fourgames"), ", only the ", h("b", "website"), " repository, and ", h("b", "Contents: Read and write"), "."),
      h("li", "Paste it here.")),
    input,
  ], "Unlock", async () => {
    const token = input.value.trim();
    const res = await github("", token);
    const repo = res.ok ? await res.json() : null;
    // Fine-grained tokens don't report their own permissions here; a save that's refused says so.
    if (!repo || repo.permissions?.push === false) throw new Error(res.status === 401 ? "GitHub doesn't accept that token." : "That token can't see the website repo.");
    store.set("token", token);
    return token;
  });
}

// What you changed and where, for Claude to judge like a patch-notes line.
function askFix(issue) {
  const note = h("textarea.dlg-input", { rows: 2, required: true }, `Fixed: ${issue.title}`);
  // Every update, older ones too: a player can report something on an old build after it was fixed
  // (feedback/run.py then counts the reports as from before the fix).
  const list = updates();
  const pick = h("select.dlg-select", { "aria-label": "Update", onchange: () => { out.checked = true; } },
    ...list.map((r) => h("option", { value: r.gid, title: `${r.name}, ${fmtDate(r.time)}` }, `${r.name} · ${agoWords(r.time)}`)));
  const next = h("input", { type: "radio", name: "fix-where", checked: true });
  const out = h("input", { type: "radio", name: "fix-where" });
  return formDialog("Mark fixed", [
    h("p.dlg-sub", issue.title),
    h("label.dlg-label", "What did you change?", note),
    h("p.dlg-hint", "Like a patch-notes line. Claude checks it against what players said."),
    h("div.dlg-label", "Where is the fix?"),
    h("label.dlg-opt", next, h("span", "In the next update ", h("span.dlg-hint", "(not out yet)"))),
    list.length ? h("label.dlg-opt", out, h("span", "Already out in"), pick) : null,
  ], "Mark fixed", () => {
    if (!note.value.trim()) throw new Error("Write what you changed first.");
    return { note: note.value.trim(), release: out.checked ? pick.value : null };
  });
}

// Marks an issue fixed (asking what and where), or undoes that. Shown at once, then saved.
async function setFixed(issue, fixed) {
  const fix = fixed ? await askFix(issue) : {};
  if (!fix) return;
  const as = fixed ? "fixed" : null;
  const appId = String(state.game.appId);
  const at = Math.max(now(), issue.lastSeen);
  await saveData("cleared", CLEARED_PATH, (data) => {
    const game = (data[appId] ||= {});
    if (as) game[issue.id] = { as, at, title: issue.title, ...fix };
    else delete game[issue.id];
    if (!Object.keys(game).length) delete data[appId];
    return data;
  }, `Feedback: ${as ? "fixed" : "reopen"} "${issue.title}" [skip ci]`, as ? "Marked fixed: Claude checks it within 5 min" : "Back on the list");
}

// Changes one of the files only the dashboard writes (state[key], saved at path in the repo): shown
// at once, then saved through GitHub's API with your token. When something else saved the file in
// between, GitHub refuses and it goes again; when saving fails, the change is taken back.
async function saveData(key, path, change, message, done) {
  const token = DATA_OVERRIDE ? "test" : store.get("token") || await askToken();
  if (!token) return;
  const before = structuredClone(state[key] || {});
  state[key] = change(structuredClone(before));
  redraw();
  toast(done);
  if (DATA_OVERRIDE) return toast("Test copy of the data: not saved");
  try {
    for (let attempt = 0; ; attempt++) {
      const res = await github(`contents/${path}?ref=main`, token);
      if (!res.ok && res.status !== 404) throw res;
      const file = res.ok ? await res.json() : null;
      const data = change(file ? JSON.parse(b64.decode(file.content)) : {});
      const put = await github(`contents/${path}`, token, { method: "PUT",
        body: JSON.stringify({ message, branch: "main", sha: file?.sha, content: b64.encode(JSON.stringify(data, null, 1) + "\n") }) });
      if (put.ok) {
        // Read the data from this commit on, so a refresh doesn't show the old file for a minute.
        const { commit } = await put.json();
        DATA = DATA_OVERRIDE || `${RAW}/${commit.sha}/feedback/data`;
        store.del("api");
        state[key] = data;
        return;
      }
      if (![409, 422].includes(put.status) || attempt >= 2) throw put;
    }
  } catch (err) {
    state[key] = before;
    redraw();
    if (err.status === 401 || err.status === 403 || err.status === 404) {
      store.del("token");
      toast("GitHub refused the token; try again to enter a new one");
    } else toast("Couldn't save to GitHub; try again");
  }
}

// Redraws in place after a change, keeping the scroll position.
function redraw() {
  const y = window.scrollY;
  renderStatus();
  render();
  window.scrollTo(0, y);
}


// A flag for a language: the country it's most associated with (a language isn't a country, but
// it reads at a glance). Reviews carry Steam's own language code; forum posts the name Claude gave.
const STEAM_LANG = {
  english: "gb", koreana: "kr", japanese: "jp", schinese: "cn", tchinese: "tw", german: "de", french: "fr",
  spanish: "es", latam: "mx", portuguese: "pt", brazilian: "br", russian: "ru", polish: "pl", italian: "it",
  turkish: "tr", ukrainian: "ua", dutch: "nl", swedish: "se", danish: "dk", norwegian: "no", finnish: "fi",
  czech: "cz", hungarian: "hu", romanian: "ro", thai: "th", vietnamese: "vn", indonesian: "id", greek: "gr",
  bulgarian: "bg", arabic: "sa",
};
const LANG_NAME = {
  english: "gb", korean: "kr", japanese: "jp", chinese: "cn", "simplified chinese": "cn", "chinese (simplified)": "cn",
  "traditional chinese": "tw", "chinese (traditional)": "tw", german: "de", french: "fr", spanish: "es",
  "latin american spanish": "mx", "spanish (latin america)": "mx", portuguese: "pt", "brazilian portuguese": "br",
  "portuguese (brazil)": "br", russian: "ru", polish: "pl", italian: "it", turkish: "tr", ukrainian: "ua", dutch: "nl",
  swedish: "se", danish: "dk", norwegian: "no", finnish: "fi", czech: "cz", hungarian: "hu", romanian: "ro", thai: "th",
  vietnamese: "vn", indonesian: "id", greek: "gr", bulgarian: "bg", arabic: "sa",
};
function flag(code) {
  return code ? [...code.toUpperCase()].map((c) => String.fromCodePoint(0x1f1a5 + c.charCodeAt(0))).join("") : "";
}
function langFlag(name, steamCode) {
  return flag(STEAM_LANG[steamCode] || LANG_NAME[(name || "").toLowerCase()]);
}
const withFlag = (name, steamCode) => [langFlag(name, steamCode), name].filter(Boolean).join(" ");

const ICONS = {
  issues: "M8 2l1.88 1.88M14.12 3.88 16 2M9 7.13v-1a3 3 0 1 1 6 0v1M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6M12 20v-9M6.53 9C4.6 8.8 3 7.1 3 5M6 13H2M3 21c0-2.1 1.7-3.9 3.8-4M20.97 5c0 2.1-1.6 3.8-3.5 4M22 13h-4M17.2 17c2.1.1 3.8 1.9 3.8 4",
  suggestions: "M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5M9 18h6M10 22h4",
  feed: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z",
  overview: "M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z",
  loved: "M19 14c1.5-1.5 3-3.2 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.8 0-3 .5-4.5 2-1.5-1.5-2.7-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4 3 5.5l7 7z",
  updates: "M12 19V5M5 12l7-7 7 7M4 21h16",
  replies: "M9 17H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v6M14 19l2 2 5-5",
  achievements: "M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0zM17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3",
  bundles: "M16.5 9.4 7.5 4.2M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16zM3.3 7 12 12l8.7-5M12 22V12",
  soon: "M6 11h4M8 9v4M15 12h.01M18 10h.01M17.32 5H6.68a4 4 0 0 0-3.98 3.59L2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.41-1.41A2 2 0 0 1 9.83 16h4.34a2 2 0 0 1 1.41.59L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3l-.7-7.41A4 4 0 0 0 17.32 5z",
  competitors: "M3 3v18h18M7 15l4-4 3 3 6-6",
  sales: "M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6",
  media: "M4.9 19.1C1 15.2 1 8.8 4.9 4.9M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5M19.1 4.9C23 8.8 23 15.1 19.1 19M14 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0",
};
function icon(name) {
  const svg = svgEl("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round", class: "icon", "aria-hidden": "true" });
  svg.append(svgEl("path", { d: ICONS[name] }));
  return svg;
}

// One-click filter buttons (replaces every dropdown).
function chips(options, value, onChange, label) {
  const group = h("div.chips", { role: "group", "aria-label": label });
  for (const [v, text] of options) {
    group.append(h("button", { type: "button", "aria-pressed": String(v === value), onclick: (e) => {
      group.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", "false"));
      e.currentTarget.setAttribute("aria-pressed", "true");
      onChange(v);
    } }, text));
  }
  return group;
}

// A small single-series trend line for the KPI cards.
function spark(values, color = "var(--fb-accent)") {
  const svg = svgEl("svg", { viewBox: "0 0 100 30", preserveAspectRatio: "none", class: "spark", "aria-hidden": "true" });
  if (values.length < 2 || !values.some((v) => v)) return svg;
  const max = Math.max(...values), min = Math.min(0, ...values);
  const pts = values.map((v, i) => [(i / (values.length - 1)) * 100, 28 - ((v - min) / (max - min || 1)) * 26]);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
  svg.append(svgEl("path", { d: `${line}L100,30L0,30Z`, fill: color, opacity: 0.14 }));
  svg.append(svgEl("path", { d: line, fill: "none", stroke: color, "stroke-width": 2, "vector-effect": "non-scaling-stroke", "stroke-linejoin": "round" }));
  return svg;
}
// Per-day values for the last `n` days.
function daily(n, valueOf) {
  const today = Math.floor(now() / DAY);
  return Array.from({ length: n }, (_, i) => valueOf((today - n + 1 + i) * DAY));
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

// Points DATA at the newest data commit and shows when it was made. Falls back to "main" if the
// GitHub API is unreachable or rate-limited (60 requests an hour per IP).
async function dataBase() {
  if (DATA_OVERRIDE) return;
  const read = (k) => { try { return JSON.parse(store.get(k)); } catch { return null; } };
  // A recent answer is reused, so refreshing the page doesn't ask GitHub again (unauthenticated
  // calls are limited to 60 an hour per connection).
  const cached = read("api");
  if (cached && Date.now() - cached.at < 60 * 1000) return applyApi(cached);
  // After a timeout or the hourly limit, skip the API until it's likely back, and load the data
  // straight from the repo instead of waiting each time.
  if ((read("apiDownUntil") || 0) > Date.now()) return cached ? applyApi(cached, true) : null;
  let limitedUntil = null;
  // GitHub's API sometimes hangs rather than failing; never wait more than a few seconds for it.
  const api = (path) => fetch(`https://api.github.com/repos/fourgames/website/${path}`, { cache: "no-store", signal: AbortSignal.timeout(5000) })
    .then((res) => {
      if (!res.ok) limitedUntil = Number(res.headers.get("x-ratelimit-reset")) * 1000 || Date.now() + 10 * 60 * 1000;
      return res.json();
    });
  // Both at once: the newest data commit, and whether the collecting workflow is running (data is
  // only committed when something changed, so its date alone can look stale).
  // And the newest site deploy, to say when the site was rebuilt (or that it's rebuilding now).
  const [commits, runs, deploys] = await Promise.allSettled([api("commits?path=feedback/data&per_page=1"), api("actions/workflows/feedback.yml/runs?per_page=1"),
    api("actions/workflows/static.yml/runs?per_page=1")]);
  const c = Array.isArray(commits.value) ? commits.value[0] : null;
  const run = runs.value?.workflow_runs?.[0];
  const deploy = deploys.value?.workflow_runs?.[0];
  if (!c?.sha) {
    store.set("apiDownUntil", JSON.stringify(limitedUntil || Date.now() + 5 * 60 * 1000));
    return cached ? applyApi(cached, true) : null;
  }
  const answer = {
    at: Date.now(),
    sha: c.sha,
    dataChanged: Date.parse(c.commit.committer.date) / 1000,
    checks: run ? { running: run.status !== "completed", ok: run.conclusion !== "failure", at: Date.parse(run.updated_at) / 1000 } : null,
    deploy: deploy ? { running: deploy.status !== "completed", ok: deploy.conclusion !== "failure", sha: deploy.head_sha.slice(0, 7),
      at: Date.parse(deploy.updated_at) / 1000, url: deploy.html_url } : null,
  };
  store.set("api", JSON.stringify(answer));
  applyApi(answer);
}

// Which data is on screen: its commit, and its own last-change time (for data straight from main).
const drawnKey = () => `${DATA}@${state.index?.changedAt || ""}`;

// Uses an API answer; an old one only for the times (its data commit may be outdated).
function applyApi(answer, stale = false) {
  if (!stale) DATA = `${RAW}/${answer.sha}/feedback/data`;
  state.dataChanged = answer.dataChanged;
  if (answer.checks) state.checks = answer.checks;
  if (answer.deploy) state.deploy = answer.deploy;
}

async function init() {
  await dataBase();
  try {
    state.index = await getJson("index.json");
  } catch (e) {
    document.getElementById("fb-updated").textContent = "No data yet: the feedback workflow hasn't committed anything. (" + e.message + ")";
    return;
  }
  await loadCleared();
  await loadSales();
  renderStatus();
  const games = state.index.games || [];
  const hash = new URLSearchParams(location.hash.slice(1));
  const wanted = Number(hash.get("app") || store.get("app"));
  state.tab = NAV.some(([, tabs]) => tabs.some(([id]) => id === hash.get("tab"))) ? hash.get("tab") : state.tab;
  if (games.length) pickGame(games.some((g) => g.appId === wanted) ? wanted : orderedGames()[0].appId);
}

// Brand marks for the service cards: Steam, Discord and GitHub as in the site's Icon.vue, Claude
// from the same source (Simple Icons, CC0).
const BRAND = {
  steam: "M11.98 0C5.68 0 .51 4.86.02 11.04l6.43 2.66c.55-.37 1.2-.59 1.92-.59h.19l2.86-4.14V8.9a4.53 4.53 0 1 1 4.52 4.53h-.1l-4.08 2.91v.16a3.4 3.4 0 0 1-6.72.67L.44 15.27A12 12 0 1 0 11.98 0zM7.54 18.21l-1.47-.61a2.55 2.55 0 1 0 1.42-3.34l1.52.63a1.88 1.88 0 1 1-1.47 3.32zm11.42-9.3a3.02 3.02 0 1 0-6.03 0 3.02 3.02 0 0 0 6.03 0zm-5.28 0a2.27 2.27 0 1 1 4.53 0 2.27 2.27 0 0 1-4.53 0z",
  discord: "M20.32 4.37a19.8 19.8 0 0 0-4.89-1.52.07.07 0 0 0-.08.04c-.21.38-.44.87-.61 1.25a18.27 18.27 0 0 0-5.49 0 12.64 12.64 0 0 0-.62-1.25.08.08 0 0 0-.08-.04 19.74 19.74 0 0 0-4.89 1.52.07.07 0 0 0-.03.03C.53 9.05-.32 13.58.1 18.06a.08.08 0 0 0 .03.05 19.9 19.9 0 0 0 5.99 3.03.08.08 0 0 0 .08-.03c.46-.63.87-1.3 1.23-1.99a.08.08 0 0 0-.04-.1 13.1 13.1 0 0 1-1.87-.9.08.08 0 0 1-.01-.12l.37-.3a.07.07 0 0 1 .08-.01c3.93 1.8 8.18 1.8 12.06 0a.07.07 0 0 1 .08.01l.37.3a.08.08 0 0 1-.01.12c-.6.35-1.22.65-1.87.9a.08.08 0 0 0-.04.1c.36.7.77 1.36 1.22 1.99a.08.08 0 0 0 .08.03 19.84 19.84 0 0 0 6.01-3.03.08.08 0 0 0 .03-.05c.5-5.18-.84-9.68-3.55-13.66a.06.06 0 0 0-.03-.03zM8.02 15.33c-1.18 0-2.16-1.09-2.16-2.42 0-1.33.96-2.42 2.16-2.42 1.21 0 2.18 1.1 2.16 2.42 0 1.33-.96 2.42-2.16 2.42zm7.97 0c-1.18 0-2.16-1.09-2.16-2.42 0-1.33.96-2.42 2.16-2.42 1.21 0 2.18 1.1 2.16 2.42 0 1.33-.95 2.42-2.16 2.42z",
  github: "M12 .3a12 12 0 0 0-3.8 23.38c.6.12.83-.26.83-.57L9 21.07c-3.34.72-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.08-.74.09-.73.09-.73 1.2.09 1.84 1.24 1.84 1.24 1.07 1.83 2.8 1.3 3.49 1 .1-.78.42-1.31.76-1.61-2.67-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.14-.3-.54-1.52.1-3.18 0 0 1-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.28-1.55 3.29-1.23 3.29-1.23.64 1.66.24 2.88.12 3.18a4.65 4.65 0 0 1 1.23 3.22c0 4.61-2.8 5.63-5.48 5.92.42.36.81 1.1.81 2.22l-.01 3.29c0 .31.2.69.82.57A12 12 0 0 0 12 .3",
  // Twitch and YouTube from the same source; news is a plain newspaper.
  twitch: "M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714Z",
  youtube: "M23.5 6.19a3.02 3.02 0 0 0-2.12-2.14C19.5 3.55 12 3.55 12 3.55s-7.5 0-9.38.5A3.02 3.02 0 0 0 .5 6.19C0 8.07 0 12 0 12s0 3.93.5 5.81a3.02 3.02 0 0 0 2.12 2.14c1.87.5 9.38.5 9.38.5s7.5 0 9.38-.5a3.02 3.02 0 0 0 2.12-2.14C24 15.93 24 12 24 12s0-3.93-.5-5.81zM9.55 15.57V8.43L15.82 12l-6.27 3.57z",
  news: "M4 4h13a1 1 0 0 1 1 1v1h2a1 1 0 0 1 1 1v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a1 1 0 0 1 1-1zm14 4v10a1 1 0 0 0 2 0V8zM6 7v4h5V7zm7 0v1.5h3V7zm0 2.5V11h3V9.5zM6 13v1.5h10V13zm0 3v1.5h10V16z",
  claude: "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z",
};

// The services each run uses (feedback/status.py): what they're for, what their "last" time means,
// and where a problem is fixed. GitHub (collecting and storing the data) is checked from here.
const SERVICES = {
  steam: ["Steam", "Reviews, players in game, store pages and update posts", "no new data yet", "https://github.com/fourgames/website/actions/workflows/feedback.yml", "See the runs"],
  forums: ["Discussions", "Threads, replies and comments on your announcements", "no new posts yet", "https://github.com/fourgames/website/actions/workflows/feedback.yml", "See the runs"],
  sales: ["Sales", "Revenue, units, refunds and countries per day, hourly (feedback/sales.py)", "no sales data yet", "https://github.com/fourgames/website/settings/secrets/actions", "GitHub secrets", "https://partner.steamgames.com/pub/groups/"],
  claude: ["Claude", "Translates posts, sorts them into bugs and ideas, matches patch notes", "nothing sorted yet", "https://platform.claude.com/settings/billing", "Add credit"],
  discord: ["Discord", "Pings you for new negative reviews and bug reports, urgent issues, flipped reviews and shared complaints", "no alerts sent yet", "https://github.com/fourgames/website/settings/secrets/actions", "GitHub secrets"],
  // Media (feedback/media.py). The last entry: where the key a missing secret needs is made.
  twitch: ["Twitch", "Who's streaming your games right now, checked every 5 min", "no streams yet", "https://github.com/fourgames/website/settings/secrets/actions", "GitHub secrets", "https://dev.twitch.tv/console/apps"],
  youtube: ["YouTube", "New videos about your games, about hourly", "no videos yet", "https://github.com/fourgames/website/settings/secrets/actions", "GitHub secrets", "https://console.cloud.google.com/apis/library/youtube.googleapis.com"],
  news: ["News", "Articles about your games on Google News, and articles, Reddit threads, web pages and download copies from your Google Alerts", "nothing found yet", "https://github.com/fourgames/website/actions/workflows/feedback.yml", "See the runs", "https://www.google.com/alerts"],
  github: ["GitHub", "Runs it all every 5 min, saves the data, rebuilds the site on store changes", "no changes yet", "https://github.com/fourgames/website/actions/workflows/feedback.yml", "See the runs"],
};

// ---------------------------------------------------------------------------
// What Claude costs. feedback/run.py counts every call's tokens per game, per day and per task
// (record_usage) and, once, estimates the time before counting started from the saved posts
// (estimate_past_usage); each game's summary is in index.json. The cost is estimated from the
// token counts at list price, which matches the bill when the collector is all that uses the key.
// Your credit: set it from the billing page (data/credit.json: {balance, at, spent}, `spent` being
// every game's counted cost then); what's left is that minus what's been counted since.
// ---------------------------------------------------------------------------

const TASKS = { sort: "Sorting posts", translate: "Translating your posts", patch: "Checking patch notes and your fixes", merge: "Merging duplicates", reply: "Drafting replies" };
const fmtTokens = (n) => n < 1000 ? String(Math.round(n)) : n < 1e6 ? `${Math.round(n / 1000)}k` : `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)}M`;
const fmtCost = (usd) => usd > 0 && usd < 0.01 ? "< $0.01" : `$${usd.toFixed(2)}`;
const isoDay = (t) => new Date(t * 1000).toISOString().slice(0, 10);
const claudeGames = () => (state.index?.games || []).filter((g) => g.claude);

// Cost per day, counted and estimated, for one game's summary or all of them.
function costDays(list = claudeGames().map((g) => g.claude)) {
  const days = {};
  for (const c of list) {
    for (const [d, v] of Object.entries(c.days || {})) (days[d] ||= { counted: 0, past: 0 }).counted += v;
    for (const [d, v] of Object.entries(c.past?.days || {})) (days[d] ||= { counted: 0, past: 0 }).past += v;
  }
  return days;
}
const totalCost = (c) => (c.cost || 0) + (c.past?.cost || 0);
const monthCost = (days) => Object.entries(days).filter(([d]) => d.startsWith(isoDay(now()).slice(0, 7))).reduce((n, [, v]) => n + v.counted + v.past, 0);
// The average day over the last two weeks (or since the first day with any cost, if sooner).
function dailyRate(days) {
  const first = Object.keys(days).sort()[0];
  if (!first) return 0;
  const span = Math.min(14, Math.max(1, Math.round((now() - Date.parse(first) / 1000) / DAY) + 1));
  const from = isoDay(now() - (span - 1) * DAY);
  return Object.entries(days).filter(([d]) => d >= from).reduce((n, [, v]) => n + v.counted + v.past, 0) / span;
}
function creditLeft() {
  if (!state.credit) return null;
  const counted = claudeGames().reduce((n, g) => n + (g.claude.cost || 0), 0);
  return state.credit.balance - (counted - (state.credit.spent || 0));
}
function lasts(left, rate) {
  if (!rate) return null;
  const days = left / rate;
  return days < 1 ? "runs out today" : days < 14 ? `lasts about ${plural(Math.round(days), "day")}` : days < 120 ? `lasts about ${plural(Math.round(days / 7), "week")}` : "lasts months";
}

// Under a game's name: what Claude has cost for it.
function gameCost(c) {
  if (!c) return null;
  const days = costDays([c]);
  const estimated = c.past?.cost ? ` Includes ≈ ${fmtCost(c.past.cost)} estimated for the time before counting started${c.since ? ` (${fmtDate(c.since)})` : ""}.` : "";
  return h("div.usage", { title: `${plural((c.calls || 0) + (c.past?.calls || 0), "Claude call")}, estimated at list price.${estimated}` },
    `Claude: ${fmtCost(totalCost(c))} total · ${fmtCost(monthCost(days))} this month · ${fmtTokens((c.input || 0) + (c.past?.input || 0))} tokens in, ${fmtTokens((c.output || 0) + (c.past?.output || 0))} out`);
}

// In the Claude card: credit left (or a button to set it) and what it's cost.
function claudeCard() {
  const days = costDays();
  const left = creditLeft();
  const credit = left == null
    ? h("button.linkish", { type: "button", onclick: setCredit }, "Set your credit to see what's left")
    : h(`div.svc-credit${left < 2 ? ".low" : ""}`, h("b", `≈ ${fmtCost(Math.max(left, 0))} left`), lasts(Math.max(left, 0), dailyRate(days)) ? ` · ${lasts(Math.max(left, 0), dailyRate(days))}` : "");
  return h("div.svc-cost", credit,
    claudeGames().length ? h("div", `${fmtCost(monthCost(days))} this month · ${fmtCost(claudeGames().reduce((n, g) => n + totalCost(g.claude), 0))} total`) : null,
    claudeGames().length ? h("span.kpi-more.svc-more", state.costsOpen ? "Hide chart ▴" : "Chart ▾") : null);
}

function setCredit() {
  const input = h("input.dlg-input", { type: "number", min: "0", step: "0.01", required: true, placeholder: "10.00", value: creditLeft() != null ? Math.max(creditLeft(), 0).toFixed(2) : null });
  formDialog("Your Claude credit", [
    h("p", "What your ", h("a", { href: "https://platform.claude.com/settings/billing", target: "_blank", rel: "noopener" }, "billing page ↗"), " shows as your credit balance now. Set it again whenever you top up; the dashboard counts down from it, and Discord pings you once when it's below $2."),
    h("label.dlg-label", "Credit balance ($)", input),
  ], "Save", () => {
    const balance = Number(input.value);
    if (!(balance >= 0)) throw new Error("Enter the amount, like 10.00.");
    return balance;
  }).then((balance) => {
    if (balance == null) return;
    const spent = claudeGames().reduce((n, g) => n + (g.claude.cost || 0), 0);
    saveData("credit", "feedback/data/credit.json", () => ({ balance, at: now(), spent: Math.round(spent * 1e6) / 1e6 }),
      `Feedback: Claude credit $${balance.toFixed(2)} [skip ci]`, "Credit saved");
  });
}

// Under the service cards: cost per day for the last 30 days, and per game and task.
function costPanel() {
  const days = costDays();
  const n = 30;
  const list = Array.from({ length: n }, (_, k) => { const d = isoDay(now() - (n - 1 - k) * DAY); return { d, ...(days[d] || { counted: 0, past: 0 }) }; });
  const max = Math.max(0.01, ...list.map((x) => x.counted + x.past));
  const W = 600, H = 120, bw = W / n;
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none", class: "cost-chart", role: "img", "aria-label": "Claude cost per day, last 30 days" });
  list.forEach((x, k) => {
    const hp = (x.past / max) * H, hc = (x.counted / max) * H;
    const g = svgEl("g");
    const title = svgEl("title");
    title.textContent = `${x.d}: ${fmtCost(x.counted + x.past)}${x.past ? ` (≈ ${fmtCost(x.past)} estimated)` : ""}`;
    g.append(title, svgEl("rect", { x: k * bw + 1, y: 0, width: bw - 2, height: H, class: "cost-hit" }));
    if (hp) g.append(svgEl("rect", { x: k * bw + 2, y: H - hp - hc, width: bw - 4, height: hp, class: "cost-past", rx: 2 }));
    if (hc) g.append(svgEl("rect", { x: k * bw + 2, y: H - hc, width: bw - 4, height: hc, class: "cost-bar", rx: 2 }));
    svg.append(g);
  });
  const rate = dailyRate(days);
  const stat = (label, value) => h("div.cost-stat", h("b", value), h("span", label));
  const games = claudeGames().slice().sort((a, b) => totalCost(b.claude) - totalCost(a.claude));
  const row = (g) => {
    const c = g.claude;
    const tasks = {};
    for (const src of [c.tasks || {}, c.past?.tasks || {}]) for (const [t, v] of Object.entries(src)) tasks[t] = (tasks[t] || 0) + v;
    return h("div.cost-game",
      h("div.cost-game-head", h("b", g.name), h("span", `${fmtCost(totalCost(c))} total · ${fmtCost(monthCost(costDays([c])))} this month`)),
      h("div.cost-tasks", ...Object.entries(tasks).sort((a, b) => b[1] - a[1]).map(([t, v]) => h("span", `${TASKS[t] || t} ${fmtCost(v)}`))));
  };
  const left = creditLeft();
  return h("section.cost-panel",
    h("div.cost-stats",
      stat("today", fmtCost((days[isoDay(now())]?.counted || 0) + (days[isoDay(now())]?.past || 0))),
      stat("a day, on average", fmtCost(rate)),
      stat("this month", fmtCost(monthCost(days))),
      left != null ? stat(lasts(Math.max(left, 0), rate) || "left", `≈ ${fmtCost(Math.max(left, 0))}`) : null),
    svg,
    h("div.cost-axis", h("span", fmtShort(Date.parse(list[0].d) / 1000)), h("span", "today")),
    h("p.cost-note", h("span.cost-key"), " counted  ", h("span.cost-key.past"), " estimated for the time before counting started (on the low side: it can't see posts sorted twice or failed calls)"),
    ...games.map(row),
    h("div.actions", h("button.btn", { type: "button", onclick: setCredit }, left == null ? "Set your credit" : "Update your credit"),
      h("a.btn.link-btn", { href: "https://platform.claude.com/settings/billing", target: "_blank", rel: "noopener" }, "Billing ↗")));
}

// In the page header: a card per service, saying whether it works and when it last did something.
function renderStatus() {
  const el = document.getElementById("fb-status");
  if (!el || !state.index) return;
  const status = { ...(state.index.status || {}) };
  // GitHub's state comes from the workflow runs (unknown when its API limit is used up); its last
  // change from the data itself, or the newest data commit.
  // The last known run state is kept for an hour, so a page load during GitHub's hourly API limit
  // still shows it.
  if (state.checks) store.set("checks", JSON.stringify({ ...state.checks, seen: now() }));
  let kept = null;
  try { kept = JSON.parse(store.get("checks")); } catch {}
  const checks = state.checks || (kept && now() - kept.seen < 3600 ? kept : null);
  status.github = {
    ok: checks ? checks.running || checks.ok : undefined,
    message: checks && !checks.running && !checks.ok ? "The collecting workflow stopped with an error." : null,
    since: checks?.at,
    active: Math.max(state.index.changedAt || 0, state.dataChanged || 0) || null,
    activeWhat: "data changed",
  };
  const kindOf = (key) => { const s = status[key]; return !s || s.ok === undefined ? "idle" : s.ok ? "ok" : "bad"; };
  const brandMark = (key) => {
    const mark = svgEl("svg", { viewBox: "0 0 24 24", class: "svc-mark", "aria-hidden": "true", fill: "currentColor" });
    mark.append(svgEl("path", { d: BRAND[key === "forums" || key === "sales" ? "steam" : key], "fill-rule": key === "news" ? "evenodd" : "nonzero" }));
    return mark;
  };
  const STATE = { ok: "Working", bad: "Needs attention", idle: "Unknown" };
  // Folded into one line while everything works (they're mostly a distraction then); open by
  // themselves when anything needs attention, or when you've opened them (remembered).
  const keys = Object.keys(SERVICES);
  const bad = keys.filter((k) => kindOf(k) === "bad");
  const open = bad.length > 0 || store.get("statusOpen") === "1";
  const toggleAll = () => {
    store.set("statusOpen", open ? "0" : "1");
    if (open) state.costsOpen = false;
    renderStatus();
  };
  if (!open) {
    const working = keys.filter((k) => kindOf(k) === "ok").length;
    const unknown = keys.filter((k) => kindOf(k) === "idle").map((k) => SERVICES[k][0]);
    el.replaceChildren(h("button.svc-bar", { type: "button", "aria-expanded": "false", onclick: toggleAll },
      h("span.svc-bar-items", ...keys.map((k) => h(`span.svc-chip.svc-${kindOf(k)}`, { title: `${SERVICES[k][0]}: ${STATE[kindOf(k)]}` }, brandMark(k), h("span.svc-dot")))),
      h("span.svc-bar-note", working === keys.length ? `All ${keys.length} working` : `${working} of ${keys.length} working${unknown.length ? ` · ${unknown.join(", ")} unknown` : ""}`,
        status.github.active ? ` · data changed ${ago(status.github.active)}` : ""),
      h("span.svc-bar-more", "Details ▾")));
    return;
  }
  const card = ([key, [name, what, none, href, action, keyPage]]) => {
    const s = status[key];
    const kind = kindOf(key);
    // Out of credit is the one with a fix behind a button; other services link to where they're fixed.
    const fix = key === "claude" && s && !/credit/i.test(s.message || "") ? ["https://platform.claude.com/settings/keys", "API keys"] : [href, action];
    const mark = brandMark(key);
    // A card: mark, name and state; what it does; and at the bottom (so every card lines up) what it
    // last did and when. Problems get their message and fix below that.
    // The Claude card opens its cost chart below, like the players and reviews cards do theirs.
    const opens = key === "claude" && claudeGames().length;
    const toggle = (e) => {
      if (e.type === "keydown" && e.key !== "Enter" && e.key !== " ") return;
      if (e.target.closest("a, button")) return;
      e.preventDefault();
      state.costsOpen = !state.costsOpen;
      renderStatus();
    };
    return h(`div.svc.svc-${kind}${opens ? ".svc-open" : ""}`, opens ? { role: "button", tabindex: "0", "aria-expanded": String(!!state.costsOpen), onclick: toggle, onkeydown: toggle } : null,
      h("div.svc-head", mark, h("b", name),
        h("span.svc-state", h("span.svc-dot"), STATE[kind])),
      h("div.svc-what", what),
      key === "claude" ? claudeCard() : null,
      key === "github" ? siteBuilt() : null,
      h("div.svc-last", s?.active ? `${s.activeWhat || "last activity"} ${ago(s.active)}` : none),
      key === "github" && kind === "idle" ? h("div.svc-msg", "GitHub's hourly request limit is used up; back within the hour.") : null,
      kind === "bad" ? h("div.svc-msg", s.message || "Failed.", s.since ? h("span.svc-since", ` · since ${ago(s.since)}`) : null) : null,
      // A missing key: where to make it, then where to add it.
      kind === "bad" && keyPage && /secret/i.test(s.message || "") ? h("a.btn.svc-fix", { href: keyPage, target: "_blank", rel: "noopener" }, "Get a key ↗") : null,
      kind === "bad" ? h("a.btn.primary.svc-fix", { href: fix[0], target: "_blank", rel: "noopener" }, fix[1], " ↗") : null);
  };
  el.replaceChildren(...[
    bad.length ? null : h("div.svc-top", h("button.linkish", { type: "button", "aria-expanded": "true", onclick: toggleAll }, "Hide details ▴")),
    h("div.svc-grid", ...Object.entries(SERVICES).map(card)),
    state.costsOpen && claudeGames().length ? costPanel() : null,
  ].filter(Boolean));
}

// When the site you're looking at was built, and whether a newer deploy is running, failed or is
// already live (then a reload shows it). Handy after pushing a change to this dashboard.
const BUILT = typeof __BUILD_TIME__ === "undefined" ? null : __BUILD_TIME__;
const BUILT_SHA = typeof __BUILD_SHA__ === "undefined" ? "" : __BUILD_SHA__;
function siteBuilt() {
  const d = state.deploy;
  const link = (text) => d?.url ? h("a", { href: d.url, target: "_blank", rel: "noopener" }, text) : text;
  const line = [BUILT ? `site built ${ago(BUILT)}` : "site built just now (dev server)"];
  if (d?.running) line.push(" · ", link("rebuilding now…"));
  else if (d && !d.ok) line.push(" · ", h("span.svc-warn", link("last rebuild failed")));
  else if (d && BUILT_SHA && d.sha !== BUILT_SHA && d.at > (BUILT || 0))
    line.push(" · ", h("button.linkish", { type: "button", onclick: () => location.reload() }, "newer version live: reload"));
  return h("div.svc-built", { title: BUILT_SHA ? `This page is commit ${BUILT_SHA}` : "" }, ...line);
}

// Released games first, newest release on top; then coming-soon games, soonest first.
// One list: the game with the newest player post on top (newest release breaks ties).
function orderedGames() {
  return [...(state.index.games || [])].sort((a, b) => (b.lastPost || 0) - (a.lastPost || 0) || (b.released || 0) - (a.released || 0));
}

function renderGames() {
  const games = orderedGames();
  const players = (g) => g.lastPost ? `last player post ${ago(g.lastPost)}` : g.status === "upcoming" ? "coming soon, no player posts yet" : "no player posts yet";
  const sub = (g) => players(g) + (g.lastDevPost > (g.lastPost || 0) ? ` · you posted ${ago(g.lastDevPost)}` : "");
  const item = (g) => h("button.g-item", { type: "button", title: g.name, "aria-current": String(state.game?.appId === g.appId), onclick: () => pickGame(g.appId) },
    g.capsule ? h("img.g-thumb", { src: g.capsule, alt: "", loading: "lazy" }) : h("span.g-thumb"),
    h("span.g-name", g.name, h("span.g-sub", sub(g))));
  document.getElementById("fb-games-side").replaceChildren(h("div.side-label", "Games"), ...games.map(item));
  document.getElementById("fb-games-strip").replaceChildren(...games.map(item));
}

async function pickGame(appId) {
  store.set("app", appId);
  const meta = state.index.games.find((g) => g.appId === appId);
  if (!state.games[appId]) {
    document.getElementById("fb-view").replaceChildren(h("p.empty", "Loading…"));
    try {
      state.games[appId] = await getJson(`games/${appId}.json`);
    } catch (e) {
      state.game = { appId, meta, items: {}, issues: {}, players: [], releases: [], reviewTotals: {} };
      render();
      document.getElementById("fb-view").replaceChildren(h("p.empty", "No data for this game yet."));
      return;
    }
  }
  state.game = { ...state.games[appId], meta };
  render();
}

function setHash() {
  // Keep vue-router's history state; only the hash changes.
  history.replaceState(history.state, "", `${location.pathname}${location.search}#app=${state.game.appId}&tab=${state.tab}`);
}

// ---------------------------------------------------------------------------
// Derived data
// ---------------------------------------------------------------------------

const items = () => Object.values(state.game.items || {});
const issues = (kind) => Object.values(state.game.issues || {}).filter((i) => i.kind === kind);
const english = (item) => (item.triage && item.triage.english) || item.text || "";
// Still to do: not fixed by an update, and not cleared by you.
const isActive = (i) => i.status !== "likely_fixed" && !clearedAs(i);

function playersAt(series, t) {
  let v = null;
  for (const [ts, n] of series) { if (ts > t) break; v = n; }
  return v;
}

function renderHeader() {
  const meta = state.game.meta || {};
  const img = document.getElementById("fb-capsule");
  img.hidden = !meta.capsule;
  if (meta.capsule) img.src = meta.capsule;
  document.getElementById("fb-title").replaceChildren(...[meta.name || "", meta.status === "upcoming" ? h("span.pill", "Coming soon") : null].filter(Boolean));
  const g = state.game;
  // The newest numbered update; a launch post or an unnumbered one only when there's nothing else.
  const release = (g.releases || []).filter((r) => r.version).at(-1) || (g.releases || []).at(-1);
  document.getElementById("fb-updated").replaceChildren(...[
    release ? `Latest update ${release.version ? "v" + release.version : release.name}, ${ago(release.time)}` : null,
    gameCost(g.meta?.claude),
  ].filter(Boolean));
  const id = state.game.appId;
  const links = [
    ["Store page", `https://store.steampowered.com/app/${id}/`],
    ["Reviews", `https://steamcommunity.com/app/${id}/reviews/?browsefilter=mostrecent`],
    ["Discussions", `https://steamcommunity.com/app/${id}/discussions/`],
    ["News", `https://store.steampowered.com/news/app/${id}`],
    ["Steamworks", `https://partner.steamgames.com/apps/landing/${id}`],
    // Steamworks' own sales report, for what the Sales view doesn't show (packages, wishlists…).
    ["Sales", `https://partner.steampowered.com/app/details/${id}/`],
  ];
  document.getElementById("fb-links").replaceChildren(
    h("details.steam-menu",
      h("summary.btn", "Steam ▾"),
      h("div.menu", ...links.map(([label, href]) => h("a", { href, target: "_blank", rel: "noopener" }, label, " ↗")))));
}

function renderStats() {
  const g = state.game;
  const series = g.players || [];
  const t = now();
  const current = series.length ? series[series.length - 1][1] : null;
  const totalsKey = Object.keys(g.reviewTotals || {}).sort().pop();
  const totals = totalsKey ? g.reviewTotals[totalsKey] : null;
  // 14-day trends for every card.
  const peaks = daily(14, (d) => Math.max(playersAt(series, d) ?? 0, ...series.filter(([ts]) => ts >= d && ts < d + DAY).map(([, n]) => n)));
  const reviewsPerDay = daily(14, (d) => items().filter((i) => i.kind === "review" && i.created >= d && i.created < d + DAY).length);
  const openBugsPerDay = daily(14, (d) => issues("bug").filter((i) => i.firstSeen < d + DAY && !(i.status === "likely_fixed" && i.fixedAt < d + DAY)).length);
  const postsPerDay = daily(14, (d) => items().filter((i) => !i.dev && i.created >= d && i.created < d + DAY).length);
  const bugs = issues("bug").filter(isActive);
  const urgent = bugs.filter((i) => i.urgency === "urgent" || i.urgency === "high");
  const still = bugs.filter((i) => i.status === "still_happening");
  const fresh = items().filter((i) => !i.dev && i.created >= t - DAY);
  const tile = (label, value, sub, trend, color, chart) => {
    const body = [h("div.label", label, chart ? h("span.kpi-more", state.expanded === chart ? "Hide chart ▴" : "Chart ▾") : null), h("div.value", value), ...(Array.isArray(sub) ? sub : [sub]).filter(Boolean).map((line) => h("div.sub", line)), trend ? spark(trend, color) : null];
    if (!chart) return h("div.kpi", ...body);
    return h("button.kpi.kpi-open", { type: "button", "aria-expanded": String(state.expanded === chart), onclick: () => {
      state.expanded = state.expanded === chart ? null : chart;
      renderStats();
    } }, ...body);
  };
  const score = reviewScore(totals);
  const byDay = new Map(salesDays());
  const revenue = daily(14, (d) => byDay.get(isoDay(d))?.net || 0);
  const gross7 = daily(7, (d) => byDay.get(isoDay(d))?.gross || 0).reduce((a, b) => a + b, 0);
  // The two chart cards stay minimal, like SteamDB's: the number and what it is. Their details
  // (peaks, positive and negative counts) are in the panel that opens below.
  const cards = {
    // A fire when the players in game right now are the most ever recorded.
    players: tile("Players", current == null ? "–" : `${current}${current && current >= Math.max(...series.map(([, n]) => n)) ? " 🔥" : ""}`,
      current != null ? (current && current >= Math.max(...series.map(([, n]) => n)) ? "In-Game · all-time peak" : "In-Game") : "not released", peaks, undefined, "players"),
    reviews: tile("Reviews", score ? `${score.rating.toFixed(2)}%` : "–", score ? plural(score.total, "review") : "no reviews yet", reviewsPerDay, "var(--fb-positive)", "reviews"),
    followers: tile("Followers", g.followers?.length ? g.followers[g.followers.length - 1][1] : "–", g.followers?.length ? growthLine(g.followers) : "on Steam",
      daily(14, (d) => playersAt(g.followers || [], d + DAY - 1) ?? 0), "var(--type-praise)", "followers"),
    discord: state.index.discord?.members?.length
      ? tile("Discord", state.index.discord.members.at(-1)[1], [`${state.index.discord.online?.at(-1)?.[1] ?? 0} online`],
        daily(14, (d) => playersAt(state.index.discord.members, d + DAY - 1) ?? 0), "#5865f2", "discord")
      : null,
    revenue: salesDays().length ? tile("Revenue", usd(revenue.slice(-7).reduce((a, b) => a + b, 0)), [`net, last 7 days`, `${usd(gross7)} gross`], revenue, "var(--fb-positive)") : null,
    bugs: tile("Open bugs", bugs.length, still.length ? `${still.length} still happening` : urgent.length ? `${urgent.length} high or urgent` : "none high or urgent", openBugsPerDay, "var(--type-bug)"),
    posts: tile("New posts", fresh.length, "last 24 h", postsPerDay),
  };
  // Up front only what you can act on: before release, the following you're building; after it,
  // players, reviews, money and bugs. The rest waits behind "+ more" (remembered), and the card
  // whose chart is open stays out either way.
  const upcoming = g.meta?.status === "upcoming";
  const main = upcoming ? ["followers", "discord", "bugs"] : ["players", "reviews", "revenue", "bugs"];
  const more = store.get("kpis-more") === "1";
  const extra = Object.keys(cards).filter((k) => !main.includes(k) && cards[k]);
  const shown = Object.keys(cards).filter((k) => cards[k] && (more || main.includes(k) || k === state.expanded));
  const toggle = extra.length ? h("button.kpi.kpi-toggle", { type: "button", "aria-expanded": String(more), onclick: () => {
    store.set("kpis-more", more ? "0" : "1");
    renderStats();
  } }, more ? "Fewer" : `+ ${extra.filter((k) => !shown.includes(k)).length} more`) : null;
  document.getElementById("fb-stats").replaceChildren(...shown.map((k) => cards[k]), toggle);
  document.getElementById("fb-expand").replaceChildren(...(state.expanded ? [chartPanel(state.expanded)] : []));
}

// "+12 this week" (or "no change this week") under a count that's stored on change.
function growthLine(series) {
  const d = series[series.length - 1][1] - (playersAt(series, now() - 7 * DAY) ?? series[0][1]);
  return d ? `${d > 0 ? "+" : ""}${d} this week` : "no change this week";
}

// SteamDB's rating: the positive share pulled towards 50% when there are few reviews,
// rating = p − (p − 0.5)·2^(−log10(n + 1)); and Steam's own summary words for the share.
function reviewScore(totals) {
  const pos = totals?.positive || 0, neg = totals?.negative || 0, n = pos + neg;
  if (!n) return null;
  const p = pos / n;
  const rating = (p - (p - 0.5) * 2 ** -Math.log10(n + 1)) * 100;
  const share = p * 100;
  const label = share >= 95 && n >= 500 ? "Overwhelmingly Positive" : share >= 80 && n >= 50 ? "Very Positive" : share >= 80 ? "Positive"
    : share >= 70 ? "Mostly Positive" : share >= 40 ? "Mixed" : share >= 20 ? "Mostly Negative"
    : n >= 500 ? "Overwhelmingly Negative" : n >= 50 ? "Very Negative" : "Negative";
  const tone = share >= 70 ? "good" : share >= 40 ? "mixed" : "bad";
  return { pos, neg, total: n, share, rating, label, tone };
}

// The big numbers above an opened chart, SteamDB-style.
function statHeader(which) {
  const g = state.game, series = g.players || [], t = now();
  const stat = (value, label, cls) => h(`div.sh-stat${cls ? "." + cls : ""}`, h("div.sh-value", value), h("div.sh-label", label));
  if (which === "players") {
    const current = series.length ? series[series.length - 1][1] : 0;
    const day = Math.max(current, playersAt(series, t - DAY) ?? 0, ...series.filter(([ts]) => ts >= t - DAY).map(([, n]) => n));
    const best = series.reduce((b, s) => (s[1] > b[1] ? s : b), [0, 0]);
    return h("div.stat-header",
      stat(current, "players right now"),
      stat(`${day}${day && day >= best[1] ? " 🔥" : ""}`, "24-hour peak"),
      stat(`${best[1]} 🔥`, best[0] ? `all-time peak ${ago(best[0])}` : "all-time peak"));
  }
  // Followers and Discord: now, and the change over a week and a month.
  const growth = (series, unit) => {
    const current = series.length ? series[series.length - 1][1] : 0;
    const since = (days) => { const was = playersAt(series, t - days * DAY) ?? series[0]?.[1] ?? current; const d = current - was; return `${d >= 0 ? "+" : ""}${d}`; };
    return [stat(current, unit), stat(since(7), "last 7 days"), stat(since(30), "last 30 days")];
  };
  if (which === "followers") return h("div.stat-header", ...growth(g.followers || [], "followers on Steam"));
  if (which === "discord") {
    const online = state.index.discord?.online || [];
    return h("div.stat-header", ...growth(state.index.discord?.members || [], "Discord members"), stat(online.length ? online[online.length - 1][1] : 0, "online now"));
  }
  const totalsKey = Object.keys(g.reviewTotals || {}).sort().pop();
  const score = reviewScore(totalsKey ? g.reviewTotals[totalsKey] : null);
  const left = REVIEW_GOAL - (score?.total || 0);
  const toGoal = left > 0 ? stat(`${left} to go`, `until ${REVIEW_GOAL} reviews, when Steam shows a review score and starts showing the game in more places`) : null;
  if (!score) return h("div.stat-header", stat("–", "no reviews yet"), toGoal);
  return h("div.stat-header", toGoal,
    stat(score.label, "Steam's summary", `tone-${score.tone}`),
    stat(`${score.rating.toFixed(2)}%`, "rating (SteamDB's formula)"),
    stat(score.pos, `${score.share.toFixed(1)}% positive reviews`, "tone-good"),
    stat(score.neg, `${(100 - score.share).toFixed(1)}% negative reviews`, "tone-bad"));
}

// The chart behind an opened stat card, with its own time range.
function chartPanel(which) {
  const f = state.filters.stats;
  const wrap = h("div.expand.chart-card", statHeader(which));
  const body = h("div");
  const draw = () => {
    const end = now();
    // Never before the game's release (nothing to show there): "All" starts at the oldest data or
    // the release, whichever is later; the fixed ranges are cut at the release too.
    // Followers and Discord count from before the release too (that's when wishlists build up).
    const own = { followers: state.game.followers, discord: state.index.discord?.members }[which];
    const released = own ? 0 : state.game.meta?.released || 0;
    const oldest = Math.min(end - DAY, ...(own || []).map((p) => p[0]), ...(own ? [] : [...(state.game.players || []).map((p) => p[0]), ...items().map((i) => i.created)]));
    const start = Math.min(end - DAY, Math.max(released, f.range ? end - f.range * DAY : oldest));
    const releases = markers(start, end);
    body.replaceChildren({ players: playersChart, reviews: reviewsChart, followers: followersChart, discord: discordChart }[which](start, end, releases));
  };
  const range = chips([[2, "48h"], [7, "1w"], [30, "1m"], [90, "3m"], [180, "6m"], [365, "1y"], [0, "max"]], f.range, (v) => { f.range = v; draw(); }, "Zoom");
  wrap.append(h("div.filters", h("span.zoom-label", "Zoom"), range), body);
  draw();
  return wrap;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

// The views, in groups so the list reads at a glance: what players say, the game itself, and money.
const NAV = [
  [null, [["overview", "Overview"]]],
  ["Players", [["issues", "Bugs"], ["suggestions", "Ideas"], ["loved", "Loved"], ["replies", "Replies"], ["feed", "All posts"]]],
  ["Game", [["updates", "Updates"], ["achievements", "Achievements"], ["media", "Media"]]],
  ["Business", [["sales", "Sales"], ["bundles", "Bundles"], ["competitors", "Competitors"]]],
  ["Later", [["soon", "Coming soon"]]],
];

// A view's explanation, folded away so the view itself comes first; one click opens it.
const about = (...kids) => h("details.about", h("summary", "How this works"), h("p", ...kids));

function render() {
  state.drawn = drawnKey(); // what's on screen, so a refresh only redraws for new data
  renderGames();
  renderHeader();
  renderStats();
  const counts = {
    issues: issues("bug").filter(isActive).length,
    suggestions: issues("suggestion").filter(isActive).length,
    feed: items().filter((i) => !i.dev).length,
    loved: issues("praise").length,
    replies: toReply().length,
    overview: attention().length || null,
    achievements: state.game.achievements?.list?.length || null,
    bundles: bundleWith().length || null,
    competitors: competitors().length || null,
    soon: soonCount(),
    media: liveNow().length ? `${liveNow().length} live` : talk().filter((m) => m.at > now() - 7 * DAY).length || null,
  };
  // The view on screen counts as seen now; any other view with something from the last 48 hours
  // that's newer than when you last opened it gets "New", like a new post.
  store.set(`seen:${state.game.appId}:${state.tab}`, now());
  const button = ([id, label]) =>
    h("button.nav-btn", { type: "button", "aria-current": String(state.tab === id), onclick: () => { state.tab = id; render(); } },
      icon(id), h("span", label), id !== state.tab && hasNew(id) ? h("span.pc-new.nav-new", "New") : null, counts[id] != null ? h(`span.count${id === "media" && liveNow().length ? ".count-live" : id === "soon" ? ".count-soon" : ""}`, counts[id]) : null);
  // The side card lists the views under their group's name; the phone tabs keep them in one row,
  // with a gap between groups.
  document.getElementById("fb-nav-side").replaceChildren(...NAV.flatMap(([group, tabs]) => [...(group ? [h("div.nav-group", group)] : []), ...tabs.map(button)]));
  document.getElementById("fb-nav-top").replaceChildren(...NAV.flatMap(([, tabs], i) => [...(i ? [h("span.nav-gap")] : []), ...tabs.map(button)]));
  setHash();
  const view = { overview: overviewView, issues: () => issueView("bug"), suggestions: () => issueView("suggestion"), loved: lovedView, replies: repliesView, updates: updatesView, media: mediaView, achievements: achievementsView, bundles: bundlesView, competitors: competitorsView, sales: salesView, soon: soonView, feed: feedView }[state.tab]();
  document.getElementById("fb-view").replaceChildren(view);
}

// How far players get: the share who unlocked each achievement (feedback/community.py), most common
// first, so a big step down shows where many players stop.
function achievementsView() {
  const a = state.game.achievements;
  if (!a?.list?.length) return h("p.empty", state.game.meta?.status === "upcoming" ? "Not out yet: achievement stats start once players have it." : "No achievement stats on Steam for this game.");
  const list = a.list.slice().sort((x, y) => y.percent - x.percent);
  let drop = null;
  list.forEach((x, i) => { if (i && list[i - 1].percent - x.percent > (drop?.by || 0)) drop = { at: i, by: list[i - 1].percent - x.percent }; });
  return h("div",
    about( `The share of players who unlocked each achievement, from Steam, most common first. If they follow the game's progress, a big step down is where many players stop. Updated daily, last ${ago(a.at)}.`),
    ...list.map((x, i) => h("div.card.ach",
      x.icon ? h("img.ach-icon", { src: x.icon, alt: "", loading: "lazy" }) : null,
      h("div.ach-body",
        h("div.ach-head", h("b", x.name),
          drop && drop.at === i && drop.by >= 10 ? h("span.pc-new.ach-drop", { title: "The biggest step down from the achievement above" }, `−${drop.by.toFixed(1)} points: biggest drop`) : null,
          h("span.ach-pct", `${x.percent.toFixed(1)}%`)),
        x.desc && x.desc !== x.name ? h("div.ach-desc", x.desc) : null,
        h("div.ach-bar", h("i", { style: `width:${Math.max(0.5, x.percent)}%` }))))));
}

// Bundles: the ones on Steam the game is in (feedback/community.py reads them daily from its store
// page), and the games you'd like to bundle it with, saved in feedback/data/bundles.json
// ({appId: {otherAppId: {at, name, status, note}}}). The collector looks each of those up on the
// next run: name, developer, price and reviews.
const BUNDLE_PATH = "feedback/data/bundles.json";
const BUNDLE_STATUS = [["idea", "Idea"], ["contacted", "Contacted"], ["yes", "Said yes"], ["no", "Said no"]];
// Steam's support form for a game: its first page lists how to reach the developer.
const contactUrl = (appId) => `https://help.steampowered.com/en/wizard/HelpWithGameTechnicalIssue?appid=${appId}`;
const bundleWith = () => Object.entries(state.bundleWith?.[state.game.appId] || {})
  .map(([appId, w]) => ({ appId: Number(appId), ...w, info: state.game.partners?.[appId] || null }))
  .sort((a, b) => b.at - a.at);

function bundlesView() {
  const id = state.game.appId;
  const list = state.game.bundles?.list || [];
  const bundled = new Set(list.flatMap((b) => b.apps.map((a) => a.appId)));
  const wanted = bundleWith();
  const storeLink = (appId, text) => h("a", { href: `https://store.steampowered.com/app/${appId}/`, target: "_blank", rel: "noopener" }, text);
  const bundleCard = (b) => h("div.card.bundle",
    b.image ? h("img.bundle-img", { src: b.image, alt: "", loading: "lazy" }) : null,
    h("div.bundle-body",
      h("div.bundle-head", h("b", b.name), b.bundleDiscount ? h("span.pill", `−${b.bundleDiscount}% bundle discount`) : null),
      h("div.bundle-apps", plural(b.apps.length, "game"), ": ", ...b.apps.flatMap((a, i) => [i ? ", " : null, a.appId === id ? h("b", a.name || a.appId) : storeLink(a.appId, a.name || `App ${a.appId}`)])),
      h("div.bundle-meta", b.price ? (b.fullPrice && b.fullPrice !== b.price ? [h("s", b.fullPrice), " ", b.price] : b.price) : null, b.price ? " · " : null,
        h("a", { href: `https://store.steampowered.com/bundle/${b.id}/`, target: "_blank", rel: "noopener" }, "Store page ↗"))));
  const wantCard = (w) => {
    const info = w.info;
    const name = info?.name || w.name || `App ${w.appId}`;
    const makers = [...new Set([...(info?.developers || []), ...(info?.publishers || [])])];
    const r = info?.reviews;
    const facts = [
      makers.length ? `by ${makers.join(", ")}` : null,
      info?.comingSoon ? "coming soon" : info?.released ? `out ${info.released}` : null,
      info?.price || null,
      // Steam's word for the score, except when it has too few reviews for one ("7 user reviews").
      r?.total ? `${/^\d/.test(r.desc || "") ? "" : `${r.desc}: `}${Math.round(100 * r.positive / r.total)}% of ${plural(r.total, "review")} positive` : info && !info.missing ? "no reviews yet" : null,
    ].filter(Boolean);
    return h("div.card.bundle",
      h("img.bundle-img", { src: info?.capsule || `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${w.appId}/header.jpg`, alt: "", loading: "lazy", onerror: (e) => { e.currentTarget.hidden = true; } }),
      h("div.bundle-body",
        h("div.bundle-head", storeLink(w.appId, h("b", name)), bundled.has(w.appId) ? h("span.pill.pill-good", "In a bundle together") : null),
        info?.missing ? h("div.bundle-meta", "Steam has no public store page for this app id.") : facts.length ? h("div.bundle-meta", facts.join(" · ")) : h("div.bundle-meta", "Looked up on the next run (within 5 min)."),
        w.note ? h("p.bundle-note", w.note) : null,
        h("div.bundle-actions",
          h("a.btn.primary", { href: contactUrl(w.appId), target: "_blank", rel: "noopener" }, "Contact the developer ↗"),
          chips(BUNDLE_STATUS, w.status || "idea", (v) => setBundleWith(w.appId, { status: v }, `${name}: ${BUNDLE_STATUS.find(([k]) => k === v)[1].toLowerCase()}`), "Status"),
          h("button.linkish", { type: "button", onclick: () => askBundleWith(w) }, "Note"),
          h("button.linkish", { type: "button", onclick: () => setBundleWith(w.appId, null, `${name} removed`) }, "Remove"))));
  };
  return h("div",
    h("section.ov-section",
      h("h3", "Bundles on Steam", h("span.ov-count", list.length)),
      about( "The bundles this game is in, from its store page, checked daily", state.game.bundles?.at ? `, last ${ago(state.game.bundles.at)}` : "", ". ",
        h("a", { href: "https://partner.steamgames.com/doc/store/application/bundles", target: "_blank", rel: "noopener" }, "How bundles work ↗")),
      ...(list.length ? list.map(bundleCard) : [h("p.empty", "Not in any bundle yet.")])),
    h("section.ov-section",
      h("h3", "Games to bundle with", h("span.ov-count", wanted.length), h("button.btn", { type: "button", style: "margin-left:auto", onclick: () => askBundleWith() }, "+ Add a game")),
      about( "Games you'd like to bundle this one with. Contact the developer opens Steam's support page for that game, which lists how to reach them; mark where each one stands."),
      ...(wanted.length ? wanted.map(wantCard) : [h("p.empty", "None yet: add a game by its store link or app id.")])));
}

// Adds a game to bundle with (by its store link or app id), or edits the note on one.
function askBundleWith(w) {
  const input = w ? null : h("input.dlg-input", { type: "text", required: true, placeholder: "https://store.steampowered.com/app/3203590/… or 3203590", spellcheck: "false" });
  const note = h("textarea.dlg-input", { rows: 2, placeholder: "Why it fits, who you talked to…" }, w?.note || "");
  formDialog(w ? `Note: ${w.info?.name || w.name || `App ${w.appId}`}` : "Add a game to bundle with", [
    input ? h("label.dlg-label", "Store link or app id", input) : null,
    h("label.dlg-label", "Note (optional)", note),
  ], w ? "Save" : "Add", () => {
    if (!input) return { appId: w.appId };
    return appFromInput(input.value, state.bundleWith);
  }).then((got) => {
    if (!got) return;
    const fields = { note: note.value.trim() || null, ...(w ? {} : { name: got.name, status: "idea", at: now() }) };
    setBundleWith(got.appId, fields, w ? "Note saved" : "Added: looked up on the next run");
  });
}

// {appId, name} from a Steam store link or an app id typed in a dialog; throws what's wrong with it.
// `saved` is the dashboard file the game goes in ({appId: {otherAppId: …}}).
function appFromInput(text, saved) {
  const m = text.trim().match(/\/app\/(\d+)(?:\/([^/?#]+))?/) || text.trim().match(/^(\d+)$/);
  if (!m) throw new Error("Paste the game's Steam store link, or its app id (the number in the link).");
  const appId = Number(m[1]);
  if (appId === state.game.appId) throw new Error("That's this game.");
  if (saved?.[state.game.appId]?.[appId]) throw new Error("That game is already on the list.");
  // A name from the link until the collector looks the game up.
  let name = null;
  try { name = m[2] ? decodeURIComponent(m[2]).replace(/_/g, " ") : null; } catch {}
  return { appId, name };
}

// Changes one game on the list (null removes it).
function setBundleWith(appId, fields, done) {
  const game = String(state.game.appId);
  saveData("bundleWith", BUNDLE_PATH, (data) => {
    const list = (data[game] ||= {});
    if (fields) list[appId] = { ...(list[appId] || {}), ...fields };
    else delete list[appId];
    if (!Object.keys(list).length) delete data[game];
    return data;
  }, `Feedback: bundle with ${appId} ${fields ? "updated" : "removed"} [skip ci]`, done);
}

// Competitors: similar games you compare this one with, saved in feedback/data/competitors.json
// ({appId: {otherAppId: {at, name}}}). feedback/community.py reads each one hourly: the day's peak
// players, its review totals per day and its update posts (state.game.competitors), so a drop shows
// as "everyone dropped" or "only we dropped".
const COMPETITOR_PATH = "feedback/data/competitors.json";
const competitors = () => Object.entries(state.compareWith?.[state.game.appId] || {})
  .map(([appId, w]) => ({ appId: Number(appId), ...w, info: state.game.competitors?.[appId] || null }))
  .sort((a, b) => b.at - a.at);
const WEEK = 7;

// The game's own daily peak players ({day: n}, UTC days like the collector's) from its player count,
// which is stored on change: a count holds until the next one.
function ownPeaks() {
  const series = state.game.players || [];
  const peaks = {};
  series.forEach(([t, n], i) => {
    const until = series[i + 1]?.[0] ?? now();
    for (let d = Math.floor(t / DAY); d <= Math.floor(until / DAY); d++) {
      const key = isoDay(d * DAY);
      peaks[key] = Math.max(n, peaks[key] ?? 0);
    }
  });
  return peaks;
}
// Average daily peak over `days` full days ending `ago` days before today (today is still going).
function peakAverage(peaks, days, ago = 1) {
  const today = Math.floor(now() / DAY);
  const values = Array.from({ length: days }, (_, i) => peaks[isoDay((today - ago - i) * DAY)]).filter((v) => v != null);
  return values.length >= Math.ceil(days * 0.7) ? values.reduce((a, b) => a + b, 0) / values.length : null;
}
// Players this week against the week before, as a share (−0.2 is 20% fewer), or null without the data.
function weekChange(peaks) {
  const was = peakAverage(peaks, WEEK, WEEK + 1), is = peakAverage(peaks, WEEK);
  return was == null || is == null || was < 1 ? null : is / was - 1;
}
// Review totals ({day: {positive, negative}}): the newest, and how many came in over the last week.
function reviewFacts(totals) {
  const days = Object.keys(totals || {}).sort();
  if (!days.length) return null;
  const last = totals[days[days.length - 1]];
  const weekAgo = days.filter((d) => d <= isoDay(now() - WEEK * DAY)).pop();
  const count = (r) => r.positive + r.negative;
  return { total: count(last), positive: last.positive, week: weekAgo ? count(last) - count(totals[weekAgo]) : null };
}
const pct = (share) => `${share > 0 ? "+" : share < 0 ? "−" : "±"}${Math.abs(Math.round(share * 100))}%`;
const median = (list) => { const s = list.slice().sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };

// The one line that says what the numbers mean: did only this game drop, or everyone?
function competitorVerdict(own, others) {
  if (!others.length) return null;
  const m = median(others);
  const vs = `similar games ${pct(m)} (median of ${others.length})`;
  if (own == null) return ["calm", `Too few players of your own these two weeks to compare. Players this week against last: ${vs}.`];
  if (own - m <= -0.15) return ["bad", `Only you dropped: players ${pct(own)} this week against last, while ${vs}. Look at what changed for this game: an update, a bug, a sale ending.`];
  if (own - m >= 0.15) return ["good", `You're beating the market: players ${pct(own)} this week against last, while ${vs}.`];
  if (m <= -0.1) return ["calm", `Everyone dropped: players ${pct(own)} this week against last, and ${vs}. Likely the season or a big release elsewhere, not your game.`];
  return ["calm", `In step with similar games: players ${pct(own)} this week against last, ${vs}.`];
}

function competitorsView() {
  const list = competitors();
  const mine = ownPeaks();
  const rows = list.map((w) => ({ ...w, name: w.info?.name || w.name || `App ${w.appId}`, peaks: w.info?.peaks || {} }));
  const verdict = competitorVerdict(weekChange(mine), rows.map((r) => weekChange(r.peaks)).filter((v) => v != null));
  const since = Math.min(...rows.flatMap((r) => Object.keys(r.peaks)).map(dayTime));
  const storeLink = (appId, text) => h("a", { href: `https://store.steampowered.com/app/${appId}/`, target: "_blank", rel: "noopener" }, text);
  const row = ({ appId, name, capsule, peaks, reviews, updates, info, own }) => {
    const change = weekChange(peaks);
    const r = reviewFacts(reviews);
    const lastUpdate = (updates || []).slice().sort((a, b) => b.time - a.time)[0];
    const yesterday = peaks[isoDay(now() - DAY)] ?? peaks[isoDay(now())];
    const facts = [
      yesterday != null ? `peak ${fmtNum(yesterday)} players yesterday` : null,
      r?.total ? `${Math.round(100 * r.positive / r.total)}% of ${fmtNum(r.total)} reviews positive${r.week ? `, +${r.week} this week` : ""}` : null,
    ].filter(Boolean);
    return h(`div.card.bundle${own ? ".cmp-own" : ""}`,
      h("img.bundle-img.cmp-img", { src: capsule || `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/header.jpg`, alt: "", loading: "lazy", onerror: (e) => { e.currentTarget.hidden = true; } }),
      h("div.bundle-body",
        h("div.bundle-head", own ? h("b", name, " (you)") : storeLink(appId, h("b", name)),
          change != null ? h(`span.cmp-change.${change <= -0.15 ? "down" : change >= 0.15 ? "up" : "level"}`, { title: "Average daily peak players, the last 7 days against the 7 before" }, pct(change), " this week") : null),
        info?.missing ? h("div.bundle-meta", "Steam has no public store page for this app id.")
          : info || own ? h("div.bundle-meta", facts.join(" · ") || "Players and reviews show after the next hourly check.")
          : h("div.bundle-meta", "Looked up on the next run (within 5 min)."),
        lastUpdate ? h("div.bundle-meta", "Last update: ", h("a", { href: lastUpdate.url, target: "_blank", rel: "noopener" }, lastUpdate.version ? `v${lastUpdate.version}` : lastUpdate.name.slice(0, 50)), `, ${ago(lastUpdate.time)}`) : null,
        own ? null : h("div.bundle-actions", h("button.linkish", { type: "button", onclick: () => setCompareWith(appId, null, `${name} removed`) }, "Remove"))));
  };
  const own = { appId: state.game.appId, name: state.game.meta?.name || "This game", capsule: state.game.meta?.capsule, peaks: mine, reviews: state.game.reviewTotals, updates: state.game.releases, own: true };
  return h("div",
    h("section.ov-section",
      h("h3", "Compared with similar games", h("span.ov-count", list.length), h("button.btn", { type: "button", style: "margin-left:auto", onclick: () => askCompareWith() }, "+ Add a game")),
      verdict ? h(`p.cmp-verdict.${verdict[0]}`, verdict[1])
        : h("p.ov-calm", !list.length ? "Add 5 to 10 games like this one (same genre, size or price) to see whether a drop in players is yours alone or everyone's."
          : `Needs two weeks of players to compare: collecting${Number.isFinite(since) ? ` since ${fmtShort(since)}` : " from the next run"}. Steam keeps no history, so it starts when a game is added.`),
      list.length ? competitorChart(own, rows) : null,
      about("Each game is read hourly from Steam: its player count (kept as the day's peak), its reviews and its update posts. \"This week\" is the average daily peak over the last 7 full days against the 7 before, so a game with 10 players and one with 10,000 compare fairly. Days are UTC."),
      row(own),
      ...rows.map((r) => row({ ...r, ...(r.info || {}), name: r.name, peaks: r.peaks }))));
}

// Daily peak players for this game and the median of the others, each as a share of its own average
// over the chart, so games of any size line up; the others are faint lines behind.
function competitorChart(own, rows) {
  // The last 60 days, or from the first day any similar game was read.
  const end = Math.floor(now() / DAY) * DAY;
  const first = Math.min(...rows.flatMap((r) => Object.keys(r.peaks)).map((d) => Date.parse(d + "T00:00:00Z") / 1000));
  const start = Math.max(end - 60 * DAY, Math.min(first, end - 2 * DAY));
  const days = Array.from({ length: (end - start) / DAY }, (_, i) => isoDay(start + i * DAY));
  const indexed = (peaks) => {
    const values = days.map((d) => peaks[d] ?? null);
    const known = values.filter((v) => v != null);
    const avg = known.reduce((a, b) => a + b, 0) / (known.length || 1);
    return avg >= 1 ? values.map((v) => (v == null ? null : v / avg)) : null;
  };
  const others = rows.map((r) => ({ name: r.name, values: indexed(r.peaks), peaks: r.peaks })).filter((o) => o.values && o.values.filter((v) => v != null).length >= 2);
  const mine = indexed(own.peaks);
  if (!others.length) return null;
  const med = days.map((_, i) => { const v = others.map((o) => o.values[i]).filter((x) => x != null); return v.length ? median(v) : null; });
  const max = Math.max(2, Math.ceil(Math.max(...others.flatMap((o) => o.values), ...(mine || []), ...med) * 2) / 2);
  const x = (t) => M.left + ((t - start) / (end - DAY - start)) * (W - M.left - M.right);
  const y = (v) => H - M.bottom - (v / max) * (H - M.top - M.bottom);
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart", role: "img", "aria-label": "Daily peak players against each game's own average" });
  yAxis(svg, y, max, (v) => `${Math.round(v * 100)}%`);
  svg.append(svgEl("line", { x1: M.left, x2: W - M.right, y1: y(1), y2: y(1), class: "grid" }));
  timeAxis(svg, x, start, end - DAY);
  releaseMarkers(svg, x, markers(start, end));
  const path = (values, attrs) => {
    let d = "", pen = false;
    values.forEach((v, i) => { if (v == null) { pen = false; return; } d += `${pen ? "L" : "M"}${x(start + i * DAY).toFixed(1)},${y(v).toFixed(1)}`; pen = true; });
    if (d) svg.append(svgEl("path", { d, fill: "none", "stroke-linejoin": "round", ...attrs }));
  };
  for (const o of others) path(o.values, { stroke: "var(--fb-muted)", "stroke-width": 1, opacity: 0.35 });
  path(med, { stroke: "var(--fb-ink-2)", "stroke-width": 2, "stroke-dasharray": "5 3" });
  if (mine) path(mine, { stroke: "var(--fb-accent)", "stroke-width": 2.5 });
  const cross = svgEl("line", { y1: M.top, y2: H - M.bottom, class: "cross", visibility: "hidden" });
  svg.append(cross);
  const legend = h("div.legend", h("span", h("i", { style: "background:var(--fb-accent)" }), "You"), h("span", h("i", { style: "background:var(--fb-ink-2)" }), "Median of similar games"), h("span", h("i", { style: "background:var(--fb-muted);opacity:.5" }), "Each similar game"));
  const { card, tip } = chartCard("Players against their usual", "Each game's daily peak players as a share of its own average over the chart, the last 60 days at most (100% is a usual day). Lines apart are what's yours alone; lines together are the market.", legend, svg, null);
  svg.addEventListener("pointermove", (e) => {
    const box = svg.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * W;
    const i = Math.max(0, Math.min(days.length - 1, Math.round(((px - M.left) / (W - M.left - M.right)) * (days.length - 1))));
    const t = start + i * DAY;
    cross.setAttribute("x1", x(t)); cross.setAttribute("x2", x(t)); cross.setAttribute("visibility", "visible");
    const line = (label, v, n) => v == null ? null : h("div", h("b", `${Math.round(v * 100)}%`), ` ${label}`, n != null ? h("span.t", ` (${fmtNum(n)} peak)`) : null);
    showTip(card, tip, svg, x(t), y(mine?.[i] ?? med[i] ?? 1), [h("div.t", fmtDate(t)), line("you", mine?.[i], own.peaks[days[i]]), line("median of similar games", med[i])].filter(Boolean));
  });
  svg.addEventListener("pointerleave", () => { tip.style.display = "none"; cross.setAttribute("visibility", "hidden"); });
  return card;
}

// Adds a game to compare with, by its store link or app id.
function askCompareWith() {
  const input = h("input.dlg-input", { type: "text", required: true, placeholder: "https://store.steampowered.com/app/3203590/… or 3203590", spellcheck: "false" });
  formDialog("Add a game to compare with", [h("label.dlg-label", "Store link or app id", input)], "Add", () => appFromInput(input.value, state.compareWith))
    .then((got) => got && setCompareWith(got.appId, { name: got.name, at: now() }, "Added: read on the next run"));
}

// Changes one game on the list (null removes it).
function setCompareWith(appId, fields, done) {
  const game = String(state.game.appId);
  saveData("compareWith", COMPETITOR_PATH, (data) => {
    const list = (data[game] ||= {});
    if (fields) list[appId] = { ...(list[appId] || {}), ...fields };
    else delete list[appId];
    if (!Object.keys(list).length) delete data[game];
    return data;
  }, `Feedback: compare with ${appId} ${fields ? "added" : "removed"} [skip ci]`, done);
}

// Ideas for later, each with what it would show and what it needs, so none gets forgotten. Nothing
// here is collected yet.
const SOON = [
  {
    title: "Data from inside the game",
    why: "Reviews say what players think; this would show what they do.",
    shows: ["Per player (those who say yes): their whole journey across sessions, so you see what kept a player going after something went wrong, and who your biggest fans are",
      "A/B tests: two versions of a level, tutorial or price, and which keeps more players (bold changes show first: there are few players per version)",
      "From everyone: where players quit, how long sessions last, crashes with Godot's error logs grouped like bugs, and hardware and settings"],
    needs: "A small add-on in each Godot game and a place to receive the events. At first launch it asks once: \"Help make the game better? Share your gameplay with Four Games so we can see how people play. [Sure!] [Only anonymous stats]\". Yes: events carry a random ID per install (not the Steam ID). No: events carry no ID, nothing is saved on the player's computer and the server keeps no IP addresses, so they can't be linked to anyone. Plus a privacy policy page saying what's collected and how to have it deleted; worth a check by someone who knows EU privacy law before launch.",
  },
  {
    title: "Steam curators",
    why: "Curators who review a game, to thank them or reply.",
    shows: ["Each curator's recommendation, with their follower count"],
    needs: "Steam has no official way to read these, so it may not work well.",
  },
];
const soonCount = () => SOON.length;

function soonView() {
  return h("div",
    about( "Ideas for later: what each would show and what it needs. Nothing here is collected yet."),
    ...SOON.map((idea) => h("div.card.soon",
      h("h3", idea.title, h("span.count.count-soon", "Soon")),
      h("p", idea.why),
      h("ul.soon-list", ...idea.shows.map((line) => h("li", line))),
      h("p.ov-calm", h("b", "Needs: "), idea.needs, idea.link ? [" ", h("a", { href: idea.link[0], target: "_blank", rel: "noopener" }, idea.link[1], " ↗")] : null))));
}

// When the newest thing in each view arrived (the overview only sums up the others).
const NEWEST = {
  issues: () => issues("bug").filter(isActive).map((i) => i.lastSeen),
  suggestions: () => issues("suggestion").filter(isActive).map((i) => i.lastSeen),
  loved: () => issues("praise").map((i) => i.lastSeen),
  replies: () => toReply().map((i) => draftFor(i).at || i.created),
  updates: () => (state.game.releases || []).map((r) => r.time),
  media: () => talk().filter((m) => !m.own).map((m) => m.at),
  feed: () => items().filter((i) => !i.dev).map((i) => i.created),
};
function hasNew(view) {
  const newest = Math.max(0, ...(NEWEST[view]?.() || []).filter(Boolean));
  return isRecent(newest) && newest > Number(store.get(`seen:${state.game.appId}:${view}`) || 0);
}

function issueView(kind) {
  const f = state.filters[kind === "bug" ? "issues" : "suggestions"];
  const wrap = h("div");
  const list = h("div");
  const draw = () => {
    const q = f.q.toLowerCase();
    const shown = issues(kind)
      .filter((i) => f.status === "all" || (f.status === "active" ? isActive(i) : f.status === "still" ? isActive(i) && i.status === "still_happening"
        : f.status === "cleared" ? clearedAs(i) : i.status === "likely_fixed" && !clearedAs(i)))
      .filter((i) => !q || (i.title + " " + i.area + " " + (i.summary || "")).toLowerCase().includes(q))
      .filter((i) => f.sort !== "first" || i.firstSession > 0)
      .sort(SORTS[f.sort] || SORTS.priority);
    list.replaceChildren(...(shown.length ? shown.map((i) => issueCard(i)) : [h("p.empty", kind === "bug" ? "No issues here." : "No suggestions here.")]));
  };
  const status = chips([["active", "Open"], ["still", "Still happening"], ["fixed", "Likely fixed"], ["cleared", "Marked fixed"], ["all", "All"]], f.status, (v) => { f.status = v; draw(); }, "Status");
  // What costs the most reviews, what most players hit, or what turns new players away.
  const sort = chips([["priority", "Priority"], ["negative", "Negative reviews"], ["players", "Most players"], ["first", "First 2 hours"]], f.sort, (v) => { f.sort = v; draw(); }, "Sort");
  const search = h("input", { type: "search", placeholder: "Search issues", value: f.q, oninput: (e) => { f.q = e.target.value; draw(); } });
  wrap.append(h("div.filters", status, h("span.zoom-label", "Sort"), sort, search), list);
  draw();
  return wrap;
}

const SORTS = {
  priority: (a, b) => b.priority - a.priority,
  negative: (a, b) => (b.negativeReviews || 0) - (a.negativeReviews || 0) || b.mentions - a.mentions,
  players: (a, b) => b.mentions - a.mentions || (b.negativeReviews || 0) - (a.negativeReviews || 0),
  first: (a, b) => (b.firstSession || 0) - (a.firstSession || 0) || b.mentions - a.mentions,
};

// What players love: praise grouped like ideas, most players first, ready to copy for a store page.
function lovedView() {
  const list = issues("praise").sort((a, b) => b.mentions - a.mentions || b.lastSeen - a.lastSeen);
  const copyAll = h("button.btn.primary", { onclick: (e) => copy(list.map((i) => `- ${i.title} (${plural(i.mentions, "player")})`).join("\n"), e.currentTarget) }, "Copy the list");
  return h("div",
    about( "What players praise, grouped like ideas: things to keep, and wording for your store page and trailers."),
    list.length ? h("div.filters", copyAll) : null,
    ...(list.length ? list.map((i) => issueCard(i)) : [h("p.empty", "No praise grouped yet.")]));
}

// How each update landed: negative reviews before and after it, what it fixed and whether those
// reports stopped, and what's new since.
function updatesView() {
  // Every update post, numbered or not (older ones are often only named).
  const all = (state.game.releases || []).slice().sort((a, b) => a.time - b.time);
  const reviews = items().filter((i) => i.kind === "review");
  const tally = (from, to) => {
    const list = reviews.filter((r) => r.created >= from && r.created < to);
    return { n: list.length, neg: list.filter((r) => !r.votedUp).length };
  };
  // How players took the update, from the reviews written after it (until the next update).
  const reception = (w, last) => {
    if (!w.n) return h("div.impact-stat", h("b", "–"), h("span", last ? "no reviews since yet" : "no reviews before the next update"));
    const pos = w.n - w.neg, share = pos / w.n;
    const [word, cls] = share >= 0.7 ? ["Liked", ".good"] : share >= 0.4 ? ["Mixed", ".warn"] : ["Disliked", ".bad"];
    return h(`div.impact-stat${cls}`, h("b", word), h("span", w.n === 1 ? `the 1 review since was ${pos ? "positive" : "negative"}` : `${pos} of ${w.n} reviews since were positive`));
  };
  const cards = all.slice().reverse().map((r) => {
    const i = all.indexOf(r);
    const next = all[i + 1]?.time ?? now();
    const after = tally(r.time, next);
    // What the patch notes fixed, and what you marked fixed in this update.
    const fixed = [...new Set([...(r.matched || []).map((id) => state.game.issues?.[id]),
      ...Object.values(state.game.issues || {}).filter((x) => x.manualFix && x.status === "likely_fixed" && x.fixedUrl === r.url)])].filter(Boolean);
    const partly = (r.partly || []).map((id) => state.game.issues?.[id]).filter((x) => x && x.status !== "likely_fixed");
    const since = Object.values(state.game.issues || {}).filter((x) => x.kind !== "praise" && x.firstSeen >= r.time && x.firstSeen < next);
    const reportsAfter = (x) => x.items.map((id) => state.game.items[id]).filter((p) => p && p.created > r.time).length;
    return h("article.card",
      h("div.pc-top",
        h("div.pc-main", h("span.pc-type", isLaunch(r) ? "Launch" : r.version ? `v${r.version}` : r.name), h("span.pc-prio", fmtDate(r.time))),
        h("div.pc-aside.impact",
          reception(after, !all[i + 1]))),
      fixed.length ? h("div.upd-section", h("b", "Fixed by this update"),
        h("ul.pc-points", ...fixed.map((x) => h("li", h(`span.pk.pk-${x.kind === "bug" ? "bug" : "suggestion"}`, x.kind === "bug" ? "Bug" : "Idea"),
          h("span", x.title, " · ", reportsAfter(x) ? h("span.vote-down", `${plural(reportsAfter(x), "report")} since`) : h("span.s-fixed", "no reports since")))))) : null,
      partly.length ? h("div.upd-section", h("b", "Partly addressed (still open)"),
        h("ul.pc-points", ...partly.map((x) => h("li", h(`span.pk.pk-${x.kind === "bug" ? "bug" : "suggestion"}`, x.kind === "bug" ? "Bug" : "Idea"), h("span", x.title))))) : null,
      since.length ? h("div.upd-section", h("b", "New since this update"),
        h("ul.pc-points", ...since.map((x) => sinceLine(x)))) : null,
      h("div.meta", h("a", { href: r.url, target: "_blank", rel: "noopener" }, "Patch notes ↗")));
  });
  return h("div",
    about( "Each update: how players took it (the reviews written after it), what it fixed (and whether those reports stopped), what it only partly addressed, and what came up since (crossed out once a later update fixed it)."),
    ...(cards.length ? cards : [h("p.empty", "No updates yet.")]));
}

// A bug or idea that came up after an update: crossed out, with where, once a later update fixed it
// (dashed when one only partly fixed it).
function sinceLine(x) {
  const fixed = x.status === "likely_fixed";
  const partly = !fixed && partlyFixed(x);
  return h(`li${fixed ? ".pt-fixed" : partly ? ".pt-partly" : ""}`, h(`span.pk.pk-${x.kind === "bug" ? "bug" : "suggestion"}`, x.kind === "bug" ? "Bug" : "Idea"),
    h("span", `${x.title} (${plural(x.mentions, "player")})`),
    fixed ? h("a.pt-fixed-in", { href: x.fixedUrl || null, target: "_blank", rel: "noopener", title: x.fixReason || "" }, `✓ fixed in ${x.fixedIn}`) : null,
    partly ? partlyLink(partly) : null);
}

// The updates (or your fixes) that helped with an issue without doing what players asked, while
// it isn't fixed.
const partlyFixed = (issue) => issue && issue.status !== "likely_fixed" && issue.partly?.length ? issue.partly : null;
function partlyLink(partly) {
  return h("a.pt-partly-in", { href: partly.at(-1).url || null, target: "_blank", rel: "noopener", title: partly.map((p) => `${p.in}: ${p.reason}`).join("\n") },
    `◐ partly fixed in ${partly.map((p) => p.in).join(", ")}`);
}

function urgencyBadge(u) {
  return h(`span.badge.u-${u}`, h("span.dot", { "aria-hidden": "true" }), URGENCY[u] || u);
}

// Everything updates did about an issue: the fix (or, once players say it's still there, a fix that
// only partly worked, plus "still happening") and every update that partly addressed it.
function statusBadge(issue) {
  const link = (cls, url, title, text) => h(`a.badge.${cls}`, { href: url, target: "_blank", rel: "noopener", title: title || "" }, text);
  const partly = (issue.partly || []).filter((p) => p.in !== issue.fixedIn);
  const partlyBadge = partly.length
    ? link("s-partly", partly.at(-1).url, partly.map((p) => `${p.in}: ${p.reason}`).join("\n"), `◐ Partly addressed in ${partly.map((p) => p.in).join(", ")}`)
    : null;
  const cleared = clearedAs(issue);
  if (cleared) return [h("span.badge.s-fixed", { title: [`You marked this fixed on ${fmtDate(cleared.at)}`, cleared.note].filter(Boolean).join("\n") },
    `✓ Fixed ${fixedWhere(cleared)} · Claude is checking`)];
  // Cleared, then reported again: back on the list.
  const entry = clearedEntry(issue);
  // (After Claude took your note as the fix, it's Claude's "still happening" that says so.)
  const back = entry && issue.lastSeen > entry.at && issue.manualFix !== fixKey(issue, entry)
    ? h("span.badge.s-still", { title: `You marked this fixed on ${fmtDate(entry.at)}` }, "↻ Reported again since you marked it fixed") : null;
  if (issue.status === "likely_fixed")
    return [link("s-fixed", issue.fixedUrl, issue.fixReason, "✓ Likely fixed in " + issue.fixedIn), back];
  if (issue.status === "still_happening")
    return [link("s-partly", issue.fixedUrl, issue.fixReason, `◐ Worked on in ${issue.fixedIn}`), partlyBadge,
      h("span.badge.s-still", { title: "A player says it's still there after the fix" }, "↻ Still happening"), back];
  return [partlyBadge, back];
}

// A post as its own card: click to open the whole post (selecting it for the Speak Selection key),
// click again to fold it; not when using a link, button or toggle inside, or after a drag.
// With `focus` (an issue ID), only the points about that issue are listed.
function postCard(item, { clamp = true, focus = null } = {}) {
  return h(`div.card.post-card${clamp ? ".clamp" : ""}`, { onmousedown: (e) => { e.currentTarget.dataset.down = `${e.clientX},${e.clientY}`; }, onclick: (e) => {
    const [dx, dy] = (e.currentTarget.dataset.down || "0,0").split(",").map(Number);
    if (e.target.closest("a, button, summary") || Math.abs(e.clientX - dx) + Math.abs(e.clientY - dy) > 4) return;
    const card = e.currentTarget;
    const open = !card.classList.contains("is-open");
    card.classList.toggle("is-open", open);
    card.classList.toggle("clamp", clamp && !open);
    card.querySelectorAll("details.full").forEach((d) => { d.open = open; });
    if (open) selectText(card.querySelector("details.full .text") || card.querySelector(".post .text"));
    else window.getSelection().removeAllRanges();
  } }, postView(item, focus));
}

function thumbImg(up) {
  return h("img.thumb.thumb-inline", { src: up ? STEAM_THUMB.up : STEAM_THUMB.down, alt: up ? "positive" : "negative" });
}

// A bug or idea in the post cards' style: type and priority on the left, the rest to the right.
function issueCard(issue) {
  const posts = issue.items.map((id) => state.game.items[id]).filter(Boolean).sort((a, b) => b.created - a.created);
  const postList = h("div", { hidden: true });
  let filled = false;
  const toggle = h("button.btn", { onclick: () => {
    if (!filled) {
      postList.append(...posts.map((p) => postCard(p, { clamp: false, focus: issue.id })));
      filled = true;
    }
    postList.hidden = !postList.hidden;
    toggle.textContent = postList.hidden ? `Show ${plural(posts.length, "post")}` : "Hide posts";
  } }, `Show ${plural(posts.length, "post")}`);
  const copyText = issue.kind === "bug" ? issue.fixPrompt : suggestionText(issue, posts);
  const copyBtn = h("button.btn.primary", { onclick: (e) => copy(copyText, e.currentTarget) }, issue.kind === "bug" ? "Copy fix prompt" : "Copy summary");
  // A ready line for the patch notes, crediting how many players raised it.
  const patchLine = issue.kind === "bug" ? `Fixed: ${issue.title} (reported by ${plural(issue.mentions, "player")})`
    : `${issue.title} (suggested by ${plural(issue.mentions, "player")})`;
  const patchBtn = issue.kind === "praise" ? null : h("button.btn", { onclick: (e) => copy(patchLine, e.currentTarget) }, "Copy patch-note line");
  const [, kind] = CATEGORY[issue.kind] || [];
  const u = issue.kind === "praise" ? null : issue.urgency; // praise has no priority
  const bars = u ? h(`span.bars4.pt-${u}`, ...[1, 2, 3, 4].map((n) => h(n <= PRIORITY_BARS[u] ? "i.on" : "i"))) : null;
  const summary = issue.summary ? h("span", issue.summary) : null;
  const summaryLabel = summary ? h(`button.pk.pk-${issue.kind}`, { type: "button", title: "Select this sentence" }, POINT_LABEL[issue.kind] || kind) : null;
  summaryLabel?.addEventListener("click", (e) => { e.stopPropagation(); selectText(summary); });
  return h("article.card.issue-card",
    h("div.post.pc.neutral",
      h("div.pc-top",
        h("div.pc-main",
          h(`span.pc-type.tt-text-${issue.kind}`, typeIcon(issue.kind), kind),
          u ? h("span.pc-prio", bars, `${URGENCY[u]} priority`) : null,
          statusBadge(issue),
          isRecent(issue.firstSeen) ? h("span.pc-new", { title: `First reported ${ago(issue.firstSeen)}` }, "New")
            : isRecent(issue.lastSeen) ? h("span.pc-new", { title: `Last reported ${ago(issue.lastSeen)}` }, "New report") : null),
        // The impact, big: how many players reported it and how many negative reviews it's in.
        h("div.pc-aside.impact",
          h("div.impact-stat", h("b", issue.mentions), h("span", issue.kind === "praise" ? (issue.mentions === 1 ? "player loves it" : "players love it")
            : issue.mentions === 1 ? "player reported it" : "players reported it")),
          issue.kind === "praise" ? null : h(`div.impact-stat${issue.negativeReviews ? ".bad" : ""}`, h("b", issue.negativeReviews || 0),
            h("span", issue.negativeReviews === 1 ? "negative review" : "negative reviews")),
          // Raised inside Steam's 2-hour refund window: what turns new players away.
          issue.firstSession && issue.kind !== "praise" ? h("div.impact-stat.warn", h("b", issue.firstSession), h("span", "in the first 2 hours")) : null)),
      h("h3.issue-title", issue.title),
      h("div.pc-block-sub.issue-facts", [
        (issue.languages || []).map((l) => withFlag(l)).join(", "),
        `last reported ${ago(issue.lastSeen)}`,
        issue.area,
      ].filter(Boolean).join(" · ")),
      summary ? h("ul.pc-points", h("li", summaryLabel, summary)) : null,
      h("div.actions", issue.kind === "praise" ? null : copyBtn, toggle, patchBtn, issue.kind === "praise" ? null : checkButton(issue))),
    postList);
}

// The check: ticks a bug or idea off as fixed, or (ticked) undoes that.
function checkButton(issue) {
  if (issue.status === "likely_fixed" && !ticked(issue)) return null; // an update already fixed it
  const on = ticked(issue);
  return h(`button.check-btn${on ? ".on" : ""}`, { type: "button", "aria-pressed": String(on),
    title: on ? "Marked fixed. Click to undo" : "Mark fixed", "aria-label": on ? "Undo marked fixed" : "Mark fixed",
    onclick: () => setFixed(issue, !on) }, svgCheck());
}
function svgCheck() {
  const svg = svgEl("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": 2.5, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" });
  svg.append(svgEl("path", { d: "M5 12.5l4.5 4.5L19 7.5" }));
  return svg;
}

function suggestionText(issue, posts) {
  return [
    `${state.game.meta.name} suggestion: ${issue.title}`,
    `${plural(issue.mentions, "player")} (${(issue.languages || []).join(", ")}), area: ${issue.area}`,
    "",
    ...posts.slice(0, 10).map((p) => `- "${english(p).replace(/\s+/g, " ").slice(0, 300)}" ${p.url}`),
  ].join("\n");
}

// Opening a post selects its text, so pressing the Speak Selection key reads it with your own Mac
// voice (Siri included, which web pages can't use themselves). Reply texts select on a click.
function fullPost(text) {
  const details = h("details.full", h("summary", "Full post"), text);
  details.addEventListener("toggle", () => { if (details.open) selectText(text); });
  return details;
}

function selectText(el) {
  if (!el) return;
  const range = document.createRange();
  range.selectNodeContents(el);
  window.getSelection().removeAllRanges();
  window.getSelection().addRange(range);
}

function textRow(text) {
  return h("div.text", text);
}
function withSpeak(text) {
  const el = h("span.selectable", { title: "Click to select" }, text);
  el.addEventListener("click", (e) => { e.stopPropagation(); selectText(el); });
  return [el];
}

// Steam's "0.4 hrs on record (0.2 hrs at review time)": total hours now, and the hours when the
// review was written if they've played more since.
function playtime(item) {
  if (item.kind !== "review" || item.playtime == null) return null;
  const now = Math.max(item.playtimeForever || 0, item.playtime);
  return { total: `${now} h`, atReview: now > item.playtime ? `${item.playtime} h at review` : null };
}

// ---------------------------------------------------------------------------
// Post card: laid out like Steam's own review box. The header carries the verdict, hours and date
// on the left and the player's language with what triage made of it on the right.
// ---------------------------------------------------------------------------

const CATEGORY = { bug: ["🐞", "Bug"], suggestion: ["💡", "Suggestion"], question: ["❓", "Question"], praise: ["💬", "Praise"] };

const POINT_ORDER = ["bug", "complaint", "suggestion", "question", "praise"];
const POINT_LABEL = { bug: "Bug", complaint: "Complaint", suggestion: "Suggestion", question: "Question", praise: "Praise" };

// The parts of a post the card shows.
function postParts(item, focus = null) {
  const t = item.triage || {};
  const points = (t.points || []).filter((pt) => !focus || pt.issue === focus);
  const others = (t.points || []).length - points.length;
  const translated = t.english && t.english.trim() !== (item.text || "").trim();
  const flipped = (item.flips || []).at(-1);
  const parent = item.topic ? state.game.items[item.topic] : null;
  const review = item.kind === "review";
  return {
    t, review,
    flag: t.language ? langFlag(t.language, item.lang) : "",
    language: t.language || (item.dev ? "Your post" : "Not triaged yet"),
    hours: playtime(item)?.total || null,
    atReview: playtime(item)?.atReview || null,
    verdict: review ? (item.votedUp ? ["vote-up", "👍", "Recommended"] : ["vote-down", "👎", "Not recommended"]) : null,
    who: item.author?.name || null,
    when: fmtDate(item.created),
    kind: KIND[item.kind] + (item.forum ? ` · ${item.forum}` : ""),
    link: h("a", { href: item.url, target: "_blank", rel: "noopener" }, "Open on Steam ↗"),
    // What happened to the post, and what triage made of it.
    flags: [
      item.edited ? h("span.badge", { title: `Edited · ${(item.versions || []).length} earlier version(s) kept` }, "edited") : null,
      flipped ? h("span.badge", { class: flipped.to === "negative" ? "s-still" : "s-fixed" }, `flipped ${flipped.to} ${fmtShort(flipped.at)}`) : null,
      item.deleted ? h("span.badge.s-still", "deleted on Steam") : null,
      item.dev ? h("span.badge", "Your post") : null,
    ].filter(Boolean),
    tags: [t.category ? h("span.badge", t.category) : null, t.urgency ? urgencyBadge(t.urgency) : null].filter(Boolean),
    body: [
      // Where it was posted (a comment can sit under an older announcement than the version it was
      // written on, shown in the header).
      parent ? h("div.meta", parent.forum === "Events & Announcements" ? "Comment on the “" : "Reply in “", parent.title || "thread",
        parent.forum === "Events & Announcements" ? "” announcement" : "”") : null,
      item.title ? h("div", h("b", item.title)) : null,
      // Every post leads with its points (what kind of thing it says), most actionable first.
      ...(points.length ? [
        h("ul.pc-points", ...[...points].sort((a, b) => POINT_ORDER.indexOf(a.kind) - POINT_ORDER.indexOf(b.kind))
          .map((pt) => {
            // Clicking the label selects the sentence, ready for the Speak Selection key.
            // Hover shows the player's own words the point comes from.
            const sentence = h("span", pt.quote ? { title: `“${pt.quote}”` } : {}, pt.text);
            const label = h(`button.pk.pk-${pt.kind}`, { type: "button", title: "Select this point" }, POINT_LABEL[pt.kind]);
            label.addEventListener("click", (e) => {
              e.stopPropagation();
              const range = document.createRange();
              range.selectNodeContents(sentence);
              window.getSelection().removeAllRanges();
              window.getSelection().addRange(range);
            });
            // Struck through once an update fixed the issue it belongs to (for posts from before the fix);
            // a dashed amber line when one only partly fixed it.
            const issue = pt.issue ? state.game.issues?.[pt.issue] : null;
            const fixed = issue?.status === "likely_fixed" && item.created < issue.fixedAt;
            const partly = !fixed && partlyFixed(issue);
            return h(`li${fixed ? ".pt-fixed" : partly ? ".pt-partly" : ""}`, label, sentence,
              fixed ? h("a.pt-fixed-in", { href: issue.fixedUrl, target: "_blank", rel: "noopener", title: issue.fixReason || "" }, `✓ fixed in ${issue.fixedIn}`) : null,
              partly ? partlyLink(partly) : null);
          })),
        others ? h("div.meta", `+ ${plural(others, "other point")} about other things, in the full post`) : null,
        // Long posts fold away under their points; short ones stay readable as they are, except
        // under an issue, where only its points show.
        english(item).length > 280 || focus ? fullPost(textRow(english(item))) : textRow(english(item)),
      ] : [textRow(english(item))]),
      t.note ? h("div.pc-note", h("b", "Note "), t.note) : null,
      translated ? h("details", h("summary", `Original (${t.language})`), textRow(item.text)) : null,
      (item.versions || []).length ? h("details", h("summary", `Earlier versions (${item.versions.length})`),
        ...item.versions.slice().reverse().map((v) => h("div.text", `${fmtDate(v.at)}${v.votedUp == null ? "" : v.votedUp ? " · 👍" : " · 👎"}\n${v.title ? v.title + "\n" : ""}${v.text}`))) : null,
      item.devResponse ? h("details", h("summary", "Your reply on Steam"), textRow(item.devResponseEnglish || item.devResponse),
        item.devResponseEnglish ? h("details", h("summary", `Original (${item.devResponseLanguage})`), textRow(item.devResponse)) : null) : null,
    ].filter(Boolean),
  };
}

// The game version live when something was posted: the newest numbered update released before it
// (or the launch build, before the first one). An estimate from the update dates, since Steam
// doesn't record the version a player was on.
function versionAt(time) {
  const before = (state.game.releases || []).filter((r) => r.time <= time).sort((a, b) => a.time - b.time);
  const numbered = before.filter((r) => r.version).at(-1);
  if (numbered) return `v${numbered.version}`;
  return before.length || (state.game.meta?.released && state.game.meta.released <= time) ? "launch build" : null;
}

// Priority as signal bars, one to four.
const PRIORITY_BARS = { low: 1, medium: 2, high: 3, urgent: 4 };
// Steam's own review thumbs, and line icons for the types (Steam has none of its own for those).
const STEAM_THUMB = {
  up: "https://community.akamai.steamstatic.com/public/shared/images/userreviews/icon_thumbsUp_v6.png",
  down: "https://community.akamai.steamstatic.com/public/shared/images/userreviews/icon_thumbsDown_v6.png",
};
const TYPE_ICON = {
  bug: "M8 2l1.88 1.88M14.12 3.88 16 2M9 7.13v-1a3 3 0 1 1 6 0v1M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6M12 20v-9M6.53 9C4.6 8.8 3 7.1 3 5M6 13H2M3 21c0-2.1 1.7-3.9 3.8-4M20.97 5c0 2.1-1.6 3.8-3.5 4M22 13h-4M17.2 17c2.1.1 3.8 1.9 3.8 4",
  suggestion: "M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5M9 18h6M10 22h4",
  question: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01",
  praise: "M19 14c1.5-1.5 3-3.2 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.8 0-3 .5-4.5 2-1.5-1.5-2.7-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4 3 5.5l7 7z",
};
function typeIcon(cat) {
  const svg = svgEl("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": 2.2, "stroke-linecap": "round", "stroke-linejoin": "round", class: "type-icon", "aria-hidden": "true" });
  svg.append(svgEl("path", { d: TYPE_ICON[cat] }));
  return svg;
}

// Read left to right, most important first: the top line is the type (in its colour) and the
// priority (signal bars), with the player's language at the far right; the second line has
// Steam's verdict, hours and date. The card's left edge is blue for a recommending review, red
// for a negative one and grey for everything else.
function postView(item, focus = null) {
  const p = postParts(item, focus);
  const cat = p.t.category;
  const kind = (CATEGORY[cat] || [])[1];
  const u = p.t.urgency;
  const edge = p.verdict ? p.verdict[0].replace("vote-", "is-") : "neutral";
  const bars = u ? h(`span.bars4.pt-${u}`, ...[1, 2, 3, 4].map((n) => h(n <= PRIORITY_BARS[u] ? "i.on" : "i"))) : null;
  const up = p.verdict && p.verdict[0] === "vote-up";
  // Left: only what matters when skimming hundreds of posts, the type and priority. Right, smaller
  // and behind a divider: who wrote it, in what language, their verdict, hours and date.
  return h(`div.post.pc.${edge}`,
    h("div.pc-top",
      h("div.pc-main",
        kind ? h(`span.pc-type.tt-text-${cat}`, typeIcon(cat), kind) : h("span.pc-type.pc-kind", p.kind),
        u ? h("span.pc-prio", bars, `${URGENCY[u]} priority`) : null,
        p.t.tone && p.t.tone !== "sincere" ? h("span.pc-tone", { title: "How the post is meant" }, { joke: "Joke", sarcastic: "Sarcastic", mixed: "Partly joking" }[p.t.tone]) : null,
        isRecent(item.created) ? h("span.pc-new", { title: `Posted ${ago(item.created)}` }, "New") : null),
      // Two tidy blocks: who wrote it (name; language, library, reviews) and what it is (verdict or
      // kind; hours, date, version).
      h("div.pc-aside",
        h("div.pc-block",
          h("div.pc-block-main",
            item.author?.name ? h("a.pc-player", { href: item.author.profile || item.url, target: "_blank", rel: "noopener", title: "Steam profile" },
              item.author.avatar ? h("img.avatar", { src: item.author.avatar, alt: "", loading: "lazy" }) : null, item.author.name) : h("span", p.who || "Steam user")),
          h("div.pc-block-sub", [
            p.flag || p.language ? `${p.flag ? p.flag + " " : ""}${p.language}` : null,
            item.author?.games != null ? `${item.author.games.toLocaleString("en-US")} games` : null,
            item.kind === "review" && item.author?.reviews != null ? plural(item.author.reviews, "review") : null,
          ].filter(Boolean).join(" · "))),
        h("div.pc-block",
          h("div.pc-block-main",
            p.verdict ? h(`span.${p.verdict[0]}`, h("img.thumb", { src: up ? STEAM_THUMB.up : STEAM_THUMB.down, alt: "" }), p.verdict[2]) : h("span", KIND[item.kind])),
          h("div.pc-block-sub", { title: "Hours played · posted · the version live then (from the update dates)" }, [
            p.hours ? `${p.hours} played${p.atReview ? ` (${p.atReview})` : ""}` : null,
            p.when,
            versionAt(item.created),
          ].filter(Boolean).join(" · "))))),
    ...p.body,
    h("div.meta", ...p.flags, item.forum && item.kind !== "review" ? h("span", item.forum) : null, p.link));
}

// Posts worth a reply: a negative review or a thread about something a later update fixed (Steam's
// guidance: reply to "a bug that has since been resolved"), and recent positive reviews, thanked and
// invited back to the newest update. Drafted by feedback/run.py; gone once you've replied on Steam,
// the issue turns out to be still happening, the review turns negative, or you press Done
// (remembered in this browser).
function replied(item) {
  if (item.devResponse) return true;
  const thread = item.topic || item.id;
  // Any post of yours in the thread after the player's counts, even one from before the fix.
  return items().some((i) => i.dev && (i.id === thread || i.topic === thread) && i.created > item.created);
}
function toReply() {
  const done = new Set((store.get("replied") || "").split(",").filter(Boolean));
  return items()
    .filter((i) => draftFor(i) && !done.has(i.id) && !replied(i))
    .sort((a, b) => b.created - a.created);
}
// The fixed complaints a positive review's thank-you names, while they're still fixed.
function thanksFixes(r) {
  return (r.fixes || []).map((f) => state.game.issues?.[f.split("@")[0]]).filter((i) => i?.status === "likely_fixed");
}
function draftFor(item) {
  if (item.fixReply && state.game.issues?.[item.fixReply.issue]?.status === "likely_fixed") return item.fixReply;
  if (item.thanksReply && item.votedUp) return item.thanksReply;
  return null;
}

function replyCard(item) {
  const r = draftFor(item);
  const issue = r.issue ? state.game.issues[r.issue] : null;
  const done = h("button.btn", { onclick: () => {
    store.set("replied", [...(store.get("replied") || "").split(",").filter(Boolean), item.id].join(","));
    render();
  } }, "Done");
  return h("div.card",
    r === item.fixReply
      ? h("div.meta", h("span.badge.s-fixed", `✓ Fixed in ${r.version}`), h("b", issue?.title || ""))
      : h("div.meta", h("span.badge.s-fixed", "👍 Positive review"),
        ...thanksFixes(r).flatMap((i) => [h("span.badge.s-fixed", `✓ Fixed in ${i.fixedIn}`), h("b", i.title)]),
        h("span", r.update ? `invites them back for ${r.update}` : "a thank-you")),
    h("div.reply",
      h("div.reply-row",
        h("div", h("div", "💬 ", ...withSpeak(r.text)), r.text !== r.english ? h("div.en", r.english) : null),
        h("div.actions", { style: "margin:0;flex:none" },
          h("button.btn.primary", { onclick: (e) => copy(r.text, e.currentTarget) }, "Copy reply"),
          h("a.btn.link-btn", { href: item.url, target: "_blank", rel: "noopener" }, item.kind === "review" ? "Reply on Steam ↗" : "Open thread ↗"),
          done))),
    postView(item));
}

// Your answer to a player's post: the developer response on a review, or your first post in the
// thread after theirs.
function yourReply(item) {
  if (item.devResponse) return { text: item.devResponse, at: null };
  const thread = item.topic || item.id;
  const mine = items().filter((i) => i.dev && (i.id === thread || i.topic === thread) && i.created > item.created)
    .sort((a, b) => a.created - b.created)[0];
  return mine ? { text: mine.text, at: mine.created } : null;
}

function repliedCard(item) {
  const mine = yourReply(item);
  return h("div.card",
    h("div.meta", h("span.badge.s-fixed", "✓ Replied"), mine?.at ? h("span", fmtDate(mine.at)) : null,
      !mine ? h("span", "marked done here") : null),
    mine ? h("div.reply", h("div.reply-row", h("div", h("div.en", "Your reply"), h("div", ...withSpeak(mine.text))))) : null,
    postView(item));
}

function repliesView() {
  const f = state.filters.replies;
  const done = new Set((store.get("replied") || "").split(",").filter(Boolean));
  const open = toReply();
  // Every player post you've answered, plus drafts you marked done here.
  const answered = items()
    .filter((i) => !i.dev && (replied(i) || ((i.fixReply || i.thanksReply) && done.has(i.id))))
    .sort((a, b) => b.created - a.created);
  const list = h("div");
  const draw = () => {
    const cards = f.show === "open" ? open.map(replyCard)
      : f.show === "replied" ? answered.map(repliedCard)
      : [...open.map(replyCard), ...answered.map(repliedCard)];
    const empty = { open: "Nothing to reply to right now.", replied: "You haven't replied to any posts yet.", all: "Nothing here yet." }[f.show];
    list.replaceChildren(...(cards.length ? cards : [h("p.empty", empty)]));
  };
  const intro = about(
    "To reply: negative reviews and threads about something an update has since fixed (say what was fixed), and positive reviews from the last 60 days (thank them and invite them back for the newest update). Replied: posts you've already answered on Steam.");
  const filter = chips([["open", `To reply (${open.length})`], ["replied", `Replied (${answered.length})`], ["all", "All"]], f.show, (v) => { f.show = v; draw(); }, "Show");
  draw();
  return h("div", intro, h("div.filters", filter), list);
}

// Bugs that need you now: reported again after a fix, or high/urgent and still open.
function attention() {
  return Object.values(state.game.issues || {})
    .filter((i) => isActive(i) && (i.status === "still_happening" || (i.kind === "bug" && (i.urgency === "urgent" || i.urgency === "high"))))
    .sort((a, b) => b.priority - a.priority);
}

function overviewView() {
  const go = (tab, label) => h("button.btn", { onclick: () => { state.tab = tab; render(); window.scrollTo({ top: 0 }); } }, label, " →");
  const section = (title, count, ...body) => h("section.ov-section", h("h3", title, count != null ? h("span.ov-count", count) : null), ...body);
  const urgent = attention();
  // Next to anything urgent, the open complaints in the most negative reviews (not already above).
  const costly = Object.values(state.game.issues || {}).filter((i) => i.kind !== "praise" && isActive(i) && i.negativeReviews && !urgent.includes(i))
    .sort((a, b) => b.negativeReviews - a.negativeReviews || b.mentions - a.mentions).slice(0, 3);
  const replies = toReply();
  const latest = items().filter((i) => !i.dev).sort((a, b) => b.created - a.created).slice(0, 5);
  const live = liveNow();
  const coverage = talk().filter((m) => !isLive(m) && m.at > now() - 7 * DAY).sort((a, b) => b.at - a.at).slice(0, 3);
  return h("div",
    live.length ? section("🔴 Live now", live.length, ...live.map(mediaCard)) : null,
    urgent.length
      ? section("Needs attention", urgent.length, ...urgent.slice(0, 5).map((i) => issueCard(i)), urgent.length > 5 || issues("bug").filter(isActive).length > urgent.length ? go("issues", "All bugs") : null)
      : section("Needs attention", null, h("p.ov-calm", "Nothing urgent: no high-priority bugs, and nothing came back after a fix.")),
    costly.length
      ? section("Costing you reviews", costly.length, h("p.ov-calm", "The open complaints that come up most in negative reviews."), ...costly.map((i) => issueCard(i)), go("suggestions", "All ideas"))
      : null,
    replies.length
      ? section("Worth a reply", replies.length, h("p.ov-calm", `${plural(replies.length, "post")}: fixes to tell players about and positive reviews to thank. `, go("replies", "Replies")))
      : null,
    coverage.length
      ? section("New this week", null, h("p.ov-calm", "Videos, articles and posts about the game outside Steam."), ...coverage.map(mediaCard), go("media", "All media"))
      : null,
    section("Latest posts", null,
      // Long reviews are cut to a few lines here; a click shows the whole post.
      ...(latest.length ? latest.map((i) => postCard(i)) : [h("p.ov-calm", "No posts yet.")]),
      latest.length ? go("feed", "All posts") : null),
  );
}

function feedView() {
  const f = state.filters.feed;
  const wrap = h("div");
  const list = h("div");
  const draw = () => {
    const q = f.q.toLowerCase();
    const all = items()
      .filter((i) => !i.dev || !(i.kind === "topic" && i.forum === "Events & Announcements"))
      .filter((i) => f.kind === "all" || i.kind === f.kind)
      .filter((i) => f.category === "all" || (f.category === "pending" ? !i.triage && !i.dev : i.triage?.category === f.category))
      .filter((i) => !q || (english(i) + " " + (i.text || "") + " " + (i.title || "")).toLowerCase().includes(q))
      .sort((a, b) => Math.max(b.created, b.updated || 0) - Math.max(a.created, a.updated || 0));
    const shown = all.slice(0, f.shown);
    list.replaceChildren(...(shown.length ? shown.map((i) => h("div.card", postView(i))) : [h("p.empty", "Nothing here yet.")]));
    if (all.length > shown.length) list.append(h("button.btn.more", { onclick: () => { f.shown += 50; draw(); } }, `Show more (${all.length - shown.length} left)`));
  };
  const sel = (label, key, options) => chips(options, f[key], (v) => { f[key] = v; f.shown = 50; draw(); }, label);
  wrap.append(
    h("div.filters",
      sel("Type", "kind", [["all", "All posts"], ["review", "Reviews"], ["topic", "Threads"], ["reply", "Replies"]]),
      sel("Category", "category", [["all", "Any category"], ["bug", "Bugs"], ["suggestion", "Suggestions"], ["question", "Questions"], ["praise", "Praise"], ["pending", "Not triaged yet"]]),
      h("input", { type: "search", placeholder: "Search posts", value: f.q, oninput: (e) => { f.q = e.target.value; f.shown = 50; draw(); } })),
    list);
  draw();
  return wrap;
}


// ---------------------------------------------------------------------------
// Media: Twitch streams, YouTube videos, news articles, Reddit posts, web pages and download copies that name the game
// (feedback/media.py, in the game's file under `media`).
// ---------------------------------------------------------------------------

const MEDIA = {
  twitch: { name: "Twitch", color: "#9146ff" },
  youtube: { name: "YouTube", color: "#ff0033" },
  news: { name: "News", color: "#3e63dd" },
  reddit: { name: "Reddit", color: "#ff4500" },
  web: { name: "Web", color: "#12a594" },
  copy: { name: "Download copies", color: "#71717a" },
};
// Copies of the game on download sites aren't anyone talking about it: they stay off the overview and charts.
const REMOVAL_FORM = "https://reportcontent.google.com/forms/dmca_search";
const MEDIA_SOURCES = Object.keys(MEDIA);
const mediaItems = () => Object.values(state.game?.media?.items || {});
const talk = () => mediaItems().filter((m) => m.source !== "copy");
// Live: a run saw it live in the last half hour (the data can be a few minutes behind).
const isLive = (m) => !!m.live && now() - (m.end || m.at) < 1800;
const liveNow = () => mediaItems().filter(isLive).sort((a, b) => (b.viewers || 0) - (a.viewers || 0));
const fmtNum = (n) => n < 1000 ? String(n) : n < 1e6 ? `${+(n / 1000).toFixed(n < 1e4 ? 1 : 0)}k` : `${+(n / 1e6).toFixed(1)}M`;
const fmtLength = (s) => s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min` : `${Math.max(1, Math.round(s / 60))} min`;
// How many people it reached (peak viewers, views or score), for the size of its chart mark.
const reach = (m) => m.peak || m.views || m.score || 0;

function mediaFacts(m) {
  const f = [];
  if (m.source === "twitch") {
    if (isLive(m)) f.push(`${fmtNum(m.viewers || 0)} watching now`, `live for ${fmtLength(now() - m.at)}`);
    else f.push(`streamed ${fmtLength(Math.max(60, (m.end || m.at) - m.at))}`, m.peak ? `peak ${plural(m.peak, "viewer")}` : null);
    if (m.followers != null) f.push(`${fmtNum(m.followers)} followers`);
  } else if (m.source === "youtube") {
    if (m.live && m.viewers) f.push(`${fmtNum(m.viewers)} watching now`);
    if (m.views != null) f.push(`${fmtNum(m.views)} views`);
    if (m.likes) f.push(`${fmtNum(m.likes)} likes`);
    if (m.comments) f.push(`${fmtNum(m.comments)} comments`);
    if (m.duration && !m.live) f.push(fmtLength(m.duration));
    if (m.subscribers != null) f.push(`${fmtNum(m.subscribers)} subscribers`);
  }
  return f.filter(Boolean);
}

function mediaCard(m) {
  const live = isLive(m);
  const src = MEDIA[m.source];
  const link = (props, ...kids) => h("a", { href: m.url, target: "_blank", rel: "noopener", ...props }, ...kids);
  // Twitch's preview picture only exists while the stream is live.
  const thumb = m.thumb && (m.source !== "twitch" || live)
    ? link({ class: "md-thumb", tabindex: "-1", "aria-hidden": "true" }, h("img", { src: m.thumb, alt: "", loading: "lazy", onerror: (e) => e.currentTarget.parentElement.remove() }))
    : null;
  const action = { twitch: live ? "Watch and chat" : "Channel", youtube: live ? "Watch and chat" : "Watch and comment", reddit: "Open the thread", news: "Read it", web: "Open the page", copy: "See the page" }[m.source];
  const facts = mediaFacts(m);
  return h(`div.card.md-card${live ? ".md-live" : ""}`, { style: `--md:${src.color}` },
    thumb,
    h("div.md-body",
      h("div.md-src", live ? h("span.md-dot") : null, h("b", src.name, live ? " · Live" : ""), h("span", { title: new Date(m.at * 1000).toLocaleString() }, ` · ${live ? "started " : ""}${ago(m.at)}`)),
      h("h3", link({}, m.title || "(no title)")),
      h("div.md-who",
        m.authorUrl ? h("a", { href: m.authorUrl, target: "_blank", rel: "noopener" }, m.author) : m.author,
        m.own ? " · you" : null,
        m.by ? ` · u/${m.by}` : null,
        m.lang ? ` · ${m.lang.slice(0, 2).toUpperCase()}` : null),
      facts.length ? h("div.md-facts", facts.join(" · ")) : null,
      m.text && m.source !== "youtube" ? h("p.md-text", m.text) : null,
      link({ class: `btn${live ? " primary" : ""} md-go` }, action, " ↗"),
      m.source === "copy" ? h("a.btn.md-go", { href: REMOVAL_FORM, target: "_blank", rel: "noopener", title: "Google's form to remove a copyright-infringing page from its search results" }, "Ask Google to remove it ↗") : null));
}

function mediaView() {
  const f = state.filters.media;
  const all = mediaItems();
  const live = liveNow();
  const list = h("div");
  const draw = () => {
    // What's live is already at the top.
    const shown = all.filter((m) => !isLive(m) && (f.source === "all" || m.source === f.source)).sort((a, b) => b.at - a.at);
    list.replaceChildren(...(shown.length ? shown.slice(0, f.shown).map(mediaCard) : [h("p.empty", "Nothing found yet.")]));
    if (shown.length > f.shown) list.append(h("button.btn.more", { onclick: () => { f.shown += 30; draw(); } }, `Show more (${shown.length - f.shown} left)`));
  };
  const count = (s) => all.filter((m) => m.source === s).length;
  const filter = chips([["all", `All (${all.length})`], ...MEDIA_SOURCES.map((s) => [s, `${MEDIA[s].name} (${count(s)})`])], f.source, (v) => { f.source = v; f.shown = 30; draw(); }, "Source");
  const twitch = state.game.media?.twitch;
  draw();
  return h("div",
    live.length ? h("section.ov-section", h("h3", "🔴 Live now", h("span.ov-count", live.length)), ...live.map(mediaCard)) : null,
    about(
      "Streams, videos, articles, Reddit threads and other web pages that name the game. Twitch is checked every 5 minutes, news every 30 and YouTube about hourly; Reddit threads, web pages and download copies come from your Google Alerts. Discord pings you for each new stream, video and article. They're marked along the bottom of the player and review charts, so you can see what caused a jump; download copies aren't, and each has a link to Google's removal form."),
    twitch && twitch.category === null ? h("p.ov-calm", { style: "margin:0 0 12px" }, "Twitch has no category for this game yet, so its streams can't be found. Twitch adds games from IGDB: once the game is on igdb.com, it shows up within a day.") : null,
    names(),
    h("div.filters", filter),
    list);
}

// The names it searches for: English and every localized name Steam has (or had) for the game.
const STEAM_LANG_NAME = { koreana: "Korean", schinese: "Simplified Chinese", tchinese: "Traditional Chinese", latam: "Spanish (Latin America)",
  spanish: "Spanish (Spain)", brazilian: "Portuguese (Brazil)", portuguese: "Portuguese (Portugal)" };
const langName = (lang) => STEAM_LANG_NAME[lang] || lang[0].toUpperCase() + lang.slice(1);
function names() {
  const local = Object.entries(state.game.media?.names || {}).flatMap(([lang, ns]) => ns.map((n) => [lang, n]));
  return h("details.md-names", h("summary", local.length ? `Searches for ${plural(local.length + 1, "name")}: English and every localized name on Steam` : "Searches for the English name (Steam has no localized ones)"),
    h("ul", h("li", h("b", "English"), " ", state.game.meta?.name || ""), ...local.map(([lang, n]) => h("li", h("b", langName(lang)), " ", n))),
    h("p.ov-calm", "Each language's names are searched in its own country's Google News. A name Steam had before (a changed translation) is kept."),
    h("p.ov-calm", "For web pages in every language, make a ", h("a", { href: "https://www.google.com/alerts", target: "_blank", rel: "noopener" }, "Google Alert ↗"),
      " for this (Show options → Deliver to: RSS feed) and add its feed link to the GOOGLE_ALERTS_FEEDS secret:"),
    h("code.md-query", [state.game.meta?.name || "", ...local.map(([, n]) => n)].filter((n, i, all) => n && all.indexOf(n) === i).map((n) => `"${n}"`).join(" OR ")));
}

// Streams, videos, articles and posts along the bottom of a chart: a stream as a bar for as long
// as it ran, anything else as a dot that's bigger the more people it reached. Returns the sources
// shown, for the legend.
function mediaMarks(svg, x, start, end) {
  const list = talk().filter((m) => (m.end || m.at) >= start && m.at <= end).sort((a, b) => reach(a) - reach(b));
  const y = H - M.bottom - 6;
  for (const m of list) {
    const color = MEDIA[m.source].color;
    if (m.source === "twitch") {
      const from = x(Math.max(start, m.at)), to = x(Math.min(end, isLive(m) ? end : m.end || m.at));
      svg.append(svgEl("rect", { x: from, y: y - 3, width: Math.max(4, to - from), height: 6, rx: 3, fill: color, opacity: 0.85, class: "md-mark" }));
    } else {
      svg.append(svgEl("circle", { cx: x(m.at), cy: y, r: 3 + Math.min(4, Math.log10(reach(m) + 1)), fill: color, opacity: 0.85, class: "md-mark" }));
    }
  }
  return MEDIA_SOURCES.filter((s) => list.some((m) => m.source === s));
}
const mediaLegend = (sources) => sources.map((s) => h("span", h("i", { style: `background:${MEDIA[s].color}` }), MEDIA[s].name));
// What was going on at a point of a chart: streams running then, anything else posted within `span`.
function mediaAt(t, span) {
  return talk()
    .filter((m) => m.source === "twitch" ? t >= m.at - span && t <= (isLive(m) ? now() : m.end || m.at) + span : Math.abs(m.at - t) <= span)
    .sort((a, b) => reach(b) - reach(a))
    .slice(0, 4)
    .map((m) => h("div.t.md-tip", { style: `--md:${MEDIA[m.source].color}` }, `${MEDIA[m.source].name}: ${m.author || ""}${mediaFacts(m)[m.source === "twitch" ? 1 : 0] ? ` · ${mediaFacts(m)[m.source === "twitch" ? 1 : 0]}` : ""}`));
}

// ---------------------------------------------------------------------------
// Sales (feedback/sales.py: Steam's totals per day and game, Pacific-time dates, USD before Valve's
// cut). Public on purpose, like other developers share theirs.
// ---------------------------------------------------------------------------

const usd = (v, digits = 0) => "$" + Number(v || 0).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const dayTime = (d) => Date.parse(d + "T12:00:00Z") / 1000;

// [[date, totals]] for the game on screen, oldest first.
function salesDays() {
  const id = String(state.game.appId);
  return Object.entries(state.sales?.days || {}).map(([d, apps]) => [d, apps[id]]).filter(([, t]) => t);
}

function salesView() {
  if (!Object.keys(state.sales?.days || {}).length) {
    const s = state.index.status?.sales;
    return h("div.card", h("p", "No sales data yet."),
      h("p.meta", s && !s.ok ? s.message : "The collector reads Steam's sales hourly with the STEAM_FINANCIAL_KEY secret (a Financial API Group's key); they show here after its next run."));
  }
  if (!salesDays().length) return h("p.empty", state.game.meta?.status === "upcoming" ? "Not out yet: sales show here from launch." : "No sales for this game in Steam's data yet.");
  const f = state.filters.sales;
  const body = h("div");
  const draw = () => {
    const days = salesDays();
    const end = now();
    // The chart starts at this game's first sale, never before (nothing to show there); the account
    // card counts the whole range, since other games sold earlier.
    const from = f.range ? end - f.range * DAY : 0;
    const start = Math.min(end - 7 * DAY, Math.max(from, dayTime(days[0][0]) - DAY));
    const inRange = days.filter(([d]) => dayTime(d) >= start);
    const sum = (list, k) => list.reduce((a, [, t]) => a + (t[k] || 0), 0);
    const units = sum(inRange, "units"), refunded = sum(inRange, "returnedUnits");
    const tile = (label, value, sub) => h("div.kpi", h("div.label", label), h("div.value", value), sub ? h("div.sub", sub) : null);
    body.replaceChildren(
      h("section.kpis", { "aria-label": "Sales summary" },
        tile("Gross revenue", usd(sum(inRange, "gross")), "what players paid, before refunds and tax"),
        tile("Net revenue", usd(sum(inRange, "net")), "after refunds and tax, before Steam's cut"),
        tile("Units sold", units - refunded, `${units} sold, ${refunded} refunded`),
        tile("Refund rate", units ? Math.round((100 * refunded) / units) + "%" : "–", "of units sold in this range"),
        tile("Lifetime", usd(sum(days, "gross")), `gross · ${usd(sum(days, "net"))} net · ${sum(days, "units") - sum(days, "returnedUnits")} units`),
        sum(inRange, "activations") ? tile("Key activations", sum(inRange, "activations"), "keys from outside Steam") : null),
      revenueChart(inRange, start, end, markers(start, end)),
      accountTotals(from),
      countryBreakdown(inRange));
  };
  const range = chips([[7, "1w"], [30, "1m"], [90, "3m"], [365, "1y"], [0, "max"]], f.range, (v) => { f.range = v; draw(); }, "Zoom");
  draw();
  return h("div", h("div.filters", h("span.zoom-label", "Zoom"), range,
    h("span.updated", "Steam's days are Pacific time; recent days can still change as payments settle.")), body);
}

function revenueChart(days, start, end, releases) {
  const bucket = end - start > 120 * DAY ? 7 * DAY : DAY;
  const b0 = Math.floor(start / bucket) * bucket;
  const n = Math.ceil((end - b0) / bucket);
  const rows = Array.from({ length: n }, () => ({ gross: 0, net: 0, units: 0, refunded: 0, discount: 0 }));
  for (const [d, t] of days) {
    const k = Math.floor((dayTime(d) - b0) / bucket);
    if (k < 0 || k >= n) continue;
    rows[k].gross += t.gross || 0; rows[k].net += t.net || 0; rows[k].units += t.units || 0; rows[k].refunded += t.returnedUnits || 0;
    rows[k].discount = Math.max(rows[k].discount, t.discount || 0);
  }
  const max = niceMax(Math.max(1, ...rows.map((r) => Math.max(r.gross, r.net))));
  const x = (t) => M.left + ((t - start) / (end - start)) * (W - M.left - M.right);
  const y = (v) => H - M.bottom - (Math.max(0, v) / max) * (H - M.top - M.bottom);
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart", role: "img", "aria-label": "Gross and net revenue over time" });
  const bw = Math.max(1, (W - M.left - M.right) / n - 2);
  // Days sold at a discount, from the sales themselves.
  rows.forEach((r, k) => {
    if (r.discount) svg.append(svgEl("rect", { x: Math.max(M.left, x(b0 + k * bucket)), y: M.top, width: bw + 2, height: H - M.top - M.bottom, class: "band" }));
  });
  yAxis(svg, y, max, (v) => usd(v));
  timeAxis(svg, x, start, end);
  releaseMarkers(svg, x, releases);
  // Gross as a faint bar, net in front of it: the gap is refunds and tax.
  const bar = (bx, v, fill, opacity = 1) => {
    const top = y(v), base = H - M.bottom, rr = Math.min(4, bw / 2, base - top);
    svg.append(svgEl("path", { d: `M${bx},${base}V${top + rr}Q${bx},${top} ${bx + rr},${top}H${bx + bw - rr}Q${bx + bw},${top} ${bx + bw},${top + rr}V${base}Z`, fill, opacity }));
  };
  rows.forEach((r, k) => {
    const bx = Math.max(M.left, x(b0 + k * bucket)) + 1;
    if (r.gross > 0) bar(bx, r.gross, "var(--fb-accent)", 0.3);
    if (r.net > 0) bar(bx, r.net, "var(--fb-accent)");
  });
  svg.append(svgEl("rect", { x: M.left, y: M.top, width: W - M.left - M.right, height: H - M.top - M.bottom, fill: "transparent" }));
  const legend = h("div.legend", h("span", h("i", { style: "background:var(--fb-accent);opacity:.3" }), "Gross"), h("span", h("i", { style: "background:var(--fb-accent)" }), "Net"), saleLegend());
  const table = h("details", h("summary", "Data table"),
    h("table.data", h("tr", h("th", bucket === DAY ? "Day" : "Week of"), h("th", "Gross"), h("th", "Net"), h("th", "Sold"), h("th", "Refunded"), h("th", "Discount")),
      ...rows.map((r, k) => [k, r]).filter(([, r]) => r.units || r.net).reverse()
        .map(([k, r]) => h("tr", h("td", fmtDate(b0 + k * bucket)), h("td", usd(r.gross, 2)), h("td", usd(r.net, 2)), h("td", r.units), h("td", r.refunded), h("td", r.discount ? r.discount + "%" : "")))));
  const total = rows.reduce((a, r) => a + r.net, 0), gross = rows.reduce((a, r) => a + r.gross, 0);
  const { card, tip } = chartCard(`Revenue per ${bucket === DAY ? "day" : "week"}`, total || gross ? `${usd(gross)} gross, ${usd(total)} net in this range. Dashed lines are updates; shaded days had a discount.` : "No sales in this range.", legend, svg, table);
  svg.addEventListener("pointermove", (e) => {
    const box = svg.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * W;
    const k = Math.floor((start + ((px - M.left) / (W - M.left - M.right)) * (end - start) - b0) / bucket);
    if (k < 0 || k >= n) return;
    const r = rows[k];
    showTip(card, tip, svg, px, y(Math.max(r.gross, r.net)), [
      h("div.t", (bucket === DAY ? "" : "Week of ") + fmtDate(b0 + k * bucket)),
      h("div", h("b", usd(r.gross, 2)), " gross"),
      h("div", h("b", usd(r.net, 2)), " net"),
      h("div", `${r.units} sold${r.refunded ? `, ${r.refunded} refunded` : ""}`),
      r.discount ? h("div.t", `On sale, up to ${r.discount}% off`) : null,
    ].filter(Boolean));
  });
  svg.addEventListener("pointerleave", () => { tip.style.display = "none"; });
  return card;
}

// Every game on the account together, in the range and since launch, and each game's share.
function accountTotals(start) {
  const per = new Map();
  for (const [d, apps] of Object.entries(state.sales?.days || {})) {
    for (const [id, t] of Object.entries(apps)) {
      const g = per.get(id) || { gross: 0, net: 0, units: 0, all: { gross: 0, net: 0, units: 0 } };
      const units = (t.units || 0) - (t.returnedUnits || 0);
      g.all.gross += t.gross || 0; g.all.net += t.net || 0; g.all.units += units;
      if (dayTime(d) >= start) { g.gross += t.gross || 0; g.net += t.net || 0; g.units += units; }
      per.set(id, g);
    }
  }
  const name = (id) => state.index.games.find((g) => String(g.appId) === id)?.name || state.sales.apps?.[id] || `App ${id}`;
  const rows = [...per].filter(([, g]) => g.all.gross || g.all.net).sort((a, b) => b[1].gross - a[1].gross || b[1].all.gross - a[1].all.gross);
  const total = (k, all) => rows.reduce((a, [, g]) => a + (all ? g.all[k] : g[k]), 0);
  const max = Math.max(1, ...rows.map(([, g]) => g.gross));
  const stat = (value, label) => h("div.sh-stat", h("div.sh-value", value), h("div.sh-label", label));
  return h("div.chart-card", h("h3", "Your account"), h("div.sub", "Every game together"),
    h("div.stat-header",
      stat(usd(total("gross")), "gross in this range"),
      stat(usd(total("net")), "net in this range"),
      stat(usd(total("gross", true)), "gross, all time"),
      stat(usd(total("net", true)), `net, all time · ${total("units", true)} units`)),
    h("div.bars", ...rows.flatMap(([id, g]) => [
      h("span", id === String(state.game.appId) ? h("b", name(id)) : name(id)),
      h("div", h("div.bar", { style: `width:${(100 * g.gross) / max}%` })),
      h("span.n", `${usd(g.gross)} gross · ${usd(g.net)} net · ${g.units}`)])));
}

function countryBreakdown(days) {
  const totals = new Map();
  for (const [, t] of days) for (const [cc, [net, units]] of Object.entries(t.countries || {})) {
    const c = totals.get(cc) || [0, 0];
    totals.set(cc, [c[0] + net, c[1] + units]);
  }
  let regions;
  try { regions = new Intl.DisplayNames(["en"], { type: "region" }); } catch {}
  const rows = [...totals].filter(([, [net]]) => net > 0).sort((a, b) => b[1][0] - a[1][0]).slice(0, 12);
  const max = Math.max(1, ...rows.map(([, [net]]) => net));
  return h("div.chart-card", h("h3", "Top countries"), h("div.sub", rows.length ? "Net revenue and units in this range" : "No sales in this range."),
    h("div.bars", ...rows.flatMap(([cc, [net, units]]) => [
      h("span", `${flag(cc.length === 2 ? cc : "")} ${(cc.length === 2 && regions?.of(cc)) || cc}`.trim()),
      h("div", h("div.bar", { style: `width:${(100 * net) / max}%` })),
      h("span.n", `${usd(net)} · ${units}`)])));
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

const W = 760, H = 240, M = { top: 44, right: 12, bottom: 24, left: 40 };

function niceMax(v) {
  if (v <= 4) return Math.max(4, Math.ceil(v));
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v);
}

function timeAxis(svg, x, start, end) {
  const span = end - start;
  const step = span <= 10 * DAY ? DAY : span <= 60 * DAY ? 7 * DAY : span <= 400 * DAY ? 30 * DAY : 90 * DAY;
  const first = Math.ceil(start / DAY) * DAY;
  let last = -1e9;
  for (let t = first; t <= end; t += step) {
    const px = x(t);
    if (px - last < 60) continue;
    last = px;
    const label = svgEl("text", { x: px, y: H - 6, "text-anchor": "middle" });
    label.textContent = fmtShort(t);
    svg.append(label);
  }
}

function yAxis(svg, y, max, fmt = (v) => v) {
  for (const v of [0, max / 2, max]) {
    svg.append(svgEl("line", { x1: M.left, x2: W - M.right, y1: y(v), y2: y(v), class: v === 0 ? "base" : "grid" }));
    const t = svgEl("text", { x: M.left - 6, y: y(v) + 4, "text-anchor": "end" });
    t.textContent = fmt(Math.round(v * 10) / 10);
    svg.append(t);
  }
}

// Updates, the launch and the 10th review as lines, every one labelled: labels that would overlap
// move to the next of three rows above the plot.
const isLaunch = (r) => r.launch || /\b(out now|available now|now available|launch(ed)?|released?)\b/i.test(r.name || "");
// At 10 reviews Steam shows a review score and starts showing the game in more places (the
// discovery queue, "more like this"), so it's marked like a release once it's reached.
const REVIEW_GOAL = 10;
function reviewGoalAt() {
  const tenth = items().filter((i) => i.kind === "review").map((i) => i.created).sort((a, b) => a - b)[REVIEW_GOAL - 1];
  if (tenth) return tenth;
  // Fewer reviews collected than Steam counts: the first day Steam's own total reached 10.
  const day = Object.keys(state.game.reviewTotals || {}).sort().find((d) => { const r = state.game.reviewTotals[d]; return r.positive + r.negative >= REVIEW_GOAL; });
  return day ? Date.parse(day + "T12:00:00Z") / 1000 : null;
}
function markers(start, end) {
  const list = (state.game.releases || []).filter((r) => r.time >= start && r.time <= end);
  // No launch post: mark the store's release date instead.
  const released = state.game.meta?.released;
  if (!list.some(isLaunch) && released && released >= start && released <= end) list.push({ time: released, launch: true, name: "Release" });
  const goal = reviewGoalAt();
  if (goal && goal >= start && goal <= end) list.push({ time: goal, milestone: true, name: `${REVIEW_GOAL} reviews` });
  return list.sort((a, b) => a.time - b.time);
}
function releaseMarkers(svg, x, releases) {
  const rowEnd = [-1e9, -1e9, -1e9];
  for (const r of releases) {
    const px = x(r.time);
    const label = r.milestone ? "⭐ " + r.name : isLaunch(r) ? "🚀 Launch" : r.version ? "v" + r.version : r.name.slice(0, 14);
    const width = label.length * 6 + 8;
    let row = rowEnd.findIndex((e) => px - e > 4);
    if (row < 0) row = rowEnd.indexOf(Math.min(...rowEnd));
    rowEnd[row] = px + width;
    const y = M.top - 6 - row * 12;
    svg.append(svgEl("line", { x1: px, x2: px, y1: y + 2, y2: H - M.bottom, class: r.milestone ? "release milestone" : isLaunch(r) ? "release launch" : "release" }));
    const t = svgEl("text", { x: px + 3, y, class: "release-label" });
    t.textContent = label;
    svg.append(t);
  }
}

// Sale periods (recorded from the store's discount, see feedback/run.py record_discount) as shaded bands.
function saleBands(svg, x, start, end) {
  const series = state.game.discounts || [];
  const bands = [];
  series.forEach(([t, pct], i) => {
    if (!pct) return;
    const from = Math.max(t, start), to = Math.min(series[i + 1]?.[0] ?? end, end);
    if (to > from) bands.push([from, to, pct]);
  });
  for (const [from, to, pct] of bands) {
    svg.append(svgEl("rect", { x: x(from), y: M.top, width: Math.max(2, x(to) - x(from)), height: H - M.top - M.bottom, class: "band" }));
    const t = svgEl("text", { x: x(from) + 4, y: H - M.bottom - 6, class: "band-label" });
    t.textContent = `−${pct}%`;
    svg.append(t);
  }
  return bands.length > 0;
}
const saleLegend = () => h("span", h("i", { style: "background:var(--fb-warning);opacity:.45" }), "On sale");

function chartCard(title, sub, legend, svg, table) {
  const card = h("div.chart-card", h("h3", title), h("div.sub", sub), legend, svg, table);
  const tip = h("div.tip");
  card.append(tip);
  return { card, tip };
}

function showTip(card, tip, svg, px, py, lines) {
  tip.replaceChildren(...lines);
  tip.style.display = "block";
  const box = svg.getBoundingClientRect(), cbox = card.getBoundingClientRect();
  const sx = box.width / W, sy = box.height / H;
  let left = box.left - cbox.left + px * sx + 12;
  if (left + tip.offsetWidth > cbox.width - 8) left = box.left - cbox.left + px * sx - tip.offsetWidth - 12;
  tip.style.left = Math.max(4, left) + "px";
  tip.style.top = box.top - cbox.top + Math.max(0, py * sy - 20) + "px";
}

// A step chart of counts stored on change (players, followers, Discord members), with updates, sales
// and media marked like on every chart. `lines`: [{series, color, unit, dashed}]; the first is the
// main one (its data table, its dot).
function stepChart(start, end, releases, { title, sub, empty, aria, lines }) {
  const step = (series) => {
    // Each stored sample holds until the next one (samples are stored only on change).
    const pts = [];
    const first = playersAt(series, start);
    if (first != null) pts.push([start, first]);
    for (const [t, n] of series) if (t >= start && t <= end) pts.push([t, n]);
    if (pts.length) pts.push([end, pts[pts.length - 1][1]]);
    return pts;
  };
  const drawn = lines.map((l) => ({ ...l, pts: step(l.series || []) }));
  const pts = drawn[0].pts;
  const max = niceMax(Math.max(1, ...drawn.flatMap((l) => l.pts.map((p) => p[1]))));
  const x = (t) => M.left + ((t - start) / (end - start)) * (W - M.left - M.right);
  const y = (v) => H - M.bottom - (v / max) * (H - M.top - M.bottom);
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart", role: "img", "aria-label": aria });
  const onSale = saleBands(svg, x, start, end);
  yAxis(svg, y, max);
  timeAxis(svg, x, start, end);
  releaseMarkers(svg, x, releases);
  const covered = mediaMarks(svg, x, start, end);
  for (const l of drawn.slice().reverse()) {
    if (!l.pts.length) continue;
    let d = `M${x(l.pts[0][0])},${y(l.pts[0][1])}`;
    for (let i = 1; i < l.pts.length; i++) d += `H${x(l.pts[i][0])}V${y(l.pts[i][1])}`;
    svg.append(svgEl("path", { d, fill: "none", stroke: l.color, "stroke-width": l.dashed ? 1.5 : 2, "stroke-dasharray": l.dashed ? "4 3" : "none", "stroke-linejoin": "round" }));
  }
  const cross = svgEl("line", { y1: M.top, y2: H - M.bottom, class: "cross", visibility: "hidden" });
  const dot = svgEl("circle", { r: 4, fill: drawn[0].color, stroke: "var(--fb-card)", "stroke-width": 2, visibility: "hidden" });
  svg.append(cross, dot);
  const main = drawn[0];
  const table = h("details", h("summary", "Data table"),
    h("table.data", h("tr", h("th", "Time"), h("th", main.unit[0].toUpperCase() + main.unit.slice(1))), ...(main.series || []).filter(([t]) => t >= start).slice(-200).reverse().map(([t, n]) => h("tr", h("td", new Date(t * 1000).toLocaleString()), h("td", n)))));
  const legend = [onSale ? saleLegend() : null, ...(drawn.length > 1 ? drawn.map((l) => h("span", h("i", { style: `background:${l.color}` }), l.unit)) : []), ...mediaLegend(covered)].filter(Boolean);
  const { card, tip } = chartCard(title, pts.length ? `${sub} Dashed lines are updates${covered.length ? "; marks along the bottom are streams, videos and posts" : ""}.` : empty,
    legend.length ? h("div.legend", ...legend) : null, svg, table);
  svg.addEventListener("pointermove", (e) => {
    if (!pts.length) return;
    const box = svg.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * W;
    const t = Math.min(end, Math.max(start, start + ((px - M.left) / (W - M.left - M.right)) * (end - start)));
    const v = playersAt(pts, t);
    const span = ((end - start) / (W - M.left - M.right)) * 6; // 6 px either side
    const media = mediaAt(t, span);
    if (v == null && !media.length) return;
    cross.setAttribute("x1", x(t)); cross.setAttribute("x2", x(t)); cross.setAttribute("visibility", "visible");
    dot.setAttribute("cx", x(t)); dot.setAttribute("cy", y(v ?? 0)); dot.setAttribute("visibility", v == null ? "hidden" : "visible");
    const near = releases.find((r) => Math.abs(x(r.time) - x(t)) < 6);
    const values = drawn.map((l) => [l, playersAt(l.pts, t)]).filter(([, n]) => n != null).map(([l, n]) => h("div", h("b", n), " ", l.unit));
    showTip(card, tip, svg, x(t), y(v ?? 0), [...values, h("div.t", new Date(t * 1000).toLocaleString()), near ? h("div.t", near.milestone ? `⭐ Reached ${near.name}` : "Update: " + (near.version ? "v" + near.version : near.name)) : null, ...media].filter(Boolean));
  });
  svg.addEventListener("pointerleave", () => { tip.style.display = "none"; cross.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden"); });
  return card;
}

const playersChart = (start, end, releases) => stepChart(start, end, releases, {
  title: "Concurrent players", aria: "Concurrent players over time", sub: "Steam's current player count, sampled every run.", empty: "No player data in this range.",
  lines: [{ series: state.game.players || [], color: "var(--fb-accent)", unit: "players" }],
});
// Followers of the game's Steam community hub (feedback/community.py), which move with wishlists.
const followersChart = (start, end, releases) => stepChart(start, end, releases, {
  title: "Followers on Steam", aria: "Steam followers over time", sub: "Who follows the game on Steam, checked hourly. It moves with wishlists.", empty: "No follower data in this range.",
  lines: [{ series: state.game.followers || [], color: "var(--type-praise)", unit: "followers" }],
});
// The studio's Discord server (feedback/community.py, in index.json), the same on every game.
const discordChart = (start, end, releases) => stepChart(start, end, releases, {
  title: `Discord: ${state.index.discord?.name || "your server"}`, aria: "Discord members over time", sub: "Members and members online, checked hourly. The same server for every game.", empty: "No Discord data in this range.",
  lines: [{ series: state.index.discord?.members || [], color: "#5865f2", unit: "members" }, { series: state.index.discord?.online || [], color: "#23a559", unit: "online", dashed: true }],
});

function reviewsChart(start, end, releases) {
  // New reviews per day (or week, for long ranges): recommended up, not recommended down.
  const bucket = end - start > 120 * DAY ? 7 * DAY : DAY;
  const b0 = Math.floor(start / bucket) * bucket;
  const n = Math.ceil((end - b0) / bucket);
  const up = new Array(n).fill(0), down = new Array(n).fill(0);
  for (const i of items()) {
    if (i.kind !== "review" || i.created < start) continue;
    const k = Math.floor((i.created - b0) / bucket);
    if (k >= 0 && k < n) (i.votedUp ? up : down)[k]++;
  }
  const max = niceMax(Math.max(1, ...up, ...down));
  const x = (t) => M.left + ((t - start) / (end - start)) * (W - M.left - M.right);
  const mid = M.top + (H - M.top - M.bottom) / 2;
  const half = (H - M.top - M.bottom) / 2;
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart", role: "img", "aria-label": "New reviews over time" });
  for (const v of [max, max / 2]) {
    for (const yy of [mid - (v / max) * half, mid + (v / max) * half]) svg.append(svgEl("line", { x1: M.left, x2: W - M.right, y1: yy, y2: yy, class: "grid" }));
  }
  for (const [v, yy] of [[max, M.top], [0, mid], [max, H - M.bottom]]) {
    const t = svgEl("text", { x: M.left - 6, y: yy + 4, "text-anchor": "end" });
    t.textContent = v;
    svg.append(t);
  }
  const onSale = saleBands(svg, x, start, end);
  releaseMarkers(svg, x, releases);
  const covered = mediaMarks(svg, x, start, end);
  // Each day (or week) gets its own bar, centred in its slot with a clear gap to the next, and its
  // count printed on it, so neighbouring days never run together.
  const slot = (k) => {
    const from = x(Math.max(start, b0 + k * bucket)), to = x(Math.min(end, b0 + (k + 1) * bucket));
    const w = Math.max(3, Math.min(44, (to - from) * 0.62));
    return [from + (to - from - w) / 2, w];
  };
  const bar = (k, value, sign, color) => {
    if (!value) return;
    const [bx, bw] = slot(k);
    const hgt = Math.max(2, (value / max) * half);
    const r = Math.min(4, bw / 2, hgt);
    // Rounded only at the data end, anchored square on the zero line.
    const d = sign > 0
      ? `M${bx},${mid}V${mid - hgt + r}Q${bx},${mid - hgt} ${bx + r},${mid - hgt}H${bx + bw - r}Q${bx + bw},${mid - hgt} ${bx + bw},${mid - hgt + r}V${mid}Z`
      : `M${bx},${mid}V${mid + hgt - r}Q${bx},${mid + hgt} ${bx + r},${mid + hgt}H${bx + bw - r}Q${bx + bw},${mid + hgt} ${bx + bw},${mid + hgt - r}V${mid}Z`;
    svg.append(svgEl("path", { d, fill: color }));
    if (bw >= 10) {
      const label = svgEl("text", { x: bx + bw / 2, y: sign > 0 ? mid - hgt - 4 : mid + hgt + 12, "text-anchor": "middle", class: "bar-count" });
      label.textContent = value;
      svg.append(label);
    }
  };
  for (let k = 0; k < n; k++) { bar(k, up[k], 1, "var(--fb-positive)"); bar(k, down[k], -1, "var(--fb-negative)"); }
  // Dates under their own bars when each slot has room for one; otherwise the usual time axis.
  const slotWidth = (W - M.left - M.right) / ((end - start) / bucket);
  if (slotWidth >= 46) {
    for (let k = 0; k < n; k++) {
      const from = x(Math.max(start, b0 + k * bucket)), to = x(Math.min(end, b0 + (k + 1) * bucket));
      if (to - from < 30) continue;
      const t = svgEl("text", { x: (from + to) / 2, y: H - 6, "text-anchor": "middle" });
      t.textContent = fmtShort(b0 + k * bucket);
      svg.append(t);
    }
  } else timeAxis(svg, x, start, end);
  svg.append(svgEl("line", { x1: M.left, x2: W - M.right, y1: mid, y2: mid, class: "base" }));
  const hit = svgEl("rect", { x: M.left, y: M.top, width: W - M.left - M.right, height: H - M.top - M.bottom, fill: "transparent" });
  svg.append(hit);
  const legend = h("div.legend", h("span", h("i", { style: "background:var(--fb-positive)" }), "Recommended"), h("span", h("i", { style: "background:var(--fb-negative)" }), "Not recommended"), onSale ? saleLegend() : null, ...mediaLegend(covered));
  const total = up.reduce((a, b) => a + b, 0) + down.reduce((a, b) => a + b, 0);
  const table = h("details", h("summary", "Data table"),
    h("table.data", h("tr", h("th", bucket === DAY ? "Day" : "Week of"), h("th", "👍"), h("th", "👎")),
      ...up.map((u, k) => [k, u, down[k]]).filter(([, u, d]) => u || d).reverse().map(([k, u, d]) => h("tr", h("td", fmtDate(b0 + k * bucket)), h("td", u), h("td", d)))));
  const { card, tip } = chartCard(`New reviews per ${bucket === DAY ? "day" : "week"}`, total ? `${total} in this range. Dashed lines are updates.` : "No reviews in this range.", legend, svg, table);
  svg.addEventListener("pointermove", (e) => {
    const box = svg.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * W;
    const t = start + ((px - M.left) / (W - M.left - M.right)) * (end - start);
    const k = Math.floor((t - b0) / bucket);
    if (k < 0 || k >= n) return;
    showTip(card, tip, svg, px, mid - (up[k] / max) * half, [
      h("div.t", (bucket === DAY ? "" : "Week of ") + fmtDate(b0 + k * bucket)),
      h("div", h("b", up[k]), " recommended"),
      h("div", h("b", down[k]), " not recommended"),
      ...mediaAt(b0 + k * bucket + bucket / 2, bucket / 2),
    ]);
  });
  svg.addEventListener("pointerleave", () => { tip.style.display = "none"; });
  return card;
}


// ---------------------------------------------------------------------------
// Mount (called by src/views/FeedbackView.vue once the page is in the browser)
// ---------------------------------------------------------------------------

const SHELL = `
<div class="fb-layout">
  <aside class="fb-side" aria-label="Games and views">
    <div class="side-card" id="fb-games-side"></div>
    <div class="side-card side-views">
      <div class="side-label">Views</div>
      <nav class="nav-side" id="fb-nav-side" aria-label="Views"></nav>
    </div>
  </aside>
  <div class="fb-main">
    <div class="strip" id="fb-games-strip" aria-label="Games"></div>
    <header class="top">
      <img id="fb-capsule" alt="" hidden>
      <div class="top-text"><h2 id="fb-title">Loading…</h2><div class="updated" id="fb-updated"></div></div>
      <div class="steam-links" id="fb-links"></div>
    </header>
    <section class="kpis" id="fb-stats" aria-label="Summary"></section>
    <div id="fb-expand"></div>
    <nav class="nav-top" id="fb-nav-top" aria-label="Views"></nav>
    <div id="fb-view"></div>
  </div>
</div>
<div class="toast" id="fb-toast" role="status"></div>`;

// The Steam menu is a <details>; close it when clicking elsewhere or pressing Escape.
document.addEventListener("click", (e) => {
  document.querySelectorAll(".fb .steam-menu[open]").forEach((m) => { if (!m.contains(e.target)) m.open = false; });
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") document.querySelectorAll(".fb .steam-menu[open]").forEach((m) => { m.open = false; });
});

// Left open (on a TV, say), the page keeps itself current: every 5 minutes it asks GitHub for the
// newest data commit and, when there is one, reloads the data and redraws in place, keeping the
// game, view, filters, open chart and scroll position. Every 12 hours it reloads the whole page,
// to pick up changes to the dashboard itself.
const REFRESH_MS = 5 * 60 * 1000;
const FULL_RELOAD_MS = 12 * 3600 * 1000;
let refreshTimer = null;
let clockTimer = null;
const loadedAt = Date.now();

async function refresh() {
  if (!document.getElementById("fb-view")) return clearInterval(refreshTimer); // left the page
  if (!state.game) return;
  if (Date.now() - loadedAt > FULL_RELOAD_MS && !window.getSelection().toString()) return location.reload();
  const loaded = DATA;
  await dataBase();
  // A new data commit, or (when GitHub's API is skipped and the data comes straight from main)
  // every round, since main may have moved on.
  if (DATA !== loaded || DATA.includes("/main/")) {
    try {
      const index = await getJson("index.json");
      const appId = state.game.appId;
      const game = await getJson(`games/${appId}.json`);
      await loadCleared();
      await loadSales();
      state.index = index;
      state.games = { [appId]: game }; // other games reload when picked
      state.game = { ...game, meta: index.games.find((g) => g.appId === appId) };
    } catch {
      DATA = loaded;
      return; // try again next time
    }
  }
  // Nothing new since the last redraw: only the header's times and check status change, so open
  // posts stay open. Not while typing in a search box either (a redraw would wipe it); next round.
  if (drawnKey() === state.drawn || document.activeElement?.matches?.(".fb input")) {
    renderStatus();
    renderHeader();
    return;
  }
  // New data: redraw, keeping the reader's place.
  const y = window.scrollY;
  renderStatus();
  render();
  window.scrollTo(0, y);
}

export function mount(root) {
  if (!document.getElementById("fb-dash-css")) {
    document.head.append(h("style", { id: "fb-dash-css" }, CSS));
  }
  root.innerHTML = SHELL;
  // Lets the site's header show a "Feedback" link in this browser from now on (SiteHeader.vue).
  store.set("visited", "1");
  init();
  clearInterval(refreshTimer);
  refreshTimer = setInterval(refresh, REFRESH_MS);
  // The header's "x min ago" counts up every minute on its own; only new data needs the network.
  clearInterval(clockTimer);
  clockTimer = setInterval(() => {
    if (!document.getElementById("fb-view")) return clearInterval(clockTimer);
    renderStatus();
    if (state.game) renderHeader();
  }, 60 * 1000);
}
