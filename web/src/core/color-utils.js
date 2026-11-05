// 颜色格式转换，供取色器使用。

export function hsvToHex(h, s, v) {
    const c = v * s;
    const hp = (((h % 360) + 360) % 360) / 60;
    const x = c * (1 - Math.abs((hp % 2) - 1));
    let r = 0, g = 0, b = 0;
    if (hp < 1) { r = c; g = x; }
    else if (hp < 2) { r = x; g = c; }
    else if (hp < 3) { g = c; b = x; }
    else if (hp < 4) { g = x; b = c; }
    else if (hp < 5) { r = x; b = c; }
    else { r = c; b = x; }
    const m = v - c;
    const toHex = (n) => Math.round(Math.max(0, Math.min(1, n + m)) * 255).toString(16).padStart(2, "0");
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase();
}

export function hexToHsv(hex) {
    let raw = String(hex || "").trim().replace(/^#/, "");
    if (!/^([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(raw)) return { h: 0, s: 1, v: 1 };
    if (raw.length === 3) raw = raw.split("").map((c) => c + c).join("");
    const r = parseInt(raw.slice(0, 2), 16) / 255;
    const g = parseInt(raw.slice(2, 4), 16) / 255;
    const b = parseInt(raw.slice(4, 6), 16) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    let h = 0;
    if (d !== 0) {
        if (max === r) h = ((g - b) / d) % 6;
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h *= 60;
        if (h < 0) h += 360;
    }
    return { h: Math.round(h), s: max === 0 ? 0 : d / max, v: max };
}
