import json
import math


def sanitize_items(items):
    """按官方 schema 规范化条目（就地修改）。与 MOSS_JSON_Importer 里的同名函数保持一致，
    这里单独保留一份，避免两个节点模块互相依赖。
    """
    for item in items or []:
        if not isinstance(item, dict):
            continue
        for key in [k for k in item if k.startswith("_")]:
            item.pop(key, None)
        for key in ("tags", "palette"):
            if isinstance(item.get(key), list) and not item[key]:
                item.pop(key, None)
        if item.get("label") != "text":
            item.pop("text", None)
    return items


def normalize_layout(data, fallback_w=None, fallback_h=None):
    """把官方"草稿"格式统一成模型格式（与 MOSS_JSON_Importer 中的同名函数保持一致，
    这里单独保留一份，避免两个节点模块互相依赖）。

    草稿： bbox_coord_space="abs"             + bbox_format="xyxy"（左上角原点，带 width/height）
    模型： bbox_coord_space="abs_centralized" + bbox_format="yxyx"（画布中心原点）
    """
    if not isinstance(data, dict):
        return data, None, None

    width = data.get("width") or fallback_w
    height = data.get("height") or fallback_h

    coord = str(data.get("bbox_coord_space") or "abs_centralized").lower()
    fmt = str(data.get("bbox_format") or "yxyx").lower()
    centered = coord == "abs_centralized"
    yxyx = fmt == "yxyx"

    if centered and yxyx:
        return data, width, height
    if not centered and not (width and height):
        return data, width, height

    for item in data.get("items") or []:
        if not isinstance(item, dict):
            continue
        bbox = item.get("bbox")
        if not (isinstance(bbox, (list, tuple)) and len(bbox) == 4):
            continue
        a, b, c, d = bbox
        if yxyx:
            ymin, xmin, ymax, xmax = a, b, c, d
        else:
            xmin, ymin, xmax, ymax = a, b, c, d
        if not centered:
            xmin -= width / 2
            xmax -= width / 2
            ymin -= height / 2
            ymax -= height / 2
        item["bbox"] = [int(round(ymin)), int(round(xmin)), int(round(ymax)), int(round(xmax))]

    data["bbox_coord_space"] = "abs_centralized"
    data["bbox_format"] = "yxyx"
    # width / height 保留，由调用方决定是否更新/剥离
    return data, width, height


class MOSS_BBox_Resizer:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "layout_json": ("STRING", {"multiline": True, "default": "", "tooltip": "输入的 MOSS JSON 提示词数据。"}),
                "auto_guess_old_size": ("BOOLEAN", {"default": False, "tooltip": "开启后，自动根据 JSON 边界推测原尺寸，并禁用下方的手动旧尺寸输入框。"}),
                "guess_ratio": (["自动(不限定)", "1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9"], {"default": "1:1", "tooltip": "推测比例的基准。若已知原图大概是几比几，选择对应比例推测最准确。"}),
                "old_width": ("INT", {"default": 1024, "min": 64, "max": 16384, "step": 16, "tooltip": "【原图宽度】JSON数据最初生成时的画布宽度。若开启了自动猜测，此处会被锁定。"}),
                "old_height": ("INT", {"default": 1024, "min": 64, "max": 16384, "step": 16, "tooltip": "【原图高度】JSON数据最初生成时的画布高度。若开启了自动猜测，此处会被锁定。"}),
                "new_width": ("INT", {"default": 1088, "min": 64, "max": 16384, "step": 16, "tooltip": "⚠️ 目标宽度：请务必与【创建边界框】节点或【Empty Latent】节点的宽保持一致！"}),
                "new_height": ("INT", {"default": 1920, "min": 64, "max": 16384, "step": 16, "tooltip": "⚠️ 目标高度：请务必与【创建边界框】节点或【Empty Latent】节点的高保持一致！"}),
                "resize_mode": (["保持固定坐标(不缩放)", "保持长宽比(等比缩放)", "暴力拉伸(铺满画布)"], {"default": "保持长宽比(等比缩放)", "tooltip": "决定坐标的缩放策略：固定坐标不缩放；保持比例防变形；暴力拉伸铺满全屏。"}),
                "scale_factor": ("FLOAT", {"default": 1.0, "min": 0.1, "max": 5.0, "step": 0.05, "tooltip": "在基础缩放上额外叠加的倍率。>1.0 放大，<1.0 缩小留白。"}),
            }
        }

    RETURN_TYPES = ("ARRAY", "STRING", "INT", "INT", "ARRAY")
    RETURN_NAMES = ("元素数组", "映射后JSON", "目标宽度", "目标高度", "边界框")
    OUTPUT_NODE = True
    FUNCTION = "resize_bbox"
    CATEGORY = "MOSS_BBox_Enhancer"

    @staticmethod
    def _to_official_elements(items, width, height):
        elements = []
        for item in items:
            if not isinstance(item, dict):
                continue
            bbox = item.get("bbox")
            if not isinstance(bbox, (list, tuple)) or len(bbox) != 4:
                continue
            ymin, xmin, ymax, xmax = bbox
            element = {
                "type": "text" if item.get("label") == "text" else "obj",
                "bbox": [
                    max(0, min(1000, round((ymin + height / 2) * 1000 / height))),
                    max(0, min(1000, round((xmin + width / 2) * 1000 / width))),
                    max(0, min(1000, round((ymax + height / 2) * 1000 / height))),
                    max(0, min(1000, round((xmax + width / 2) * 1000 / width))),
                ],
                "desc": item.get("caption", item.get("desc", "")),
            }
            if element["type"] == "text":
                element["text"] = item.get("text", "")
            palette = item.get("palette", item.get("color_palette", []))
            if isinstance(palette, list) and palette:
                element["color_palette"] = palette
            tags = item.get("tags", [])
            if isinstance(tags, list) and tags:
                element["tags"] = tags
            elements.append(element)
        return elements

    @staticmethod
    def _to_pixel_boxes(items, width, height):
        """映射后的像素框：给官方「创建边界框」或「MOSS 绘制边界框」用。

        每个框都带 canvas_width / canvas_height，下游据此知道这些像素坐标按多大的
        画布算出——画面尺寸不同时按差值平移即可。不单独放一个数组项，否则官方
        CreateBoundingBoxes 会因为它「既不是框、也没有 bbox 字段」直接报错。
        """
        half_w, half_h = width / 2, height / 2
        boxes = []
        for item in items:
            if not isinstance(item, dict):
                continue
            bbox = item.get("bbox")
            if not isinstance(bbox, (list, tuple)) or len(bbox) != 4:
                continue
            ymin, xmin, ymax, xmax = bbox
            x1, y1 = xmin + half_w, ymin + half_h
            x2, y2 = xmax + half_w, ymax + half_h
            is_text = item.get("label") == "text"

            # 官方 CreateBoundingBoxes 只认画布内的左上角坐标（会按 width/height 归一化），
            # 负值或超出画布的框会让它算错位置。这里按画布求交集，只保留可见部分；
            # 完全在画布外的框留零尺寸占位，保证序号和 items 一一对应。
            vx1, vy1 = max(0.0, x1), max(0.0, y1)
            vx2, vy2 = min(float(width), x2), min(float(height), y2)
            if vx2 <= vx1 or vy2 <= vy1:
                vx1 = vy1 = vx2 = vy2 = 0.0

            box = {
                "x": round(vx1),
                "y": round(vy1),
                "width": round(vx2 - vx1),
                "height": round(vy2 - vy1),
                "canvas_width": width,
                "canvas_height": height,
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

    def resize_bbox(self, layout_json, auto_guess_old_size, guess_ratio, old_width, old_height, new_width, new_height, resize_mode, scale_factor):
        if not layout_json.strip():
            return {"ui": {"old_width": [old_width], "old_height": [old_height]},
                    "result": ([], layout_json, new_width, new_height, [])}

        try:
            data = json.loads(layout_json)
        except Exception as e:
            print(f"[MOSS Resizer] JSON 解析失败: {e}")
            return {"ui": {"old_width": [old_width], "old_height": [old_height]},
                    "result": ([], layout_json, new_width, new_height, [], [])}

        # 草稿格式（abs/xyxy）自动转成模型格式（abs_centralized/yxyx）
        data, draft_w, draft_h = normalize_layout(data, old_width, old_height)
        if draft_w and draft_h:
            # 草稿声明了自己的画布，它才是“原图尺寸”
            old_width, old_height = int(draft_w), int(draft_h)

        items = data if isinstance(data, list) else data.get("items", [])
        if not items:
            return {"ui": {"old_width": [old_width], "old_height": [old_height]},
                    "result": ([], layout_json, new_width, new_height, [], [])}

        # 🌟 核心功能：自动推测原尺寸
        actual_old_w, actual_old_h = old_width, old_height
        if auto_guess_old_size:
            max_x, max_y = 0, 0
            for item in items:
                bbox = item.get("bbox")
                if bbox and len(bbox) == 4:
                    ymin, xmin, ymax, xmax = bbox
                    # 找出最偏离中心的边缘绝对值
                    max_y = max(max_y, abs(ymin), abs(ymax))
                    max_x = max(max_x, abs(xmin), abs(xmax))
            
            # 基础物理尺寸（至少包含所有框，所以乘以2）
            guess_h = max_y * 2
            guess_w = max_x * 2
            
            # 根据比例调整
            if guess_ratio != "自动(不限定)":
                r_w, r_h = map(int, guess_ratio.split(':'))
                target_ratio = r_w / r_h
                
                current_ratio = guess_w / guess_h if guess_h > 0 else 1.0
                
                if current_ratio < target_ratio:
                    # 框太窄，撑大宽度
                    guess_w = guess_h * target_ratio
                else:
                    # 框太扁，撑大高度
                    guess_h = guess_w / target_ratio
            
            # 向上取整到 16 的倍数，并保底
            actual_old_w = max(64, math.ceil(guess_w / 16) * 16)
            actual_old_h = max(64, math.ceil(guess_h / 16) * 16)
            
            print(f"[MOSS Resizer] 自动推测原尺寸: {actual_old_w}x{actual_old_h} (包含所有坐标极值)")

        old_cx, old_cy = actual_old_w / 2, actual_old_h / 2
        new_cx, new_cy = new_width / 2, new_height / 2
        scale_x = scale_y = 1.0
        offset_x = offset_y = 0.0
        mode_log = "保持固定坐标"

        if resize_mode != "保持固定坐标(不缩放)":

            if resize_mode == "保持长宽比(等比缩放)":
                base_scale = min(new_width / actual_old_w, new_height / actual_old_h)
                scale_x = scale_y = base_scale * scale_factor
                offset_x = (new_width - actual_old_w * scale_x) / 2
                offset_y = (new_height - actual_old_h * scale_y) / 2
                mode_log = f"保持长宽比 (x{scale_factor})"
            else:
                scale_x = (new_width / actual_old_w) * scale_factor
                scale_y = (new_height / actual_old_h) * scale_factor
                offset_x = (new_width - actual_old_w * scale_x) / 2
                offset_y = (new_height - actual_old_h * scale_y) / 2
                mode_log = f"暴力拉伸 (x{scale_factor})"

        for item in items if resize_mode != "保持固定坐标(不缩放)" else []:
            bbox = item.get("bbox")
            if not bbox or len(bbox) != 4:
                continue
            
            ymin, xmin, ymax, xmax = bbox

            top = ymin + old_cy
            left = xmin + old_cx
            bottom = ymax + old_cy
            right = xmax + old_cx

            top = top * scale_y + offset_y
            left = left * scale_x + offset_x
            bottom = bottom * scale_y + offset_y
            right = right * scale_x + offset_x

            new_ymin = top - new_cy
            new_xmin = left - new_cx
            new_ymax = bottom - new_cy
            new_xmax = right - new_cx

            # 不裁剪：布局数据保留真实坐标，超出画布的部分交给渲染端自然裁掉。
            # 之前的 clamp 会把放大后的框压到画布边界（甚至压成画面角上的退化框），
            # 导致「new 填不同尺寸、同一个框得到不同结果」。
            item["bbox"] = [
                math.floor(new_ymin),
                math.floor(new_xmin),
                math.ceil(new_ymax),
                math.ceil(new_xmax)
            ]

        final_data = items if isinstance(data, list) else data
        print(f"[MOSS Resizer] 模式: {mode_log}。映射: {actual_old_w}x{actual_old_h} -> {new_width}x{new_height}")
        sanitize_items(items)  # 空数组字段 / 私有字段 / 非法 text 不进入输出
        # 映射后画布就是目标尺寸；旧尺寸留着会误导下游，直接更新
        if isinstance(final_data, dict) and ("width" in final_data or "height" in final_data):
            final_data["width"] = new_width
            final_data["height"] = new_height
        resized_json = json.dumps(final_data, ensure_ascii=False, separators=(',', ':'))
        pixel_boxes = self._to_pixel_boxes(items, new_width, new_height)
        return {"ui": {"old_width": [actual_old_w], "old_height": [actual_old_h]},
                "result": (self._to_official_elements(items, new_width, new_height), resized_json,
                           new_width, new_height, pixel_boxes)}

NODE_CLASS_MAPPINGS = {"MOSS_BBox_Resizer": MOSS_BBox_Resizer}
NODE_DISPLAY_NAME_MAPPINGS = {"MOSS_BBox_Resizer": "MOSS BBox 尺寸映射器"}
