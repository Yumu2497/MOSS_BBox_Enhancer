import json
import os

import numpy as np
import torch
from PIL import Image, ImageColor, ImageDraw, ImageFont

# 默认字体不带中文，按平台找一个能显示中文的系统字体
_FONT_CANDIDATES = (
    "C:/Windows/Fonts/msyh.ttc",
    "C:/Windows/Fonts/msyhl.ttc",
    "C:/Windows/Fonts/simhei.ttf",
    "C:/Windows/Fonts/simsun.ttc",
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
)
_font_cache = {}


def _font(size):
    size = int(size)
    if size in _font_cache:
        return _font_cache[size]
    for path in _FONT_CANDIDATES:
        try:
            if os.path.isfile(path):
                font = ImageFont.truetype(path, size)
                _font_cache[size] = font
                return font
        except Exception:
            continue
    try:
        font = ImageFont.load_default(size)
    except Exception:
        font = ImageFont.load_default()
    _font_cache[size] = font
    return font


def _to_rgb(value, fallback):
    if isinstance(value, (list, tuple)) and len(value) >= 3:
        try:
            return tuple(int(max(0, min(255, v))) for v in value[:3])
        except (TypeError, ValueError):
            return fallback
    if isinstance(value, str) and value.strip():
        try:
            return ImageColor.getrgb(value.strip())[:3]
        except Exception:
            return fallback
    return fallback


def _meta(box):
    meta = box.get("metadata")
    return meta if isinstance(meta, dict) else {}


def _box_color(box, fallback):
    # 只用框自己的 color；调色板属于构图信息，不参与描边
    return _to_rgb(box.get("color"), fallback)


def _normalize(data):
    """接受单个框、框列表、帧嵌套列表（[[...]]）或 JSON 字符串。"""
    if data is None:
        return []
    if isinstance(data, str):
        text = data.strip()
        if not text:
            return []
        try:
            data = json.loads(text)
        except Exception:
            return []
    if isinstance(data, dict):
        data = [data]
    if isinstance(data, list) and data and isinstance(data[0], list):
        data = data[0]

    boxes = []
    for item in data if isinstance(data, list) else []:
        if not isinstance(item, dict):
            continue
        try:
            x = float(item.get("x", 0))
            y = float(item.get("y", 0))
            w = float(item.get("width", 0))
            h = float(item.get("height", 0))
        except (TypeError, ValueError):
            continue
        if w < 0:
            x, w = x + w, -w
        if h < 0:
            y, h = y + h, -h
        boxes.append({**item, "x": x, "y": y, "width": w, "height": h})
    return boxes


def _readable(rgb):
    return (0, 0, 0) if (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) > 140 else (255, 255, 255)


def _one_line(text):
    """把任意文本压成单行：换行、制表符、连续空格统一成一个空格。"""
    return " ".join(str(text or "").split())


def _fit_text(draw, text, font, max_width):
    """按宽度截断并补省略号；量不了长度时退回原文本，不让绘图崩掉。"""
    if not text:
        return ""
    try:
        if draw.textlength(text, font=font) <= max_width:
            return text
        while text and draw.textlength(text + "…", font=font) > max_width:
            text = text[:-1]
        return text + "…" if text else ""
    except Exception:
        return text[: max(1, int(max_width // 8))]


def draw_boxes(pil, boxes, line_width, show_index, show_label, fallback):
    overlay = Image.new("RGBA", pil.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    fs = max(10, round(pil.size[1] / 64))
    font = _font(fs)

    for index, box in enumerate(boxes):
        color = _box_color(box, fallback)
        x1, y1 = box["x"], box["y"]
        x2, y2 = x1 + box["width"], y1 + box["height"]

        draw.rectangle([x1, y1, x2, y2], outline=color + (255,), width=line_width)

        if show_index:
            tag = str(index + 1).zfill(2)
            tag_w = draw.textlength(tag, font=font)
            draw.rectangle([x1, y1, x1 + tag_w + 8, y1 + fs + 6], fill=color + (255,))
            draw.text((x1 + 4, y1 + 2), tag, fill=_readable(color) + (255,), font=font)

        meta = _meta(box)
        # 多行文本（文本框常见）PIL 量不了长度，先压成单行
        label = _one_line(meta.get("text") or meta.get("desc") or "")
        label_y = y1 + fs + 8
        if show_label and label and label_y + fs <= y2:
            max_w = x2 - x1 - 12
            if max_w > 8:
                label = _fit_text(draw, label, font, max_w)
                if label:
                    draw.text((x1 + 6, label_y), label, fill=color + (255,), font=font)

    return Image.alpha_composite(pil.convert("RGBA"), overlay).convert("RGB")


class MOSS_DrawBBoxes:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "bboxes": ("*", {"forceInput": True,
                                 "tooltip": "边界框列表。描边颜色取每项的 color，没有就用兜底色；不读调色板（palette）。"}),
                "line_width": ("INT", {"default": 3, "min": 1, "max": 64, "step": 1}),
                "show_index": ("BOOLEAN", {"default": True, "tooltip": "在框左上角画序号标签。"}),
                "show_label": ("BOOLEAN", {"default": True, "tooltip": "在框内画描述 / 文字内容。"}),
                "fallback_color": ("COLOR", {"default": "#ff4a4a",
                                             "tooltip": "没设置颜色的框使用这个颜色。"}),
            },
            "optional": {
                "image": ("IMAGE", {"tooltip": "底图。不接时按框的最大范围生成一张深灰底图。"}),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("图像",)
    FUNCTION = "execute"
    CATEGORY = "MOSS_BBox_Enhancer"

    def execute(self, bboxes, line_width=3, show_index=True, show_label=True,
                fallback_color="#ff4a4a", image=None):
        boxes = _normalize(bboxes)
        fallback = _to_rgb(fallback_color, (255, 74, 74))
        width = int(line_width)

        # 没有框就原样返回，避免多走一次 uint8 量化
        if image is not None and not boxes:
            return (image,)

        if image is None:
            max_w = max((b["x"] + b["width"] for b in boxes), default=640)
            max_h = max((b["y"] + b["height"] for b in boxes), default=640)
            base = Image.new("RGB", (max(64, int(max_w)), max(64, int(max_h))), (32, 32, 32))
            out = draw_boxes(base, boxes, width, show_index, show_label, fallback)
            arr = np.asarray(out, dtype=np.float32) / 255.0
            return (torch.from_numpy(arr).unsqueeze(0),)

        frames = []
        for i in range(image.shape[0]):
            arr = (image[i].detach().cpu().numpy() * 255).clip(0, 255).astype(np.uint8)
            pil = Image.fromarray(arr[..., :3] if arr.shape[-1] >= 3 else arr)
            frames.append(draw_boxes(pil, boxes, width, show_index, show_label, fallback))

        out = np.stack([np.asarray(f, dtype=np.float32) / 255.0 for f in frames])
        return (torch.from_numpy(out).to(image.device),)


NODE_CLASS_MAPPINGS = {"MOSS_DrawBBoxes": MOSS_DrawBBoxes}
NODE_DISPLAY_NAME_MAPPINGS = {"MOSS_DrawBBoxes": "MOSS 绘制边界框"}
