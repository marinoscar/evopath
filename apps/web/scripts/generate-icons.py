#!/usr/bin/env python3
"""
Generate every brand asset — rasters AND vectors — from one geometry.

The brand COLOURS come from `packages/shared/identity.json` — the one manifest
the application, the CLI and the web app manifest all read — so a rebrand
cannot leave the icons behind. The mark GEOMETRY lives in the constants below,
and this script is the only place it lives: every file that draws the mark is
written from it.

    python3 apps/web/scripts/generate-icons.py

WHY A COMMITTED SCRIPT AND COMMITTED OUTPUTS, RATHER THAN A BUILD STEP
=============================================================================
This repository is a TEMPLATE. A fork that rebrands it must not be forced to
install an image toolchain (sharp, ImageMagick, librsvg) in CI just to produce
a favicon, so no image library appears in any `package.json` and nothing in
`npm run build` calls this file. Its outputs are committed; this script is the
documented, reproducible way to REGENERATE them after a rebrand, run by hand,
on a machine with Python 3 and Pillow:

    pip install --user 'Pillow>=10'

The script never RASTERISES an SVG (that would need rsvg / cairosvg / a
headless browser). It goes the other way: it computes the mark's outline as a
polygon once, paints that polygon with Pillow for the PNGs, and serialises the
SAME polygon as SVG path data for the vectors. The vectors therefore cannot
drift from the rasters; do not hand-edit them, edit the constants here.

WHAT IT WRITES
=============================================================================
    apps/web/public/icons/icon-192.png              192  manifest, purpose: any
    apps/web/public/icons/icon-512.png              512  manifest, purpose: any
    apps/web/public/icons/icon-maskable-192.png     192  manifest, purpose: maskable
    apps/web/public/icons/icon-maskable-512.png     512  manifest, purpose: maskable
    apps/web/public/icons/badge-96.png               96  notification badge, alpha mask
    apps/web/public/icons/apple-touch-icon-180.png  180  iOS Home Screen
    apps/web/public/favicon.ico                   16/32/48 frames (compact mark)
    apps/web/public/icons/source.svg                512  vector master (standard mark)
    apps/web/public/favicon.svg                      32  tab icon (compact mark)
    apps/web/src/components/common/brandMarkPaths.generated.ts
                                                    both geometries on the 32
                                                    canvas, for `BrandMark.tsx`
    apps/api/src/email/templates/brand-mark.generated.ts
                                                    the standard icon as a 96px
                                                    PNG (2x of 48), base64, for
                                                    the email layout's cid: logo

Running it is idempotent: same inputs, byte-identical outputs, every file
rewritten from scratch.

THE MARK: "THE PATH TO THE SUN"
=============================================================================
The product is the user's path of health evolution toward a goal. The mark is
that path as a white road seen in perspective on the teal plate: wide at the
bottom where the user stands, narrowing as it winds up through two bends (an
S), and converging just below a warm yellow sun — the goal on the horizon.

  - The road is a FILLED RIBBON, not a stroke. Its centreline is drawn like a
    turtle (`MarkSpec.path`): straight legs joined by TRUE circular arcs, so
    every bend has a radius chosen in this file. Arcs become cubic Beziers,
    the cubics are sampled by length, and the outline is the centreline
    offset by +/- half the local width along its normals. The width tapers
    with "depth" (the centreline's height) from `width_base` at the bottom to
    `width_top` at the top — never a hairline.
  - The outline is smooth by construction: each bend's radius is at least
    ~1.45x the road's half-width there, so the inner edge is itself a round
    arc. A safety clamp (`_inner_half`) would round off a bend drawn too tight
    rather than let it crease, and the build fails outright if an edge ever
    crosses itself.
  - The base sits on a flat horizontal baseline (the centreline leaves the
    baseline vertically and the outline is clamped to it), so the road starts
    with a clean cut, not a spike or a blob.
  - The sun is a true circle in `ACCENT_COLOR`, set slightly to the side of
    the road's top end with a clear gap, so the composition reads as a road
    reaching the horizon rather than as a lowercase "i" or a "$".
  - The finished artwork (road + sun) is scaled to fit the mark box and its
    bounding box centred on it, lifted by `OPTICAL_LIFT` because the heavy base
    otherwise makes the mark look as if it sits low.

A second, COMPACT geometry (`COMPACT`) is used where the mark is tiny: the
favicon frames, `favicon.svg`, the notification badge, and `BrandMark` below
32px. It keeps the same S and the sun but draws the road at a uniform width
(about 0.16 of the box once fitted) with rounder bends and a larger gap,
because perspective tapering turns into sub-pixel slivers at 16px.

The accent colour is a LOGO-ONLY colour: the sun, nothing else. It is never a
UI colour (see `ACCENT_COLOR` in `packages/shared/index.js`).

THREE PLATFORM RULES THIS ENCODES (get one wrong and the icon looks broken
only on the platform that cares)
=============================================================================
1. MASKABLE icons are cropped by the launcher to a shape it chooses — circle,
   squircle, teardrop. So their background is FULL-BLEED with no rounding of
   our own, and all meaningful content stays inside the centred safe-zone
   circle of 80% diameter. A maskable icon that reuses the standard artwork
   gets its own rounded corners shaved off.
2. The Android notification BADGE is used as an ALPHA MASK. Every opaque pixel
   is repainted in the system's colour, so a teal square would render as a
   solid blob. It is therefore a transparent canvas with the road AND the sun
   in white, kept legible as two shapes by the gap between them.
3. The iOS touch icon must have NO alpha channel at all: iOS composites
   transparency against black, so transparent corners come out as black
   corners. It is written as RGB with the rounded-square corners filled with
   the background colour.
"""

from __future__ import annotations

import base64
import io
import json
import math
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageDraw

# =============================================================================
# Paths
# =============================================================================
# Everything is resolved from THIS FILE's own location, never from the current
# working directory. The documented invocation is
# `python3 apps/web/scripts/generate-icons.py` from the repository root, but the
# script must write the same bytes to the same places when it is run from
# `apps/web/scripts/`, from a sibling checkout, or from anywhere else.
SCRIPT_DIR = Path(__file__).resolve().parent    # apps/web/scripts
WEB_DIR = SCRIPT_DIR.parent                     # apps/web
REPO_ROOT = WEB_DIR.parent.parent               # <repo root>
PUBLIC_DIR = WEB_DIR / "public"
ICONS_DIR = PUBLIC_DIR / "icons"
IDENTITY_MANIFEST = REPO_ROOT / "packages" / "shared" / "identity.json"
BRAND_MARK_TS = WEB_DIR / "src" / "components" / "common" / "brandMarkPaths.generated.ts"
EMAIL_MARK_TS = REPO_ROOT / "apps" / "api" / "src" / "email" / "templates" / "brand-mark.generated.ts"

FAVICON_ICO_SIZES = (16, 32, 48)


# =============================================================================
# Brand constants
# =============================================================================
# SOURCE OF TRUTH: `packages/shared/identity.json` (`themeColor`,
# `backgroundColor`, `accentColor`). That manifest is what
# `packages/shared/index.js` exports as `THEME_COLOR` / `BACKGROUND_COLOR` /
# `ACCENT_COLOR`, and therefore what the application, the MUI theme and the web
# app manifest all read at runtime.
#
# These values are READ from it rather than copied into it, and that is the
# whole point: this script paints them into committed files, so a rebrand that
# edited one place and forgot the other used to leave every generated icon on
# the old colour with nothing to catch it. JSON is the one format both a
# CommonJS module and a Python script can read. To rebrand: edit
# `identity.json` (or run `node scripts/rename.mjs`), then re-run this script.


def load_identity() -> dict:
    """Parse `packages/shared/identity.json`, or exit with an actionable error."""
    try:
        with IDENTITY_MANIFEST.open(encoding="utf-8") as handle:
            identity = json.load(handle)
    except FileNotFoundError:
        raise SystemExit(
            f"generate-icons: brand manifest not found at {IDENTITY_MANIFEST}\n"
            "  It is the source of truth for the icon colours. Run this script "
            "from a complete\n"
            "  checkout of the repository, or restore "
            "`packages/shared/identity.json`."
        ) from None
    except json.JSONDecodeError as error:
        raise SystemExit(
            f"generate-icons: {IDENTITY_MANIFEST} is not valid JSON\n"
            f"  {error}\n"
            "  Fix the manifest, then re-run this script."
        ) from None

    if not isinstance(identity, dict):
        raise SystemExit(
            f"generate-icons: {IDENTITY_MANIFEST} must contain a JSON object, "
            f"got {type(identity).__name__}."
        )

    return identity


def identity_color(identity: dict, key: str) -> str:
    """Read one colour from the manifest, or exit saying exactly which is wrong."""
    value = identity.get(key)
    if not isinstance(value, str) or not value.strip():
        raise SystemExit(
            f"generate-icons: `{key}` is missing (or is not a colour string) in "
            f"{IDENTITY_MANIFEST}\n"
            f'  Add it as a 6-digit hex literal, e.g. "{key}": "#1976d2", then '
            "re-run this script."
        )
    return value.strip().lower()


_IDENTITY = load_identity()

BRAND_COLOR = identity_color(_IDENTITY, "themeColor")
# Opaque fill for the iOS icon, which must have no alpha channel (see rule 3).
BACKGROUND_COLOR = identity_color(_IDENTITY, "backgroundColor")
# The sun. LOGO-ONLY: never a UI colour.
ACCENT_COLOR = identity_color(_IDENTITY, "accentColor")

# The road is drawn in this colour on the brand-coloured plate. Not a manifest
# field: it is not an identity choice but a legibility one — the badge is an
# alpha mask (rule 2) and the road must contrast with the plate at 16px.
FOREGROUND_COLOR = "#ffffff"

if len({BRAND_COLOR, ACCENT_COLOR, FOREGROUND_COLOR}) != 3:
    # The SVGs are rebranded by `scripts/rename.mjs` anchored on
    # `fill="<colour>"`, and the identity guard counts the plate's fill; two
    # roles sharing one hex would make both ambiguous.
    raise SystemExit(
        "generate-icons: themeColor, accentColor and the white road must be three "
        f"different colours (got {BRAND_COLOR}, {ACCENT_COLOR}, {FOREGROUND_COLOR})."
    )

# =============================================================================
# Mark geometry — all fractions, so the mark is resolution independent
# =============================================================================
# Everything below is in MARK-BOX coordinates: a square box, `0..1` on both
# axes, y DOWN (as in SVG and Pillow). The box is centred on the canvas and its
# side is `MARK_RATIO_*` of the canvas. The design coordinates in `STANDARD`
# and `COMPACT` are normalised (fitted to the box, bounding box centred, then
# lifted by `OPTICAL_LIFT`) before anything is drawn, so they need not be
# exactly centred by hand.
CORNER_RADIUS_RATIO = 0.22   # rounded-square plate radius, as a fraction of size

# The heavy base makes a geometrically centred mark look low; lift it by this
# fraction of the box.
OPTICAL_LIFT = 0.015

# How finely the centreline is sampled before the outline is offset: one
# sample per CURVE_STEP of box length (about 2px on the 512 icon), at least
# CURVE_MIN_SAMPLES per cubic. Far below visible faceting on these radii.
CURVE_STEP = 0.006
CURVE_MIN_SAMPLES = 4


@dataclass(frozen=True)
class MarkSpec:
    """One version of the mark, in design coordinates (box-sized, y down).

    The road's centreline is drawn like a turtle: it leaves the baseline at
    `start_x` heading straight up, then follows `path`, a sequence of
    ("line", length) and ("arc", radius, turn_degrees) steps (positive turns
    left, negative right). Straight legs joined by TRUE circular arcs give
    every bend a radius chosen here, which is what keeps the inside of each
    bend smooth: a bend tighter than the road's half-width cannot be offset
    cleanly by any means (see `_inner_half`).
    """

    start_x: float
    path: tuple[tuple, ...]
    # Road width at the base and at the top end, as fractions of the box.
    width_base: float
    width_top: float
    # Taper curve: width follows depth**taper_power (1 = linear in height;
    # below 1 the road stays wider for longer, a gentler perspective).
    taper_power: float
    # The sun: radius, the clear gap between it and the road's top end, and
    # the direction (degrees, 0 = right, 90 = straight up) from that end.
    sun_radius: float
    sun_gap: float
    sun_angle: float
    # Whether the top end of the road gets a round cap (else a square cut).
    round_top: bool


# The standard mark: a road climbing from a flat baseline through a wide left
# bend and a tighter right bend (perspective), converging up-left beneath a
# sun set off to its right. The bend radii are >= ~1.45x the local half-width,
# so the inner edges are smooth arcs with no help from the safety clamp.
STANDARD = MarkSpec(
    start_x=0.60,
    path=(
        ("line", 0.02),           # leaves the baseline straight up
        ("arc", 0.18, 62),        # eases left into the first crossing
        ("line", 0.06),           # first crossing, climbing left
        ("arc", 0.135, -126),     # the left bend
        ("line", 0.15),           # second crossing, climbing right
        ("arc", 0.095, 112),      # the right bend
        ("line", 0.09),           # the last climb toward the horizon
    ),
    width_base=0.22,
    width_top=0.08,
    taper_power=0.9,
    sun_radius=0.13,
    sun_gap=0.065,
    sun_angle=40,
    round_top=True,
)

# The compact mark: the same S at a uniform width, with rounder bends and a
# larger gap, for favicon and badge sizes.
COMPACT = MarkSpec(
    start_x=0.60,
    path=(
        ("line", 0.01),
        ("arc", 0.16, 60),
        ("line", 0.03),
        ("arc", 0.14, -124),
        ("line", 0.11),
        ("arc", 0.13, 110),
        ("line", 0.05),
    ),
    width_base=0.175,
    width_top=0.175,
    taper_power=1.0,
    sun_radius=0.17,
    sun_gap=0.10,
    sun_angle=38,
    round_top=True,
)

# How much of the canvas the mark box occupies, per icon family.
MARK_RATIO_STANDARD = 0.68   # rounded plate, corners are ours to shape
MARK_RATIO_MASKABLE = 0.50   # inside the 80%-diameter safe zone with room to spare
MARK_RATIO_BADGE = 0.70      # no plate, so the mark can breathe wider
MARK_RATIO_FAVICON = 0.80    # tab-sized: padding costs whole pixels, so spend fewer

# Anti-aliasing. Pillow's drawing primitives are hard-edged, so everything is
# drawn at this multiple and downsampled with LANCZOS; that resample IS the
# anti-aliasing.
SUPERSAMPLE = 8

# The email logo: the standard icon at 2x of its CSS display size.
EMAIL_DISPLAY_SIZE = 48
EMAIL_PNG_SIZE = EMAIL_DISPLAY_SIZE * 2


# =============================================================================
# Geometry: centreline -> ribbon outline polygon
# =============================================================================

Point = tuple[float, float]


def _cubic(
    p0: Point, p1: Point, p2: Point, p3: Point, t: float
) -> tuple[Point, Point, float]:
    """Point, (unnormalised) tangent and signed curvature of a cubic at `t`.

    The curvature `k = (x'y'' - y'x'') / |v|^3` is signed so that `k > 0` puts
    the centre of curvature on the LEFT normal `(-ty, tx)`, `k < 0` on the right.
    """
    u = 1.0 - t
    point = (
        u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
        u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
    )
    d1 = (
        3 * u * u * (p1[0] - p0[0]) + 6 * u * t * (p2[0] - p1[0]) + 3 * t * t * (p3[0] - p2[0]),
        3 * u * u * (p1[1] - p0[1]) + 6 * u * t * (p2[1] - p1[1]) + 3 * t * t * (p3[1] - p2[1]),
    )
    d2 = (
        6 * u * (p2[0] - 2 * p1[0] + p0[0]) + 6 * t * (p3[0] - 2 * p2[0] + p1[0]),
        6 * u * (p2[1] - 2 * p1[1] + p0[1]) + 6 * t * (p3[1] - 2 * p2[1] + p1[1]),
    )
    speed = math.hypot(*d1) or 1e-12
    curvature = (d1[0] * d2[1] - d1[1] * d2[0]) / speed**3
    return point, d1, curvature


Cubic = tuple[Point, Point, Point]


def _segments(spec: MarkSpec) -> tuple[Point, list[Cubic], Point, Point]:
    """The turtle path as cubic Beziers.

    Returns (start, cubics, end point, end direction). Lines become cubics
    with handles at thirds; arcs are split into pieces of at most 90 degrees,
    each the standard cubic approximation of a circular arc (handle length
    4/3 * tan(theta / 4) * radius), accurate far below a pixel.
    """
    x, y = spec.start_x, 1.0
    heading = math.pi / 2  # straight up, with the angle measured y-UP
    cubics: list[Cubic] = []
    for step in spec.path:
        dx, dy = math.cos(heading), -math.sin(heading)
        if step[0] == "line":
            length = step[1]
            end = (x + dx * length, y + dy * length)
            cubics.append(
                ((x + dx * length / 3, y + dy * length / 3),
                 (x + dx * 2 * length / 3, y + dy * 2 * length / 3),
                 end)
            )
            x, y = end
            continue
        _, radius, turn_degrees = step
        pieces = max(1, math.ceil(abs(turn_degrees) / 90))
        piece = math.radians(turn_degrees) / pieces
        side = 1 if piece > 0 else -1
        for _ in range(pieces):
            dx, dy = math.cos(heading), -math.sin(heading)
            # Centre of the turning circle, on the side the road turns toward.
            cx = x - side * radius * math.sin(heading)
            cy = y - side * radius * math.cos(heading)
            heading += piece
            ex = cx + side * radius * math.sin(heading)
            ey = cy + side * radius * math.cos(heading)
            handle = 4 / 3 * math.tan(abs(piece) / 4) * radius
            ux, uy = math.cos(heading), -math.sin(heading)
            cubics.append(
                ((x + dx * handle, y + dy * handle), (ex - ux * handle, ey - uy * handle), (ex, ey))
            )
            x, y = ex, ey
    return (spec.start_x, 1.0), cubics, (x, y), (math.cos(heading), -math.sin(heading))


def _sun(spec: MarkSpec) -> tuple[float, float, float]:
    """The sun's centre and radius: `sun_gap` clear of the road's top end."""
    _, _, (ex, ey), _ = _segments(spec)
    distance = spec.sun_radius + spec.sun_gap + spec.width_top / 2
    angle = math.radians(spec.sun_angle)
    return (ex + math.cos(angle) * distance, ey - math.sin(angle) * distance, spec.sun_radius)


def _centreline(spec: MarkSpec) -> list[tuple[Point, Point, float]]:
    """The centreline as (point, unit tangent, signed curvature) samples."""
    start, cubics, _, _ = _segments(spec)
    samples: list[tuple[Point, Point, float]] = []
    current = start
    for index, (c1, c2, end) in enumerate(cubics):
        first = 0 if index == 0 else 1  # shared joints are sampled once
        hull = (
            math.dist(current, c1) + math.dist(c1, c2) + math.dist(c2, end)
        )  # control-polygon length: an upper bound on the arc length
        count = max(CURVE_MIN_SAMPLES, math.ceil(hull / CURVE_STEP))
        for step in range(first, count + 1):
            point, (tx, ty), curvature = _cubic(current, c1, c2, end, step / count)
            length = math.hypot(tx, ty) or 1.0
            samples.append((point, (tx / length, ty / length), curvature))
        current = end
    return samples


# On the INSIDE of a bend, the inner half-width is limited to INNER_CLEARANCE
# x the local radius of curvature. Past 1.0 the offset edge folds over itself
# (a crease or a swallowtail); 0.8 leaves the inner edge a radius of at least
# 0.2 R.
#
# The limit is a SAFETY NET, not a styling tool: the bends in `STANDARD` and
# `COMPACT` are drawn with radii generous enough (R >= ~1.45 x half-width)
# that it never engages. It is exactly the identity until the half-width
# reaches INNER_KNEE of the limit and only then eases (C1, via tanh) toward
# the limit, so a well-drawn bend is untouched and a too-tight one is rounded
# rather than creased. The curvature it reads is dilated and blurred along
# the centreline (CURVATURE_BLUR x half-width) so that, when it does engage,
# it covers the whole bend and the width eases in and out instead of stepping.
INNER_CLEARANCE = 0.8
INNER_KNEE = 0.85
CURVATURE_BLUR = 1.0


def _inner_half(half: float, curvature: float) -> float:
    """`half`, limited to INNER_CLEARANCE x the radius of curvature (see above)."""
    if abs(curvature) < 1e-9:
        return half
    limit = INNER_CLEARANCE / abs(curvature)
    knee = INNER_KNEE * limit
    if half <= knee:
        return half
    span = limit - knee
    return knee + span * math.tanh((half - knee) / span)


def _smoothed_curvature(
    samples: list[tuple[Point, Point, float]], halves: list[float]
) -> list[float]:
    """Signed curvature, dilated then Gaussian-blurred along arc length.

    Dilated first (a running MAXIMUM of each side's curvature over +/- 2 sigma)
    so the full limit covers the whole bend and a margin either side of it,
    then blurred (sigma ~ half-width) so the inner width eases in and out
    instead of stepping. Averaging alone would weaken the limit exactly at the
    ends of an arc, where the inner offset starts to fold. Each side is
    processed separately, so a left bend next to a right one is not averaged
    into a straight; per sample, the side with the larger result wins.
    """
    arc = [0.0]
    for (p0, _, _), (p1, _, _) in zip(samples, samples[1:]):
        arc.append(arc[-1] + math.hypot(p1[0] - p0[0], p1[1] - p0[1]))
    sigmas = [max(1e-6, CURVATURE_BLUR * half) for half in halves]
    count = len(samples)

    def window(i: int, reach: float) -> range:
        lo = i
        while lo > 0 and arc[i] - arc[lo - 1] <= reach:
            lo -= 1
        hi = i
        while hi < count - 1 and arc[hi + 1] - arc[i] <= reach:
            hi += 1
        return range(lo, hi + 1)

    positive = [max(k, 0.0) for _, _, k in samples]
    negative = [max(-k, 0.0) for _, _, k in samples]
    dilated = [
        (
            max(positive[j] for j in window(i, 2 * sigmas[i])),
            max(negative[j] for j in window(i, 2 * sigmas[i])),
        )
        for i in range(count)
    ]
    result = []
    for i in range(count):
        pos = neg = total = 0.0
        for j in window(i, 3 * sigmas[i]):
            weight = math.exp(-0.5 * ((arc[j] - arc[i]) / sigmas[i]) ** 2)
            total += weight
            pos += weight * dilated[j][0]
            neg += weight * dilated[j][1]
        pos, neg = pos / total, neg / total
        result.append(pos if pos >= neg else -neg)
    return result


def _ribbon(spec: MarkSpec) -> list[Point]:
    """The road outline: the centreline offset by +/- half the local width.

    The outer side of every bend gets the full half-width; the inner side is
    limited by the local radius of curvature (`_inner_half`), so the outline
    is smooth by construction: no creases, teeth or self-intersections.
    """
    samples = _centreline(spec)
    y_base = 1.0
    y_top = samples[-1][0][1]

    def width_at(y: float) -> float:
        depth = min(1.0, max(0.0, (y - y_top) / (y_base - y_top)))
        return spec.width_top + (spec.width_base - spec.width_top) * depth ** spec.taper_power

    halves = [width_at(y) / 2 for (_, y), _, _ in samples]
    curvatures = _smoothed_curvature(samples, halves)
    left: list[Point] = []
    right: list[Point] = []
    for ((x, y), (tx, ty), _), half, curvature in zip(samples, halves, curvatures):
        # The centre of curvature is on the left when curvature > 0.
        half_left = _inner_half(half, curvature) if curvature > 0 else half
        half_right = _inner_half(half, curvature) if curvature < 0 else half
        nx, ny = -ty, tx  # left-hand normal (y down)
        # Clamped to the baseline: the base is a flat, clean cut.
        left.append((x + nx * half_left, min(y_base, y + ny * half_left)))
        right.append((x - nx * half_right, min(y_base, y - ny * half_right)))

    cap: list[Point] = []
    if spec.round_top:
        (x, y), (tx, ty), _ = samples[-1]
        half = spec.width_top / 2
        nx, ny = -ty, tx
        # Sweep from the left edge, over the end (along the tangent), to the
        # right edge: a semicircle, so the narrow end is soft, never a point.
        steps = 16
        for step in range(1, steps):
            theta = math.pi * step / steps
            c, s = math.cos(theta), math.sin(theta)
            cap.append((x + (c * nx + s * tx) * half, y + (c * ny + s * ty) * half))

    for edge in (left, right):
        if _self_intersects(edge):
            raise SystemExit(
                "generate-icons: the road outline crosses itself. A bend is too "
                "tight for the road's width; loosen the bend in the MarkSpec."
            )
    return left + cap + right[::-1]


def _self_intersects(edge: list[Point]) -> bool:
    """Whether a polyline crosses itself (non-adjacent segments only)."""
    for i in range(len(edge) - 1):
        for j in range(i + 2, len(edge) - 1):
            if _segment_intersection(edge[i], edge[i + 1], edge[j], edge[j + 1]) is not None:
                return True
    return False


def _segment_intersection(a: Point, b: Point, c: Point, d: Point) -> Point | None:
    """Intersection of segments ab and cd, or None."""
    rx, ry = b[0] - a[0], b[1] - a[1]
    sx, sy = d[0] - c[0], d[1] - c[1]
    denom = rx * sy - ry * sx
    if abs(denom) < 1e-12:
        return None
    qx, qy = c[0] - a[0], c[1] - a[1]
    t = (qx * sy - qy * sx) / denom
    u = (qx * ry - qy * rx) / denom
    if 0.0 < t < 1.0 and 0.0 < u < 1.0:
        return (a[0] + t * rx, a[1] + t * ry)
    return None


@dataclass(frozen=True)
class MarkGeometry:
    """The finished mark in box coordinates: road polygon and sun circle."""

    road: list[Point]
    sun: tuple[float, float, float]


def build_geometry(spec: MarkSpec) -> MarkGeometry:
    """Ribbon + sun, fitted to the unit box and optically centred."""
    road = _ribbon(spec)
    sx, sy, sr = _sun(spec)

    xs = [p[0] for p in road] + [sx - sr, sx + sr]
    ys = [p[1] for p in road] + [sy - sr, sy + sr]
    min_x, max_x, min_y, max_y = min(xs), max(xs), min(ys), max(ys)
    scale = 1.0 / max(max_x - min_x, max_y - min_y)
    off_x = 0.5 - (min_x + max_x) / 2 * scale
    off_y = 0.5 - (min_y + max_y) / 2 * scale - OPTICAL_LIFT

    def fit(p: Point) -> Point:
        return (p[0] * scale + off_x, p[1] * scale + off_y)

    return MarkGeometry(
        road=[fit(p) for p in road],
        sun=(sx * scale + off_x, sy * scale + off_y, sr * scale),
    )


GEOMETRY_STANDARD = build_geometry(STANDARD)
GEOMETRY_COMPACT = build_geometry(COMPACT)


def sun_gap(geometry: MarkGeometry) -> float:
    """Closest distance between the sun's edge and the road outline (box units)."""
    sx, sy, sr = geometry.sun
    return min(math.hypot(x - sx, y - sy) for x, y in geometry.road) - sr


# =============================================================================
# Raster rendering
# =============================================================================


def _place(geometry: MarkGeometry, size: float, mark_ratio: float):
    box = size * mark_ratio
    origin = (size - box) / 2
    road = [(origin + x * box, origin + y * box) for x, y in geometry.road]
    sx, sy, sr = geometry.sun
    return road, (origin + sx * box, origin + sy * box, sr * box)


def draw_mark(
    draw: ImageDraw.ImageDraw,
    size: int,
    mark_ratio: float,
    geometry: MarkGeometry,
    road_fill: str,
    sun_fill: str,
) -> None:
    """Draw the road and the sun centred on a `size`x`size` canvas."""
    road, (sx, sy, sr) = _place(geometry, size, mark_ratio)
    draw.polygon(road, fill=road_fill)
    draw.ellipse((sx - sr, sy - sr, sx + sr, sy + sr), fill=sun_fill)


def render_standard(
    size: int,
    mark_ratio: float = MARK_RATIO_STANDARD,
    geometry: MarkGeometry = GEOMETRY_STANDARD,
) -> Image.Image:
    """Rounded brand-coloured plate, transparent corners, mark on top. RGBA."""
    scale = size * SUPERSAMPLE
    image = Image.new("RGBA", (scale, scale), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle(
        (0, 0, scale - 1, scale - 1),
        radius=scale * CORNER_RADIUS_RATIO,
        fill=BRAND_COLOR,
    )
    draw_mark(draw, scale, mark_ratio, geometry, FOREGROUND_COLOR, ACCENT_COLOR)
    return image.resize((size, size), Image.LANCZOS)


def render_maskable(size: int) -> Image.Image:
    """Full-bleed plate (the launcher applies its own mask), small mark. RGB.

    No alpha channel: every pixel is opaque by construction, and an RGB file
    makes it impossible to reintroduce transparent corners by accident.
    """
    scale = size * SUPERSAMPLE
    image = Image.new("RGB", (scale, scale), BRAND_COLOR)
    draw = ImageDraw.Draw(image)
    draw_mark(draw, scale, MARK_RATIO_MASKABLE, GEOMETRY_STANDARD, FOREGROUND_COLOR, ACCENT_COLOR)
    return image.resize((size, size), Image.LANCZOS)


def render_badge(size: int) -> Image.Image:
    """Transparent canvas, white road AND sun. RGBA — Android reads ONLY the alpha."""
    scale = size * SUPERSAMPLE
    image = Image.new("RGBA", (scale, scale), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw_mark(draw, scale, MARK_RATIO_BADGE, GEOMETRY_COMPACT, FOREGROUND_COLOR, FOREGROUND_COLOR)
    return image.resize((size, size), Image.LANCZOS)


def render_apple_touch(size: int) -> Image.Image:
    """Rounded plate with the corners filled opaque. RGB — iOS renders alpha black."""
    standard = render_standard(size)
    canvas = Image.new("RGB", (size, size), BACKGROUND_COLOR)
    canvas.paste(standard, (0, 0), standard)
    return canvas


def render_favicon_frame(size: int) -> Image.Image:
    """The tab-size crop with the compact mark."""
    return render_standard(size, MARK_RATIO_FAVICON, GEOMETRY_COMPACT)


def png_bytes(image: Image.Image) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG", optimize=True)
    return buffer.getvalue()


# =============================================================================
# Vector serialisation
# =============================================================================


def _num(value: float) -> str:
    """2-decimal number with no trailing zeros (and no "-0")."""
    text = f"{value:.2f}".rstrip("0").rstrip(".")
    return "0" if text in ("-0", "") else text


# Vector outputs drop polygon vertices that deviate from a straight run by
# less than this fraction of the canvas (Ramer-Douglas-Peucker): far below a
# pixel at any size the file is drawn at, and it keeps favicon.svg, which every
# page load fetches, small. The rasters are painted from the full polygon.
VECTOR_TOLERANCE = 0.0005


def _simplify(points: list[Point], tolerance: float) -> list[Point]:
    """Ramer-Douglas-Peucker polyline simplification (iterative)."""
    if len(points) < 3:
        return points
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        first, last = stack.pop()
        (ax, ay), (bx, by) = points[first], points[last]
        length = math.hypot(bx - ax, by - ay) or 1e-12
        worst, index = 0.0, -1
        for i in range(first + 1, last):
            px, py = points[i]
            distance = abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / length
            if distance > worst:
                worst, index = distance, i
        if index != -1 and worst > tolerance:
            keep[index] = True
            stack.extend(((first, index), (index, last)))
    return [point for point, kept in zip(points, keep) if kept]


def path_data(geometry: MarkGeometry, size: float, mark_ratio: float) -> str:
    """The road polygon as SVG path data on a `size` canvas."""
    road, _ = _place(geometry, size, mark_ratio)
    road = _simplify(road, size * VECTOR_TOLERANCE)
    points = []
    for x, y in road:
        point = f"{_num(x)} {_num(y)}"
        if not points or points[-1] != point:  # drop duplicates after rounding
            points.append(point)
    return "M" + " L".join(points) + "Z"


def sun_circle(geometry: MarkGeometry, size: float, mark_ratio: float) -> tuple[str, str, str]:
    _, (sx, sy, sr) = _place(geometry, size, mark_ratio)
    return _num(sx), _num(sy), _num(sr)


SVG_HEADER = """<!--
  GENERATED by apps/web/scripts/generate-icons.py — do not edit by hand.
  {what}
  Regenerate (after changing the geometry in that script, or the colours in
  packages/shared/identity.json):

      python3 apps/web/scripts/generate-icons.py

  Plate = themeColor, road = white, sun = accentColor (a logo-only colour).
-->
"""


def write_svg(
    path: Path,
    size: int,
    mark_ratio: float,
    geometry: MarkGeometry,
    what: str,
    extra_attrs: str = "",
) -> None:
    radius = _num(size * CORNER_RADIUS_RATIO)
    cx, cy, r = sun_circle(geometry, size, mark_ratio)
    svg = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        + SVG_HEADER.format(what=what)
        + f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" '
        f'viewBox="0 0 {size} {size}"{extra_attrs}>\n'
        f'  <rect width="{size}" height="{size}" rx="{radius}" fill="{BRAND_COLOR}"/>\n'
        f'  <path d="{path_data(geometry, size, mark_ratio)}" fill="{FOREGROUND_COLOR}"/>\n'
        f'  <circle cx="{cx}" cy="{cy}" r="{r}" fill="{ACCENT_COLOR}"/>\n'
        "</svg>\n"
    )
    path.write_text(svg, encoding="utf-8")


# =============================================================================
# TypeScript modules
# =============================================================================

# BrandMark.tsx draws on a 32-unit viewBox. The plate geometry is placed at
# the standard ratio (large plates) or the favicon ratio (compact, small
# plates); the glyph geometry fills the box edge to edge with a small margin.
TS_CANVAS = 32
GLYPH_RATIO = 0.94


def write_brand_mark_ts(path: Path) -> None:
    def entry(name: str, geometry: MarkGeometry, ratio: float, doc: str) -> str:
        cx, cy, r = sun_circle(geometry, TS_CANVAS, ratio)
        return (
            f"/** {doc} */\n"
            f"export const {name} = {{\n"
            f"  road: '{path_data(geometry, TS_CANVAS, ratio)}',\n"
            f"  sun: {{ cx: {cx}, cy: {cy}, r: {r} }},\n"
            "} as const;\n"
        )

    body = (
        "// GENERATED by apps/web/scripts/generate-icons.py — do not edit by hand.\n"
        "//\n"
        "// The brand mark's geometry for `BrandMark.tsx`, computed from the same\n"
        "// polygon that paints the PNG icons and writes the SVGs, so the React mark\n"
        "// cannot drift from them. Every value is on a 32-unit viewBox. Regenerate with:\n"
        "//\n"
        "//     python3 apps/web/scripts/generate-icons.py\n"
        "\n"
        f"/** The viewBox side every value below is expressed on. */\n"
        f"export const BRAND_MARK_VIEWBOX = {TS_CANVAS};\n"
        "\n"
        f"/** Plate corner radius ({CORNER_RADIUS_RATIO} of the side). */\n"
        f"export const BRAND_MARK_PLATE_RADIUS = {_num(TS_CANVAS * CORNER_RADIUS_RATIO)};\n"
        "\n"
        + entry(
            "BRAND_MARK_PLATE_STANDARD",
            GEOMETRY_STANDARD,
            MARK_RATIO_STANDARD,
            f"Standard road + sun on a plate (mark box {MARK_RATIO_STANDARD} of the side).",
        )
        + "\n"
        + entry(
            "BRAND_MARK_PLATE_COMPACT",
            GEOMETRY_COMPACT,
            MARK_RATIO_FAVICON,
            f"Compact road + sun on a plate, for small sizes (mark box {MARK_RATIO_FAVICON}).",
        )
        + "\n"
        + entry(
            "BRAND_MARK_GLYPH_STANDARD",
            GEOMETRY_STANDARD,
            GLYPH_RATIO,
            f"Standard road + sun with no plate (mark box {GLYPH_RATIO}).",
        )
        + "\n"
        + entry(
            "BRAND_MARK_GLYPH_COMPACT",
            GEOMETRY_COMPACT,
            GLYPH_RATIO,
            f"Compact road + sun with no plate (mark box {GLYPH_RATIO}).",
        )
    )
    path.write_text(body, encoding="utf-8")


def write_email_ts(path: Path, png: bytes) -> None:
    encoded = base64.b64encode(png).decode("ascii")
    body = (
        "// GENERATED by apps/web/scripts/generate-icons.py — do not edit by hand.\n"
        "//\n"
        "// The brand mark as an inline PNG for HTML email. Emails cannot load remote\n"
        "// images by default, so the layout attaches these bytes to every message and\n"
        "// references them as `cid:${BRAND_MARK_CID}`. Regenerate with:\n"
        "//\n"
        "//     python3 apps/web/scripts/generate-icons.py\n"
        "\n"
        "/** Content-ID the layout's <img src=\"cid:...\"> points at. */\n"
        "export const BRAND_MARK_CID = 'brand-mark';\n"
        "\n"
        "/** Attachment filename (shown by clients that list inline parts). */\n"
        "export const BRAND_MARK_FILENAME = 'brand-mark.png';\n"
        "\n"
        "/** Rendered size in CSS pixels; the PNG is 2x for high-density screens. */\n"
        f"export const BRAND_MARK_DISPLAY_SIZE = {EMAIL_DISPLAY_SIZE};\n"
        "\n"
        "/** PNG bytes, base64-encoded. */\n"
        "export const BRAND_MARK_PNG_BASE64 =\n"
        f"  '{encoded}';\n"
    )
    path.write_text(body, encoding="utf-8")


# =============================================================================
# Main
# =============================================================================


def _rel(path: Path) -> str:
    return str(path.relative_to(REPO_ROOT))


def main() -> None:
    ICONS_DIR.mkdir(parents=True, exist_ok=True)

    outputs: list[tuple[Path, Image.Image]] = [
        (ICONS_DIR / "icon-192.png", render_standard(192)),
        (ICONS_DIR / "icon-512.png", render_standard(512)),
        (ICONS_DIR / "icon-maskable-192.png", render_maskable(192)),
        (ICONS_DIR / "icon-maskable-512.png", render_maskable(512)),
        (ICONS_DIR / "badge-96.png", render_badge(96)),
        (ICONS_DIR / "apple-touch-icon-180.png", render_apple_touch(180)),
    ]

    for path, image in outputs:
        image.save(path, format="PNG", optimize=True)
        print(f"wrote {_rel(path)}  {image.size[0]}x{image.size[1]}  {image.mode}")

    # The .ico carries three frames because the contexts that still read it
    # differ: 16px is the browser tab, 32px the bookmark bar and taskbar, 48px
    # a Windows desktop shortcut. Each frame is rendered and downsampled
    # independently rather than letting the ICO encoder shrink one big frame.
    # They use the compact mark and the tighter favicon crop, which
    # `public/favicon.svg` matches.
    frames = [render_favicon_frame(size) for size in FAVICON_ICO_SIZES]
    ico_path = PUBLIC_DIR / "favicon.ico"
    frames[-1].save(
        ico_path,
        format="ICO",
        sizes=[(size, size) for size in FAVICON_ICO_SIZES],
        append_images=frames[:-1],
    )
    print(f"wrote {_rel(ico_path)}  {'/'.join(str(s) for s in FAVICON_ICO_SIZES)}px frames")

    source_svg = ICONS_DIR / "source.svg"
    write_svg(
        source_svg,
        512,
        MARK_RATIO_STANDARD,
        GEOMETRY_STANDARD,
        "The vector master of the brand mark (standard geometry, 512 canvas). Nothing\n"
        "  loads it at runtime; it exists for design tools and as a reference.",
        ' role="img" aria-label="Application mark"',
    )
    print(f"wrote {_rel(source_svg)}")

    favicon_svg = PUBLIC_DIR / "favicon.svg"
    write_svg(
        favicon_svg,
        32,
        MARK_RATIO_FAVICON,
        GEOMETRY_COMPACT,
        "The tab icon (compact geometry, favicon crop, 32 canvas); favicon.ico's\n"
        "  frames use the identical geometry.",
    )
    print(f"wrote {_rel(favicon_svg)}")

    write_brand_mark_ts(BRAND_MARK_TS)
    print(f"wrote {_rel(BRAND_MARK_TS)}")

    email_png = png_bytes(render_standard(EMAIL_PNG_SIZE))
    write_email_ts(EMAIL_MARK_TS, email_png)
    print(f"wrote {_rel(EMAIL_MARK_TS)}  {EMAIL_PNG_SIZE}x{EMAIL_PNG_SIZE} PNG, {len(email_png)} bytes")

    print(
        f"\nsun gap: standard {sun_gap(GEOMETRY_STANDARD):.3f}, "
        f"compact {sun_gap(GEOMETRY_COMPACT):.3f} (box units)"
    )


if __name__ == "__main__":
    main()
