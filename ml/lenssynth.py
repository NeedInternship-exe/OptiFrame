"""Procedural renderer of spectacle lenses lying on the OptiFrame mat.

Shared by the training-data generator (rectified top view, 3 px/mm) and by the
test-photo generator (full mat, then warped into a fake phone photo).

What we simulate (each effect is randomised):
  * lens outlines: superellipse / Fourier / aviator / cat-eye / round / hexagonal
  * paper colour, illumination gradients, vignetting, light-box (backlit) mode
  * refraction (minifying or magnifying the paper and the printed marks)
  * transmission and tint (clear, AR-coated, sun lenses)
  * the edge (bevel) seen from above: dark band of variable width and contrast,
    with glints and segments where the edge almost disappears
  * confounders: "myopic ring" inside the lens, offset edge shadow outside,
    phone/hand shadow, specular highlights, window and phone reflections,
    AR-coating colour casts, ink marks, drill holes, dust
  * camera: blur, noise, JPEG, gamma, white balance

Coordinates: pixels, x right, y down. Shapes are generated in millimetres.
"""
from __future__ import annotations

import cv2
import numpy as np

TAU = 2 * np.pi


# ----------------------------------------------------------------------------- shapes
def _resample_closed(pts: np.ndarray, n: int) -> np.ndarray:
    d = np.r_[0, np.cumsum(np.linalg.norm(np.diff(np.vstack([pts, pts[:1]]), axis=0), axis=1))]
    t = np.linspace(0, d[-1], n, endpoint=False)
    closed = np.vstack([pts, pts[:1]])
    return np.c_[np.interp(t, d, closed[:, 0]), np.interp(t, d, closed[:, 1])]


def _fourier_smooth(pts: np.ndarray, k: int) -> np.ndarray:
    z = pts[:, 0] + 1j * pts[:, 1]
    f = np.fft.fft(z)
    f[k + 1 : len(f) - k] = 0
    z = np.fft.ifft(f)
    return np.c_[z.real, z.imag]


def random_lens_shape(rng: np.random.Generator, n: int = 720, family: str | None = None) -> np.ndarray:
    """Closed polygon (n, 2) in mm, boxing centre at the origin, y down.

    The boxing rectangle is exactly A x B (returned shapes are rescaled).
    """
    fams = ["superellipse", "fourier", "aviator", "round", "hex", "cateye", "panto"]
    probs = [0.24, 0.22, 0.12, 0.08, 0.08, 0.12, 0.14]
    family = family or rng.choice(fams, p=probs)
    A = rng.uniform(33.0, 64.0)
    ratio = rng.uniform(0.82, 1.0) if family == "round" else rng.uniform(0.48, 0.92)
    B = A * ratio
    th = np.linspace(0, TAU, n, endpoint=False)
    a, b = A / 2, B / 2

    if family == "hex":
        k = rng.choice([6, 6, 8])
        ang = np.linspace(0, TAU, k, endpoint=False) + rng.uniform(-0.2, 0.2) + (np.pi / k if rng.random() < 0.5 else 0)
        poly = np.c_[np.cos(ang) * a, np.sin(ang) * b]
        pts = _fourier_smooth(_resample_closed(poly, n), int(rng.integers(10, 22)))
    else:
        p = {"superellipse": rng.uniform(2.0, 5.5), "round": rng.uniform(2.0, 2.6), "panto": rng.uniform(2.2, 3.5)}.get(
            family, rng.uniform(2.0, 4.5)
        )
        c, s = np.abs(np.cos(th)), np.abs(np.sin(th))
        r = (np.power(c / a, p) + np.power(s / b, p)) ** (-1 / p)
        amp = {"fourier": 0.06}.get(family, 0.025)
        for kk in range(1, 7):
            r *= 1 + rng.normal(0, amp / kk) * np.cos(kk * th + rng.uniform(0, TAU))
        side = 1 if rng.random() < 0.5 else -1  # which side is temporal (x>0 or x<0)

        def bump(theta0, width, alpha):
            dth = np.angle(np.exp(1j * (th - theta0)))
            return 1 + alpha * np.exp(-0.5 * (dth / width) ** 2)

        if family == "aviator":  # big lower-nasal drop
            r *= bump(np.pi / 2 + side * 0.5, rng.uniform(0.4, 0.8), rng.uniform(0.12, 0.3))
        elif family == "cateye":  # raised upper-temporal corner
            t0 = -np.pi / 2 + side * rng.uniform(0.5, 0.9)
            r *= bump(t0, rng.uniform(0.25, 0.45), rng.uniform(0.1, 0.25))
        elif family == "panto":  # flatter top, round bottom
            top = np.clip(-np.sin(th), 0, None)
            r *= 1 - rng.uniform(0.05, 0.15) * top**3
        pts = np.c_[r * np.cos(th), r * np.sin(th)]
        pts = _fourier_smooth(pts, int(rng.integers(16, 40)))

    # exact boxing A x B
    mn, mx = pts.min(0), pts.max(0)
    pts = (pts - (mn + mx) / 2) / (mx - mn) * np.array([A, B])
    return _resample_closed(pts, n)


# ----------------------------------------------------------------------------- helpers
def smooth_field(rng, shape, cells=4, amp=0.2):
    h, w = shape
    g = rng.normal(0, 1, (cells, cells)).astype(np.float32)
    f = cv2.resize(g, (w, h), interpolation=cv2.INTER_CUBIC)
    f = f / (np.abs(f).max() + 1e-6)
    return 1 + amp * f


def soft_ellipse(shape, cx, cy, rx, ry, ang, blur):
    m = np.zeros(shape, np.float32)
    cv2.ellipse(m, (int(cx * 16), int(cy * 16)), (max(1, int(rx * 16)), max(1, int(ry * 16))), ang, 0, 360, 1.0, -1, cv2.LINE_AA, 4)
    if blur > 0.3:
        m = cv2.GaussianBlur(m, (0, 0), blur)
    return m


def poly_mask(shape, poly_px, aa=True):
    m = np.zeros(shape, np.float32)
    cv2.fillPoly(m, [np.round(poly_px * 16).astype(np.int32)], 1.0, cv2.LINE_AA if aa else cv2.LINE_8, 4)
    return m


def signed_distance(mask_bin: np.ndarray) -> np.ndarray:
    """Positive inside, negative outside, in pixels."""
    inside = cv2.distanceTransform(mask_bin, cv2.DIST_L2, 5)
    outside = cv2.distanceTransform(1 - mask_bin, cv2.DIST_L2, 5)
    return inside - outside


def angle_noise(rng, theta, amp, k_max=8):
    v = np.zeros_like(theta)
    for k in range(1, k_max + 1):
        v += rng.normal(0, 1 / k) * np.cos(k * theta + rng.uniform(0, TAU))
    v /= np.abs(v).max() + 1e-6
    return amp * v


# ----------------------------------------------------------------------------- scene
def render_lenses(
    bg: np.ndarray,
    polys_px: list[np.ndarray],
    ppm: float,
    rng: np.random.Generator,
    backlit: bool | None = None,
) -> tuple[np.ndarray, np.ndarray]:
    """Draw lenses on a float32 RGB background (values ~[0,1]).

    bg: (H, W, 3) background at `ppm` pixels per mm (already lit).
    Returns (image, label) where label is the soft lens coverage in [0, 1].
    """
    H, W = bg.shape[:2]
    img = bg.copy()
    label = np.zeros((H, W), np.float32)
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    if backlit is None:
        backlit = rng.random() < 0.35

    for poly in polys_px:
        mask_aa = poly_mask((H, W), poly)
        label = np.maximum(label, mask_aa)
        mbin = (mask_aa > 0.5).astype(np.uint8)
        if mbin.sum() < 20:
            continue
        sd = signed_distance(mbin) / ppm  # mm, + inside
        cx, cy = poly[:, 0].mean(), poly[:, 1].mean()
        theta = np.arctan2(yy - cy, xx - cx)

        # --- shadow of the lens / edge on the paper (outside + seen through the lens)
        if rng.random() < 0.4 and not backlit:
            dx, dy = rng.uniform(-3.5, 3.5, 2) * ppm
            M = np.float32([[1, 0, dx], [0, 1, dy]])
            sd_s = cv2.warpAffine(sd, M, (W, H), borderMode=cv2.BORDER_REPLICATE)
            ring_w = rng.uniform(0.3, 2.0)
            dark = rng.uniform(0.04, 0.18)
            shadow = np.clip(1 - np.abs(sd_s - ring_w / 2) / (ring_w / 2 + 0.2), 0, 1)
            if rng.random() < 0.4:  # filled shadow / caustic
                inside = np.clip(sd_s, 0, 1)
                shadow = np.maximum(shadow * 1.0, inside * rng.uniform(0.2, 0.6))
            shadow = cv2.GaussianBlur(shadow, (0, 0), rng.uniform(0.3, 2.0) * ppm)
            img *= (1 - dark * shadow)[..., None].astype(np.float32)

        # --- refraction: remap the background inside the lens
        m = rng.uniform(0.82, 1.18)
        wfield = rng.normal(0, 1, (2, 5, 5)).astype(np.float32)
        wx = cv2.resize(wfield[0], (W, H), interpolation=cv2.INTER_CUBIC) * rng.uniform(0, 1.2) * ppm
        wy = cv2.resize(wfield[1], (W, H), interpolation=cv2.INTER_CUBIC) * rng.uniform(0, 1.2) * ppm
        inside_w = np.clip(sd / 1.5, 0, 1)
        mapx = (cx + (xx - cx) / m + wx) * inside_w + xx * (1 - inside_w)
        mapy = (cy + (yy - cy) / m + wy) * inside_w + yy * (1 - inside_w)
        refr = cv2.remap(img, mapx.astype(np.float32), mapy.astype(np.float32), cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)

        # --- transmission / tint
        if rng.random() < 0.1:
            T = rng.uniform(0.15, 0.6)
            tint = np.array([[0.55, 0.55, 0.55], [0.75, 0.55, 0.35], [0.45, 0.65, 0.45], [0.45, 0.55, 0.8], [0.85, 0.55, 0.6]])[
                rng.integers(5)
            ] / 0.7
        else:
            T = rng.uniform(0.85, 0.995)
            tint = 1 + rng.normal(0, 0.025, 3)
        lens = refr * (T * tint)[None, None, :].astype(np.float32)

        # --- edge (bevel) band
        w = float(np.exp(rng.uniform(np.log(0.25), np.log(2.6))))
        if backlit:
            k = rng.uniform(0.05, 0.45)
        else:
            k = rng.uniform(0.35, 0.92)
        kv = np.clip(k + angle_noise(rng, theta, rng.uniform(0, 0.25)), 0.03, 1)
        if rng.random() < 0.3:  # segments where the edge nearly disappears
            t0, span = rng.uniform(0, TAU), rng.uniform(0.3, 1.6)
            dth = np.abs(np.angle(np.exp(1j * (theta - t0))))
            fade = np.clip((span / 2 - dth) / 0.2, 0, 1)
            kv = kv * (1 - fade) + rng.uniform(0.85, 0.98) * fade
        u = np.clip(sd / w, 0, 1)  # 0 at the outer edge, 1 at the inner side of the band
        style = rng.integers(3)
        if style == 0:
            band = (u < 1).astype(np.float32)
        elif style == 1:
            band = np.clip(1 - u, 0, 1) ** rng.uniform(0.5, 2)
        else:
            band = np.exp(-0.5 * ((u - rng.uniform(0.1, 0.6)) / 0.25) ** 2)
        band *= (sd > 0).astype(np.float32)
        band_soft = cv2.GaussianBlur(band, (0, 0), 0.35 * ppm / 3 + 0.3)
        lens *= (1 - (1 - kv) * band_soft)[..., None]
        if rng.random() < 0.5:  # bright line on the inner side of the bevel
            bl = np.exp(-0.5 * ((sd - w) / (0.12 + 0.05 * w)) ** 2) * rng.uniform(0.05, 0.35)
            lens += bl[..., None]
        if rng.random() < 0.5:  # glints on the edge
            for _ in range(int(rng.integers(1, 4))):
                t0, span = rng.uniform(0, TAU), rng.uniform(0.1, 0.6)
                dth = np.abs(np.angle(np.exp(1j * (theta - t0))))
                g = np.clip((span / 2 - dth) / 0.08, 0, 1) * (np.abs(sd - w * 0.4) < w * 0.6 + 0.1)
                lens += (g * rng.uniform(0.15, 0.6))[..., None]

        # --- "myopic ring": reflection of the edge seen inside thick lenses
        if rng.random() < 0.35:
            d0 = rng.uniform(1.0, 6.0)
            rw = rng.uniform(0.15, 0.8)
            ring = np.exp(-0.5 * ((sd - d0) / rw) ** 2)
            ring *= np.clip(1 + angle_noise(rng, theta, 0.6), 0, 1)
            sign = -1 if rng.random() < 0.7 else 1
            lens *= (1 + sign * rng.uniform(0.05, 0.35) * ring)[..., None]

        # --- reflections on the lens surface
        refl_add = np.zeros((H, W, 3), np.float32)
        refl_mul = np.ones((H, W), np.float32)
        bx0, by0 = poly.min(0)
        bx1, by1 = poly.max(0)
        for _ in range(int(rng.poisson(1.3))):
            kind = rng.choice(["blob", "window", "haze", "phone"], p=[0.45, 0.2, 0.2, 0.15])
            px, py = rng.uniform(bx0, bx1), rng.uniform(by0, by1)
            col = np.array([[1, 1, 1], [0.6, 1, 0.6], [0.9, 0.6, 1], [0.6, 0.8, 1], [1, 0.9, 0.6]])[
                rng.choice(5, p=[0.4, 0.2, 0.2, 0.1, 0.1])
            ].astype(np.float32)
            if kind == "blob":
                e = soft_ellipse((H, W), px, py, rng.uniform(1.5, 14) * ppm, rng.uniform(1, 8) * ppm, rng.uniform(0, 180), rng.uniform(0.3, 3) * ppm)
                refl_add += e[..., None] * col * rng.uniform(0.1, 0.7)
            elif kind == "window":
                ww, hh = rng.uniform(6, 25) * ppm, rng.uniform(5, 20) * ppm
                e = np.zeros((H, W), np.float32)
                cv2.rectangle(e, (int(px - ww / 2), int(py - hh / 2)), (int(px + ww / 2), int(py + hh / 2)), 1.0, -1)
                bar = max(1, int(rng.uniform(0.5, 2) * ppm))
                cv2.line(e, (int(px), int(py - hh / 2)), (int(px), int(py + hh / 2)), 0.0, bar)
                cv2.line(e, (int(px - ww / 2), int(py)), (int(px + ww / 2), int(py)), 0.0, bar)
                M = cv2.getRotationMatrix2D((float(px), float(py)), rng.uniform(-40, 40), 1)
                e = cv2.warpAffine(e, M, (W, H))
                e = cv2.GaussianBlur(e, (0, 0), rng.uniform(0.5, 2.5) * ppm)
                refl_add += e[..., None] * col * rng.uniform(0.1, 0.5)
            elif kind == "haze":
                e = soft_ellipse((H, W), px, py, rng.uniform(15, 40) * ppm, rng.uniform(10, 30) * ppm, rng.uniform(0, 180), 6 * ppm)
                refl_add += e[..., None] * col * rng.uniform(0.03, 0.15)
            else:  # dark phone silhouette with a tiny bright spot
                e = soft_ellipse((H, W), px, py, rng.uniform(6, 20) * ppm, rng.uniform(4, 14) * ppm, rng.uniform(0, 180), rng.uniform(1, 3) * ppm)
                refl_mul *= 1 - e * rng.uniform(0.1, 0.45)
                s = soft_ellipse((H, W), px, py, 0.6 * ppm, 0.6 * ppm, 0, 0.4 * ppm)
                refl_add += s[..., None] * rng.uniform(0.2, 0.8)
        # reflections live on the lens surface (may also wash out the edge band)
        surf = np.clip(sd / 0.15 + 0.5, 0, 1)
        lens = lens * (1 - (1 - refl_mul) * surf)[..., None] + refl_add * surf[..., None]

        # --- ink marks / drill holes / engravings
        if rng.random() < 0.25:
            ink = np.array([[0.1, 0.1, 0.1], [0.75, 0.1, 0.1], [0.1, 0.2, 0.75], [0.1, 0.55, 0.15]])[rng.integers(4)]
            ox, oy = cx + rng.normal(0, 4) * ppm, cy + rng.normal(0, 3) * ppm
            for j in (-1, 0, 1):
                cv2.circle(lens, (int(ox + j * 5 * ppm), int(oy)), max(1, int(rng.uniform(0.3, 0.8) * ppm)), ink.tolist(), -1, cv2.LINE_AA)
            if rng.random() < 0.5:
                cv2.line(lens, (int(ox - 12 * ppm), int(oy)), (int(ox + 12 * ppm), int(oy)), ink.tolist(), max(1, int(0.3 * ppm)), cv2.LINE_AA)
        if rng.random() < 0.06:
            for _ in range(int(rng.integers(1, 3))):
                i = rng.integers(len(poly))
                nvec = np.array([cx, cy]) - poly[i]
                nvec /= np.linalg.norm(nvec) + 1e-6
                hx, hy = poly[i] + nvec * rng.uniform(2.0, 4.0) * ppm
                rad = rng.uniform(0.6, 1.2) * ppm
                cv2.circle(lens, (int(hx), int(hy)), int(rad), (0.25, 0.25, 0.25), max(1, int(0.3 * ppm)), cv2.LINE_AA)

        alpha = mask_aa[..., None]
        img = img * (1 - alpha) + lens * alpha

    return img, label


def paper_background(rng, mat_gray: np.ndarray, backlit: bool) -> np.ndarray:
    """Turn a grayscale mat crop (uint8) into a lit RGB float image."""
    H, W = mat_gray.shape
    m = mat_gray.astype(np.float32) / 255.0
    ink = rng.uniform(0.04, 0.25)
    m = ink + (1 - ink) * m
    if backlit:
        base = rng.uniform(0.9, 1.15)
        illum = smooth_field(rng, (H, W), 3, rng.uniform(0, 0.06))
        m = cv2.GaussianBlur(m, (0, 0), rng.uniform(0.01, 0.6)) if rng.random() < 0.5 else m
    else:
        base = rng.uniform(0.6, 1.0)
        illum = smooth_field(rng, (H, W), int(rng.integers(2, 6)), rng.uniform(0.02, 0.3))
        gx, gy = rng.normal(0, 0.15, 2)
        yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
        illum *= 1 + gx * (xx / W - 0.5) + gy * (yy / H - 0.5)
    paper = (1 + rng.normal(0, 0.015, 3)).astype(np.float32)
    tex = 1 + rng.normal(0, rng.uniform(0.002, 0.015), (H, W)).astype(np.float32)
    tex = cv2.GaussianBlur(tex, (0, 0), 0.8)
    img = (m * illum * tex * base)[..., None] * paper[None, None, :]
    # big soft shadow from the phone / hand
    if not backlit and rng.random() < 0.35:
        e = soft_ellipse((H, W), rng.uniform(-0.2, 1.2) * W, rng.uniform(-0.2, 1.2) * H, rng.uniform(0.3, 0.9) * W, rng.uniform(0.2, 0.7) * H, rng.uniform(0, 180), rng.uniform(0.03, 0.15) * W)
        img *= (1 - rng.uniform(0.1, 0.5) * e)[..., None]
    return img.astype(np.float32)


def camera_effects(rng, img: np.ndarray, strength: float = 1.0) -> np.ndarray:
    """Blur / noise / gamma / white balance / JPEG. img float RGB -> uint8 RGB."""
    if rng.random() < 0.7:
        img = cv2.GaussianBlur(img, (0, 0), rng.uniform(0.05, 0.9) * strength + 1e-3)
    if rng.random() < 0.1:
        k = int(rng.integers(3, 6))
        ker = np.zeros((k, k), np.float32)
        ker[k // 2, :] = 1 / k
        M = cv2.getRotationMatrix2D((k / 2 - 0.5, k / 2 - 0.5), rng.uniform(0, 180), 1)
        ker = cv2.warpAffine(ker, M, (k, k))
        ker /= ker.sum() + 1e-6
        img = cv2.filter2D(img, -1, ker)
    img = img * rng.uniform(0.85, 1.15) + rng.uniform(-0.05, 0.05)
    img = img * (1 + rng.normal(0, 0.02, 3))[None, None, :]
    img = np.clip(img, 0, 1) ** rng.uniform(0.8, 1.25)
    sigma = rng.uniform(0.003, 0.035) * strength
    img = img + rng.normal(0, sigma, img.shape).astype(np.float32) * np.sqrt(np.clip(img, 0.05, 1))
    out = (np.clip(img, 0, 1) * 255 + 0.5).astype(np.uint8)
    if rng.random() < 0.8:
        q = int(rng.integers(45, 96))
        ok, buf = cv2.imencode(".jpg", out[..., ::-1], [cv2.IMWRITE_JPEG_QUALITY, q])
        out = cv2.imdecode(buf, cv2.IMREAD_COLOR)[..., ::-1]
    return np.ascontiguousarray(out)


# ----------------------------------------------------------------------------- frames
def _texture(rng, shape, kind):
    """Colour texture of a frame material, float RGB."""
    H, W = shape
    if kind == "tortoise":
        n1 = cv2.resize(rng.normal(0, 1, (max(2, H // 18), max(2, W // 18))).astype(np.float32), (W, H), interpolation=cv2.INTER_CUBIC)
        n2 = cv2.resize(rng.normal(0, 1, (max(2, H // 6), max(2, W // 6))).astype(np.float32), (W, H), interpolation=cv2.INTER_CUBIC)
        spots = np.clip((n1 + 0.5 * n2 - rng.uniform(0.3, 1.0)) * 2, 0, 1)[..., None]
        dark = np.array([0.08, 0.05, 0.03]) * rng.uniform(0.6, 1.4)
        amber = np.array([0.75, 0.48, 0.12]) * rng.uniform(0.7, 1.1)
        return (dark * (1 - spots) + amber * spots).astype(np.float32)
    if kind == "solid":
        col = np.array([[0.05, 0.05, 0.06], [0.12, 0.1, 0.09], [0.1, 0.15, 0.35], [0.45, 0.08, 0.1], [0.2, 0.3, 0.25], [0.7, 0.65, 0.6]])[rng.integers(6)]
        return np.broadcast_to(col * rng.uniform(0.8, 1.2), (H, W, 3)).astype(np.float32).copy()
    # metal: grey / gold
    col = np.array([[0.55, 0.56, 0.58], [0.72, 0.6, 0.35], [0.25, 0.25, 0.27]])[rng.integers(3)]
    return np.broadcast_to(col, (H, W, 3)).astype(np.float32).copy()


def render_frame(img: np.ndarray, polys_px: list[np.ndarray], ppm: float, rng: np.random.Generator) -> np.ndarray:
    """Draw a spectacle frame around lens openings (the polygons = visible openings).

    Rim of 1-8 mm (metal thin, acetate thick), optional transparent acetate,
    a bridge towards one side and an endpiece/hinge block on the other, a cast
    shadow on the paper and a dark line where the lens enters the groove.
    """
    H, W = img.shape[:2]
    kind = rng.choice(["tortoise", "solid", "metal", "clear"], p=[0.35, 0.35, 0.18, 0.12])
    w = rng.uniform(1.0, 2.5) if kind == "metal" else rng.uniform(3.0, 8.0)
    alpha = rng.uniform(0.35, 0.7) if kind == "clear" else 1.0
    mask = np.zeros((H, W), np.uint8)
    for p in polys_px:
        cv2.fillPoly(mask, [np.round(p * 16).astype(np.int32)], 1, cv2.LINE_AA, 4)
    out_d = cv2.distanceTransform(1 - mask, cv2.DIST_L2, 5) / ppm  # mm outside the openings
    in_d = cv2.distanceTransform(mask, cv2.DIST_L2, 5) / ppm
    rim = ((out_d > 0) & (out_d <= w)).astype(np.float32)
    # bridge (nasal side) and endpiece (temporal side) for each opening
    for p in polys_px:
        bx0, by0 = p.min(0)
        bx1, by1 = p.max(0)
        cy = by0 + (by1 - by0) * rng.uniform(0.25, 0.45)
        side = 1 if rng.random() < 0.5 else -1
        bw = rng.uniform(3, 6) * ppm
        xa = bx1 if side > 0 else bx0
        cv2.rectangle(rim, (int(xa), int(cy - bw / 2)), (int(xa + side * 25 * ppm), int(cy + bw / 2)), 1.0, -1)
        xe = bx0 if side > 0 else bx1
        eh = rng.uniform(5, 9) * ppm
        cv2.rectangle(rim, (int(xe - side * (w * ppm + rng.uniform(3, 7) * ppm)), int(cy - eh / 2)), (int(xe), int(cy + eh / 2)), 1.0, -1)
    rim *= 1 - mask  # never over the openings
    rim = cv2.GaussianBlur(rim, (0, 0), 0.4)
    # shadow of the frame on the paper
    dx, dy = rng.uniform(-3, 3, 2) * ppm
    sh = cv2.warpAffine(rim, np.float32([[1, 0, dx], [0, 1, dy]]), (W, H))
    sh = cv2.GaussianBlur(sh, (0, 0), rng.uniform(1, 4) * ppm) * rng.uniform(0.1, 0.4)
    img = img * (1 - sh * (1 - mask))[..., None]
    tex = _texture(rng, (H, W), "solid" if kind == "clear" else kind)
    if kind in ("metal", "solid", "clear"):  # specular line along the rim
        hl = np.exp(-0.5 * ((out_d - w * rng.uniform(0.3, 0.7)) / (0.15 * w + 0.1)) ** 2) * rng.uniform(0.1, 0.5)
        tex = tex + hl[..., None]
    a = (rim * alpha)[..., None]
    img = img * (1 - a) + tex * a
    # dark line where the lens disappears into the groove
    groove = np.exp(-0.5 * (in_d / rng.uniform(0.15, 0.5)) ** 2) * mask * rng.uniform(0.1, 0.5)
    return (img * (1 - groove[..., None])).astype(np.float32)
