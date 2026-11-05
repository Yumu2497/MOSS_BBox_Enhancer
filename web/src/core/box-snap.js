// 框吸附计算：网格 / 边对齐 / 等距。纯几何，不依赖 DOM 或编辑器状态。
// 调用方负责缓存 targets，并把 mode、缩放、网格尺寸作为参数传进来。

// 其他框之间已有的间距，供等距吸附复用
export function collectGaps(boxes, axis) {
    const out = [];
    for (let i = 0; i < boxes.length; i++) {
        for (let j = 0; j < boxes.length; j++) {
            if (i === j) continue;
            const a = boxes[i];
            const b = boxes[j];
            if (axis === "x") {
                if (a.xmax > b.xmin) continue;
                if (!(a.ymin < b.ymax && b.ymin < a.ymax)) continue;
                out.push(b.xmin - a.xmax);
            } else {
                if (a.ymax > b.ymin) continue;
                if (!(a.xmin < b.xmax && b.xmin < a.xmax)) continue;
                out.push(b.ymin - a.ymax);
            }
        }
    }
    // 相同间距只留一份，避免框多时列表膨胀
    return [...new Set(out.filter((g) => g > 0).map((g) => Math.round(g * 100) / 100))];
}

// 候选线：画布左中右 / 上中下，加上其他框的三条竖线、三条横线
export function buildSnapTargets({ items, canvasW, canvasH, exclude }) {
    const xs = [-canvasW / 2, 0, canvasW / 2];
    const ys = [-canvasH / 2, 0, canvasH / 2];
    const skip = exclude instanceof Set
        ? exclude
        : new Set(exclude == null ? [] : [exclude]);
    const boxes = [];
    (items || []).forEach((item, i) => {
        if (skip.has(i) || !item || !Array.isArray(item.bbox)) return;
        const [ymin, xmin, ymax, xmax] = item.bbox;
        xs.push(xmin, (xmin + xmax) / 2, xmax);
        ys.push(ymin, (ymin + ymax) / 2, ymax);
        boxes.push({ xmin, xmax, ymin, ymax });
    });
    return { xs, ys, boxes, gapsX: collectGaps(boxes, "x"), gapsY: collectGaps(boxes, "y") };
}

// 把当前框的边 / 中线与其他框、画布对齐，返回最近命中
export function nearestSnap(edges, targets, tol) {
    let best = null;
    edges.forEach((edge) => {
        targets.forEach((t) => {
            const d = t - edge;
            if (Math.abs(d) <= tol && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, pos: t };
        });
    });
    return best;
}

// 等距吸附：夹在两框之间取等距，或与邻居保持其他框之间已有的间距
export function snapSpacing(rect, axis, targets, tol) {
    const boxes = targets.boxes;
    if (!boxes.length) return null;

    const isX = axis === "x";
    const start = isX ? rect.x : rect.y;
    const size = isX ? rect.w : rect.h;
    const end = start + size;
    const crossStart = isX ? rect.y : rect.x;
    const crossEnd = isX ? rect.y + rect.h : rect.x + rect.w;

    let near = null;
    let far = null;
    boxes.forEach((b) => {
        const bStart = isX ? b.xmin : b.ymin;
        const bEnd = isX ? b.xmax : b.ymax;
        const bCrossStart = isX ? b.ymin : b.xmin;
        const bCrossEnd = isX ? b.ymax : b.xmax;
        if (!(bCrossStart < crossEnd && crossStart < bCrossEnd)) return;
        if (bEnd <= start) {
            if (!near || bEnd > (isX ? near.xmax : near.ymax)) near = b;
        } else if (bStart >= end) {
            if (!far || bStart < (isX ? far.xmin : far.ymin)) far = b;
        }
    });

    const nearEnd = near ? (isX ? near.xmax : near.ymax) : null;
    const farStart = far ? (isX ? far.xmin : far.ymin) : null;
    const at = (crossStart + crossEnd) / 2;

    // 规则一：左右两边都挨着框，让两个间距相等
    if (near && far) {
        const free = farStart - nearEnd;
        if (free > size) {
            const gap = (free - size) / 2;
            const target = nearEnd + gap;
            if (Math.abs(target - start) <= tol) {
                return {
                    delta: target - start,
                    guides: [
                        { type: "spacing", axis, from: nearEnd, to: target, at, gap },
                        { type: "spacing", axis, from: target + size, to: farStart, at, gap },
                    ],
                };
            }
        }
    }

    // 规则二：贴着某个框时，间距等于其他框之间已有的某个间距
    const gaps = isX ? targets.gapsX : targets.gapsY;
    let best = null;
    gaps.forEach((gap) => {
        if (near) {
            const target = nearEnd + gap;
            const d = target - start;
            if (Math.abs(d) <= tol && (!best || Math.abs(d) < Math.abs(best.delta))) {
                best = {
                    delta: d,
                    guides: [{ type: "spacing", axis, from: nearEnd, to: target, at, gap }],
                };
            }
        }
        if (far) {
            const target = farStart - gap - size;
            const d = target - start;
            if (Math.abs(d) <= tol && (!best || Math.abs(d) < Math.abs(best.delta))) {
                best = {
                    delta: d,
                    guides: [{ type: "spacing", axis, from: farStart - gap, to: farStart, at, gap }],
                };
            }
        }
    });
    return best;
}

// 拖动整框时的吸附：返回吸附后的位置与辅助线
export function snapMoveRect(rect, targets, { mode, altKey, grid, scale, snapPx }) {
    if (altKey || mode !== "object" || !targets || !targets.xs.length) {
        return { x: rect.x, y: rect.y, guides: [] };
    }
    const tol = snapPx / scale;

    const xHit = nearestSnap([rect.x, rect.x + rect.w / 2, rect.x + rect.w], targets.xs, tol);
    const yHit = nearestSnap([rect.y, rect.y + rect.h / 2, rect.y + rect.h], targets.ys, tol);
    const xGap = snapSpacing(rect, "x", targets, tol);
    const yGap = snapSpacing(rect, "y", targets, tol);

    // 边对齐与等距同时命中时，取位移更小的那个
    const pick = (hit, gap, axisName) => {
        const edgeD = hit ? hit.d : null;
        const gapD = gap ? gap.delta : null;
        if (edgeD !== null && (gapD === null || Math.abs(edgeD) <= Math.abs(gapD))) {
            return { d: edgeD, guides: [{ axis: axisName, pos: hit.pos }] };
        }
        if (gapD !== null) return { d: gapD, guides: gap.guides };
        return { d: 0, guides: [] };
    };

    const rx = pick(xHit, xGap, "x");
    const ry = pick(yHit, yGap, "y");
    return {
        x: rect.x + rx.d,
        y: rect.y + ry.d,
        guides: [...rx.guides, ...ry.guides],
    };
}

// 拖某一条边 / 角时只吸附这一条线
export function snapEdge(value, axis, targets, { mode, altKey, scale, snapPx }) {
    if (altKey || mode !== "object" || !targets) return { value, guide: null };
    const list = axis === "x" ? targets.xs : targets.ys;
    const hit = nearestSnap([value], list, snapPx / scale);
    return hit ? { value: hit.pos, guide: { axis, pos: hit.pos } } : { value, guide: null };
}

// 网格吸附：以左上角为基准画网格线
export function applyGridSnap(value, { isX, grid, canvasW, canvasH, altKey, mode }) {
    if (!altKey && mode === "grid") {
        const offset = isX ? canvasW / 2 : canvasH / 2;
        return Math.round((value + offset) / grid) * grid - offset;
    }
    return Math.round(value);
}
