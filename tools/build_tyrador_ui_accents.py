"""Build deterministic Tyrador top-bar accent textures.

The main shell is concept art, but interactive accents must line up exactly
with live SC2 controls. Pillow-generated sprites keep the energy cells and
hover frames pixel-perfect and repeatable.
"""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter


def save_pair(image: Image.Image, base: Path) -> None:
    base.parent.mkdir(parents=True, exist_ok=True)
    image.save(base.with_suffix(".png"), optimize=True)
    image.save(base.with_suffix(".dds"), pixel_format="DXT5")


def energy_fill() -> Image.Image:
    width, height = 32, 64
    image = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    pixels = image.load()

    for y in range(height):
        vertical = y / (height - 1)
        pulse = 1.0 - abs(vertical - 0.48) * 0.5
        for x in range(width):
            edge = min(x, width - 1 - x)
            alpha_edge = min(1.0, max(0.0, (edge - 1) / 5.0))
            center = 1.0 - abs((x / (width - 1)) - 0.5) * 1.15
            r = round(155 + 75 * center * pulse)
            g = round(58 + 115 * center * pulse)
            b = 255
            a = round((95 + 150 * center) * alpha_edge)
            if y % 7 == 0:
                a = round(a * 0.72)
            pixels[x, y] = (r, g, b, max(0, min(255, a)))

    glow = image.filter(ImageFilter.GaussianBlur(2.2))
    result = Image.alpha_composite(glow, image)
    draw = ImageDraw.Draw(result, "RGBA")
    draw.line((6, 2, width - 7, 2), fill=(225, 248, 255, 220), width=2)
    draw.line((4, height - 3, width - 5, height - 3), fill=(85, 220, 255, 100), width=1)
    return result


def button_hover() -> Image.Image:
    size = 128
    glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow, "RGBA")
    outline = [(16, 4), (112, 4), (124, 16), (124, 112), (112, 124),
               (16, 124), (4, 112), (4, 16), (16, 4)]
    glow_draw.line(outline, fill=(112, 58, 255, 230), width=10, joint="curve")
    glow_draw.line([(29, 8), (99, 8)], fill=(66, 228, 255, 255), width=6)
    glow_draw.line([(29, 120), (99, 120)], fill=(178, 103, 255, 220), width=5)
    blurred = glow.filter(ImageFilter.GaussianBlur(8))

    crisp = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(crisp, "RGBA")
    draw.line(outline, fill=(189, 121, 255, 235), width=4, joint="curve")
    draw.line([(24, 7), (104, 7)], fill=(126, 245, 255, 255), width=3)
    draw.line([(12, 24), (12, 104)], fill=(116, 77, 220, 190), width=3)
    draw.line([(116, 24), (116, 104)], fill=(116, 77, 220, 190), width=3)
    return Image.alpha_composite(blurred, crisp)


def _button_octagon(inset: int = 4) -> list[tuple[int, int]]:
    size = 128
    bevel = 13
    return [
        (inset + bevel, inset),
        (size - inset - bevel, inset),
        (size - inset, inset + bevel),
        (size - inset, size - inset - bevel),
        (size - inset - bevel, size - inset),
        (inset + bevel, size - inset),
        (inset, size - inset - bevel),
        (inset, inset + bevel),
    ]


def button_backing() -> Image.Image:
    """Opaque recessed well placed below the live command icon."""
    size = 128
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).polygon(_button_octagon(5), fill=255)

    backing = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    pixels = backing.load()
    mask_pixels = mask.load()
    for y in range(size):
        vertical = y / (size - 1)
        for x in range(size):
            if not mask_pixels[x, y]:
                continue
            nx = abs((x / (size - 1)) - 0.5) * 2.0
            ny = abs((y / (size - 1)) - 0.5) * 2.0
            vignette = min(1.0, (nx * nx + ny * ny) * 0.42)
            top_light = max(0.0, 1.0 - vertical * 2.0)
            pixels[x, y] = (
                round(13 + 18 * top_light - 6 * vignette),
                round(10 + 10 * top_light - 4 * vignette),
                round(24 + 30 * top_light - 7 * vignette),
                252,
            )

    draw = ImageDraw.Draw(backing, "RGBA")
    draw.line(_button_octagon(8) + [_button_octagon(8)[0]], fill=(60, 38, 88, 230), width=4, joint="curve")
    draw.line([(24, 11), (104, 11)], fill=(48, 139, 165, 125), width=2)
    return backing


def button_frame() -> Image.Image:
    """Continuous Tyrador bezel placed above the live command icon."""
    size = 128
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image, "RGBA")
    outer = _button_octagon(3)
    inner = _button_octagon(9)
    draw.line(outer + [outer[0]], fill=(42, 48, 57, 245), width=7, joint="curve")
    draw.line(inner + [inner[0]], fill=(142, 93, 177, 230), width=4, joint="curve")
    draw.line([(22, 6), (106, 6)], fill=(148, 235, 255, 220), width=3)
    draw.line([(24, 121), (104, 121)], fill=(72, 40, 98, 220), width=3)
    return image


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output_dir", type=Path)
    args = parser.parse_args()
    save_pair(energy_fill(), args.output_dir / "tyrador_energy_fill")
    save_pair(button_backing(), args.output_dir / "tyrador_button_backing")
    save_pair(button_frame(), args.output_dir / "tyrador_button_frame")
    save_pair(button_hover(), args.output_dir / "tyrador_button_hover")
    print(f"Wrote Tyrador accents to {args.output_dir}")


if __name__ == "__main__":
    main()
