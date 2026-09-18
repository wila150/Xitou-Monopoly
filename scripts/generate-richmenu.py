#!/usr/bin/env python3
"""產生圖文選單圖片（2500x1686px，符合 LINE Rich Menu 規格）。
配色取自「森呼吸．永續漫遊」主視覺：米黃底、森林綠、深藍。
輸出到 assets/richmenu.png，供 scripts/setup-rich-menu.js 上傳到 LINE 使用。

如果要調整文字/配色/按鈕內容，改這個檔案後重新執行：
    python3 scripts/generate-richmenu.py
"""
from PIL import Image, ImageDraw, ImageFont
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
LOGO_PATH = os.path.join(ROOT, "assets", "brand", "logo.jpg")
OUT_PATH = os.path.join(ROOT, "assets", "richmenu.png")

W, H = 2500, 1686
HEADER_H = 258  # 與 setup-rich-menu.js 一致：(1686 - 258) / 3 = 476

BG = (250, 238, 178)
GREEN = (90, 168, 84)
GREEN_DARK = (58, 122, 64)
NAVY = (27, 58, 107)
CREAM_TILE = (255, 247, 214)
EMERGENCY_TILE = (255, 226, 220)
EMERGENCY_DARK = (176, 42, 32)

FONT_PATH = "/System/Library/Fonts/STHeiti Medium.ttc"


def font(size):
    return ImageFont.truetype(FONT_PATH, size, index=0)


def main():
    img = Image.new("RGB", (W, H), BG)
    draw = ImageDraw.Draw(img)

    # ---- Header ----
    draw.rectangle([0, 0, W, HEADER_H], fill=(255, 250, 224))
    draw.line([0, HEADER_H, W, HEADER_H], fill=GREEN_DARK, width=6)

    logo = Image.open(LOGO_PATH).convert("RGB")
    logo_h = 170
    logo_w = int(logo.width * logo_h / logo.height)
    img.paste(logo.resize((logo_w, logo_h), Image.LANCZOS), (60, (HEADER_H - logo_h) // 2))

    title_font = font(92)
    subtitle_font = font(40)
    title_text = "森呼吸．永續漫遊"
    tb = draw.textbbox((0, 0), title_text, font=title_font)
    tw = tb[2] - tb[0]
    title_x = W - tw - 90
    draw.text((title_x, 55), title_text, font=title_font, fill=GREEN_DARK)
    sub_text = "溪頭闖關系統"
    sb = draw.textbbox((0, 0), sub_text, font=subtitle_font)
    draw.text((W - (sb[2] - sb[0]) - 90, 165), sub_text, font=subtitle_font, fill=NAVY)

    # ---- Buttons grid (2 欄 x 3 列) ----
    grid_top = HEADER_H
    grid_h = H - HEADER_H
    col_w = W // 2
    row_h = grid_h // 3
    PAD = 22

    def rounded_tile(x0, y0, x1, y1, fill=CREAM_TILE, outline=GREEN_DARK):
        draw.rounded_rectangle(
            [x0 + PAD, y0 + PAD, x1 - PAD, y1 - PAD],
            radius=36, fill=fill, outline=outline, width=4,
        )

    # (col, row, 按鈕文字＝實際會送出的指令內容, 說明文字)
    # 最後一顆是緊急聯絡，用紅色底跟其他按鈕明顯區隔
    tiles = [
        (0, 0, "目前關卡", "查詢這一關在哪裡", False),
        (1, 0, "闖關進度", "已完成幾關、耗時多久", False),
        (0, 1, "排行榜", "看看目前排名", False),
        (1, 1, "報到", "第一次使用，從這裡開始", False),
        (0, 2, "使用說明", "依您的身分列出可用指令", False),
        (1, 2, "緊急聯絡", "受傷、迷路、危險，立刻通知小編", True),
    ]

    label_font = font(88)
    desc_font = font(42)

    for col, row, label, desc, urgent in tiles:
        x0, y0 = col * col_w, grid_top + row * row_h
        x1, y1 = x0 + col_w, y0 + row_h
        if urgent:
            rounded_tile(x0, y0, x1, y1, fill=EMERGENCY_TILE, outline=EMERGENCY_DARK)
        else:
            rounded_tile(x0, y0, x1, y1)
        label_color = EMERGENCY_DARK if urgent else NAVY
        desc_color = EMERGENCY_DARK if urgent else GREEN_DARK

        cx, cy = (x0 + x1) // 2, (y0 + y1) // 2
        lb = draw.textbbox((0, 0), label, font=label_font)
        lw, lh = lb[2] - lb[0], lb[3] - lb[1]
        draw.text((cx - lw / 2, cy - lh / 2 - 40), label, font=label_font, fill=label_color)

        db = draw.textbbox((0, 0), desc, font=desc_font)
        dw, dh = db[2] - db[0], db[3] - db[1]
        draw.text((cx - dw / 2, cy + lh / 2 + 10), desc, font=desc_font, fill=desc_color)

    img.save(OUT_PATH)
    print(f"已產生 {OUT_PATH}（{img.size[0]}x{img.size[1]}）")


if __name__ == "__main__":
    main()
