"""插件版本号的唯一来源。

改版本只动这里的 `__version__`，布局编辑器标题栏会通过 `GET /moss/version` 自动跟着变。

注意：节点左下角那颗 `MOSS_BBox_Enhancer` 徽标来自前端注册信息（包名 / 模块名），
不是 Python 的 `CATEGORY`，改分类也带不上版本号，所以那边保持原样。
"""

from aiohttp import web
from server import PromptServer

__version__ = "1.7.0"

PACK_NAME = "MOSS_BBox_Enhancer"


@PromptServer.instance.routes.get("/moss/version")
async def moss_get_version(request):
    return web.json_response({
        "success": True,
        "name": PACK_NAME,
        "version": __version__,
    })
