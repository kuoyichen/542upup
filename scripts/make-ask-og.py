"""產生鎮妹給問嗎的分享預覽圖 ask-og.png（1200x630）。
用法：python3 scripts/make-ask-og.py <candidate-hero.jpeg> ask-og.png
照片取自 https://542upup.tw/candidate-hero.jpeg；字型用本機 ~/Library/Fonts 的 jf-openhuninn-2.1.ttf 與 NotoSansTC-VF.ttf。
"""
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

FONTS = Path.home() / 'Library/Fonts'
HUNINN = str(FONTS / 'jf-openhuninn-2.1.ttf')
NOTO = str(FONTS / 'NotoSansTC-VF.ttf')

W, H = 1200, 630
BG = '#fff8f4'
ACCENT = '#b44e2a'
FG = '#211d1d'
MUTED = '#6d625b'
HL_BG = '#fcea8b'
HL_FG = '#4a3b00'
PHOTO_W = 470


def noto(size, weight):
    f = ImageFont.truetype(NOTO, size)
    f.set_variation_by_axes([weight])
    return f


def main(photo_path, out_path):
    img = Image.new('RGB', (W, H), BG)
    d = ImageDraw.Draw(img)

    # 右側照片：臉約在原圖 (865, 260)，裁成 PHOTO_W x H 的比例
    ph = Image.open(photo_path).convert('RGB')
    crop_h = ph.height
    crop_w = round(crop_h * PHOTO_W / H)
    cx = 870
    left = max(0, min(ph.width - crop_w, cx - crop_w // 2))
    ph = ph.crop((left, 0, left + crop_w, crop_h)).resize((PHOTO_W, H), Image.LANCZOS)
    img.paste(ph, (W - PHOTO_W, 0))

    x = 64
    d.text((x, 52), '2026 草屯鎮長 政見發表會 會後活動', font=noto(28, 500), fill=MUTED)
    title = ImageFont.truetype(HUNINN, 132)
    d.text((x, 100), '鎮妹！', font=title, fill=ACCENT)
    d.text((x, 240), '給問嗎？', font=title, fill=ACCENT)
    d.text((x, 404), '把想問媛婷的事丟進留言瓶', font=noto(34, 700), fill=FG)

    pill_font = noto(30, 800)
    pill_text = '11/19（四）中午 12:00 直播抽題回答'
    tw = d.textlength(pill_text, font=pill_font)
    py = 470
    d.rounded_rectangle((x, py, x + tw + 44, py + 62), radius=31, fill=HL_BG)
    d.text((x + 22, py + 31), pill_text, font=pill_font, fill=HL_FG, anchor='lm')

    d.text((x, 566), 'ask.542upup.tw', font=noto(26, 500), fill=MUTED)

    right_edge = W - PHOTO_W - 24
    assert x + tw + 44 <= right_edge, f'pill too wide: {x + tw + 44} > {right_edge}'
    assert x + d.textlength('給問嗎？', font=title) <= right_edge, 'title too wide'

    img.save(out_path, optimize=True)
    print(out_path, img.size)


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
