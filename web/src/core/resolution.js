// 画布分辨率计算：手动 / 按像素 / 按比例三种输入方式。
// 纯函数，不依赖 DOM 或节点，方便直接跑用例。

// 官方分辨率选择器的 1 MP 按 1024×1024 计，不是 1,000,000
export const MP_BASE = 1024 * 1024;
export const MIN_SIZE = 64;
export const MAX_SIZE = 16384;
export const MULTIPLES = [8, 16, 32, 64];

// 顺序与官方分辨率选择器一致：方形 → 竖构图 → 横构图 → 宽银幕
export const RATIO_PRESETS = [
    { label: "1:1 (方形)", w: 1, h: 1 },
    { label: "2:3 (竖版照片)", w: 2, h: 3 },
    { label: "3:2 (照片)", w: 3, h: 2 },
    { label: "3:4 (竖版标准)", w: 3, h: 4 },
    { label: "4:3 (标准)", w: 4, h: 3 },
    { label: "9:16 (竖屏宽幅)", w: 9, h: 16 },
    { label: "16:9 (宽屏)", w: 16, h: 9 },
    { label: "21:9 (超宽)", w: 21, h: 9 },
];

export const DEFAULT_STATE = {
    mode: "manual",          // manual | pixels | ratio
    ratioW: 1,
    ratioH: 1,
    megapixels: 1,
    base: "width",           // width | height | long
    baseValue: 1024,
    multiple: 32,
};

const MODES = ["manual", "pixels", "ratio"];
const BASES = ["width", "height", "long"];

const gcd = (a, b) => {
    let x = Math.abs(Math.round(a));
    let y = Math.abs(Math.round(b));
    while (y) {
        const t = x % y;
        x = y;
        y = t;
    }
    return x || 1;
};

// 约分，例如 32:18 → 16:9；小数先放大再约
export function reduceRatio(w, h) {
    const a = Number(w);
    const b = Number(h);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) {
        return { w: 1, h: 1 };
    }
    const scale = 1000;
    const g = gcd(Math.round(a * scale), Math.round(b * scale));
    return {
        w: Math.max(1, Math.round((a * scale) / g)),
        h: Math.max(1, Math.round((b * scale) / g)),
    };
}

export function ratioToNumber(w, h) {
    const a = Number(w);
    const b = Number(h);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return 1;
    return a / b;
}

export function clampSize(value) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return MIN_SIZE;
    return Math.min(MAX_SIZE, Math.max(MIN_SIZE, n));
}

// 落到倍数网格：四舍五入，再夹一次范围
export function snapSize(value, multiple) {
    const m = MULTIPLES.includes(Number(multiple)) ? Number(multiple) : 32;
    const n = Number(value);
    if (!Number.isFinite(n)) return MIN_SIZE;
    const snapped = Math.round(n / m) * m;
    return clampSize(snapped);
}

// 按像素：总面积固定，按比例求宽高。
// 先定宽再反推高，保证宽高比精确落在倍数网格上（官方 2:3 / 1MP → 832×1248 也是这么来的）
export function fromMegapixels(ratioW, ratioH, megapixels, multiple) {
    const r = ratioToNumber(ratioW, ratioH);
    const mp = Math.max(0.01, Number(megapixels) || 1);
    const width = snapSize(Math.sqrt(mp * MP_BASE * r), multiple);
    const height = snapSize(width / r, multiple);
    return { width, height };
}

// 按比例：先定基准边，另一边自动
export function fromRatio(ratioW, ratioH, base, baseValue, multiple) {
    const r = ratioToNumber(ratioW, ratioH);
    const value = Math.max(1, Number(baseValue) || 1024);
    if (base === "height") {
        const height = snapSize(value, multiple);
        return { width: snapSize(height * r, multiple), height };
    }
    if (base === "long") {
        // 长边作为基准：比例大于 1 时宽是长边，否则高是长边
        if (r >= 1) {
            const width = snapSize(value, multiple);
            return { width, height: snapSize(width / r, multiple) };
        }
        const height = snapSize(value, multiple);
        return { width: snapSize(height * r, multiple), height };
    }
    const width = snapSize(value, multiple);
    return { width, height: snapSize(width / r, multiple) };
}

export function megapixelsOf(width, height) {
    return (Math.max(1, width) * Math.max(1, height)) / MP_BASE;
}

// 1024×1024 → "1.05 MP"；去掉多余的 0
export function formatMegapixels(width, height) {
    const mp = megapixelsOf(width, height);
    const text = mp >= 10 ? mp.toFixed(1) : mp.toFixed(2);
    return `${text.replace(/\.?0+$/, "")} MP`;
}

export function formatResolution(width, height) {
    return `${Math.round(width)} × ${Math.round(height)}`;
}

// 从当前宽高反推比例与像素，切模式时用它做初值，避免一打开就跳成 1:1
export function inferFromSize(width, height) {
    const w = Math.max(1, Number(width) || 1);
    const h = Math.max(1, Number(height) || 1);
    const ratio = reduceRatio(w, h);
    return {
        ratioW: ratio.w,
        ratioH: ratio.h,
        megapixels: Math.max(0.01, Math.round((w * h * 100) / MP_BASE) / 100),
        baseValue: Math.round(Math.max(w, h)),
    };
}

// 把任意来源的配置收敛成合法值；坏字段回退默认，不抛错
export function normalizeState(raw) {
    const src = raw && typeof raw === "object" ? raw : {};
    const state = { ...DEFAULT_STATE };
    if (MODES.includes(src.mode)) state.mode = src.mode;
    const ratio = reduceRatio(src.ratioW ?? state.ratioW, src.ratioH ?? state.ratioH);
    state.ratioW = ratio.w;
    state.ratioH = ratio.h;
    const mp = Number(src.megapixels);
    if (Number.isFinite(mp)) state.megapixels = Math.min(16, Math.max(0.01, mp));
    if (BASES.includes(src.base)) state.base = src.base;
    const baseValue = Number(src.baseValue);
    if (Number.isFinite(baseValue)) state.baseValue = clampSize(baseValue);
    const multiple = Number(src.multiple);
    if (MULTIPLES.includes(multiple)) state.multiple = multiple;
    return state;
}

// 根据当前模式算出宽高；手动模式返回 null，由调用方直接用两个输入框的值
export function computeSize(state) {
    const s = normalizeState(state);
    if (s.mode === "pixels") {
        return fromMegapixels(s.ratioW, s.ratioH, s.megapixels, s.multiple);
    }
    if (s.mode === "ratio") {
        return fromRatio(s.ratioW, s.ratioH, s.base, s.baseValue, s.multiple);
    }
    return null;
}
