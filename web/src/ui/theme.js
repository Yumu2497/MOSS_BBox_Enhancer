// 插件 UI 的唯一主题入口：颜色、圆角、间距、基础控件样式都从这里来。
// 只注入一次 <style>，其它模块不要再各写一套。

const STYLE_ID = "moss-ui-style";

export const ensureTheme = () => {
    if (typeof document === "undefined") return;
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
:root {
    --moss-bg: #1e1e1e;
    --moss-bg-raised: #1a1a1a;
    --moss-bg-elevated: #262626;
    --moss-bg-control: #2a2a2a;
    --moss-bg-control-hover: #3c3c3c;
    --moss-border: #444;
    --moss-border-strong: #555;
    --moss-divider: #333;
    --moss-text: #eee;
    --moss-text-dim: #aaa;
    --moss-text-muted: #888;
    --moss-accent: #4a9eff;
    --moss-radius-sm: 4px;
    --moss-radius: 6px;
    --moss-radius-lg: 8px;
    --moss-gap-sm: 4px;
    --moss-gap: 8px;
    --moss-gap-lg: 10px;
    --moss-font-sm: 11px;
    --moss-font: 12px;
}

.moss-card {
    background: var(--moss-bg-raised);
    border: 1px solid var(--moss-border);
    border-radius: var(--moss-radius);
    overflow: hidden;
    box-sizing: border-box;
}
.moss-card__head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--moss-gap);
    padding: 8px 10px;
    font-size: var(--moss-font-sm);
    font-weight: bold;
    color: var(--moss-text-dim);
    user-select: none;
}
.moss-card__head--clickable { cursor: pointer; }
.moss-card__head--open { border-bottom: 1px solid var(--moss-divider); }
.moss-card__body { padding: 8px 10px 10px; }
.moss-card__body--flush { padding: 0; }
.moss-card__body--stack { display: flex; flex-direction: column; gap: var(--moss-gap); }
.moss-card__arrow {
    font-size: 10px;
    line-height: 1;
    color: var(--moss-text-muted);
    transform: rotate(-90deg);
    transition: transform 0.2s;
}
.moss-card__head--open .moss-card__arrow { transform: rotate(0deg); }

.moss-row {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: var(--moss-font-sm);
}
.moss-label {
    color: var(--moss-text-dim);
    font-size: var(--moss-font-sm);
    white-space: nowrap;
}

.moss-input,
.moss-select {
    min-width: 0;
    background: #111;
    color: var(--moss-text);
    border: 1px solid var(--moss-border);
    border-radius: var(--moss-radius-sm);
    padding: 3px 5px;
    font-size: var(--moss-font-sm);
    outline: none;
    box-sizing: border-box;
}
.moss-select { cursor: pointer; padding: 3px 4px; }
.moss-input:focus,
.moss-select:focus { border-color: var(--moss-accent); }

.moss-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    padding: 6px 8px;
    background: var(--moss-bg-control);
    border: 1px solid var(--moss-border);
    border-radius: 5px;
    color: #ccc;
    font-size: var(--moss-font-sm);
    cursor: pointer;
    white-space: nowrap;
    transition: background 0.12s, border-color 0.12s, color 0.12s;
}
.moss-btn:hover {
    background: var(--moss-bg-control-hover);
    border-color: #8a8a8a;
    color: #fff;
}
.moss-btn--primary {
    background: #24405e;
    border-color: #4a7ab5;
    color: #dbe9ff;
}
.moss-btn--primary:hover { background: #2c4f75; }
.moss-btn--block { width: 100%; }
.moss-btn--sm { padding: 3px 8px; font-size: 10px; }
.moss-btn--icon { width: 22px; height: 22px; padding: 0; border-color: transparent; background: transparent; }
.moss-btn--soft { background: #333; border-color: var(--moss-border-strong); }
.moss-btn--soft:hover { background: #444; }

.moss-divider { height: 1px; background: var(--moss-divider); margin: 6px 0; }

.moss-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    border: 1px solid var(--moss-border);
    border-radius: 999px;
    background: var(--moss-bg-control);
    color: #ccc;
    font-size: var(--moss-font-sm);
    user-select: none;
    cursor: pointer;
    transition: background 0.12s, border-color 0.12s, color 0.12s;
}
.moss-chip:hover { border-color: #666; }
.moss-chip.is-selected { background: #24405e; border-color: #4a7ab5; color: #dbe9ff; }

/* 区块：弹层内部用的「标题 + 分隔线 + 内容」，不需要再套一层卡片边框。
   标题用负 margin 抵消弹层的 10px 内边距，让分隔线贯穿到卡片边缘。 */
.moss-section { display: flex; flex-direction: column; gap: var(--moss-gap); min-width: 0; }
.moss-section__head {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0 -10px;
    padding: 0 10px 4px;
    border-bottom: 1px solid var(--moss-divider);
    font-size: var(--moss-font-sm);
    font-weight: bold;
    color: var(--moss-text-dim);
}
.moss-section__title { flex: 0 0 auto; }
.moss-section__body { display: flex; flex-direction: column; gap: var(--moss-gap); min-width: 0; }
.moss-section--inline { flex-direction: row; align-items: center; }
.moss-section--inline .moss-section__head { margin: 0; padding: 0; border-bottom: none; }
.moss-section--inline .moss-section__body { flex: 1 1 auto; flex-direction: row; align-items: center; gap: 6px; }

.moss-textarea {
    width: 100%;
    box-sizing: border-box;
    padding: 8px 10px;
    border: none;
    background: transparent;
    color: var(--moss-text);
    font-family: sans-serif;
    font-size: var(--moss-font);
    line-height: 1.4;
    resize: vertical;
    outline: none;
}
.moss-textarea::placeholder { color: #666; }

.moss-checkbox { margin: 0; accent-color: var(--moss-accent); cursor: pointer; }

/* 角色行：整行可交互（双击改、右键删），悬浮给一层浅底 */
.moss-char-row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 3px 4px;
    border-radius: var(--moss-radius-sm);
    font-size: var(--moss-font-sm);
    color: var(--moss-text-dim);
    transition: background 0.12s, color 0.12s;
}
.moss-char-row:hover { background: #2f3033; color: var(--moss-text); }
.moss-char-row > .moss-char-name {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

/* 主提示词模板条目：两行（名字 + 预览），整条可点 */
.moss-tpl-item {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 5px 6px;
    border-radius: var(--moss-radius-sm);
    cursor: pointer;
    transition: background 0.12s;
}
.moss-tpl-item:hover { background: #2f3033; }
.moss-tpl-head { display: flex; align-items: center; gap: 4px; min-width: 0; }
.moss-tpl-title {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--moss-font-sm);
    color: var(--moss-text);
}
.moss-tpl-preview {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 10px;
    color: var(--moss-text-muted);
}

.moss-readout {
    padding: 4px 6px;
    border: 1px solid var(--moss-border);
    border-radius: var(--moss-radius-sm);
    background: #242424;
    color: var(--moss-text-dim);
    font-size: var(--moss-font-sm);
    text-align: center;
}
`;
    document.head.appendChild(style);
};

export const THEME_COLORS = {
    bg: "#1e1e1e",
    bgRaised: "#1a1a1a",
    bgControl: "#2a2a2a",
    border: "#444",
    divider: "#333",
    text: "#eee",
    textDim: "#aaa",
    textMuted: "#888",
    accent: "#4a9eff",
};
