#!/usr/bin/env python3
"""
Generate every brand raster under `apps/web/public/`.

The brand COLOURS come from `packages/shared/identity.json` — the one manifest
the application, the CLI and the web app manifest all read — so a rebrand
cannot leave the icons behind. The mark GEOMETRY lives in the constants below.

    python3 apps/web/scripts/generate-icons.py

WHY A COMMITTED SCRIPT AND COMMITTED PNGs, RATHER THAN A BUILD STEP
=============================================================================
This repository is a TEMPLATE. A fork that rebrands it must not be forced to
install an image toolchain (sharp, ImageMagick, librsvg) in CI just to produce
a favicon, so no image library appears in any `package.json` and nothing in
`npm run build` calls this file. The PNGs it writes are committed; this script
is the documented, reproducible way to REGENERATE them after a rebrand, run by
hand, on a machine with Python 3 and Pillow:

    pip install --user 'Pillow>=10'

The mark itself also exists as hand-editable vector art in
`apps/web/public/icons/source.svg`. That SVG and the geometry constants in this
file describe the same mark and must be kept in step — this script deliberately
does NOT rasterise the SVG, because doing so would reintroduce exactly the
rendering dependency (rsvg / cairosvg / a headless browser) the committed-PNG
approach exists to avoid.

WHAT IT WRITES
=============================================================================
    public/icons/icon-192.png              192  manifest, purpose: any
    public/icons/icon-512.png              512  manifest, purpose: any
    public/icons/icon-maskable-192.png     192  manifest, purpose: maskable
    public/icons/icon-maskable-512.png     512  manifest, purpose: maskable
    public/icons/badge-96.png               96  notification badge, monochrome
    public/icons/apple-touch-icon-180.png  180  iOS Home Screen
    public/favicon.ico                   16/32/48 frames

Every file carries the same mark — "the path" (see MARK GEOMETRY below) — in
white, on the brand-coloured plate where the family has one.

`public/favicon.svg` and `public/icons/source.svg` are hand-written vector and
are NOT touched by this script.

Running it is idempotent: same inputs, byte-comparable outputs, every file
rewritten from scratch.

THE MARK: "THE PATH"
=============================================================================
The product is the user's path of health evolution, built on a longitudinal
record. The mark is that path, reduced to a silhouette: ONE smooth stroke that
enters low on the left, dips once, then climbs to the upper right and ends in
a filled dot — the latest measurement, "you are here". One colour, no
gradient, no outline, so it survives being an alpha mask (the badge) and
being two pixels wide (the favicon).

Pillow has no Bezier primitive, so each of the two cubic segments is sampled
into a polyline (`CURVE_SAMPLES` points per segment) and drawn as straight
`ImageDraw.line` segments with a disc of radius width/2 stamped on EVERY
vertex. The discs are the round joins and the round start cap in one gesture
(`ImageDraw.line`'s own `joint="curve"` leaves hairline slivers inside a wide
stroke when the segments are short, which at 8x supersampling they are); the
end is hidden under the terminal dot. The polyline's facets are far below one
output pixel.

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
   solid blob. It is therefore a transparent canvas with the mark in white.
3. The iOS touch icon must have NO alpha channel at all: iOS composites
   transparency against black, so transparent corners come out as black
   corners. It is written as RGB with the rounded-square corners filled with
   the background colour.
"""

from __future__ import annotations

import json
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

FAVICON_ICO_SIZES = (16, 32, 48)


# =============================================================================
# Brand constants
# =============================================================================
# SOURCE OF TRUTH: `packages/shared/identity.json` (`themeColor`,
# `backgroundColor`). That manifest is what `packages/shared/index.js` exports as
# `THEME_COLOR` / `BACKGROUND_COLOR`, and therefore what the application, the MUI
# theme and the web app manifest all read at runtime.
#
# These values are READ from it rather than copied into it, and that is the whole
# point: this script paints them into committed PNGs, so a rebrand that edited
# one place and forgot the other used to leave every generated icon on the old
# colour with nothing to catch it. JSON is the one format both a CommonJS module
# and a Python script can read — a Python script cannot import
# `packages/shared/index.js` — so the manifest, not either consumer, holds the
# fact. To rebrand: edit `identity.json` (or run `node scripts/rename.mjs`), then
# re-run this script to regenerate the rasters.


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
    return value


_IDENTITY = load_identity()

BRAND_COLOR = identity_color(_IDENTITY, "themeColor")
# Opaque fill for the iOS icon, which must have no alpha channel (see rule 3).
BACKGROUND_COLOR = identity_color(_IDENTITY, "backgroundColor")

# The mark is drawn in this colour on the brand-coloured plate. Not a manifest
# field: it is not an identity choice but a legibility one — the badge is an
# alpha mask (rule 2) and the mark must contrast with the plate at 16px.
FOREGROUND_COLOR = "#ffffff"

# =============================================================================
# Mark geometry — all fractions, so the mark is resolution independent
# =============================================================================
# Everything below is expressed in MARK-BOX coordinates: a square box, `0..1`
# on both axes, y DOWN (as in SVG and Pillow), that the mark is laid out in.
# The box is centred on the canvas and its side is `MARK_RATIO_*` of the
# canvas. `apps/web/public/icons/source.svg` carries the same numbers scaled
# onto the 512 canvas, and `public/favicon.svg` onto the 32 canvas with the
# favicon crop.
#
# The stroke's round caps and the end dot overhang the box slightly on purpose
# (about 0.06 on the left, 0.11 on the right at the dot): the box frames the
# path's CENTRELINE, which is what the SVG `d` attribute describes too, so the
# two descriptions share one set of numbers instead of each carrying its own
# fudge for the stroke width.
CORNER_RADIUS_RATIO = 0.22   # rounded-square plate radius, as a fraction of size

# The path: start, then two cubic Bezier segments as (control 1, control 2, end).
PATH_START = (0.02, 0.78)
PATH_SEGMENTS = (
    # The dip: a shallow trough just right of the start.
    ((0.16, 0.78), (0.28, 0.92), (0.42, 0.90)),
    # The climb: a long S-curve up to the top-right.
    ((0.60, 0.88), (0.74, 0.22), (0.98, 0.18)),
)
STROKE_WIDTH_RATIO = 0.16    # stroke width, as a fraction of the mark box side
END_DOT_RADIUS_RATIO = 0.13  # terminal dot radius; > stroke/2 so it reads as a point
# How finely each cubic is sampled before it is drawn as a polyline. 64 is far
# more than the eye needs at 8x supersampling; it costs nothing and keeps the
# tightest part of the climb free of visible facets at 512px.
CURVE_SAMPLES = 64

# How much of the canvas the mark box occupies, per icon family.
MARK_RATIO_STANDARD = 0.68   # rounded plate, corners are ours to shape
MARK_RATIO_MASKABLE = 0.50   # inside the 80%-diameter safe zone with room to spare
MARK_RATIO_BADGE = 0.70      # no plate, so the mark can breathe wider
MARK_RATIO_FAVICON = 0.80    # tab-sized: padding costs whole pixels, so spend fewer

# Anti-aliasing. Pillow's drawing primitives are hard-edged, so everything is
# drawn at this multiple and downsampled with LANCZOS; that resample IS the
# anti-aliasing. 8x rather than 4x because the 16px favicon frame is where it
# shows: at 4x the stroke's edges land on visibly coarser alpha steps.
SUPERSAMPLE = 8


def _cubic_point(
    p0: tuple[float, float],
    p1: tuple[float, float],
    p2: tuple[float, float],
    p3: tuple[float, float],
    t: float,
) -> tuple[float, float]:
    """Evaluate a cubic Bezier at `t` in [0, 1]."""
    u = 1.0 - t
    a, b, c, d = u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t
    return (
        a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0],
        a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1],
    )


def path_points() -> list[tuple[float, float]]:
    """The whole path as one polyline in mark-box coordinates.

    Each cubic contributes `CURVE_SAMPLES` points, excluding its start (which
    is the previous segment's end), so consecutive segments share no duplicate
    vertex — a zero-length segment would otherwise give `joint="curve"` a
    degenerate direction to round.
    """
    points = [PATH_START]
    current = PATH_START
    for control1, control2, end in PATH_SEGMENTS:
        for step in range(1, CURVE_SAMPLES + 1):
            points.append(_cubic_point(current, control1, control2, end, step / CURVE_SAMPLES))
        current = end
    return points


def draw_mark(draw: ImageDraw.ImageDraw, size: int, mark_ratio: float, fill: str) -> None:
    """Draw the path mark centred on a `size`x`size` canvas.

    `mark_ratio` is the mark box's side as a fraction of the canvas; the box
    is centred on both axes and the path is laid out inside it.
    """
    box = size * mark_ratio
    origin = (size - box) / 2
    stroke = box * STROKE_WIDTH_RATIO
    dot_radius = box * END_DOT_RADIUS_RATIO

    points = [(origin + x * box, origin + y * box) for x, y in path_points()]

    # Pillow's `width` is an integer number of pixels; at SUPERSAMPLE x the
    # rounding error is a fraction of one OUTPUT pixel. No `joint=` argument:
    # the discs below are the joins (see the module docstring for why not
    # `joint="curve"`).
    draw.line(points, fill=fill, width=max(1, round(stroke)))

    # A disc on every vertex: round joins between the facets, and a round cap
    # at the start. Without the cap a square end on a two-pixel stroke reads
    # as a notch at favicon size.
    half = stroke / 2
    for x, y in points:
        draw.ellipse((x - half, y - half, x + half, y + half), fill=fill)

    # The terminal dot: "you are here". Larger than the stroke's half-width so
    # it reads as a point on the line rather than as the line's rounded end.
    end_x, end_y = points[-1]
    draw.ellipse(
        (end_x - dot_radius, end_y - dot_radius, end_x + dot_radius, end_y + dot_radius),
        fill=fill,
    )


def render_standard(size: int, mark_ratio: float = MARK_RATIO_STANDARD) -> Image.Image:
    """Rounded brand-coloured plate, transparent corners, mark on top. RGBA."""
    scale = size * SUPERSAMPLE
    image = Image.new("RGBA", (scale, scale), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle(
        (0, 0, scale - 1, scale - 1),
        radius=scale * CORNER_RADIUS_RATIO,
        fill=BRAND_COLOR,
    )
    draw_mark(draw, scale, mark_ratio, FOREGROUND_COLOR)
    return image.resize((size, size), Image.LANCZOS)


def render_maskable(size: int) -> Image.Image:
    """Full-bleed plate (the launcher applies its own mask), small mark. RGB.

    No alpha channel: every pixel is opaque by construction, and an RGB file
    makes it impossible to reintroduce transparent corners by accident.
    """
    scale = size * SUPERSAMPLE
    image = Image.new("RGB", (scale, scale), BRAND_COLOR)
    draw = ImageDraw.Draw(image)
    draw_mark(draw, scale, MARK_RATIO_MASKABLE, FOREGROUND_COLOR)
    return image.resize((size, size), Image.LANCZOS)


def render_badge(size: int) -> Image.Image:
    """Transparent canvas, white mark. RGBA — Android reads ONLY the alpha."""
    scale = size * SUPERSAMPLE
    image = Image.new("RGBA", (scale, scale), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw_mark(draw, scale, MARK_RATIO_BADGE, FOREGROUND_COLOR)
    return image.resize((size, size), Image.LANCZOS)


def render_apple_touch(size: int) -> Image.Image:
    """Rounded plate with the corners filled opaque. RGB — iOS renders alpha black."""
    standard = render_standard(size)
    canvas = Image.new("RGB", (size, size), BACKGROUND_COLOR)
    canvas.paste(standard, (0, 0), standard)
    return canvas


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
        print(f"wrote {path.relative_to(WEB_DIR)}  {image.size[0]}x{image.size[1]}  {image.mode}")

    # The .ico carries three frames because the contexts that still read it
    # differ: 16px is the browser tab, 32px the bookmark bar and taskbar, 48px
    # a Windows desktop shortcut. Each frame is rendered and downsampled
    # independently rather than letting the ICO encoder shrink one big frame —
    # the 16px stroke and dot survive the difference visibly. They also use the
    # tighter favicon crop, which `public/favicon.svg` matches.
    frames = [render_standard(size, MARK_RATIO_FAVICON) for size in FAVICON_ICO_SIZES]
    ico_path = PUBLIC_DIR / "favicon.ico"
    frames[-1].save(
        ico_path,
        format="ICO",
        sizes=[(size, size) for size in FAVICON_ICO_SIZES],
        append_images=frames[:-1],
    )
    print(
        f"wrote {ico_path.relative_to(WEB_DIR)}  "
        f"{'/'.join(str(size) for size in FAVICON_ICO_SIZES)}px frames"
    )

    print("\nfavicon.svg and icons/source.svg are hand-written vector — not regenerated.")


if __name__ == "__main__":
    main()
