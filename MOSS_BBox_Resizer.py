import json
import math

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

    RETURN_TYPES = ("ARRAY", "STRING", "INT", "INT")
    RETURN_NAMES = ("边界框数组", "映射后JSON", "目标宽度", "目标高度")
    OUTPUT_NODE = True
    FUNCTION = "resize_bbox"
    CATEGORY = "MOSS/边界框工具"

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
            if palette:
                element["color_palette"] = palette
            elements.append(element)
        return elements

    def resize_bbox(self, layout_json, auto_guess_old_size, guess_ratio, old_width, old_height, new_width, new_height, resize_mode, scale_factor):
        if not layout_json.strip():
            return {"ui": {"old_width": [old_width], "old_height": [old_height]},
                    "result": ([], layout_json, new_width, new_height)}

        try:
            data = json.loads(layout_json)
        except Exception as e:
            print(f"[MOSS Resizer] JSON 解析失败: {e}")
            return {"ui": {"old_width": [old_width], "old_height": [old_height]},
                    "result": ([], layout_json, new_width, new_height)}

        items = data if isinstance(data, list) else data.get("items", [])
        if not items:
            return {"ui": {"old_width": [old_width], "old_height": [old_height]},
                    "result": ([], layout_json, new_width, new_height)}

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

            def clamp(val, min_val, max_val):
                return max(min_val, min(val, max_val))

            item["bbox"] = [
                math.floor(clamp(new_ymin, -new_cy, new_cy)),
                math.floor(clamp(new_xmin, -new_cx, new_cx)),
                math.ceil(clamp(new_ymax, -new_cy, new_cy)),
                math.ceil(clamp(new_xmax, -new_cx, new_cx))
            ]

        final_data = items if isinstance(data, list) else data
        print(f"[MOSS Resizer] 模式: {mode_log}。映射: {actual_old_w}x{actual_old_h} -> {new_width}x{new_height}")
        resized_json = json.dumps(final_data, ensure_ascii=False, separators=(',', ':'))
        return {"ui": {"old_width": [actual_old_w], "old_height": [actual_old_h]},
                "result": (self._to_official_elements(items, new_width, new_height), resized_json,
                           new_width, new_height)}

NODE_CLASS_MAPPINGS = {"MOSS_BBox_Resizer": MOSS_BBox_Resizer}
NODE_DISPLAY_NAME_MAPPINGS = {"MOSS_BBox_Resizer": "MOSS BBox 尺寸映射器"}
