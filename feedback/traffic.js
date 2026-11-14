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
// One read per game per day (the page sums a date range; one day at a time gives the days), from the
// page's own "Download … in CSV format" link (the same URL with &format=csv): since late 2026 the page
// draws its breakdown with scripts, so the HTML has no table to read. The CSV has one line per
// [Page / Category, Page / Feature, Impressions, Visits, Owner Impressions, Owner Visits], then one per
// country. Each day keeps cols ["Source", "Impressions", "Visits", …] and one row per source,
// [label, numbers…]: an outside site by its domain (["youtube.com", 0, 85, 0, 0]), anything else
// summed per category (["Home Page", 120, 4, 0, 0]).
// Its own JSON writer, like steamworks.js.
document.title = "traffic reading";
(async () => {
  const plan = window.__trafficPlan;
  if (!plan || !Object.keys(plan).length) throw new Error("set window.__trafficPlan first (traffic_save.py --plan)");
  const number = (text) => {
    const t = text.replace(/[,\s%$]/g, "");
    return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : null;
  };
  // CSV lines into cells (quoted cells may hold commas and "" for a quote).
  const parse = (text) => text.split(/\r?\n/).filter((l) => l.trim()).map((line) => {
    const cells = [];
    let cell = "", quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ",") { cells.push(cell.trim()); cell = ""; } else cell += ch;
    }
    cells.push(cell.trim());
    return cells;
  });
  // Steamworks sometimes drops a request when many run at once: try a few times.
  const get = async (url) => {
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await fetch(url, { credentials: "include" });
        if (res.url.includes("/login")) throw new Error("not signed in to partner.steamgames.com");
        if (res.ok) return await res.text();
        if (attempt >= 4) throw new Error(`HTTP ${res.status}`);
      } catch (error) {
        if (/signed in/.test(error.message) || attempt >= 4) throw error;
      }
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  };
  const read = async (id, day) => {
    const url = `/apps/navtrafficstats/${id}?attribution_filter=all&preset_date_range=custom&start_date=${day}&end_date=${day}&format=csv`;
    const [head, ...lines] = parse(await get(url));
    // Not the CSV (a sign-in or error page): the page changed.
    if (!head || !/^page/i.test(head[0]) || !head.some((c) => /^visits$/i.test(c))) return { cols: [], rows: [], missing: true };
    // Summed per category, outside sites per domain; countries and bot traffic left out (they'd make
    // the page text too long to read out, and nothing uses them).
    const sums = new Map();
    for (const [category, feature, ...rest] of lines) {
      if (!category || /^(country|bot traffic)$/i.test(category)) continue;
      const label = /^external website$/i.test(category) && feature ? feature : category;
      const sum = sums.get(label) || rest.map(() => 0);
      rest.forEach((cell, i) => { sum[i] += number(cell) || 0; });
      sums.set(label, sum);
    }
    const rows = [...sums].map(([label, sum]) => [label, ...sum]).filter((r) => r.slice(1).some((n) => n));
    return { cols: ["Source", ...head.slice(2)], rows };
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
