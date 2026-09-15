"""Ícone do app e selos de não lidas do Windows, desenhados com o PIL.

Gera em `desktop/build/`:
- `icon.png` (1024×1024): o pulso de três barras da marca, laranja #ff7a29 →
  roxo #944bc2, sobre grafite #17171a com cantos arredondados. `make-icons.mjs`
  deriva o .icns e o .ico daqui.
- `badge/1.png` … `badge/10.png` (32×32): o número em branco sobre vermelho,
  para `setOverlayIcon` no Windows (10 é "9+").
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent / "build"
SIZE = 1024
GRAPHITE = (23, 23, 26, 255)
ORANGE = (255, 122, 41)
PURPLE = (148, 75, 194)
RED = (229, 72, 77, 255)


def lerp(a: tuple[int, int, int], b: tuple[int, int, int], t: float) -> tuple[int, int, int]:
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))  # type: ignore[return-value]


def pill(width: int, height: int, color_at) -> Image.Image:
    """Barra de cantos totalmente redondos, colorida linha a linha de cima para baixo."""
    bar = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(bar)
    for y in range(height):
        r, g, b = color_at(y / max(1, height - 1))
        draw.line([(0, y), (width, y)], fill=(r, g, b, 255))
    mask = Image.new("L", (width, height), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, width - 1, height - 1], radius=width // 2, fill=255)
    bar.putalpha(mask)
    return bar


def make_icon() -> None:
    icon = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(icon)
    draw.rounded_rectangle([0, 0, SIZE - 1, SIZE - 1], radius=int(SIZE * 0.225), fill=GRAPHITE)

    area = SIZE * 0.54
    bar_w = int(SIZE * 0.125)
    gap = int(SIZE * 0.085)
    heights = [0.62, 1.0, 0.8]
    colors = [
        lambda _t: ORANGE,
        lambda t: lerp(ORANGE, PURPLE, t),
        lambda _t: PURPLE,
    ]
    total_w = 3 * bar_w + 2 * gap
    x0 = (SIZE - total_w) // 2
    bottom = int(SIZE / 2 + area / 2)
    for i, (h, color) in enumerate(zip(heights, colors)):
        bar_h = int(area * h)
        x = x0 + i * (bar_w + gap)
        y = bottom - bar_h
        bar = pill(bar_w, bar_h, color)
        icon.alpha_composite(bar, (x, y))

    ROOT.mkdir(parents=True, exist_ok=True)
    icon.save(ROOT / "icon.png")
    icon.resize((512, 512), Image.LANCZOS).save(ROOT / "icon-512.png")


def font(size: int) -> ImageFont.ImageFont | ImageFont.FreeTypeFont:
    for candidate in (
        "/usr/share/fonts/abattis-cantarell-fonts/Cantarell-Bold.otf",
        "/usr/share/fonts/liberation-sans-fonts/LiberationSans-Bold.ttf",
        "/usr/share/fonts/dejavu-sans-fonts/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "C:/Windows/Fonts/arialbd.ttf",
    ):
        try:
            return ImageFont.truetype(candidate, size)
        except OSError:
            continue
    return ImageFont.load_default()


def make_badges() -> None:
    folder = ROOT / "badge"
    folder.mkdir(parents=True, exist_ok=True)
    # Desenha em 4× e reduz, para o círculo e o número saírem lisos em 32px.
    scale = 4
    size = 32 * scale
    for n in range(1, 11):
        label = "9+" if n == 10 else str(n)
        badge = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        draw = ImageDraw.Draw(badge)
        draw.ellipse([0, 0, size - 1, size - 1], fill=RED)
        f = font(int(size * (0.58 if len(label) == 1 else 0.5)))
        left, top, right, bottom = draw.textbbox((0, 0), label, font=f)
        draw.text(
            ((size - (right - left)) / 2 - left, (size - (bottom - top)) / 2 - top - size * 0.02),
            label,
            font=f,
            fill=(255, 255, 255, 255),
        )
        badge.resize((32, 32), Image.LANCZOS).save(folder / f"{n}.png")


if __name__ == "__main__":
    make_icon()
    make_badges()
    print(f"ícone e selos em {ROOT}")
