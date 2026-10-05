#!/usr/bin/env python3
"""tools/logo.png 를 리소스팩 글리프(font/glyph_E1.png)로 만듭니다.

마인크래프트 베드락은 font/glyph_E1.png 의 16x16 칸을 문자 U+E100 ~ U+E1FF 로 보여줍니다.
로고 전체를 칸 하나(U+E100)에 넣습니다. 여러 칸으로 나누면 글자 사이 틈 때문에 로고가 갈라져 보임.
화면 크기: 부제목(subtitle) 줄에서 그림 픽셀 1개가 약 7~8 화면 픽셀 → 폭 128픽셀 로고가 1080p 화면 폭의 약 절반.
로고를 바꾸려면 tools/logo.png 를 바꾸고 이 파일을 다시 실행하세요. (pip install pillow 필요)
"""
import os
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "logo.png")
OUT = os.path.join(HERE, "..", "resource_pack", "font", "glyph_E1.png")
CELL = 128  # 칸 하나의 픽셀 수 = 로고 폭 (이게 곧 화면 크기를 정함)
# 칸 안에서 로고를 놓을 높이 (위에서부터 픽셀). 칸 가운데(약 48)보다 작을수록 화면에서 위로 올라감
TOP = 18


def main():
    logo = Image.open(SRC).convert("RGBA")
    scale = CELL / logo.width
    resized = logo.resize((CELL, round(logo.height * scale)), Image.LANCZOS)
    # 반투명 테두리 픽셀이 지저분하게(깨져) 보이므로 완전히 보이거나 완전히 투명하게만
    pixels = resized.load()
    for y in range(resized.height):
        for x in range(resized.width):
            r, g, b, a = pixels[x, y]
            pixels[x, y] = (r, g, b, 255) if a >= 128 else (0, 0, 0, 0)

    cell = Image.new("RGBA", (CELL, CELL), (0, 0, 0, 0))
    cell.paste(resized, (0, TOP))
    sheet = Image.new("RGBA", (16 * CELL, 16 * CELL), (0, 0, 0, 0))
    sheet.paste(cell, (0, 0))
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    sheet.save(OUT, optimize=True)
    print("저장:", os.path.normpath(OUT), sheet.size)


if __name__ == "__main__":
    main()
