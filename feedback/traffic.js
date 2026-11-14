// Your games' store traffic from Steamworks' Traffic Breakdown page (no API): store page visits per
// day by where they came from, including outside websites like youtube.com. The dashboard's "Videos
// that moved sales" card uses it as the best evidence of what a video did (visits from youtube.com
// on the days after it went up).
//
// The page is on partner.steamgames.com (not partner.steampowered.com like steamworks.js), so the
// scheduled task on your Mac runs this with Claude in Chrome in a signed-in tab THERE. First it sets
// window.__trafficPlan = {appId: ["YYYY-MM-DD", …]}, the days to read (printed by
// `python3 feedback/traffic_save.py --plan`). It returns at once and works in the background; when
// done it writes the result as JSON into the page (a <pre>, ending in a line "END") and sets the tab's
// title to "traffic ready" (or "traffic failed: …"). feedback/traffic_save.py merges it into
// traffic.json in the private data repo.
//
// One page read per game per day (the page sums a date range; one day at a time gives the days).
// Each day keeps the page's table that has a "Visits" column: its column names and one row per
// source ([label, numbers…]), e.g. ["youtube.com", 1200, 85, …]. Rows without a number are left out.
// Its own JSON writer, like steamworks.js.
document.title = "traffic reading";
(async () => {
  const plan = window.__trafficPlan;
  if (!plan || !Object.keys(plan).length) throw new Error("set window.__trafficPlan first (traffic_save.py --plan)");
  const clean = (el) => el.textContent.replace(/\s+/g, " ").split("(?)")[0].trim();
  const number = (text) => {
    const t = text.replace(/[,\s%$]/g, "");
    return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : null;
  };
  const read = async (id, day) => {
    const url = `/apps/navtrafficstats/${id}?attribution_filter=all&preset_date_range=custom&start_date=${day}&end_date=${day}`;
    const res = await fetch(url, { credentials: "include" });
    if (res.url.includes("/login")) throw new Error("not signed in to partner.steamgames.com");
    const doc = new DOMParser().parseFromString(await res.text(), "text/html");
    for (const table of doc.querySelectorAll("table")) {
      const rows = [...table.rows].map((r) => [...r.cells].map(clean));
      const head = rows.findIndex((r) => r.some((c) => /visits/i.test(c)));
      if (head < 0) continue;
      const body = rows.slice(head + 1)
        .map((r) => [r[0], ...r.slice(1).map(number)])
        .filter((r) => r[0] && r.slice(1).some((n) => n != null));
      return { cols: rows[head], rows: body.slice(0, 300) };
    }
    return { cols: [], rows: [], missing: true }; // no table with visits: the page changed, or no data
  };
  const out = { apps: {} };
  const jobs = Object.entries(plan).flatMap(([id, days]) => days.map((day) => [id, day]));
  // A few at a time: Steamworks is slow with many at once.
  let next = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < jobs.length) {
      const [id, day] = jobs[next++];
      (out.apps[id] ??= { days: {} }).days[day] = await read(id, day);
      document.title = `traffic reading ${next}/${jobs.length}`;
    }
  }));
  const str = (text) => {
    let o = '"';
    for (const ch of text) {
      const c = ch.charCodeAt(0);
      o += ch === '"' || ch === "\\" || c < 32 || c === 0x2028 || c === 0x2029 ? "\\u" + c.toString(16).padStart(4, "0") : ch;
    }
    return o + '"';
  };
  const json = (v) => v == null ? "null" : typeof v === "number" ? (isFinite(v) ? String(v) : "null") : typeof v === "boolean" ? String(v)
    : typeof v === "string" ? str(v) : Array.isArray(v) ? "[" + v.map(json).join(",") + "]"
    : "{" + Object.keys(v).map((k) => str(k) + ":" + json(v[k])).join(",") + "}";
  const pre = document.createElement("pre");
  pre.textContent = json(out) + "\nEND";
  document.body.replaceChildren(pre);
  document.title = "traffic ready";
})().catch((error) => { document.title = `traffic failed: ${error.message}`; });
"started";
