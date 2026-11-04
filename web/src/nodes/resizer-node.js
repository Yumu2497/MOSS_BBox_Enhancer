import { app } from "../../../../scripts/app.js";

export const resizerNodeExtension = {
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
};

export function registerResizerNode() {
    return app.registerExtension(resizerNodeExtension);
}
