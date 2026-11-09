"""DWPose wholebody ONNX 推理：从图片识别人体，按部位生成矩形框。

模型来自 mmpose 的 DWPose 整套（Apache-2.0），权重以
Claquasse/Anima-Control-Pose 的 detector/ 目录为镜像分发：

  detector/yolox_m_8xb8-300e_humanart-c2c7a14a.onnx            人体检测（97MB）
  detector/rtmw-dw-x-l_simcc-cocktail14_270e-256x192_*.onnx    133 点姿态（219MB）

133 点的分布：身体 0-16、脚 17-22、脸 23-90、左手 91-111、右手 112-132。
MOSS 只要矩形，所以这里不区分左右，只出六类：
面部 / 肘部 / 手部 / 胯部 / 膝部 / 脚部（手和脚各有两只，会各出一个框）。

推理用 onnxruntime，不依赖 torch / rtmlib / mmcv。
"""

import asyncio
import base64
import math
import os
import threading
import urllib.request

import numpy as np
from aiohttp import web
from server import PromptServer

_ROOT = os.path.dirname(os.path.abspath(__file__))
_MODEL_DIR = os.path.join(_ROOT, "models")

# 默认下载的两个文件（只在目录里找不到同类模型时才下）
_DET_FILE = "yolox_m_8xb8-300e_humanart-c2c7a14a.onnx"
_POSE_FILE = "rtmw-dw-x-l_simcc-cocktail14_270e-256x192_20231122.onnx"
_MIRRORS = (
    "https://hf-mirror.com/Claquasse/Anima-Control-Pose/resolve/main/detector/",
    "https://huggingface.co/Claquasse/Anima-Control-Pose/resolve/main/detector/",
)
_MIN_BYTES = 20 * 1024 * 1024   # 小于这个多半是下到了错误页面

# 按通配符找模型：换任何同族导出（yolox_* / rtmw_* / dwpose_*）都不用改代码
_DET_PATTERNS = ("*humanart*.onnx", "*yolox*.onnx")
_POSE_PATTERNS = ("*rtmw*.onnx", "*dwpose*.onnx", "*wholebody*.onnx")


def _pick(patterns):
    """按优先级找第一个匹配的模型文件；忽略 .part 和明显不完整的。"""
    import glob

    for pattern in patterns:
        hits = [
            p for p in sorted(glob.glob(os.path.join(_MODEL_DIR, pattern)))
            if os.path.isfile(p) and os.path.getsize(p) >= _MIN_BYTES
            and not p.endswith(".part")
        ]
        if hits:
            return hits[0]
    return None


def _model_paths():
    """返回 (检测模型, 姿态模型)，任一缺失就返回 None。"""
    det = _pick(_DET_PATTERNS)
    pose = _pick(_POSE_PATTERNS)
    if det is None or pose is None:
        return None
    return det, pose


_download = {"busy": False, "file": "", "got": 0, "total": 0, "error": ""}
_download_lock = threading.Lock()


def _stream_to(url, path):
    req = urllib.request.Request(url, headers={"User-Agent": "MOSS-BBox-Enhancer"})
    with urllib.request.urlopen(req, timeout=30) as resp, open(path, "wb") as out:
        try:
            total = int(resp.headers.get("Content-Length") or 0)
        except (TypeError, ValueError):
            total = 0
        _download["total"] += total
        while True:
            chunk = resp.read(256 * 1024)
            if not chunk:
                break
            out.write(chunk)
            _download["got"] += len(chunk)


def _download_models():
    """下载缺的模型。已有同类文件直接跳过，并发调用靠锁串行。"""
    if _model_paths() is not None:
        return _model_paths()

    with _download_lock:
        if _model_paths() is not None:
            return _model_paths()

        os.makedirs(_MODEL_DIR, exist_ok=True)
        _download.update({"busy": True, "file": "", "got": 0, "total": 0, "error": ""})

        # 只下缺的那一类：已经有人手动放了 rtmw 就只补检测模型
        targets = []
        if _pick(_DET_PATTERNS) is None:
            targets.append(_DET_FILE)
        if _pick(_POSE_PATTERNS) is None:
            targets.append(_POSE_FILE)

        last_error = ""
        try:
            if not targets:
                raise RuntimeError("models/ 里的 DWPose 模型不完整（检测或姿态缺一个）")
            for name in targets:
                dest = os.path.join(_MODEL_DIR, name)
                _download["file"] = name
                tmp = dest + ".part"
                for base in _MIRRORS:
                    url = base + name
                    try:
                        print(f"[MOSS Pose] 正在下载模型：{url}")
                        _stream_to(url, tmp)
                        if os.path.getsize(tmp) < _MIN_BYTES:
                            raise IOError("文件过小，可能下到了错误页面")
                        os.replace(tmp, dest)
                        print(f"[MOSS Pose] 已就绪：{dest}")
                        break
                    except Exception as exc:
                        last_error = f"{type(exc).__name__}: {exc}"
                        print(f"[MOSS Pose] 下载失败（{url}）：{last_error}")
                        try:
                            os.remove(tmp)
                        except OSError:
                            pass
                else:
                    raise RuntimeError(last_error or "所有下载源都失败")
            paths = _model_paths()
            if paths is None:
                raise RuntimeError(last_error or "模型文件不完整")
            return paths
        except Exception as exc:
            _download["error"] = f"模型下载失败：{exc}"
            raise
        finally:
            _download["busy"] = False


# ---------------- 推理 ----------------

# 下面三个是「模型里没写死时」的兜底值；真正的尺寸在加载模型时从 ONNX 读取
_INPUT = 640                 # 检测输入边长（方图）
_POSE_W, _POSE_H = 192, 256  # 姿态输入宽高
_META = {"det": (640, 640), "pose": (192, 256), "split": 2.0, "kpts": 133}
_MEAN = np.array([123.675, 116.28, 103.53], dtype=np.float32)
_STD = np.array([58.395, 57.12, 57.375], dtype=np.float32)
_CONF_DEFAULT = 0.5      # 人体检测分数阈值
_KP_CONF = 0.3           # 单个关键点的置信度阈值

# 133 点分组
FACE = list(range(23, 91))
HAND_L = list(range(91, 112))
HAND_R = list(range(112, 133))
FOOT_L = [15, 17, 18, 19]    # 踝 + 大趾 + 小趾 + 脚跟
FOOT_R = [16, 20, 21, 22]
ELBOWS = (7, 8)
KNEES = (13, 14)
HIPS = (11, 12)
BODY = list(range(17))

_sessions = None
_lock = threading.Lock()


def _static_hw(input_shape):
    """从 (N,3,H,W) 里取静态的 (宽, 高)；有动态维度就返回 None。"""
    try:
        if len(input_shape) == 4 and all(isinstance(v, int) and v > 0 for v in input_shape[2:]):
            return int(input_shape[3]), int(input_shape[2])
    except TypeError:
        pass
    return None


def _get_sessions():
    global _sessions
    with _lock:
        if _sessions is None:
            import onnxruntime as ort

            paths = _model_paths()
            if paths is None:
                raise FileNotFoundError("models/ 下没有 DWPose 模型")
            available = ort.get_available_providers()
            providers = [p for p in ("CUDAExecutionProvider", "CPUExecutionProvider") if p in available]
            providers = providers or ["CPUExecutionProvider"]
            det = ort.InferenceSession(paths[0], providers=providers)
            pose = ort.InferenceSession(paths[1], providers=providers)

            # 输入尺寸不写死：能读到就用模型自己的，读不到才退回默认值
            _META["det"] = _static_hw(det.get_inputs()[0].shape) or (_INPUT, _INPUT)
            _META["pose"] = _static_hw(pose.get_inputs()[0].shape) or (_POSE_W, _POSE_H)

            # 关键点数和 simcc 倍数从输出形状反推（RTMPose 一般是 2 倍）
            kpts, split = 133, 2.0
            outs = pose.get_outputs()
            if outs and len(outs[0].shape) == 3:
                shape = outs[0].shape
                if isinstance(shape[1], int) and shape[1] > 0:
                    kpts = int(shape[1])
                pw = _META["pose"][0]
                if isinstance(shape[2], int) and shape[2] > 0 and pw:
                    split = round(shape[2] / float(pw), 4) or 2.0
            _META.update({"kpts": kpts, "split": split})

            if kpts != 133:
                raise RuntimeError(
                    f"这个姿态模型输出 {kpts} 个关键点；本插件按 DWPose wholebody 的 133 点"
                    "（身体17 + 脚6 + 脸68 + 双手各21）分组，换成 17 点或 26 点的模型用不了。"
                )

            dw, dh = _META["det"]
            pw, ph = _META["pose"]
            print(
                f"[MOSS Pose] 就绪：{os.path.basename(paths[0])} + {os.path.basename(paths[1])}"
                f"｜检测 {dw}x{dh}，姿态 {pw}x{ph}，{kpts} 点，split {split}"
            )
            _sessions = (det, pose)
        return _sessions


def _det_preprocess(img):
    """等比缩放到模型输入尺寸，并在左上角贴边填充（和 mmpose 的 yolox 预处理一致）。"""
    import cv2

    tw, th = _META["det"]
    h, w = img.shape[:2]
    if (h, w) == (th, tw):
        return img.copy(), 1.0
    ratio = min(tw / float(w), th / float(h))
    nw, nh = int(w * ratio), int(h * ratio)
    canvas = np.full((th, tw, 3), 114, dtype=np.uint8)
    canvas[:nh, :nw] = cv2.resize(img, (nw, nh), interpolation=cv2.INTER_LINEAR)
    return canvas, ratio


def _det_infer(img, conf):
    """返回 [[x1,y1,x2,y2,score], ...]，原图坐标。模型自带 NMS。"""
    det = _get_sessions()[0]
    canvas, ratio = _det_preprocess(img)
    blob = np.ascontiguousarray(canvas.transpose(2, 0, 1)[None], dtype=np.float32)
    outputs = det.run(None, {det.get_inputs()[0].name: blob})
    dets = outputs[0][0]                     # [N,5] = x1,y1,x2,y2,score
    if dets.ndim != 2 or dets.shape[-1] != 5:
        raise RuntimeError(
            f"这个检测模型的输出是 {tuple(np.shape(dets))}，不是 [N,5]（自带 NMS 的版本）；"
            "请换用 mmpose / DWPose 导出的带 NMS 的 yolox 模型。"
        )
    if len(outputs) > 1:
        labels = outputs[1][0]
    else:
        labels = np.zeros(len(dets), dtype=np.int64)

    h, w = img.shape[:2]
    out = []
    for (x1, y1, x2, y2, score), label in zip(dets, labels):
        if int(label) != 0 or float(score) < conf:   # 只要 person
            continue
        out.append([
            max(0.0, min(w, float(x1) / ratio)),
            max(0.0, min(h, float(y1) / ratio)),
            max(0.0, min(w, float(x2) / ratio)),
            max(0.0, min(h, float(y2) / ratio)),
            float(score),
        ])
    out.sort(key=lambda r: -r[4])
    return out


def _pose_warp(img, bbox):
    """按 bbox 做仿射裁剪到模型输入尺寸，返回 (blob, center, scale)。"""
    import cv2

    pw, ph = _META["pose"]
    x1, y1, x2, y2 = bbox
    center = np.array([(x1 + x2) * 0.5, (y1 + y2) * 0.5], dtype=np.float32)
    scale = np.array([(x2 - x1) * 1.25, (y2 - y1) * 1.25], dtype=np.float32)

    # 把 bbox 调整成模型输入的长宽比
    aspect = pw / float(ph)
    if scale[0] > scale[1] * aspect:
        scale = np.array([scale[0], scale[0] / aspect], dtype=np.float32)
    else:
        scale = np.array([scale[1] * aspect, scale[1]], dtype=np.float32)

    # 三点仿射：中心 + 竖直方向偏移点 + 其旋转 90° 的点
    src = np.zeros((3, 2), dtype=np.float32)
    src[0] = center
    src[1] = center + np.array([0.0, -scale[0] * 0.5], dtype=np.float32)
    src[2] = src[1] + np.array([scale[1] * 0.5, 0.0], dtype=np.float32)

    dst = np.zeros((3, 2), dtype=np.float32)
    dst[0] = [pw * 0.5, ph * 0.5]
    dst[1] = [pw * 0.5, ph * 0.5 - pw * 0.5]
    dst[2] = dst[1] + np.array([ph * 0.5, 0.0], dtype=np.float32)

    mat = cv2.getAffineTransform(src, dst)
    warped = cv2.warpAffine(img, mat, (pw, ph), flags=cv2.INTER_LINEAR)
    warped = (warped.astype(np.float32) - _MEAN) / _STD
    return np.ascontiguousarray(warped.transpose(2, 0, 1)[None], dtype=np.float32), center, scale


def _pose_infer(img, bbox):
    """单个人的关键点。返回 (kpts[K,2], scores[K])，原图坐标。"""
    pose = _get_sessions()[1]
    blob, center, scale = _pose_warp(img, bbox)
    simcc_x, simcc_y = pose.run(None, {pose.get_inputs()[0].name: blob})[0:2]

    n_kpts = simcc_x.shape[1]
    if n_kpts != _META["kpts"]:
        raise RuntimeError(f"姿态模型输出的关键点数({n_kpts})和加载时不一致")

    x_locs = np.argmax(simcc_x[0], axis=1).astype(np.float32)
    y_locs = np.argmax(simcc_y[0], axis=1).astype(np.float32)
    max_x = np.amax(simcc_x[0], axis=1)
    max_y = np.amax(simcc_y[0], axis=1)
    scores = 0.5 * (max_x + max_y)

    pw, ph = _META["pose"]
    locs = np.stack([x_locs, y_locs], axis=1) / _META["split"]
    locs = locs / np.array([pw, ph], dtype=np.float32) * scale
    locs = locs + center - scale / 2.0
    locs[scores <= 0] = -1.0
    return locs, scores


def _detect_once(img, conf):
    """单次推理。返回 [{bbox, score, kpts, kpscore}]，坐标在原图像素空间。"""
    people = []
    for x1, y1, x2, y2, score in _det_infer(img, conf):
        if x2 - x1 < 2 or y2 - y1 < 2:
            continue
        kpts, kscores = _pose_infer(img, (x1, y1, x2, y2))
        people.append({
            "bbox": [x1, y1, x2, y2],
            "score": score,
            "kpts": kpts,
            "kpscore": kscores,
        })
    return people


# 正向检出为空时尝试的朝向：俯拍、倒挂、躺姿这类视角在 COCO 里几乎没有
_ROTATE_FALLBACKS = ("ccw", "cw", "180", "flip", "flip180")


def _rotate_and_map(img, kind):
    import cv2

    h, w = img.shape[:2]
    if kind == "ccw":
        return cv2.rotate(img, cv2.ROTATE_90_COUNTERCLOCKWISE), lambda xr, yr: ((w - 1) - yr, xr)
    if kind == "cw":
        return cv2.rotate(img, cv2.ROTATE_90_CLOCKWISE), lambda xr, yr: (yr, (h - 1) - xr)
    if kind == "180":
        return cv2.rotate(img, cv2.ROTATE_180), lambda xr, yr: ((w - 1) - xr, (h - 1) - yr)
    if kind == "flip":
        return cv2.flip(img, 1), lambda xr, yr: ((w - 1) - xr, yr)
    return cv2.rotate(cv2.flip(img, 1), cv2.ROTATE_180), lambda xr, yr: (xr, (h - 1) - yr)


def _remap_person(person, inverse, shape):
    h, w = shape[:2]
    kp = person["kpts"].copy()
    src = kp.copy()
    nx, ny = inverse(src[:, 0], src[:, 1])
    kp[:, 0] = np.array(nx, copy=True)
    kp[:, 1] = np.array(ny, copy=True)

    x1, y1, x2, y2 = person["bbox"]
    xs, ys = [], []
    for bx, by in ((x1, y1), (x2, y1), (x1, y2), (x2, y2)):
        px, py = inverse(bx, by)
        xs.append(float(px))
        ys.append(float(py))
    return {
        "bbox": [
            max(0.0, min(w, min(xs))),
            max(0.0, min(h, min(ys))),
            max(0.0, min(w, max(xs))),
            max(0.0, min(h, max(ys))),
        ],
        "score": person["score"],
        "kpts": kp,
        "kpscore": person["kpscore"],
    }


def _has_anchor(person):
    """有脸或胯才算可用检测，零散肢体拼出来的不算。"""
    x1, y1, x2, y2 = person["bbox"]
    if x2 - x1 < 2 or y2 - y1 < 2:
        return False
    names = [p[0] for p in _part_boxes(person["kpts"], person["kpscore"], y2 - y1, 1.0)]
    return "面部" in names or "胯部" in names


def _detect(img, conf=_CONF_DEFAULT):
    results = _detect_once(img, conf)
    if results:
        return results

    retry_conf = max(0.15, conf * 0.4)
    for kind in _ROTATE_FALLBACKS:
        rotated, inverse = _rotate_and_map(img, kind)
        candidates = _detect_once(rotated, retry_conf)
        if not candidates:
            continue
        mapped = [_remap_person(p, inverse, img.shape) for p in candidates]
        mapped = [p for p in mapped if _has_anchor(p)]
        if not mapped:
            continue
        mapped.sort(key=lambda r: -r["score"])
        print(f"[MOSS Pose] 正向未检出，按 {kind} 旋转后找到 {len(mapped)} 人")
        return mapped
    return []


# ---------------- 关键点 -> 六类框 ----------------

def _dist(a, b):
    return math.hypot(a[0] - b[0], a[1] - b[1])


def _box_around(center, size):
    size = max(size, 10.0)
    half = size / 2.0
    return [float(center[0] - half), float(center[1] - half), size, size]


def _group_box(kpts, scores, idx, min_count, pad, limit, body_h):
    """一组关键点取包围盒；点太少、太小或大到不合常理的，都不出框。"""
    pts = [kpts[i] for i in idx if scores[i] >= _KP_CONF]
    if len(pts) < min_count:
        return None
    xs = [float(p[0]) for p in pts]
    ys = [float(p[1]) for p in pts]
    x1, x2 = min(xs), max(xs)
    y1, y2 = min(ys), max(ys)
    w, h = x2 - x1, y2 - y1
    if w < 3 or h < 3:
        return None
    if max(w, h) > body_h * limit:      # 点散开了，说明这个部位没测准
        return None
    x1 -= w * pad
    x2 += w * pad
    y1 -= h * pad
    y2 += h * pad
    return [x1, y1, x2 - x1, y2 - y1]


# 关节框边长占「人体框高度」的比例
_R_ELBOW = 0.08
_R_KNEE = 0.08
_R_HIP_W = 1.35    # 相对两髋距离
_R_HIP_H = 0.12


def _part_boxes(kpts, scores, body_h, scale=1.0):
    """133 点 -> [(部位名, [x, y, w, h])]，不区分左右。"""
    unit = max(body_h, 8.0) * max(scale, 0.2)
    limit_h = max(body_h, 8.0)
    out = []

    face = _group_box(kpts, scores, FACE, 8, 0.12, 0.55, limit_h)
    if face:
        out.append(("面部", face))

    for idx in (HAND_L, HAND_R):
        box = _group_box(kpts, scores, idx, 6, 0.15, 0.5, limit_h)
        if box:
            out.append(("手部", box))

    for idx in (FOOT_L, FOOT_R):
        box = _group_box(kpts, scores, idx, 2, 0.15, 0.7, limit_h)
        if box:
            out.append(("脚部", box))

    for i in ELBOWS:
        if scores[i] >= _KP_CONF:
            out.append(("肘部", _box_around(kpts[i], unit * _R_ELBOW)))

    for i in KNEES:
        if scores[i] >= _KP_CONF:
            out.append(("膝部", _box_around(kpts[i], unit * _R_KNEE)))

    hips = [kpts[i] for i in HIPS if scores[i] >= _KP_CONF]
    if len(hips) == 2:
        d = _dist(hips[0], hips[1])
        cx = (float(hips[0][0]) + float(hips[1][0])) / 2.0
        cy = (float(hips[0][1]) + float(hips[1][1])) / 2.0
        bw = max(d * _R_HIP_W, unit * _R_HIP_H)
        bh = max(unit * _R_HIP_H, 10.0)
        out.append(("胯部", [cx - bw / 2.0, cy - bh / 2.0, bw, bh]))

    return out


# ---------------- 路由 ----------------

@PromptServer.instance.routes.get("/moss/pose/status")
async def moss_pose_status(request):
    """模型是否就绪 / 正在下载 / 已下载多少字节，前端轮询用。"""
    ready = _model_paths() is not None
    return web.json_response({
        "success": True,
        "ready": ready,
        "model": "DWPose（RTMW-x 133 点）" if ready else "",
        "default_model": "DWPose",
        "downloading": _download["busy"],
        "downloaded": _download["got"],
        "total": _download["total"],
        "file": _download["file"],
        "error": _download["error"],
    })


@PromptServer.instance.routes.post("/moss/pose/prepare")
async def moss_pose_prepare(request):
    """触发首次下载后立刻返回，前端轮询 status 看进度。"""
    if _model_paths() is not None:
        return web.json_response({"success": True, "ready": True, "downloading": False})
    if not _download["busy"]:
        _download["error"] = ""
        threading.Thread(target=_download_models, daemon=True).start()
    return web.json_response({
        "success": True,
        "ready": False,
        "downloading": True,
        "model": "DWPose",
    })


@PromptServer.instance.routes.post("/moss/pose")
async def moss_pose(request):
    try:
        payload = await request.json()
    except Exception:
        return web.json_response({"success": False, "error": "请求不是合法 JSON"}, status=400)

    data = payload.get("image") or ""
    try:
        conf = float(payload.get("conf") or _CONF_DEFAULT)
    except (TypeError, ValueError):
        conf = _CONF_DEFAULT
    conf = max(0.05, min(0.95, conf))
    try:
        scale = float(payload.get("scale") or 1.0)
    except (TypeError, ValueError):
        scale = 1.0
    scale = max(0.3, min(3.0, scale))

    if not isinstance(data, str) or "," not in data:
        return web.json_response({"success": False, "error": "缺少图片数据"}, status=400)
    if _model_paths() is None:
        # 直接调用这个接口（比如别的前端）时也要能自己把模型下下来，放到线程里不阻塞事件循环
        try:
            await asyncio.get_running_loop().run_in_executor(None, _download_models)
        except Exception as exc:
            return web.json_response(
                {"success": False, "error": f"模型缺失且自动下载失败：{exc}"},
                status=500,
            )

    try:
        import cv2

        raw = base64.b64decode(data.split(",", 1)[1])
        img = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
        if img is None:
            raise ValueError("解码为空")
    except Exception as exc:
        return web.json_response({"success": False, "error": f"图片解析失败：{exc}"}, status=400)

    try:
        people = _detect(img, conf)
    except Exception as exc:
        return web.json_response({"success": False, "error": f"推理失败：{exc}"}, status=500)

    height, width = img.shape[:2]
    boxes = []
    kept = 0
    for person in people:
        x1, y1, x2, y2 = person["bbox"]
        if x2 - x1 < 2 or y2 - y1 < 2:
            continue

        parts = _part_boxes(person["kpts"], person["kpscore"], y2 - y1, scale)
        names = [p[0] for p in parts]
        # 头和胯都没有，说明只是画面边缘的零散肢体被拼成了一个"人"，这种框全在别人身上
        if "面部" not in names and "胯部" not in names:
            print(f"[MOSS Pose] 跳过零散检测：score={person['score']:.2f} "
                  f"bbox=({x1:.0f},{y1:.0f})-({x2:.0f},{y2:.0f}) 部位={names}")
            continue

        kept += 1
        for part, (bx, by, bw, bh) in parts:
            if bw < 2 or bh < 2:
                continue
            boxes.append({
                "x": round(float(max(0.0, bx)), 1),
                "y": round(float(max(0.0, by)), 1),
                "width": round(float(bw), 1),
                "height": round(float(bh), 1),
                "part": part,
                "person": kept,
                "score": round(float(person["score"]), 3),
            })

    return web.json_response({
        "success": True,
        "people": kept,
        "detected": len(people),
        "boxes": boxes,
        "width": width,
        "height": height,
    })
