#!/usr/bin/env python3
"""tools/logo.png 를 리소스팩 글리프(font/glyph_E1.png)로 만듭니다.

마인크래프트 베드락은 font/glyph_E1.png 의 16x16 칸을 문자 U+E100 ~ U+E1FF 로 보여줍니다.
로고를 가로 2칸으로 잘라 넣고, 화면 제목(title)에 그 문자들(U+E100, U+E101)을 쓰면 로고 그림이 나옵니다.
화면 크기: 베드락은 그림 픽셀 1개를 제목(title)에서 약 14픽셀, 부제목(subtitle)에서 약 6픽셀로 그림.
그래서 로고는 부제목에 넣고, 전체 폭 128픽셀(64 x 2칸) → 화면에서 약 770픽셀(1080p 화면 폭의 약 40%).
로고를 바꾸려면 tools/logo.png 를 바꾸고 이 파일을 다시 실행하세요. (pip install pillow 필요)
"""
import os
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "logo.png")
OUT = os.path.join(HERE, "..", "resource_pack", "font", "glyph_E1.png")
CELL = 64  # 칸 하나의 픽셀 수 (이게 곧 화면 크기를 정함)
COLS, ROWS = 2, 1


def main():
    logo = Image.open(SRC).convert("RGBA")
    # 로고를 가로 8칸 x 세로 2칸 크기 안에 비율 유지해서 맞춤 (가운데 정렬)
    area_w, area_h = COLS * CELL, ROWS * CELL
    scale = min(area_w / logo.width, area_h / logo.height)
    resized = logo.resize((round(logo.width * scale), round(logo.height * scale)), Image.LANCZOS)
    area = Image.new("RGBA", (area_w, area_h), (0, 0, 0, 0))
    area.paste(resized, ((area_w - resized.width) // 2, (area_h - resized.height) // 2), resized)

    sheet = Image.new("RGBA", (16 * CELL, 16 * CELL), (0, 0, 0, 0))
    for row in range(ROWS):
        for col in range(COLS):
            cell = area.crop((col * CELL, row * CELL, (col + 1) * CELL, (row + 1) * CELL))
            # 글자 폭이 투명 부분만큼 줄어들면 로고 조각이 어긋나므로, 양 끝에 거의 안 보이는 점을 찍어 폭을 꽉 채움
            cell.putpixel((0, CELL - 1), (0, 0, 0, 2))
            cell.putpixel((CELL - 1, CELL - 1), (0, 0, 0, 2))
            # (작은 칸에서 로고 선이 뭉개지지 않게 축소는 위에서 LANCZOS 로 한 번만 함)
            sheet.paste(cell, (col * CELL, row * CELL))
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    sheet.save(OUT, optimize=True)
    print("저장:", os.path.normpath(OUT), sheet.size)


if __name__ == "__main__":
    main()
