// UI 组件工厂：只拼 class，不写颜色/圆角/字号。样式统一在 theme.js。

import { ensureTheme } from "./theme.js";

const applyWidth = (el, width) => {
    if (width === undefined || width === null) return;
    el.style.width = typeof width === "number" ? `${width}px` : String(width);
};

/**
 * 卡片：可选折叠头。分隔线、箭头、圆角都由 .moss-card 系列 class 控制。
 * - arrow: 是否显示默认箭头（false 时自行放按钮，仍可用 toggle）
 * - headClick: 点标题栏是否折叠；false 时只能调 toggle()
 * - divider: 不可折叠也画一条标题分隔线
 */
export function createCard({
    title = "",
    collapsible = false,
    open = true,
    flush = false,
    divider = false,
    arrow = true,
    headClick,
    bodyClass = "",
    className = "",
} = {}) {
    ensureTheme();
    const el = document.createElement("div");
    el.className = `moss-card ${className}`.trim();

    const head = document.createElement("div");
    head.className = "moss-card__head";
    const titleEl = document.createElement("span");
    titleEl.textContent = title;
    head.appendChild(titleEl);

    const body = document.createElement("div");
    body.className = `moss-card__body${flush ? " moss-card__body--flush" : ""}${bodyClass ? ` ${bodyClass}` : ""}`;

    let openState = !!open;
    let toggleHook = null;

    const paint = () => {
        head.classList.toggle("moss-card__head--open", openState && (collapsible || divider));
        body.style.display = openState ? "" : "none";
        head.classList.toggle("moss-card__head--clickable", collapsible && headClick !== false);
    };

    if (collapsible && arrow) {
        const arrowEl = document.createElement("span");
        arrowEl.className = "moss-card__arrow";
        arrowEl.textContent = "▼";
        head.appendChild(arrowEl);
    }

    const toggle = (next) => {
        if (!collapsible) return openState;
        openState = typeof next === "boolean" ? next : !openState;
        paint();
        return openState;
    };

    if (collapsible && headClick !== false) {
        head.onclick = () => {
            toggle();
            toggleHook?.(openState);
        };
    }

    el.appendChild(head);
    el.appendChild(body);
    paint();

    return {
        el,
        head,
        body,
        titleEl,
        toggle,
        isOpen: () => openState,
        onToggle: (fn) => {
            toggleHook = fn;
        },
        setTitle: (text) => {
            titleEl.textContent = text;
        },
    };
}

/**
 * 区块：弹层里的「标题 + 贯穿分隔线 + 内容」，不带外框。
 * inline: 标题和控件同一行（用于单行设置项）。
 */
export function createSection({ title = "", inline = false, className = "" } = {}) {
    ensureTheme();
    const el = document.createElement("div");
    el.className = `moss-section${inline ? " moss-section--inline" : ""} ${className}`.trim();

    const head = document.createElement("div");
    head.className = "moss-section__head";
    const titleEl = document.createElement("span");
    titleEl.className = "moss-section__title";
    titleEl.textContent = title;
    head.appendChild(titleEl);

    const body = document.createElement("div");
    body.className = "moss-section__body";

    el.appendChild(head);
    el.appendChild(body);
    return { el, head, titleEl, body };
}

export function createRow(children = [], { gap = "6px", className = "" } = {}) {
    ensureTheme();
    const row = document.createElement("div");
    row.className = `moss-row ${className}`.trim();
    if (gap) row.style.gap = gap;
    children.filter(Boolean).forEach((child) => row.appendChild(child));
    return row;
}

export function createLabel(text) {
    ensureTheme();
    const label = document.createElement("span");
    label.className = "moss-label";
    label.textContent = text;
    return label;
}

export function createSelect(options = [], { value, width } = {}) {
    ensureTheme();
    const select = document.createElement("select");
    select.className = "moss-select";
    applyWidth(select, width);
    options.forEach((opt) => {
        const item = document.createElement("option");
        const isObj = opt && typeof opt === "object";
        item.value = String(isObj ? opt.value : opt);
        item.textContent = String(isObj ? opt.label ?? opt.value : opt);
        select.appendChild(item);
    });
    if (value !== undefined) select.value = String(value);
    return select;
}

export function createInput({ type = "text", value = "", min, max, step, width, placeholder } = {}) {
    ensureTheme();
    const input = document.createElement("input");
    input.type = type;
    input.className = "moss-input";
    input.value = String(value);
    if (min !== undefined) input.min = String(min);
    if (max !== undefined) input.max = String(max);
    if (step !== undefined) input.step = String(step);
    if (placeholder) input.placeholder = placeholder;
    applyWidth(input, width);
    return input;
}

export function createButton(label, { variant = "", block = false, small = false, icon = false, title, onClick } = {}) {
    ensureTheme();
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = [
        "moss-btn",
        variant === "primary" ? "moss-btn--primary" : "",
        block ? "moss-btn--block" : "",
        small ? "moss-btn--sm" : "",
        icon ? "moss-btn--icon" : "",
    ]
        .filter(Boolean)
        .join(" ");
    btn.textContent = label;
    if (title) btn.title = title;
    if (onClick) btn.addEventListener("click", onClick);
    return btn;
}

// label + 控件的一行；控件自动吃掉剩余宽度
export function createField(labelText, control, { labelWidth } = {}) {
    ensureTheme();
    const row = createRow([]);
    const label = createLabel(labelText);
    if (labelWidth) label.style.width = typeof labelWidth === "number" ? `${labelWidth}px` : String(labelWidth);
    row.appendChild(label);
    if (control) {
        control.style.flex = "1 1 auto";
        row.appendChild(control);
    }
    return row;
}

export function createDivider() {
    ensureTheme();
    const el = document.createElement("div");
    el.className = "moss-divider";
    return el;
}

export function createTextarea({ value = "", placeholder = "", rows, height } = {}) {
    ensureTheme();
    const el = document.createElement("textarea");
    el.className = "moss-textarea";
    el.value = value;
    if (placeholder) el.placeholder = placeholder;
    if (rows) el.rows = rows;
    if (height !== undefined) el.style.height = typeof height === "number" ? `${height}px` : String(height);
    return el;
}

export function createCheckbox({ checked = false, title } = {}) {
    ensureTheme();
    const el = document.createElement("input");
    el.type = "checkbox";
    el.className = "moss-checkbox";
    el.checked = !!checked;
    if (title) el.title = title;
    return el;
}
