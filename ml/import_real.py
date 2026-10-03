"""Convert the app's paired-capture export into image / mask pairs.

    python import_real.py optiframe-collecte.json real/

Each sample is the rectified zone at 3 px/mm (pixel u covers mm
[x0 + u/ppm, x0 + (u+1)/ppm]) and the reference outline in mat mm.
Samples whose own outline is far from the reference (lens moved) are skipped.
Writes real/<id>.png and real/<id>_mask.png (8-bit soft mask).
"""
from __future__ import annotations

import base64
import json
import sys
from pathlib import Path

import cv2
import numpy as np


def soft_mask(poly_px: np.ndarray, h: int, w: int, ss: int = 4) -> np.ndarray:
    big = np.zeros((h * ss, w * ss), np.uint8)
    pts = np.round(((poly_px + 0.5) * ss - 0.5) * 16).astype(np.int32)
    cv2.fillPoly(big, [pts], 255, cv2.LINE_AA, 4)
    return cv2.resize(big, (w, h), interpolation=cv2.INTER_AREA)


def main(src: str, dst: str) -> None:
    data = json.loads(Path(src).read_text())
    out = Path(dst)
    out.mkdir(parents=True, exist_ok=True)
    kept = skipped = 0
    for s in data["samples"]:
        if s["role"] == "hard" and s["meanDev"] is not None and s["meanDev"] > 1.5:
            skipped += 1
            continue
        png = base64.b64decode(s["image"].split(",", 1)[1])
        img = cv2.imdecode(np.frombuffer(png, np.uint8), cv2.IMREAD_COLOR)
        h, w = img.shape[:2]
        poly = (np.asarray(s["label"]) - [s["x0"], s["y0"]]) * s["ppm"] - 0.5
        cv2.imwrite(str(out / f"{s['id']}.png"), img)
        cv2.imwrite(str(out / f"{s['id']}_mask.png"), soft_mask(poly, h, w))
        kept += 1
    print(f"{kept} pairs written to {out} ({skipped} skipped: lens moved)")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
