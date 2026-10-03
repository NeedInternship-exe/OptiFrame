"""Generate fake *phone photos* of the mat with lenses, with exact ground truth.

Used by the end-to-end benchmark (bench/run.ts): the web-app pipeline is run
on these JPEGs and the measured A / B are compared to the true outlines.

    python make_photos.py --n 24 --out ../bench/photos

A random camera (focal ~26 mm equivalent, height 20-35 cm, tilt 0-28 deg,
any roll) looks at the whole mat or at one zone. The table around the sheet,
vignetting, defocus, noise and JPEG compression are simulated.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import cv2
import numpy as np

from dataset import SPEC, mat_raster
from lenssynth import camera_effects, paper_background, random_lens_shape, render_lenses

PPM = 14.0  # rendering resolution of the flat mat (px/mm)


def rot(ax, ay, az):
    cx, sx, cy, sy, cz, sz = np.cos(ax), np.sin(ax), np.cos(ay), np.sin(ay), np.cos(az), np.sin(az)
    Rx = np.array([[1, 0, 0], [0, cx, -sx], [0, sx, cx]])
    Ry = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]])
    Rz = np.array([[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]])
    return Rz @ Ry @ Rx


def camera_homography(rng, W, H, target_mm, span_xy):
    """H maps mat mm (X, Y, 1) -> image px. Camera looks at target point.

    span_xy: (width, height) in mm of the mat region that must stay in frame.
    The phone is rotated so that the region's long side follows the image's.
    """
    f = 26 / 43.27 * np.hypot(W, H)
    K = np.array([[f, 0, W / 2 - 0.5], [0, f, H / 2 - 0.5], [0, 0, 1]])
    tilt = np.deg2rad(rng.uniform(0, 28))
    az = rng.uniform(0, 2 * np.pi)
    region_landscape = span_xy[0] >= span_xy[1]
    image_landscape = W >= H
    base_roll = [0, np.pi] if region_landscape == image_landscape else [np.pi / 2, -np.pi / 2]
    roll = rng.choice(base_roll) + np.deg2rad(rng.normal(0, 5))
    # camera z axis points from camera to the mat (mat normal is -z in camera frame when fronto-parallel)
    R = rot(np.cos(az) * tilt, np.sin(az) * tilt, roll)
    # distance so that the region fits in the frame (with some slack for tilt)
    lo, sh = max(span_xy), min(span_xy)
    dist = f * max(lo / (0.9 * max(W, H)), sh / (0.9 * min(W, H))) * rng.uniform(1.02, 1.2) * (1 + 0.6 * np.sin(tilt))
    # world->camera: Xc = R (Xw - C). Mat plane z=0, camera above at -z? use z toward the mat.
    target = np.array([target_mm[0], target_mm[1], 0.0])
    view_dir = R.T @ np.array([0, 0, 1.0])  # camera optical axis in world coordinates
    if view_dir[2] < 0:
        R = rot(0, np.pi, 0) @ R
        view_dir = R.T @ np.array([0, 0, 1.0])
    C = target - view_dir * dist
    t = -R @ C
    Hm = K @ np.c_[R[:, 0], R[:, 1], t]
    return Hm / Hm[2, 2], dict(f=f, tilt_deg=float(np.rad2deg(tilt)), height_mm=float(-C[2]) if C[2] < 0 else float(C[2]))


def table_texture(rng, W, H):
    base = np.array(rng.choice([[0.55, 0.42, 0.3], [0.35, 0.36, 0.38], [0.75, 0.74, 0.72], [0.2, 0.2, 0.22]]), np.float32)
    n = cv2.resize(rng.normal(0, 1, (H // 40 + 2, W // 8 + 2)).astype(np.float32), (W, H), interpolation=cv2.INTER_CUBIC)
    return np.clip(base[None, None, :] * (1 + 0.08 * n[..., None]), 0, 1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=24)
    ap.add_argument("--out", default="../bench/photos")
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--res", default="4032x3024", help="photo size, e.g. 1920x1440 for a browser video frame")
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    mat = mat_raster(PPM)
    Hm_, Wm_ = mat.shape
    gt_all = []
    for k in range(args.n):
        rng = np.random.default_rng(args.seed * 1000 + k)
        backlit = rng.random() < 0.4
        bg = paper_background(rng, mat, backlit)
        lenses, polys_px = [], []
        mode = rng.choice(["pair", "OD", "OS"], p=[0.5, 0.25, 0.25])
        zones = ["OD", "OS"] if mode == "pair" else [mode]
        for z in zones:
            zs = SPEC["zones"][z]
            shape = random_lens_shape(rng)
            a = np.deg2rad(rng.uniform(-6, 6))
            Rm = np.array([[np.cos(a), -np.sin(a)], [np.sin(a), np.cos(a)]])
            shape = shape @ Rm.T
            half = (shape.max(0) - shape.min(0)) / 2
            cx = rng.uniform(zs["x"] + half[0] + 6, zs["x"] + zs["w"] - half[0] - 6)
            cy = rng.uniform(zs["y"] + half[1] + 6, zs["y"] + zs["h"] - half[1] - 6)
            poly_mm = shape + [cx, cy]
            polys_px.append(poly_mm * PPM - 0.5)  # pixel centres at integer coords
            lenses.append({"zone": z, "poly": poly_mm.round(4).tolist()})
        flat, _ = render_lenses(bg, polys_px, PPM, rng, backlit)

        rw, rh = (int(v) for v in args.res.split("x"))
        W, H = (rw, rh) if rng.random() < 0.5 else (rh, rw)
        if mode == "pair":
            target, span = (SPEC["page"]["w"] / 2, SPEC["page"]["h"] / 2), (SPEC["page"]["w"] + 6, SPEC["page"]["h"] + 6)
        else:
            zs = SPEC["zones"][mode]
            target, span = (zs["x"] + zs["w"] / 2, zs["y"] + zs["h"] / 2), (zs["w"] + 70, zs["h"] + 66)
        Hc, cam = camera_homography(rng, W, H, target, span)
        # flat-raster px -> mm -> image px
        S = np.array([[1 / PPM, 0, 0.5 / PPM], [0, 1 / PPM, 0.5 / PPM], [0, 0, 1]])
        Hpx = Hc @ S
        # the table, then the sheet on top
        table = table_texture(rng, W, H)
        sheet = cv2.warpPerspective(flat, Hpx, (W, H), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=(0, 0, 0))
        cover = cv2.warpPerspective(np.ones((Hm_, Wm_), np.float32), Hpx, (W, H), flags=cv2.INTER_LINEAR)
        img = table * (1 - cover[..., None]) + sheet * cover[..., None]
        yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
        r2 = ((xx - W / 2) ** 2 + (yy - H / 2) ** 2) / (W * W / 4 + H * H / 4)
        img *= (1 - rng.uniform(0.05, 0.3) * r2)[..., None]
        img = camera_effects(rng, img, strength=1.6)
        name = f"photo_{k:03d}.jpg"
        cv2.imwrite(str(out / name), img[..., ::-1], [cv2.IMWRITE_JPEG_QUALITY, 92])
        gt_all.append({"file": name, "mode": mode, "backlit": bool(backlit), "camera": cam, "lenses": lenses})
        print(name, mode, "backlit" if backlit else "ambient", f"tilt {cam['tilt_deg']:.0f}")
    (out / "ground_truth.json").write_text(json.dumps(gt_all))


if __name__ == "__main__":
    main()
