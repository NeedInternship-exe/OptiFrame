// 1:1 SVG of the measured outlines: print at 100 % and lay the lens on it.
import { bbox, type Poly } from '../core/geom.ts';
import type { Eye } from '../core/mat.ts';
import { fmt, type Measures } from '../core/measure.ts';

export interface SvgLens {
  eye: Eye;
  contour: Poly; // lens frame, front view, y down (mm)
  measures: Measures;
  label?: string;
}

const esc = (s: string) => s.replace(/[<&>]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]!);

export function contoursSVG(lenses: SvgLens[], when = new Date()): string {
  const W = 210, H = 297;
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}mm" height="${H}mm" viewBox="0 0 ${W} ${H}">`,
    `<rect width="${W}" height="${H}" fill="#fff"/>`,
    `<g font-family="Helvetica, Arial, sans-serif" fill="#111">`,
    `<text x="15" y="16" font-size="5" font-weight="bold">OptiFrame — contours des verres à l’échelle 1:1</text>`,
    `<text x="15" y="22" font-size="3">Imprimer à 100 % (taille réelle). Poser le verre face bombée vers le haut sur son tracé. ${esc(when.toLocaleString('fr-CA'))}</text>`,
    `</g>`,
  ];
  // print-scale check bar
  const bx = 15, by = 30;
  out.push(`<g stroke="#111" stroke-width="0.25"><line x1="${bx}" y1="${by}" x2="${bx + 50}" y2="${by}"/>`);
  for (let i = 0; i <= 50; i += 5) out.push(`<line x1="${bx + i}" y1="${by}" x2="${bx + i}" y2="${by - (i % 10 === 0 ? 3 : 1.8)}"/>`);
  out.push(`</g><text x="${bx + 53}" y="${by}" font-size="3" font-family="Helvetica, Arial">← contrôle : doit mesurer exactement 50 mm</text>`);

  const slotH = (H - 50) / Math.max(1, lenses.length);
  lenses.forEach((l, i) => {
    const b = bbox(l.contour);
    const cx = W / 2, cy = 50 + slotH * (i + 0.5);
    const ox = cx - (b.minX + b.maxX) / 2, oy = cy - (b.minY + b.maxY) / 2;
    const d = l.contour.map(([x, y], k) => `${k ? 'L' : 'M'}${(x + ox).toFixed(3)},${(y + oy).toFixed(3)}`).join('') + 'Z';
    const m = l.measures;
    out.push(
      `<rect x="${(b.minX + ox).toFixed(3)}" y="${(b.minY + oy).toFixed(3)}" width="${m.A.toFixed(3)}" height="${m.B.toFixed(3)}" fill="none" stroke="#999" stroke-width="0.15" stroke-dasharray="1.5 1"/>`,
      `<path d="${d}" fill="none" stroke="#000" stroke-width="0.25"/>`,
      `<g stroke="#c00" stroke-width="0.15"><line x1="${cx - 3}" y1="${cy}" x2="${cx + 3}" y2="${cy}"/><line x1="${cx}" y1="${cy - 3}" x2="${cx}" y2="${cy + 3}"/></g>`,
    );
    const nasal = l.eye === 'OD' ? 'nez →' : '← nez';
    const name = l.eye === 'OD' ? 'Verre droit (OD)' : 'Verre gauche (OS)';
    out.push(
      `<text x="${cx}" y="${(b.minY + oy - 6).toFixed(2)}" font-size="3.6" font-weight="bold" text-anchor="middle" font-family="Helvetica, Arial">${name} · ${nasal}</text>`,
      `<text x="${cx}" y="${(b.minY + oy - 2).toFixed(2)}" font-size="3" text-anchor="middle" font-family="Helvetica, Arial">A ${fmt(m.A, 2)} mm × B ${fmt(m.B, 2)} mm · périmètre ${fmt(m.perimeter, 1)} mm · ED ${fmt(m.ed, 1)} mm${l.label ? ` · ${esc(l.label)}` : ''}</text>`,
    );
  });
  out.push('</svg>');
  return out.join('\n');
}

export function download(name: string, data: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
