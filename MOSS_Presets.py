"""用户自定义提示词预设的读写接口。

内置预设在前端 preset-data.js 里，随仓库一起发布；
这里只负责把用户自己加的类型 / 预设持久化到插件根目录的 user_presets.json。
"""

import json
import os
import tempfile

from aiohttp import web
from server import PromptServer

_ROOT = os.path.dirname(os.path.abspath(__file__))
_USER_FILE = os.path.join(_ROOT, "user_presets.json")

MAX_GROUPS = 50
MAX_ITEMS = 200
MAX_ITEM_LEN = 200
MAX_NAME_LEN = 40
MAX_TEMPLATES = 100
MAX_TEMPLATE_LEN = 20000


def _clean(raw):
    """只保留 name / items / prefix 字段，顺手截断长度，避免把任意内容写进文件。"""
    groups = []
    if not isinstance(raw, dict):
        return groups
    for group in raw.get("groups") or []:
        if not isinstance(group, dict):
            continue
        name = str(group.get("name") or "").strip()[:MAX_NAME_LEN]
        if not name:
            continue
        items = []
        for item in group.get("items") or []:
            if isinstance(item, str) and item.strip():
                items.append(item.strip()[:MAX_ITEM_LEN])
        groups.append({
            "name": name,
            "items": items[:MAX_ITEMS],
            # 自建类型是否在写入时带「类型名：」前缀，由新建时的勾选框决定
            "prefix": bool(group.get("prefix")),
        })
        if len(groups) >= MAX_GROUPS:
            break
    return groups


def _clean_templates(raw):
    """主提示词模板：{name, text}。text 是整段 summary.caption，允许较长。"""
    templates = []
    if not isinstance(raw, list):
        return templates
    for item in raw:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip()[:MAX_NAME_LEN]
        text = str(item.get("text") or "").strip()[:MAX_TEMPLATE_LEN]
        if not name or not text:
            continue
        templates.append({"name": name, "text": text})
        if len(templates) >= MAX_TEMPLATES:
            break
    return templates


@PromptServer.instance.routes.get("/moss/presets")
async def moss_get_presets(request):
    groups = []
    templates = []
    try:
        with open(_USER_FILE, "r", encoding="utf-8") as handle:
            raw = json.load(handle)
        groups = _clean(raw)
        templates = _clean_templates(raw.get("templates") if isinstance(raw, dict) else None)
    except (OSError, ValueError):
        pass
    return web.json_response({"success": True, "groups": groups, "templates": templates})


@PromptServer.instance.routes.post("/moss/presets")
async def moss_save_presets(request):
    try:
        payload = await request.json()
    except Exception:
        return web.json_response({"success": False, "error": "请求不是合法 JSON"}, status=400)

    if not isinstance(payload, dict):
        return web.json_response({"success": False, "error": "请求体必须是对象"}, status=400)

    # 读出现有内容：标签预设和主提示词模板共用这个文件，谁提交就只改谁，
    # 没提交的那一半原样保留（否则保存其中一个会把另一个清空）。
    existing = {}
    try:
        with open(_USER_FILE, "r", encoding="utf-8") as handle:
            loaded = json.load(handle)
        if isinstance(loaded, dict):
            existing = loaded
    except (OSError, ValueError):
        existing = {}

    groups = _clean(payload) if "groups" in payload else _clean(existing)
    templates = (
        _clean_templates(payload.get("templates"))
        if "templates" in payload
        else _clean_templates(existing.get("templates"))
    )
    data = {"version": 2, "groups": groups, "templates": templates}

    # 同目录临时文件 + 原子替换，避免写一半把原有预设弄坏
    fd, tmp = tempfile.mkstemp(prefix=".user_presets.", suffix=".tmp", dir=_ROOT)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle, ensure_ascii=False, indent=2)
        os.replace(tmp, _USER_FILE)
    except OSError as exc:
        try:
            os.remove(tmp)
        except OSError:
            pass
        return web.json_response({"success": False, "error": str(exc)}, status=500)
    return web.json_response({
        "success": True,
        "groups": data["groups"],
        "templates": data["templates"],
    })
