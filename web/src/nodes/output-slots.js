import { app } from "../../../../scripts/app.js";

// 旧版本这两个节点多出过端口（bboxes），工作流里保存的插槽数比现在的定义多。
// ComfyUI 只按索引更新前 N 个名字，多出来的会沿用旧名，看起来就像重复的「边界框」。
// 这里在加载工作流后把多余的插槽裁掉，并把前 N 个名字对齐到当前定义。
const EXPECTED_OUTPUTS = {
    MOSS_JSON_Importer: [
        ["元素数组", "ARRAY"],
        ["主提示词", "STRING"],
        ["完整提示词", "STRING"],
        ["边界框", "ARRAY"],
    ],
    MOSS_BBox_Resizer: [
        ["元素数组", "ARRAY"],
        ["映射后JSON", "STRING"],
        ["目标宽度", "INT"],
        ["目标高度", "INT"],
        ["边界框", "ARRAY"],
    ],
};

function syncOutputs(node, expected) {
    if (!Array.isArray(node.outputs)) return;
    let changed = false;

    while (node.outputs.length > expected.length) {
        const index = node.outputs.length - 1;
        const before = node.outputs.length;
        try {
            node.disconnectOutput(index);
        } catch (_) {
            // 老版本没有这个接口，直接删插槽即可
        }
        try {
            node.removeOutput(index);
        } catch (_) {
            // 交给下面的兜底
        }
        // 防止 removeOutput 静默失败导致死循环
        if (node.outputs.length >= before) node.outputs.pop();
        changed = true;
    }

    expected.forEach(([name, type], index) => {
        const slot = node.outputs[index];
        if (!slot) {
            node.addOutput(name, type);
            changed = true;
            return;
        }
        if (slot.name !== name) {
            slot.name = name;
            changed = true;
        }
        if (slot.label) {
            slot.label = "";
            changed = true;
        }
        if (slot.type !== type) {
            slot.type = type;
            changed = true;
        }
    });

    if (changed) node.setDirtyCanvas?.(true, false);
}

function syncNode(node) {
    const expected = EXPECTED_OUTPUTS[node?.comfyClass || node?.type];
    if (expected) syncOutputs(node, expected);
}

export const outputSlotsExtension = {
    name: "MOSS.OutputSlots.Repair",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        const expected = EXPECTED_OUTPUTS[nodeData.name];
        if (!expected) return;

        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const result = onConfigure?.apply(this, arguments);
            syncOutputs(this, expected);
            // 部分版本在 onConfigure 之后才按节点定义补插槽，下一帧再对一次
            setTimeout(() => syncOutputs(this, expected), 0);
            return result;
        };
    },
    setup() {
        app.graph?._nodes?.forEach(syncNode);
    },
};

export function registerOutputSlots() {
    return app.registerExtension(outputSlotsExtension);
}
