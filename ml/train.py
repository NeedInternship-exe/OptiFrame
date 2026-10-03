"""Train the OptiFrame lens segmentation model (tiny U-Net) on synthetic data.

    python train.py --steps 14000 --out runs/v1
    # fine-tune with real photos collected in the app (paired capture):
    python train.py --steps 3000 --lr 5e-4 --resume runs/v1/best.pt --real real/ --out runs/v1-real

Input : RGB float32 in [0, 1], NCHW, rectified top view at 3 px/mm, any H, W
        multiple of 32 (fully convolutional).
Output: 1-channel logits (lens / background), same H, W.
"""
from __future__ import annotations

import argparse
import json
import math
import time
from pathlib import Path

import cv2
import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.utils.data import DataLoader, Dataset

from dataset import make_sample
from lenssynth import camera_effects

PPM = 3.0


# ----------------------------------------------------------------------------- model
def cbr(cin, cout, stride=1):
    return nn.Sequential(nn.Conv2d(cin, cout, 3, stride, 1, bias=False), nn.BatchNorm2d(cout), nn.ReLU(inplace=True))


class LensUNet(nn.Module):
    """Small U-Net, plain 3x3 convs (fast on GPU and in ONNX Runtime Web).

    ~0.5 M parameters, ~2 GMAC for a 416x288 zone (3 px/mm).
    """

    def __init__(self, ch=(12, 24, 32, 48, 64, 96)):
        super().__init__()
        self.stem = nn.Sequential(cbr(3, ch[0]), cbr(ch[0], ch[0]))
        self.encs = nn.ModuleList(nn.Sequential(cbr(ch[i - 1], ch[i], 2), cbr(ch[i], ch[i])) for i in range(1, len(ch)))
        self.decs = nn.ModuleList(
            nn.Sequential(cbr(ch[i] + ch[i - 1], ch[i - 1]), *([cbr(ch[i - 1], ch[i - 1])] if i > 1 else []))
            for i in range(len(ch) - 1, 0, -1)
        )
        self.head = nn.Conv2d(ch[0], 1, 1)
        self.register_buffer("mean", torch.tensor([0.5, 0.5, 0.5]).view(1, 3, 1, 1))
        self.register_buffer("std", torch.tensor([0.25, 0.25, 0.25]).view(1, 3, 1, 1))

    def forward(self, x):
        x = (x - self.mean) / self.std
        skips = [self.stem(x)]
        y = skips[0]
        for enc in self.encs:
            y = enc(y)
            skips.append(y)
        y = skips.pop()
        for dec in self.decs:
            s = skips.pop()
            y = F.interpolate(y, scale_factor=2.0, mode="bilinear", align_corners=False)
            y = dec(torch.cat([y, s], 1))
        return self.head(y)


# ----------------------------------------------------------------------------- data
def worker_init(_):
    cv2.setNumThreads(1)


class RealLenses:
    """Real rectified photos labelled by paired capture (see import_real.py)."""

    def __init__(self, folder):
        self.items = sorted(p for p in Path(folder).glob("*.png") if not p.name.endswith("_mask.png"))
        if not self.items:
            raise SystemExit(f"no real samples in {folder}")

    def sample(self, rng, size):
        p = self.items[rng.integers(len(self.items))]
        img = cv2.imread(str(p))[..., ::-1]
        lab = cv2.imread(str(p.with_name(p.stem + "_mask.png")), cv2.IMREAD_GRAYSCALE).astype(np.float32) / 255
        h, w = lab.shape
        if h < size or w < size:  # pad by replication (the network was trained on that border too)
            ph, pw = max(0, size - h), max(0, size - w)
            img = cv2.copyMakeBorder(np.ascontiguousarray(img), 0, ph, 0, pw, cv2.BORDER_REPLICATE)
            lab = cv2.copyMakeBorder(lab, 0, ph, 0, pw, cv2.BORDER_REPLICATE)
            h, w = lab.shape
        y0, x0 = rng.integers(0, h - size + 1), rng.integers(0, w - size + 1)
        img, lab = img[y0 : y0 + size, x0 : x0 + size], lab[y0 : y0 + size, x0 : x0 + size]
        if rng.random() < 0.5:
            img, lab = img[:, ::-1], lab[:, ::-1]
        img = camera_effects(rng, np.ascontiguousarray(img).astype(np.float32) / 255, strength=0.5)
        return img, np.ascontiguousarray(lab)


class SynthLenses(Dataset):
    def __init__(self, n, base_seed, size=256, real=None, real_frac=0.0):
        self.n, self.base, self.size = n, base_seed, size
        self.real, self.real_frac = real, real_frac

    def __len__(self):
        return self.n

    def __getitem__(self, i):
        rng = np.random.default_rng(700_000_000 + self.base + i)
        if self.real is not None and rng.random() < self.real_frac:
            img, lab = self.real.sample(rng, self.size)
        else:
            img, lab = make_sample(self.base + i, self.size)
        x = torch.from_numpy(np.ascontiguousarray(img)).permute(2, 0, 1).float() / 255.0
        y = torch.from_numpy(lab)[None]
        return x, y


def boundary_weight(y):
    # emphasise pixels within ~1.5 mm of the true outline
    edge = ((y > 0.02) & (y < 0.98)).float()
    edge = F.max_pool2d(edge, 9, 1, 4)
    return 1 + 4 * edge


def loss_fn(logits, y):
    w = boundary_weight(y)
    bce = (F.binary_cross_entropy_with_logits(logits, y, reduction="none") * w).mean()
    p = torch.sigmoid(logits)
    inter = (p * y).sum((1, 2, 3))
    dice = 1 - (2 * inter + 1) / (p.sum((1, 2, 3)) + y.sum((1, 2, 3)) + 1)
    return bce + 0.5 * dice.mean()


# ----------------------------------------------------------------------------- metrics
def box_of(mask):
    ys, xs = np.nonzero(mask)
    if len(xs) == 0:
        return None
    return xs.min(), xs.max(), ys.min(), ys.max()


@torch.no_grad()
def evaluate(model, loader, device):
    model.eval()
    ious, dA, dB, empty_ok = [], [], [], []
    for x, y in loader:
        p = torch.sigmoid(model(x.to(device))).cpu().numpy()[:, 0]
        y = y.numpy()[:, 0]
        for pi, yi in zip(p, y):
            pm, ym = pi > 0.5, yi > 0.5
            if ym.sum() == 0:
                empty_ok.append(pm.sum() < 50)
                continue
            ious.append((pm & ym).sum() / max(1, (pm | ym).sum()))
            # A/B only for lenses fully inside the crop
            if ym[0].any() or ym[-1].any() or ym[:, 0].any() or ym[:, -1].any():
                continue
            n, lab, stats, _ = cv2.connectedComponentsWithStats(pm.astype(np.uint8))
            if n < 2:
                dA.append(99), dB.append(99)
                continue
            k = 1 + np.argmax(stats[1:, cv2.CC_STAT_AREA])
            bp, bg = box_of(lab == k), box_of(ym)
            # sub-pixel widths from the soft maps along the box
            dA.append(abs((bp[1] - bp[0]) - (bg[1] - bg[0])) / PPM)
            dB.append(abs((bp[3] - bp[2]) - (bg[3] - bg[2])) / PPM)
    model.train()
    return {
        "iou": float(np.mean(ious)),
        "A_mae_mm": float(np.mean(dA)),
        "B_mae_mm": float(np.mean(dB)),
        "A_p90_mm": float(np.percentile(dA, 90)),
        "empty_ok": float(np.mean(empty_ok)) if empty_ok else None,
    }


# ----------------------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--steps", type=int, default=14000)
    ap.add_argument("--bs", type=int, default=16)
    ap.add_argument("--lr", type=float, default=2e-3)
    ap.add_argument("--workers", type=int, default=9)
    ap.add_argument("--out", default="runs/v1")
    ap.add_argument("--resume", default="")
    ap.add_argument("--real", default="", help="folder from import_real.py (fine-tuning on real photos)")
    ap.add_argument("--real-frac", type=float, default=0.3)
    args = ap.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    device = torch.device("mps" if torch.backends.mps.is_available() else "cpu")
    torch.manual_seed(0)
    model = LensUNet().to(device)
    if args.resume:
        model.load_state_dict(torch.load(args.resume, map_location=device))
    nparams = sum(p.numel() for p in model.parameters())
    print(f"params: {nparams / 1e3:.0f} k  device: {device}", flush=True)

    real = RealLenses(args.real) if args.real else None
    if real:
        print(f"real samples: {len(real.items)} (fraction {args.real_frac})", flush=True)
    train = SynthLenses(args.steps * args.bs, base_seed=0, real=real, real_frac=args.real_frac)
    val = SynthLenses(512, base_seed=10_000_000)
    tl = DataLoader(train, args.bs, shuffle=False, num_workers=args.workers, persistent_workers=True, prefetch_factor=4, worker_init_fn=worker_init)
    vl = DataLoader(val, 32, num_workers=args.workers, worker_init_fn=worker_init)
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, args.lr, total_steps=args.steps, pct_start=0.05)

    log = []
    t0 = time.time()
    run = 0.0
    best = math.inf
    for step, (x, y) in enumerate(tl, 1):
        x, y = x.to(device, non_blocking=True), y.to(device, non_blocking=True)
        loss = loss_fn(model(x), y)
        opt.zero_grad(set_to_none=True)
        loss.backward()
        opt.step()
        sched.step()
        run = 0.98 * run + 0.02 * loss.item() if step > 1 else loss.item()
        if step % 100 == 0:
            print(f"step {step:6d}  loss {run:.4f}  lr {sched.get_last_lr()[0]:.2e}  {time.time() - t0:.0f}s", flush=True)
        if step % 2000 == 0 or step == args.steps:
            m = evaluate(model, vl, device)
            m.update(step=step, loss=run, time_s=round(time.time() - t0))
            log.append(m)
            print("  val", json.dumps(m), flush=True)
            (out / "log.json").write_text(json.dumps(log, indent=1))
            torch.save(model.state_dict(), out / "last.pt")
            score = m["A_mae_mm"] + m["B_mae_mm"]
            if score < best:
                best = score
                torch.save(model.state_dict(), out / "best.pt")
        if step >= args.steps:
            break
    print("done", flush=True)


if __name__ == "__main__":
    main()
