import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// ==========================================
// 0. JSON 规范化（对齐官方 schema）
// ==========================================
//   · 编辑器内部字段（_align 等）不落盘
//   · tags / palette 为空数组时，整个字段删除
//   · text 字段只属于 label === "text" 的条目
// 所有写回 layout_json 的路径都必须经过这里。

// 记录哪些节点的管理面板当前是打开的。
// ComfyUI 的全局撤销（Ctrl+Z）会重建整张图，节点被移除再新建，
// 面板会跟着消失；靠这份记录在节点重建后自动把它恢复。
const openPanelIds = new Set();
// 框的复制/粘贴缓冲（模块级，可在不同节点的面板之间通用）
let bboxClipboard = [];

function sanitizeItemForJson(item) {
    if (!item || typeof item !== "object") return item;
    const out = {};
    for (const key of Object.keys(item)) {
        if (key.startsWith("_")) continue;
        const value = item[key];
        if ((key === "tags" || key === "palette") && Array.isArray(value) && value.length === 0) continue;
        if (key === "text" && item.label !== "text") continue;
        out[key] = value;
    }
    return out;
}

function serializeLayout(data) {
    if (Array.isArray(data)) {
        return JSON.stringify(data.map(sanitizeItemForJson), null, 2);
    }
    if (!data || typeof data !== "object") return "{}";
    const clone = { ...data };
    if (Array.isArray(clone.items)) clone.items = clone.items.map(sanitizeItemForJson);
    return JSON.stringify(clone, null, 2);
}

// 官方有两套坐标描述，统一以 ComfyUI 官方节点使用的“模型格式”为准：
//   草稿： bbox_coord_space="abs"             + bbox_format="xyxy"（左上角原点，带 width/height）
//   模型： bbox_coord_space="abs_centralized" + bbox_format="yxyx"（画布中心原点）
function normalizeLayoutSchema(data, fallbackW, fallbackH) {
    const result = { converted: false, width: null, height: null };
    if (!data || typeof data !== "object" || Array.isArray(data)) return result;

    // 只有 JSON 自己声明了 width/height 才回传（用于同步画布控件）
    const declaredW = Number(data.width) || 0;
    const declaredH = Number(data.height) || 0;
    const width = declaredW || Number(fallbackW) || 0;
    const height = declaredH || Number(fallbackH) || 0;
    result.width = declaredW || null;
    result.height = declaredH || null;

    const coord = String(data.bbox_coord_space || "abs_centralized").toLowerCase();
    const format = String(data.bbox_format || "yxyx").toLowerCase();
    const centered = coord === "abs_centralized";
    const yxyx = format === "yxyx";
    if (centered && yxyx) return result; // 已经是模型格式

    // 草稿是左上角原点，没有画布尺寸就没法换算
    if (!centered && (!width || !height)) return result;

    const items = Array.isArray(data.items) ? data.items : [];
    items.forEach((item) => {
        const bbox = item && item.bbox;
        if (!Array.isArray(bbox) || bbox.length !== 4) return;
        const [a, b, c, d] = bbox;
        let xmin, ymin, xmax, ymax;
        if (yxyx) {
            ymin = a; xmin = b; ymax = c; xmax = d;
        } else {
            xmin = a; ymin = b; xmax = c; ymax = d;
        }
        if (!centered) {
            xmin -= width / 2; xmax -= width / 2;
            ymin -= height / 2; ymax -= height / 2;
        }
        item.bbox = [Math.round(ymin), Math.round(xmin), Math.round(ymax), Math.round(xmax)];
    });

    data.bbox_coord_space = "abs_centralized";
    data.bbox_format = "yxyx";
    // 注意：width / height 保留。模型格式同样允许携带画布尺寸，
    // 只是在生成给下游的提示词时才剥离（见 MOSS_JSON_Importer）。
    result.converted = true;
    return result;
}

// ==========================================
// 1.5 JSON 控件下方追加「复制」按钮
// ==========================================
// 这个版本的 ComfyUI 只渲染官方控件类型（自定义画布控件不会被绘制），
// 所以这里用 addWidget("button")，并把它挪到 layout_json 的正下方。
function attachJsonCopyButtons(node, jsonWidget) {
    if (!jsonWidget) return;

    const copyText = async (text) => {
        try {
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(text);
                return true;
            }
        } catch (_) {
            /* 继续走回退方案 */
        }
        try {
            const ta = document.createElement("textarea");
            ta.value = text;
            ta.style.cssText = "position:fixed; left:-9999px; top:0;";
            document.body.appendChild(ta);
            ta.select();
            const ok = document.execCommand("copy");
            ta.remove();
            return ok;
        } catch (_) {
            return false;
        }
    };

    // 复制并带上画布宽高（放在最前面，便于阅读）
    const jsonWithSize = () => {
        const raw = jsonWidget.value || "";
        let data;
        try {
            data = JSON.parse(raw);
        } catch (_) {
            return raw;
        }
        if (!data || typeof data !== "object" || Array.isArray(data)) return raw;

        const w = node.widgets?.find((x) => x.name === "canvas_width")?.value;
        const h = node.widgets?.find((x) => x.name === "canvas_height")?.value;
        const ordered = {};
        if (Number.isFinite(Number(w))) ordered.width = Number(w);
        if (Number.isFinite(Number(h))) ordered.height = Number(h);
        Object.keys(data).forEach((k) => {
            if (k !== "width" && k !== "height") ordered[k] = data[k];
        });
        return JSON.stringify(ordered, null, 2);
    };

    // 把控件插到 layout_json 之后
    const placeAfterJsonWidget = (w) => {
        const arr = node.widgets || [];
        const from = arr.indexOf(w);
        if (from >= 0) arr.splice(from, 1);
        const idx = arr.findIndex((x) => x.name === "layout_json");
        if (idx >= 0) arr.splice(idx + 1, 0, w);
        else arr.push(w);
    };

    // 官方整行按钮（可靠，但没有并排效果）
    const addPlainButtons = () => {
        const add = (label, run) => {
            let w = null;
            w = node.addWidget("button", label, null, async () => {
                const ok = await run();
                const shown = ok ? "✓ 已复制" : "✗ 失败";
                w.label = shown;
                w.name = shown;
                node.setDirtyCanvas?.(true, true);
                setTimeout(() => {
                    w.label = label;
                    w.name = label;
                    node.setDirtyCanvas?.(true, true);
                }, 1200);
            });
            placeAfterJsonWidget(w);
            return w;
        };
        add("📐 复制 JSON(带长宽)", () => copyText(jsonWithSize()));
        add("📋 复制 JSON", () => copyText(jsonWidget.value || ""));
    };

    // ---- 方案 A：DOM 控件（原生 hover / click，最可靠） ----
    const DOM_ROW_H = 26;
    const buildDomRow = () => {
        const wrap = document.createElement("div");
        // 固定行高：DOM 控件的高度会跟随元素，不固定就会被 stretch 拉满
        wrap.style.cssText =
            `display:flex; gap:6px; width:100%; box-sizing:border-box; height:${DOM_ROW_H}px; margin:0; padding:0; align-items:stretch;`;

        const makeBtn = (label, handler) => {
            const b = document.createElement("button");
            b.type = "button";
            b.textContent = label;
            b.style.cssText =
                `flex:1 1 0; min-width:0; height:${DOM_ROW_H}px; margin:0; padding:0 6px; font-size:12px; line-height:1; ` +
                "border-radius:4px; border:1px solid #555; background:#2e2e2e; color:#ccc; cursor:pointer; " +
                "transition:background .12s,border-color .12s,color .12s;";
            b.addEventListener("mouseenter", () => {
                b.style.background = "#3c3c3c";
                b.style.borderColor = "#8a8a8a";
                b.style.color = "#fff";
            });
            b.addEventListener("mouseleave", () => {
                b.style.background = "#2e2e2e";
                b.style.borderColor = "#555";
                b.style.color = "#ccc";
            });
            // 阻止拖拽节点 / 画布交互
            b.addEventListener("pointerdown", (e) => e.stopPropagation());
            b.addEventListener("click", async (e) => {
                e.stopPropagation();
                e.preventDefault();
                const ok = await handler();
                b.textContent = ok ? "✓ 已复制" : "✗ 失败";
                setTimeout(() => {
                    b.textContent = label;
                }, 1200);
            });
            wrap.appendChild(b);
            return b;
        };

        makeBtn("复制", () => copyText(jsonWidget.value || ""));
        makeBtn("复制(带长宽)", () => copyText(jsonWithSize()));
        return wrap;
    };

    // DOM 控件方案在这个前端会留一整行空白（行高由模板控制），先关闭
    const ENABLE_DOM_ROW = false;
    if (ENABLE_DOM_ROW && typeof node.addDOMWidget === "function") {
        try {
            const domWidget = node.addDOMWidget("moss_copy_row", "moss_copy", buildDomRow(), {
                serialize: false,
                getHeight: () => DOM_ROW_H,
            });
            if (domWidget) {
                try {
                    // 双保险：万一前端按 computeSize 排版，也固定成一行高度
                    domWidget.computeSize = () => [Math.max(80, (node.size?.[0] || 320) - 20), DOM_ROW_H];
                } catch (_) {
                    /* 忽略 */
                }
                placeAfterJsonWidget(domWidget);

                // 这一版前端把控件排进 CSS 子网格，行高由节点模板决定，不是元素高度。
                // 先压元素，再切一次节点尺寸强制重排；若行高仍不收敛（>60px），
                // 就直接撤掉 DOM 控件、换回官方整行按钮，避免留下大片空白。
                setTimeout(() => {
                    try {
                        const el = domWidget.element;
                        const host = el?.parentElement || null;
                        if (el) {
                            el.style.height = `${DOM_ROW_H}px`;
                            el.style.minHeight = `${DOM_ROW_H}px`;
                            el.style.maxHeight = `${DOM_ROW_H}px`;
                        }
                        if (host) {
                            host.style.height = `${DOM_ROW_H}px`;
                            host.style.minHeight = `${DOM_ROW_H}px`;
                            host.style.maxHeight = `${DOM_ROW_H}px`;
                            host.style.padding = "0";
                            host.style.margin = "0";
                        }

                        // 有的版本会读 widget.height / options.getHeight 来排版
                        try {
                            domWidget.height = DOM_ROW_H;
                            domWidget.options = domWidget.options || {};
                            domWidget.options.getHeight = () => DOM_ROW_H;
                        } catch (_) {
                            /* 忽略 */
                        }

                        // 切一次尺寸，迫使前端按新的控件高度重算网格行
                        try {
                            const [w, h] = node.size;
                            node.setSize([w, h + 1]);
                            node.setSize([w, h]);
                        } catch (_) {
                            /* 忽略 */
                        }
                        node.graph?.setDirtyCanvas?.(true, true);
                    } catch (_) {
                        /* 忽略 */
                    }

                    // 二次确认：行高没收敛就换官方按钮
                    setTimeout(() => {
                        try {
                            const el = domWidget.element;
                            const rowEl =
                                el?.closest?.('[data-testid="node-widget"]') || el?.parentElement?.parentElement;
                            const rowH = rowEl ? rowEl.getBoundingClientRect().height : 0;
                            if (rowH <= 60) return; // 收敛了，保留并排按钮

                            const i = node.widgets.indexOf(domWidget);
                            if (i >= 0) node.widgets.splice(i, 1);
                            el?.remove?.();
                            addPlainButtons();
                            node.graph?.setDirtyCanvas?.(true, true);
                        } catch (_) {
                            /* 忽略 */
                        }
                    }, 320);
                }, 120);

                return; // DOM 版生效，下面的画布方案不再执行
            }
        } catch (err) {
            console.warn("[MOSS] DOM 复制按钮添加失败，退回其它方案:", err);
        }
    }

    // 该前端的控件行高由节点模板控制：DOM 控件会留下一整行空白，
    // 自绘控件又没有鼠标事件。两条路都试过，统一退回官方按钮（无空白、可点击）。
    addPlainButtons();
    return;

    /* eslint-disable no-unreachable */
    const ROW_H = 22;
    const BTN_H = 20;
    const BTN_GAP = 4;

    const runAction = async (id) => {
        const text = id === "copySize" ? jsonWithSize() : (jsonWidget.value || "");
        const ok = await copyText(text);
        node._mossCopyFlash = { id, label: ok ? "✓ 已复制" : "✗ 失败" };
        node.setDirtyCanvas?.(true, false);
        setTimeout(() => {
            node._mossCopyFlash = null;
            node.setDirtyCanvas?.(true, false);
        }, 1200);
    };

    const drawBtn = (ctx, x, y, w, h, label, hot) => {
        ctx.beginPath();
        if (typeof ctx.roundRect === "function") ctx.roundRect(x, y, w, h, 4);
        else ctx.rect(x, y, w, h);
        ctx.fillStyle = hot ? "#3c3c3c" : "#2e2e2e";
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.strokeStyle = hot ? "#8a8a8a" : "#555";
        ctx.stroke();
        ctx.fillStyle = hot ? "#ffffff" : "#c8c8c8";
        ctx.font = "11px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(label, x + w / 2, y + h / 2 + 0.5);
    };

    // 不用 emoji：它的实际字宽和 measureText 不一致，会让文字看起来偏左
    const LABEL_LEFT = "复制";
    const LABEL_RIGHT = "复制(带长宽)";

    const hitTestRects = (n, lx, ly) => {
        for (const r of n._mossCopyRects || []) {
            if (lx >= r.x && lx <= r.x + r.w && ly >= r.y && ly <= r.y + r.h) return r.id;
        }
        return null;
    };

    // widget.mouse 与 node.onMouseDown 可能都触发，去重
    const trigger = (id) => {
        const now = Date.now();
        if (node._mossCopyLastAt && now - node._mossCopyLastAt < 250) return true;
        node._mossCopyLastAt = now;
        runAction(id);
        return true;
    };

    // 命中检测：localPos 在不同版本里语义不一，两种坐标都试一遍
    const hitId = (e, localPos, canvas, n) => {
        const candidates = [];
        if (Array.isArray(localPos) && localPos.length >= 2 && Number.isFinite(localPos[0])) {
            candidates.push(localPos);
        }
        const cv = (canvas && canvas.canvas) || app.canvas?.canvas;
        const ds = (canvas && canvas.ds) || app.canvas?.ds;
        if (e && cv && ds && Number.isFinite(e.clientX)) {
            const rect = cv.getBoundingClientRect();
            const scale = ds.scale || 1;
            candidates.push([
                (e.clientX - rect.left) / scale - ds.offset[0] - n.pos[0],
                (e.clientY - rect.top) / scale - ds.offset[1] - n.pos[1],
            ]);
        }
        for (const p of candidates) {
            const id = hitTestRects(n, p[0], p[1]);
            if (id) return id;
        }
        return null;
    };

    // 一行两个半宽按钮：横排
    const widget = {
        name: "moss_json_copy",
        type: "moss_json_copy",
        value: null,
        options: {},
        last_y: 0,
        computeSize: () => [0, ROW_H],
        draw(ctx, n, width, y) {
            n._mossCopyDrawn = true; // 供兜底逻辑判断是否真的被绘制
            const total = (typeof width === "number" && width > 0 ? width : n.size[0]) || 200;
            const w = Math.max(40, (total - BTN_GAP) / 2);
            const flash = n._mossCopyFlash;
            const hover = n._mossCopyHover;

            const labelOf = (id, fallback) => (flash && flash.id === id ? flash.label : fallback);
            const isHot = (id) => (flash && flash.id === id) || hover === id;

            n._mossCopyRects = [
                { x: 0, y, w, h: BTN_H, id: "copy" },
                { x: w + BTN_GAP, y, w, h: BTN_H, id: "copySize" },
            ];

            ctx.save();
            drawBtn(ctx, 0, y, w, BTN_H, labelOf("copy", LABEL_LEFT), isHot("copy"));
            drawBtn(ctx, w + BTN_GAP, y, w, BTN_H, labelOf("copySize", LABEL_RIGHT), isHot("copySize"));
            ctx.restore();
        },
        mouse(e, pos, n) {
            if (!e || !pos) return false;
            const type = e.type || "";
            if (type !== "pointerdown" && type !== "mousedown" && type !== "click") return false;
            const id = hitTestRects(n, pos[0], pos[1]);
            return id ? trigger(id) : false;
        },
    };

    // 悬停高亮 + 点击兜底（部分前端不派发 widget.mouse）
    const origMove = node.onMouseMove;
    node.onMouseMove = function (e, localPos, canvas) {
        const res = origMove?.apply(this, arguments);
        const id = hitId(e, localPos, canvas, this);
        if (id !== this._mossCopyHover) {
            this._mossCopyHover = id;
            this.setDirtyCanvas?.(true, false);
        }
        return res;
    };

    const origDown = node.onMouseDown;
    node.onMouseDown = function (e, localPos, canvas) {
        const id = hitId(e, localPos, canvas, this);
        if (id) return trigger(id);
        return origDown?.apply(this, arguments);
    };

    let customAdded = false;
    try {
        if (typeof node.addCustomWidget === "function") {
            node.addCustomWidget(widget);
            placeAfterJsonWidget(widget);
            customAdded = true;
        }
    } catch (err) {
        console.warn("[MOSS] 自定义复制按钮添加失败，改用普通按钮:", err);
    }

    // 兜底：不绘制自定义控件（或 addCustomWidget 不可用）时，退回官方整行按钮
    const addFallbackButtons = () => {
        if (node._mossCopyFallback) return;
        node._mossCopyFallback = true;
        const i = node.widgets.indexOf(widget);
        if (i >= 0) node.widgets.splice(i, 1);
        addPlainButtons();
        node.setDirtyCanvas?.(true, true);
    };

    if (!customAdded) {
        addFallbackButtons();
    } else {
        setTimeout(() => {
            if (!node._mossCopyDrawn) addFallbackButtons();
        }, 1200);
    }
}

// ==========================================
// 1. MOSS_JSON_Importer 的快捷编辑功能
// ==========================================
app.registerExtension({
    name: "Comfy.MOSS_BBox_Manager",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name !== "MOSS_JSON_Importer") return;

        // 🌟 onExecuted：接收 Python 返回的 width/height/background_images
        const onExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (message) {
            const r = onExecuted?.apply(this, arguments);
            console.log("[MOSS Debug] onExecuted message:", message);
            const node = this;

            try {
                const hasW = message && Array.isArray(message.width) && message.width.length;
                const hasH = message && Array.isArray(message.height) && message.height.length;

                const wWidget = node.widgets.find((w) => w.name === "canvas_width");
                const hWidget = node.widgets.find((w) => w.name === "canvas_height");
                if (hasW && wWidget) { 
                    wWidget.value = message.width[0]; 
                    wWidget.callback?.(wWidget.value); 
                }
                if (hasH && hWidget) { 
                    hWidget.value = message.height[0]; 
                    hWidget.callback?.(hWidget.value); 
                }

                const hasBg = message && Array.isArray(message.background_images)
                    && message.background_images.length;
                if (hasBg) {
                    const info = message.background_images[0];
                    if (info && info.filename) {
                        const url = `/view?filename=${encodeURIComponent(info.filename)}`
                            + `&subfolder=${encodeURIComponent(info.subfolder || "")}`
                            + `&type=${encodeURIComponent(info.type || "output")}`;
                        const img = new Image();
                        img.crossOrigin = "anonymous";
                        img.onload = () => {
                            if (node._mossPanelUpdate) {
                                node._mossPanelUpdate({ image: img });
                            } else {
                                node._mossPendingBackground = img;
                            }
                        };
                        img.onerror = () => console.warn("[MOSS] 背景图加载失败:", url);
                        img.src = url;
                    }
                } else if (node._mossPanelUpdate) {
                    // 只更新了尺寸、没有图片时，也要触发一次重绘
                    node._mossPanelUpdate({ image: null });
                }

                if (node.graph) node.graph.setDirtyCanvas(true, true);
            } catch (e) {
                console.error("[MOSS] onExecuted 处理失败:", e);
            }

            return r;
        };

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onNodeCreated
                ? onNodeCreated.apply(this, arguments)
                : undefined;
            const node = this;

            // 🌟 中文化显示名（内部 name 不变，不影响已有工作流和后续 find 逻辑）
            const LABELS = {
                "canvas_width": "画布宽度",
                "canvas_height": "画布高度",
                "use_image_size": "使用背景图并修改尺寸",
                "image": "背景",
            };
            node.widgets?.forEach((w) => {
                if (LABELS[w.name]) w.label = LABELS[w.name];
            });
            // input 端口的 label 要在下一帧才就绪（可能被 ComfyUI 延迟创建）
            setTimeout(() => {
                node.inputs?.forEach((inp) => {
                    if (LABELS[inp.name]) inp.label = LABELS[inp.name];
                });
                if (node.graph) node.graph.setDirtyCanvas(true, true);
            }, 50);

            // 🌟 初始化 token 计数
            node._mossImageLoadToken = 0;

            // 🌟 前端自动读图尺寸（仅对 LoadImage 类上游有效）
            const tryReadImageSize = () => {
                const inputSlot = node.inputs?.find((i) => i.name === "image");
                if (!inputSlot || inputSlot.link == null) return false;
                const link = node.graph?.links?.[inputSlot.link];
                if (!link) return false;
                const upstream = node.graph.getNodeById(link.origin_id);
                if (!upstream?.widgets) return false;

                const imgWidget = upstream.widgets.find(
                    (w) => w.name === "image" && typeof w.value === "string" && w.value.trim()
                );
                if (!imgWidget) return false;

                const m = imgWidget.value.match(/^(.*?)(?:\s*\[(input|output|temp)\])?\s*$/);
                if (!m) return false;
                const filename = m[1].trim();
                if (!filename) return false;
                const type = m[2] || "input";
                const url = `/view?filename=${encodeURIComponent(filename)}&type=${encodeURIComponent(type)}`;

                // 🌟 每次发起加载时，Token +1
                const currentToken = ++node._mossImageLoadToken;

                const img = new Image();
                img.crossOrigin = "anonymous";
                img.onload = () => {
                    // 🌟 检查 Token，如果不一致说明已经被最新的开关操作打断，直接丢弃结果
                    if (node._mossImageLoadToken !== currentToken) return;

                    // 再次确认开关状态，防止加载过程中被关闭
                    const w = node.widgets?.find((x) => x.name === "use_image_size");
                    if (!w || !w.value) return;

                    const wW = node.widgets.find((w) => w.name === "canvas_width");
                    const hW = node.widgets.find((w) => w.name === "canvas_height");

                    // 避免重复赋值触发多余的 callback
                    if (wW && wW.value !== img.naturalWidth) {
                        wW.value = img.naturalWidth; 
                        wW.callback?.(wW.value); 
                    }
                    if (hW && hW.value !== img.naturalHeight) {
                        hW.value = img.naturalHeight; 
                        hW.callback?.(hW.value); 
                    }
                    if (node.graph) node.graph.setDirtyCanvas(true, true);

                    if (node._mossPanelUpdate) {
                        node._mossPanelUpdate({ image: img });
                    } else {
                        node._mossPendingBackground = img;
                    }
                    console.log(`[MOSS] 自动读取背景尺寸: ${img.naturalWidth}x${img.naturalHeight}`);
                };
                img.onerror = () => {
                    if (node._mossImageLoadToken === currentToken) {
                        console.warn(`[MOSS] 读取图片尺寸失败: ${url}`);
                    }
                };
                img.src = url;
                return true;
            };
            node._mossTryReadImageSize = tryReadImageSize;

            // 🌟 统一开关状态：未连接 image 时禁用；断开时自动关闭并清理
            const updateToggleState = () => {
                const w = node.widgets?.find((x) => x.name === "use_image_size");
                if (!w) return;
                const inputSlot = node.inputs?.find((i) => i.name === "image");
                const connected = !!(inputSlot && inputSlot.link != null);

                w.disabled = !connected;

                // 断开连接时取消异步读图、恢复尺寸，并清理自动背景图
                if (!connected) {
                    node._mossImageLoadToken++;
                    if (w.value) w.value = false;

                    const wW = node.widgets.find((x) => x.name === "canvas_width");
                    const hW = node.widgets.find((x) => x.name === "canvas_height");
                    if (node._mossSizeBeforeUseImage) {
                        if (wW) { wW.value = node._mossSizeBeforeUseImage.w; wW.callback?.(wW.value); }
                        if (hW) { hW.value = node._mossSizeBeforeUseImage.h; hW.callback?.(hW.value); }
                        node._mossSizeBeforeUseImage = null;
                    }
                    if (node._mossPanelUpdate) node._mossPanelUpdate({ clear: true });
                    node._mossPendingBackground = null;
                    if (node.graph) node.graph.setDirtyCanvas(true, true);
                }
            };
            node._mossUpdateToggleState = updateToggleState;

            // 🌟 开关切换：开启时保存当前尺寸并尝试读图；关闭时恢复
            const useImageSizeWidget = node.widgets.find((w) => w.name === "use_image_size");
            if (useImageSizeWidget) {
                const origCb = useImageSizeWidget.callback;
                useImageSizeWidget.callback = function () {
                    // 🌟 未连接时拦截，回滚 value 并提示
                    const inputSlot = node.inputs?.find((i) => i.name === "image");
                    const connected = !!(inputSlot && inputSlot.link != null);
                    if (!connected) {
                        useImageSizeWidget.value = !useImageSizeWidget.value; // 回滚
                        if (useImageSizeWidget.value === false && origCb) {
                            // 若原本是开被切到关再回滚，什么都不做
                        }
                        alert("请先连接背景图，再使用「使用背景尺寸」开关");
                        if (node.graph) node.graph.setDirtyCanvas(true, true);
                        return;
                    }

                    if (origCb) origCb.apply(this, arguments);

                    const wW = node.widgets.find((w) => w.name === "canvas_width");
                    const hW = node.widgets.find((w) => w.name === "canvas_height");

                    if (useImageSizeWidget.value) {
                        if (!node._mossSizeBeforeUseImage && wW && hW) {
                            node._mossSizeBeforeUseImage = { w: wW.value, h: hW.value };
                        }
                        tryReadImageSize();
                    } else {
                        // 🌟 关闭时打断尚未完成的异步加载
                        node._mossImageLoadToken++; 
                        
                        if (node._mossSizeBeforeUseImage) {
                            if (wW && wW.value !== node._mossSizeBeforeUseImage.w) {
                                wW.value = node._mossSizeBeforeUseImage.w; 
                                wW.callback?.(wW.value);
                            }
                            if (hW && hW.value !== node._mossSizeBeforeUseImage.h) {
                                hW.value = node._mossSizeBeforeUseImage.h; 
                                hW.callback?.(hW.value);
                            }
                            node._mossSizeBeforeUseImage = null;
                            if (node.graph) node.graph.setDirtyCanvas(true, true);
                        }
                        if (node._mossPanelUpdate) node._mossPanelUpdate({ clear: true });
                        node._mossPendingBackground = null;
                    }
                };
            }

            // 🌟 旧版 LiteGraph 走 mouse 路径：未连接时消费点击事件，直接弹提示
            if (useImageSizeWidget && typeof useImageSizeWidget.mouse === "function") {
                const origMouse = useImageSizeWidget.mouse;
                useImageSizeWidget.mouse = function (event, pos, nodeRef) {
                    const inputSlot = node.inputs?.find((i) => i.name === "image");
                    const connected = !!(inputSlot && inputSlot.link != null);
                    if (!connected) {
                        if (event && (event.type === "pointerdown" || event.type === "mousedown")) {
                            alert("请先连接背景图，再使用「使用背景尺寸」开关");
                        }
                        return true; // 消费事件，阻止 value 被 toggle
                    }
                    return origMouse?.apply(this, arguments);
                };
            }

            setTimeout(updateToggleState, 100);

            // 🌟 首次创建 / 加载工作流时，如果已开启且已连线，延迟尝试一次
            setTimeout(() => {
                if (useImageSizeWidget?.value) {
                    const wW = node.widgets.find((w) => w.name === "canvas_width");
                    const hW = node.widgets.find((w) => w.name === "canvas_height");
                    if (!node._mossSizeBeforeUseImage && wW && hW) {
                        node._mossSizeBeforeUseImage = { w: wW.value, h: hW.value };
                    }
                    tryReadImageSize();
                }
            }, 200);

            const jsonWidget = node.widgets.find((w) => w.name === "layout_json");
            if (!jsonWidget) return r;

            // 面板与 onExecuted 之间的桥
            node._mossPanelUpdate = null;
            node._mossPendingBackground = null;

            node.addWidget("button", "📋 打开边界框管理面板", null, () => {
                createFloatingPanel(node, jsonWidget);
            });

            // 🌟 JSON 控件下方的「复制 / 复制(带长宽)」按钮
            attachJsonCopyButtons(node, jsonWidget);

            // 🌟 节点被重建（例如 Ctrl+Z 触发整图 reconfigure）后自动恢复面板
            if (openPanelIds.has(node.id)) {
                setTimeout(() => {
                    if (document.getElementById(`moss-bbox-panel-${node.id}`)) return;
                    const w = node.widgets?.find((x) => x.name === "layout_json");
                    if (w) createFloatingPanel(node, w);
                }, 120);
            }
            // 🌟 新增：导入图片提示词按钮
            node.addWidget("button", "📂 导入图片中的提示词JSON", null, () => {
                console.log("[MOSS] 导入按钮被点击");
                
                const fileInput = document.createElement("input");
                fileInput.type = "file";
                fileInput.accept = "image/png, image/jpeg, image/webp";
                // 🌟 修复 1：必须添加到 DOM 中，防止某些浏览器拦截 click
                fileInput.style.display = "none";
                document.body.appendChild(fileInput);
                
                fileInput.onchange = async (e) => {
                    const file = e.target.files[0];
                    // 清理 DOM
                    document.body.removeChild(fileInput);
                    if (!file) return;
                    
                    console.log("[MOSS] 选择了文件:", file.name);
                    
                    const formData = new FormData();
                    formData.append("image", file);
                    
                    try {
                        console.log("[MOSS] 发送请求到 /moss/extract_prompt...");
                        const resp = await api.fetchApi("/moss/extract_prompt", {
                            method: "POST",
                            body: formData
                        });
                        
                        // 检查 HTTP 状态
                        if (!resp.ok) {
                            throw new Error(`HTTP error! status: ${resp.status}`);
                        }
                        
                        const data = await resp.json();
                        console.log("[MOSS] 后端返回数据:", data);
                        
                        if (data.success) {
                            const flows = data.flows;
                            let targetFlow = flows[0];
                            
                            // 🌟 多流程选择
                            if (flows.length > 1) {
                                let optionsText = flows.map((f, i) => {
                                    let desc = "";
                                    if (f.moss_jsons.length > 0) desc = `包含自制节点 (尺寸: ${f.moss_jsons[0].w}x${f.moss_jsons[0].h})`;
                                    else if (f.official_boxes.length > 0) desc = `包含官方画框 (尺寸: ${f.official_boxes[0].w}x${f.official_boxes[0].h}, ${f.official_boxes[0].boxes.length}个框)`;
                                    else desc = `纯文本提示词 (${f.texts.length} 段)`;
                                    return `${i + 1}. 采样器 ID:${f.samplerId} - ${desc}`;
                                }).join('\n');
                                
                                const choice = prompt(`检测到 ${flows.length} 个独立的生成流程，请选择要导入的序号：\n\n${optionsText}`, "1");
                                if (choice === null) return;
                                
                                const idx = parseInt(choice) - 1;
                                if (idx >= 0 && idx < flows.length) {
                                    targetFlow = flows[idx];
                                } else {
                                    alert("输入无效，取消导入。");
                                    return;
                                }
                            }

                            // 🌟 提取或组装数据
                            if (targetFlow.moss_jsons.length > 0) {
                                const moss = targetFlow.moss_jsons[0];
                                jsonWidget.value = moss.json;
                                if (jsonWidget.callback) jsonWidget.callback(jsonWidget.value);
                                
                                const wWidget = node.widgets.find((w) => w.name === "canvas_width");
                                const hWidget = node.widgets.find((w) => w.name === "canvas_height");
                                if (wWidget) { wWidget.value = moss.w; wWidget.callback?.(wWidget.value); }
                                if (hWidget) { hWidget.value = moss.h; hWidget.callback?.(hWidget.value); }

                                alert(`✅ 成功导入 MOSS JSON！\n尺寸: ${moss.w} x ${moss.h}`);
                            } 
                            else if (targetFlow.official_boxes.length > 0) {
                                const boxData = targetFlow.official_boxes[0];
                                const W = boxData.w, H = boxData.h;
                                const halfW = W / 2, halfH = H / 2;
                                
                                const items = boxData.boxes.map(box => {
                                    const item = {
                                        label: box.metadata?.type === "text" ? "text" : "object",
                                        caption: box.metadata?.desc || "",
                                        bbox: [
                                            box.y - halfH, 
                                            box.x - halfW, 
                                            box.y - halfH + box.height, 
                                            box.x - halfW + box.width
                                        ]
                                    };
                                    if (box.metadata?.text) item.text = box.metadata.text;
                                    if (box.metadata?.palette && box.metadata.palette.length > 0) item.palette = box.metadata.palette;
                                    return item;
                                });
                                
                                const finalJson = {
                                    summary: { caption: targetFlow.texts.length > 0 ? targetFlow.texts[0] : "" },
                                    items: items,
                                    bbox_coord_space: "abs_centralized",
                                    bbox_format: "yxyx"
                                };

                                jsonWidget.value = serializeLayout(finalJson);
                                if (jsonWidget.callback) jsonWidget.callback(jsonWidget.value);

                                const wWidget = node.widgets.find((w) => w.name === "canvas_width");
                                const hWidget = node.widgets.find((w) => w.name === "canvas_height");
                                if (wWidget) { wWidget.value = W; wWidget.callback?.(wWidget.value); }
                                if (hWidget) { hWidget.value = H; hWidget.callback?.(hWidget.value); }

                                alert(`✅ 已将官方边界框转换为 MOSS JSON 并导入！\n尺寸: ${W} x ${H}`);
                            } 
                            else if (targetFlow.texts.length > 0) {
                                const allTexts = targetFlow.texts.join('\n\n');
                                jsonWidget.value = JSON.stringify({
                                    summary: { caption: allTexts },
                                    items: [],
                                    bbox_coord_space: "abs_centralized",
                                    bbox_format: "yxyx"
                                }, null, 2);
                                if (jsonWidget.callback) jsonWidget.callback(jsonWidget.value);
                                
                                alert(`✅ 未找到边界框数据，但已为您提取并填入纯文本提示词。`);
                            }
                            
                        } else {
                            alert("❌ " + data.error);
                        }
                    } catch (err) {
                        console.error("[MOSS] 请求解析图片失败:", err);
                        alert("请求后端失败，请查看 F12 控制台！\n" + err.message);
                    }
                };
                
                // 🌟 修复 2：触发点击
                console.log("[MOSS] 触发 fileInput.click()");
                fileInput.click();
            });

            const onRemoved = this.onRemoved;
            this.onRemoved = function () {
                const panel = document.getElementById(`moss-bbox-panel-${node.id}`);
                if (panel) panel.remove();
                // 取色浮层、标签样式挂在 body/head 上，节点删除时要一并清理
                document.getElementById(`moss-color-popup-${node.id}`)?.remove();
                document.getElementById(`moss-color-popup-style-${node.id}`)?.remove();
                document.getElementById(`moss-tag-style-${node.id}`)?.remove();
                // 属性面板若处于独立悬浮态，它是挂在 body 上的
                document.getElementById(`moss-editor-${node.id}`)?.remove();
                // 键盘监听挂在 window 捕获阶段，节点删除时必须摘掉
                if (node._mossKeyHandler) {
                    window.removeEventListener("keydown", node._mossKeyHandler, true);
                    node._mossKeyHandler = null;
                }
                node._mossPanelUpdate = null;
                node._mossPendingBackground = null;

                // 节点被移除：如果它是被整图重建掉的（Ctrl+Z），稍后会以同 id 重新出现，
                // 那就保留"面板打开"的记录让新节点自动恢复；否则清掉。
                if (openPanelIds.has(node.id)) {
                    setTimeout(() => {
                        const live = node.graph?.getNodeById?.(node.id);
                        if (!live) openPanelIds.delete(node.id);
                    }, 500);
                }

                return onRemoved?.apply(this, arguments);
            };

            return r;
        };

        const onConnectionsChange = nodeType.prototype.onConnectionsChange;
        nodeType.prototype.onConnectionsChange = function (type, slotIndex, isConnected) {
            const r = onConnectionsChange?.apply(this, arguments);
            // type === 1 表示 INPUT（LiteGraph.INPUT）
            if (type === 1) {
                const slot = this.inputs?.[slotIndex];
                this._mossUpdateToggleState?.();
                if (isConnected && slot?.name === "image") {
                    const w = this.widgets?.find((x) => x.name === "use_image_size");
                    if (w?.value) setTimeout(() => this._mossTryReadImageSize?.(), 100);
                }
            }
            return r;
        };
    },
});

function createFloatingPanel(node, jsonWidget) {
    // 🌟 背景图状态（提前声明，避免 TDZ）
    let bgImage = null;
    let bgOpacity = 0.5;
    let bgActive = false;
    let bgX = 0, bgY = 0, bgW = 0, bgH = 0;
    let bgDragMode = null;
    let bgStartBBox = null;
    let bgStartMouse = { x: 0, y: 0 };
    let bgInitialState = null;
    let bgSource = "none"; // 'manual' | 'auto'

    // 拖动背景图时是否吸附画布边缘/中心（面板里的“吸附”勾选框控制）
    let bgSnap = true;
    // 锁定长宽比：输入尺寸、拖拽边角都按比例同步
    let bgLockRatio = true;

    // 面板里的“尺寸”输入框建好后挂上来（避免上面的函数提前引用导致 TDZ）
    let syncBgSizeHook = null;

    // 🌟 新增：记录所有历史存在过的框的坐标，用于精准识别新建框
    const knownBboxHistory = new Set(); 


    // 🌟 删除背景图
    function deleteBackgroundImage() {
        if (!bgImage) return;
        bgImage = null;
        bgInitialState = null;
        bgSource = "none";
        bgX = 0; bgY = 0; bgW = 0; bgH = 0;
        bgActive = false;
        bgDragMode = null;
        if (bgActiveCb) {
            bgActiveCb.checked = false;
            bgActiveCb.disabled = true;
        }
        if (syncBgSizeHook) syncBgSizeHook();
        if (bgUploadInput) bgUploadInput.value = ""; 
        drawCanvas();
    }

    // 🌟 将图片对象套用为背景图
    function applyBackgroundImage(img, source = "manual") {
        bgImage = img;
        bgSource = source;

        // 导入时使用原图尺寸（1:1 像素），需要铺满时点「⤢ 铺满」
        bgW = img.width;
        bgH = img.height;
        bgX = 0;
        bgY = 0;
        bgInitialState = { x: bgX, y: bgY, w: bgW, h: bgH };
        if (bgActiveCb) bgActiveCb.disabled = false;
        if (syncBgSizeHook) syncBgSizeHook();
        if (typeof drawCanvas === "function") drawCanvas();
    }

    // 🌟 注入面板更新接口（供 node.onExecuted 调用）
    node._mossPanelUpdate = ({ image, clear } = {}) => {
        if (clear) {
            // 只有开关自动加载的图才随开关清理
            if (bgSource === "auto") {
                deleteBackgroundImage();
            }
        } else if (image) {
            // 标记为自动来源
            applyBackgroundImage(image, "auto");
        } else {
            drawCanvas();
        }
    };

    // 🌟 从 Blob/File 加载背景图（文件上传、粘贴共用）
    function loadBackgroundFromBlob(blob) {
        if (!blob || !blob.type || !blob.type.startsWith("image/")) return false;
        const reader = new FileReader();
        reader.onload = (ev) => {
            const img = new Image();
            img.onload = () => applyBackgroundImage(img);
            img.src = ev.target.result;
        };
        reader.readAsDataURL(blob);
        return true;
    }

    // 🌟 核心修复：智能容错，处理空文本与纯文本输入
    const rawVal = (jsonWidget.value || "").trim();
    let needReset = false;
    let finalJsonObj = null;

    if (!rawVal) {
        // 情况 A：完全为空
        needReset = true;
        finalJsonObj = {
            summary: { caption: "" },
            items: [],
            bbox_coord_space: "abs_centralized",
            bbox_format: "yxyx",
        };
    } else {
        try {
            JSON.parse(rawVal); 
            // 解析成功，说明格式合法，什么都不做
        } catch (e) {
            // 情况 B：解析失败（说明用户输入了纯文本），自动包装为 JSON
            needReset = true;
            finalJsonObj = {
                summary: { caption: rawVal }, // 把纯文本直接塞进主提示词
                items: [],
                bbox_coord_space: "abs_centralized",
                bbox_format: "yxyx",
            };
        }
    }

    if (needReset && finalJsonObj) {
        jsonWidget.value = serializeLayout(finalJsonObj);
        if (jsonWidget.callback) jsonWidget.callback(jsonWidget.value);
    }

    const panelId = `moss-bbox-panel-${node.id}`;
    let panel = document.getElementById(panelId);
    if (panel) {
        panel.style.display = "flex";
        panel.style.zIndex = "10000";
        if (node._mossRefreshPanel) node._mossRefreshPanel();
        return;
    }

    // --- 1. 构建主面板 ---
    panel = document.createElement("div");
    panel.id = panelId;
    panel.style.cssText =
        "position: fixed; left: 50%; top: 10%; transform: translateX(-50%); width: 750px; height: 600px; min-width: 450px; min-height: 400px; resize: both; overflow: hidden; background: rgba(30, 30, 30, 0.95); backdrop-filter: blur(10px); border: 1px solid #555; border-radius: 8px; display: flex; flex-direction: column; z-index: 9999; box-shadow: 0 10px 30px rgba(0,0,0,0.8); font-family: sans-serif; color: #eee; font-size: 13px;";

    const header = document.createElement("div");
    header.style.cssText =
        "display: flex; justify-content: space-between; align-items: center; padding: 10px 12px; background: #2a2a2a; border-bottom: 1px solid #444; border-radius: 8px 8px 0 0; font-weight: bold; cursor: move; flex-shrink: 0;";
    
    const titleLeft = document.createElement("div");
    titleLeft.style.cssText = "display: flex; align-items: center; gap: 10px;";
    
    const title = document.createElement("span");
    title.textContent = "边界框管理与预览";
    titleLeft.appendChild(title);

    // 🌟 修改：加上“帮助”文字
    const helpBtn = document.createElement("button");
    helpBtn.textContent = "❓ 帮助";
    helpBtn.title = "查看操作帮助";
    helpBtn.style.cssText = "background: #333; border: 1px solid #555; color: #4a9eff; cursor: pointer; font-size: 11px; padding: 2px 8px; border-radius: 4px; line-height: 1.2; font-weight: normal;";
    
    // 🌟 核心修复 1：阻止 pointerdown 冒泡，防止被标题栏的拖拽逻辑吞噬
    helpBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
    
    helpBtn.onclick = (e) => {
        e.stopPropagation();
        showHelpModal();
    };
    titleLeft.appendChild(helpBtn);

    const closeBtn = document.createElement("button");
    closeBtn.textContent = "✖";
    closeBtn.style.cssText =
        "background: transparent; border: none; color: #aaa; cursor: pointer; font-size: 16px; font-weight: bold;";
    closeBtn.onclick = () => {
        setDetached(false); // 悬浮态要先收回，否则它会留在页面上
        panel.style.display = "none";
        closeColorPopup();
        openPanelIds.delete(node.id); // 用户主动关闭，不再自动恢复
    };
    
    header.appendChild(titleLeft);
    header.appendChild(closeBtn);
    panel.appendChild(header);

    const contentContainer = document.createElement("div");
    contentContainer.style.cssText =
        "display: flex; flex-direction: row; flex: 1; overflow: hidden;";

    // 左侧容器：包含画布和编辑面板
    const leftContainer = document.createElement("div");
    leftContainer.style.cssText =
        "flex: 1; position: relative; display: flex; flex-direction: column; border-right: 1px solid #333; overflow: hidden;";

    const canvasContainer = document.createElement("div");
    canvasContainer.style.cssText =
        "flex: 1; position: relative; display: flex; align-items: center; justify-content: center; background: #111; overflow: hidden;";

        const canvas = document.createElement("canvas");
    canvas.style.cssText =
        "width: 100%; height: 100%; display: block; cursor: crosshair;";
    canvas.tabIndex = 0;
    canvasContainer.appendChild(canvas);

    // ================= 画布右下角工具条（撤销 / 重做 / 重置视图） =================
    const canvasTools = document.createElement("div");
    canvasTools.style.cssText =
        "position: absolute; right: 12px; bottom: 12px; display: flex; gap: 6px; z-index: 21;";
    canvasContainer.appendChild(canvasTools);

    const makeToolBtn = (text, title) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = text;
        btn.title = title;
        btn.style.cssText =
            "background: rgba(30,30,30,0.9); border: 1px solid #555; color: #ccc; border-radius: 6px; padding: 5px 10px; font-size: 12px; cursor: pointer; backdrop-filter: blur(6px); transition: background 0.12s, color 0.12s, border-color 0.12s, opacity 0.12s;";
        btn.onmouseover = () => {
            if (btn.disabled) return;
            btn.style.background = "rgba(60,60,60,0.95)";
            btn.style.color = "#fff";
            btn.style.borderColor = "#777";
        };
        btn.onmouseout = () => {
            btn.style.background = "rgba(30,30,30,0.9)";
            btn.style.color = "#ccc";
            btn.style.borderColor = "#555";
        };
        canvasTools.appendChild(btn);
        return btn;
    };

    const undoBtn = makeToolBtn("↶ 撤销", "撤销上一步编辑");
    const redoBtn = makeToolBtn("↷ 重做", "重做下一步");
    const resetViewBtn = makeToolBtn("🎯 重置视图", "恢复画布的缩放与位移");
    undoBtn.onclick = () => undoEdit();
    redoBtn.onclick = () => redoEdit();
    resetViewBtn.onclick = () => {
        viewScale = 1.0;
        viewX = 0;
        viewY = 0;
        drawCanvas();
    };

    // ================= 新增：画布主提示词悬浮窗 =================
    const promptWrapper = document.createElement("div");
    promptWrapper.style.cssText = "position: absolute; top: 12px; right: 12px; width: 260px; background: rgba(30, 30, 30, 0.85); backdrop-filter: blur(8px); border: 1px solid #444; border-radius: 6px; display: flex; flex-direction: column; z-index: 20; box-shadow: 0 4px 12px rgba(0,0,0,0.5); transition: width 0.2s;";
    
    const promptHeader = document.createElement("div");
    promptHeader.style.cssText = "display: flex; justify-content: space-between; align-items: center; padding: 6px 10px; font-size: 11px; color: #aaa; border-bottom: 1px solid #333; font-weight: bold; cursor: pointer; user-select: none;";
    
    const promptTitle = document.createElement("span");
    promptTitle.textContent = "📝 主提示词 (摘要)";
    
    const toggleIcon = document.createElement("span");
    toggleIcon.textContent = "▼";
    toggleIcon.style.cssText = "font-size: 10px; transition: transform 0.2s;";
    
    promptHeader.appendChild(promptTitle);
    promptHeader.appendChild(toggleIcon);
    
    const promptTextarea = document.createElement("textarea");
    promptTextarea.style.cssText = "width: 100%; height: 80px; box-sizing: border-box; background: transparent; color: #eee; border: none; padding: 8px 10px; font-size: 12px; font-family: sans-serif; resize: vertical; outline: none; line-height: 1.4;";
    promptTextarea.placeholder = "在此输入画面主描述...";

    // 折叠逻辑
    let isPromptExpanded = true;
    promptHeader.onclick = () => {
        isPromptExpanded = !isPromptExpanded;
        promptTextarea.style.display = isPromptExpanded ? "block" : "none";
        promptHeader.style.borderBottom = isPromptExpanded ? "1px solid #333" : "none";
        toggleIcon.style.transform = isPromptExpanded ? "rotate(0deg)" : "rotate(-90deg)";
    };

    // 阻止事件冒泡，防止输入时触发画布快捷键或拖拽
    promptTextarea.addEventListener("mousedown", (e) => e.stopPropagation());
    promptTextarea.addEventListener("wheel", (e) => e.stopPropagation());
    promptTextarea.addEventListener("keydown", (e) => e.stopPropagation());

    promptWrapper.appendChild(promptHeader);
    promptWrapper.appendChild(promptTextarea);
    canvasContainer.appendChild(promptWrapper);
    // ==========================================================
    
    leftContainer.appendChild(canvasContainer);

    // 画布下方的动态编辑面板（属性面板）：默认吸附在画布底部，可切换成独立悬浮窗
    const editorContainer = document.createElement("div");
    editorContainer.className = "moss-editor";
    editorContainer.id = `moss-editor-${node.id}`;

    // 吸附态：画布底部整条
    const DOCKED_STYLE =
        "position: absolute; bottom: 0; left: 0; width: 100%; box-sizing: border-box; display: none; flex-direction: column; padding: 10px 12px; background: rgba(30, 30, 30, 0.95); backdrop-filter: blur(10px); border-top: 1px solid #444; z-index: 10; max-height: 250px; overflow-y: auto;";
    // 独立悬浮态：固定定位，可拖到屏幕任意位置
    const DETACHED_STYLE =
        "position: fixed; box-sizing: border-box; display: none; flex-direction: column; padding: 10px 12px; background: rgba(28, 28, 28, 0.98); backdrop-filter: blur(12px); border: 1px solid #555; border-radius: 8px; z-index: 2147482000; max-height: 70vh; overflow-y: auto; box-shadow: 0 12px 36px rgba(0, 0, 0, 0.7);";
    editorContainer.style.cssText = DOCKED_STYLE;

    // 类型 Tab 切换
    const tabContainer = document.createElement("div");
    tabContainer.style.cssText =
        "display: flex; gap: 2px; margin-bottom: 10px; background: #111; padding: 2px; border-radius: 6px;";
    const objBtn = document.createElement("button");
    objBtn.textContent = "对象";
    const charBtn = document.createElement("button");
    charBtn.textContent = "角色";
    const textBtn = document.createElement("button");
    textBtn.textContent = "文字";
    [objBtn, charBtn, textBtn].forEach((btn) => {
        btn.style.cssText =
            "flex: 1; padding: 6px 0; border: none; border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: bold; transition: 0.2s;";
    });
    tabContainer.appendChild(objBtn);
    tabContainer.appendChild(charBtn);
    tabContainer.appendChild(textBtn);

    // 🌟 独立悬浮按钮：位于属性面板右上角
    const detachBtn = document.createElement("button");
    detachBtn.type = "button";
    detachBtn.textContent = "⧉";
    detachBtn.title = "独立悬浮属性面板（也可在面板空白处双击）";
    detachBtn.style.cssText =
        "flex: 0 0 22px; height: 26px; padding: 0; background: #2a2a2a; border: 1px solid #444; border-radius: 4px; color: #aaa; cursor: pointer; font-size: 12px; line-height: 1;";
    detachBtn.onclick = (e) => {
        e.stopPropagation();
        toggleDetached();
    };
    tabContainer.appendChild(detachBtn);

    editorContainer.appendChild(tabContainer);

    // 独立悬浮时才显示的拖动条（收在面板顶部，按住即可移动）
    const detachBar = document.createElement("div");
    detachBar.style.cssText =
        "display: none; align-items: center; justify-content: space-between; gap: 8px; margin: 0 0 8px; padding: 4px 8px; background: #2a2a2a; border: 1px solid #444; border-radius: 5px; font-size: 11px; color: #999; cursor: move; user-select: none;";
    detachBar.innerHTML =
        '<span>⠿ 按住此条拖动</span><span style="color:#666;">双击空白处收回</span>';
    editorContainer.insertBefore(detachBar, editorContainer.firstChild);

    // 官方 schema 的 label 只有 object / character / text 三种
    const TYPE_TABS = [
        { btn: objBtn, label: "object" },
        { btn: charBtn, label: "character" },
        { btn: textBtn, label: "text" },
    ];
    const updateTypeTabs = (label) => {
        TYPE_TABS.forEach(({ btn, label: value }) => {
            const active = label === value;
            btn.style.background = active ? "#444" : "transparent";
            btn.style.color = active ? "#fff" : "#888";
        });
    };

    // 文字输入框 (仅 text 类型显示)
    const textLabel = document.createElement("div");
    textLabel.textContent = "文字";
    textLabel.style.cssText =
        "font-size: 11px; color: #888; margin-bottom: 4px; display: none;";
    const textArea = document.createElement("textarea");
    textArea.style.cssText =
        "width: 100%; height: 36px; background: #111; color: #eee; border: 1px solid #444; border-radius: 4px; padding: 6px; resize: vertical; font-family: sans-serif; box-sizing: border-box; margin-bottom: 8px; display: none; font-size: 12px;";
    editorContainer.appendChild(textLabel);
    editorContainer.appendChild(textArea);

    // 描述输入框
    const descLabel = document.createElement("div");
    descLabel.textContent = "描述";
    descLabel.style.cssText = "font-size: 11px; color: #888; margin-bottom: 4px;";
    const descArea = document.createElement("textarea");
    descArea.style.cssText =
        "width: 100%; height: 52px; background: #111; color: #eee; border: 1px solid #444; border-radius: 4px; padding: 6px; resize: vertical; font-family: sans-serif; box-sizing: border-box; margin-bottom: 8px; font-size: 12px;";
    editorContainer.appendChild(descLabel);
    editorContainer.appendChild(descArea);

    // 颜色调色板 (多色)
    const colorLabel = document.createElement("div");
    colorLabel.textContent = "调色板";
    colorLabel.style.cssText =
        "font-size: 11px; color: #888; margin-bottom: 4px;";

    // 取色器不再用原生 <input type="color">：它的弹窗位置由浏览器决定，无法夹取。
    // 改为下方自绘浮层（colorPopup），位置完全可控。

    const paletteContainer = document.createElement("div");
    paletteContainer.style.cssText =
        "display: flex; flex-wrap: wrap; gap: 6px; align-items: center;";

    editorContainer.appendChild(colorLabel);
    editorContainer.appendChild(paletteContainer);

    const tagsLabel = document.createElement("div");
    tagsLabel.textContent = "标签";
    tagsLabel.style.cssText = "font-size: 11px; color: #888; margin: 8px 0 4px;";
    const tagsContainer = document.createElement("div");
    tagsContainer.style.cssText = "display: flex; flex-wrap: wrap; gap: 6px; align-items: center;";
    editorContainer.appendChild(tagsLabel);
    editorContainer.appendChild(tagsContainer);

    // 标签的悬浮/选中样式只能靠 CSS（内联样式写不了 :hover）
    const tagStyle = document.createElement("style");
    tagStyle.id = `moss-tag-style-${node.id}`;
    tagStyle.textContent = `
.moss-grip { flex: 0 0 auto; padding: 0 1px; color: #666; font-size: 13px; line-height: 1; letter-spacing: -1px; cursor: grab; user-select: none; transition: color 0.12s; }
.moss-grip:hover { color: #bbb; }
.moss-grip:active { cursor: grabbing; }
.moss-row-placeholder { flex: 0 0 auto; border-radius: 4px; border: 1px dashed #4a9eff; background: rgba(74, 158, 255, 0.10); }
.moss-editor > * { flex-shrink: 0; }
.moss-editor .moss-tag { display: inline-block; padding: 3px 8px; border: 1px solid #555; border-radius: 12px; background: #333; color: #ccc; font-size: 11px; line-height: 1.4; cursor: pointer; user-select: none; transition: background 0.12s, border-color 0.12s, color 0.12s; }
.moss-editor .moss-tag:hover { background: #414141; border-color: #8a8a8a; color: #fff; }
.moss-editor .moss-tag.is-selected { background: #24405e; border-color: #4a9eff; color: #dbe9ff; }
.moss-editor .moss-tag.is-selected:hover { background: #2c4c6e; border-color: #6bb0ff; }
.moss-editor .moss-tag-input { width: 100px; padding: 2px 8px; border-radius: 12px; border: 1px solid #4a9eff; background: #111; color: #eee; font-size: 11px; outline: none; }
.moss-editor .moss-chip-add { width: 24px; height: 24px; padding: 0; box-sizing: border-box; display: flex; align-items: center; justify-content: center; background: #333; border: 1px solid #555; border-radius: 4px; color: #ccc; cursor: pointer; font-size: 16px; line-height: 1; transition: background 0.12s, border-color 0.12s, color 0.12s; }
.moss-editor .moss-chip-add:hover { background: #444; border-color: #8a8a8a; color: #fff; }
.moss-editor .moss-swatch { width: 24px; height: 24px; box-sizing: border-box; border-radius: 4px; border: 2px solid #555; cursor: pointer; transition: border-color 0.12s, transform 0.12s, box-shadow 0.12s; }
.moss-editor .moss-swatch:hover { border-color: #8a8a8a; transform: translateY(-1px); }
.moss-editor .moss-swatch.is-selected { border-color: #4a9eff; box-shadow: 0 0 0 2px rgba(74, 158, 255, 0.35); }
.moss-editor .moss-swatch.is-selected:hover { border-color: #6bb0ff; }
`;
    document.head.appendChild(tagStyle);

    let selectedPaletteIndex = -1;
    // 记录“当前高亮”属于哪个框，切换框时才能把残留的选中态清掉
    let selectedPaletteOwner = -1;
    // 🌟 延时开浮层的定时器：双击必须在弹窗之前判定，所以单击要等一小会儿
    let paletteClickTimer = null;

    // 🌟 只切换选中样式，不重建 DOM（重建会打断取色浮层的锚点元素）
    const refreshPaletteHighlight = () => {
        paletteContainer.querySelectorAll("[data-color-idx]").forEach((el) => {
            const idx = Number(el.dataset.colorIdx);
            el.classList.toggle("is-selected", idx === selectedPaletteIndex);
        });
    };

    // 🌟 删除指定色块（双击 / 右键 / Delete 键共用同一条路径）
    const deletePaletteColor = (colorIdx) => {
        const target = currentItems[activeIndex];
        if (!target || !Array.isArray(target.palette)) return;
        if (colorIdx < 0 || colorIdx >= target.palette.length) return;
        if (paletteClickTimer) {
            clearTimeout(paletteClickTimer);
            paletteClickTimer = null;
        }
        closeColorPopup(false);
        target.palette.splice(colorIdx, 1);
        // 空数组不留字段
        if (target.palette.length === 0) delete target.palette;
        selectedPaletteIndex = -1;
        syncEditorPanel();
        saveEditorChanges();
    };

    const deleteSelectedPalette = () => {
        if (activeIndex === -1 || selectedPaletteIndex < 0) return;
        deletePaletteColor(selectedPaletteIndex);
    };

    // 🌟 「+」按钮：色块栏和标签栏共用同一套外观与行为
    const makeAddChipButton = (title, onClick) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "moss-chip-add";
        btn.textContent = "+";
        btn.title = title;
        btn.onclick = (e) => {
            e.stopPropagation();
            onClick();
        };
        return btn;
    };

    // 🌟 调色板整行重建：色块在前、「+」永远排在最后（与标签栏一致）
    const renderPalette = () => {
        const item = currentItems[activeIndex];
        paletteContainer.innerHTML = "";
        if (!item) return;

        // 换了框就清掉上一个框的选中态
        if (selectedPaletteOwner !== activeIndex) {
            selectedPaletteIndex = -1;
            selectedPaletteOwner = activeIndex;
        }

        const palette = Array.isArray(item.palette) ? item.palette : [];

        palette.forEach((color, colorIdx) => {
            const swatch = document.createElement("div");
            swatch.className = "moss-swatch" + (colorIdx === selectedPaletteIndex ? " is-selected" : "");
            swatch.dataset.colorIdx = String(colorIdx);
            swatch.tabIndex = 0;
            swatch.style.backgroundColor = color;
            swatch.title = "单击改颜色，双击或右键删除";

            // 单击：先立刻高亮（反馈要即时），再延时开取色浮层——
            // 那 200ms 是留给双击判定的，双击时绝不弹窗
            swatch.onclick = (e) => {
                e.stopPropagation();
                selectedPaletteIndex = colorIdx;
                selectedPaletteOwner = activeIndex;
                // 色块和标签是互斥选中，避免 Delete 键删错对象
                selectedTagIndex = -1;
                refreshTagHighlight();
                refreshPaletteHighlight();
                swatch.focus();

                if (paletteClickTimer) clearTimeout(paletteClickTimer);
                paletteClickTimer = setTimeout(() => {
                    paletteClickTimer = null;
                    openColorPopup(swatch, colorIdx);
                }, 200);
            };

            // 双击：先掐掉待开的浮层，再删除
            swatch.ondblclick = (e) => {
                e.stopPropagation();
                if (paletteClickTimer) {
                    clearTimeout(paletteClickTimer);
                    paletteClickTimer = null;
                }
                closeColorPopup(false);
                deletePaletteColor(colorIdx);
            };

            // 右键删除
            swatch.oncontextmenu = (e) => {
                e.preventDefault();
                e.stopPropagation();
                closeColorPopup(false);
                deletePaletteColor(colorIdx);
            };

            paletteContainer.appendChild(swatch);
        });

        paletteContainer.appendChild(
            makeAddChipButton("添加颜色", () => {
                if (activeIndex === -1) return;
                const cur = currentItems[activeIndex];
                if (!cur) return;
                if (!Array.isArray(cur.palette)) cur.palette = [];
                cur.palette.push("#FFFFFF");
                const newIdx = cur.palette.length - 1;
                selectedPaletteIndex = newIdx;
                selectedPaletteOwner = activeIndex;
                renderPalette();
                saveEditorChanges();
                // 新建后直接弹取色浮层，和标签栏「点 + 直接进编辑」对齐
                const swatchEl = paletteContainer.querySelector(`[data-color-idx="${newIdx}"]`);
                if (swatchEl) openColorPopup(swatchEl, newIdx);
            })
        );
    };

    // ================= 标签：选中 / 编辑 / 删除 =================
    let selectedTagIndex = -1;
    let selectedTagOwner = -1;
    let editingTagIndex = null; // null=不在编辑; -1=新增; >=0=编辑已有

    const refreshTagHighlight = () => {
        tagsContainer.querySelectorAll(".moss-tag").forEach((el) => {
            const idx = Number(el.dataset.tagIdx);
            el.classList.toggle("is-selected", idx === selectedTagIndex);
        });
    };

    const deleteTag = (tagIdx) => {
        const item = currentItems[activeIndex];
        if (!item || !Array.isArray(item.tags)) return;
        if (tagIdx < 0 || tagIdx >= item.tags.length) return;
        item.tags.splice(tagIdx, 1);
        // 空数组不留字段
        if (item.tags.length === 0) delete item.tags;
        selectedTagIndex = -1;
        editingTagIndex = null;
        renderTags();
        saveEditorChanges();
    };

    // 内联输入框：Enter 提交、Esc 取消、失焦提交（不再依赖原生 prompt，
    // 原生 prompt 被浏览器拦截时会静默失败，表现为“点 + 没反应”）
    const makeTagInput = (tagIdx, value) => {
        const input = document.createElement("input");
        input.type = "text";
        input.className = "moss-tag-input";
        input.value = value || "";
        input.placeholder = tagIdx >= 0 ? "" : "新标签…";

        let finished = false;
        const finish = (ok) => {
            if (finished) return;
            finished = true;
            const cur = currentItems[activeIndex];
            let text = "";
            if (ok && cur) {
                text = input.value.trim();
                if (text) {
                    if (!Array.isArray(cur.tags)) cur.tags = [];
                    if (tagIdx >= 0 && tagIdx < cur.tags.length) cur.tags[tagIdx] = text;
                    else cur.tags.push(text);
                    selectedTagIndex = tagIdx >= 0 ? tagIdx : cur.tags.length - 1;
                    selectedTagOwner = activeIndex;
                }
            }
            editingTagIndex = null;
            renderTags();
            if (text) saveEditorChanges();
        };

        input.addEventListener("keydown", (e) => {
            // 别让编辑器的 Delete/Backspace 逻辑把标签误删
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
        return input;
    };

    const renderTags = () => {
        const item = currentItems[activeIndex];
        tagsContainer.innerHTML = "";
        if (!item) return;

        // 换了框就清掉上一个框的选中态，并退出编辑
        if (selectedTagOwner !== activeIndex) {
            selectedTagIndex = -1;
            selectedTagOwner = activeIndex;
            editingTagIndex = null;
        }

        const tags = Array.isArray(item.tags) ? item.tags : [];

        tags.forEach((tag, idx) => {
            if (editingTagIndex === idx) {
                tagsContainer.appendChild(makeTagInput(idx, tag));
                return;
            }
            const chip = document.createElement("span");
            chip.className = "moss-tag" + (idx === selectedTagIndex ? " is-selected" : "");
            chip.textContent = tag;
            chip.dataset.tagIdx = String(idx);
            chip.tabIndex = 0;
            chip.title = "单击选中，双击编辑，右键或 Delete 删除";

            chip.onclick = (e) => {
                e.stopPropagation();
                selectedTagIndex = idx;
                selectedTagOwner = activeIndex;
                // 色块和标签是互斥选中
                selectedPaletteIndex = -1;
                refreshPaletteHighlight();
                chip.focus();
                refreshTagHighlight();
            };
            chip.ondblclick = (e) => {
                e.stopPropagation();
                editingTagIndex = idx;
                renderTags();
            };
            chip.oncontextmenu = (e) => {
                e.preventDefault();
                e.stopPropagation();
                deleteTag(idx);
            };
            tagsContainer.appendChild(chip);
        });

        if (editingTagIndex === -1) {
            tagsContainer.appendChild(makeTagInput(-1, ""));
        } else {
            tagsContainer.appendChild(
                makeAddChipButton("添加标签", () => {
                    if (activeIndex === -1) return;
                    editingTagIndex = -1;
                    renderTags();
                })
            );
        }

        const editingInput = tagsContainer.querySelector(".moss-tag-input");
        if (editingInput && document.activeElement !== editingInput) {
            editingInput.focus();
            editingInput.select();
        }
    };

    editorContainer.addEventListener("keydown", (event) => {
        if (event.key !== "Delete" && event.key !== "Backspace") return;
        // 在输入框里打字时不要触发删除
        const el = event.target;
        if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
        event.preventDefault();
        // 先删选中的标签，没有选中标签再删选中的色块
        if (selectedTagIndex >= 0 && selectedTagOwner === activeIndex) {
            deleteTag(selectedTagIndex);
            return;
        }
        deleteSelectedPalette();
    });

    // ================= 自绘取色浮层 =================
    // 定位规则（全部由这里掌握，不交给浏览器）：
    //   1. 默认贴在“被选中色块”的右上角，浮层整体位于色块上方；
    //   2. 右边超出视口时停下，不再继续往右（只夹到视口右边缘）；
    //   3. 无论如何都不会翻到色块下方。
    const colorPopup = document.createElement("div");
    colorPopup.id = `moss-color-popup-${node.id}`;
    colorPopup.style.cssText =
        "position: fixed; left: 0; top: 0; display: none; width: 208px; padding: 8px; box-sizing: border-box; " +
        "background: rgba(32,32,32,0.98); border: 1px solid #555; border-radius: 8px; " +
        "box-shadow: 0 10px 28px rgba(0,0,0,0.65); font-family: sans-serif; z-index: 2147483647;";
    document.body.appendChild(colorPopup);

    // 滑块拇指只能靠伪元素样式，内联样式管不到
    const colorPopupStyle = document.createElement("style");
    colorPopupStyle.id = `moss-color-popup-style-${node.id}`;
    colorPopupStyle.textContent = `
#${colorPopup.id} input[type="range"] { -webkit-appearance: none; appearance: none; background: transparent; }
#${colorPopup.id} input[type="range"]::-webkit-slider-thumb { -webkit-appearance: none; width: 14px; height: 14px; border-radius: 50%; background: #fff; border: 2px solid #222; box-shadow: 0 0 0 1px #888; cursor: pointer; }
#${colorPopup.id} input[type="range"]::-moz-range-thumb { width: 12px; height: 12px; border-radius: 50%; background: #fff; border: 2px solid #222; box-shadow: 0 0 0 1px #888; cursor: pointer; }
`;
    document.head.appendChild(colorPopupStyle);

    // 饱和度/明度面板
    const svBox = document.createElement("div");
    svBox.style.cssText =
        "position: relative; width: 100%; height: 108px; border-radius: 4px; cursor: crosshair; touch-action: none; user-select: none; background-color: #f00;";
    const svCursor = document.createElement("div");
    svCursor.style.cssText =
        "position: absolute; left: 0; top: 0; width: 10px; height: 10px; margin: -5px 0 0 -5px; border: 2px solid #fff; border-radius: 50%; box-shadow: 0 0 0 1px rgba(0,0,0,0.7); pointer-events: none;";
    svBox.appendChild(svCursor);
    colorPopup.appendChild(svBox);

    // 色相滑块
    const hueInput = document.createElement("input");
    hueInput.type = "range";
    hueInput.min = "0";
    hueInput.max = "360";
    hueInput.step = "1";
    hueInput.style.cssText =
        "display: block; width: 100%; height: 14px; margin: 10px 0 0; border-radius: 7px; outline: none; cursor: pointer; " +
        "background: linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00);";
    colorPopup.appendChild(hueInput);

    // 预览 + 十六进制输入
    const hexRow = document.createElement("div");
    hexRow.style.cssText = "display: flex; align-items: center; gap: 6px; margin-top: 8px;";
    const hexPreview = document.createElement("div");
    hexPreview.style.cssText =
        "width: 22px; height: 22px; flex-shrink: 0; border-radius: 4px; border: 1px solid #555;";
    const hexInput = document.createElement("input");
    hexInput.type = "text";
    hexInput.spellcheck = false;
    hexInput.style.cssText =
        "flex: 1; min-width: 0; background: #111; color: #eee; border: 1px solid #444; border-radius: 4px; " +
        "padding: 4px 6px; font-size: 12px; font-family: monospace; outline: none; text-transform: uppercase;";
    hexRow.appendChild(hexPreview);
    hexRow.appendChild(hexInput);
    colorPopup.appendChild(hexRow);

    // ---- 颜色换算 ----
    const hsvToHex = (h, s, v) => {
        const c = v * s;
        const hp = (((h % 360) + 360) % 360) / 60;
        const x = c * (1 - Math.abs((hp % 2) - 1));
        let r = 0, g = 0, b = 0;
        if (hp < 1) { r = c; g = x; }
        else if (hp < 2) { r = x; g = c; }
        else if (hp < 3) { g = c; b = x; }
        else if (hp < 4) { g = x; b = c; }
        else if (hp < 5) { r = x; b = c; }
        else { r = c; b = x; }
        const m = v - c;
        const toHex = (n) =>
            Math.round(Math.max(0, Math.min(1, n + m)) * 255)
                .toString(16)
                .padStart(2, "0");
        return `#${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase();
    };

    const hexToHsv = (hex) => {
        let raw = String(hex || "").trim().replace(/^#/, "");
        if (!/^([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(raw)) return { h: 0, s: 1, v: 1 };
        if (raw.length === 3) raw = raw.split("").map((c) => c + c).join("");
        const r = parseInt(raw.slice(0, 2), 16) / 255;
        const g = parseInt(raw.slice(2, 4), 16) / 255;
        const b = parseInt(raw.slice(4, 6), 16) / 255;
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const d = max - min;
        let h = 0;
        if (d !== 0) {
            if (max === r) h = ((g - b) / d) % 6;
            else if (max === g) h = (b - r) / d + 2;
            else h = (r - g) / d + 4;
            h *= 60;
            if (h < 0) h += 360;
        }
        return { h: Math.round(h), s: max === 0 ? 0 : d / max, v: max };
    };

    const picker = { h: 0, s: 1, v: 1, colorIdx: -1 };
    let pickerDirty = false;

    // 把 picker 的当前颜色写回数据（不落盘），并刷新浮层
    const applyPickerColor = () => {
        const hex = hsvToHex(picker.h, picker.s, picker.v);

        const pureHue = hsvToHex(picker.h, 1, 1);
        svBox.style.backgroundImage =
            `linear-gradient(to top, #000, rgba(0,0,0,0)), linear-gradient(to right, #fff, ${pureHue})`;
        const boxW = svBox.clientWidth || 192;
        const boxH = svBox.clientHeight || 108;
        svCursor.style.left = `${picker.s * boxW}px`;
        svCursor.style.top = `${(1 - picker.v) * boxH}px`;
        if (String(hueInput.value) !== String(Math.round(picker.h))) {
            hueInput.value = String(Math.round(picker.h));
        }
        hexPreview.style.backgroundColor = hex;
        if (document.activeElement !== hexInput) hexInput.value = hex;

        const item = currentItems[activeIndex];
        if (
            item &&
            Array.isArray(item.palette) &&
            picker.colorIdx >= 0 &&
            picker.colorIdx < item.palette.length
        ) {
            if (item.palette[picker.colorIdx] !== hex) {
                item.palette[picker.colorIdx] = hex;
                pickerDirty = true;
            }
            const swatchEl = paletteContainer.querySelector(`[data-color-idx="${picker.colorIdx}"]`);
            if (swatchEl) swatchEl.style.backgroundColor = hex;
        }
    };

    const commitPickerColor = () => {
        if (!pickerDirty) return;
        pickerDirty = false;
        // 不要在这里重建面板 DOM：commit 可能发生在 pointerdown 阶段，
        // 重建会把「+」这类按钮换掉，导致紧接着的 click 落空。
        saveEditorChanges();
    };

    const closeColorPopup = (commit = true) => {
        if (colorPopup.style.display === "none") return;
        colorPopup.style.display = "none";
        picker.colorIdx = -1;
        if (commit) commitPickerColor();
        pickerDirty = false;
    };

    const openColorPopup = (anchorEl, colorIdx) => {
        const item = currentItems[activeIndex];
        if (!item) return;
        // 延时开窗期间色块可能被重绘过，重新取一次锚点
        if (!anchorEl || !anchorEl.isConnected) {
            anchorEl = paletteContainer.querySelector(`[data-color-idx="${colorIdx}"]`);
            if (!anchorEl) return;
        }
        const current = Array.isArray(item.palette) ? item.palette[colorIdx] : null;
        const hsv = hexToHsv(current || "#FFFFFF");
        picker.h = hsv.h;
        picker.s = hsv.s;
        picker.v = hsv.v;
        picker.colorIdx = colorIdx;
        pickerDirty = false;

        selectedPaletteIndex = colorIdx;
        selectedPaletteOwner = activeIndex;
        refreshPaletteHighlight();

        // 先显示再测量，否则 offsetHeight 为 0
        colorPopup.style.display = "block";
        applyPickerColor();
        pickerDirty = false;

        const popupW = colorPopup.offsetWidth;
        const popupH = colorPopup.offsetHeight;
        const rect = anchorEl.getBoundingClientRect();
        const margin = 8;

        // 默认：色块右上角外侧，且整体在色块上方
        let left = rect.right + 6;
        let top = rect.top - popupH - 6;

        // 右边到界就停（不越过视口右边缘），左右都夹一次，保证不越界；
        // 顶部同理，但绝不翻到色块下方
        const maxLeft = Math.max(margin, window.innerWidth - margin - popupW);
        if (left > maxLeft) left = maxLeft;
        if (left < margin) left = margin;
        if (top < margin) top = margin;

        colorPopup.style.left = `${Math.round(left)}px`;
        colorPopup.style.top = `${Math.round(top)}px`;
    };

    // ---- 浮层交互 ----
    let isSvDragging = false;
    const updateSvFromPointer = (e) => {
        const rect = svBox.getBoundingClientRect();
        const x = Math.min(Math.max(e.clientX - rect.left, 0), rect.width);
        const y = Math.min(Math.max(e.clientY - rect.top, 0), rect.height);
        picker.s = rect.width ? x / rect.width : 0;
        picker.v = rect.height ? 1 - y / rect.height : 1;
        applyPickerColor();
    };

    svBox.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        isSvDragging = true;
        svBox.setPointerCapture?.(e.pointerId);
        updateSvFromPointer(e);
    });
    svBox.addEventListener("pointermove", (e) => {
        if (isSvDragging) updateSvFromPointer(e);
    });
    const endSvDrag = () => {
        if (!isSvDragging) return;
        isSvDragging = false;
        commitPickerColor();
    };
    svBox.addEventListener("pointerup", endSvDrag);
    svBox.addEventListener("pointercancel", endSvDrag);

    hueInput.addEventListener("input", () => {
        picker.h = Number(hueInput.value) || 0;
        applyPickerColor();
    });
    hueInput.addEventListener("change", () => commitPickerColor());

    hexInput.addEventListener("focus", () => hexInput.select());
    hexInput.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
            e.preventDefault();
            hexInput.blur();
        } else if (e.key === "Escape") {
            e.preventDefault();
            closeColorPopup();
        }
    });
    hexInput.addEventListener("change", () => {
        const hsv = hexToHsv(hexInput.value);
        picker.h = hsv.h;
        picker.s = hsv.s;
        picker.v = hsv.v;
        applyPickerColor();
        commitPickerColor();
    });

    // 点击浮层以外任何地方就收起；点色块自己除外（交给它的 click 重新定位）
    document.addEventListener(
        "pointerdown",
        (e) => {
            if (e.target.closest?.("[data-color-idx]")) return;
            if (colorPopup.contains(e.target)) return;
            // 还没弹出来的延时任务也要掐掉，否则点了别处它仍会冒出来
            if (paletteClickTimer) {
                clearTimeout(paletteClickTimer);
                paletteClickTimer = null;
            }
            closeColorPopup();
        },
        true
    );
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") closeColorPopup();
    });

    // ================= 属性面板：独立悬浮 / 收回 =================
    let isPanelDetached = false;
    let detachedPos = { x: 0, y: 0 };

    // 画布右下角工具条要避让「吸附在底部」的属性面板；面板悬浮时它不该被顶上去
    const updateCanvasToolbarOffset = () => {
        if (!canvasTools) return;
        const dockedVisible = editorContainer.style.display !== "none" && !isPanelDetached;
        canvasTools.style.bottom = dockedVisible ? `${editorContainer.offsetHeight + 12}px` : "12px";
    };

    const setDetached = (detached) => {
        if (detached === isPanelDetached) return;
        const wasVisible = editorContainer.style.display !== "none";
        isPanelDetached = detached;

        if (detached) {
            // 以当前屏幕位置作为悬浮窗初始位置，并夹进视口
            const rect = editorContainer.getBoundingClientRect();
            const width = Math.min(380, Math.max(280, Math.round(rect.width) || 360));
            const x = Math.min(Math.max(rect.left, 8), Math.max(8, window.innerWidth - width - 8));
            const y = Math.min(Math.max(rect.top, 8), Math.max(8, window.innerHeight - 80));
            detachedPos = { x, y };

            editorContainer.style.cssText = DETACHED_STYLE;
            editorContainer.style.width = `${width}px`;
            editorContainer.style.left = `${x}px`;
            editorContainer.style.top = `${y}px`;
            document.body.appendChild(editorContainer);

            detachBar.style.display = "flex";
            detachBtn.textContent = "⤓";
            detachBtn.title = "收回属性面板（也可在面板空白处双击）";
        } else {
            editorContainer.style.cssText = DOCKED_STYLE;
            leftContainer.appendChild(editorContainer);
            detachBar.style.display = "none";
            detachBtn.textContent = "⧉";
            detachBtn.title = "独立悬浮属性面板（也可在面板空白处双击）";
        }

        if (wasVisible) editorContainer.style.display = "flex";
        updateCanvasToolbarOffset();
    };

    const toggleDetached = () => {
        if (activeIndex === -1) return; // 没有选中框时面板本身是隐藏的
        setDetached(!isPanelDetached);
    };

    // 按住拖动条移动悬浮窗
    let isDraggingDetached = false;
    let detachGrabX = 0;
    let detachGrabY = 0;

    detachBar.addEventListener("pointerdown", (e) => {
        if (e.target.closest("button")) return;
        isDraggingDetached = true;
        const rect = editorContainer.getBoundingClientRect();
        detachGrabX = e.clientX - rect.left;
        detachGrabY = e.clientY - rect.top;
        detachBar.setPointerCapture?.(e.pointerId);
        e.preventDefault();
    });

    detachBar.addEventListener("pointermove", (e) => {
        if (!isDraggingDetached) return;
        const w = editorContainer.offsetWidth || 360;
        const x = Math.min(Math.max(e.clientX - detachGrabX, 0), Math.max(0, window.innerWidth - w));
        const y = Math.min(Math.max(e.clientY - detachGrabY, 0), Math.max(0, window.innerHeight - 40));
        detachedPos = { x, y };
        editorContainer.style.left = `${x}px`;
        editorContainer.style.top = `${y}px`;
    });

    const endDetachDrag = (e) => {
        if (!isDraggingDetached) return;
        isDraggingDetached = false;
        detachBar.releasePointerCapture?.(e.pointerId);
    };
    detachBar.addEventListener("pointerup", endDetachDrag);
    detachBar.addEventListener("pointercancel", endDetachDrag);

    // 空白处双击：独立 / 收回
    editorContainer.addEventListener("dblclick", (e) => {
        const t = e.target;
        if (t.closest("input, textarea, select, button, .moss-tag, .moss-tag-input, .moss-swatch, .moss-chip-add")) return;
        toggleDetached();
    });

    // 窗口变小后把悬浮窗拉回可见区域
    window.addEventListener("resize", () => {
        if (!isPanelDetached) return;
        const w = editorContainer.offsetWidth || 360;
        const x = Math.min(detachedPos.x, Math.max(0, window.innerWidth - w));
        const y = Math.min(detachedPos.y, Math.max(0, window.innerHeight - 40));
        if (x !== detachedPos.x || y !== detachedPos.y) {
            detachedPos = { x, y };
            editorContainer.style.left = `${x}px`;
            editorContainer.style.top = `${y}px`;
        }
    });

    leftContainer.appendChild(editorContainer);
    contentContainer.appendChild(leftContainer);

    const rightContainer = document.createElement("div");
    // 锁死宽度：否则行内超长文本会通过 min-content 把整列撑宽，把左边画布挤窄
    rightContainer.style.cssText =
        "flex: 0 0 280px; width: 280px; min-width: 280px; max-width: 280px; overflow: hidden; display: flex; flex-direction: column; background: #1e1e1e;";


    const toolbar = document.createElement("div");
    // 🌟 改为纵向排列，分成两行
    toolbar.style.cssText =
        "display: flex; flex-direction: column; gap: 8px; padding: 10px; border-bottom: 1px solid #333; flex-shrink: 0;";

    // --- 第一行：视图与辅助工具 ---
    const topRow = document.createElement("div");
    topRow.style.cssText = "display: flex; justify-content: space-between; align-items: center; gap: 6px;";

    const selectAllLabel = document.createElement("label");
    selectAllLabel.style.cssText =
        "flex: 1; display: flex; align-items: center; justify-content: center; cursor: pointer; gap: 4px; font-size: 12px; background: #2a2a2a; border: 1px solid #444; border-radius: 4px; padding: 5px 0;";
    const selectAllCb = document.createElement("input");
    selectAllCb.type = "checkbox";
    selectAllCb.style.cssText =
        "cursor: pointer; accent-color: #4a9eff; margin: 0;";
    selectAllLabel.appendChild(selectAllCb);
    selectAllLabel.appendChild(document.createTextNode("全选"));

    // 找到原来的 snapLabel 部分，整体替换为：
    const snapWrapper = document.createElement("div");
    snapWrapper.style.cssText =
        "flex: 1.5; display: flex; align-items: center; justify-content: center; gap: 6px; font-size: 12px; color: #aaa; background: #2a2a2a; border: 1px solid #444; border-radius: 4px; padding: 3px 6px;";

    const snapCb = document.createElement("input");
    snapCb.type = "checkbox";
    snapCb.checked = false;
    snapCb.style.cssText = "cursor: pointer; accent-color: #4a9eff; margin: 0;";
    
    const snapText = document.createElement("span");
    snapText.textContent = "吸附";

    const gridSizeSelect = document.createElement("select");
    gridSizeSelect.style.cssText = "background: #111; color: #eee; border: 1px solid #444; border-radius: 4px; padding: 0 2px; outline: none; cursor: pointer; font-size: 11px;";
    [16, 32].forEach(sz => {
        const opt = document.createElement("option");
        opt.value = sz;
        opt.textContent = sz;
        gridSizeSelect.appendChild(opt);
    });
    gridSizeSelect.onchange = () => {
        GRID_SNAP = parseInt(gridSizeSelect.value);
        // 极小框的视觉代理边长跟随网格：16px 网格 → 16，32px 网格 → 32
        sizeInput.max = String(Math.max(1, GRID_SNAP - 1));
        syncEditorPanel(); // 刷新尺寸输入框上限与极小框状态
        drawCanvas(); // 立刻重绘画布，更新网格线与极小框代理
    };

    snapWrapper.appendChild(snapCb);
    snapWrapper.appendChild(snapText);
    snapWrapper.appendChild(gridSizeSelect);

    // 最后把 snapWrapper 塞入顶部的 topRow 中
    topRow.appendChild(selectAllLabel);
    topRow.appendChild(snapWrapper);
    toolbar.appendChild(topRow);

    // --- 第二行：增删操作 ---
    const bottomRow = document.createElement("div");
    bottomRow.style.cssText = "display: flex; gap: 8px;";

    const addBtn = document.createElement("button");
    addBtn.textContent = "➕ 添加";
    addBtn.title = "新建一个边界框";
    addBtn.style.cssText =
        "flex: 1; background: #2e7d32; color: white; border: none; padding: 6px 0; border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: bold;";
        
    const deleteBtn = document.createElement("button");
    deleteBtn.textContent = "🗑 删除";
    deleteBtn.title = "删除选中的边界框";
    deleteBtn.style.cssText =
        "flex: 1; background: #d32f2f; color: white; border: none; padding: 6px 0; border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: bold;";

    bottomRow.appendChild(addBtn);
    bottomRow.appendChild(deleteBtn);
    toolbar.appendChild(bottomRow);

    rightContainer.appendChild(toolbar);

    // ================= 画布模式（summary.canvas） =================
    // JSON 顶层字段，不属于背景图设置，单独放在工具栏下方
    const canvasModePanel = document.createElement("div");
    canvasModePanel.style.cssText =
        "margin: 8px 10px 0; padding: 8px 10px; border: 1px solid #444; border-radius: 6px; display: flex; align-items: center; gap: 8px; background: #1a1a1a;";

    const canvasModeLabel = document.createElement("span");
    canvasModeLabel.textContent = "🧩 画布模式";
    canvasModeLabel.style.cssText = "font-size: 12px; color: #aaa; white-space: nowrap;";

    const canvasModeSelect = document.createElement("select");
    canvasModeSelect.style.cssText =
        "flex: 1; min-width: 0; background: #111; color: #eee; border: 1px solid #444; border-radius: 4px; padding: 4px 6px; outline: none; cursor: pointer; font-size: 12px;";
    [
        { value: "", label: "默认 (不设置)" },
        { value: "single", label: "单图" },
        { value: "multi_panel", label: "多面板/分镜" },
        { value: "collage", label: "拼贴" },
    ].forEach((opt) => {
        const o = document.createElement("option");
        o.value = opt.value;
        o.textContent = opt.label;
        canvasModeSelect.appendChild(o);
    });

    canvasModePanel.appendChild(canvasModeLabel);
    canvasModePanel.appendChild(canvasModeSelect);
    rightContainer.appendChild(canvasModePanel);

    // （原「对齐 / 分布」面板已移除：构图以手操为主，不再占用右栏空间）

    // ================= 极小框控制面板 =================
    const smallBoxPanel = document.createElement("div");
    smallBoxPanel.style.cssText = "margin: 8px 10px 0; padding: 10px; border: 1px solid #444; border-radius: 6px; display: flex; flex-direction: column; gap: 8px; background: #1a1a1a;";
    
    const smallBoxTitle = document.createElement("div");
    smallBoxTitle.textContent = "📐 极小框控制";
    smallBoxTitle.style.cssText = "font-size: 12px; font-weight: bold; color: #aaa; border-bottom: 1px solid #333; padding-bottom: 4px; margin-bottom: 2px;";
    smallBoxPanel.appendChild(smallBoxTitle);

    const smallBoxRow = document.createElement("div");
    smallBoxRow.style.cssText = "display: flex; align-items: center; gap: 6px; font-size: 12px; flex-wrap: wrap;";
    
    const enableSmallCb = document.createElement("input");
    enableSmallCb.type = "checkbox";
    enableSmallCb.style.cssText = "cursor: pointer; accent-color: #4a9eff; margin: 0;";
    
    const sizeLabel = document.createElement("span");
    sizeLabel.textContent = "尺寸:";
    sizeLabel.style.color = "#aaa";
    
    const sizeInput = document.createElement("input");
    sizeInput.type = "number";
    sizeInput.min = "1";
    sizeInput.max = "15";
    sizeInput.value = "8";
    sizeInput.style.cssText = "width: 40px; background: #111; color: #eee; border: 1px solid #444; border-radius: 4px; padding: 2px 4px; text-align: center;";

    // 🌟 新增：对齐方式下拉框
    const alignSelect = document.createElement("select");
    alignSelect.style.cssText = "flex: 1; background: #111; color: #eee; border: 1px solid #444; border-radius: 4px; padding: 2px 4px; outline: none; cursor: pointer; font-size: 11px;";
    const alignOptions = [
        { value: "center", label: "中心" },
        { value: "tl", label: "左上" },
        { value: "tr", label: "右上" },
        { value: "bl", label: "左下" },
        { value: "br", label: "右下" }
    ];
    alignOptions.forEach(opt => {
        const o = document.createElement("option");
        o.value = opt.value;
        o.textContent = opt.label;
        alignSelect.appendChild(o);
    });
    
    smallBoxRow.appendChild(enableSmallCb);
    smallBoxRow.appendChild(sizeLabel);
    smallBoxRow.appendChild(sizeInput);
    smallBoxPanel.appendChild(smallBoxRow);

    // 🌟 新增：第二行，专门放对齐方式
    const alignRow = document.createElement("div");
    alignRow.style.cssText = "display: flex; align-items: center; gap: 6px; font-size: 12px; margin-top: 4px;";
    
    const alignLabel = document.createElement("span");
    alignLabel.textContent = "实际坐标位于:";
    alignLabel.style.color = "#aaa";
    alignLabel.style.whiteSpace = "nowrap";
    
    alignRow.appendChild(alignLabel);
    alignRow.appendChild(alignSelect);
    
    smallBoxPanel.appendChild(alignRow);
    rightContainer.appendChild(smallBoxPanel);
    
    alignSelect.onchange = () => {
        if (activeIndex === -1) return;
        const item = currentItems[activeIndex];
        const oldAlign = item._align || "center";
        
        // 先拿到旧视觉框的左上角，保证视觉位置不动
        const oldBounds = getVisualBounds(item);
        item._align = alignSelect.value;
        
        // 根据新对齐方式，反推真实坐标
        applyVisualBounds(item, oldBounds.vXmin, oldBounds.vYmin);
        saveEditorChanges();
        drawCanvas();
    };

    enableSmallCb.onchange = () => {
        if (activeIndex === -1) {
            enableSmallCb.checked = false;
            return alert("请先在画布上选中一个框！");
        }
        const item = currentItems[activeIndex];
        const oldBounds = getVisualBounds(item);
        const cx = (oldBounds.vXmin + oldBounds.vXmax) / 2;
        const cy = (oldBounds.vYmin + oldBounds.vYmax) / 2;

        let w;
        let h;

        if (enableSmallCb.checked) {
            // 进入极小框：先记住原来的尺寸，取消勾选时还原
            if (!oldBounds.isExtreme) item._prevBBox = [...item.bbox];
            let size = parseInt(sizeInput.value) || Math.round(GRID_SNAP / 2);
            size = Math.max(1, Math.min(GRID_SNAP - 1, size));
            w = size;
            h = size;
        } else {
            // 取消勾选：回到原来的尺寸；没有记录（比如本来就很小）才退回网格大小
            if (Array.isArray(item._prevBBox) && item._prevBBox.length === 4) {
                w = Math.max(1, item._prevBBox[3] - item._prevBBox[1]);
                h = Math.max(1, item._prevBBox[2] - item._prevBBox[0]);
                delete item._prevBBox;
            } else {
                w = GRID_SNAP;
                h = GRID_SNAP;
            }
            item._align = "center";
        }

        const finalXmin = Math.round(cx - w / 2);
        const finalYmin = Math.round(cy - h / 2);
        item.bbox = [finalYmin, finalXmin, finalYmin + h, finalXmin + w];

        saveEditorChanges();
        renderList(false);
        drawCanvas();
    };

    sizeInput.onchange = () => {
        if (activeIndex === -1 || !enableSmallCb.checked) return;
        const item = currentItems[activeIndex];
        const oldBounds = getVisualBounds(item);
        
        let size = parseInt(sizeInput.value) || Math.round(GRID_SNAP / 2);
        size = Math.max(1, Math.min(GRID_SNAP - 1, size));
        sizeInput.value = size;
        
        const cx = (oldBounds.vXmin + oldBounds.vXmax) / 2;
        const cy = (oldBounds.vYmin + oldBounds.vYmax) / 2;
        const finalXmin = Math.round(cx - size / 2);
        const finalYmin = Math.round(cy - size / 2);
        
        item.bbox = [finalYmin, finalXmin, finalYmin + size, finalXmin + size];
        saveEditorChanges();
        renderList(false);
        drawCanvas();
    };

    // 🌟 背景图控制面板（卡片化包装）
    const bgPanel = document.createElement("div");
    bgPanel.style.cssText = "margin: 8px 10px 0; padding: 10px; border: 1px solid #444; border-radius: 6px; display: flex; flex-direction: column; gap: 8px; background: #1a1a1a;";
    
    // 添加区域标题
    // 标题行：标题 + 操控 + 折叠按钮
    const bgHeader = document.createElement("div");
    bgHeader.style.cssText =
        "display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: bold; color: #aaa;" +
        "border-bottom: 1px solid #333; padding-bottom: 4px; margin-bottom: 2px;";

    const bgTitle = document.createElement("span");
    bgTitle.textContent = "🖼️ 背景图设置";
    bgTitle.style.cssText = "flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;";

    const bgActiveLabel = document.createElement("label");
    bgActiveLabel.style.cssText =
        "display: flex; align-items: center; gap: 3px; color: #ccc; font-size: 12px; font-weight: normal; cursor: pointer; flex-shrink: 0;";
    bgActiveLabel.title = "开启后可在画布上移动 / 拉伸背景图";
    const bgActiveCb = document.createElement("input");
    bgActiveCb.type = "checkbox";
    bgActiveCb.disabled = true;
    bgActiveCb.style.cssText = "accent-color: #4a9eff; margin: 0;";
    bgActiveCb.onchange = () => { bgActive = bgActiveCb.checked; };
    bgActiveLabel.appendChild(bgActiveCb);
    bgActiveLabel.appendChild(document.createTextNode("操控"));

    const bgCollapseBtn = document.createElement("button");
    bgCollapseBtn.type = "button";
    bgCollapseBtn.title = "展开 / 收起背景图设置";
    bgCollapseBtn.style.cssText =
        "display: flex; align-items: center; justify-content: center; flex: 0 0 auto;" +
        "width: 22px; height: 20px; padding: 0; border-radius: 4px; background: #2a2a2a;" +
        "border: 1px solid #444; cursor: pointer;";
    // 用 CSS 三角形，比 ▾ 字符大好控制
    const bgCollapseArrow = document.createElement("span");
    bgCollapseArrow.style.cssText =
        "display: block; width: 0; height: 0; border-left: 5px solid transparent;" +
        "border-right: 5px solid transparent; border-top: 6px solid #bbb;" +
        "transition: transform 0.15s;";
    bgCollapseBtn.appendChild(bgCollapseArrow);
    bgCollapseBtn.onmouseover = () => { bgCollapseBtn.style.background = "#3a3a3a"; };
    bgCollapseBtn.onmouseout = () => { bgCollapseBtn.style.background = "#2a2a2a"; };

    bgHeader.appendChild(bgTitle);
    bgHeader.appendChild(bgActiveLabel);
    bgHeader.appendChild(bgCollapseBtn);
    bgPanel.appendChild(bgHeader);

    // 正文容器（可折叠）
    const bgBody = document.createElement("div");
    bgBody.style.cssText = "display: flex; flex-direction: column; gap: 8px;";
    bgPanel.appendChild(bgBody);

    bgCollapseBtn.onclick = () => {
        const collapsed = bgBody.style.display === "none";
        bgBody.style.display = collapsed ? "flex" : "none";
        // 展开时箭头朝下，收起时朝右
        bgCollapseArrow.style.transform = collapsed ? "rotate(0deg)" : "rotate(-90deg)";
    };

    const bgUploadLabel = document.createElement("label");
    bgUploadLabel.style.cssText = "background: #333; color: #ccc; text-align: center; padding: 6px; border-radius: 4px; cursor: pointer; font-size: 12px; border: 1px solid #555; flex: 1; transition: 0.2s;";
    bgUploadLabel.textContent = "📁 导入";
    bgUploadLabel.onmouseover = () => bgUploadLabel.style.background = "#444";
    bgUploadLabel.onmouseout = () => bgUploadLabel.style.background = "#333";
    
    const bgUploadInput = document.createElement("input");
    bgUploadInput.type = "file";
    bgUploadInput.accept = "image/*";
    bgUploadInput.style.display = "none";
    bgUploadInput.onchange = (e) => {
        const file = e.target.files[0];
        if (file) loadBackgroundFromBlob(file);
        e.target.value = "";
    };
    bgUploadLabel.appendChild(bgUploadInput);

    const bgPasteBtn = document.createElement("button");
    bgPasteBtn.textContent = "📋 粘贴";
    bgPasteBtn.title = "从剪贴板粘贴图片（或在画布聚焦时按 Ctrl+V）";
    bgPasteBtn.style.cssText = "background: #333; color: #ccc; border: 1px solid #555; padding: 6px; border-radius: 4px; cursor: pointer; font-size: 12px; flex: 1; transition: 0.2s;";
    bgPasteBtn.onmouseover = () => bgPasteBtn.style.background = "#444";
    bgPasteBtn.onmouseout = () => bgPasteBtn.style.background = "#333";
    bgPasteBtn.onclick = async () => {
        try {
            if (!navigator.clipboard || !navigator.clipboard.read) {
                alert("当前浏览器不支持读取剪贴板，请在画布聚焦时按 Ctrl+V 粘贴。");
                return;
            }
            const items = await navigator.clipboard.read();
            for (const item of items) {
                const imageType = item.types.find((t) => t.startsWith("image/"));
                if (imageType) {
                    const blob = await item.getType(imageType);
                    if (loadBackgroundFromBlob(blob)) return;
                }
            }
            alert("剪贴板中没有图片。");
        } catch (err) {
            console.warn("[MOSS] 读取剪贴板失败:", err);
            alert("读取剪贴板失败（可能缺少权限），请在画布聚焦时按 Ctrl+V 粘贴。");
        }
    };

    const bgUploadRow = document.createElement("div");
    bgUploadRow.style.cssText = "display: flex; gap: 6px;";
    bgUploadRow.appendChild(bgUploadLabel);
    bgUploadRow.appendChild(bgPasteBtn);
    bgBody.appendChild(bgUploadRow);

    const bgControlRow = document.createElement("div");
    bgControlRow.style.cssText = "display: flex; align-items: center; gap: 6px; font-size: 12px;";
    
    const bgOpacityLabel = document.createElement("span");
    bgOpacityLabel.textContent = "透明度";
    bgOpacityLabel.style.color = "#aaa";
    bgOpacityLabel.style.whiteSpace = "nowrap";
    
    const bgOpacitySlider = document.createElement("input");
    bgOpacitySlider.type = "range";
    bgOpacitySlider.min = "0";
    bgOpacitySlider.max = "1";
    bgOpacitySlider.step = "0.05";
    bgOpacitySlider.value = bgOpacity;
    bgOpacitySlider.style.flex = "1";
    bgOpacitySlider.oninput = (e) => { bgOpacity = parseFloat(e.target.value); drawCanvas(); };
    
    bgControlRow.appendChild(bgOpacityLabel);
    bgControlRow.appendChild(bgOpacitySlider);
    bgBody.appendChild(bgControlRow);

    // 🌟 背景图尺寸（没有背景图时禁用变灰）
    const bgSizeRow = document.createElement("div");
    bgSizeRow.style.cssText = "display: flex; align-items: center; gap: 5px; font-size: 12px;";

    const bgSizeLabel = document.createElement("span");
    bgSizeLabel.textContent = "尺寸";
    bgSizeLabel.style.cssText = "color: #aaa; white-space: nowrap;";

    const mkSizeInput = (ph) => {
        const inp = document.createElement("input");
        inp.type = "number";
        inp.min = "16";
        inp.step = "1";
        inp.disabled = true;
        inp.placeholder = ph;
        inp.style.cssText =
            "width: 58px; background: #111; color: #eee; border: 1px solid #444; border-radius: 4px; " +
            "padding: 2px 4px; text-align: center; outline: none; box-sizing: border-box; transition: opacity 0.12s;";
        return inp;
    };
    const bgWInput = mkSizeInput("宽");
    const bgHInput = mkSizeInput("高");
    const bgSizeX = document.createElement("span");
    bgSizeX.textContent = "×";
    bgSizeX.style.cssText = "color: #666;";

    // 🌟 锁定长宽比
    const bgLockBtn = document.createElement("button");
    bgLockBtn.type = "button";
    bgLockBtn.textContent = bgLockRatio ? "🔒" : "🔓";
    bgLockBtn.title = bgLockRatio ? "已锁定长宽比（点按解锁）" : "未锁定长宽比（点按锁定）";
    bgLockBtn.style.cssText =
        "flex: 0 0 auto; width: 24px; height: 22px; line-height: 1; padding: 0; border-radius: 4px;" +
        `background: #2a2a2a; border: 1px solid ${bgLockRatio ? "#4a9eff" : "#555"};` +
        `color: ${bgLockRatio ? "#8ecbff" : "#ccc"}; font-size: 12px; cursor: pointer;`;
    bgLockBtn.onclick = () => {
        bgLockRatio = !bgLockRatio;
        bgLockBtn.textContent = bgLockRatio ? "🔒" : "🔓";
        bgLockBtn.title = bgLockRatio ? "已锁定长宽比（点按解锁）" : "未锁定长宽比（点按锁定）";
        bgLockBtn.style.borderColor = bgLockRatio ? "#4a9eff" : "#555";
        bgLockBtn.style.color = bgLockRatio ? "#8ecbff" : "#ccc";
    };

    // 🌟 铺满：按原图比例放大到盖住画布并居中
    const bgCoverBtn = document.createElement("button");
    bgCoverBtn.type = "button";
    bgCoverBtn.textContent = "⤢ 铺满";
    bgCoverBtn.title = "按原图比例放大到铺满画布并居中";
    bgCoverBtn.disabled = true;
    bgCoverBtn.style.cssText =
        "background:#333;color:#ccc;border:1px solid #555;padding:2px 6px;border-radius:4px;" +
        "cursor:pointer;font-size:11px;white-space:nowrap;transition:background 0.12s,opacity 0.12s;";
    bgCoverBtn.onmouseover = () => {
        if (!bgCoverBtn.disabled) bgCoverBtn.style.background = "#3f3f3f";
    };
    bgCoverBtn.onmouseout = () => {
        bgCoverBtn.style.background = "#333";
    };
    bgCoverBtn.onclick = () => {
        if (!bgImage) return;
        const { w, h } = getCanvasSize();
        const scale = Math.max(w / bgImage.width, h / bgImage.height);
        bgW = bgImage.width * scale;
        bgH = bgImage.height * scale;
        bgX = 0;
        bgY = 0;
        if (syncBgSizeHook) syncBgSizeHook();
        drawCanvas();
    };

    bgSizeRow.appendChild(bgSizeLabel);
    bgSizeRow.appendChild(bgWInput);
    bgSizeRow.appendChild(bgSizeX);
    bgSizeRow.appendChild(bgHInput);
    bgSizeRow.appendChild(bgLockBtn);
    bgSizeRow.appendChild(bgCoverBtn);
    bgBody.appendChild(bgSizeRow);

    const syncBgSizeInputs = () => {
        const has = !!bgImage;
        [bgWInput, bgHInput].forEach((inp) => {
            inp.disabled = !has;
            inp.style.opacity = has ? "1" : "0.45";
            inp.style.cursor = has ? "text" : "not-allowed";
        });
        bgCoverBtn.disabled = !has;
        bgCoverBtn.style.opacity = has ? "1" : "0.45";
        bgCoverBtn.style.cursor = has ? "pointer" : "not-allowed";
        if (has) {
            // 正在输入时不要覆盖
            if (document.activeElement !== bgWInput) bgWInput.value = String(Math.round(bgW));
            if (document.activeElement !== bgHInput) bgHInput.value = String(Math.round(bgH));
        } else {
            bgWInput.value = "";
            bgHInput.value = "";
        }
    };

    const applyBgSizeFromInputs = (which) => {
        if (!bgImage) return;
        let w = Math.max(16, Math.round(Number(bgWInput.value) || bgW));
        let h = Math.max(16, Math.round(Number(bgHInput.value) || bgH));

        // 锁定长宽比时，改任意一边都按当前比例同步另一边
        if (bgLockRatio && bgW > 0 && bgH > 0) {
            const ratio = bgW / bgH;
            if (which === "h") w = Math.max(16, Math.round(h * ratio));
            else h = Math.max(16, Math.round(w / ratio));
        }

        bgW = w;
        bgH = h;
        bgWInput.value = String(w);
        bgHInput.value = String(h);
        drawCanvas();
    };
    bgWInput.addEventListener("change", () => applyBgSizeFromInputs("w"));
    bgHInput.addEventListener("change", () => applyBgSizeFromInputs("h"));

    syncBgSizeHook = syncBgSizeInputs;
    syncBgSizeInputs();

    const bgActionRow = document.createElement("div");
    bgActionRow.style.cssText = "display: flex; align-items: center; justify-content: space-between; margin-top: 2px;";
    
    const bgSnapLabel = document.createElement("label");
    bgSnapLabel.style.cssText = "display: flex; align-items: center; gap: 4px; color: #ccc; font-size: 12px; cursor: pointer;";
    bgSnapLabel.title = "勾选：拖动时吸附画布的上/下/左/右边缘与中心；取消：自由拖动";
    const bgSnapCb = document.createElement("input");
    bgSnapCb.type = "checkbox";
    bgSnapCb.checked = bgSnap;
    bgSnapCb.style.cssText = "accent-color: #4a9eff; margin: 0;";
    bgSnapCb.onchange = () => { bgSnap = bgSnapCb.checked; };
    bgSnapLabel.appendChild(bgSnapCb);
    bgSnapLabel.appendChild(document.createTextNode("吸附"));

    const bgBtnGroup = document.createElement("div");
    bgBtnGroup.style.cssText = "display: flex; gap: 4px;";

    const bgResetBtn = document.createElement("button");
    bgResetBtn.textContent = "↺ 重置";
    bgResetBtn.title = "恢复为导入时的初始尺寸与位置";
    bgResetBtn.style.cssText = "background: #333; color: #ccc; border: 1px solid #555; padding: 2px 6px; border-radius: 4px; cursor: pointer; font-size: 11px;";
    bgResetBtn.onclick = () => {
        if (!bgImage || !bgInitialState) return;
        bgX = bgInitialState.x;
        bgY = bgInitialState.y;
        bgW = bgInitialState.w;
        bgH = bgInitialState.h;
        if (syncBgSizeHook) syncBgSizeHook();
        drawCanvas();
    };

    const bgCenterBtn = document.createElement("button");
    bgCenterBtn.textContent = "🎯 居中";
    bgCenterBtn.title = "将背景图中心对齐画布中心（不改变尺寸）";
    bgCenterBtn.style.cssText = "background: #333; color: #ccc; border: 1px solid #555; padding: 2px 6px; border-radius: 4px; cursor: pointer; font-size: 11px;";
    bgCenterBtn.onclick = () => {
        if (bgImage) { bgX = 0; bgY = 0; drawCanvas(); }
    };

    const bgDeleteBtn = document.createElement("button");
    bgDeleteBtn.textContent = "✖ 移除";
    bgDeleteBtn.title = "移除背景图";
    // 🌟 这里改了样式：灰色次要按钮，避免和上方大红色的“删除边框”混淆
    bgDeleteBtn.style.cssText =
        "background: #2a2a2a; color: #aaa; border: 1px solid #444; padding: 2px 6px; border-radius: 4px; cursor: pointer; font-size: 11px;";
    bgDeleteBtn.onmouseover = () => { bgDeleteBtn.style.background = "#3a2a2a"; bgDeleteBtn.style.color = "#ffaaaa"; bgDeleteBtn.style.borderColor = "#5a3a3a"; };
    bgDeleteBtn.onmouseout = () => { bgDeleteBtn.style.background = "#2a2a2a"; bgDeleteBtn.style.color = "#aaa"; bgDeleteBtn.style.borderColor = "#444"; };
    bgDeleteBtn.onclick = () => deleteBackgroundImage();

    bgBtnGroup.appendChild(bgResetBtn);
    bgBtnGroup.appendChild(bgCenterBtn);
    bgBtnGroup.appendChild(bgDeleteBtn);

    bgActionRow.appendChild(bgSnapLabel);
    bgActionRow.appendChild(bgBtnGroup);
    bgBody.appendChild(bgActionRow);
    rightContainer.appendChild(bgPanel);

    const listArea = document.createElement("div");
    // min-width: 0 让列表可以被父级压缩，而不是用内容宽度把右栏顶宽
    listArea.style.cssText =
        "display: flex; flex-direction: column; gap: 4px; padding: 10px; overflow-y: auto; overflow-x: hidden; flex: 1; min-width: 0;";
    rightContainer.appendChild(listArea);

    contentContainer.appendChild(rightContainer);
    panel.appendChild(contentContainer);
    document.body.appendChild(panel);

    // ================= 面板位置 / 尺寸持久化 =================
    const PANEL_RECT_KEY = "moss.bbox.panelRect";
    const savePanelRect = () => {
        if (panel.style.display === "none") return;
        const r = panel.getBoundingClientRect();
        try {
            localStorage.setItem(PANEL_RECT_KEY, JSON.stringify({
                left: Math.round(r.left),
                top: Math.round(r.top),
                width: Math.round(r.width),
                height: Math.round(r.height),
            }));
        } catch (_) {
            /* 存储不可用时忽略 */
        }
    };
    const restorePanelRect = () => {
        let saved = null;
        try {
            saved = JSON.parse(localStorage.getItem(PANEL_RECT_KEY) || "null");
        } catch (_) {
            saved = null;
        }
        if (!saved || !Number.isFinite(saved.left) || !Number.isFinite(saved.top)) return;
        const w = Math.min(Math.max(saved.width || 750, 450), Math.max(450, window.innerWidth - 16));
        const h = Math.min(Math.max(saved.height || 600, 300), Math.max(300, window.innerHeight - 16));
        const left = Math.min(Math.max(saved.left, 0), Math.max(0, window.innerWidth - w));
        const top = Math.min(Math.max(saved.top, 0), Math.max(0, window.innerHeight - 40));
        panel.style.transform = "none";
        panel.style.left = `${left}px`;
        panel.style.top = `${top}px`;
        panel.style.width = `${w}px`;
        panel.style.height = `${h}px`;
    };
    restorePanelRect();

    let saveRectTimer = null;
    const queueSavePanelRect = () => {
        if (saveRectTimer) clearTimeout(saveRectTimer);
        saveRectTimer = setTimeout(savePanelRect, 300);
    };
    try {
        // CSS resize 拖拽不会触发事件，用尺寸变化监听兜住
        new ResizeObserver(queueSavePanelRect).observe(panel);
    } catch (_) {
        /* 老浏览器忽略 */
    }

    // --- 拖拽面板逻辑 ---
    let isDraggingPanel = false,
        panelStartX,
        panelStartY,
        panelStartLeft,
        panelStartTop;

    // 🌟 拖拽边界：标题栏必须始终留在视口内，否则一旦拖出去就再也抓不回来
    //   · 上边界：标题栏不能顶出视口顶部
    //   · 下边界：标题栏不能掉出视口底部
    //   · 左右：至少留 KEEP_W 宽，保证还抓得住标题栏
    const clampPanelPosition = (left, top) => {
        const w = panel.offsetWidth || 450;
        const headerH = header.offsetHeight || 36;
        const KEEP_W = Math.min(160, w);

        const minLeft = -(w - KEEP_W);
        const maxLeft = Math.max(minLeft, window.innerWidth - KEEP_W);
        const maxTop = Math.max(0, window.innerHeight - headerH - 4);

        return {
            left: Math.min(Math.max(left, minLeft), maxLeft),
            top: Math.min(Math.max(top, 0), maxTop),
        };
    };

    header.addEventListener("pointerdown", (e) => {
        if (e.target === closeBtn || e.target === helpBtn) return;

        isDraggingPanel = true;
        panelStartX = e.clientX;
        panelStartY = e.clientY;

        // 换算成 left/top 之前先夹一次：窗口变小后重新打开也能自动回到可见区域
        const rect = panel.getBoundingClientRect();
        const pos = clampPanelPosition(rect.left, rect.top);
        panelStartLeft = pos.left;
        panelStartTop = pos.top;
        panel.style.transform = "none";
        panel.style.left = panelStartLeft + "px";
        panel.style.top = panelStartTop + "px";

        // 核心修复：锁定指针，确保鼠标移出面板依然能收到松开事件
        header.setPointerCapture(e.pointerId);
        e.preventDefault();
    });

    header.addEventListener("pointermove", (e) => {
        if (!isDraggingPanel) return;
        const pos = clampPanelPosition(
            panelStartLeft + e.clientX - panelStartX,
            panelStartTop + e.clientY - panelStartY
        );
        panel.style.left = pos.left + "px";
        panel.style.top = pos.top + "px";
    });

    header.addEventListener("pointerup", (e) => {
        isDraggingPanel = false;
        header.releasePointerCapture(e.pointerId);
        savePanelRect();
    });

    // 窗口尺寸变化后，把已经拖出去的面板拉回可见区域
    window.addEventListener("resize", () => {
        if (panel.style.display === "none") return;
        if (panel.style.transform !== "none") return; // 还没被拖动过，仍是居中布局
        const rect = panel.getBoundingClientRect();
        const pos = clampPanelPosition(rect.left, rect.top);
        panel.style.left = pos.left + "px";
        panel.style.top = pos.top + "px";
    });

    // --- 核心状态与变量 ---
    let isUpdatingFromUI = false;
    let currentItems = [];
    let activeIndex = -1;
    let selectedIndices = new Set();

    let dragMode = null;
    let dragStartMouse = { x: 0, y: 0 };
    let dragStartBBox = [0, 0, 0, 0];
    let labelCache = [];

    // 视口状态
    let viewScale = 1.0;
    let viewX = 0;
    let viewY = 0;
    let isPanning = false;
    let panStartX = 0,
        panStartY = 0,
        panStartViewX = 0,
        panStartViewY = 0;

    const HANDLE_SIZE = 8;
    let GRID_SNAP = 16;

    const getCanvasSize = () => {
        const w = node.widgets.find((w) => w.name === "canvas_width")?.value || 1024;
        const h = node.widgets.find((w) => w.name === "canvas_height")?.value || 1024;
        return { w, h };
    };

    const getBaseScale = () => {
        const { w, h } = getCanvasSize();
        const rect = canvasContainer.getBoundingClientRect();
        const padding = 40;
        const displayW = Math.max(1, rect.width - padding);
        const displayH = Math.max(1, rect.height - padding);
        return Math.min(displayW / w, displayH / h);
    };

    const getActualScale = () => getBaseScale() * viewScale;

    const physToLogic = (px, py) => {
        const scale = getActualScale();
        const rect = canvasContainer.getBoundingClientRect();
        const centerX = rect.width / 2;
        const centerY = rect.height / 2;
        return {
            x: (px - centerX - viewX) / scale,
            y: (py - centerY - viewY) / scale,
        };
    };

    const logicToPhys = (lx, ly) => {
        const scale = getActualScale();
        const rect = canvasContainer.getBoundingClientRect();
        const centerX = rect.width / 2;
        const centerY = rect.height / 2;
        return { x: centerX + viewX + lx * scale, y: centerY + viewY + ly * scale };
    };

    const applySnap = (val, isAltPressed, isX) => {
        if (snapCb.checked !== isAltPressed) {
            const { w, h } = getCanvasSize();
            const offset = isX ? w / 2 : h / 2;
            // 核心逻辑：以左上角为基准画网格线
            return Math.round((val + offset) / GRID_SNAP) * GRID_SNAP - offset;
        }
        return Math.round(val);
    };

    const isOverlapping = (r1, r2) => {
        return !(
            r1.x + r1.w < r2.x ||
            r1.x > r2.x + r2.w ||
            r1.y + r1.h < r2.y ||
            r1.y > r2.y + r2.h
        );
    };

    // ================= 撤销 / 重做 =================
    const undoStack = [];
    let undoIndex = -1;
    let lastRecordAt = 0;
    const UNDO_LIMIT = 100;

    // snapshot 是写回后的完整 JSON；700ms 内的连续改动合并成一步（打字/连续微移）
    const recordHistory = (snapshot, coalesce = true) => {
        if (typeof snapshot !== "string") return;
        if (undoIndex >= 0 && undoStack[undoIndex] === snapshot) return;
        if (undoIndex < undoStack.length - 1) undoStack.length = undoIndex + 1;

        const now = Date.now();
        if (coalesce && undoIndex >= 0 && now - lastRecordAt < 700) {
            undoStack[undoIndex] = snapshot;
        } else {
            undoStack.push(snapshot);
            if (undoStack.length > UNDO_LIMIT) undoStack.shift();
            undoIndex = undoStack.length - 1;
        }
        lastRecordAt = now;
        updateUndoButtons();
    };

    const applyHistory = (index) => {
        if (index < 0 || index >= undoStack.length) return;
        undoIndex = index;
        const value = undoStack[index];
        isUpdatingFromUI = true;
        jsonWidget.value = value;
        jsonWidget.callback?.(value);
        isUpdatingFromUI = false;

        // 保留选中态：撤销不应该把下方属性面板一起关掉
        renderList(false);
        const maxIdx = currentItems.length - 1;
        if (activeIndex > maxIdx) activeIndex = -1;
        selectedIndices.forEach((i) => {
            if (i > maxIdx) selectedIndices.delete(i);
        });
        updateListSelection();
        syncEditorPanel();
        drawCanvas();
        if (node.graph) node.graph.setDirtyCanvas(true, true);
        lastRecordAt = 0; // 撤销/重做之后的下一次改动必须新开一步，不能合并掉当前状态
        updateUndoButtons();
    };
    const undoEdit = () => applyHistory(undoIndex - 1);
    const redoEdit = () => applyHistory(undoIndex + 1);

    // 按钮可用状态：栈底/栈顶时置灰
    const updateUndoButtons = () => {
        const canUndo = undoIndex > 0;
        const canRedo = undoIndex >= 0 && undoIndex < undoStack.length - 1;
        [[undoBtn, canUndo], [redoBtn, canRedo]].forEach(([btn, enabled]) => {
            if (!btn) return;
            btn.disabled = !enabled;
            btn.style.opacity = enabled ? "1" : "0.38";
            btn.style.cursor = enabled ? "pointer" : "default";
        });
    };

    // 编辑器内部状态（极小框对齐 / 锁定）不进 JSON，靠 bbox + 序号跨重绘继承
    const carryEditorState = (prev, next) => {
        if (!Array.isArray(prev) || !prev.length || !Array.isArray(next)) return;
        const byBbox = new Map();
        prev.forEach((it) => {
            if (it && Array.isArray(it.bbox)) byBbox.set(it.bbox.join(","), it);
        });
        next.forEach((it, i) => {
            if (!it) return;
            const src = (Array.isArray(it.bbox) && byBbox.get(it.bbox.join(","))) || prev[i];
            if (!src) return;
            if (src._align && !it._align) it._align = src._align;
            if (src._locked) it._locked = true;
            // 极小框的“原尺寸”也要跨重绘保留，否则取消勾选时还原不回去
            if (Array.isArray(src._prevBBox) && !it._prevBBox) it._prevBBox = [...src._prevBBox];
        });
    };

    // ================= 键盘微移 =================
    const nudgeSelected = (dx, dy) => {
        if (activeIndex === -1 && selectedIndices.size) {
            activeIndex = selectedIndices.values().next().value;
        }
        const indices = selectedIndices.size
            ? Array.from(selectedIndices)
            : activeIndex >= 0 ? [activeIndex] : [];
        if (!indices.length) return false;

        const { w, h } = getCanvasSize();
        const limitX = w / 2;
        const limitY = h / 2;
        let moved = false;

        indices.forEach((i) => {
            const item = currentItems[i];
            if (!item || !Array.isArray(item.bbox)) return;
            const [ymin, xmin, ymax, xmax] = item.bbox;
            const bw = xmax - xmin;
            const bh = ymax - ymin;
            const nx = Math.max(-limitX, Math.min(xmin + dx, limitX - bw));
            const ny = Math.max(-limitY, Math.min(ymin + dy, limitY - bh));
            if (nx === xmin && ny === ymin) return;
            item.bbox = [Math.round(ny), Math.round(nx), Math.round(ny + bh), Math.round(nx + bw)];
            moved = true;
        });

        if (moved) saveEditorChanges();
        return moved;
    };

    // ================= 键盘：方向键微移 =================
    // ⚠️ Ctrl+Z 不再拦截：ComfyUI 的全局撤销会在更早阶段执行并把整图重建，
    // 拦不住反而容易双触发。撤销/重做改由画布右下角的按钮触发。
    const panelKeyHandler = (e) => {
        if (!panel.contains(e.target)) return; // 只在面板内部生效

        const t = e.target;
        if (!t) return;
        // 文本类输入框内交给原生行为；checkbox / 按钮 不算
        const isTextEditable =
            t.tagName === "TEXTAREA" ||
            t.isContentEditable ||
            (t.tagName === "INPUT" && !["checkbox", "radio", "button", "range", "color"].includes((t.type || "text").toLowerCase()));
        if (isTextEditable || t.tagName === "SELECT") return;
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (activeIndex === -1 && selectedIndices.size === 0) return;

        const step = e.shiftKey ? GRID_SNAP : 1;
        let dx = 0;
        let dy = 0;
        if (e.key === "ArrowLeft") dx = -step;
        else if (e.key === "ArrowRight") dx = step;
        else if (e.key === "ArrowUp") dy = -step;
        else if (e.key === "ArrowDown") dy = step;
        else return;
        e.preventDefault();
        e.stopPropagation();
        nudgeSelected(dx, dy);
    };
    window.addEventListener("keydown", panelKeyHandler, true);
    node._mossKeyHandler = panelKeyHandler; // 节点删除时在 onRemoved 里摘掉

    // --- 编辑面板逻辑 ---
    // 写回 JSON 时统一走模块级的 serializeLayout()，字段规则只保留一处
    const saveEditorChanges = () => {
        if (activeIndex === -1 || !currentItems[activeIndex]) return;

        currentItems.forEach(item => { if ("_isNew" in item) delete item._isNew; });

        let parsed = {};
        try {
            parsed = JSON.parse(jsonWidget.value);
        } catch (_) {
            parsed = {};
        }
        const data = Array.isArray(parsed)
            ? currentItems
            : parsed && typeof parsed === "object"
                ? { ...parsed, items: currentItems }
                : { items: currentItems };

        isUpdatingFromUI = true;
        jsonWidget.value = serializeLayout(data);
        if (jsonWidget.callback) jsonWidget.callback(jsonWidget.value);
        isUpdatingFromUI = false;
        recordHistory(jsonWidget.value);

        // 实时更新右侧列表的文本显示（不整体重建列表，防止失去焦点）
        // ⚠️ 必须按类名找：行首现在是拖动柄 span，querySelector("span") 会抓错元素
        const cbs = listArea.querySelectorAll("input[type='checkbox']");
        const row = cbs[activeIndex]?.parentElement;
        if (row) {
            const span = row.querySelector(".moss-row-label");
            const item = currentItems[activeIndex];
            const text =
                item.caption || item.desc || `未命名 (${item.label || "object"})`;
            if (span)
                span.textContent = `${activeIndex + 1}. ${text.length > 15 ? text.substring(0, 15) + "..." : text}`;
        }

        drawCanvas();
        if (node.graph) node.graph.setDirtyCanvas(true, true);
    };

    const syncEditorPanel = () => {
        if (activeIndex === -1 || !currentItems[activeIndex]) {
            editorContainer.style.display = "none";
            closeColorPopup(false);
            // 属性面板收起时，右下角工具条回到画布底部
            updateCanvasToolbarOffset();
            return;
        }
        editorContainer.style.display = "flex";
        const item = currentItems[activeIndex];
        // 🌟 换了框就清掉上一个框残留的色块选中态（取色浮层也要跟着收起）
        if (selectedPaletteOwner !== activeIndex) {
            selectedPaletteIndex = -1;
            selectedPaletteOwner = activeIndex;
            closeColorPopup(false);
        }
        const isText = item.label === "text";

        // 🌟 同步极小框 UI
        const { isExtreme } = getVisualBounds(item);
        enableSmallCb.checked = isExtreme;
        sizeInput.disabled = !isExtreme;
        alignSelect.disabled = !isExtreme;
        // 上限跟着网格走：16px 网格 → 最大 15，32px 网格 → 最大 31
        sizeInput.max = String(Math.max(1, GRID_SNAP - 1));
        if (isExtreme) {
            sizeInput.value = item.bbox[3] - item.bbox[1];
            alignSelect.value = item._align || "center";
        }

        // 更新类型 Tab 状态（object / character / text）
        updateTypeTabs(item.label || "object");

        // 显示/隐藏文字框
        textLabel.style.display = isText ? "block" : "none";
        textArea.style.display = isText ? "block" : "none";

        // 更新值（防止正在输入时被覆盖）
        if (document.activeElement !== descArea) {
            descArea.value = item.caption || item.desc || "";
        }
        if (isText && document.activeElement !== textArea) {
            textArea.value = item.text || "";
        }

        // 调色板整行重建（色块在前、「+」在后）
        renderPalette();

        // 标签区整体重建（选中态 / 编辑态都在 renderTags 里处理）
        renderTags();

        // 属性面板展开时会盖住画布底部，把右下角工具条顶上去（悬浮态则不需要）
        updateCanvasToolbarOffset();
    };

    const setItemLabel = (label) => {
        if (activeIndex === -1) return;
        const item = currentItems[activeIndex];
        if (!item) return;
        item.label = label;
        if (label === "text") {
            if (typeof item.text !== "string") item.text = "";
        } else {
            // 只有 text 类型才有 text 字段，切回对象/角色要删掉
            delete item.text;
        }
        syncEditorPanel();
        saveEditorChanges();
    };

    objBtn.onclick = () => setItemLabel("object");
    charBtn.onclick = () => setItemLabel("character");
    textBtn.onclick = () => setItemLabel("text");

    descArea.addEventListener("input", () => {
        if (activeIndex === -1) return;
        currentItems[activeIndex].caption = descArea.value;
        saveEditorChanges();
    });

    textArea.addEventListener("input", () => {
        if (activeIndex === -1) return;
        currentItems[activeIndex].text = textArea.value;
        saveEditorChanges();
    });

    // 🌟 获取视觉上的代理范围（边长 = 当前网格尺寸：16 或 32）
    const getVisualBounds = (item) => {
        const [ymin, xmin, ymax, xmax] = item.bbox;
        const realW = xmax - xmin;
        const realH = ymax - ymin;
        // 极小框的视觉代理边长跟随网格尺寸（16 → 16，32 → 32）
        const T = GRID_SNAP;
        if (realW >= T && realH >= T) {
            return { vXmin: xmin, vYmin: ymin, vXmax: xmax, vYmax: ymax, isExtreme: false };
        }

        // 极小框
        const half = T / 2;
        const align = item._align || "center";
        let vXmin = xmin, vYmin = ymin, vXmax = xmin + T, vYmax = ymin + T;

        if (align === "center") {
            const cx = (xmin + xmax) / 2;
            const cy = (ymin + ymax) / 2;
            vXmin = cx - half; vXmax = cx + half;
            vYmin = cy - half; vYmax = cy + half;
        } else if (align === "tl") {
            vXmin = xmin; vYmin = ymin; vXmax = xmin + T; vYmax = ymin + T;
        } else if (align === "tr") {
            vXmin = xmax - T; vYmin = ymin; vXmax = xmax; vYmax = ymin + T;
        } else if (align === "bl") {
            vXmin = xmin; vYmin = ymax - T; vXmax = xmin + T; vYmax = ymax;
        } else if (align === "br") {
            vXmin = xmax - T; vYmin = ymax - T; vXmax = xmax; vYmax = ymax;
        }

        return { vXmin, vYmin, vXmax, vYmax, isExtreme: true };
    };

    // 🌟 将视觉范围反向映射回真实数据
    const applyVisualBounds = (item, vXmin, vYmin) => {
        const [ymin, xmin, ymax, xmax] = item.bbox;
        const realW = xmax - xmin;
        const realH = ymax - ymin;
        const T = GRID_SNAP;
        if (realW >= T && realH >= T) return; // 只有极小框需要反向映射

        const align = item._align || "center";
        let newXmin = xmin, newYmin = ymin, newXmax = xmax, newYmax = ymax;

        if (align === "center") {
            const cx = vXmin + T / 2;
            const cy = vYmin + T / 2;
            newXmin = cx - realW / 2; newXmax = cx + realW / 2;
            newYmin = cy - realH / 2; newYmax = cy + realH / 2;
        } else if (align === "tl") {
            newXmin = vXmin; newYmin = vYmin; newXmax = vXmin + realW; newYmax = vYmin + realH;
        } else if (align === "tr") {
            newXmin = vXmin + T - realW; newYmin = vYmin; newXmax = vXmin + T; newYmax = vYmin + realH;
        } else if (align === "bl") {
            newXmin = vXmin; newYmin = vYmin + T - realH; newXmax = vXmin + realW; newYmax = vYmin + T;
        } else if (align === "br") {
            newXmin = vXmin + T - realW; newYmin = vYmin + T - realH; newXmax = vXmin + T; newYmax = vYmin + T;
        }

        item.bbox = [Math.round(newYmin), Math.round(newXmin), Math.round(newYmax), Math.round(newXmax)];
    };

    // --- 绘制画布 ---
    const drawCanvas = () => {
        const rect = canvasContainer.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return; // 面板隐藏时跳过

        const ctx = canvas.getContext("2d");
        const { w, h } = getCanvasSize();
        const actualScale = getActualScale();

        if (canvas.width !== rect.width || canvas.height !== rect.height) {
            canvas.width = rect.width;
            canvas.height = rect.height;
        }

        ctx.fillStyle = "#111";
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        const p1 = logicToPhys(-w / 2, -h / 2);
        const p2 = logicToPhys(w / 2, h / 2);
        const canvasW_phys = p2.x - p1.x;
        const canvasH_phys = p2.y - p1.y;

        ctx.fillStyle = "#1a1a1a";
        ctx.fillRect(p1.x, p1.y, canvasW_phys, canvasH_phys);

        // 🌟 渲染背景图（不裁剪到逻辑画布内：否则超出部分和四角控制点会被剪掉，没法拉伸）
        if (bgImage) {
            ctx.save();
            ctx.globalAlpha = bgOpacity;
            const bp1 = logicToPhys(bgX - bgW / 2, bgY - bgH / 2);
            const bp2 = logicToPhys(bgX + bgW / 2, bgY + bgH / 2);
            ctx.drawImage(bgImage, bp1.x, bp1.y, bp2.x - bp1.x, bp2.y - bp1.y);

            // 如果开启背景图操控模式，画一个虚线框提示
            if (bgActive) {
                ctx.globalAlpha = 1;
                ctx.strokeStyle = "#ff9800";
                ctx.lineWidth = 2;
                ctx.setLineDash([5, 5]);
                ctx.strokeRect(bp1.x, bp1.y, bp2.x - bp1.x, bp2.y - bp1.y);
                ctx.setLineDash([]);

                // 画四角控制点
                ctx.fillStyle = "#ff9800";
                const hs = HANDLE_SIZE;
                [[bp1.x, bp1.y], [bp2.x, bp1.y], [bp1.x, bp2.y], [bp2.x, bp2.y]].forEach(([hx, hy]) => {
                    ctx.fillRect(hx - hs / 2, hy - hs / 2, hs, hs);
                });
            }
            ctx.restore();
        }
        ctx.strokeStyle = "#333";
        ctx.lineWidth = 1;
        ctx.strokeRect(p1.x + 0.5, p1.y + 0.5, canvasW_phys - 1, canvasH_phys - 1);

        const gridSize = GRID_SNAP * actualScale;
        if (gridSize > 4) {
            ctx.strokeStyle = snapCb.checked
                ? "rgba(255,255,255,0.08)"
                : "rgba(255,255,255,0.02)";
            ctx.lineWidth = 1;
            ctx.beginPath();
            for (let lx = -w / 2; lx <= w / 2; lx += GRID_SNAP) {
                const px = logicToPhys(lx, 0).x;
                ctx.moveTo(px, p1.y);
                ctx.lineTo(px, p2.y);
            }
            for (let ly = -h / 2; ly <= h / 2; ly += GRID_SNAP) {
                const py = logicToPhys(0, ly).y;
                ctx.moveTo(p1.x, py);
                ctx.lineTo(p2.x, py);
            }
            ctx.stroke();
        }

        labelCache = [];

        currentItems.forEach((item, index) => {
            const bbox = item.bbox;
            if (!bbox || bbox.length !== 4) return;

            const [ymin, xmin, ymax, xmax] = bbox;

            let realW = xmax - xmin;
            let realH = ymax - ymin;
            
            // 原来的一大段 isExtreme 计算换成：
            const { vXmin, vYmin, vXmax, vYmax, isExtreme } = getVisualBounds(item);

            const bp1 = logicToPhys(vXmin, vYmin);
            const bp2 = logicToPhys(vXmax, vYmax);
            const rectW = bp2.x - bp1.x;
            const rectH = bp2.y - bp1.y;

            const isSelected = selectedIndices.has(index);
            const isActive = index === activeIndex;
            // 边框颜色只和选中状态有关，不再被调色板覆盖
            const itemColor = isActive ? "#4a9eff" : "#ccc";

            // 画框
            if (isActive) {
                ctx.fillStyle = "rgba(74, 158, 255, 0.4)";
                ctx.strokeStyle = itemColor;
                ctx.lineWidth = 2;
            } else if (isSelected) {
                ctx.fillStyle = "rgba(74, 158, 255, 0.15)";
                ctx.strokeStyle = itemColor;
                ctx.lineWidth = 1;
            } else {
                ctx.fillStyle = "rgba(255, 255, 255, 0.05)";
                ctx.strokeStyle = itemColor;
                ctx.lineWidth = 1;
            }
            ctx.fillRect(bp1.x, bp1.y, rectW, rectH);
            ctx.strokeRect(bp1.x, bp1.y, rectW, rectH);

            if (isExtreme) {
                ctx.strokeStyle = "#ff4a4a"; // 红色边框
                ctx.setLineDash([4, 4]);
                ctx.strokeRect(bp1.x, bp1.y, rectW, rectH);
                ctx.setLineDash([]); // 画完虚线后必须恢复实线，否则后续全变虚线
            }
            if (item._locked) {
                ctx.fillStyle = "#ff4a4a";
                ctx.font = "12px sans-serif";
                ctx.textBaseline = "top"; // 保证文字从上往下对齐
                ctx.fillText("🔒", bp2.x - 14, bp1.y + 4); // 稍微调整了位置，防止超出框外
            }

            if (isActive) {
                ctx.fillStyle = "#fff";
                const hs = HANDLE_SIZE / 2;
                [
                    [bp1.x, bp1.y],
                    [bp2.x, bp1.y],
                    [bp1.x, bp2.y],
                    [bp2.x, bp2.y],
                ].forEach(([hx, hy]) => {
                    ctx.fillRect(hx - hs, hy - hs, HANDLE_SIZE, HANDLE_SIZE);
                });
            }

            // 绘制数字标签
            const labelText = (index + 1).toString();
            const displayScale = Math.max(1, actualScale);
            const labelFontSize = Math.max(10, Math.round(12 * displayScale));
            ctx.font = `bold ${labelFontSize}px sans-serif`;
            const textW = ctx.measureText(labelText).width;
            const labelW = textW + 8;
            const labelH = labelFontSize + 6;

            const candidates = [
                { x: bp1.x, y: bp1.y },
                { x: bp2.x - labelW, y: bp1.y },
                { x: bp1.x, y: bp2.y - labelH },
                { x: bp2.x - labelW, y: bp2.y - labelH },
            ];

            let finalPos = candidates[0];
            for (let pos of candidates) {
                const testRect = { x: pos.x, y: pos.y, w: labelW, h: labelH };
                const overlaps = labelCache.some((cachedRect) =>
                    isOverlapping(testRect, cachedRect),
                );
                if (!overlaps) {
                    finalPos = pos;
                    break;
                }
            }
            labelCache.push({
                x: finalPos.x,
                y: finalPos.y,
                w: labelW,
                h: labelH,
                index,
            });

            ctx.fillStyle = itemColor;
            ctx.fillRect(finalPos.x, finalPos.y, labelW, labelH);
            ctx.fillStyle = "#fff";
            ctx.textBaseline = "middle";
            ctx.fillText(labelText, finalPos.x + 4, finalPos.y + labelH / 2);
            // 🌟 新增：绘制顶部多色横条
            if (item.palette && item.palette.length > 0) {
                let barStartX = bp1.x;
                let barWidth = rectW;

                // 如果数字标签在左上角，颜色条从标签右边开始画
                if (finalPos.x === bp1.x && finalPos.y === bp1.y) {
                    barStartX = bp1.x + labelW;
                    barWidth = rectW - labelW;
                }
                // 如果数字标签在右上角，颜色条从左边画到标签左边
                else if (finalPos.x === bp2.x - labelW && finalPos.y === bp1.y) {
                    barWidth = rectW - labelW;
                }

                // 如果还有剩余宽度，绘制多色块
                if (barWidth > 0) {
                    const colorW = barWidth / item.palette.length;
                    item.palette.forEach((color, i) => {
                        // 防止颜色为空，给个默认灰色
                        ctx.fillStyle = color || "#8c8c8c";
                        ctx.fillRect(barStartX + i * colorW, bp1.y, colorW, labelH);
                    });
                }
            }

            // 🌟 绘制框内描述 (完美复刻原版的 text 逻辑)
            let displayText = "";
            if (item.label === "text") {
                const textContent = item.text ? `"${item.text}"` : "";
                const descContent = item.caption || item.desc || "";
                if (textContent && descContent) {
                    displayText = `${textContent} — ${descContent}`;
                } else {
                    displayText = textContent || descContent;
                }
            } else {
                displayText = item.caption || item.desc || "";
            }

            if (displayText && rectH > labelH + 4) {
                const descFontSize = Math.max(9, Math.round(11 * displayScale));
                ctx.font = `${descFontSize}px sans-serif`;
                ctx.textBaseline = "top";

                const maxDescW = Math.max(10, rectW - 8);
                let displayDesc = displayText;
                let currentW = ctx.measureText(displayDesc).width;
                if (currentW > maxDescW) {
                    while (displayDesc.length > 1 && currentW > maxDescW) {
                        displayDesc = displayDesc.slice(0, -1);
                        currentW = ctx.measureText(displayDesc + "...").width;
                    }
                    displayDesc += "...";
                }

                let drawX = bp1.x + 4;
                let drawY = bp1.y + 4;
                if (finalPos.x === bp1.x && finalPos.y === bp1.y) {
                    drawY = finalPos.y + labelH + 2;
                }

                ctx.fillStyle = "rgba(0,0,0,0.6)";
                ctx.fillText(displayDesc, drawX + 1, drawY + 1);
                ctx.fillStyle = isActive ? "#fff" : "#ccc";
                ctx.fillText(displayDesc, drawX, drawY);
            }
        });
    };

    const resizeObserver = new ResizeObserver(() => drawCanvas());
    resizeObserver.observe(canvasContainer);

    // 🌟 画布聚焦时 Ctrl+V 粘贴图片为背景图
    canvas.addEventListener("paste", (e) => {
        if (document.activeElement !== canvas) return;
        const items = e.clipboardData?.items;
        if (!items) return;
        for (const item of items) {
            if (item.type && item.type.startsWith("image/")) {
                const blob = item.getAsFile();
                if (blob && loadBackgroundFromBlob(blob)) {
                    e.preventDefault();
                    e.stopPropagation(); // 防止 ComfyUI 全局粘贴节点/图片
                    return;
                }
            }
        }
    });
    // --- 鼠标交互 ---
    canvas.addEventListener(
        "wheel",
        (e) => {
            e.preventDefault();

            const rect = canvasContainer.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            const mouseY = e.clientY - rect.top;
            const centerX = rect.width / 2;
            const centerY = rect.height / 2;

            const oldScale = getActualScale();
            const lx = (mouseX - centerX - viewX) / oldScale;
            const ly = (mouseY - centerY - viewY) / oldScale;

            const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
            viewScale *= zoomFactor;
            viewScale = Math.max(0.1, Math.min(10, viewScale));

            const newScale = getActualScale();
            viewX = mouseX - centerX - lx * newScale;
            viewY = mouseY - centerY - ly * newScale;

            drawCanvas();
        },
        { passive: false },
    );

    // 背景图命中检测（操控模式）：返回 "tl"/"tr"/"bl"/"br"/"t"/"b"/"l"/"r"/"move"/null
    const getBgHitMode = (mouseX, mouseY) => {
        if (!bgActive || !bgImage) return null;
        const bp1 = logicToPhys(bgX - bgW / 2, bgY - bgH / 2);
        const bp2 = logicToPhys(bgX + bgW / 2, bgY + bgH / 2);
        // 拉伸点可能在画布外的黑色区域，容差放宽一点
        const handleDist = 18;

        const nearTL = Math.abs(mouseX - bp1.x) < handleDist && Math.abs(mouseY - bp1.y) < handleDist;
        const nearTR = Math.abs(mouseX - bp2.x) < handleDist && Math.abs(mouseY - bp1.y) < handleDist;
        const nearBL = Math.abs(mouseX - bp1.x) < handleDist && Math.abs(mouseY - bp2.y) < handleDist;
        const nearBR = Math.abs(mouseX - bp2.x) < handleDist && Math.abs(mouseY - bp2.y) < handleDist;

        const nearT = !nearTL && !nearTR && mouseY > bp1.y - handleDist && mouseY < bp1.y + handleDist && mouseX > bp1.x && mouseX < bp2.x;
        const nearB = !nearBL && !nearBR && mouseY > bp2.y - handleDist && mouseY < bp2.y + handleDist && mouseX > bp1.x && mouseX < bp2.x;
        const nearL = !nearTL && !nearBL && mouseX > bp1.x - handleDist && mouseX < bp1.x + handleDist && mouseY > bp1.y && mouseY < bp2.y;
        const nearR = !nearTR && !nearBR && mouseX > bp2.x - handleDist && mouseX < bp2.x + handleDist && mouseY > bp1.y && mouseY < bp2.y;

        if (nearTL) return "tl";
        if (nearTR) return "tr";
        if (nearBL) return "bl";
        if (nearBR) return "br";
        if (nearT) return "t";
        if (nearB) return "b";
        if (nearL) return "l";
        if (nearR) return "r";
        if (mouseX > bp1.x && mouseX < bp2.x && mouseY > bp1.y && mouseY < bp2.y) return "move";
        return null;
    };

    canvas.addEventListener("mousedown", (e) => {
        canvas.focus();
        const rect = canvasContainer.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        if (e.button === 1) {
            isPanning = true;
            panStartX = mouseX;
            panStartY = mouseY;
            panStartViewX = viewX;
            panStartViewY = viewY;
            canvas.style.cursor = "grabbing";
            e.preventDefault();
            return;
        }

        if (e.button !== 0) return;

        // 🌟 背景图操控拦截
        if (bgActive && bgImage) {
            const hitMode = getBgHitMode(mouseX, mouseY);
            if (hitMode) {
                bgDragMode = hitMode;
                bgStartMouse = { x: mouseX, y: mouseY };
                bgStartBBox = { x: bgX, y: bgY, w: bgW, h: bgH };
                e.preventDefault();
                return; // 阻断后续的 bbox 逻辑
            }

            // 操控模式下点在空白处：既不新建框，也不平移画布。
            // 否则画布黑色区域里的背景图拉伸点会被“平移画布”的逻辑抢走。
            e.preventDefault();
            return;
        }

        // 🌟 画布外的黑色区域：左键拖动改为平移画布，不创建新框
        {
            const { w: cw, h: ch } = getCanvasSize();
            const tl = logicToPhys(-cw / 2, -ch / 2);
            const br = logicToPhys(cw / 2, ch / 2);
            const insideCanvas =
                mouseX >= tl.x && mouseX <= br.x && mouseY >= tl.y && mouseY <= br.y;

            if (!insideCanvas) {
                // 只有当这里本来会“新建框”时才改成平移，避免抢走框/标签的拖拽
                const preHit = getHitInfo(mouseX, mouseY);
                if (preHit.type === "create") {
                    isPanning = true;
                    panStartX = mouseX;
                    panStartY = mouseY;
                    panStartViewX = viewX;
                    panStartViewY = viewY;
                    canvas.style.cursor = "grabbing";
                    e.preventDefault();
                    return;
                }
            }
        }

        const hit = getHitInfo(mouseX, mouseY);
        const isCtrl = e.ctrlKey || e.metaKey;

        if (hit.type === "select-label") {
            const targetIdx = hit.index;
            const item = currentItems[targetIdx];

            // 1. 处理选中逻辑
            if (isCtrl) {
                if (selectedIndices.has(targetIdx)) selectedIndices.delete(targetIdx);
                else selectedIndices.add(targetIdx);
                activeIndex = targetIdx;
            } else {
                if (!selectedIndices.has(targetIdx)) {
                    selectedIndices.clear();
                    selectedIndices.add(targetIdx);
                }
                activeIndex = targetIdx;
            }

            updateListSelection();
            syncEditorPanel(); // 点标签也弹出下方面板
            drawCanvas();

            // 2. 🌟 核心优化：如果不是锁定的，允许按住标签直接拖动！
            if (!item._locked) {
                dragMode = "move";
                dragStartMouse = { x: mouseX, y: mouseY };
                dragStartBBox = [...item.bbox];
            }
            
            e.preventDefault();
            return;
        }

        if (hit.type === "create") {
            if (!isCtrl) selectedIndices.clear();

            const { w, h } = getCanvasSize(); // 🌟 补上缺失的宽高获取
            const limitX = w / 2;
            const limitY = h / 2;

            const logicPos = physToLogic(mouseX, mouseY);
            let snapX = applySnap(logicPos.x, e.altKey, true);
            let snapY = applySnap(logicPos.y, e.altKey, false);

            snapX = Math.max(-limitX, Math.min(snapX, limitX));
            snapY = Math.max(-limitY, Math.min(snapY, limitY));

            currentItems.push({
                label: "object",
                caption: "新对象",
                bbox: [snapY, snapX, snapY, snapX],
            });
            activeIndex = currentItems.length - 1;
            selectedIndices.add(activeIndex);

            dragMode = "resize-br";
            dragStartMouse = { x: mouseX, y: mouseY };
            dragStartBBox = [...currentItems[activeIndex].bbox];

            editorContainer.style.display = "none";
        } else {
            const targetIdx = hit.index;
            if (isCtrl) {
                if (selectedIndices.has(targetIdx)) selectedIndices.delete(targetIdx);
                else selectedIndices.add(targetIdx);
                activeIndex = targetIdx;
            } else {
                if (!selectedIndices.has(targetIdx)) {
                    selectedIndices.clear();
                    selectedIndices.add(targetIdx);
                }
                activeIndex = targetIdx;
            }

            dragMode = hit.type;
            dragStartMouse = { x: mouseX, y: mouseY };
            dragStartBBox = [...currentItems[targetIdx].bbox];
        }

        updateListSelection();
        if (hit.type !== "create") {
            syncEditorPanel();
        }
        drawCanvas();
        e.preventDefault();
    });

    window.addEventListener("mousemove", (e) => {
        const rect = canvasContainer.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        if (isPanning) {
            viewX = panStartViewX + (mouseX - panStartX);
            viewY = panStartViewY + (mouseY - panStartY);
            drawCanvas();
            return;
        }

        // 🌟 背景图拖拽计算
        if (bgDragMode && bgImage) {
            const dx = (mouseX - bgStartMouse.x) / getActualScale();
            const dy = (mouseY - bgStartMouse.y) / getActualScale();

            let nx = bgStartBBox.x, ny = bgStartBBox.y, nw = bgStartBBox.w, nh = bgStartBBox.h;

            if (bgDragMode === "move") {
                nx += dx;
                ny += dy;

                // 🌟 吸附到画布：左/中/右、上/中/下（仅在勾选“吸附”时生效）
                if (bgSnap) {
                    const snapThreshold = 8 / getActualScale();
                    const { w: canvasW, h: canvasH } = getCanvasSize();
                    const xTargets = [-canvasW / 2, 0, canvasW / 2];
                    const yTargets = [-canvasH / 2, 0, canvasH / 2];

                    // 用三个锚点（起始边 / 中心 / 结束边）里最近的那个去吸附
                    const snapAxis = (pos, size, targets) => {
                        const anchors = [pos - size / 2, pos, pos + size / 2];
                        let bestDelta = null;
                        for (const a of anchors) {
                            for (const t of targets) {
                                const d = t - a;
                                if (
                                    Math.abs(d) <= snapThreshold &&
                                    (bestDelta === null || Math.abs(d) < Math.abs(bestDelta))
                                ) {
                                    bestDelta = d;
                                }
                            }
                        }
                        return bestDelta === null ? pos : pos + bestDelta;
                    };

                    nx = snapAxis(nx, nw, xTargets);
                    ny = snapAxis(ny, nh, yTargets);
                }
            } else {
                const startL = bgStartBBox.x - bgStartBBox.w / 2;
                const startR = bgStartBBox.x + bgStartBBox.w / 2;
                const startT = bgStartBBox.y - bgStartBBox.h / 2;
                const startB = bgStartBBox.y + bgStartBBox.h / 2;

                let L = startL, R = startR, T = startT, B = startB;
                if (bgDragMode.includes("l")) L = startL + dx;
                if (bgDragMode.includes("r")) R = startR + dx;
                if (bgDragMode.includes("t")) T = startT + dy;
                if (bgDragMode.includes("b")) B = startB + dy;

                // 🌟 吸附：拖动的这条边靠近画布边缘/中心时自动对齐（和平移吸附同一开关）
                if (bgSnap) {
                    const { w: canvasW, h: canvasH } = getCanvasSize();
                    const snapThr = 8 / getActualScale();
                    const xTargets = [-canvasW / 2, 0, canvasW / 2];
                    const yTargets = [-canvasH / 2, 0, canvasH / 2];

                    const snapEdge = (value, targets) => {
                        let best = null;
                        for (const t of targets) {
                            const d = Math.abs(t - value);
                            if (d <= snapThr && (best === null || d < Math.abs(best - value))) best = t;
                        }
                        return best === null ? value : best;
                    };

                    if (bgDragMode.includes("l")) L = snapEdge(L, xTargets);
                    if (bgDragMode.includes("r")) R = snapEdge(R, xTargets);
                    if (bgDragMode.includes("t")) T = snapEdge(T, yTargets);
                    if (bgDragMode.includes("b")) B = snapEdge(B, yTargets);
                }

                let w = R - L;
                let h = B - T;
                const horiz = bgDragMode.includes("l") || bgDragMode.includes("r");
                const vert = bgDragMode.includes("t") || bgDragMode.includes("b");

                // 🌟 锁定长宽比：拖四条边也会按比例联动，不只是拖角
                if (bgLockRatio && bgStartBBox.w > 0 && bgStartBBox.h > 0) {
                    const aspect = bgStartBBox.w / bgStartBBox.h;

                    if (horiz && vert) {
                        // 角：以位移较大的一维为准
                        if (Math.abs(w) >= Math.abs(h) * aspect) h = w / aspect;
                        else w = h * aspect;
                    } else if (horiz) {
                        h = w / aspect;
                    } else if (vert) {
                        w = h * aspect;
                    }

                    // 固定未被拖拽的边，其余方向保持原中心
                    if (bgDragMode.includes("l")) L = R - w;
                    else if (bgDragMode.includes("r")) R = L + w;
                    else {
                        L = bgStartBBox.x - w / 2;
                        R = bgStartBBox.x + w / 2;
                    }

                    if (bgDragMode.includes("t")) T = B - h;
                    else if (bgDragMode.includes("b")) B = T + h;
                    else {
                        T = bgStartBBox.y - h / 2;
                        B = bgStartBBox.y + h / 2;
                    }
                }

                nx = (L + R) / 2;
                ny = (T + B) / 2;
                nw = Math.abs(R - L);
                nh = Math.abs(B - T);
            }

            if (nw > 10 && nh > 10) {
                bgX = nx; bgY = ny; bgW = nw; bgH = nh;
                drawCanvas();
            }
            return; // 阻断后续的 bbox 逻辑
        }

        if (!dragMode) return;

        const dx = mouseX - dragStartMouse.x;
        const dy = mouseY - dragStartMouse.y;
        const scale = getActualScale();
        const logicDx = dx / scale;
        const logicDy = dy / scale;
        const { w, h } = getCanvasSize();
        const limitX = w / 2;
        const limitY = h / 2;

        let [ymin, xmin, ymax, xmax] = dragStartBBox;
        let newYmin = ymin, newXmin = xmin, newYmax = ymax, newXmax = xmax;

        if (dragMode === "move") {
            // 🌟 核心修复：用起始快照算出初始视觉边界，防止每一帧重复叠加总位移
            const tempItem = { bbox: dragStartBBox, _align: currentItems[activeIndex]._align };
            const { isExtreme, vXmin, vYmin, vXmax, vYmax } = getVisualBounds(tempItem);
            
            if (isExtreme) {
                let newVx = vXmin + logicDx;
                let newVy = vYmin + logicDy;

                newVx = applySnap(newVx, e.altKey, true);
                newVy = applySnap(newVy, e.altKey, false);

                newVx = Math.max(-limitX, Math.min(newVx, limitX - GRID_SNAP));
                newVy = Math.max(-limitY, Math.min(newVy, limitY - GRID_SNAP));

                applyVisualBounds(currentItems[activeIndex], newVx, newVy);
            } else {
                let newXmin = vXmin + logicDx;
                let newYmin = vYmin + logicDy;

                newXmin = applySnap(newXmin, e.altKey, true);
                newYmin = applySnap(newYmin, e.altKey, false);

                newXmin = Math.max(-limitX, Math.min(newXmin, limitX - (vXmax - vXmin)));
                newYmin = Math.max(-limitY, Math.min(newYmin, limitY - (vYmax - vYmin)));

                currentItems[activeIndex].bbox = [
                    newYmin, newXmin,
                    newYmin + (vYmax - vYmin), newXmin + (vXmax - vXmin)
                ];
            }
        } else if (dragMode.startsWith("resize")) {
            // 🌟 核心补全：处理四角拉伸拖拽
            const isRight = dragMode === "resize-r" || dragMode === "resize-tr" || dragMode === "resize-br";
            const isLeft = dragMode === "resize-l" || dragMode === "resize-tl" || dragMode === "resize-bl";
            const isTop = dragMode === "resize-t" || dragMode === "resize-tl" || dragMode === "resize-tr";
            const isBottom = dragMode === "resize-b" || dragMode === "resize-bl" || dragMode === "resize-br";

            if (isRight) newXmax += logicDx;
            if (isLeft) newXmin += logicDx;
            if (isBottom) newYmax += logicDy;
            if (isTop) newYmin += logicDy;

            // 吸附处理（只吸附正在拖拽的边，固定边不动）
            if (isLeft) newXmin = applySnap(newXmin, e.altKey, true);
            if (isRight) newXmax = applySnap(newXmax, e.altKey, true);
            if (isTop) newYmin = applySnap(newYmin, e.altKey, false);
            if (isBottom) newYmax = applySnap(newYmax, e.altKey, false);

            // 约束：允许自由缩小到 1，不再强制卡在 16
            if (isLeft) {
                newXmin = Math.min(newXmin, newXmax - 1);
            } else if (isRight) {
                newXmax = Math.max(newXmax, newXmin + 1);
            }
            if (isTop) {
                newYmin = Math.min(newYmin, newYmax - 1);
            } else if (isBottom) {
                newYmax = Math.max(newYmax, newYmin + 1);
            }

            // 画布边界限制
            newXmin = Math.max(-limitX, Math.min(newXmin, limitX));
            newXmax = Math.max(-limitX, Math.min(newXmax, limitX));
            newYmin = Math.max(-limitY, Math.min(newYmin, limitY));
            newYmax = Math.max(-limitY, Math.min(newYmax, limitY));

            currentItems[activeIndex].bbox = [
                Math.min(newYmin, newYmax), Math.min(newXmin, newXmax),
                Math.max(newYmin, newYmax), Math.max(newXmin, newXmax),
            ];
        }
        drawCanvas();
    });

    window.addEventListener("mouseup", () => {
        if (bgDragMode) {
            bgDragMode = null;
            if (syncBgSizeHook) syncBgSizeHook(); // 拖动/拉伸结束后刷新尺寸输入框
            return;
        }
        if (isPanning) {
            isPanning = false;
            canvas.style.cursor = "default";
            return;
        }
        if (!dragMode) return;

        const currentDragMode = dragMode;
        const currentActive = activeIndex;
        dragMode = null;

        try {
            if (currentActive !== -1) {
                const item = currentItems[currentActive];
                if (item) {
                    const [ymin, xmin, ymax, xmax] = item.bbox;
                    let w = xmax - xmin;
                    let h = ymax - ymin;

                    // 🌟 身份证查验
                    const isNew = !knownBboxHistory.has(dragStartBBox.join(","));

                    // 1. 防误触：新建框且极小，直接静默删除
                    if (isNew && w <= 5 && h <= 5) {
                        currentItems.splice(currentActive, 1);
                        selectedIndices.delete(currentActive);
                        activeIndex = -1;
                        syncEditorPanel();
                        drawCanvas();
                        return;
                    }

                    // 2. 缩放到小于网格尺寸时，强制变为正方形极小框
                    if (currentDragMode && currentDragMode.startsWith("resize") && (w < GRID_SNAP || h < GRID_SNAP)) {
                        const finalSize = Math.max(1, Math.min(w, h));
                        
                        // 🌟 核心修复：在这里获取画布尺寸，防止 limitX 报错！
                        const { w: canvasW, h: canvasH } = getCanvasSize();
                        const limitX = canvasW / 2;
                        const limitY = canvasH / 2;
                        const halfT = GRID_SNAP / 2;

                        // 计算视觉代理框的安全中心点，防止视觉框溢出画布
                        let cx = (xmin + xmax) / 2;
                        let cy = (ymin + ymax) / 2;
                        cx = Math.max(-limitX + halfT, Math.min(cx, limitX - halfT));
                        cy = Math.max(-limitY + halfT, Math.min(cy, limitY - halfT));

                        const finalXmin = Math.round(cx - finalSize / 2);
                        const finalYmin = Math.round(cy - finalSize / 2);
                        
                        item.bbox = [finalYmin, finalXmin, finalYmin + finalSize, finalXmin + finalSize];
                    }
                    
                    // 3. 刷新通行证
                    knownBboxHistory.add(item.bbox.join(","));
                }
            }

            if (activeIndex !== -1) {
                saveEditorChanges();
                const lastActive = activeIndex;
                renderList(false);
                activeIndex = lastActive;
                if (currentItems[activeIndex]) {
                    syncEditorPanel();
                }
            }
        } catch (err) {
            console.error("[MOSS] mouseup error:", err);
        } finally {
            drawCanvas();
            if (node.graph) node.graph.setDirtyCanvas(true, true);
        }
    });

    canvas.addEventListener("auxclick", (e) => {
        if (e.button === 1) e.preventDefault();
    });

    const getHitInfo = (mouseX, mouseY) => {
        const handleDist = 12;
        
        // 提取单框命中检测逻辑
        const checkItemHit = (item, i) => {
            const { vXmin, vYmin, vXmax, vYmax, isExtreme } = getVisualBounds(item);
            const p1 = logicToPhys(vXmin, vYmin);
            const p2 = logicToPhys(vXmax, vYmax);

            // 检测四角（极小框跳过）
            if (!isExtreme) {
                const nearTL = Math.abs(mouseX - p1.x) < handleDist && Math.abs(mouseY - p1.y) < handleDist;
                const nearTR = Math.abs(mouseX - p2.x) < handleDist && Math.abs(mouseY - p1.y) < handleDist;
                const nearBL = Math.abs(mouseX - p1.x) < handleDist && Math.abs(mouseY - p2.y) < handleDist;
                const nearBR = Math.abs(mouseX - p2.x) < handleDist && Math.abs(mouseY - p2.y) < handleDist;

                if (nearTL) return { type: "resize-tl", index: i };
                if (nearTR) return { type: "resize-tr", index: i };
                if (nearBL) return { type: "resize-bl", index: i };
                if (nearBR) return { type: "resize-br", index: i };
            }

            // 检测框体内部或极小框
            if (mouseX >= p1.x && mouseX <= p2.x && mouseY >= p1.y && mouseY <= p2.y) {
                if (item._locked) return { type: "select-label", index: i };
                return { type: "move", index: i };
            }
            return null;
        };

        // 🌟 1. 绝对最高优先级：检测数字标签（确保重叠时能通过点标签切换选中）
        for (let i = labelCache.length - 1; i >= 0; i--) {
            const l = labelCache[i];
            if (mouseX >= l.x && mouseX <= l.x + l.w && mouseY >= l.y && mouseY <= l.y + l.h) {
                return { type: "select-label", index: l.index };
            }
        }

        // 🌟 2. 次高优先级：检测当前已经选中的框（选中后操作它时，不被其他框抢走焦点）
        if (activeIndex !== -1 && currentItems[activeIndex]) {
            const hit = checkItemHit(currentItems[activeIndex], activeIndex);
            if (hit) return hit;
        }

        // 🌟 3. 最后：检测其他框（从后往前遍历）
        for (let i = currentItems.length - 1; i >= 0; i--) {
            if (i === activeIndex) continue; // 刚刚已经测过了，跳过
            const hit = checkItemHit(currentItems[i], i);
            if (hit) return hit;
        }
        
        return { type: "create", index: -1 };
    };

    // --- 🌟 双击修改描述功能 ---
    canvas.addEventListener("dblclick", (e) => {
        e.preventDefault();
        const rect = canvasContainer.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        // 与单击保持一致：优先「当前选中的框」→ 数字标签 → 其他框。
        // 之前这里只按序号从大到小扫，重叠时会把精确选中的小框顶掉。
        let targetIdx = -1;

        const hit = getHitInfo(mouseX, mouseY);
        if (hit && typeof hit.index === "number" && currentItems[hit.index]) {
            targetIdx = hit.index;
        }

        if (targetIdx === -1) {
            for (let i = currentItems.length - 1; i >= 0; i--) {
                const item = currentItems[i];
                const bbox = item && item.bbox;
                if (!bbox || bbox.length !== 4) continue;
                const { vXmin, vYmin, vXmax, vYmax } = getVisualBounds(item);
                const p1 = logicToPhys(vXmin, vYmin);
                const p2 = logicToPhys(vXmax, vYmax);
                if (mouseX >= p1.x && mouseX <= p2.x && mouseY >= p1.y && mouseY <= p2.y) {
                    targetIdx = i;
                    break;
                }
            }
        }

        if (targetIdx !== -1) {
            // 选中该框
            activeIndex = targetIdx;
            selectedIndices.clear();
            selectedIndices.add(targetIdx);
            updateListSelection();
            syncEditorPanel();
            drawCanvas();

            // 计算悬浮输入框的位置和大小
            const bbox = currentItems[targetIdx].bbox;
            const p1 = logicToPhys(bbox[1], bbox[0]);
            const p2 = logicToPhys(bbox[3], bbox[2]);

            // 创建 textarea
            const inlineInput = document.createElement("textarea");
            inlineInput.value =
                currentItems[targetIdx].caption || currentItems[targetIdx].desc || "";
            inlineInput.style.cssText = `
                position: absolute;
                left: ${p1.x}px;
                top: ${p1.y}px;
                width: ${Math.max(50, p2.x - p1.x)}px;
                height: ${Math.max(30, p2.y - p1.y)}px;
                background: rgba(0, 0, 0, 0.85);
                color: #fff;
                border: 2px solid #4a9eff;
                border-radius: 4px;
                padding: 4px;
                font-size: 12px;
                font-family: sans-serif;
                resize: none;
                outline: none;
                z-index: 100;
            `;

            canvasContainer.appendChild(inlineInput);
            inlineInput.focus();
            inlineInput.select();

            // 保存逻辑
            let inlineSaved = false;
            const saveInline = () => {
                if (inlineSaved) return; // Enter 后移除元素会再触发 blur，避免重复保存
                inlineSaved = true;
                const newText = inlineInput.value.trim();
                if (currentItems[targetIdx]) {
                    const changed = (currentItems[targetIdx].caption || "") !== newText;
                    currentItems[targetIdx].caption = newText;
                    saveEditorChanges(); // 同步到 JSON、右侧列表
                    // 同步下方属性面板的「描述」输入框
                    if (changed) syncEditorPanel();
                }
                if (inlineInput.parentNode)
                    inlineInput.parentNode.removeChild(inlineInput);
            };

            // 失焦保存
            inlineInput.addEventListener("blur", saveInline);

            // 边打字边把内容同步到下方属性面板的「描述」
            inlineInput.addEventListener("input", () => {
                if (document.activeElement === descArea) return;
                descArea.value = inlineInput.value;
            });

            // 键盘快捷键
            inlineInput.addEventListener("keydown", (ev) => {
                ev.stopPropagation(); // 防止触发画布的删除快捷键
                if (ev.key === "Enter" && !ev.shiftKey) {
                    ev.preventDefault();
                    saveInline();
                } else if (ev.key === "Escape") {
                    ev.preventDefault();
                    inlineSaved = true; // 放弃修改：别让 blur 再保存一次
                    if (inlineInput.parentNode)
                        inlineInput.parentNode.removeChild(inlineInput);
                    syncEditorPanel(); // 把面板里的临时文本还原
                }
            });
        }
    });

    // 🌟 框的复制 / 粘贴（Ctrl+C / Ctrl+V）
    const cloneItemForClipboard = (item) => {
        const copy = JSON.parse(JSON.stringify(item));
        Object.keys(copy).forEach((k) => {
            if (k.startsWith("_")) delete copy[k];
        });
        return copy;
    };

    const copySelectedBoxes = () => {
        const idxs = selectedIndices.size
            ? Array.from(selectedIndices)
            : activeIndex !== -1
              ? [activeIndex]
              : [];
        if (!idxs.length) return false;
        idxs.sort((a, b) => a - b);
        bboxClipboard = idxs
            .map((i) => currentItems[i])
            .filter(Boolean)
            .map(cloneItemForClipboard);
        return bboxClipboard.length > 0;
    };

    const pasteBoxes = () => {
        if (!bboxClipboard.length) return false;
        const { w, h } = getCanvasSize();
        const limitX = w / 2;
        const limitY = h / 2;
        const offset = 10; // 粘出来的框稍微错开，避免完全重叠看不见

        const added = [];
        bboxClipboard.forEach((src) => {
            const clone = JSON.parse(JSON.stringify(src));
            const bbox = Array.isArray(clone.bbox) ? clone.bbox : null;
            if (!bbox || bbox.length !== 4) return;

            const bw = bbox[3] - bbox[1];
            const bh = bbox[2] - bbox[0];
            const xmin = Math.max(-limitX, Math.min(bbox[1] + offset, limitX - bw));
            const ymin = Math.max(-limitY, Math.min(bbox[0] + offset, limitY - bh));

            clone.bbox = [ymin, xmin, ymin + bh, xmin + bw];
            currentItems.push(clone);
            added.push(currentItems.length - 1);
        });

        if (!added.length) return false;

        activeIndex = added[added.length - 1];
        selectedIndices.clear();
        added.forEach((i) => selectedIndices.add(i));

        saveEditorChanges();
        renderList();
        syncEditorPanel();
        drawCanvas();
        return true;
    };

    const isPanelOpen = () => {
        if (!panel || !document.body.contains(panel)) return false;
        return panel.style.display !== "none";
    };

    // 只在"面板内"或"画布聚焦"时接管快捷键，避免抢走 ComfyUI 自己的复制粘贴
    const isOurContext = (target) => {
        if (target === canvas || panel.contains(target)) return true;
        const ae = document.activeElement;
        return ae === canvas || (ae && panel.contains(ae));
    };

    const isTypingElsewhere = () => {
        const ae = document.activeElement;
        if (!ae) return false;
        return (
            ae.tagName === "INPUT" ||
            ae.tagName === "TEXTAREA" ||
            ae.tagName === "SELECT" ||
            ae.isContentEditable
        );
    };

    const onPanelCopyKeydown = (e) => {
        if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
        if ((e.key || "").toLowerCase() !== "c") return;
        if (!document.body.contains(panel)) {
            window.removeEventListener("keydown", onPanelCopyKeydown, true);
            return;
        }
        if (!isPanelOpen() || isTypingElsewhere()) return;
        if (!isOurContext(e.target)) return;

        if (copySelectedBoxes()) {
            e.preventDefault();
            e.stopPropagation();
        }
    };
    window.addEventListener("keydown", onPanelCopyKeydown, true);

    const onPanelPaste = (e) => {
        if (!document.body.contains(panel)) {
            document.removeEventListener("paste", onPanelPaste, true);
            return;
        }
        if (e.defaultPrevented || !isPanelOpen() || isTypingElsewhere()) return;
        if (!isOurContext(e.target)) return;

        // 剪贴板里是图片 → 交给背景图逻辑（canvas 的 paste 监听会处理）
        const items = e.clipboardData?.items;
        const hasImage = items
            ? Array.from(items).some((it) => it.type && it.type.startsWith("image/"))
            : false;
        if (hasImage) return;

        if (bboxClipboard.length && pasteBoxes()) {
            e.preventDefault();
            e.stopPropagation();
        }
    };
    document.addEventListener("paste", onPanelPaste, true);

    canvas.addEventListener("keydown", (e) => {
        if (e.key === "Delete" || e.key === "Backspace") {
            if (document.activeElement !== canvas) return;

            // 🌟 优先：处于"操控背景图"模式时，Delete/Backspace 删除背景图
            if (bgActive && bgImage) {
                deleteBackgroundImage();
                e.preventDefault();
                return;
            }
            
            if (selectedIndices.size > 0 && document.activeElement === canvas) {
                const indicesToRemove = Array.from(selectedIndices).sort((a, b) => b - a);
                const raw = JSON.parse(jsonWidget.value);
                const isArray = Array.isArray(raw);
                const data = isArray ? raw : { ...raw, items: currentItems };
                const items = isArray ? data : data.items;
                indicesToRemove.forEach((idx) => items.splice(idx, 1));

                activeIndex = -1;
                selectedIndices.clear();

                isUpdatingFromUI = true;
                jsonWidget.value = serializeLayout(data);
                if (jsonWidget.callback) jsonWidget.callback(jsonWidget.value);
                isUpdatingFromUI = false;
                recordHistory(jsonWidget.value, false);
                renderList();
                syncEditorPanel();
                drawCanvas();
                if (node.graph) node.graph.setDirtyCanvas(true, true);
                e.preventDefault();
            }
        }
    });

    canvas.addEventListener("mousemove", (e) => {
        if (isPanning || dragMode) return;
        const rect = canvasContainer.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        // 🌟 最高优先级：操控背景图时的光标（移动 / 拉伸），优先于框和黑色区域
        if (bgActive && bgImage) {
            const mode = getBgHitMode(mouseX, mouseY);
            if (mode === "tl" || mode === "br") canvas.style.cursor = "nwse-resize";
            else if (mode === "tr" || mode === "bl") canvas.style.cursor = "nesw-resize";
            else if (mode === "t" || mode === "b") canvas.style.cursor = "ns-resize";
            else if (mode === "l" || mode === "r") canvas.style.cursor = "ew-resize";
            else if (mode === "move") canvas.style.cursor = "move";
            else canvas.style.cursor = "default"; // 操控模式下空白处不建框、不平移
            return;
        }

        let hoveredLabel = false;
        for (let l of labelCache) {
            if (
                mouseX >= l.x &&
                mouseX <= l.x + l.w &&
                mouseY >= l.y &&
                mouseY <= l.y + l.h
            ) {
                hoveredLabel = true;
                break;
            }
        }

        if (hoveredLabel) {
            canvas.style.cursor = "pointer";
            return;
        }

        const hit = getHitInfo(mouseX, mouseY);

        if (hit.type === "create") {
            // 画布外的黑色区域拖动是“平移”，光标也换成抓手
            const { w: cw, h: ch } = getCanvasSize();
            const tl = logicToPhys(-cw / 2, -ch / 2);
            const br = logicToPhys(cw / 2, ch / 2);
            const insideCanvas =
                mouseX >= tl.x && mouseX <= br.x && mouseY >= tl.y && mouseY <= br.y;
            canvas.style.cursor = insideCanvas ? "crosshair" : "grab";
        } else if (hit.type === "move") canvas.style.cursor = "move";
        else if (hit.type === "resize-tl" || hit.type === "resize-br")
            canvas.style.cursor = "nwse-resize";
        else if (hit.type === "resize-tr" || hit.type === "resize-bl")
            canvas.style.cursor = "nesw-resize";
    });

    canvas.addEventListener("mouseleave", () => {
        if (!isPanning && !dragMode) canvas.style.cursor = "default";
    });

    snapCb.addEventListener("change", () => drawCanvas());

    const updateListSelection = () => {
        const cbs = listArea.querySelectorAll("input[type='checkbox']");
        Array.from(listArea.children).forEach((child, i) => {
            const isSel = selectedIndices.has(i);
            if (cbs[i]) cbs[i].checked = isSel;

            child.style.background =
                i === activeIndex ? "#324664" : isSel ? "#2a3a4f" : "#2a2a2a";
            child.style.borderColor =
                i === activeIndex ? "#5c8ccb" : isSel ? "#4a7ab5" : "#333";
        });
        selectAllCb.checked =
            currentItems.length > 0 && selectedIndices.size === currentItems.length;
    };

        // 🌟 同步 canvas 字段到 UI
    const syncCanvasMode = () => {
        try {
            const data = JSON.parse(jsonWidget.value || "{}");
            const canvasMode = data?.summary?.canvas || "";
            if (canvasModeSelect.value !== canvasMode) {
                // 如果 JSON 里有个我们预设之外的 custom 值，动态添加进去
                let optionExists = Array.from(canvasModeSelect.options).some(o => o.value === canvasMode);
                if (!optionExists && canvasMode) {
                    const o = document.createElement("option");
                    o.value = canvasMode;
                    o.textContent = canvasMode;
                    canvasModeSelect.appendChild(o);
                }
                canvasModeSelect.value = canvasMode;
            }
        } catch (e) { }
    };

        // 🌟 同步主提示词到 UI
    const syncPrompt = () => {
        // 如果用户正在输入，不要覆盖它的光标和内容
        if (document.activeElement === promptTextarea) return;
        try {
            const data = JSON.parse(jsonWidget.value || "{}");
            const caption = data?.summary?.caption || "";
            if (promptTextarea.value !== caption) {
                promptTextarea.value = caption;
            }
        } catch (e) { }
    };

    // 🌟 监听主提示词输入，写入 JSON
    promptTextarea.addEventListener("input", () => {
        const val = promptTextarea.value;
        try {
            let data = JSON.parse(jsonWidget.value || "{}");
            if (Array.isArray(data)) {
                data = { summary: { caption: "" }, items: data };
            }
            if (!data.summary) data.summary = {};
            data.summary.caption = val;

            isUpdatingFromUI = true;
            jsonWidget.value = serializeLayout(data);
            if (jsonWidget.callback) jsonWidget.callback(jsonWidget.value);
            isUpdatingFromUI = false;
            recordHistory(jsonWidget.value);
            
            if (node.graph) node.graph.setDirtyCanvas(true, true);
        } catch (e) {
            console.error("[MOSS] 更新主提示词失败:", e);
        }
    });

    // 🌟 监听下拉框变化，写入 JSON
    canvasModeSelect.onchange = () => {
        const val = canvasModeSelect.value;
        try {
            let data = JSON.parse(jsonWidget.value || "{}");
            if (Array.isArray(data)) {
                data = { summary: { caption: "" }, items: data };
            }
            if (!data.summary) data.summary = {};

            if (val === "") {
                delete data.summary.canvas;
            } else {
                data.summary.canvas = val;
            }

            isUpdatingFromUI = true;
            jsonWidget.value = serializeLayout(data);
            if (jsonWidget.callback) jsonWidget.callback(jsonWidget.value);
            isUpdatingFromUI = false;
            recordHistory(jsonWidget.value, false);
            
            if (node.graph) node.graph.setDirtyCanvas(true, true);
        } catch (e) {
            console.error("[MOSS] 更新 canvas 字段失败:", e);
        }
    };

    // ================= 列表拖动排序 =================
    let listDrag = null;

    const listRows = () =>
        Array.from(listArea.children).filter((el) => el.dataset && el.dataset.index !== undefined);

    const snapshotTops = (rows) => {
        const map = new Map();
        rows.forEach((el) => map.set(el, el.getBoundingClientRect()));
        return map;
    };

    // FLIP：先反向位移，再过渡回原位，得到平滑的让位动画
    const animateRows = (rows, beforeMap) => {
        rows.forEach((el) => {
            const before = beforeMap.get(el);
            if (!before) return;
            const after = el.getBoundingClientRect();
            const dy = before.top - after.top;
            if (Math.abs(dy) < 1) return;
            el.style.transition = "none";
            el.style.transform = `translateY(${dy}px)`;
            void el.offsetHeight; // 强制回流，让上面的位移立即生效
            el.style.transition = "transform 0.16s cubic-bezier(0.2, 0.8, 0.3, 1)";
            el.style.transform = "";
        });
    };

    const onRowDragMove = (e) => {
        if (!listDrag) return;
        const { row, placeholder } = listDrag;
        // 拖动期间列表被重建（例如外部触发了 renderList），直接放弃这次拖动
        if (!row.isConnected || !placeholder.isConnected) return;

        row.style.top = `${e.clientY - listDrag.grabOffsetY - listDrag.panelTop}px`;

        const rowsNow = listRows().filter((el) => el !== row);
        const beforeMap = snapshotTops(rowsNow);
        const others = rowsNow.filter((el) => el !== placeholder);

        // 指针落在哪一行的上半部之前，就插到那一行前面
        let ref = null;
        for (const el of others) {
            const r = el.getBoundingClientRect();
            if (e.clientY < r.top + r.height / 2) {
                ref = el;
                break;
            }
        }

        const alreadyThere = ref
            ? placeholder.nextElementSibling === ref
            : placeholder === listArea.lastElementChild;
        if (alreadyThere) return;

        if (ref) listArea.insertBefore(placeholder, ref);
        else listArea.appendChild(placeholder);

        animateRows(rowsNow, beforeMap);
    };

    const onRowDragEnd = () => {
        if (!listDrag) return;
        const { row, placeholder, fromIndex, origCss } = listDrag;

        window.removeEventListener("pointermove", onRowDragMove);
        window.removeEventListener("pointerup", onRowDragEnd);
        window.removeEventListener("pointercancel", onRowDragEnd);
        document.body.style.userSelect = "";
        document.body.style.cursor = "";

        row.classList.remove("is-dragging");
        row.style.cssText = origCss;

        // 占位符已经被列表重建清掉时，只要把行收回来即可
        if (!placeholder.isConnected) {
            row.remove();
            listDrag = null;
            renderList();
            return;
        }

        // 占位符前面有多少个真实行，就是新的落点
        const all = Array.from(listArea.children);
        const toIndex = all
            .slice(0, all.indexOf(placeholder))
            .filter((el) => el.dataset.index !== undefined).length;

        listArea.insertBefore(row, placeholder);
        placeholder.remove();
        listDrag = null;

        if (toIndex === fromIndex) {
            updateListSelection();
            return;
        }

        // 重排数据并写回 JSON
        const [moved] = currentItems.splice(fromIndex, 1);
        currentItems.splice(toIndex, 0, moved);

        try {
            let parsed = JSON.parse(jsonWidget.value || "{}");
            if (Array.isArray(parsed)) {
                parsed = currentItems;
            } else {
                parsed.items = currentItems;
            }
            isUpdatingFromUI = true;
            jsonWidget.value = serializeLayout(parsed);
            if (jsonWidget.callback) jsonWidget.callback(jsonWidget.value);
            isUpdatingFromUI = false;
            recordHistory(jsonWidget.value, false);
        } catch (err) {
            console.error("[MOSS] 排序写回失败:", err);
        }

        renderList();
        selectedIndices.clear();
        selectedIndices.add(toIndex);
        activeIndex = toIndex;
        updateListSelection();
        syncEditorPanel();
        drawCanvas();
        if (node.graph) node.graph.setDirtyCanvas(true, true);
    };

    const beginRowDrag = (e, row, index) => {
        if (listDrag || currentItems.length < 2) return;
        e.preventDefault();
        e.stopPropagation();

        const rect = row.getBoundingClientRect();
        const panelRect = panel.getBoundingClientRect();
        const placeholder = document.createElement("div");
        placeholder.className = "moss-row-placeholder";
        placeholder.style.height = `${rect.height}px`;
        placeholder.style.boxSizing = "border-box";

        const origCss = row.style.cssText;
        row.parentElement.insertBefore(placeholder, row);

        row.dataset.index = String(index);
        row.classList.add("is-dragging");
        // 🌟 挂在主面板内部并用面板相对坐标：
        // 挂到 body 上会受页面变换/视口影响，可能撑出滚动条把左侧画布挤窄
        row.style.position = "absolute";
        row.style.boxSizing = "border-box";
        row.style.left = `${rect.left - panelRect.left}px`;
        row.style.top = `${rect.top - panelRect.top}px`;
        row.style.width = `${rect.width}px`;
        row.style.height = `${rect.height}px`;
        row.style.margin = "0";
        row.style.zIndex = "9999";
        row.style.pointerEvents = "none";
        row.style.opacity = "0.98";
        row.style.boxShadow = "0 12px 26px rgba(0, 0, 0, 0.65)";
        row.style.transition = "box-shadow 0.15s ease";
        panel.appendChild(row);

        listDrag = {
            row,
            placeholder,
            fromIndex: index,
            origCss,
            grabOffsetY: e.clientY - rect.top,
            pointerId: e.pointerId,
            panelTop: panelRect.top,
        };

        document.body.style.userSelect = "none";
        document.body.style.cursor = "grabbing";

        window.addEventListener("pointermove", onRowDragMove);
        window.addEventListener("pointerup", onRowDragEnd);
        window.addEventListener("pointercancel", onRowDragEnd);
    };

    const renderList = (resetActive = true) => {
        syncCanvasMode();
        syncPrompt();

        if (resetActive) {
            activeIndex = -1;
            selectedIndices.clear();
            syncEditorPanel();
        }
        listArea.innerHTML = "";
        selectAllCb.checked = false;

        const prevItems = currentItems;
        try {
            const data = JSON.parse(jsonWidget.value || "{}");
            currentItems = Array.isArray(data) ? data : data.items || [];
            carryEditorState(prevItems, currentItems);

            knownBboxHistory.clear();
            currentItems.forEach(item => {
                if (item.bbox && item.bbox.length === 4) {
                    knownBboxHistory.add(item.bbox.join(","));
                }
            });
        } catch (e) {
            listArea.innerHTML = "<div style='color:#888;'>JSON 格式错误</div>";
            drawCanvas();
            return;
        }

        if (currentItems.length === 0) {
            listArea.innerHTML = "<div style='color:#888;'>当前没有边界框</div>";
            drawCanvas();
            return;
        }

        currentItems.forEach((item, index) => {
            const row = document.createElement("div");
            // 🌟 极小框红色高亮
            const realW = item.bbox[3] - item.bbox[1];
            const realH = item.bbox[2] - item.bbox[0];
            const isExtreme = realW < GRID_SNAP || realH < GRID_SNAP;
            
            row.style.cssText = `display: flex; align-items: center; gap: 8px; padding: 6px 8px; background: #2a2a2a; border-radius: 4px; border: 1px solid ${isExtreme ? '#ff4a4a' : '#333'}; flex-shrink: 0; min-width: 0; cursor: pointer;`;
            row.dataset.index = String(index);

            // 🌟 左侧六点拖动柄：按住即可上下拖动排序
            const grip = document.createElement("span");
            grip.className = "moss-grip";
            grip.textContent = "⠿";
            grip.title = "按住拖动排序";
            grip.addEventListener("pointerdown", (e) => beginRowDrag(e, row, index));

            const cb = document.createElement("input");
            cb.type = "checkbox";
            cb.dataset.index = index;
            cb.checked = selectedIndices.has(index);
            cb.style.cssText = "cursor: pointer; accent-color: #4a9eff;";

            cb.addEventListener("change", () => {
                if (cb.checked) {
                    selectedIndices.add(index);
                    activeIndex = index;
                } else {
                    selectedIndices.delete(index);
                    if (activeIndex === index) activeIndex = -1;
                }
                updateListSelection();
                syncEditorPanel();
                drawCanvas();
            });

            row.addEventListener("click", (e) => {
                if (e.target.closest?.(".moss-grip")) return; // 拖动柄不触发选中
                if (e.target !== cb && e.target.tagName !== "BUTTON") {
                    if (e.ctrlKey || e.metaKey) {
                        cb.checked = !cb.checked;
                    } else {
                        if (!cb.checked) {
                            selectedIndices.clear();
                            cb.checked = true;
                        }
                    }
                    cb.dispatchEvent(new Event("change"));
                }
            });

            const label = document.createElement("span");
            label.className = "moss-row-label";
            let text = item.caption || item.desc || `未命名 (${item.label || "object"})`;
            if (isExtreme) text = `[极小框 ${realW}x${realH}] ${text}`; // 显示真实尺寸
            
            label.textContent = `${index + 1}. ${text.length > 15 ? text.substring(0, 15) + "..." : text}`;
            label.style.cssText = `color: ${isExtreme ? '#ff4a4a' : '#ccc'}; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; pointer-events: none;`;

            // 🌟 锁定按钮
            const lockBtn = document.createElement("button");
            lockBtn.textContent = item._locked ? "🔒" : "🔓";
            lockBtn.title = item._locked ? "已锁住，点击解锁" : "锁住框，禁止拖动";
            lockBtn.style.cssText = "background: transparent; border: none; cursor: pointer; font-size: 14px; padding: 0;";
            lockBtn.onclick = (e) => {
                e.stopPropagation();
                item._locked = !item._locked;
                lockBtn.textContent = item._locked ? "🔒" : "🔓";
                // 锁定状态不存入 JSON，只是前端内存状态
                drawCanvas();
            };

            row.appendChild(grip);
            row.appendChild(cb);
            row.appendChild(label);
            row.appendChild(lockBtn);
            listArea.appendChild(row);
        });

        setTimeout(() => {
            updateListSelection();
            syncEditorPanel();
            drawCanvas();
        }, 10);
    };

    selectAllCb.addEventListener("change", (e) => {
        const isChecked = e.target.checked;
        selectedIndices.clear();
        if (isChecked) {
            currentItems.forEach((_, i) => selectedIndices.add(i));
            activeIndex = currentItems.length - 1;
        } else {
            activeIndex = -1;
        }
        updateListSelection();
        syncEditorPanel();
        drawCanvas();
    });

    addBtn.addEventListener("click", () => {
        try {
            let data = JSON.parse(jsonWidget.value || "{}");
            if (Array.isArray(data))
                data = { summary: { caption: "杰作" }, items: data };
            if (!data.items) data.items = [];
            data.items.push({
                label: "object",
                caption: "新对象",
                bbox: [-128, -128, 128, 128],
            });

            knownBboxHistory.add("-128,-128,128,128");

            isUpdatingFromUI = true;
            jsonWidget.value = serializeLayout(data);
            if (jsonWidget.callback) jsonWidget.callback(jsonWidget.value);
            isUpdatingFromUI = false;
            recordHistory(jsonWidget.value, false);

            selectedIndices.clear();
            selectedIndices.add(data.items.length - 1);
            activeIndex = data.items.length - 1;

            renderList(false);
            syncEditorPanel();
            listArea.scrollTop = listArea.scrollHeight;
            if (node.graph) node.graph.setDirtyCanvas(true, true);
        } catch (e) {
            alert("增加失败！");
        }
    });

    deleteBtn.addEventListener("click", () => {
        if (selectedIndices.size === 0) return alert("请先勾选要删除的框！");
        if (!confirm(`确定要删除选中的 ${selectedIndices.size} 个框吗？`)) return;

        const indicesToRemove = Array.from(selectedIndices).sort((a, b) => b - a);

        try {
            let data = JSON.parse(jsonWidget.value);
            let items = Array.isArray(data) ? data : data.items;
            indicesToRemove.forEach((idx) => items.splice(idx, 1));

            isUpdatingFromUI = true;
            jsonWidget.value = serializeLayout(data);
            if (jsonWidget.callback) jsonWidget.callback(jsonWidget.value);
            isUpdatingFromUI = false;
            recordHistory(jsonWidget.value, false);

            selectedIndices.clear();
            activeIndex = -1;
            renderList();
            syncEditorPanel();
            if (node.graph) node.graph.setDirtyCanvas(true, true);
        } catch (e) {
            alert("删除失败！");
        }
    });

    // 把草稿格式（abs/xyxy）就地转成模型格式（abs_centralized/yxyx），并同步画布尺寸。
    // width / height 会保留在 JSON 里（模型格式也允许携带），只在生成提示词时剥离。
    const normalizeJsonWidget = () => {
        const wW = node.widgets?.find((x) => x.name === "canvas_width");
        const hW = node.widgets?.find((x) => x.name === "canvas_height");
        let parsed;
        try {
            parsed = JSON.parse(jsonWidget.value || "{}");
        } catch (_) {
            return;
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;

        const res = normalizeLayoutSchema(parsed, wW?.value, hW?.value);

        // JSON 自带画布尺寸时，以它为准同步到节点控件
        if (res.width && wW && wW.value !== res.width) {
            wW.value = res.width;
            wW.callback?.(wW.value);
        }
        if (res.height && hW && hW.value !== res.height) {
            hW.value = res.height;
            hW.callback?.(hW.value);
        }

        if (!res.converted) return;

        isUpdatingFromUI = true;
        jsonWidget.value = serializeLayout(parsed);
        jsonWidget.callback?.(jsonWidget.value); // 只刷新控件显示，不触发 renderList
        isUpdatingFromUI = false;
        console.log("[MOSS] 已把草稿格式(abs/xyxy)转换为模型格式(abs_centralized/yxyx)");
    };

    // 画布控件变化时，把 JSON 里已有的 width / height 同步过去（不主动新增字段）
    const syncCanvasSizeToJson = (key, value) => {
        let parsed;
        try {
            parsed = JSON.parse(jsonWidget.value || "{}");
        } catch (_) {
            return;
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
        if (!(key in parsed)) return;
        const num = Number(value);
        if (!Number.isFinite(num) || Number(parsed[key]) === num) return;
        parsed[key] = num;
        isUpdatingFromUI = true;
        jsonWidget.value = serializeLayout(parsed);
        jsonWidget.callback?.(jsonWidget.value);
        isUpdatingFromUI = false;
    };

    const origCallback = jsonWidget.callback;
    jsonWidget.callback = function () {
        if (origCallback) origCallback.apply(this, arguments);
        if (isUpdatingFromUI) return;
        normalizeJsonWidget();
        recordHistory(jsonWidget.value); // 手动改 JSON 也进撤销栈（连续输入会合并）
        renderList();
    };

    const wWidget = node.widgets.find((w) => w.name === "canvas_width");
    const hWidget = node.widgets.find((w) => w.name === "canvas_height");
    if (wWidget && hWidget) {
        const origWCb = wWidget.callback,
            origHCb = hWidget.callback;
        wWidget.callback = function () {
            if (origWCb) origWCb.apply(this, arguments);
            syncCanvasSizeToJson("width", wWidget.value);
            drawCanvas();
        };
        hWidget.callback = function () {
            if (origHCb) origHCb.apply(this, arguments);
            syncCanvasSizeToJson("height", hWidget.value);
            drawCanvas();
        };
    }

    const showHelpModal = () => {
        const modal = document.createElement("div");
        modal.style.cssText = "position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); background: rgba(30, 30, 30, 0.95); backdrop-filter: blur(10px); border: 1px solid #555; border-radius: 8px; padding: 20px; z-index: 9999; box-shadow: 0 10px 30px rgba(0,0,0,0.8); color: #eee; text-align: left; width: 400px; font-family: sans-serif; font-size: 13px; line-height: 1.6;";
        
        modal.innerHTML = `
            <div style="font-size: 16px; font-weight: bold; margin-bottom: 15px; color: #4a9eff; text-align: center;">📖 边界框画布操作指南</div>
            
            <div style="margin-bottom: 10px;"><b style="color:#fff;">🖱️ 基础操作：</b></div>
            <ul style="margin: 0 0 10px 20px; padding: 0; color: #ccc;">
                <li>在空白处按住左键拖动：<b>创建新框</b></li>
                <li>拖动框的内部或数字标签：<b>移动框</b></li>
                <li>拖动框的四个角：<b>拉伸缩放</b></li>
                <li>双击框内部：<b>快速编辑描述</b></li>
                <li>滚轮：<b>缩放画布</b>；中键拖动：<b>平移画布</b></li>
            </ul>

            <div style="margin-bottom: 10px;"><b style="color:#fff;">⌨️ 快捷键：</b></div>
            <ul style="margin: 0 0 10px 20px; padding: 0; color: #ccc;">
                <li><b>Delete / Backspace</b>：删除选中框（或在操控模式下删除背景图）</li>
                <li><b>方向键</b>：微移选中的框 1px；<b>Shift + 方向键</b>：按吸附步长移动</li>
                <li><b>撤销 / 重做 / 重置视图</b>：画布右下角的 ↶ ↷ 🎯 按钮</li>
                <li><b>Ctrl + V</b>：在画布聚焦时粘贴背景图</li>
                <li><b>Ctrl + 点击</b>：多选框</li>
            </ul>

            <div style="margin-bottom: 10px;"><b style="color:#fff;">📐 极小框控制：</b></div>
            <ul style="margin: 0 0 10px 20px; padding: 0; color: #ccc;">
                <li>当框的宽或高小于当前网格尺寸（16 或 32）时，会在画布上显示为同样大小的红色虚线框。</li>
                <li>在右侧菜单勾选“极小框控制”，可自定义 1 ~ (网格尺寸-1) px 的尺寸及对齐方式。</li>
            </ul>

            <div style="margin-bottom: 10px;"><b style="color:#fff;">🔒 锁定功能：</b></div>
            <ul style="margin: 0 0 10px 20px; padding: 0; color: #ccc;">
                <li>在右侧列表点击 🔓 锁定框，锁定后不可拖拽和缩放。</li>
                <li>只能点击数字标签选中，在右侧修改参数。</li>
            </ul>

            <div style="text-align: center; margin-top: 20px;">
                <button id="close-help-btn" style="background: #4a9eff; color: white; border: none; padding: 6px 20px; border-radius: 4px; cursor: pointer; font-weight: bold;">我知道了</button>
            </div>
        `;
        
        canvasContainer.appendChild(modal);
        modal.querySelector("#close-help-btn").onclick = () => modal.remove();
    };

    normalizeJsonWidget(); // 打开面板时就把草稿格式转成模型格式
    renderList();
    recordHistory(jsonWidget.value, false); // 撤销栈的初始状态
    lastRecordAt = 0; // 保证首次编辑不会被合并进初始状态

    // 🌟 暴露刷新接口，供重新打开面板时调用
    node._mossRefreshPanel = () => {
        renderList();
    };

    openPanelIds.add(node.id); // 记下来，节点被重建（如 Ctrl+Z）时可自动恢复

    // 🌟 消费 pending 背景图（放在函数末尾，此时 getCanvasSize / drawCanvas 等全部已初始化）
    if (node._mossPendingBackground) {
        try {
            applyBackgroundImage(node._mossPendingBackground);
        } catch (e) {
            console.error("[MOSS] 消费 pending 背景图失败:", e);
        }
        node._mossPendingBackground = null;
    }
}

app.registerExtension({
    name: "Comfy.MOSS_Resizer_DynamicUI",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name !== "MOSS_BBox_Resizer") return;

        const onExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (message) {
            const r = onExecuted?.apply(this, arguments);
            const ui = message?.ui || message?.output || message || {};
            const oldWidth = ui.old_width?.[0];
            const oldHeight = ui.old_height?.[0];
            console.log("[MOSS] 尺寸映射执行结果:", { oldWidth, oldHeight, message });
            const updateWidget = (name, value) => {
                const widget = this.widgets?.find((item) => item.name === name);
                if (widget && Number.isFinite(value) && widget.value !== value) {
                    widget.value = value;
                    widget.callback?.(value);
                }
            };
            updateWidget("old_width", oldWidth);
            updateWidget("old_height", oldHeight);
            if (!Number.isFinite(oldWidth) || !Number.isFinite(oldHeight)) {
                setTimeout(() => this._mossCalculateAndLockSize?.(), 0);
            }
            return r;
        };

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onNodeCreated
                ? onNodeCreated.apply(this, arguments)
                : undefined;
            const node = this;

            const LABELS = {
                "layout_json": "布局 JSON",
                "auto_guess_old_size": "自动推测原尺寸",
                "guess_ratio": "推测宽高比",
                "old_width": "原图宽度",
                "old_height": "原图高度",
                "new_width": "目标宽度",
                "new_height": "目标高度",
                "resize_mode": "尺寸映射模式",
                "scale_factor": "额外缩放倍率",
            };
            node.widgets?.forEach((widget) => {
                if (LABELS[widget.name]) widget.label = LABELS[widget.name];
            });
            setTimeout(() => {
                node.inputs?.forEach((input) => {
                    if (LABELS[input.name]) input.label = LABELS[input.name];
                });
                node.graph?.setDirtyCanvas(true, true);
            }, 50);

            const jsonWidget = node.widgets.find((w) => w.name === "layout_json");
            const autoGuessWidget = node.widgets.find(
                (w) => w.name === "auto_guess_old_size",
            );
            const ratioWidget = node.widgets.find((w) => w.name === "guess_ratio");
            const modeWidget = node.widgets.find((w) => w.name === "resize_mode");
            const scaleWidget = node.widgets.find((w) => w.name === "scale_factor");
            const oldWWidget = node.widgets.find((w) => w.name === "old_width");
            const oldHWidget = node.widgets.find((w) => w.name === "old_height");

            if (!jsonWidget || !autoGuessWidget || !modeWidget || !scaleWidget || !oldWWidget || !oldHWidget)
                return r;

            // 🌟 1. 核心逻辑：实时计算并填入尺寸，同时控制禁用状态
            const readConnectedJson = (currentNode, visited = new Set()) => {
                if (!currentNode || visited.has(currentNode.id)) return "";
                visited.add(currentNode.id);
                const input = currentNode.inputs?.find((item) => item.name === "layout_json");
                if (!input?.link) return "";
                const link = currentNode.graph?.links?.[input.link];
                const origin = link ? currentNode.graph?.getNodeById(link.origin_id) : null;
                if (!origin) return "";

                const candidates = ["layout_json", "json", "text", "string", "value", "prompt"];
                for (const name of candidates) {
                    const widget = origin.widgets?.find((item) => item.name === name);
                    if (typeof widget?.value !== "string" || !widget.value.trim()) continue;
                    try {
                        const parsed = JSON.parse(widget.value);
                        const items = Array.isArray(parsed) ? parsed : parsed.items;
                        if (Array.isArray(items)) return widget.value;
                    } catch (_) { }
                }
                return readConnectedJson(origin, visited);
            };

            const calculateAndLockSize = () => {
                if (autoGuessWidget.value) {
                    let maxX = 0,
                        maxY = 0;
                    let hasItems = false;
                    const connectedJson = readConnectedJson(node);
                    const jsonValue = connectedJson || jsonWidget.value;
                    try {
                        const parsed = JSON.parse(jsonValue);
                        const items = Array.isArray(parsed) ? parsed : parsed.items || [];
                        for (let item of items) {
                            if (item.bbox && item.bbox.length === 4) {
                                hasItems = true;
                                let [ymin, xmin, ymax, xmax] = item.bbox;
                                maxY = Math.max(maxY, Math.abs(ymin), Math.abs(ymax));
                                maxX = Math.max(maxX, Math.abs(xmin), Math.abs(xmax));
                            }
                        }
                    } catch (e) { }

                    const inputSlot = node.inputs?.find((item) => item.name === "layout_json");
                    const hasUpstream = Boolean(inputSlot?.link);
                    if (!hasItems && hasUpstream) {
                        oldWWidget.disabled = true;
                        oldHWidget.disabled = true;
                        if (node.graph) node.graph.setDirtyCanvas(true, true);
                        return;
                    }

                    let guessW = maxX * 2;
                    let guessH = maxY * 2;

                    const ratioStr = ratioWidget.value;
                    if (ratioStr && ratioStr !== "自动(不限定)") {
                        const [rw, rh] = ratioStr.split(":").map(Number);
                        const targetRatio = rw / rh;
                        const currentRatio = guessH > 0 ? guessW / guessH : 1;
                        if (currentRatio < targetRatio) {
                            guessW = guessH * targetRatio;
                        } else {
                            guessH = guessW / targetRatio;
                        }
                    }

                    guessW = Math.max(64, Math.ceil(guessW / 16) * 16);
                    guessH = Math.max(64, Math.ceil(guessH / 16) * 16);

                    oldWWidget.value = guessW;
                    oldHWidget.value = guessH;
                }

                // 无论是否开启猜测，只要猜测开启，输入框就变灰
                oldWWidget.disabled = autoGuessWidget.value;
                oldHWidget.disabled = autoGuessWidget.value;

                if (node.graph) node.graph.setDirtyCanvas(true, true);
            };
            node._mossCalculateAndLockSize = calculateAndLockSize;

            // 监听输入变化
            const origJsonCb = jsonWidget.callback;
            jsonWidget.callback = function () {
                if (origJsonCb) origJsonCb.apply(this, arguments);
                calculateAndLockSize();
            };

            const origAutoCb = autoGuessWidget.callback;
            autoGuessWidget.callback = function () {
                if (origAutoCb) origAutoCb.apply(this, arguments);
                calculateAndLockSize();
                updateVisibility();
            };

            const origRatioCb = ratioWidget.callback;
            ratioWidget.callback = function () {
                if (origRatioCb) origRatioCb.apply(this, arguments);
                calculateAndLockSize();
            };

            // 🌟 2. 控制 scale_factor 的隐藏（锁死节点总高度版）
            const originalType = scaleWidget.type;
            const originalComputeSize = scaleWidget.computeSize;

            let lastMode = "";

            const updateVisibility = () => {
                const isFixed = modeWidget.value === "保持固定坐标(不缩放)";

                if (lastMode === modeWidget.value) return;

                // 记录当前节点绝对尺寸
                const currentWidth = node.size[0];
                const currentHeight = node.size[1];

                if (isFixed) {
                    scaleWidget.type = "hidden";
                    scaleWidget.computeSize = () => [0, -4];
                } else {
                    scaleWidget.type = originalType;
                    scaleWidget.computeSize = originalComputeSize;
                }

                lastMode = modeWidget.value;

                // 🌟 核心修复：强制把节点尺寸恢复原样！
                // 这样 ComfyUI 就不会认为节点总高度变了，也就绝对不会去重置 layout_json 的初始高度。
                // 空出来的位置会被 layout_json 自动吸走（输入框会变长一点，手感更好）。
                node.setSize([currentWidth, currentHeight]);

                if (node.graph) node.graph.setDirtyCanvas(true, true);
            };
            const origModeCb2 = modeWidget.callback;
            modeWidget.callback = function () {
                if (origModeCb2) origModeCb2.apply(this, arguments);
                updateVisibility();
            };

            // 加载工作流时恢复状态
            const onConfigure = this.onConfigure;
            this.onConfigure = function (info) {
                const res = onConfigure
                    ? onConfigure.apply(this, arguments)
                    : undefined;
                setTimeout(() => {
                    lastMode = "";
                    calculateAndLockSize();
                    updateVisibility();
                }, 50);
                return res;
            };

            setTimeout(() => {
                calculateAndLockSize();
                updateVisibility();
            }, 50);

            return r;
        };

        const onConnectionsChange = nodeType.prototype.onConnectionsChange;
        nodeType.prototype.onConnectionsChange = function () {
            const r = onConnectionsChange?.apply(this, arguments);
            setTimeout(() => {
                this._mossCalculateAndLockSize?.();
            }, 0);
            return r;
        };
    },
});
