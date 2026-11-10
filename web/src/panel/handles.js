/**
 * 矩形 8 个控制点的命中判定与光标映射。
 *
 * 深度图层（depth-editor）和背景图裁剪（floating-panel）都用这一套：
 * 四角 tl/tr/bl/br + 四边中点 t/b/l/r，框内为 move。
 * 两边的坐标系不同（图层是画布像素、背景图是逻辑坐标 + 视图缩放），
 * 所以这里只统一「命中 → 光标」，拖动和限幅仍留在各自模块里。
 */

export const HANDLE_CURSOR = {
    tl: "nwse-resize",
    br: "nwse-resize",
    tr: "nesw-resize",
    bl: "nesw-resize",
    t: "ns-resize",
    b: "ns-resize",
    l: "ew-resize",
    r: "ew-resize",
    move: "move",
};

/** 命中结果转 CSS cursor；没命中就返回 fallback */
export function cursorForHit(hit, fallback = "default") {
    return HANDLE_CURSOR[hit] || fallback;
}

/**
 * 点是否落在矩形的 8 个控制点上（返回 tl/tr/bl/br/t/b/l/r），否则落在框内返回 move。
 * 用「点距离」而不是整条边带：和画出来的 8 个小方块一一对应，不会出现「明明没对着点却能拖」。
 */
export function hitRect(x1, y1, x2, y2, px, py, tol = 8) {
    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2;
    const points = [
        ["tl", x1, y1],
        ["t", mx, y1],
        ["tr", x2, y1],
        ["l", x1, my],
        ["r", x2, my],
        ["bl", x1, y2],
        ["b", mx, y2],
        ["br", x2, y2],
    ];
    for (const [name, hx, hy] of points) {
        if (Math.abs(px - hx) <= tol && Math.abs(py - hy) <= tol) return name;
    }
    if (px > x1 && px < x2 && py > y1 && py < y2) return "move";
    return null;
}
