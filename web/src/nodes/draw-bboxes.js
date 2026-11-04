import { app } from "../../../../scripts/app.js";

// 绘制节点只在前端改显示名，输入 key 保持不变，老工作流与新工作流都按原 key 取值
const WIDGET_LABELS = {
    line_width: "线宽",
    show_index: "显示序号",
    show_label: "显示描述",
    fallback_color: "兜底颜色",
};

const INPUT_LABELS = {
    bboxes: "边界框",
};

const OUTPUT_LABELS = {
    图像: "图像",
};

function isDrawNode(node) {
    return (node?.comfyClass || node?.type) === "MOSS_DrawBBoxes";
}

function applyChineseLabels(node) {
    if (!isDrawNode(node)) return;

    node.widgets?.forEach((widget) => {
        const label = WIDGET_LABELS[widget.name];
        if (label && widget.label !== label) widget.label = label;
    });

    node.inputs?.forEach((input) => {
        const label = INPUT_LABELS[input.name];
        if (label && input.label !== label) input.label = label;
    });

    node.outputs?.forEach((output) => {
        const label = OUTPUT_LABELS[output.name];
        if (label && output.label !== label) output.label = label;
    });

    node.setDirtyCanvas?.(true, false);
}

export const drawBBoxesNodeExtension = {
    name: "MOSS.DrawBBoxes.Chinese",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "MOSS_DrawBBoxes") return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = onNodeCreated?.apply(this, arguments);
            applyChineseLabels(this);
            // 少数版本在 onNodeCreated 之后才补建控件，下一帧再刷一次
            setTimeout(() => applyChineseLabels(this), 0);
            return result;
        };

        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const result = onConfigure?.apply(this, arguments);
            applyChineseLabels(this);
            return result;
        };
    },
    setup() {
        app.graph?._nodes?.forEach(applyChineseLabels);
    },
};

export function registerDrawBBoxes() {
    return app.registerExtension(drawBBoxesNodeExtension);
}
