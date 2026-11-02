import json
import nodes
import io
import base64
from PIL import Image
from aiohttp import web
from server import PromptServer
import folder_paths

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
            },
            "optional": {
                "image": ("IMAGE", {"tooltip": "可选图片：用作画布尺寸参考和面板背景图。"}),
            },
        }
    
    OUTPUT_NODE = True
    RETURN_TYPES = ("ARRAY", "ARRAY", "STRING", "STRING")
    RETURN_NAMES = ("元素数组", "边界框数组", "主提示词", "完整提示词")
    FUNCTION = "execute"
    CATEGORY = "MOSS_BBox_Enhancer"

    def execute(self, layout_json, canvas_width, canvas_height,
                use_image_size=True, image=None):
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
            return {"ui": ui, "result": ([], [], "", "")}

        try:
            data = json.loads(layout_json)
        except Exception as e:
            # 🌟 容错机制：如果不是合法 JSON，直接当作纯文本主提示词处理
            print(f"[MOSS Import] JSON 解析失败，按纯文本处理: {e}")
            prompt = layout_json.strip()
            # 因为没有画框，元素数组和边界框都为空，主提示词和完整提示词都是这段纯文本
            return {"ui": ui, "result": ([], [], prompt, prompt)}

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

        elements = []
        bboxes = []
        half_w, half_h = canvas_width / 2, canvas_height / 2

        for item in items:
            if not isinstance(item, dict):
                continue
            bbox = item.get("bbox")
            if not bbox or len(bbox) != 4:
                continue

            ymin, xmin, ymax, xmax = bbox
            y1, x1 = ymin + half_h, xmin + half_w
            y2, x2 = ymax + half_h, xmax + half_w

            # 生成官方元素数组
            element = {
                "type": item.get("label", "object"),
                "bbox": [
                    max(0, min(1000, round((y1 / canvas_height) * 1000))),
                    max(0, min(1000, round((x1 / canvas_width) * 1000))),
                    max(0, min(1000, round((y2 / canvas_height) * 1000))),
                    max(0, min(1000, round((x2 / canvas_width) * 1000)))
                ],
                "desc": item.get("caption", ""),
            }
            if "text" in item:
                element["text"] = item["text"]
            if "palette" in item:
                element["color_palette"] = item["palette"]
            elements.append(element)

            # 生成像素 BBox
            label = item.get("label", "object")
            bbox_obj = {
                "x": round(x1),
                "y": round(y1),
                "width": round(x2 - x1),
                "height": round(y2 - y1),
                "metadata": {
                    "type": "text" if label == "text" else "obj",
                    "text": item.get("text", ""),
                    "desc": item.get("caption", ""),
                    "palette": item.get("palette", []) or []
                }
            }
            bboxes.append(bbox_obj)

        # ================= 核心修复：完整提示词 =================
        # 如果画了框（元素数组不为空），就把整个 JSON 作为字符串输出；否则只输出主提示词。
        if elements:
            full_prompt = json.dumps(data, ensure_ascii=False, separators=(',', ':'))
        else:
            full_prompt = prompt

        print(f"[MOSS Import] 成功导入 {len(elements)} 个框，主提示词: {len(prompt)} 字符，完整提示词模式: {'JSON' if elements else '纯文本'}")
        
        # 返回：元素数组、边界框数组、主提示词、完整提示词
        return {"ui": ui, "result": (elements, bboxes, prompt, full_prompt)}


NODE_CLASS_MAPPINGS = {"MOSS_JSON_Importer": MOSS_JSON_Importer}
NODE_DISPLAY_NAME_MAPPINGS = {"MOSS_JSON_Importer": "MOSS JSON 导入边界框"}
