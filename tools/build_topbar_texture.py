"""Prepare a transparent topbar concept image for use by SC2 layouts.

The source may contain a large transparent canvas or faint generation noise.
This tool finds the substantial horizontal artwork, crops it, fits it inside a
power-of-two canvas, and writes both a review PNG and a DXT5 DDS game asset.
"""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image


def substantial_bbox(image: Image.Image, alpha_threshold: int = 24) -> tuple[int, int, int, int]:
    alpha = image.getchannel("A")
    width, height = image.size
    mask = alpha.point(lambda value: 255 if value >= alpha_threshold else 0)
    pixels = mask.load()

    min_row_pixels = max(8, round(width * 0.05))
    rows = [
        y for y in range(height)
        if sum(1 for x in range(width) if pixels[x, y]) >= min_row_pixels
    ]
    if not rows:
        bbox = mask.getbbox()
        if bbox is None:
            raise ValueError("The source image has no visible pixels.")
        return bbox

    top, bottom = rows[0], rows[-1] + 1
    active_height = bottom - top
    min_column_pixels = max(3, round(active_height * 0.05))
    columns = [
        x for x in range(width)
        if sum(1 for y in range(top, bottom) if pixels[x, y]) >= min_column_pixels
    ]
    if not columns:
        return 0, top, width, bottom
    return columns[0], top, columns[-1] + 1, bottom


def build_texture(source: Path, output_png: Path, output_dds: Path,
                  canvas_width: int, canvas_height: int, padding: int) -> None:
    image = Image.open(source).convert("RGBA")
    left, top, right, bottom = substantial_bbox(image)
    content = image.crop((left, top, right, bottom))

    available_width = canvas_width - 2 * padding
    available_height = canvas_height - 2 * padding
    scale = min(available_width / content.width, available_height / content.height)
    fitted_size = (
        max(1, round(content.width * scale)),
        max(1, round(content.height * scale)),
    )
    content = content.resize(fitted_size, Image.Resampling.LANCZOS)

    canvas = Image.new("RGBA", (canvas_width, canvas_height), (0, 0, 0, 0))
    position = (
        (canvas_width - content.width) // 2,
        (canvas_height - content.height) // 2,
    )
    canvas.alpha_composite(content, position)

    output_png.parent.mkdir(parents=True, exist_ok=True)
    output_dds.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(output_png, optimize=True)
    canvas.save(output_dds, pixel_format="DXT5")

    print(f"source crop: {left},{top} to {right},{bottom} ({right-left}x{bottom-top})")
    print(f"fitted content: {content.width}x{content.height} at {position}")
    print(f"PNG: {output_png}")
    print(f"DDS: {output_dds}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("output_png", type=Path)
    parser.add_argument("output_dds", type=Path)
    parser.add_argument("--width", type=int, default=1024)
    parser.add_argument("--height", type=int, default=128)
    parser.add_argument("--padding", type=int, default=2)
    args = parser.parse_args()
    build_texture(
        args.source,
        args.output_png,
        args.output_dds,
        args.width,
        args.height,
        args.padding,
    )


if __name__ == "__main__":
    main()
