// A Steam-store-style laurel, the kind most developers make themselves: a white wreath around the
// event's name, "Official Selection" / "NOMINEE" / "WINNER" and the year, on a transparent background
// (for the dark store page). Used for events that hand out no badge art of their own.

const W = 280, H = 180, CX = 140, CY = 92, RX = 110, RY = 76;

function branch(side) {
  // From the bottom (t = 0) up the side to near the top; a leaf pair at each node, pointing up the stem.
  const parts = [];
  const pt = (deg) => {
    const a = (deg * Math.PI) / 180;
    return [CX + side * RX * Math.sin(a), CY + RY * Math.cos(a)];
  };
  const [x0, y0] = pt(18), [x1, y1] = pt(150);
  parts.push(`<path d="M${x0.toFixed(1)} ${y0.toFixed(1)} A${RX} ${RY} 0 0 ${side > 0 ? 0 : 1} ${x1.toFixed(1)} ${y1.toFixed(1)}" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>`);
  for (let deg = 24; deg <= 150; deg += 11.5) {
    const [x, y] = pt(deg);
    const size = 1 - (deg - 26) / 360; // leaves shrink a little towards the tips
    // Tangent direction (going up the branch), in SVG degrees.
    const tan = (Math.atan2(-RY * Math.sin((deg * Math.PI) / 180), side * RX * Math.cos((deg * Math.PI) / 180)) * 180) / Math.PI;
    for (const off of [-34, 40]) {
      const rot = tan + side * off * -1;
      const rx = 13.5 * size, ry = 5.6 * size;
      const a = (rot * Math.PI) / 180;
      const lx = x + Math.cos(a) * rx * 0.85, ly = y + Math.sin(a) * rx * 0.85;
      parts.push(`<ellipse cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" rx="${rx.toFixed(1)}" ry="${ry.toFixed(1)}" transform="rotate(${rot.toFixed(1)} ${lx.toFixed(1)} ${ly.toFixed(1)})" fill="currentColor"/>`);
    }
  }
  // A leaf at the very tip.
  const [tx, ty] = pt(156);
  const tipRot = side > 0 ? -150 : -30;
  parts.push(`<ellipse cx="${tx.toFixed(1)}" cy="${ty.toFixed(1)}" rx="11" ry="4.6" transform="rotate(${tipRot} ${tx.toFixed(1)} ${ty.toFixed(1)})" fill="currentColor"/>`);
  return parts.join("");
}

// Break the name into at most 3 lines of about `max` characters.
function wrap(text, max) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  for (const w of words) {
    const last = lines[lines.length - 1];
    if (last && (last + " " + w).length <= max) lines[lines.length - 1] = last + " " + w;
    else lines.push(w);
  }
  if (lines.length > 3) return [...lines.slice(0, 2), lines.slice(2).join(" ")];
  return lines;
}

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// {top: "Official Selection" | "Nominee" | "Winner", name: "Tiny Teams", year: "2027"} → an SVG string.
// Like most store-page laurels: Official Selection puts the event's name big with the label under it;
// Nominee and Winner put the label big with the event's name small above.
const FONT = "'Helvetica Neue', Helvetica, Arial, sans-serif";
const AVAIL = 160; // px between the branches
const fit = (lines, max, em = 0.6) => Math.min(max, Math.floor(AVAIL / (Math.max(...lines.map((l) => l.length)) * em)));

export function laurelSvg({ top, name, year }, color = "#fff") {
  const rows = []; // [text, size, weight, letterSpacing]
  if (/selection/i.test(top)) {
    const lines = wrap(name, 15);
    const size = fit(lines, 26);
    for (const l of lines) rows.push([l, size, 800, 0]);
    rows.push([top, Math.min(16, fit([top], 16, 0.55)), 500, 0]);
  } else {
    const lines = wrap(name, 22);
    const size = fit(lines, 12, 0.55);
    for (const l of lines) rows.push([l, size, 500, 0]);
    rows.push([top.toUpperCase(), fit([top.toUpperCase()], 30, 0.7), 800, 0.5]);
  }
  if (year) rows.push([year, 12, 700, 1]);
  const gap = (sz) => sz * 1.12;
  const height = rows.reduce((t, [, sz]) => t + gap(sz), 0) + (year ? 4 : 0);
  let y = CY - height / 2 - 4;
  const text = rows.map(([t, sz, w, ls], i) => {
    y += gap(sz) + (year && i === rows.length - 1 ? 4 : 0);
    return `<text x="${CX}" y="${y.toFixed(1)}" font-size="${sz}" font-weight="${w}" letter-spacing="${ls}">${esc(t)}</text>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" style="color:${color}">`
    + `<g>${branch(-1)}${branch(1)}</g>`
    + `<g fill="currentColor" text-anchor="middle" font-family="${FONT}">${text.join("")}</g></svg>`;
}

// The SVG drawn onto a canvas at 4x and saved as a transparent PNG.
export async function saveLaurelPng(svg, filename) {
  const img = new Image();
  img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = W * 4; canvas.height = H * 4;
  canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
