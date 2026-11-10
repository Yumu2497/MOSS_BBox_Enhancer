"""插件版本号。

改版本要同时动两处，否则 Registry 上的版本会和插件里显示的不一致：
  1. 这里的 `__version__`（布局编辑器标题栏通过 `GET /moss/version` 读它）
  2. `pyproject.toml` 的 `[project] version`（Comfy Registry 读它）
发布 workflow 里有一道一致性检查，两处不同就会直接失败。

注意：节点左下角那颗 `MOSS_BBox_Enhancer` 徽标来自前端注册信息（包名 / 模块名），
不是 Python 的 `CATEGORY`，改分类也带不上版本号，所以那边保持原样。
"""

from aiohttp import web
from server import PromptServer

__version__ = "1.8.1"

PACK_NAME = "MOSS_BBox_Enhancer"


@PromptServer.instance.routes.get("/moss/version")
async def moss_get_version(request):
    return web.json_response({
        "success": True,
        "name": PACK_NAME,
        "version": __version__,
    })
