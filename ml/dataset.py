"""Synthetic training samples in the *rectified* domain seen by the app.

The app warps each lens zone of the mat to a top view at 3 px/mm before
segmentation, so the model only ever sees: white paper, the printed corner
ticks / ruler / labels, and a lens. We render exactly that, at 2x and then
downsample (anti-aliased soft labels).

Each sample is fully determined by its integer seed (reproducible dataset).
"""
from __future__ import annotations

import json
from pathlib import Path

import cv2
import numpy as np

from gen_mat import render_raster
from lenssynth import camera_effects, paper_background, random_lens_shape, render_frame, render_lenses

ROOT = Path(__file__).resolve().parents[1]
SPEC = json.loads((ROOT / "shared" / "mat.json").read_text())

PPM = 3.0  # model resolution (px per mm) - must match src/vision/constants.ts
SS = 2  # supersampling factor for rendering

_MAT_CACHE: dict[float, np.ndarray] = {}


def mat_raster(ppm: float) -> np.ndarray:
    if ppm not in _MAT_CACHE:
        _MAT_CACHE[ppm] = render_raster(SPEC, ppm)
    return _MAT_CACHE[ppm]


def crop_mat(ppm: float, x0_mm: float, y0_mm: float, w_px: int, h_px: int) -> np.ndarray:
    mat = mat_raster(ppm)
    H, W = mat.shape
    x0, y0 = int(round(x0_mm * ppm)), int(round(y0_mm * ppm))
    out = np.full((h_px, w_px), 255, np.uint8)
    sx0, sy0 = max(0, x0), max(0, y0)
    sx1, sy1 = min(W, x0 + w_px), min(H, y0 + h_px)
    if sx1 > sx0 and sy1 > sy0:
        out[sy0 - y0 : sy1 - y0, sx0 - x0 : sx1 - x0] = mat[sy0:sy1, sx0:sx1]
    return out


def add_dust(rng, img, ppm):
    H, W = img.shape[:2]
    for _ in range(int(rng.poisson(4))):
        x, y = int(rng.uniform(0, W)), int(rng.uniform(0, H))
        v = rng.uniform(0.2, 0.7) if rng.random() < 0.7 else rng.uniform(1.0, 1.3)
        cv2.circle(img, (x, y), max(1, int(rng.uniform(0.1, 0.4) * ppm)), (v, v, v), -1, cv2.LINE_AA)
    if rng.random() < 0.08:  # hair / fibre
        pts = np.cumsum(rng.normal(0, 2 * ppm, (8, 2)), axis=0) + rng.uniform(0, [W, H])
        cv2.polylines(img, [pts.astype(np.int32)], False, (0.3, 0.3, 0.3), max(1, int(0.08 * ppm)), cv2.LINE_AA)
    return img


def make_sample(seed: int, size: int = 256, ppm: float = PPM):
    rng = np.random.default_rng(seed)
    R = ppm * SS
    S = size * SS
    span_mm = size / ppm
    zone = SPEC["zones"][rng.choice(["OD", "OS"])]
    cxm = rng.uniform(zone["x"] - 8, zone["x"] + zone["w"] + 8)
    cym = rng.uniform(zone["y"] - 8, zone["y"] + zone["h"] + 8)
    jitter = rng.uniform(0.94, 1.06)  # residual scale error
    src = int(round(S / jitter))
    crop = crop_mat(R, cxm - span_mm / 2, cym - span_mm / 2, src, src)
    crop = cv2.resize(crop, (S, S), interpolation=cv2.INTER_AREA if src > S else cv2.INTER_LINEAR)
    backlit = rng.random() < 0.35
    bg = paper_background(rng, crop, backlit)

    polys = []
    u = rng.random()
    n_lens = 0 if u < 0.06 else (2 if u < 0.14 else 1)
    for i in range(n_lens):
        shape = random_lens_shape(rng)
        if rng.random() < 0.5:
            shape[:, 0] *= -1
        a = np.deg2rad(rng.uniform(-25, 25))
        Rm = np.array([[np.cos(a), -np.sin(a)], [np.sin(a), np.cos(a)]])
        shape = shape @ Rm.T * jitter
        half = (shape.max(0) - shape.min(0)) / 2
        if i == 0 and rng.random() < 0.82:  # fully visible
            lo, hi = half + 1.5, span_mm - half - 1.5
            c = np.where(hi > lo, rng.uniform(lo, np.maximum(hi, lo + 1e-3)), span_mm / 2)
        else:  # partially out of the crop
            c = rng.uniform(-half * 0.6, span_mm + half * 0.6)
        polys.append((shape + c) * R)
    img, label = render_lenses(bg, polys, R, rng, backlit)
    # mounted glasses (35 %): the label is the visible opening inside the rim
    if polys and rng.random() < 0.35:
        img = render_frame(img, polys, R, rng)
    img = add_dust(rng, img, R)
    img = cv2.resize(img, (size, size), interpolation=cv2.INTER_AREA)
    label = cv2.resize(label, (size, size), interpolation=cv2.INTER_AREA)
    img = camera_effects(rng, img)
    return img, label.astype(np.float32)


if __name__ == "__main__":
    import sys
    import time

    n = int(sys.argv[1]) if len(sys.argv) > 1 else 16
    t = time.time()
    tiles = []
    for s in range(n):
        im, lb = make_sample(1_000_000 + s)
        over = im.copy()
        cnts, _ = cv2.findContours((lb > 0.5).astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
        cv2.drawContours(over, cnts, -1, (255, 0, 0), 1)
        tiles.append(np.hstack([im, over]))
    print(f"{(time.time() - t) / n * 1000:.1f} ms/sample")
    rows = [np.hstack(tiles[i : i + 4]) for i in range(0, n, 4)]
    out = ROOT / "ml" / "assets" / "synthetic_preview.jpg"
    cv2.imwrite(str(out), np.vstack(rows)[..., ::-1])
    print(out)
