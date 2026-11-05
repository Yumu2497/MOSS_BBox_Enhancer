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


@PromptServer.instance.routes.get("/moss/presets")
async def moss_get_presets(request):
    try:
        with open(_USER_FILE, "r", encoding="utf-8") as handle:
            groups = _clean(json.load(handle))
    except (OSError, ValueError):
        groups = []
    return web.json_response({"success": True, "groups": groups})


@PromptServer.instance.routes.post("/moss/presets")
async def moss_save_presets(request):
    try:
        payload = await request.json()
    except Exception:
        return web.json_response({"success": False, "error": "请求不是合法 JSON"}, status=400)

    data = {"version": 2, "groups": _clean(payload)}

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
    return web.json_response({"success": True, "groups": data["groups"]})
