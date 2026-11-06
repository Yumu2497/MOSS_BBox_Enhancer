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

const inputStyle =
    "background: #111; color: #eee; border: 1px solid #444; border-radius: 4px; padding: 3px 5px; outline: none; font-size: 11px; box-sizing: border-box;";
const selectStyle =
    "background: #111; color: #eee; border: 1px solid #444; border-radius: 4px; padding: 3px 4px; outline: none; cursor: pointer; font-size: 11px; box-sizing: border-box;";
const labelStyle = "color: #999; font-size: 11px; white-space: nowrap;";
const rowStyle = "display: flex; align-items: center; gap: 6px;";

const makeSelect = (options, style = selectStyle) => {
    const el = document.createElement("select");
    el.style.cssText = style;
    options.forEach((opt) => {
        const o = document.createElement("option");
        o.value = String(opt.value);
        o.textContent = opt.label;
        el.appendChild(o);
    });
    return el;
};

const makeNumber = (value, min, max, step, width = "64px") => {
    const el = document.createElement("input");
    el.type = "number";
    el.value = String(value);
    el.min = String(min);
    el.max = String(max);
    el.step = String(step);
    el.style.cssText = inputStyle + `width: ${width};`;
    return el;
};

/**
 * 创建一个分辨率选择器。
 * @param {object} opts
 * @param {object} opts.node           节点（读写 properties）
 * @param {() => {width:number,height:number}} opts.getSize  读当前宽高
 * @param {(size:{width:number,height:number}) => void} opts.applySize 写回宽高
 * @param {boolean} [opts.compact]     节点上的紧凑版
 */
export function createResolutionControl({ node, getSize, applySize, persist, compact = false }) {
    const el = document.createElement("div");
    el.className = "moss-resolution";
    el.style.cssText = [
        "display: flex; flex-direction: column; gap: 6px;",
        "padding: 8px; border: 1px solid #3a3a3a; border-radius: 6px;",
        "background: #1a1a1a; color: #ddd; font-size: 11px; box-sizing: border-box;",
        compact ? "width: 100%;" : "width: 100%; margin: 0;",
    ].join(" ");

    let state = getStore(node).state;

    // ---- 标题 ----
    const title = document.createElement("div");
    title.textContent = "🖼 分辨率";
    title.style.cssText =
        "font-size: 11px; font-weight: bold; color: #aaa; border-bottom: 1px solid #333; padding-bottom: 3px;";
    el.appendChild(title);

    // ---- 图片尺寸覆盖提示 ----
    const hint = document.createElement("div");
    hint.style.cssText = "color: #8a8a8a; font-size: 10px; line-height: 1.4; display: none;";
    hint.textContent = "执行时会被图片尺寸覆盖";
    el.appendChild(hint);

    const refreshHint = () => {
        const useImage = node?.widgets?.find((w) => w.name === "use_image_size")?.value;
        const hasImage = node?.inputs?.find((i) => i.name === "image")?.link != null;
        hint.style.display = useImage && hasImage ? "block" : "none";
    };

    // ---- 模式 ----
    const modeRow = document.createElement("div");
    modeRow.style.cssText = rowStyle;
    const modeLabel = document.createElement("span");
    modeLabel.textContent = "方式";
    modeLabel.style.cssText = labelStyle;
    const modeSelect = makeSelect(
        [
            { value: "manual", label: "手动输入" },
            { value: "pixels", label: "按像素" },
            { value: "ratio", label: "按比例" },
        ],
        selectStyle + "flex: 1;"
    );
    modeRow.appendChild(modeLabel);
    modeRow.appendChild(modeSelect);
    el.appendChild(modeRow);

    // ---- 比例 ----
    const ratioRow = document.createElement("div");
    ratioRow.style.cssText = rowStyle;
    const ratioLabel = document.createElement("span");
    ratioLabel.textContent = "宽高比";
    ratioLabel.style.cssText = labelStyle;
    const ratioSelect = makeSelect(
        [
            ...RATIO_PRESETS.map((r) => ({ value: `${r.w}:${r.h}`, label: `${r.label}` })),
            { value: "custom", label: "自定义" },
        ],
        selectStyle + "flex: 1;"
    );
    const customW = makeNumber(1, 1, 999, 1, "48px");
    const customH = makeNumber(1, 1, 999, 1, "48px");
    const customColon = document.createElement("span");
    customColon.textContent = ":";
    customColon.style.cssText = labelStyle;
    const customWrap = document.createElement("span");
    customWrap.style.cssText = "display: none; align-items: center; gap: 3px;";
    customWrap.appendChild(customW);
    customWrap.appendChild(customColon);
    customWrap.appendChild(customH);
    ratioRow.appendChild(ratioLabel);
    ratioRow.appendChild(ratioSelect);
    ratioRow.appendChild(customWrap);
    el.appendChild(ratioRow);

    // ---- 参数：手动宽高 ----
    const manualRow = document.createElement("div");
    manualRow.style.cssText = rowStyle;
    const manualWLabel = document.createElement("span");
    manualWLabel.textContent = "宽";
    manualWLabel.style.cssText = labelStyle;
    const manualW = makeNumber(1024, 64, 16384, 8, "68px");
    const manualHLabel = document.createElement("span");
    manualHLabel.textContent = "高";
    manualHLabel.style.cssText = labelStyle;
    const manualH = makeNumber(1024, 64, 16384, 8, "68px");
    manualRow.appendChild(manualWLabel);
    manualRow.appendChild(manualW);
    manualRow.appendChild(manualHLabel);
    manualRow.appendChild(manualH);
    el.appendChild(manualRow);

    // ---- 参数：百万像素 ----
    const pixelsRow = document.createElement("div");
    pixelsRow.style.cssText = rowStyle;
    const pixelsLabel = document.createElement("span");
    pixelsLabel.textContent = "百万像素";
    pixelsLabel.style.cssText = labelStyle;
    const mpInput = makeNumber(1, 0.01, 16, 0.1, "72px");
    const mpUnit = document.createElement("span");
    mpUnit.textContent = "MP";
    mpUnit.style.cssText = labelStyle;
    pixelsRow.appendChild(pixelsLabel);
    pixelsRow.appendChild(mpInput);
    pixelsRow.appendChild(mpUnit);
    el.appendChild(pixelsRow);

    // ---- 参数：按比例基准 ----
    const baseRow = document.createElement("div");
    baseRow.style.cssText = rowStyle;
    const baseLabel = document.createElement("span");
    baseLabel.textContent = "基准";
    baseLabel.style.cssText = labelStyle;
    const baseSelect = makeSelect(
        [
            { value: "width", label: "宽" },
            { value: "height", label: "高" },
            { value: "long", label: "长边" },
        ],
        selectStyle + "width: 58px;"
    );
    const baseValueInput = makeNumber(1024, 64, 16384, 8, "68px");
    baseRow.appendChild(baseLabel);
    baseRow.appendChild(baseSelect);
    baseRow.appendChild(baseValueInput);
    el.appendChild(baseRow);

    // ---- 倍数 ----
    const multipleRow = document.createElement("div");
    multipleRow.style.cssText = rowStyle;
    const multipleLabel = document.createElement("span");
    multipleLabel.textContent = "倍数";
    multipleLabel.style.cssText = labelStyle;
    const multipleSelect = makeSelect(
        MULTIPLES.map((m) => ({ value: m, label: String(m) })),
        selectStyle + "width: 58px;"
    );
    multipleRow.appendChild(multipleLabel);
    multipleRow.appendChild(multipleSelect);
    el.appendChild(multipleRow);

    // ---- 结果 ----
    const result = document.createElement("div");
    result.style.cssText =
        "padding: 4px 6px; background: #242424; border: 1px solid #3a3a3a; border-radius: 4px; text-align: center; color: #ddd; font-size: 11px;";
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

