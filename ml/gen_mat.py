"""Generate the OptiFrame capture mat (A4 landscape) from a single layout spec.

Outputs:
  shared/mat.json              layout used by the web app and the ML scripts
  public/mat/optiframe-mat-A4.pdf  vector PDF to print at 100 % ("actual size")
  public/mat/optiframe-mat-A4.svg  same layout as SVG (preview in the app)
  ml/assets/mat_<ppm>ppm.png   raster renders used for synthetic data

All coordinates are in millimetres, origin at the top-left corner of the page,
x to the right, y downwards (same convention as images).
"""
from __future__ import annotations

import json
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]

PAGE_W, PAGE_H = 297.0, 210.0
MARKER = 24.0  # marker side (6x6 cells of 4 mm, 1-cell black border included)
DICT = "DICT_4X4_50"

# Top-left corner of each marker. IDs go clockwise from the top-left corner.
MARKERS = [
    (0, 10.0, 10.0),
    (1, 136.5, 10.0),
    (2, 263.0, 10.0),
    (3, 263.0, 93.0),
    (4, 263.0, 176.0),
    (5, 136.5, 176.0),
    (6, 10.0, 176.0),
    (7, 10.0, 93.0),
]

# Lens zones as seen from the front of the glasses: the right-eye lens (OD)
# sits on the left of the picture, the left-eye lens (OS) on the right.
ZONES = {
    "OD": {"x": 42.0, "y": 42.0, "w": 88.0, "h": 126.0, "nasal": "right"},
    "OS": {"x": 167.0, "y": 42.0, "w": 88.0, "h": 126.0, "nasal": "left"},
}
RULER = {"x": 148.5, "y0": 55.0, "y1": 155.0}
VERSION = "OptiFrame mat A4 v1"


def marker_bits(mid: int) -> list[list[int]]:
    d = cv2.aruco.getPredefinedDictionary(getattr(cv2.aruco, DICT))
    img = cv2.aruco.generateImageMarker(d, mid, 6)
    return [[1 if v < 128 else 0 for v in row] for row in img]  # 1 = black


def marker_corners(x: float, y: float) -> list[list[float]]:
    # ArUco corner order: TL, TR, BR, BL (clockwise in image coordinates)
    return [[x, y], [x + MARKER, y], [x + MARKER, y + MARKER], [x, y + MARKER]]


def black_runs(bits: list[list[int]]):
    """Yield (row, col_start, length) for horizontal runs of black cells."""
    for r, row in enumerate(bits):
        c = 0
        while c < len(row):
            if row[c]:
                s = c
                while c < len(row) and row[c]:
                    c += 1
                yield r, s, c - s
            else:
                c += 1


def build_spec() -> dict:
    return {
        "version": VERSION,
        "page": {"w": PAGE_W, "h": PAGE_H},
        "dictionary": DICT,
        "markerSize": MARKER,
        "markers": [
            {"id": mid, "x": x, "y": y, "corners": marker_corners(x, y), "bits": marker_bits(mid)}
            for mid, x, y in MARKERS
        ],
        "zones": ZONES,
        "ruler": RULER,
    }


# --------------------------------------------------------------------------- PDF
def write_pdf(spec: dict, path: Path) -> None:
    from reportlab.lib.colors import Color, black, white
    from reportlab.lib.units import mm
    from reportlab.pdfgen import canvas

    c = canvas.Canvas(str(path), pagesize=(PAGE_W * mm, PAGE_H * mm))
    c.setTitle("OptiFrame - tapis de mesure A4 (imprimer a 100 %)")

    def Y(y):  # top-left mm -> PDF points (origin bottom-left)
        return (PAGE_H - y) * mm

    cell = MARKER / 6
    c.setFillColor(black)
    for m in spec["markers"]:
        for r, s, n in black_runs(m["bits"]):
            c.rect((m["x"] + s * cell) * mm, Y(m["y"] + (r + 1) * cell), n * cell * mm, cell * mm, stroke=0, fill=1)

    grey = Color(0.55, 0.55, 0.55)
    # zone corner ticks (outside the zone so nothing is printed under the lens)
    c.setStrokeColor(grey)
    c.setLineWidth(0.5)
    for name, z in spec["zones"].items():
        x0, y0, x1, y1 = z["x"], z["y"], z["x"] + z["w"], z["y"] + z["h"]
        L, g = 6.0, 2.0
        for cx, cy, sx, sy in ((x0, y0, 1, 1), (x1, y0, -1, 1), (x1, y1, -1, -1), (x0, y1, 1, -1)):
            c.line((cx - sx * g) * mm, Y(cy - sy * g), (cx - sx * g + sx * L) * mm, Y(cy - sy * g))
            c.line((cx - sx * g) * mm, Y(cy - sy * g), (cx - sx * g) * mm, Y(cy - sy * g + sy * L))
        label = "VERRE DROIT  (OD)" if name == "OD" else "VERRE GAUCHE  (OS)"
        nasal = "nez  →" if z["nasal"] == "right" else "←  nez"
        c.setFillColor(black)
        c.setFont("Helvetica-Bold", 11)
        c.drawCentredString((x0 + z["w"] / 2) * mm, Y(22), label)
        c.setFont("Helvetica", 7.5)
        c.drawCentredString((x0 + z["w"] / 2) * mm, Y(28.5), f"face bombée vers le haut  ·  haut du verre ↑  ·  {nasal}")

    # 100 mm check ruler in the centre column
    rx, ry0, ry1 = RULER["x"], RULER["y0"], RULER["y1"]
    c.setStrokeColor(black)
    c.setLineWidth(0.35)
    c.line(rx * mm, Y(ry0), rx * mm, Y(ry1))
    c.setFont("Helvetica", 5.5)
    for i in range(0, 101):
        y = ry0 + i
        L = 4.0 if i % 10 == 0 else (2.6 if i % 5 == 0 else 1.6)
        c.setLineWidth(0.3 if i % 10 else 0.4)
        c.line(rx * mm, Y(y), (rx + L) * mm, Y(y))
        if i % 10 == 0:
            c.drawString((rx + 5) * mm, Y(y + 0.9), str(i))
    c.saveState()
    c.translate((rx - 3) * mm, Y((ry0 + ry1) / 2))
    c.rotate(90)
    c.setFont("Helvetica", 6.5)
    c.drawCentredString(0, 0, "CONTRÔLE : cette règle doit mesurer 100 mm")
    c.restoreState()

    # footer
    c.setFillColor(black)
    c.setFont("Helvetica-Bold", 9)
    c.drawString(42 * mm, Y(184), "OptiFrame — tapis de mesure")
    c.setFont("Helvetica", 7)
    c.drawString(42 * mm, Y(189), "Imprimer à 100 % (taille réelle, sans mise à l'échelle). Poser à plat.")
    c.drawString(42 * mm, Y(193.5), "Astuce : poser la feuille sur l'écran blanc d'un portable = boîte lumineuse.")
    c.drawString(167 * mm, Y(184), "Photo : téléphone à plat, ~25 cm au-dessus du verre.")
    c.drawString(167 * mm, Y(188.5), "Les 8 carrés noirs doivent rester visibles (au moins 3).")
    c.setFont("Helvetica", 5.5)
    c.setFillColor(grey)
    c.drawString(167 * mm, Y(193.5), f"{VERSION} · ArUco {DICT} · marqueurs {MARKER:g} mm")
    c.showPage()
    c.save()


# --------------------------------------------------------------------------- SVG
def write_svg(spec: dict, path: Path) -> None:
    cell = MARKER / 6
    out = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{PAGE_W}mm" height="{PAGE_H}mm" '
        f'viewBox="0 0 {PAGE_W} {PAGE_H}">',
        f'<rect width="{PAGE_W}" height="{PAGE_H}" fill="#fff"/>',
    ]
    for m in spec["markers"]:
        for r, s, n in black_runs(m["bits"]):
            out.append(
                f'<rect x="{m["x"] + s * cell:.3f}" y="{m["y"] + r * cell:.3f}" width="{n * cell:.3f}" '
                f'height="{cell:.3f}" fill="#000"/>'
            )
    for name, z in spec["zones"].items():
        x0, y0, x1, y1 = z["x"], z["y"], z["x"] + z["w"], z["y"] + z["h"]
        L, g = 6.0, 2.0
        for cx, cy, sx, sy in ((x0, y0, 1, 1), (x1, y0, -1, 1), (x1, y1, -1, -1), (x0, y1, 1, -1)):
            px, py = cx - sx * g, cy - sy * g
            out.append(
                f'<path d="M{px + sx * L},{py} L{px},{py} L{px},{py + sy * L}" stroke="#8c8c8c" '
                f'stroke-width="0.18" fill="none"/>'
            )
        label = "VERRE DROIT (OD)" if name == "OD" else "VERRE GAUCHE (OS)"
        out.append(
            f'<text x="{x0 + z["w"] / 2}" y="23" font-family="Helvetica,Arial" font-size="3.9" '
            f'font-weight="bold" text-anchor="middle">{label}</text>'
        )
    rx, ry0, ry1 = RULER["x"], RULER["y0"], RULER["y1"]
    out.append(f'<line x1="{rx}" y1="{ry0}" x2="{rx}" y2="{ry1}" stroke="#000" stroke-width="0.12"/>')
    for i in range(0, 101):
        L = 4.0 if i % 10 == 0 else (2.6 if i % 5 == 0 else 1.6)
        out.append(f'<line x1="{rx}" y1="{ry0 + i}" x2="{rx + L}" y2="{ry0 + i}" stroke="#000" stroke-width="0.1"/>')
    out.append("</svg>")
    path.write_text("\n".join(out))


# --------------------------------------------------------------------------- raster
def render_raster(spec: dict, ppm: float, ss: int = 4) -> np.ndarray:
    """Render the mat as a grayscale uint8 image at `ppm` pixels per mm.

    Supersampled `ss` times for anti-aliasing. Text is approximated with
    small grey blocks (only used as distractors for synthetic data).
    """
    s = ppm * ss
    W, H = int(round(PAGE_W * s)), int(round(PAGE_H * s))
    img = np.full((H, W), 255, np.uint8)
    cell = MARKER / 6

    def R(x0, y0, x1, y1, v):
        cv2.rectangle(img, (int(round(x0 * s)), int(round(y0 * s))), (int(round(x1 * s)) - 1, int(round(y1 * s)) - 1), v, -1)

    for m in spec["markers"]:
        for r, c0, n in black_runs(m["bits"]):
            R(m["x"] + c0 * cell, m["y"] + r * cell, m["x"] + (c0 + n) * cell, m["y"] + (r + 1) * cell, 0)
    lw = max(1, int(round(0.18 * s)))
    for z in spec["zones"].values():
        x0, y0, x1, y1 = z["x"], z["y"], z["x"] + z["w"], z["y"] + z["h"]
        L, g = 6.0, 2.0
        for cx, cy, sx, sy in ((x0, y0, 1, 1), (x1, y0, -1, 1), (x1, y1, -1, -1), (x0, y1, 1, -1)):
            px, py = cx - sx * g, cy - sy * g
            p = (int(px * s), int(py * s))
            cv2.line(img, p, (int((px + sx * L) * s), int(py * s)), 140, lw)
            cv2.line(img, p, (int(px * s), int((py + sy * L) * s)), 140, lw)
        # label blocks standing in for text
        cx = (x0 + x1) / 2
        R(cx - 22, 19, cx + 22, 23, 40)
        R(cx - 38, 26.5, cx + 38, 28.5, 110)
    rx, ry0, ry1 = RULER["x"], RULER["y0"], RULER["y1"]
    cv2.line(img, (int(rx * s), int(ry0 * s)), (int(rx * s), int(ry1 * s)), 0, lw)
    for i in range(0, 101):
        L = 4.0 if i % 10 == 0 else (2.6 if i % 5 == 0 else 1.6)
        y = int((ry0 + i) * s)
        cv2.line(img, (int(rx * s), y), (int((rx + L) * s), y), 0, max(1, int(0.1 * s)))
    # footer text blocks
    for x, y, w in ((42, 182, 50), (42, 187.5, 80), (42, 192, 85), (167, 182, 70), (167, 186.5, 72), (167, 192, 60)):
        R(x, y, x + w, y + 2, 120)
    return cv2.resize(img, (int(round(PAGE_W * ppm)), int(round(PAGE_H * ppm))), interpolation=cv2.INTER_AREA)


def main() -> None:
    spec = build_spec()
    (ROOT / "shared").mkdir(exist_ok=True)
    (ROOT / "shared" / "mat.json").write_text(json.dumps(spec, indent=1))
    out = ROOT / "public" / "mat"
    out.mkdir(parents=True, exist_ok=True)
    write_pdf(spec, out / "optiframe-mat-A4.pdf")
    write_svg(spec, out / "optiframe-mat-A4.svg")
    assets = ROOT / "ml" / "assets"
    assets.mkdir(parents=True, exist_ok=True)
    for ppm in (3, 12):
        cv2.imwrite(str(assets / f"mat_{ppm}ppm.png"), render_raster(spec, ppm))
    print("mat written:", out)


if __name__ == "__main__":
    main()
