// 节点上四个原生按钮（复制 / 复制带长宽 / 打开面板 / 导入 JSON）的悬浮高亮。
//
// 新版 ComfyUI 前端把 button widget 渲染成 DOM，所在行带 `data-widget-name`，
// 而官方主题压根没给 hover 态（实测 hover 前后 background-color 都是 rgb(49,50,53)），
// 点起来像块死板子。这里用属性选择器补一层高亮：节点重绘不会丢，
// 按钮文案临时变成「✓ 已复制 / ✗ 失败」时也仍然命中。

import { ensureTheme } from "./theme.js";

const STYLE_ID = "moss-node-button-style";

// 「复制 JSON」同时命中「复制 JSON(带长宽)」，不必重复写。
const NAMES = ["复制 JSON", "✓ 已复制", "✗ 失败", "打开边界框管理面板", "导入图片中的提示词"];

export function ensureNodeButtonStyle() {
    if (typeof document === "undefined") return;
    if (document.getElementById(STYLE_ID)) return;
    ensureTheme();

    // 注意：伪类必须逐个加到每一项上。写成 `${list}:hover` 会只给逗号列表的
    // 最后一项加 :hover，前面几项变成无条件生效的裸选择器（按钮常态就带高亮和蓝框）。
    const withState = (state) =>
        NAMES.map((n) => `[data-widget-name*="${n}"] button${state}`).join(",\n");

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
${withState("")} {
    transition: background-color 0.12s ease, box-shadow 0.12s ease, color 0.12s ease;
}
${withState(":hover")} {
    background-color: #47484d;
    box-shadow: inset 0 0 0 1px var(--moss-border-strong);
    color: var(--moss-text);
}
${withState(":active")} {
    background-color: #333438;
    box-shadow: inset 0 0 0 1px #6a6a6a;
}
${withState(":focus-visible")} {
    outline: 1px solid var(--moss-accent);
    outline-offset: 1px;
}
`;
    document.head.appendChild(style);
}
