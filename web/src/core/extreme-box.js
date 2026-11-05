// 极小框的视觉代理范围：真实 bbox 小于网格时，画布上按一个网格大小显示，
// 并记录对齐方式（中心 / 四角）。纯几何，不依赖 DOM。

// 获取视觉上的代理范围（边长 = 当前网格尺寸：16 或 32）
export function getVisualBounds(item, grid) {
    const [ymin, xmin, ymax, xmax] = item.bbox;
    const realW = xmax - xmin;
    const realH = ymax - ymin;
    const T = grid;
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
}

// 将视觉范围反向映射回真实数据
export function applyVisualBounds(item, vXmin, vYmin, grid) {
    const [ymin, xmin, ymax, xmax] = item.bbox;
    const realW = xmax - xmin;
    const realH = ymax - ymin;
    const T = grid;
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
}
