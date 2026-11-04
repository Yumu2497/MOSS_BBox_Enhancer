// ==========================================
// 1.5 JSON 控件下方追加「复制」按钮
// ==========================================
// 这个版本的 ComfyUI 只渲染官方控件类型（自定义画布控件不会被绘制），
// 所以这里用 addWidget("button")，并把它挪到 layout_json 的正下方。
export function attachJsonCopyButtons(node, jsonWidget) {
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
}
