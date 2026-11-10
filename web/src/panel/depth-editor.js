/**
 * 深度图编辑器：在面板画布上叠加一层 8 位灰度图，用 5 档灰阶涂抹远近。
 *
 * 约定：白 = 近，黑 = 远（和 MiDaS / Depth-Anything / 主流 Depth ControlNet 一致）。
 * 未涂过的区域是中灰 128（中景/未指定）。
 *
 * 这个模块只管「光栅 + 工具条 + 指针事件」，画布缩放/平移仍由 floating-panel 负责。
 */

import { ensureTheme } from "../ui/theme.js";
import { hitRect, cursorForHit } from "./handles.js";

export const DEPTH_LEVELS = [
    { v: 255, name: "最近" },
    { v: 192, name: "近" },
    { v: 128, name: "中" },
    { v: 64, name: "远" },
    { v: 0, name: "最远" },
];

const DEFAULT_V = 128;
const MAX_UNDO = 20;
const STYLE_ID = "moss-depth-style";

function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
.moss-mode-bar {
    display: none; align-items: center; gap: 6px 8px; flex: 0 0 auto;
    flex-wrap: wrap; min-height: 32px; padding: 5px 8px; box-sizing: border-box;
    background: var(--moss-bg, #232428);
    border-bottom: 1px solid var(--moss-divider, #34363b);
    font-size: 11px; color: var(--moss-text-dim, #9aa0a8);
}
.moss-mode-bar.is-on { display: flex; }
.moss-depth-swatch {
    width: 24px; height: 20px; padding: 0; cursor: pointer;
    border: 1px solid #4a4d53; border-radius: 4px; flex: 0 0 auto;
    box-shadow: inset 0 0 0 1px rgba(0,0,0,.35);
}
.moss-depth-swatch.is-on { border-color: var(--moss-accent, #4dabf7); box-shadow: 0 0 0 1px var(--moss-accent, #4dabf7); }
.moss-mode-bar .moss-mode-btn {
    height: 22px; padding: 0 7px; flex: 0 0 auto;
    background: #2f3136; color: #ddd; border: 1px solid #45484e;
    border-radius: 5px; font-size: 11px; cursor: pointer;
}
.moss-mode-bar .moss-mode-btn:hover { background: #3a3d43; color: #fff; }
.moss-mode-bar .moss-mode-btn.is-on { background: #1f4f7a; border-color: #2b6ca3; color: #fff; }
.moss-mode-bar .moss-mode-btn:disabled { opacity: .4; cursor: default; }
/* 模式工具条里的通用小控件：背景图条也在用 */
.moss-mode-sep { width: 1px; height: 16px; background: #34363b; flex: 0 0 auto; }
.moss-mode-label { color: #8f959d; white-space: nowrap; flex: 0 0 auto; }
.moss-mode-bar label.moss-mode-btn { display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box; }
.moss-mode-bar input[type="range"] { width: 70px; accent-color: var(--moss-accent, #4dabf7); flex: 0 0 auto; }
.moss-mode-bar input.moss-mode-input {
    width: 46px; height: 20px; padding: 0 3px; box-sizing: border-box;
    background: #1a1b1e; color: #eee; border: 1px solid #45484e; border-radius: 4px;
    font-size: 11px; text-align: center; outline: none;
}
.moss-mode-bar input.moss-mode-input:focus { border-color: var(--moss-accent, #4dabf7); }
.moss-mode-bar input.moss-mode-input:disabled { opacity: .4; cursor: not-allowed; }
.moss-depth-num { min-width: 30px; text-align: right; font-variant-numeric: tabular-nums; }
.moss-depth-num.is-editable { cursor: text; border-bottom: 1px dashed transparent; }
.moss-depth-num.is-editable:hover { color: #fff; border-bottom-color: #6b7076; }
.moss-depth-num input {
    width: 34px; height: 18px; padding: 0 2px; box-sizing: border-box;
    background: #1a1b1e; color: #fff; border: 1px solid var(--moss-accent, #4dabf7);
    border-radius: 4px; font: inherit; font-size: 11px; text-align: right;
    font-variant-numeric: tabular-nums; outline: none;
}
.moss-depth-select {
    height: 22px; max-width: 96px; padding: 0 2px; flex: 0 0 auto;
    background: #2f3136; color: #ddd; border: 1px solid #45484e;
    border-radius: 5px; font-size: 11px; outline: none; cursor: pointer;
}
.moss-depth-select:disabled { opacity: .4; cursor: default; }
.moss-depth-select:hover { border-color: #666; color: #fff; }
.moss-depth-range { width: 86px; accent-color: var(--moss-accent, #4dabf7); }
.moss-depth-range.is-gray { width: 76px; }
.moss-depth-tip { color: #7d838c; }
`;
    document.head.appendChild(style);
}

function rgb(v) {
    return `rgb(${v},${v},${v})`;
}

function loadImage(url) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = url;
    });
}

export function createDepthEditor({
    canvas,
    getCanvasSize,
    physToLogic,
    logicToPhys,
    toast,
    onChange,
    onRedraw,
    onState,
    onHistoryChange,
    getSnapMode,
    getGridSize,
    getSelectedRect,
}) {
    ensureTheme();
    ensureStyle();

    const raster = document.createElement("canvas");
    const rctx = raster.getContext("2d", { willReadFrequently: true });

    let active = false;
    let dirty = false;
    let value = DEFAULT_V;
    let brush = 48;
    let eraser = false;
    let drawing = false;
    let last = null;
    let hover = null;
    let undoStack = [];
    let redoStack = [];
    let commitTimer = 0;

    // 导入的深度图当成独立图层：x/y/w/h 都是画布像素坐标，输出时按顺序合成。
    // 笔刷仍然画在底层的 raster 上，图层不参与撤销（撤销只回滚笔刷）。
    let layers = [];
    // 外部输入的深度图去过重的 key（面板恢复/清空后仍然记得，避免重复叠同一张）
    const injectedKeys = new Set();
    let activeLayer = -1;
    let tool = "brush"; // "brush" | "move"
    // 图层拖动 / 缩放：{ kind: "move"|"resize", handle, rect, sx, sy, dx, dy, unit }
    let layerOp = null;
    let layerGuides = []; // 吸附命中后要画的参考线 [{ axis, pos }]
    // 裁剪：只影响这一层的可见区域，原图位图不动，随时能拉回去
    let cropMode = false;
    let cropOp = null;

    // ---------- 重绘节流 ----------
    // 高回报率鼠标一帧能发十几条 mousemove，每条都整块重绘（底图 + 全部框 + 深度层）
    // 会明显掉帧。所有交互路径统一走这里：一帧最多画一次，状态在真正画的时候才读，
    // 所以中途合并掉的那些事件不会丢效果。
    let redrawRaf = 0;
    function requestRedraw() {
        if (!onRedraw || redrawRaf) return;
        redrawRaf = requestAnimationFrame(() => {
            redrawRaf = 0;
            onRedraw();
        });
    }

    // ---------- 光栅 ----------

    function ensureSize(w, h) {
        if (raster.width === w && raster.height === h && raster.width > 0) return;
        let snapshot = null;
        if (raster.width > 0 && raster.height > 0) {
            snapshot = document.createElement("canvas");
            snapshot.width = raster.width;
            snapshot.height = raster.height;
            snapshot.getContext("2d").drawImage(raster, 0, 0);
        }
        raster.width = Math.max(1, w);
        raster.height = Math.max(1, h);
        rctx.fillStyle = rgb(DEFAULT_V);
        rctx.fillRect(0, 0, raster.width, raster.height);
        if (snapshot) rctx.drawImage(snapshot, 0, 0, raster.width, raster.height);
    }

    const composeCanvas = document.createElement("canvas");

    // 撤销快照用 canvas 拷贝，不再 toDataURL：
    // 1248×832 的 PNG 编码要 10~30ms，每按一次笔都会先顿一下（这是笔刷「卡顿」的主因之一）；
    // 拷一张同样大小的 canvas 只要 1~2ms，画的时候直接 drawImage 回去，颜色也原样保留。
    function snapshotOf(src) {
        const cv = document.createElement("canvas");
        cv.width = Math.max(1, src.width);
        cv.height = Math.max(1, src.height);
        cv.getContext("2d").drawImage(src, 0, 0);
        return cv;
    }

    // 快照可能是 canvas（新）或 dataURL 字符串（空闲时压缩过的），两种都认
    function drawSnapshot(ctx, snap, w, h) {
        if (!snap) return Promise.resolve();
        if (typeof snap === "string") {
            return loadImage(snap)
                .then((img) => {
                    ctx.clearRect(0, 0, w, h);
                    ctx.drawImage(img, 0, 0, w, h);
                })
                .catch(() => {});
        }
        ctx.clearRect(0, 0, w, h);
        ctx.drawImage(snap, 0, 0, w, h);
        return Promise.resolve();
    }

    // 合成：笔刷层打底，再按顺序盖上可见图层
    function composeInto(target) {
        const { w, h } = getCanvasSize();
        ensureSize(w, h);
        target.width = raster.width;
        target.height = raster.height;
        const cctx = target.getContext("2d");
        cctx.clearRect(0, 0, target.width, target.height);
        cctx.imageSmoothingEnabled = true;
        cctx.drawImage(raster, 0, 0, target.width, target.height);
        for (const L of layers) {
            if (!L.visible) continue;
            if (L.crop) {
                cctx.save();
                cctx.beginPath();
                const cr = cropPixels(L);
                cctx.rect(
                    L.x + cr.x,
                    L.y + cr.y,
                    Math.max(1, cr.w),
                    Math.max(1, cr.h),
                );
                cctx.clip();
                cctx.drawImage(L.canvas, L.x, L.y, L.w, L.h);
                cctx.restore();
            } else {
                cctx.drawImage(L.canvas, L.x, L.y, L.w, L.h);
            }
        }
        return target;
    }

    function compositeUrl() {
        try {
            return composeInto(composeCanvas).toDataURL("image/png");
        } catch (_) {
            return "";
        }
    }

    // ---------- 撤销 / 重做（按操作类型记最小差量） ----------
    //   stroke    { target: "base" | index, before: dataURL }
    //   transform { index, before: {x,y,w,h} }        —— 十几字节
    //   crop      { index, before: crop|null }        —— 几十字节
    //   add       { index, layer }                    撤销=移除，重做=插回
    //   remove    { index, layer }                    撤销=插回，重做=移除
    //   clear     { base, layers }                    整体恢复
    // 位图只在「改像素 / 增删层 / 清空」时才编码，移动缩放裁剪不付这份代价。

    function cloneLayer(L) {
        const cv = document.createElement("canvas");
        cv.width = Math.max(1, L.canvas.width);
        cv.height = Math.max(1, L.canvas.height);
        const c = cv.getContext("2d");
        c.drawImage(L.canvas, 0, 0);
        return {
            canvas: cv,
            ctx: c,
            key: L.key || "",
            x: L.x,
            y: L.y,
            w: L.w,
            h: L.h,
            visible: true,
            crop: L.crop ? { ...L.crop } : null,
            name: L.name,
        };
    }

    function layerSnapshot(index) {
        const L = layers[index];
        return L ? snapshotOf(L.canvas) : null;
    }

    function pushEntry(entry) {
        if (!entry) return null;
        undoStack.push(entry);
        if (undoStack.length > MAX_UNDO) undoStack.shift();
        redoStack.length = 0;
        syncButtons();
        return entry;
    }

    // 快照先留在内存里当 canvas（快），等浏览器空闲再压成 PNG 字符串（省内存）。
    // 1M 像素的 canvas 约 4MB，20 步就是 80MB；压完只剩几十 KB。
    let shrinkTimer = 0;
    function shrinkEntriesSoon() {
        clearTimeout(shrinkTimer);
        shrinkTimer = setTimeout(() => {
            const run = () => {
                for (const stack of [undoStack, redoStack]) {
                    for (const e of stack) {
                        try {
                            if (e.type === "stroke" && e.before && typeof e.before !== "string") {
                                e.before = e.before.toDataURL("image/png");
                            } else if (e.type === "clear" && e.base && typeof e.base !== "string") {
                                e.base = e.base.toDataURL("image/png");
                            }
                        } catch (_) { /* 压不动就留着 canvas，撤销照样能用 */ }
                    }
                }
            };
            if (window.requestIdleCallback) window.requestIdleCallback(run, { timeout: 2000 });
            else run();
        }, 800);
    }

    // 笔刷 / 橡皮 / 填充：只存被改的那一张
    // 按下但没真正改动：把刚才那条记录撤掉，别占一格撤销
    function discardEntry(entry) {
        if (!entry) return;
        const i = undoStack.lastIndexOf(entry);
        if (i < 0) return;
        undoStack.splice(i, 1);
        syncButtons();
    }

    function pushStroke() {
        const isLayer = activeLayer >= 0 && !!layers[activeLayer];
        const entry = pushEntry({
            type: "stroke",
            target: isLayer ? activeLayer : "base",
            before: isLayer ? layerSnapshot(activeLayer) : snapshotOf(raster),
        });
        shrinkEntriesSoon();
        return entry;
    }

    function pushAddLayer(index) {
        if (!layers[index]) return null;
        // 不存位图：撤销时把被移除的这层 clone 进 redo 就够了
        return pushEntry({ type: "add", index });
    }

    function pushRemoveLayer(index) {
        const L = layers[index];
        if (!L) return null;
        return pushEntry({ type: "remove", index, layer: cloneLayer(L) });
    }

    function pushClear() {
        const entry = pushEntry({
            type: "clear",
            base: snapshotOf(raster),
            layers: layers.map((L) => cloneLayer(L)),
            keys: Array.from(injectedKeys),
        });
        shrinkEntriesSoon();
        return entry;
    }

    // 撤销时把「当前状态」抓成反向条目，redo 就能用同一套逻辑走回去
    function captureForEntry(entry) {
        switch (entry.type) {
            case "stroke": {
                const snap = entry.target === "base"
                    ? snapshotOf(raster)
                    : layerSnapshot(entry.target);
                return snap ? { ...entry, before: snap } : null;
            }
            case "transform": {
                const L = layers[entry.index];
                if (!L) return null;
                return { ...entry, before: { x: L.x, y: L.y, w: L.w, h: L.h } };
            }
            case "crop": {
                const L = layers[entry.index];
                if (!L) return null;
                return { ...entry, before: L.crop ? { ...L.crop } : null };
            }
            case "add": {
                const L = layers[entry.index];
                return L ? { ...entry, layer: cloneLayer(L) } : null;
            }
            case "remove":
                return { ...entry, layer: cloneLayer(entry.layer) };
            case "clear":
                return {
                    ...entry,
                    base: snapshotOf(raster),
                    layers: layers.map((L) => cloneLayer(L)),
                    keys: Array.from(injectedKeys),
                };
            default:
                return null;
        }
    }

    function afterRestore() {
        dirty = true;
        syncTools();
        rebuildLayerSelect();
        scheduleCommit();
        requestRedraw();
    }

    function applyEntry(entry, dir) {
        switch (entry.type) {
            case "stroke": {
                if (entry.target === "base") {
                    drawSnapshot(rctx, entry.before, raster.width, raster.height).then(afterRestore);
                } else {
                    const L = layers[entry.target];
                    if (!L) return;
                    drawSnapshot(L.ctx, entry.before, L.canvas.width, L.canvas.height)
                        .then(afterRestore);
                }
                return;
            }
            case "transform": {
                const L = layers[entry.index];
                if (!L) return;
                L.x = entry.before.x;
                L.y = entry.before.y;
                L.w = entry.before.w;
                L.h = entry.before.h;
                afterRestore();
                return;
            }
            case "crop": {
                const L = layers[entry.index];
                if (!L) return;
                L.crop = entry.before ? { ...entry.before } : null;
                afterRestore();
                return;
            }
            case "add": {
                if (dir === "undo") {
                    layers.splice(entry.index, 1);
                    activeLayer = layers.length ? Math.min(activeLayer, layers.length - 1) : -1;
                } else {
                    layers.splice(entry.index, 0, cloneLayer(entry.layer));
                    activeLayer = entry.index;
                }
                afterRestore();
                return;
            }
            case "remove": {
                if (dir === "undo") {
                    layers.splice(entry.index, 0, cloneLayer(entry.layer));
                    activeLayer = entry.index;
                } else {
                    layers.splice(entry.index, 1);
                    activeLayer = layers.length ? Math.min(entry.index, layers.length - 1) : -1;
                }
                afterRestore();
                return;
            }
            case "clear": {
                drawSnapshot(rctx, entry.base, raster.width, raster.height).then(() => {
                    layers = entry.layers.map((L) => cloneLayer(L));
                    activeLayer = layers.length ? layers.length - 1 : -1;
                    injectedKeys.clear();
                    (entry.keys || []).forEach((k) => injectedKeys.add(k));
                    afterRestore();
                });
                return;
            }
            default:
                return;
        }
    }

    function undo() {
        const entry = undoStack.pop();
        if (!entry) return;
        const cur = captureForEntry(entry);
        if (cur) redoStack.push(cur);
        applyEntry(entry, "undo");
        syncButtons();
        shrinkEntriesSoon(); // 反向条目也是 canvas，空闲时一起压掉
    }

    function redo() {
        const entry = redoStack.pop();
        if (!entry) return;
        const cur = captureForEntry(entry);
        if (cur) undoStack.push(cur);
        applyEntry(entry, "redo");
        syncButtons();
        shrinkEntriesSoon();
    }

    // ---------- 提交 ----------

    // 图层结构（笔刷层 + 每张图层的位图和位置）没法从合成图里还原，
    // 单独存一份给前端恢复用：写进 node.properties，跟着工作流走，不占控件空间。
    let persistTimer = 0;
    function persistState(delay = 700) {
        if (!onState) return;
        clearTimeout(persistTimer);
        persistTimer = setTimeout(() => {
            if (window.requestIdleCallback) window.requestIdleCallback(encodeState, { timeout: 2500 });
            else encodeState();
        }, delay);
    }

    // 把笔刷层和每张图层都 toDataURL 一遍，最重的一步，所以只放在空闲时做
    function encodeState() {
        try {
            onState({
                v: 1,
                base: raster.toDataURL("image/png"),
                layers: layers.map((L) => ({
                    png: L.canvas.toDataURL("image/png"),
                    x: L.x,
                    y: L.y,
                    w: L.w,
                    h: L.h,
                    name: L.name,
                    key: L.key || "",
                    crop: L.crop
                        ? { x: L.crop.x, y: L.crop.y, w: L.crop.w, h: L.crop.h }
                        : null,
                })),
            });
        } catch (err) {
            console.warn("[MOSS] 深度图层保存失败:", err);
        }
    }

    // 回写 depth_png 要整张合成 + toDataURL（10~30ms），正好卡在抬笔那一刻会明显顿一下。
    // 所以先等 600ms 确认不再画了，再挑浏览器空闲的时候做；图层结构编码更重，再往后放。
    function scheduleCommit(delay = 600) {
        clearTimeout(commitTimer);
        commitTimer = setTimeout(runCommit, delay);
    }

    function runCommit() {
        const doIt = () => {
            const url = compositeUrl();
            if (url) onChange?.(url);
            persistState(900);
        };
        if (window.requestIdleCallback) window.requestIdleCallback(doIt, { timeout: 1500 });
        else doIt();
    }

    function flushCommit() {
        clearTimeout(commitTimer);
        const url = compositeUrl();
        if (url) onChange?.(url);
        persistState(0);
    }

    // 从 node.properties 恢复：笔刷层 + 图层（刷新浏览器、重开工作流都不丢图层）
    async function restoreState(state) {
        if (!state) return false;
        const { w, h } = getCanvasSize();
        ensureSize(w, h);

        layers = [];
        injectedKeys.clear();
        activeLayer = -1;

        if (state.base) {
            try {
                const img = await loadImage(state.base);
                rctx.clearRect(0, 0, raster.width, raster.height);
                rctx.drawImage(img, 0, 0, raster.width, raster.height);
            } catch (_) { /* 笔刷层读不出来就保持现状 */ }
        } else {
            rctx.fillStyle = rgb(DEFAULT_V);
            rctx.fillRect(0, 0, raster.width, raster.height);
        }

        const items = Array.isArray(state.layers) ? state.layers : [];
        for (const d of items) {
            if (!d || !d.png) continue;
            try {
                const img = await loadImage(d.png);
                const cw = Math.max(1, Math.round(d.w || img.width));
                const ch = Math.max(1, Math.round(d.h || img.height));
                const cv = document.createElement("canvas");
                cv.width = cw;
                cv.height = ch;
                cv.getContext("2d").drawImage(img, 0, 0, cw, ch);
                layers.push({
                    canvas: cv,
                    ctx: cv.getContext("2d"),
                    key: d.key || "",
                    x: Math.round(d.x || 0),
                    y: Math.round(d.y || 0),
                    w: cw,
                    h: ch,
                    visible: true,
                    crop: d.crop
                        ? (() => {
                            let cx = Number(d.crop.x) || 0;
                            let cy = Number(d.crop.y) || 0;
                            let cw2 = Number(d.crop.w) || 1;
                            let ch2 = Number(d.crop.h) || 1;
                            // 老数据有两种：画布绝对坐标 / 相对像素。都不是比例就先换算。
                            if (cx + cw2 > cw * 1.05 || cy + ch2 > ch * 1.05) {
                                cx -= Math.round(d.x || 0);
                                cy -= Math.round(d.y || 0);
                                cx /= cw;
                                cy /= ch;
                                cw2 /= cw;
                                ch2 /= ch;
                            } else if (cw2 > 1.05 || ch2 > 1.05 || cx > 1.05 || cy > 1.05) {
                                cx /= cw;
                                cy /= ch;
                                cw2 /= cw;
                                ch2 /= ch;
                            }
                            const clamp01 = (v) => Math.min(1, Math.max(0, v));
                            cx = clamp01(cx);
                            cy = clamp01(cy);
                            cw2 = clamp01(cw2) || 1;
                            ch2 = clamp01(ch2) || 1;
                            if (cx + cw2 > 1) cw2 = 1 - cx;
                            if (cy + ch2 > 1) ch2 = 1 - cy;
                            return { x: cx, y: cy, w: Math.max(0.01, cw2), h: Math.max(0.01, ch2) };
                        })()
                        : null,
                    name: d.name || `图层 ${layers.length + 1}`,
                });
                if (d.key) injectedKeys.add(d.key);
            } catch (_) { /* 单张坏了就跳过 */ }
        }

        activeLayer = layers.length ? layers.length - 1 : -1;
        tool = layers.length ? "move" : "brush";
        rebuildLayerSelect();
        syncTools();
        syncCursor();
        dirty = !!state.base || layers.length > 0;
        requestRedraw();
        return true;
    }

    // ---------- 绘制 ----------

    function paintTo(px, py) {
        const color = rgb(value);
        // 选中图层时直接画在这一层上；选「笔刷层」（activeLayer = -1）时画在底层
        const target = activeLayer >= 0 ? layers[activeLayer] : null;
        const c = target ? target.ctx : rctx;
        const ox = target ? target.x : 0;
        const oy = target ? target.y : 0;
        const x = px - ox;
        const y = py - oy;
        c.strokeStyle = color;
        c.fillStyle = color;
        c.lineWidth = brush;
        c.lineCap = "round";
        c.lineJoin = "round";
        if (last) {
            c.beginPath();
            c.moveTo(last.x, last.y);
            c.lineTo(x, y);
            c.stroke();
        } else {
            c.beginPath();
            c.arc(x, y, Math.max(0.5, brush / 2), 0, Math.PI * 2);
            c.fill();
        }
        last = { x, y };
    }

    function draw(ctx, l2p) {
        const { w, h } = getCanvasSize();
        ensureSize(w, h);
        if (!active) return;

        const p1 = l2p(-w / 2, -h / 2);
        const p2 = l2p(w / 2, h / 2);
        const pw = p2.x - p1.x;
        const ph = p2.y - p1.y;

        ctx.save();
        ctx.globalAlpha = 0.92;
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(raster, p1.x, p1.y, pw, ph);
        if (layers.length && pw > 0 && h > 0) {
            // 裁到画布内：图层被拖到边界外时不该溢出到画布外面
            ctx.beginPath();
            ctx.rect(p1.x, p1.y, pw, ph);
            ctx.clip();
            const sx = pw / w;
            const sy = ph / h;
            for (const L of layers) {
                if (!L.visible) continue;
                if (L.crop) {
                    ctx.save();
                    ctx.beginPath();
                    const cr = cropPixels(L);
                    ctx.rect(
                        p1.x + (L.x + cr.x) * sx,
                        p1.y + (L.y + cr.y) * sy,
                        Math.max(1, cr.w * sx),
                        Math.max(1, cr.h * sy),
                    );
                    ctx.clip();
                    ctx.drawImage(L.canvas, p1.x + L.x * sx, p1.y + L.y * sy, L.w * sx, L.h * sy);
                    ctx.restore();
                } else {
                    ctx.drawImage(L.canvas, p1.x + L.x * sx, p1.y + L.y * sy, L.w * sx, L.h * sy);
                }
            }
        }
        ctx.restore();

        // 移动工具下：选中图层描虚线框 + 8 个控制点
        if (tool === "move" && activeLayer >= 0 && layers[activeLayer] && pw > 0) {
            const L = layers[activeLayer];
            const sx = pw / w;
            const sy = ph / h;
            const rx = p1.x + L.x * sx;
            const ry = p1.y + L.y * sy;
            const rw = L.w * sx;
            const rh = L.h * sy;
            ctx.save();
            ctx.setLineDash([4, 3]);
            ctx.strokeStyle = "rgba(77,171,247,.9)";
            ctx.lineWidth = 1;
            ctx.strokeRect(rx + 0.5, ry + 0.5, Math.max(0, rw - 1), Math.max(0, rh - 1));
            ctx.setLineDash([]);
            ctx.fillStyle = "#4dabf7";
            ctx.strokeStyle = "#0d1b2a";
            for (const [, hx, hy] of layerHandles(L)) {
                const x = p1.x + hx * sx;
                const y = p1.y + hy * sy;
                ctx.beginPath();
                ctx.rect(x - 3, y - 3, 6, 6);
                ctx.fill();
                ctx.stroke();
            }
            ctx.restore();
        }

        // 裁剪模式：橙色框 + 8 个控制点
        if (cropMode && activeLayer >= 0 && layers[activeLayer] && pw > 0) {
            const L = layers[activeLayer];
            const c = cropPixels(L);
            const sx = pw / w;
            const sy = ph / h;
            const rx = p1.x + (L.x + c.x) * sx;
            const ry = p1.y + (L.y + c.y) * sy;
            const rw = c.w * sx;
            const rh = c.h * sy;
            ctx.save();
            // 被裁掉的部分压暗（只在图层范围内）
            ctx.fillStyle = "rgba(0,0,0,.45)";
            const lx = p1.x + L.x * sx;
            const ly = p1.y + L.y * sy;
            const lw = L.w * sx;
            const lh = L.h * sy;
            ctx.beginPath();
            ctx.rect(lx, ly, lw, lh);
            ctx.rect(rx, ry, rw, rh);
            ctx.fill("evenodd");
            ctx.setLineDash([4, 3]);
            ctx.strokeStyle = "#ffa94d";
            ctx.lineWidth = 1;
            ctx.strokeRect(rx + 0.5, ry + 0.5, Math.max(0, rw - 1), Math.max(0, rh - 1));
            ctx.setLineDash([]);
            ctx.fillStyle = "#ffa94d";
            ctx.strokeStyle = "#2a1a06";
            for (const [, hx, hy] of layerHandles(c)) {
                ctx.beginPath();
                ctx.rect(p1.x + (L.x + hx) * sx - 3, p1.y + (L.y + hy) * sy - 3, 6, 6);
                ctx.fill();
                ctx.stroke();
            }
            ctx.restore();
        }

        // 吸附参考线
        if (layerGuides.length && pw > 0) {
            ctx.save();
            ctx.setLineDash([5, 4]);
            ctx.strokeStyle = "rgba(77,171,247,.7)";
            ctx.lineWidth = 1;
            for (const g of layerGuides) {
                ctx.beginPath();
                if (g.axis === "x") {
                    const x = Math.round(p1.x + g.pos * (pw / w)) + 0.5;
                    ctx.moveTo(x, p1.y);
                    ctx.lineTo(x, p1.y + ph);
                } else {
                    const y = Math.round(p1.y + g.pos * (ph / h)) + 0.5;
                    ctx.moveTo(p1.x, y);
                    ctx.lineTo(p1.x + pw, y);
                }
                ctx.stroke();
            }
            ctx.restore();
        }

        ctx.save();
        ctx.strokeStyle = "rgba(255,255,255,.22)";
        ctx.lineWidth = 1;
        ctx.strokeRect(p1.x + 0.5, p1.y + 0.5, pw - 1, ph - 1);
        ctx.restore();

        if (hover && pw > 0 && tool !== "move" && !cropMode) {
            const scale = pw / w;
            const c = l2p(hover.x, hover.y);
            ctx.save();
            ctx.beginPath();
            ctx.arc(c.x, c.y, Math.max(1.5, (brush / 2) * scale), 0, Math.PI * 2);
            ctx.strokeStyle = eraser ? "rgba(255,120,120,.9)" : "rgba(255,255,255,.9)";
            ctx.lineWidth = 1.2;
            ctx.stroke();
            ctx.restore();
        }
    }

    // ---------- 指针 ----------

    function toRaster(px, py) {
        const { w, h } = getCanvasSize();
        ensureSize(w, h);
        const l = physToLogic(px, py);
        return { x: l.x + w / 2, y: l.y + h / 2, w, h };
    }

    // 8 个控制点（四角 + 四边中点）
    function layerHandles(L) {
        const cx = L.x + L.w / 2;
        const cy = L.y + L.h / 2;
        return [
            ["tl", L.x, L.y], ["t", cx, L.y], ["tr", L.x + L.w, L.y],
            ["l", L.x, cy], ["r", L.x + L.w, cy],
            ["bl", L.x, L.y + L.h], ["b", cx, L.y + L.h], ["br", L.x + L.w, L.y + L.h],
        ];
    }

    function hitHandle(L, x, y, tol) {
        const hit = hitRect(L.x, L.y, L.x + L.w, L.y + L.h, x, y, tol);
        // hitRect 把「框内」判成 move，这里只要真正的控制点，
        // 否则 pointerDown 会把它当成 resize，图层就再也拖不动了
        return hit && hit !== "move" ? hit : null;
    }

    // 图层的吸附目标：画布四边 + 中线，加上其它图层的边和中线
    function layerSnapTargets(exceptIndex) {
        const { w, h } = getCanvasSize();
        const xs = [0, w / 2, w];
        const ys = [0, h / 2, h];
        layers.forEach((L, i) => {
            if (i === exceptIndex || !L.visible) return;
            xs.push(L.x, L.x + L.w / 2, L.x + L.w);
            ys.push(L.y, L.y + L.h / 2, L.y + L.h);
        });
        return { xs, ys };
    }

    // 把矩形按吸附目标微调一点；返回实际生效的参考线。
    // 目标由顶部的「无 / 对象 / 网格」决定：none 直接不吸，grid 吸网格线，object 吸画布和图层边线。
    function applyLayerSnap(rect, exceptIndex, threshold) {
        const mode = getSnapMode ? getSnapMode() : "object";
        if (mode === "none") return [];
        const grid = Math.max(2, getGridSize ? getGridSize() : 8);
        const targets = mode === "grid" ? null : layerSnapTargets(exceptIndex);
        const guides = [];
        const pick = (candidates, list) => {
            let best = null;
            const test = (c, t) => {
                const d = t - c;
                if (Math.abs(d) <= threshold && (!best || Math.abs(d) < Math.abs(best.d))) {
                    best = { d, pos: t };
                }
            };
            for (const c of candidates) {
                if (list) {
                    for (const t of list) test(c, t);
                } else {
                    test(c, Math.round(c / grid) * grid);
                }
            }
            return best;
        };
        const bx = pick([rect.x, rect.x + rect.w / 2, rect.x + rect.w], targets ? targets.xs : null);
        if (bx) {
            rect.x += bx.d;
            guides.push({ axis: "x", pos: bx.pos });
        }
        const by = pick([rect.y, rect.y + rect.h / 2, rect.y + rect.h], targets ? targets.ys : null);
        if (by) {
            rect.y += by.d;
            guides.push({ axis: "y", pos: by.pos });
        }
        return guides;
    }

    function screenUnit(px, py) {
        const a = toRaster(px, py);
        const b = toRaster(px + 1, py);
        return Math.max(0.01, Math.abs(b.x - a.x));
    }

    function snapEdge(value, list, threshold) {
        const mode = getSnapMode ? getSnapMode() : "object";
        if (mode === "none") return null;
        if (mode === "grid") {
            const grid = Math.max(2, getGridSize ? getGridSize() : 8);
            const t = Math.round(value / grid) * grid;
            const d = t - value;
            return Math.abs(d) <= threshold ? { d, pos: t } : null;
        }
        let best = null;
        for (const t of list) {
            const d = t - value;
            if (Math.abs(d) <= threshold && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, pos: t };
        }
        return best;
    }

    // crop 存的是**比例**（0~1，相对图层宽高）。这样图层移动、缩放时，
    // 裁剪窗口都按同一比例跟着走，不会出现「拖动了框不跟 / 缩放了框不缩」。
    // 画的时候换算成图层像素，交互时换算成画布绝对坐标。
    function cropPixels(L) {
        const c = L.crop;
        if (!c) return { x: 0, y: 0, w: L.w, h: L.h };
        return { x: c.x * L.w, y: c.y * L.h, w: c.w * L.w, h: c.h * L.h };
    }

    function cropAbs(L) {
        const c = cropPixels(L);
        return { x: L.x + c.x, y: L.y + c.y, w: c.w, h: c.h };
    }

    function setCropAbs(L, r) {
        const x1 = Math.max(L.x, Math.min(r.x, L.x + L.w - 8));
        const y1 = Math.max(L.y, Math.min(r.y, L.y + L.h - 8));
        const x2 = Math.min(L.x + L.w, Math.max(x1 + 8, r.x + r.w));
        const y2 = Math.min(L.y + L.h, Math.max(y1 + 8, r.y + r.h));
        L.crop = {
            x: (x1 - L.x) / L.w,
            y: (y1 - L.y) / L.h,
            w: (x2 - x1) / L.w,
            h: (y2 - y1) / L.h,
        };
    }

    function hitLayer(x, y) {
        for (let i = layers.length - 1; i >= 0; i -= 1) {
            const L = layers[i];
            if (!L.visible) continue;
            if (x >= L.x && x <= L.x + L.w && y >= L.y && y <= L.y + L.h) return i;
        }
        return -1;
    }

    function pointerDown(ev, px, py) {
        if (!active) return false;
        if (ev && ev.button !== 0) return false;
        const p = toRaster(px, py);
        const insideCanvas = p.x >= 0 && p.y >= 0 && p.x <= p.w && p.y <= p.h;

        if (cropMode) {
            const L = activeLayer >= 0 ? layers[activeLayer] : null;
            if (!L) {
                toast?.show?.("先选中一个图层再裁剪", 1600);
                return true;
            }
            if (!L.crop) L.crop = { x: 0, y: 0, w: 1, h: 1 };
            const unit = screenUnit(px, py);
            const abs = cropAbs(L);
            const handle = hitHandle(abs, p.x, p.y, 8 * unit);
            if (handle) {
                cropOp = { kind: "resize", handle, rect: abs, sx: p.x, sy: p.y };
                cropOp.pending = {
                    type: "crop",
                    index: activeLayer,
                    before: L.crop ? { ...L.crop } : null,
                };
                requestRedraw();
                return true;
            }
            if (p.x >= abs.x && p.x <= abs.x + abs.w
                && p.y >= abs.y && p.y <= abs.y + abs.h) {
                cropOp = { kind: "move", rect: abs, sx: p.x, sy: p.y };
                cropOp.pending = {
                    type: "crop",
                    index: activeLayer,
                    before: L.crop ? { ...L.crop } : null,
                };
                requestRedraw();
                return true;
            }
            return true;
        }

        // 移动工具：先判控制点和图层，再判画布边界。
        // 图层被拖到边界外时，控制点也在画布外，不能被「画布外拖动 = 平移画布」抢走。
        if (tool === "move") {
            if (!layers.length) {
                if (insideCanvas) toast?.show?.("还没有图层 · 先点「导入」加一张深度图", 1800);
                return false;
            }
            const unit = screenUnit(px, py);
            // 先看是不是点在当前图层的控制点上（缩放）
            const cur = activeLayer >= 0 ? layers[activeLayer] : null;
            const handle = cur ? hitHandle(cur, p.x, p.y, 8 * unit) : null;
            if (cur && handle) {
                layerOp = {
                    kind: "resize",
                    handle,
                    rect: { x: cur.x, y: cur.y, w: cur.w, h: cur.h },
                    sx: p.x,
                    sy: p.y,
                    unit,
                };
                layerOp.pending = {
                    type: "transform",
                    index: activeLayer,
                    before: { x: cur.x, y: cur.y, w: cur.w, h: cur.h },
                };
                syncTools();
                requestRedraw();
                return true;
            }
            const hit = hitLayer(p.x, p.y);
            if (hit < 0) {
                // 画布内点空白：留在深度模式，别顺手建框；画布外交还给平移
                if (insideCanvas) {
                    toast?.show?.("点到图层外面了 · 对准图再拖", 1400);
                    return true;
                }
                return false;
            }
            activeLayer = hit;
            const L = layers[hit];
            layerOp = {
                kind: "move",
                handle: null,
                rect: { x: L.x, y: L.y, w: L.w, h: L.h },
                sx: p.x,
                sy: p.y,
                unit,
            };
            layerOp.pending = {
                type: "transform",
                index: activeLayer,
                before: { x: L.x, y: L.y, w: L.w, h: L.h },
            };
            syncTools();
            requestRedraw();
            return true;
        }

        if (!insideCanvas) return false;
        pushStroke();
        dirty = true;
        last = null;
        paintTo(p.x, p.y);
        drawing = true;
        hover = { x: p.x - p.w / 2, y: p.y - p.h / 2 };
        requestRedraw();
        return true;
    }

    function pointerMove(ev, px, py) {
        if (!active) return false;
        const p = toRaster(px, py);

        if (cropMode) {
            // 没在拖：只把光标换成控制点对应的方向，顺手清掉笔刷圆环
            if (!cropOp || activeLayer < 0 || !layers[activeLayer]) {
                hover = null;
                const L = activeLayer >= 0 ? layers[activeLayer] : null;
                if (canvas && L) {
                    const abs = cropAbs(L);
                    const h = hitHandle(abs, p.x, p.y, 8 * screenUnit(px, py));
                    if (h) {
                        canvas.style.cursor = cursorForHit(h, "crosshair");
                    } else if (p.x >= abs.x && p.x <= abs.x + abs.w
                        && p.y >= abs.y && p.y <= abs.y + abs.h) {
                        canvas.style.cursor = "move";
                    } else {
                        canvas.style.cursor = "crosshair";
                    }
                }
                requestRedraw();
                return true;
            }
            const L = layers[activeLayer];
            const r = cropOp.rect;
            const dx = p.x - cropOp.sx;
            const dy = p.y - cropOp.sy;
            if (!cropOp.entry && cropOp.pending) cropOp.entry = pushEntry(cropOp.pending);
            let next;
            if (cropOp.kind === "move") {
                next = { x: r.x + dx, y: r.y + dy, w: r.w, h: r.h };
            } else {
                let l = r.x;
                let t = r.y;
                let rr = r.x + r.w;
                let bb = r.y + r.h;
                if (cropOp.handle.includes("l")) l = Math.min(rr - 8, r.x + dx);
                if (cropOp.handle.includes("r")) rr = Math.max(l + 8, r.x + r.w + dx);
                if (cropOp.handle.includes("t")) t = Math.min(bb - 8, r.y + dy);
                if (cropOp.handle.includes("b")) bb = Math.max(t + 8, r.y + r.h + dy);
                next = { x: l, y: t, w: rr - l, h: bb - t };
            }
            setCropAbs(L, next);
            requestRedraw();
            return true;
        }

        if (tool === "move") {
            if (!layerOp && canvas) {
                const unit = screenUnit(px, py);
                const cur = activeLayer >= 0 ? layers[activeLayer] : null;
                const h = cur ? hitHandle(cur, p.x, p.y, 8 * unit) : null;
                canvas.style.cursor = h
                    ? cursorForHit(h, "move")
                    : (hitLayer(p.x, p.y) >= 0 ? "move" : "default");
            }
            if (!layerOp || activeLayer < 0 || !layers[activeLayer]) return true;
            const L = layers[activeLayer];
            const op = layerOp;
            const noSnap = !!(ev && ev.altKey);
            if (!op.entry && op.pending) op.entry = pushEntry(op.pending);
            if (op.kind === "move") {
                const rect = {
                    x: op.rect.x + (p.x - op.sx),
                    y: op.rect.y + (p.y - op.sy),
                    w: op.rect.w,
                    h: op.rect.h,
                };
                layerGuides = noSnap ? [] : applyLayerSnap(rect, activeLayer, 6 * op.unit);
                L.x = Math.round(rect.x);
                L.y = Math.round(rect.y);
            } else {
                const dx = p.x - op.sx;
                const dy = p.y - op.sy;
                const r = op.rect;
                let l = r.x;
                let t = r.y;
                let rr = r.x + r.w;
                let bb = r.y + r.h;
                if (op.handle.includes("l")) l = Math.min(rr - 8, r.x + dx);
                if (op.handle.includes("r")) rr = Math.max(l + 8, r.x + r.w + dx);
                if (op.handle.includes("t")) t = Math.min(bb - 8, r.y + dy);
                if (op.handle.includes("b")) bb = Math.max(t + 8, r.y + r.h + dy);
                const rect = { x: l, y: t, w: rr - l, h: bb - t };

                // 四角等比缩放：以对角为锚点，按拖得更远的那一边缩放
                if (op.handle.length === 2 && r.w > 0 && r.h > 0) {
                    const ratio = r.w / r.h;
                    let nw = rect.w;
                    let nh = rect.h;
                    if (nw / nh > ratio) nh = nw / ratio;
                    else nw = nh * ratio;
                    if (op.handle.includes("l")) rect.x = r.x + r.w - nw;
                    if (op.handle.includes("t")) rect.y = r.y + r.h - nh;
                    rect.w = nw;
                    rect.h = nh;
                }

                layerGuides = [];
                if (!noSnap) {
                    // 缩放只对齐正在拖的那条边，避免整块位置乱跳
                    const th = 6 * op.unit;
                    const snapGrid = (getSnapMode ? getSnapMode() : "object") === "grid";
                    const tg = snapGrid
                        ? { xs: [], ys: [] }
                        : layerSnapTargets(activeLayer);
                    if (op.handle.includes("l")) {
                        const g = snapEdge(rect.x, tg.xs, th);
                        if (g) {
                            rect.x += g.d;
                            rect.w -= g.d;
                            layerGuides.push({ axis: "x", pos: g.pos });
                        }
                    } else if (op.handle.includes("r")) {
                        const g = snapEdge(rect.x + rect.w, tg.xs, th);
                        if (g) {
                            rect.w += g.d;
                            layerGuides.push({ axis: "x", pos: g.pos });
                        }
                    }
                    if (op.handle.includes("t")) {
                        const g = snapEdge(rect.y, tg.ys, th);
                        if (g) {
                            rect.y += g.d;
                            rect.h -= g.d;
                            layerGuides.push({ axis: "y", pos: g.pos });
                        }
                    } else if (op.handle.includes("b")) {
                        const g = snapEdge(rect.y + rect.h, tg.ys, th);
                        if (g) {
                            rect.h += g.d;
                            layerGuides.push({ axis: "y", pos: g.pos });
                        }
                    }
                }
                L.x = Math.round(rect.x);
                L.y = Math.round(rect.y);
                L.w = Math.max(8, Math.round(rect.w));
                L.h = Math.max(8, Math.round(rect.h));
            }
            requestRedraw();
            return true;
        }

        hover = { x: p.x - p.w / 2, y: p.y - p.h / 2 };
        if (drawing) {
            paintTo(p.x, p.y);
            dirty = true;
        }
        requestRedraw();
        return true;
    }

    function pointerUp() {
        if (cropOp) {
            const e = cropOp.entry;
            const L = layers[activeLayer];
            if (e && L) {
                const b = e.before;
                const c = L.crop;
                const same = b
                    ? (c && c.x === b.x && c.y === b.y && c.w === b.w && c.h === b.h)
                    : !c;
                if (same) discardEntry(e);
            }
            cropOp = null;
            scheduleCommit(120);
            requestRedraw();
            return true;
        }
        if (layerOp) {
            const e = layerOp.entry;
            const L = layers[activeLayer];
            if (e && L
                && L.x === e.before.x && L.y === e.before.y
                && L.w === e.before.w && L.h === e.before.h) {
                discardEntry(e);
            }
            layerOp = null;
            layerGuides = [];
            syncCursor();
            scheduleCommit(120);
            requestRedraw();
            return true;
        }
        if (!drawing) return false;
        drawing = false;
        last = null;
        scheduleCommit(120);
        return true;
    }

    function pointerLeave() {
        hover = null;
        if (drawing || layerOp || cropOp) pointerUp();
        requestRedraw();
    }

    // ---------- 操作 ----------

    // 退出裁剪模式（切工具 / 选颜色 / 清空等都要走这里，否则裁剪模式会一直挂着）
    function closeCropMode() {
        if (!cropMode) return;
        cropMode = false;
        cropOp = null;
        const L = activeLayer >= 0 ? layers[activeLayer] : null;
        // 拉满整层就等于没裁
        if (L && L.crop
            && Math.abs(L.crop.x) < 1e-3 && Math.abs(L.crop.y) < 1e-3
            && Math.abs(L.crop.w - 1) < 1e-3 && Math.abs(L.crop.h - 1) < 1e-3) {
            L.crop = null;
        }
        scheduleCommit(80);
    }

    function setValue(v) {
        value = v;
        eraser = false;
        tool = "brush"; // 选颜色就是要画，从移动工具退回来
        closeCropMode(); // 裁剪模式也要退，否则点了色块也画不上
        syncTools();
        syncCursor();
    }

    function clearAll() {
        pushClear();
        rctx.fillStyle = rgb(DEFAULT_V);
        rctx.fillRect(0, 0, raster.width, raster.height);
        layers = [];
        activeLayer = -1;
        tool = "brush";
        cropMode = false;
        cropOp = null;
        // 清空等于把面板复位：外部深度图的去重记录也清掉，重新执行才能再注入一次
        injectedKeys.clear();
        syncTools();
        rebuildLayerSelect();
        syncCursor();
        dirty = true;
        scheduleCommit(80);
        requestRedraw();
    }

    function fillSelected() {
        const rect = getSelectedRect?.();
        if (!rect) {
            toast?.show?.("先在「框选」模式里选中一个框", 1600);
            return;
        }
        const { w, h } = getCanvasSize();
        ensureSize(w, h);
        pushStroke();
        const L = activeLayer >= 0 ? layers[activeLayer] : null;
        const c = L ? L.ctx : rctx;
        const ox = L ? L.x : 0;
        const oy = L ? L.y : 0;
        const cx = rect.x + rect.w / 2 + w / 2 - ox;
        const cy = rect.y + rect.h / 2 + h / 2 - oy;
        c.fillStyle = rgb(value);
        c.beginPath();
        c.ellipse(cx, cy, Math.max(1, Math.abs(rect.w) / 2),
                  Math.max(1, Math.abs(rect.h) / 2), 0, 0, Math.PI * 2);
        c.fill();
        dirty = true;
        scheduleCommit(80);
        requestRedraw();
    }

    async function importBlob(blob) {
        if (!blob) return false;
        let img;
        try {
            const url = URL.createObjectURL(blob);
            img = await loadImage(url);
            URL.revokeObjectURL(url);
        } catch (_) {
            toast?.show?.("这张图读不出来", 1800);
            return false;
        }

        return addLayerFromImage(img, "");

    }

    // 把一张 Image 变成图层。key 用来去重：同一个来源（外部输入的深度图）只加一次
    function addLayerFromImage(img, key = "", { commit = true } = {}) {
        if (!img) return false;
        if (key) {
            if (injectedKeys.has(key)) return false;
            injectedKeys.add(key);
        }

        const { w, h } = getCanvasSize();
        ensureSize(w, h);

        // 按原比例缩到画布内（大于画布就缩小，小于画布保持原始像素），
        // 然后作为独立图层叠上去——不再覆盖已经画好的笔刷层。
        const scale = Math.min(1, w / img.width, h / img.height);
        const lw = Math.max(8, Math.round(img.width * scale));
        const lh = Math.max(8, Math.round(img.height * scale));

        const cv = document.createElement("canvas");
        cv.width = lw;
        cv.height = lh;
        const cctx = cv.getContext("2d", { willReadFrequently: true });
        cctx.drawImage(img, 0, 0, lw, lh);
        const data = cctx.getImageData(0, 0, lw, lh);
        const d = data.data;
        let colorful = false;
        for (let i = 0; i < d.length; i += 4) {
            const r = d[i], g = d[i + 1], b = d[i + 2];
            if (Math.abs(r - g) > 12 || Math.abs(g - b) > 12) colorful = true;
            const y = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
            d[i] = d[i + 1] = d[i + 2] = y;
        }
        cctx.putImageData(data, 0, 0);

        layers.push({
            canvas: cv,
            ctx: cctx,
            key,
            x: Math.round((w - lw) / 2),
            y: Math.round((h - lh) / 2),
            w: lw,
            h: lh,
            visible: true,
            crop: null,
            name: `图层 ${layers.length + 1}`,
        });
        activeLayer = layers.length - 1;
        tool = "move"; // 导入后直接能拖，省一步
        if (!active) setActive(true); // 不在深度模式时 draw() 会直接 return，图层会「看不见」
        syncTools();
        rebuildLayerSelect();
        syncCursor();
        dirty = true;
        // 外部注入不写回控件：这时 depth_png 仍是空的，后端就会用节点接的 depth_image，
        // 免得「第一次执行输出还是灰的、要再跑一次才对」。用户真拖过之后才提交合成图。
        if (commit) {
            pushAddLayer(layers.length - 1);
            scheduleCommit(80);
        }
        requestRedraw();
        if (colorful) toast?.show?.("这张图是彩色的，已按亮度转成灰度", 2200);
        return true;
    }

    async function loadDataUrl(url) {
        if (!url || !String(url).startsWith("data:")) return false;
        try {
            const img = await loadImage(url);
            const { w, h } = getCanvasSize();
            ensureSize(w, h);
            // 存回来的是合成图，恢复成扁平的笔刷层即可
            layers = [];
            activeLayer = -1;
            syncTools();
            rebuildLayerSelect();
            rctx.clearRect(0, 0, raster.width, raster.height);
            rctx.drawImage(img, 0, 0, raster.width, raster.height);
            dirty = true;
            requestRedraw();
            return true;
        } catch (_) {
            return false;
        }
    }

    function exportPng() {
        const out = composeInto(document.createElement("canvas"));
        out.toBlob((blob) => {
            if (!blob) return;
            const a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = "moss-depth.png";
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 4000);
        }, "image/png");
    }

    // ---------- 工具栏 ----------

    const el = document.createElement("div");
    el.className = "moss-mode-bar";

    // 数字双击变成输入框：回车 / 失焦提交，Esc 放弃
    function makeNumEditable(span, { min, max, get, commit }) {
        span.classList.add("is-editable");
        span.title = "双击直接输入";
        span.addEventListener("dblclick", () => {
            if (span.dataset.editing === "1") return;
            const before = String(get());
            const input = document.createElement("input");
            input.type = "number";
            input.min = String(min);
            input.max = String(max);
            input.step = "1";
            input.value = before;
            span.dataset.editing = "1";
            span.textContent = "";
            span.appendChild(input);
            input.focus();
            try { input.select(); } catch (_) { /* number 输入在部分浏览器不支持 select() */ }

            let closed = false;
            const finish = (ok) => {
                if (closed) return;
                closed = true;
                delete span.dataset.editing;
                if (ok) {
                    let v = Number(input.value);
                    if (!Number.isFinite(v)) v = Number(before);
                    v = Math.round(Math.min(max, Math.max(min, v)));
                    span.textContent = String(v);
                    commit(v);
                    return;
                }
                span.textContent = before;
            };
            input.addEventListener("keydown", (e) => {
                e.stopPropagation();
                if (e.key === "Enter") {
                    e.preventDefault();
                    finish(true);
                } else if (e.key === "Escape") {
                    e.preventDefault();
                    finish(false);
                }
            });
            input.addEventListener("blur", () => finish(true));
        });
    }

    const swatchEls = DEPTH_LEVELS.map((lv) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "moss-depth-swatch";
        b.style.background = rgb(lv.v);
        b.title = `${lv.name}（${lv.v}）`;
        b.addEventListener("click", () => setValue(lv.v));
        el.appendChild(b);
        return b;
    });

    const sep1 = document.createElement("div");
    sep1.className = "moss-mode-sep";
    el.appendChild(sep1);

    // 灰度滑块：0~255 连续值，拖到某个预设值上会自动高亮那个色块
    const grayWrap = document.createElement("div");
    grayWrap.style.cssText = "display:flex;align-items:center;gap:5px;flex:0 0 auto;";
    const grayText = document.createElement("span");
    grayText.textContent = "灰度";
    const grayRange = document.createElement("input");
    grayRange.type = "range";
    grayRange.className = "moss-depth-range is-gray";
    grayRange.min = "0";
    grayRange.max = "255";
    grayRange.step = "1";
    grayRange.value = String(value);
    grayRange.title = "白=近，黑=远（0~255）";
    const grayNum = document.createElement("span");
    grayNum.className = "moss-depth-num";
    grayNum.textContent = String(value);
    grayRange.addEventListener("input", () => setValue(Number(grayRange.value)));
    makeNumEditable(grayNum, {
        min: 0,
        max: 255,
        get: () => value,
        commit: (v) => setValue(v),
    });
    grayWrap.append(grayText, grayRange, grayNum);
    el.appendChild(grayWrap);

    const sepGray = document.createElement("div");
    sepGray.className = "moss-mode-sep";
    el.appendChild(sepGray);

    const brushWrap = document.createElement("div");
    brushWrap.style.cssText = "display:flex;align-items:center;gap:5px;flex:0 0 auto;";
    const brushText = document.createElement("span");
    brushText.textContent = "笔刷";
    const brushRange = document.createElement("input");
    brushRange.type = "range";
    brushRange.className = "moss-depth-range";
    brushRange.min = "4";
    brushRange.max = "240";
    brushRange.step = "1";
    brushRange.value = String(brush);
    const brushNum = document.createElement("span");
    brushNum.className = "moss-depth-num";
    brushNum.textContent = String(brush);
    brushRange.addEventListener("input", () => {
        brush = Number(brushRange.value);
        brushNum.textContent = String(brush);
        requestRedraw();
    });
    makeNumEditable(brushNum, {
        min: 4,
        max: 240,
        get: () => brush,
        commit: (v) => {
            brush = v;
            brushRange.value = String(v);
            brushNum.textContent = String(v);
            requestRedraw();
        },
    });
    brushWrap.append(brushText, brushRange, brushNum);
    el.appendChild(brushWrap);

    const sep2 = document.createElement("div");
    sep2.className = "moss-mode-sep";
    el.appendChild(sep2);

    const eraserBtn = document.createElement("button");
    eraserBtn.type = "button";
    eraserBtn.className = "moss-mode-btn";
    eraserBtn.textContent = "橡皮";
    eraserBtn.title = "把笔画回中灰（E）";
    eraserBtn.addEventListener("click", () => {
        eraser = !eraser;
        if (eraser) {
            value = DEFAULT_V;
            tool = "brush";
            closeCropMode();
        }
        syncTools();
        syncCursor();
    });
    el.appendChild(eraserBtn);

    const fillBtn = document.createElement("button");
    fillBtn.type = "button";
    fillBtn.className = "moss-mode-btn";
    fillBtn.textContent = "填充";
    fillBtn.title = "把当前选中的 bbox 填成当前灰阶（椭圆）";
    fillBtn.addEventListener("click", () => {
        tool = "brush";
        closeCropMode();
        syncCursor();
        fillSelected();
    });
    el.appendChild(fillBtn);

    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "moss-mode-btn";
    clearBtn.textContent = "清空";
    clearBtn.addEventListener("click", clearAll);
    el.appendChild(clearBtn);

    const sep4 = document.createElement("div");
    sep4.className = "moss-mode-sep";
    el.appendChild(sep4);

    const importBtn = document.createElement("button");
    importBtn.type = "button";
    importBtn.className = "moss-mode-btn";
    importBtn.textContent = "导入";
    importBtn.title = "选一张深度图导入（白=近，黑=远）";
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = "image/*";
    fileInput.style.display = "none";
    fileInput.addEventListener("change", () => {
        const f = fileInput.files?.[0];
        if (f) importBlob(f);
        fileInput.value = "";
    });
    importBtn.addEventListener("click", () => fileInput.click());
    el.append(importBtn, fileInput);

    const exportBtn = document.createElement("button");
    exportBtn.type = "button";
    exportBtn.className = "moss-mode-btn";
    exportBtn.textContent = "导出";
    exportBtn.addEventListener("click", exportPng);
    el.appendChild(exportBtn);

    const sepLayer = document.createElement("div");
    sepLayer.className = "moss-mode-sep";
    el.appendChild(sepLayer);

    // 「移动」归到图层这一组：它操作的是图层，不是画笔
    const moveBtn = document.createElement("button");
    moveBtn.type = "button";
    moveBtn.className = "moss-mode-btn";
    moveBtn.textContent = "移动";
    moveBtn.title = "拖动图层移动 · 拖四角/边中点缩放 · 按住 Alt 临时关闭吸附";
    moveBtn.addEventListener("click", () => {
        closeCropMode(); // 点移动就退出裁剪，不然两个模式叠着
        eraser = false;  // 橡皮也要退，否则两个按钮同时亮、拖动时还在涂中灰
        tool = tool === "move" ? "brush" : "move";
        if (tool === "move" && activeLayer < 0 && layers.length) activeLayer = layers.length - 1;
        syncTools();
        syncCursor();
        requestRedraw();
    });
    el.appendChild(moveBtn);

    const layerSelect = document.createElement("select");
    layerSelect.className = "moss-depth-select";
    layerSelect.title = "选择要拖动 / 删除的图层；顶层在最上面";
    layerSelect.addEventListener("change", () => {
        activeLayer = Number(layerSelect.value);
        cropMode = false;
        cropOp = null;
        tool = activeLayer >= 0 ? "move" : "brush";
        syncTools();
        syncCursor();
        requestRedraw();
    });
    el.appendChild(layerSelect);

    const delLayerBtn = document.createElement("button");
    delLayerBtn.type = "button";
    delLayerBtn.className = "moss-mode-btn";
    delLayerBtn.textContent = "删层";
    delLayerBtn.title = "删除选中的图层（底层笔刷不受影响）";
    delLayerBtn.addEventListener("click", () => {
        if (activeLayer < 0 || !layers[activeLayer]) {
            toast?.show?.("先在上面选中一个图层", 1600);
            return;
        }
        pushRemoveLayer(activeLayer);
        layers.splice(activeLayer, 1);
        activeLayer = layers.length ? Math.min(activeLayer, layers.length - 1) : -1;
        cropMode = false;
        cropOp = null;
        if (!layers.length) tool = "brush";
        syncTools();
        rebuildLayerSelect();
        syncCursor();
        scheduleCommit(80);
        requestRedraw();
    });
    el.appendChild(delLayerBtn);

    const cropBtn = document.createElement("button");
    cropBtn.type = "button";
    cropBtn.className = "moss-mode-btn";
    cropBtn.textContent = "裁剪";
    cropBtn.title = "裁出这一层的可见区域（原图位图不变，随时能拉回来）；按住 Alt 点击恢复整层";
    cropBtn.addEventListener("click", (ev) => {
        const L = activeLayer >= 0 ? layers[activeLayer] : null;
        if (!L) {
            toast?.show?.("先选中一个图层", 1600);
            return;
        }
        if (ev && ev.altKey) {
            L.crop = null;
            cropMode = false;
            cropOp = null;
            syncTools();
            syncCursor();
            scheduleCommit(80);
            requestRedraw();
            toast?.show?.("已恢复整层", 1400);
            return;
        }
        if (cropMode) {
            // 已经开着 → 关掉，走统一出口（会处理「拉满=没裁」并提交）
            closeCropMode();
        } else {
            cropMode = true;
            cropOp = null;
            if (!L.crop) L.crop = { x: 0, y: 0, w: 1, h: 1 };
            tool = "brush"; // 裁剪是独立模式，别停在移动工具
            toast?.show?.("拖动橙色框调整裁剪范围，Alt + 点「裁剪」恢复整层", 2400);
        }
        syncTools();
        syncCursor();
        requestRedraw();
    });
    el.appendChild(cropBtn);

    function rebuildLayerSelect() {
        const keep = activeLayer;
        layerSelect.textContent = "";
        const mk = (v, t) => {
            const o = document.createElement("option");
            o.value = String(v);
            o.textContent = t;
            layerSelect.appendChild(o);
        };
        mk(-1, layers.length ? "笔刷层" : "无图层");
        layers.forEach((L, i) => mk(i, L.name));
        activeLayer = keep >= 0 && keep < layers.length ? keep : -1;
        layerSelect.value = String(activeLayer);
        layerSelect.disabled = layers.length === 0;
        delLayerBtn.disabled = activeLayer < 0;
    }

    // 提示放 title，避免占掉一整行（面板只有 520px 宽）
    el.title = "白=近，黑=远｜1~5 选灰阶，[ ] 调笔刷，E 橡皮｜数字双击可输入｜撤销/重做用顶部的 ↶ ↷";

    function syncCursor() {
        if (!canvas) return;
        canvas.style.cursor = active ? (tool === "move" ? "move" : "crosshair") : "default";
    }

    function syncTools() {
        // 正好落在某个预设值上才高亮——拖滑块时这就是「划到 100%」的判定
        swatchEls.forEach((b, i) => b.classList.toggle("is-on", !eraser && DEPTH_LEVELS[i].v === value));
        eraserBtn.classList.toggle("is-on", eraser);
        moveBtn.classList.toggle("is-on", tool === "move");
        // 没有图层就没有可移动的对象，置灰
        moveBtn.disabled = layers.length === 0;
        cropBtn.classList.toggle("is-on", cropMode);
        cropBtn.disabled = activeLayer < 0;
        if (layerSelect) {
            layerSelect.value = String(activeLayer);
            layerSelect.disabled = layers.length === 0;
        }
        if (delLayerBtn) delLayerBtn.disabled = activeLayer < 0;
        grayRange.value = String(value);
        if (grayNum.dataset.editing !== "1") grayNum.textContent = String(value);
    }

    // 深度条上不再有自己的撤销 / 重做按钮，栈一变就通知顶部的全局按钮刷新置灰
    function syncButtons() {
        onHistoryChange?.(undoStack.length > 0, redoStack.length > 0);
    }

    // ---------- 模式与快捷键 ----------

    function setActive(on) {
        active = !!on;
        if (!active) {
            cropMode = false;
            cropOp = null;
        }
        el.classList.toggle("is-on", active);
        syncCursor();
        if (!active) {
            hover = null;
            if (drawing) pointerUp();
            flushCommit();
        }
        requestRedraw();
    }

    function toggle() {
        setActive(!active);
    }

    function bindKeys() {
        if (!canvas) return;
        canvas.addEventListener("keydown", (e) => {
            if (!active) return;
            const k = e.key;
            if (k >= "1" && k <= "5") {
                setValue(DEPTH_LEVELS[Number(k) - 1].v);
                e.preventDefault();
                return;
            }
            if (k === "[") {
                brush = Math.max(4, brush - 8);
                brushRange.value = String(brush);
                brushNum.textContent = String(brush);
                e.preventDefault();
                return;
            }
            if (k === "]") {
                brush = Math.min(240, brush + 8);
                brushRange.value = String(brush);
                brushNum.textContent = String(brush);
                e.preventDefault();
                return;
            }
            if (k === "e" || k === "E") {
                eraser = !eraser;
                if (eraser) value = DEFAULT_V;
                syncTools();
                e.preventDefault();
                return;
            }
        });
    }


    rebuildLayerSelect();
    syncTools();
    bindKeys();

    return {
        el,
        toggle,
        setActive,
        isActive: () => active,
        hasContent: () => dirty || layers.length > 0,
        draw,
        pointerDown,
        pointerMove,
        pointerUp,
        pointerLeave,
        loadDataUrl,
        importBlob,
        fillSelected,
        clearAll,
        undo,
        redo,
        canUndo: () => undoStack.length > 0,
        canRedo: () => redoStack.length > 0,
        flushCommit,
        restoreState,
        importImage: (img, key = "") => addLayerFromImage(img, key, { commit: false }),
        layerCount: () => layers.length,
    };
}
