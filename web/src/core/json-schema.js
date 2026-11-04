// ==========================================
// 0. JSON 规范化（对齐官方 schema）
// ==========================================
//   · 编辑器内部字段（_align 等）不落盘
//   · tags / palette 为空数组时，整个字段删除
//   · text 字段只属于 label === "text" 的条目
// 所有写回 layout_json 的路径都必须经过这里。

export function sanitizeItemForJson(item) {
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

export function serializeLayout(data) {
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
export function normalizeLayoutSchema(data, fallbackW, fallbackH) {
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

