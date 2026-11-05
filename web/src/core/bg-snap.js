// 背景图吸附的几何计算（纯函数，方便单测；不碰 DOM 与画布）。

// 平移：拿起始边 / 中心 / 结束边三个锚点去比目标线，取位移最小的那一组。
// 返回值带上命中的目标线，画布据此画虚线；没吸附上时 target 为 null。
export function snapAxisWithAnchors(pos, size, targets, threshold) {
    const anchors = [pos - size / 2, pos, pos + size / 2];
    let best = null;
    for (const anchor of anchors) {
        for (const target of targets) {
            const delta = target - anchor;
            if (Math.abs(delta) <= threshold && (best === null || Math.abs(delta) < Math.abs(best.delta))) {
                best = { delta, target };
            }
        }
    }
    return best ? { pos: pos + best.delta, target: best.target } : { pos, target: null };
}

// 拉伸：只比较被拖的那条边。
export function snapEdgeToTargets(value, targets, threshold) {
    let best = null;
    for (const target of targets) {
        const distance = Math.abs(target - value);
        if (distance <= threshold && (best === null || distance < Math.abs(best - value))) {
            best = target;
        }
    }
    return best === null ? { value, target: null } : { value: best, target: best };
}

// 长宽比联动会把刚吸附好的边再推开一点，所以按最终位置复查一次：
// 还在目标线上（默认 0.5 逻辑像素内）才算吸附成功，用来决定画不画虚线。
export function matchTarget(value, targets, tolerance = 0.5) {
    const hit = targets.find((target) => Math.abs(target - value) <= tolerance);
    return hit === undefined ? null : hit;
}
