// Every refund note players left, for every package, from Steamworks' refund pages (they need your
// Steamworks login, so the collector can't read them). Run in a signed-in tab on
// partner.steampowered.com (the scheduled "refund notes" task does this with Claude in Chrome); it
// keeps {packageId: {name, notes: [{category, language, text, date}], reasons: {category: refunds},
// sold, returned, refunded}} (lifetime; every refund counts, with a note or not) as JSON in
// window.__refundNotes and returns its length; read it out in parts of 800 characters with
// `window.__refundNotes.slice(0, 800)`, `.slice(800, 1600)`… (a tool's output is cut off when long),
// then feedback/refunds_save.py merges it into refunds.json in the private data repo. run.py turns each note into a post.
(async () => {
  const html = async (url) => new DOMParser().parseFromString(await (await fetch(url, { credentials: "include" })).text(), "text/html");
  const today = new Date().toISOString().slice(0, 10);
  const list = await html(`/package/steam/?dateStart=2000-01-01&dateEnd=${today}`);
  const packages = {};
  for (const a of list.querySelectorAll('a[href*="/package/details/"]')) packages[a.href.match(/details\/(\d+)/)[1]] = a.textContent.trim();
  const out = {};
  for (const [id, name] of Object.entries(packages)) {
    // range=0 is the lifetime view; the notes endpoint follows the page's range.
    const page = await html(`/package/refunds/${id}/?range=0`);
    const categories = new Map();
    for (const a of page.querySelectorAll('a[onclick*="Refund_LoadText"]')) {
      const m = a.getAttribute("onclick").match(/'(\d+)',\s*'(\d+)'/);
      if (m) categories.set(m[2], a.closest("tr")?.cells[0]?.textContent.trim());
    }
    // The page's tables: units sold and returned, then each reason Steam's form offers with its count.
    const rows = [...page.querySelectorAll("tr")].map((tr) => [...tr.cells].map((c) => c.textContent.replace(/\s+/g, " ").trim()));
    const count = (cell) => parseInt((cell || "").replace(/,/g, ""), 10);
    const total = (label) => { const r = rows.find((x) => x[0] === label); return r ? count(r[1]) : null; };
    const reasons = {};
    const head = rows.findIndex((r) => r[0] === "Category");
    if (head >= 0) for (const r of rows.slice(head + 1)) if (r[0] && Number.isFinite(count(r[1]))) reasons[r[0]] = count(r[1]);
    const notes = [];
    for (const [issue, category] of categories) {
      const res = await (await fetch(`/package/AjaxRefundText/${id}/?packageid=${id}&help_issueid=${issue}`, { credentials: "include" })).json();
      const doc = new DOMParser().parseFromString(res.html || "", "text/html");
      for (const tr of doc.querySelectorAll(".refund_notes_table tr")) {
        const text = tr.querySelector(".refund_note_text")?.textContent.trim();
        if (!text) continue;
        const language = tr.querySelector(".refund_note_language")?.textContent.trim().replace(/^\(|\)$/g, "") || "English";
        notes.push({ category, language, text, date: tr.cells[1]?.textContent.trim() });
      }
    }
    const sold = total("Gross units sold");
    if (categories.size || sold) out[id] = { name, notes, reasons, sold, returned: total("Gross units returned"), refunded: total("Refunded units") };
  }
  // The page's own scripts (Prototype) give arrays a toJSON that turns them into strings.
  const toJSON = Array.prototype.toJSON;
  delete Array.prototype.toJSON;
  window.__refundNotes = JSON.stringify(out);
  if (toJSON) Array.prototype.toJSON = toJSON;
  return window.__refundNotes.length;
})();
