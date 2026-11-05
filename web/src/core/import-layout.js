import { serializeLayout } from "./json-schema.js";

// ==========================================
// 图片提示词导入：三种范围的结果计算
// ==========================================
//   full   = 主提示词 + bbox + 布局，覆盖当前内容
//   prompt = 只改 summary.caption，保留现有 bbox 与画布尺寸
//   layout = 只换 items / 坐标格式 / 画布尺寸，保留现有主提示词
// 这里只做纯数据计算，不碰 DOM，方便单独验证。

const EMPTY_LAYOUT = () => ({
    summary: { caption: "" },
    items: [],
    bbox_coord_space: "abs_centralized",
    bbox_format: "yxyx",
});

const asObject = (value) =>
    value && typeof value === "object" && !Array.isArray(value) ? value : null;

const summaryOf = (layout) => {
    const summary = asObject(layout) && layout.summary;
    return asObject(summary) || { caption: "" };
};

// 当前画布里的内容；纯文本按主提示词处理，和面板的容错保持一致
export function readLayoutValue(rawValue) {
    const raw = String(rawValue || "").trim();
    if (!raw) return EMPTY_LAYOUT();
    try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return { ...EMPTY_LAYOUT(), items: parsed };
        if (asObject(parsed)) return parsed;
    } catch (_) { /* 落到下面的纯文本分支 */ }
    return { ...EMPTY_LAYOUT(), summary: { caption: raw } };
}

const parseMossJson = (raw) => {
    try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) || asObject(parsed)) return parsed;
    } catch (_) { /* 交给调用方提示 */ }
    return null;
};

const officialBoxesToItems = (boxData) => {
    const W = boxData.w, H = boxData.h;
    const halfW = W / 2, halfH = H / 2;
    return boxData.boxes.map((box) => {
        const item = {
            label: box.metadata?.type === "text" ? "text" : "object",
            caption: box.metadata?.desc || "",
            bbox: [
                box.y - halfH,
                box.x - halfW,
                box.y - halfH + box.height,
                box.x - halfW + box.width,
            ],
        };
        if (box.metadata?.text) item.text = box.metadata.text;
        if (box.metadata?.palette && box.metadata.palette.length > 0) item.palette = box.metadata.palette;
        return item;
    });
};

/**
 * @returns {{value: string, width?: number, height?: number, message: string} | {error: string}}
 */
export function buildLayoutImport({ flow, mode = "full", currentValue = "" } = {}) {
    const mosses = Array.isArray(flow && flow.moss_jsons) ? flow.moss_jsons : [];
    const boxFlows = Array.isArray(flow && flow.official_boxes) ? flow.official_boxes : [];
    const texts = Array.isArray(flow && flow.texts) ? flow.texts : [];

    // ---- 自制节点：本身带完整布局 JSON ----
    if (mosses.length > 0) {
        const moss = mosses[0];
        if (mode === "full") {
            return {
                value: moss.json,
                width: moss.w,
                height: moss.h,
                message: `✅ 成功导入完整提示词与布局！\n尺寸: ${moss.w} x ${moss.h}`,
            };
        }

        const src = parseMossJson(moss.json);
        if (mode === "prompt") {
            const srcCaption = asObject(src) ? String(summaryOf(src).caption || "") : "";
            const caption = srcCaption || texts[0] || "";
            if (!caption.trim()) return { error: "⚠️ 这组流程里没有找到可导入的主提示词。" };
            const layout = readLayoutValue(currentValue);
            layout.summary = { ...summaryOf(layout), caption };
            return {
                value: serializeLayout(layout),
                message: "✅ 已导入主提示词，现有 bbox 与画布尺寸保持不变。",
            };
        }

        if (!src) return { error: "❌ 这条 MOSS JSON 解析失败，无法只导入布局。" };
        const layout = readLayoutValue(currentValue);
        const summary = summaryOf(layout);
        // 摆在前面展开后，summary 用当前画布的，主提示词与画布模式都不动
        const merged = Array.isArray(src)
            ? { ...EMPTY_LAYOUT(), summary, items: src }
            : { ...src, summary };
        const count = Array.isArray(merged.items) ? merged.items.length : 0;
        return {
            value: serializeLayout(merged),
            width: moss.w,
            height: moss.h,
            message: `✅ 已导入 ${count} 个框与布局，主提示词保持不变。\n尺寸: ${moss.w} x ${moss.h}`,
        };
    }

    // ---- 官方 CreateBoundingBoxes：需要把左上角坐标换成中心原点 ----
    if (boxFlows.length > 0) {
        const boxData = boxFlows[0];
        const W = boxData.w, H = boxData.h;
        const items = officialBoxesToItems(boxData);

        if (mode === "prompt") {
            const caption = texts[0] || "";
            if (!caption.trim()) return { error: "⚠️ 这组流程里没有找到可导入的主提示词。" };
            const layout = readLayoutValue(currentValue);
            layout.summary = { ...summaryOf(layout), caption };
            return {
                value: serializeLayout(layout),
                message: "✅ 已导入主提示词，现有 bbox 与画布尺寸保持不变。",
            };
        }

        const layout = readLayoutValue(currentValue);
        const summary = mode === "layout"
            ? summaryOf(layout)
            : { caption: texts.length > 0 ? texts[0] : "" };
        const finalJson = {
            summary,
            items,
            bbox_coord_space: "abs_centralized",
            bbox_format: "yxyx",
        };
        return {
            value: serializeLayout(finalJson),
            width: W,
            height: H,
            message: mode === "layout"
                ? `✅ 已导入 ${items.length} 个框与布局，主提示词保持不变。\n尺寸: ${W} x ${H}`
                : `✅ 已将官方边界框转换为 MOSS JSON 并导入！\n尺寸: ${W} x ${H}`,
        };
    }

    // ---- 只有文本提示词 ----
    if (texts.length > 0) {
        if (mode === "layout") {
            return { error: "⚠️ 这组流程里没有边界框数据，只有文本提示词，无法只导入布局。" };
        }
        const allTexts = texts.join("\n\n");
        if (mode === "prompt") {
            const layout = readLayoutValue(currentValue);
            layout.summary = { ...summaryOf(layout), caption: allTexts };
            return {
                value: serializeLayout(layout),
                message: "✅ 已导入主提示词，现有 bbox 与画布尺寸保持不变。",
            };
        }
        return {
            value: JSON.stringify({
                summary: { caption: allTexts },
                items: [],
                bbox_coord_space: "abs_centralized",
                bbox_format: "yxyx",
            }, null, 2),
            message: "✅ 未找到边界框数据，但已为您提取并填入纯文本提示词。",
        };
    }

    return { error: "⚠️ 这个流程里没有可导入的内容。" };
}
