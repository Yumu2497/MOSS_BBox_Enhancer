// 分辨率选择器控件：节点上和浮动面板右栏共用同一套 DOM 与状态。
// 状态存在 node.properties.mossResolution，两个实例通过一个轻量 store 同步。

import {
    RATIO_PRESETS,
    MULTIPLES,
    normalizeState,
    computeSize,
    reduceRatio,
    formatResolution,
    formatMegapixels,
    inferFromSize,
} from "../core/resolution.js";
import { createRow, createLabel, createSelect, createInput } from "./kit.js";

const stores = new WeakMap();

function getStore(node) {
    let store = stores.get(node);
    if (!store) {
        const saved = node?.properties?.mossResolution;
        store = { state: normalizeState(saved), listeners: new Set() };
        stores.set(node, store);
    }
    return store;
}

export function getResolutionState(node) {
    return { ...getStore(node).state };
}

export function onResolutionChange(node, listener) {
    const store = getStore(node);
    store.listeners.add(listener);
    return () => store.listeners.delete(listener);
}

function commit(node, patch, origin) {
    const store = getStore(node);
    store.state = normalizeState({ ...store.state, ...patch });
    if (node) {
        node.properties = node.properties || {};
        node.properties.mossResolution = { ...store.state };
    }
    store.listeners.forEach((fn) => {
        if (fn !== origin) fn(store.state);
    });
    return store.state;
}

// 外部改了 canvas_width / canvas_height（手动拖 widget、图片覆盖），
// 或节点原生 widget 改了参数后，让面板实例重读状态与尺寸
export function refreshResolutionUI(node) {
    const store = getStore(node);
    // properties 可能已被节点侧写入，先把 store 对齐，否则面板会拿旧值重绘
    store.state = normalizeState(node?.properties?.mossResolution);
    store.listeners.forEach((fn) => fn(store.state, { external: true }));
}

/**
 * 创建一个分辨率选择器。
 * @param {object} opts
 * @param {object} opts.node           节点（读写 properties）
 * @param {() => {width:number,height:number}} opts.getSize  读当前宽高
 * @param {(size:{width:number,height:number}) => void} opts.applySize 写回宽高
 * @param {boolean} [opts.compact]     节点上的紧凑版
 */
export function createResolutionControl({ node, getSize, applySize, persist, compact = false, flat = false }) {
    const el = document.createElement("div");
    el.className = "moss-resolution";
    el.style.cssText = [
        "display: flex; flex-direction: column; gap: 6px; width: 100%; box-sizing: border-box;",
        flat
            ? ""
            : "padding: 8px; border: 1px solid var(--moss-border); border-radius: var(--moss-radius); background: var(--moss-bg-raised);",
        "color: var(--moss-text-dim); font-size: var(--moss-font-sm);",
    ].join(" ");

    let state = getStore(node).state;

    // ---- 标题 ----
    if (!flat) {
        const title = document.createElement("div");
        title.textContent = "🖼 分辨率";
        title.style.cssText =
            "font-size: 11px; font-weight: bold; color: var(--moss-text-dim); border-bottom: 1px solid var(--moss-divider); padding-bottom: 3px;";
        el.appendChild(title);
    }

    // ---- 图片尺寸覆盖提示 ----
    const hint = document.createElement("div");
    hint.style.cssText = "color: var(--moss-text-muted); font-size: 10px; line-height: 1.4; display: none;";
    hint.textContent = "执行时会被图片尺寸覆盖";
    el.appendChild(hint);

    const refreshHint = () => {
        const useImage = node?.widgets?.find((w) => w.name === "use_image_size")?.value;
        const hasImage = node?.inputs?.find((i) => i.name === "image")?.link != null;
        hint.style.display = useImage && hasImage ? "block" : "none";
    };

    // ---- 模式 ----
    const modeRow = createRow([createLabel("方式")]);
    const modeSelect = createSelect([
        { value: "manual", label: "手动输入" },
        { value: "pixels", label: "按像素" },
        { value: "ratio", label: "按比例" },
    ]);
    modeSelect.style.flex = "1 1 auto";
    modeRow.appendChild(modeSelect);
    el.appendChild(modeRow);

    // ---- 比例 ----
    const ratioLabel = createLabel("宽高比");
    const ratioRow = createRow([ratioLabel]);
    const ratioSelect = createSelect([
        ...RATIO_PRESETS.map((r) => ({ value: `${r.w}:${r.h}`, label: `${r.label}` })),
        { value: "custom", label: "自定义" },
    ]);
    ratioSelect.style.flex = "1 1 auto";
    const customW = createInput({ type: "number", value: 1, min: 1, max: 999, step: 1, width: 48 });
    const customH = createInput({ type: "number", value: 1, min: 1, max: 999, step: 1, width: 48 });
    const customColon = createLabel(":");
    const customWrap = document.createElement("span");
    customWrap.style.cssText = "display: none; align-items: center; gap: 3px;";
    customWrap.appendChild(customW);
    customWrap.appendChild(customColon);
    customWrap.appendChild(customH);
    ratioRow.appendChild(ratioSelect);
    ratioRow.appendChild(customWrap);
    el.appendChild(ratioRow);

    // ---- 参数：手动宽高 ----
    const manualRow = createRow([createLabel("宽")]);
    const manualW = createInput({ type: "number", value: 1024, min: 64, max: 16384, step: 8, width: 68 });
    const manualH = createInput({ type: "number", value: 1024, min: 64, max: 16384, step: 8, width: 68 });
    manualRow.appendChild(manualW);
    manualRow.appendChild(createLabel("高"));
    manualRow.appendChild(manualH);
    el.appendChild(manualRow);

    // ---- 参数：百万像素 ----
    const pixelsRow = createRow([createLabel("百万像素")]);
    const mpInput = createInput({ type: "number", value: 1, min: 0.01, max: 16, step: 0.1, width: 72 });
    pixelsRow.appendChild(mpInput);
    pixelsRow.appendChild(createLabel("MP"));
    el.appendChild(pixelsRow);

    // ---- 参数：按比例基准 ----
    const baseRow = createRow([createLabel("基准")]);
    const baseSelect = createSelect([
        { value: "width", label: "宽" },
        { value: "height", label: "高" },
        { value: "long", label: "长边" },
    ]);
    baseSelect.style.width = "58px";
    const baseValueInput = createInput({ type: "number", value: 1024, min: 64, max: 16384, step: 8, width: 68 });
    baseRow.appendChild(baseSelect);
    baseRow.appendChild(baseValueInput);
    el.appendChild(baseRow);

    // ---- 倍数 ----
    const multipleRow = createRow([createLabel("倍数")]);
    const multipleSelect = createSelect(MULTIPLES.map((m) => ({ value: m, label: String(m) })));
    multipleSelect.style.width = "58px";
    multipleRow.appendChild(multipleSelect);
    el.appendChild(multipleRow);

    // ---- 结果 ----
    const result = document.createElement("div");
    result.className = "moss-readout";
    el.appendChild(result);

    // ---- 渲染与写回 ----
    const currentSize = () => {
        const size = getSize() || {};
        return {
            width: Math.max(1, Math.round(Number(size.width) || 1024)),
            height: Math.max(1, Math.round(Number(size.height) || 1024)),
        };
    };

    const paint = () => {
        state = getStore(node).state;
        modeSelect.value = state.mode;
        ratioSelect.value = RATIO_PRESETS.some((r) => r.w === state.ratioW && r.h === state.ratioH)
            ? `${state.ratioW}:${state.ratioH}`
            : "custom";
        customWrap.style.display =
            ratioSelect.value === "custom" && state.mode !== "manual" ? "inline-flex" : "none";
        ratioSelect.style.display = state.mode === "manual" ? "none" : "";
        ratioLabel.style.display = state.mode === "manual" ? "none" : "";
        manualRow.style.display = state.mode === "manual" ? "flex" : "none";
        pixelsRow.style.display = state.mode === "pixels" ? "flex" : "none";
        baseRow.style.display = state.mode === "ratio" ? "flex" : "none";
        multipleRow.style.display = state.mode === "manual" ? "none" : "flex";

        if (document.activeElement !== customW) customW.value = String(state.ratioW);
        if (document.activeElement !== customH) customH.value = String(state.ratioH);
        if (document.activeElement !== mpInput) mpInput.value = String(state.megapixels);
        if (document.activeElement !== baseValueInput) baseValueInput.value = String(state.baseValue);
        baseSelect.value = state.base;
        multipleSelect.value = String(state.multiple);

        const size = currentSize();
        if (document.activeElement !== manualW) manualW.value = String(size.width);
        if (document.activeElement !== manualH) manualH.value = String(size.height);
        result.textContent = `${formatResolution(size.width, size.height)} · ${formatMegapixels(
            size.width,
            size.height
        )}`;
    };

    const apply = (size) => {
        if (!size) return;
        applySize(size);
        result.textContent = `${formatResolution(size.width, size.height)} · ${formatMegapixels(
            size.width,
            size.height
        )}`;
    };

    // 只写状态；needsApply 时按新模式算完写回
    const save = (patch, needsApply) => {
        state = commit(node, patch, onChange);
        // 节点上的原生 widget 是后端执行的权威数据，面板改动要同步过去
        persist?.(state);
        paint();
        if (needsApply) {
            const size = computeSize(state);
            if (size) apply(size);
        }
    };

    function onChange(next, meta) {
        state = next;
        paint();
        if (meta?.external) refreshHint();
    }

    modeSelect.onchange = () => {
        const mode = modeSelect.value;
        const size = currentSize();
        const guess = inferFromSize(size.width, size.height);
        const patch = { mode };
        if (mode !== "manual") {
            patch.ratioW = guess.ratioW;
            patch.ratioH = guess.ratioH;
            patch.megapixels = guess.megapixels;
            patch.baseValue = guess.baseValue;
        }
        save(patch, mode !== "manual");
        refreshHint();
    };

    ratioSelect.onchange = () => {
        if (ratioSelect.value === "custom") {
            customWrap.style.display = "inline-flex";
            return;
        }
        const [w, h] = ratioSelect.value.split(":").map(Number);
        save({ ratioW: w, ratioH: h }, true);
    };

    const onCustomRatio = () => {
        const ratio = reduceRatio(Number(customW.value) || 1, Number(customH.value) || 1);
        save({ ratioW: ratio.w, ratioH: ratio.h }, true);
    };
    customW.oninput = onCustomRatio;
    customH.oninput = onCustomRatio;
    customW.onblur = () => {
        const ratio = reduceRatio(Number(customW.value) || 1, Number(customH.value) || 1);
        customW.value = String(ratio.w);
        customH.value = String(ratio.h);
    };

    mpInput.oninput = () => {
        const mp = Number(mpInput.value);
        if (!Number.isFinite(mp) || mp <= 0) return;
        save({ megapixels: Math.min(16, Math.max(0.01, mp)) }, true);
    };

    baseSelect.onchange = () => save({ base: baseSelect.value }, true);
    baseValueInput.oninput = () => {
        const v = Number(baseValueInput.value);
        if (!Number.isFinite(v) || v <= 0) return;
        save({ baseValue: v }, true);
    };
    multipleSelect.onchange = () => save({ multiple: Number(multipleSelect.value) }, true);

    const onManualSize = () => {
        const width = Math.round(Number(manualW.value));
        const height = Math.round(Number(manualH.value));
        if (!Number.isFinite(width) || !Number.isFinite(height)) return;
        apply({ width, height });
    };
    manualW.oninput = onManualSize;
    manualH.oninput = onManualSize;

    // 外部（另一个实例 / 手动拖 widget）变化时重新渲染
    const unsubscribe = onResolutionChange(node, (next, meta) => onChange(next, meta));

    paint();
    refreshHint();
    // 上次保存的是「按像素 / 按比例」时，打开工作流后按参数还原一次尺寸
    if (state.mode !== "manual") {
        const target = computeSize(state);
        if (target) apply(target);
    }

    return {
        el,
        destroy() {
            unsubscribe();
            el.remove();
        },
        refresh: () => {
            refreshHint();
            paint();
        },
        getState: () => ({ ...state }),
    };
}

// 给节点上的 canvas_width / canvas_height 包一层回调：手动改尺寸后让两个控件跟上
export function watchWidgetSize(node) {
    if (!node || node._mossResolutionWatch) return;
    const wWidget = node.widgets?.find((w) => w.name === "canvas_width");
    const hWidget = node.widgets?.find((w) => w.name === "canvas_height");
    if (!wWidget || !hWidget) return;
    node._mossResolutionWatch = true;
    const wrap = (widget) => {
        const original = widget.callback;
        widget.callback = function () {
            const r = original ? original.apply(this, arguments) : undefined;
            refreshResolutionUI(node);
            return r;
        };
    };
    wrap(wWidget);
    wrap(hWidget);
}

