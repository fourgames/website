// Your games' stats from Steamworks' report pages that have no API: playtime, hardware survey,
// controllers, Remote Play, downloads by region, players and Steam Deck. They need your Steamworks
// login, so the scheduled task on your Mac runs this with Claude in Chrome, in a signed-in tab on
// partner.steampowered.com. It returns at once and works in the background (reading every page
// takes longer than a tool call may wait); when done it writes the result as JSON into the page (a
// <pre>, ending in a line "END") and sets the tab's title to "steamworks ready" (or "steamworks
// failed: …"), for the task to read with get_page_text; feedback/steamworks_save.py
// saves it as steamworks.json in the private data repo, which the dashboard's Steam stats view shows.
// Each page is kept as its tables ({title, rows: [[cell, …], …]}), so a changed page still reads.
// Its own JSON writer: the site's old scripts (Prototype) break JSON.stringify.
document.title = "steamworks reading";
(async () => {
  const html = async (url) => new DOMParser().parseFromString(await (await fetch(url, { credentials: "include" })).text(), "text/html");
  // A cell's text, without the "(?)" help text Steam puts in some.
  const clean = (el) => el.textContent.replace(/\s+/g, " ").split("(?)")[0].trim();
  // Every table with more than one row, titled by the heading before it. Tables whose numbers are all
  // 0 are left out (a small game's hardware survey and Remote Play pages are all zeros), and so are repeats.
  const tables = (doc) => {
    const heads = [...doc.querySelectorAll("h1, h2, h3, h4")];
    const seen = new Set();
    return [...doc.querySelectorAll("table")].filter((t) => t.rows.length > 1 && !t.querySelector("table")).map((t) => {
      const head = heads.filter((x) => x.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING).pop();
      return { title: head ? clean(head) : "", rows: [...t.rows].slice(0, 60).map((r) => [...r.cells].map(clean)).filter((r) => r.some(Boolean)) };
    }).filter((t) => {
      const numbers = t.rows.flat().filter((c) => /^[\d.,%$() +-]+$/.test(c));
      const key = t.rows.flat().join("|");
      if (seen.has(key) || !numbers.some((c) => /[1-9]/.test(c))) return false;
      seen.add(key);
      return true;
    });
  };
  const pages = {
    playtime: (id) => `/app/playtime/${id}/`,
    players: (id) => `/app/players/${id}/`,
    hardware: (id) => `/survey2.php?appID=${id}`,
    controllers: (id) => `/app/controllerstats/${id}/`,
    remotePlay: (id) => `/app/remoteplay/${id}/`,
    downloads: (id) => `/nav_regions.php?downloads=1&appID=${id}`,
  };
  const top = await html("/app/top/");
  const apps = {};
  for (const a of top.querySelectorAll('a[href*="/app/details/"]')) apps[a.href.match(/details\/(\d+)/)[1]] = clean(a);
  const out = { apps: {}, deck: tables(await html("/deckplayers.php")) };
  // Every page of every game at once.
  await Promise.all(Object.entries(apps).map(async ([id, name]) => {
    out.apps[id] = { name, pages: {} };
    await Promise.all(Object.entries(pages).map(async ([page, url]) => { out.apps[id].pages[page] = tables(await html(url(id))); }));
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
  document.title = "steamworks ready";
})().catch((error) => { document.title = `steamworks failed: ${error.message}`; });
"started";
