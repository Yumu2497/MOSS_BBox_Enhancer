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


def _boxes_from_layout(data, width=None, height=None):
    """把完整布局 JSON（{"items": [...], "bbox_format": ...}）解析成像素框。

    源画布取 JSON 自己声明的 width/height，没声明就用目标画面尺寸；
    画布尺寸不同时按比例缩放，这样同一份提示词可以画到任意分辨率的图上。
    """
    items = data.get("items") if isinstance(data, dict) else data
    if not isinstance(items, list):
        return []

    meta_src = data if isinstance(data, dict) else {}
    coord = str(meta_src.get("bbox_coord_space") or "abs_centralized").lower()
    fmt = str(meta_src.get("bbox_format") or "yxyx").lower()
    centered = coord == "abs_centralized"
    yxyx = fmt == "yxyx"

    src_w = float(meta_src.get("width") or width or 0)
    src_h = float(meta_src.get("height") or height or 0)
    if src_w <= 0 or src_h <= 0:
        return []
    dst_w = float(width or src_w)
    dst_h = float(height or src_h)
    sx, sy = dst_w / src_w, dst_h / src_h

    off_x = src_w / 2.0 if centered else 0.0
    off_y = src_h / 2.0 if centered else 0.0

    boxes = []
    for item in items:
        if not isinstance(item, dict):
            continue
        bbox = item.get("bbox")
        if not isinstance(bbox, (list, tuple)) or len(bbox) != 4:
            continue
        try:
            a, b, c, d = (float(v) for v in bbox)
        except (TypeError, ValueError):
            continue
        if yxyx:
            ymin, xmin, ymax, xmax = a, b, c, d
        else:
            xmin, ymin, xmax, ymax = a, b, c, d
        if ymin > ymax:
            ymin, ymax = ymax, ymin
        if xmin > xmax:
            xmin, xmax = xmax, xmin

        is_text = item.get("label") == "text"
        box = {
            "x": (xmin + off_x) * sx,
            "y": (ymin + off_y) * sy,
            "width": (xmax - xmin) * sx,
            "height": (ymax - ymin) * sy,
            "metadata": {
                "type": "text" if is_text else "obj",
                "text": item.get("text", "") if is_text else "",
                "desc": item.get("caption", item.get("desc", "")),
            },
        }
        if isinstance(item.get("color"), str) and item["color"]:
            box["color"] = item["color"]
        boxes.append(box)
    return boxes


def _normalize(data, width=None, height=None):
    """接受单个框、框列表、帧嵌套列表、JSON 字符串或完整布局 JSON。"""
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
    # 完整布局 JSON：{"items": [{"bbox": [...]}, ...], ...}
    if isinstance(data, dict) and isinstance(data.get("items"), list):
        return _boxes_from_layout(data, width, height)
    # 只给了 items 数组（每项带 bbox 数组、没有 x/y）
    if (
        isinstance(data, list)
        and data
        and isinstance(data[0], dict)
        and isinstance(data[0].get("bbox"), (list, tuple))
        and "x" not in data[0]
    ):
        return _boxes_from_layout(data, width, height)
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


def _canvas_of(data):
    """取出数组开头声明的源画布尺寸；没有就返回 None。"""
    if data is None:
        return None
    if isinstance(data, str):
        try:
            data = json.loads(data)
        except Exception:
            return None
    if isinstance(data, dict):
        data = [data]
    if isinstance(data, list) and data and isinstance(data[0], list):
        data = data[0]
    for item in data if isinstance(data, list) else []:
        if not isinstance(item, dict):
            continue
        if "canvas_width" in item and "canvas_height" in item:
            try:
                return (float(item["canvas_width"]), float(item["canvas_height"]))
            except (TypeError, ValueError):
                return None
    return None


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


def draw_boxes(pil, boxes, line_width, show_index, show_label, fallback, offset=(0.0, 0.0)):
    overlay = Image.new("RGBA", pil.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    fs = max(10, round(pil.size[1] / 64))
    font = _font(fs)
    ox, oy = offset

    # 坐标已经是左上角原点（尺寸映射器负责把中心坐标转成像素），这里只按
    # 「源画布」和「实际画面」的尺寸差做一次平移，让 new_width 填多少都不影响位置。
    for index, box in enumerate(boxes):
        # 尺寸映射器会把完全出画的框置零，这里跳过，避免在主图中心画一个点
        if box["width"] <= 0 or box["height"] <= 0:
            continue
        color = _box_color(box, fallback)
        x1, y1 = box["x"] + ox, box["y"] + oy
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

    # 输入带 alpha 就原样保留（透明背景图）；纯 RGB / 灰度仍输出同样通道数
    if pil.mode == "RGBA":
        return Image.alpha_composite(pil, overlay)
    return Image.alpha_composite(pil.convert("RGBA"), overlay).convert("RGB")


class MOSS_DrawBBoxes:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "bboxes": ("*", {"forceInput": True,
                                 "tooltip": "边界框列表；也可以直接接完整布局 JSON（含 items）、items 数组或 JSON 字符串。颜色取每项的 color，没有就用兜底色。"}),
                "line_width": ("INT", {"default": 3, "min": 1, "max": 64, "step": 1}),
                "show_index": ("BOOLEAN", {"default": True, "tooltip": "在框左上角画序号标签。"}),
                "show_label": ("BOOLEAN", {"default": True, "tooltip": "在框内画描述 / 文字内容。"}),
                "fallback_color": ("COLOR", {"default": "#ff4a4a",
                                             "tooltip": "没设置颜色的框使用这个颜色。"}),
            },
            "optional": {
                "image": ("IMAGE", {"tooltip": "底图。不接时输出黑底，尺寸按框的最大范围自动给。"}),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("图像",)
    FUNCTION = "execute"
    CATEGORY = "MOSS_BBox_Enhancer"

    def execute(self, bboxes, line_width=3, show_index=True, show_label=True,
                fallback_color="#ff4a4a", image=None):
        canvas = _canvas_of(bboxes)
        # 完整布局 JSON 需要按图片尺寸换算，先把画面尺寸取出来
        img_w = img_h = None
        if image is not None:
            img_h, img_w = int(image.shape[1]), int(image.shape[2])
        boxes = _normalize(bboxes, img_w, img_h)
        fallback = _to_rgb(fallback_color, (255, 74, 74))
        width = int(line_width)

        # 没有框就原样返回，避免多走一次 uint8 量化
        if image is not None and not boxes:
            return (image,)

        if image is None:
            # 不接底图：输出黑底。有源画布尺寸就按它建，坐标不用平移
            if canvas:
                base_w, base_h = canvas
            else:
                base_w = max((b["x"] + b["width"] for b in boxes), default=640)
                base_h = max((b["y"] + b["height"] for b in boxes), default=640)
            base = Image.new("RGB", (max(64, int(base_w)), max(64, int(base_h))), (0, 0, 0))
            out = draw_boxes(base, boxes, width, show_index, show_label, fallback)
            arr = np.asarray(out, dtype=np.float32) / 255.0
            return (torch.from_numpy(arr).unsqueeze(0),)

        frames = []
        for i in range(image.shape[0]):
            arr = (image[i].detach().cpu().numpy() * 255).clip(0, 255).astype(np.uint8)
            # 保留 alpha：RGBA 进来就 RGBA 出去，透明的部分不会被 RGB 转换吃成黑色
            if arr.shape[-1] == 4:
                pil = Image.fromarray(arr, mode="RGBA")
            elif arr.shape[-1] == 3:
                pil = Image.fromarray(arr, mode="RGB")
            else:
                pil = Image.fromarray(arr[..., 0], mode="L")
            # 源画布和实际画面尺寸不同时，按差值把整组框平移回画面中心
            offset = (0.0, 0.0)
            if canvas:
                offset = ((pil.size[0] - canvas[0]) / 2.0, (pil.size[1] - canvas[1]) / 2.0)
            if i == 0:
                head = boxes[0] if boxes else None
                print(f"[MOSS Draw] 图像 {pil.size[0]}x{pil.size[1]}，源画布 {canvas}，"
                      f"平移 {offset}，收到 {len(boxes)} 个框；首个: {head}")
            frames.append(draw_boxes(pil, boxes, width, show_index, show_label, fallback, offset))

        out = np.stack([np.asarray(f, dtype=np.float32) / 255.0 for f in frames])
        return (torch.from_numpy(out).to(image.device),)


NODE_CLASS_MAPPINGS = {"MOSS_DrawBBoxes": MOSS_DrawBBoxes}
NODE_DISPLAY_NAME_MAPPINGS = {"MOSS_DrawBBoxes": "MOSS 绘制边界框"}
