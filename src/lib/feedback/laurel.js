// A Steam-store-style laurel: two leafy branches around "OFFICIAL SELECTION", the event's name and
// the year, in one colour on a transparent background (white for the dark store page). Events only send
// their own laurel art to games that got in; this shows what that badge will roughly look like, and the
// PNG is fine to use until the official one arrives.

const W = 280, H = 180, CX = 140, CY = 92, RX = 110, RY = 76;

function branch(side) {
  // From the bottom (t = 0) up the side to near the top; a leaf pair at each node, pointing up the stem.
  const parts = [];
  const pt = (deg) => {
    const a = (deg * Math.PI) / 180;
    return [CX + side * RX * Math.sin(a), CY + RY * Math.cos(a)];
  };
  const [x0, y0] = pt(18), [x1, y1] = pt(150);
  parts.push(`<path d="M${x0.toFixed(1)} ${y0.toFixed(1)} A${RX} ${RY} 0 0 ${side > 0 ? 0 : 1} ${x1.toFixed(1)} ${y1.toFixed(1)}" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>`);
  for (let deg = 26; deg <= 150; deg += 12.5) {
    const [x, y] = pt(deg);
    const size = 1 - (deg - 26) / 300; // leaves shrink a little towards the tips
    // Tangent direction (going up the branch), in SVG degrees.
    const tan = (Math.atan2(-RY * Math.sin((deg * Math.PI) / 180), side * RX * Math.cos((deg * Math.PI) / 180)) * 180) / Math.PI;
    for (const off of [-38, 38]) {
      const rot = tan + side * off * -1;
      const rx = 11 * size, ry = 4.2 * size;
      const a = (rot * Math.PI) / 180;
      const lx = x + Math.cos(a) * rx * 0.85, ly = y + Math.sin(a) * rx * 0.85;
      parts.push(`<ellipse cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" rx="${rx.toFixed(1)}" ry="${ry.toFixed(1)}" transform="rotate(${rot.toFixed(1)} ${lx.toFixed(1)} ${ly.toFixed(1)})" fill="currentColor"/>`);
    }
  }
  // A leaf at the very tip.
  const [tx, ty] = pt(156);
  const tipRot = side > 0 ? -150 : -30;
  parts.push(`<ellipse cx="${tx.toFixed(1)}" cy="${ty.toFixed(1)}" rx="9" ry="3.6" transform="rotate(${tipRot} ${tx.toFixed(1)} ${ty.toFixed(1)})" fill="currentColor"/>`);
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

// {top: "OFFICIAL SELECTION", name: "Tiny Teams", year: "2027"} → an SVG string.
export function laurelSvg({ top, name, year }, color = "#fff") {
  const lines = wrap(name.toUpperCase(), 14);
  // Fit the longest line in the ~150px between the branches (Georgia caps run about 0.72em wide).
  const nameSize = Math.min(18, Math.floor(150 / (Math.max(...lines.map((l) => l.length)) * 0.72)));
  const gap = nameSize + 3;
  const block = 12 + 8 + lines.length * gap + (year ? 16 : 0);
  let y = CY - block / 2 + 10;
  const text = [`<text x="${CX}" y="${y}" font-size="9" letter-spacing="1.4" font-weight="600">${esc(top.toUpperCase())}</text>`];
  y += 8;
  for (const l of lines) { y += gap; text.push(`<text x="${CX}" y="${y - 3}" font-size="${nameSize}" font-weight="800" letter-spacing="0.5">${esc(l)}</text>`); }
  if (year) { y += 16; text.push(`<text x="${CX}" y="${y - 2}" font-size="12" font-weight="600" letter-spacing="2">${esc(year)}</text>`); }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" style="color:${color}">`
    + `<g>${branch(-1)}${branch(1)}</g>`
    + `<g fill="currentColor" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif">${text.join("")}</g></svg>`;
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
