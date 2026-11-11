// The fan mailing list's numbers on the Creators view (server/news writes stats.json, the game-data
// server serves it signed-in at /admin/news). Numbers only: the dashboard never sees an address.
// One small badge, loaded once per page load; the creators view puts it next to its tab switcher.

let el = null;
let loaded = false;

function show(C, text, title) {
  el.textContent = text;
  el.title = title || "";
}

async function load(C) {
  loaded = true;
  try {
    const res = C.dataOverride ? await fetch(`${C.dataOverride}/news.json`, { cache: "no-store" }) : await C.adminGet("news");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const s = await res.json();
    const week = Object.entries(s.days || {})
      .filter(([day]) => Date.now() - Date.parse(day) < 7 * 86400000)
      .reduce((n, [, d]) => n + (d.confirmed || 0) - (d.unsubscribed || 0), 0);
    show(C, `Mailing list: ${C.plural(s.confirmed || 0, "fan")}${week ? ` (${week > 0 ? "+" : ""}${week} this week)` : ""}`,
      `Confirmed addresses on the fan mailing list (footer signup on fourgames.se).${s.pending ? ` ${s.pending} more waiting to confirm.` : ""}`);
  } catch (e) {
    if (e.signedOut) return;
    show(C, /not_built|404/.test(e.message) ? "Mailing list: not running yet" : "Mailing list: couldn't load", "server/news, see its README");
  }
}

export function newsBadge(C) {
  el ??= Object.assign(document.createElement("span"), { className: "cr-muted" });
  el.style.cssText = "margin-left:auto;align-self:center;font-size:13px;white-space:nowrap";
  if (!loaded) {
    show(C, "Mailing list: …");
    load(C);
  }
  return el;
}
