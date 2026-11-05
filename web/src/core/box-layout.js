// 边界框布局计算。
// 这里只处理 bbox 数组和普通对象，不依赖 DOM、ComfyUI 或编辑器状态。

export function getItemsBounds(items) {
    const boxes = (Array.isArray(items) ? items : [])
        .map((item) => item?.bbox)
        .filter((bbox) => Array.isArray(bbox) && bbox.length >= 4);
    if (!boxes.length) return null;
    return {
        xmin: Math.min(...boxes.map((bbox) => bbox[1])),
        xmax: Math.max(...boxes.map((bbox) => bbox[3])),
        ymin: Math.min(...boxes.map((bbox) => bbox[0])),
        ymax: Math.max(...boxes.map((bbox) => bbox[2])),
    };
}

// 将一组框对齐到给定包围盒。函数原地更新 item.bbox，返回实际更新数量。
export function alignItems(items, mode, base) {
    if (!Array.isArray(items) || !base) return 0;
    const cx = (base.xmin + base.xmax) / 2;
    const cy = (base.ymin + base.ymax) / 2;
    let changed = 0;

    items.forEach((item) => {
        if (!item || !Array.isArray(item.bbox) || item.bbox.length < 4) return;
        const [ymin, xmin, ymax, xmax] = item.bbox;
        const width = xmax - xmin;
        const height = ymax - ymin;
        let next = null;
        if (mode === "left") next = [ymin, Math.round(base.xmin), ymax, Math.round(base.xmin + width)];
        else if (mode === "right") next = [ymin, Math.round(base.xmax - width), ymax, Math.round(base.xmax)];
        else if (mode === "centerH") next = [ymin, Math.round(cx - width / 2), ymax, Math.round(cx + width / 2)];
        else if (mode === "top") next = [Math.round(base.ymin), xmin, Math.round(base.ymin + height), xmax];
        else if (mode === "bottom") next = [Math.round(base.ymax - height), xmin, Math.round(base.ymax), xmax];
        else if (mode === "centerV") next = [Math.round(cy - height / 2), xmin, Math.round(cy + height / 2), xmax];
        if (next) {
            item.bbox = next;
            changed += 1;
        }
    });
    return changed;
}

// 首尾不动，中间按框与框之间的空隙等距排列。
export function distributeItems(items, axis) {
    if (!Array.isArray(items) || items.length < 3) return 0;
    const isX = axis === "x";
    const startOf = (item) => (isX ? item.bbox[1] : item.bbox[0]);
    const sizeOf = (item) => (isX ? item.bbox[3] - item.bbox[1] : item.bbox[2] - item.bbox[0]);
    const ordered = items
        .filter((item) => item && Array.isArray(item.bbox) && item.bbox.length >= 4)
        .slice()
        .sort((a, b) => startOf(a) - startOf(b));
    if (ordered.length < 3) return 0;

    const spanStart = startOf(ordered[0]);
    const lastItem = ordered[ordered.length - 1];
    const spanEnd = startOf(lastItem) + sizeOf(lastItem);
    const totalSize = ordered.reduce((sum, item) => sum + sizeOf(item), 0);
    const gap = (spanEnd - spanStart - totalSize) / (ordered.length - 1);

    let cursor = spanStart + sizeOf(ordered[0]) + gap;
    for (let i = 1; i < ordered.length - 1; i += 1) {
        const item = ordered[i];
        const size = sizeOf(item);
        if (isX) item.bbox = [item.bbox[0], Math.round(cursor), item.bbox[2], Math.round(cursor + size)];
        else item.bbox = [Math.round(cursor), item.bbox[1], Math.round(cursor + size), item.bbox[3]];
        cursor += size + gap;
    }
    return ordered.length - 2;
}
