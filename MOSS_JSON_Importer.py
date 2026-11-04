import json
import nodes
import io
import os
import base64
import time
from PIL import Image, ImageColor, ImageDraw, ImageFont
from aiohttp import web
from server import PromptServer
import folder_paths


# 预览图最长边，超过就等比缩小，避免大画布每次执行都生成几 MB 的 PNG
PREVIEW_MAX_SIZE = 768


def sanitize_items(items):
    """按官方 schema 规范化条目（就地修改）：
    - 编辑器私有字段（下划线开头，如 _align）不进入输出；
    - tags / palette 为空数组时整个字段删除；
    - text 字段只属于 label == "text" 的条目。
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
    """把官方"草稿"格式统一成模型格式（ComfyUI 官方节点使用的那套）。

    草稿： bbox_coord_space="abs"             + bbox_format="xyxy"（左上角原点，带 width/height）
    模型： bbox_coord_space="abs_centralized" + bbox_format="yxyx"（画布中心原点）

    返回 (data, width, height)，width/height 是草稿声明的画布尺寸（可能为 None）。
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
        # 草稿是左上角原点，没有画布尺寸就无法换算，原样返回
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
    # 注意：width / height 保留。模型格式同样允许携带画布尺寸，
    # 只在生成给下游的提示词时剥离（见 execute 里的 full_prompt）。
    return data, width, height

@PromptServer.instance.routes.post("/moss/extract_prompt")
async def extract_moss_prompt(request):
    try:
        post = await request.post()
        image_file = post.get("image")
        if not image_file:
            return web.json_response({"success": False, "error": "未接受到图片文件"})
        
        image_bytes = image_file.file.read()
        img = Image.open(io.BytesIO(image_bytes))
        prompt_str = img.info.get("prompt")
        
        if not prompt_str:
            return web.json_response({"success": False, "error": "该图片不包含 ComfyUI 生成参数"})
        
        prompt_data = json.loads(prompt_str)
        
        def resolve_val(node_id, val):
            if isinstance(val, (str, int, float)):
                return val
            if isinstance(val, list) and len(val) == 2:
                src = prompt_data.get(str(val[0]), {})
                src_inputs = src.get("inputs", {})
                for k in ["text", "value", "string", "prompt", "int", "float"]:
                    if k in src_inputs and not isinstance(src_inputs[k], (list, dict)):
                        return src_inputs[k]
            return None

        # 1. 找所有采样器
        all_samplers = set()
        for nid, n in prompt_data.items():
            ct = n.get("class_type", "")
            if "KSampler" in ct or "SamplerCustom" in ct or "Guider" in ct:
                all_samplers.add(str(nid))
                
        # 2. 剔除二采，找源头一采
        def has_sampler_parent(node_id, visited):
            if node_id in visited: return False
            visited.add(node_id)
            node = prompt_data.get(node_id)
            if not node: return False
            
            for k, v in node.get("inputs", {}).items():
                if isinstance(v, list) and len(v) == 2:
                    src_id = str(v[0])
                    if src_id in all_samplers:
                        return True
                    if has_sampler_parent(src_id, visited):
                        return True
            return False

        source_samplers = []
        for sid in all_samplers:
            if not has_sampler_parent(sid, set()):
                source_samplers.append(sid)
                
        if not source_samplers:
            source_samplers = list(all_samplers)

        # 3. 对每个源头一采进行独立溯源
        flows = []
        for sid in source_samplers:
            flow_data = {"samplerId": sid, "moss_jsons": [], "official_boxes": [], "texts": []}
            visited_nodes = set()
            queue = []
            
            pos = prompt_data[sid].get("inputs", {}).get("positive")
            if pos: queue.append(pos)

            while queue:
                item = queue.pop(0)
                curr_id = str(item[0]) if isinstance(item, list) and len(item) == 2 else str(item)
                if curr_id in visited_nodes: continue
                visited_nodes.add(curr_id)
                
                node = prompt_data.get(curr_id)
                if not node: continue
                ct = node.get("class_type", "")
                inputs = node.get("inputs", {})
                
                if ct in ["MOSS_JSON_Importer", "MOSS_BBox_Resizer"]:
                    j_val = resolve_val(curr_id, inputs.get("layout_json"))
                    if j_val:
                        w = resolve_val(curr_id, inputs.get("canvas_width", inputs.get("new_width", 1024)))
                        h = resolve_val(curr_id, inputs.get("canvas_height", inputs.get("new_height", 1024)))
                        flow_data["moss_jsons"].append({"id": curr_id, "json": j_val, "w": int(w or 1024), "h": int(h or 1024)})

                elif ct == "MOSSImageLayoutPrompt":
                    p_text = inputs.get("prompt", "")
                    if p_text and p_text not in flow_data["texts"]: 
                        flow_data["texts"].append(p_text)
                    el = inputs.get("element")
                    if el: queue.append(el)

                elif ct == "CreateBoundingBoxes":
                    boxes = inputs.get("editor_state", [])
                    w = resolve_val(curr_id, inputs.get("width", 1024))
                    h = resolve_val(curr_id, inputs.get("height", 1024))
                    if boxes:
                        flow_data["official_boxes"].append({"id": curr_id, "boxes": boxes, "w": int(w or 1024), "h": int(h or 1024)})

                elif "TextEncode" in ct or ct == "String":
                    t = inputs.get("text", inputs.get("string", inputs.get("value")))
                    if isinstance(t, str) and t.strip() and t not in flow_data["texts"]:
                        flow_data["texts"].append(t)
                
                for k, v in inputs.items():
                    if isinstance(v, list) and len(v) == 2:
                        queue.append(v)

            # ================= 核心逻辑：完整性校验与填补 =================
            # 获取最下游的（优先级最高的）文本
            best_text = flow_data["texts"][0] if flow_data["texts"] else ""

            for j in flow_data["moss_jsons"]:
                try:
                    j_data = json.loads(j["json"])
                    missing_caption = True
                    
                    # 1. 校验完整性
                    if isinstance(j_data, dict):
                        if "summary" in j_data and isinstance(j_data["summary"], dict):
                            caption = str(j_data["summary"].get("caption", "")).strip()
                            if caption:
                                missing_caption = False
                    elif isinstance(j_data, list):
                        # 如果是纯列表，说明没有 summary
                        missing_caption = True
                    
                    # 2. 填补（只在主提示词为空，且找到了外部文本时填补）
                    if missing_caption and best_text:
                        if isinstance(j_data, list):
                            j_data = {"summary": {"caption": best_text}, "items": j_data}
                        elif isinstance(j_data, dict):
                            if "summary" not in j_data or not isinstance(j_data["summary"], dict):
                                j_data["summary"] = {}
                            j_data["summary"]["caption"] = best_text
                        
                        # 重新序列化更新结果
                        j["json"] = json.dumps(j_data, ensure_ascii=False, indent=2)
                except Exception as e:
                    print(f"[MOSS] JSON 解析或填补失败: {e}")
            # ==============================================================

            # 只要有任何有效数据（JSON、官方框、纯文本）都保留
            if flow_data["moss_jsons"] or flow_data["official_boxes"] or flow_data["texts"]:
                flows.append(flow_data)

        if not flows:
            return web.json_response({"success": False, "error": "在所有采样器的正向链路中均未找到有效数据"})

        return web.json_response({"success": True, "flows": flows})

    except Exception as e:
        return web.json_response({"success": False, "error": f"解析失败: {str(e)}"})

def _preview_rgb(item, index, colors):
    """预览用的描边色：框色 → 调色板首色 → 兜底红。"""
    color = colors.get(index)
    if not color and isinstance(item, dict):
        palette = item.get("palette")
        if isinstance(palette, list) and palette and isinstance(palette[0], str):
            color = palette[0]
    if not color:
        return (255, 74, 74)
    try:
        return ImageColor.getrgb(color)
    except Exception:
        return (255, 74, 74)


def _tensor_to_pil(image):
    """把 ComfyUI 的 IMAGE 张量（取第一帧）转成 PIL。"""
    frame = image
    shape = getattr(frame, "shape", None)
    if shape is not None and len(shape) == 4:
        frame = frame[0]
    array = frame.detach().cpu().numpy() if hasattr(frame, "detach") else frame
    array = (array * 255.0).clip(0, 255).astype("uint8")
    return Image.fromarray(array)


def render_layout_preview(items, colors, width, height, background=None):
    """按画布尺寸画一张布局预览：每个框的描边取各自颜色，左上角标序号。"""
    width = max(1, int(width))
    height = max(1, int(height))
    scale = min(1.0, PREVIEW_MAX_SIZE / max(width, height))
    w = max(1, int(round(width * scale)))
    h = max(1, int(round(height * scale)))

    if background is not None:
        resample = getattr(Image, "Resampling", Image).LANCZOS
        img = background.convert("RGB").resize((w, h), resample)
    else:
        img = Image.new("RGB", (w, h), (30, 30, 32))

    draw = ImageDraw.Draw(img)
    draw.rectangle([0, 0, w - 1, h - 1], outline=(70, 70, 74), width=1)

    line = max(1, round(min(w, h) / 300))
    font = ImageFont.load_default()
    half_w, half_h = width / 2.0, height / 2.0

    for index, item in enumerate(items or []):
        bbox = item.get("bbox") if isinstance(item, dict) else None
        if not isinstance(bbox, (list, tuple)) or len(bbox) != 4:
            continue
        ymin, xmin, ymax, xmax = bbox
        x1 = (xmin + half_w) * scale
        y1 = (ymin + half_h) * scale
        x2 = (xmax + half_w) * scale
        y2 = (ymax + half_h) * scale
        color = _preview_rgb(item, index, colors)
        draw.rectangle([x1, y1, x2, y2], outline=color, width=line)

        tag = str(index + 1)
        try:
            tag_w = draw.textlength(tag, font=font)
        except Exception:
            tag_w = 7 * len(tag)
        if x2 - x1 > tag_w + 6 and y2 - y1 > 14:
            draw.rectangle([x1, y1, x1 + tag_w + 5, y1 + 13], fill=color)
            draw.text((x1 + 3, y1 + 1), tag, fill=(20, 20, 20), font=font)

    return img


class MOSS_JSON_Importer:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "layout_json": ("STRING", {"multiline": True, "default": ""}),
                "canvas_width": ("INT", {"default": 1024, "min": 64, "max": 16384, "step": 16,
                                          "tooltip": "画布宽度。若连接了 image 且 use_image_size 开启，执行时会被图片宽度覆盖，并同步回该控件。"}),
                "canvas_height": ("INT", {"default": 1024, "min": 64, "max": 16384, "step": 16,
                                           "tooltip": "画布高度。若连接了 image 且 use_image_size 开启，执行时会被图片高度覆盖，并同步回该控件。"}),
                "use_image_size": ("BOOLEAN", {"default": True,
                                                "tooltip": "连接 image 时自动使用图片宽高作为画布尺寸，并把该图片设为面板背景图。"}),
                "bbox_colors": ("STRING", {"default": "", "multiline": False,
                                           "tooltip": "面板自动写入：{序号: 颜色}，只用于「边界框」输出，不进入 layout_json。"}),
                "preview": ("BOOLEAN", {"default": True,
                                        "tooltip": "运行后在节点下方预览画布（框 + 序号）。关掉则不生成图片。"}),
            },
            "optional": {
                "image": ("IMAGE", {"tooltip": "可选图片：用作画布尺寸参考和面板背景图。"}),
            },
        }
    
    OUTPUT_NODE = True
    RETURN_TYPES = ("ARRAY", "STRING", "STRING", "ARRAY")
    RETURN_NAMES = ("元素数组", "主提示词", "完整提示词", "边界框")
    FUNCTION = "execute"
    CATEGORY = "MOSS_BBox_Enhancer"

    def execute(self, layout_json, canvas_width, canvas_height,
                use_image_size=True, image=None, bbox_colors="", preview=True):
        ui = {}
        print(f"[MOSS Import] 进入: image={'None' if image is None else f'tensor{tuple(image.shape)}'}, "
          f"use_image_size={use_image_size}, widget尺寸={canvas_width}x{canvas_height}")

        # 🌟 核心修复：无论有没有图，都把后端当前实际使用的尺寸回传给前端！
        ui["width"] = [canvas_width]
        ui["height"] = [canvas_height]

        # 🌟 图片接入：自动覆盖画布尺寸 + 导出为背景图
        if image is not None and use_image_size:
            try:
                ih = int(image.shape[1])
                iw = int(image.shape[2])
                if iw > 0 and ih > 0:
                    canvas_width, canvas_height = iw, ih
                    # 覆盖回传的尺寸
                    ui["width"] = [iw]
                    ui["height"] = [ih]
                    try:
                        saved = nodes.PreviewImage().save_images(
                            image[:1], "moss.bbox.background"
                        )
                        if saved and "ui" in saved and "images" in saved["ui"]:
                            ui["background_images"] = saved["ui"]["images"]
                    except Exception as e:
                        print(f"[MOSS Import] 保存背景图失败: {e}")
            except Exception as e:
                print(f"[MOSS Import] 读取图片尺寸失败: {e}")

        # 提前返回时，也要保证返回 4 个值
        if not layout_json.strip():
            return {"ui": ui, "result": ([], "", "", [])}

        try:
            data = json.loads(layout_json)
        except Exception as e:
            # 🌟 容错机制：如果不是合法 JSON，直接当作纯文本主提示词处理
            print(f"[MOSS Import] JSON 解析失败，按纯文本处理: {e}")
            prompt = layout_json.strip()
            # 因为没有画框，元素数组和边界框都为空，主提示词和完整提示词都是这段纯文本
            return {"ui": ui, "result": ([], prompt, prompt, [])}

        # 草稿格式（abs/xyxy）自动转成模型格式（abs_centralized/yxyx）
        data, draft_w, draft_h = normalize_layout(data, canvas_width, canvas_height)
        if draft_w and draft_h:
            # 草稿声明了自己的画布，坐标换算必须与之一致
            canvas_width, canvas_height = int(draft_w), int(draft_h)
            ui["width"] = [canvas_width]
            ui["height"] = [canvas_height]

        # ================= 修改从这里开始 =================
        
        # 1. 提取主提示词
        prompt = ""
        if isinstance(data, dict):
            summary = data.get("summary", {})
            if isinstance(summary, dict):
                prompt = summary.get("caption", "") or ""
            else:
                prompt = str(summary or "")
        
        # 2. 获取 items 列表
        items = data.get("items", []) if isinstance(data, dict) else (data if isinstance(data, list) else [])

        # 面板传来的框色：{序号: "#rrggbb"}，不写入 layout_json
        colors = {}
        try:
            if bbox_colors and bbox_colors.strip():
                raw_colors = json.loads(bbox_colors)
                if isinstance(raw_colors, dict):
                    for k, v in raw_colors.items():
                        if isinstance(v, str) and v.strip():
                            colors[int(k)] = v.strip()
        except Exception as e:
            print(f"[MOSS Import] 框色解析失败: {e}")

        elements = []
        colored_boxes = []
        half_w, half_h = canvas_width / 2, canvas_height / 2

        for index, item in enumerate(items):
            if not isinstance(item, dict):
                continue
            bbox = item.get("bbox")
            if not bbox or len(bbox) != 4:
                continue

            ymin, xmin, ymax, xmax = bbox
            y1, x1 = ymin + half_h, xmin + half_w
            y2, x2 = ymax + half_h, xmax + half_w

            # 生成官方元素数组。
            # 官方元素的 type 只有 obj / text：character 和 object 一样走 obj，
            # 角色身份由官方 MOSSImageLayoutPrompt 的 character_boxes 输入决定（填框序号）。
            label = item.get("label", "object")
            is_text = label == "text"
            element = {
                "type": "text" if is_text else "obj",
                "bbox": [
                    max(0, min(1000, round((y1 / canvas_height) * 1000))),
                    max(0, min(1000, round((x1 / canvas_width) * 1000))),
                    max(0, min(1000, round((y2 / canvas_height) * 1000))),
                    max(0, min(1000, round((x2 / canvas_width) * 1000)))
                ],
                "desc": item.get("caption", ""),
            }
            # text 字段只属于 text 条目
            if is_text:
                element["text"] = item.get("text", "")
            palette = item.get("palette")
            if isinstance(palette, list) and palette:
                element["color_palette"] = list(palette)
            tags = item.get("tags")
            if isinstance(tags, list) and tags:
                element["tags"] = tags
            elements.append(element)

            # 边界框：像素坐标，给官方「创建边界框」或「MOSS 绘制边界框」用。
            # 只带 type / text / desc + 框色，不写 palette，避免和框色混为一谈。
            frame_color = colors.get(index)
            meta = {
                "type": "text" if is_text else "obj",
                "text": item.get("text", "") if is_text else "",
                "desc": item.get("caption", ""),
            }

            plain_box = {
                "x": round(x1),
                "y": round(y1),
                "width": round(x2 - x1),
                "height": round(y2 - y1),
                "metadata": meta,
            }
            if frame_color:
                plain_box["color"] = frame_color
            colored_boxes.append(plain_box)

        # ================= 核心修复：完整提示词 =================
        # 如果画了框（元素数组不为空），就把整个 JSON 作为字符串输出；否则只输出主提示词。
        if elements:
            sanitize_items(items)  # 空数组字段 / 私有字段 / 非法 text 不进入提示词
            # 提示词里不携带画布尺寸：模型只认 bbox
            prompt_data = data
            if isinstance(data, dict):
                prompt_data = {k: v for k, v in data.items() if k not in ("width", "height")}
            full_prompt = json.dumps(prompt_data, ensure_ascii=False, separators=(',', ':'))
        else:
            full_prompt = prompt

        if preview:
            try:
                background = _tensor_to_pil(image) if image is not None else None
                preview_img = render_layout_preview(items, colors, canvas_width, canvas_height, background)
                temp_dir = folder_paths.get_temp_directory()
                filename = f"moss_layout_{int(time.time() * 1000)}.png"
                preview_img.save(os.path.join(temp_dir, filename), compress_level=1)
                ui["images"] = [{"filename": filename, "subfolder": "", "type": "temp"}]
            except Exception as e:
                print(f"[MOSS Import] 预览生成失败: {e}")

        print(f"[MOSS Import] 成功导入 {len(elements)} 个框，主提示词: {len(prompt)} 字符，完整提示词模式: {'JSON' if elements else '纯文本'}")
        
        # 返回：元素数组、主提示词、完整提示词、边界框（带颜色）
        return {"ui": ui, "result": (elements, prompt, full_prompt, colored_boxes)}


NODE_CLASS_MAPPINGS = {"MOSS_JSON_Importer": MOSS_JSON_Importer}
NODE_DISPLAY_NAME_MAPPINGS = {"MOSS_JSON_Importer": "MOSS 布局编辑器"}
