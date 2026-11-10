import { ensureTheme } from "../ui/theme.js";

const ICONS = {
    selectAll: '<rect x="2.5" y="2.5" width="11" height="11" rx="1.5" stroke-dasharray="2.5 2"/>',
    plus: '<path d="M8 3v10M3 8h10"/>',
    trash: '<path d="M3 5h10M6.5 5V3.5h3V5M4.8 5l.7 8h5l.7-8"/><path d="M6.8 7.5v3.2M9.2 7.5v3.2"/>',
    alignLeft: '<path d="M2.5 2.5v11"/><rect x="4.5" y="4" width="9" height="3" rx="0.6"/><rect x="4.5" y="9" width="6" height="3" rx="0.6"/>',
    alignCenterH: '<path d="M8 2.5v11" stroke-dasharray="2 2"/><rect x="2.5" y="4" width="11" height="3" rx="0.6"/><rect x="4.5" y="9" width="7" height="3" rx="0.6"/>',
    alignRight: '<path d="M13.5 2.5v11"/><rect x="2.5" y="4" width="9" height="3" rx="0.6"/><rect x="5.5" y="9" width="6" height="3" rx="0.6"/>',
    alignTop: '<path d="M2.5 2.5h11"/><rect x="4" y="4.5" width="3" height="9" rx="0.6"/><rect x="9" y="4.5" width="3" height="6" rx="0.6"/>',
    alignCenterV: '<path d="M2.5 8h11" stroke-dasharray="2 2"/><rect x="4" y="2.5" width="3" height="11" rx="0.6"/><rect x="9" y="4.5" width="3" height="7" rx="0.6"/>',
    alignBottom: '<path d="M2.5 13.5h11"/><rect x="4" y="2.5" width="3" height="9" rx="0.6"/><rect x="9" y="5.5" width="3" height="6" rx="0.6"/>',
    distributeH: '<path d="M2.5 2.5v11M13.5 2.5v11"/><rect x="6" y="4" width="4" height="8" rx="0.6"/>',
    distributeV: '<path d="M2.5 2.5h11M2.5 13.5h11"/><rect x="4" y="6" width="8" height="4" rx="0.6"/>',
    chevronDown: '<path d="M4.5 6.5L8 10l3.5-3.5"/>',
    magnet: '<path d="M3.5 3.5v4a4.5 4.5 0 0 0 9 0v-4"/><path d="M3.5 3.5h3.2M13.3 3.5h-3.2"/>',
    canvas: '<rect x="3" y="3" width="10" height="10" rx="1"/><path d="M2 5V3.5A1.5 1.5 0 0 1 3.5 2H5M11 2h1.5A1.5 1.5 0 0 1 14 3.5V5M14 11v1.5a1.5 1.5 0 0 1-1.5 1.5H11M5 14H3.5A1.5 1.5 0 0 1 2 12.5V11"/>',
    image: '<rect x="2" y="3" width="12" height="10" rx="1"/><circle cx="5.5" cy="6.5" r="1.1"/><path d="M2.5 11.2l3.3-2.8 2.8 2.3 1.9-1.5 2.8 2.3"/>',
    // 深度图：四段灰阶 + 外框。填充用内联 style 盖掉 svg 上继承的 fill:none，
    // 最暗那格 (#4a5057) 比面板底 #1e1e1e 亮两档，14px 下也不会糊成暗块。
    depth: '<rect x="2" y="3.5" width="3" height="9" style="fill:#e6e9ec;stroke:none"/><rect x="5" y="3.5" width="3" height="9" style="fill:#a8aeb5;stroke:none"/><rect x="8" y="3.5" width="3" height="9" style="fill:#6d737a;stroke:none"/><rect x="11" y="3.5" width="3" height="9" style="fill:#4a5057;stroke:none"/><rect x="2" y="3.5" width="12" height="9" rx="1"/>',
    undo: '<path d="M5.5 5.5H9a3.6 3.6 0 0 1 0 7.2H6"/><path d="M7.6 3.2L5 5.5l2.6 2.3"/>',
    redo: '<path d="M10.5 5.5H7a3.6 3.6 0 0 0 0 7.2h3"/><path d="M8.4 3.2L11 5.5 8.4 7.8"/>',
    reset: '<circle cx="8" cy="8" r="4.2"/><path d="M8 1.6v2M8 12.4v2M1.6 8h2M12.4 8h2"/>',
};

const STYLE_ID = "moss-ribbon-style";
let activePopover = null;

function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    ensureTheme();
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
.moss-ribbon { display: flex; align-items: center; gap: 1px; flex: 0 0 auto; height: 34px; padding: 0 6px; box-sizing: border-box; background: var(--moss-bg); border-bottom: 1px solid var(--moss-divider); overflow-x: auto; overflow-y: hidden; }
.moss-ribbon::-webkit-scrollbar { height: 3px; }
.moss-ribbon::-webkit-scrollbar-thumb { background: var(--moss-border); border-radius: 2px; }
.moss-ribbon-group { display: flex; align-items: center; gap: 1px; flex: 0 0 auto; }
.moss-ribbon-sep { width: 1px; height: 16px; margin: 0 5px; background: var(--moss-divider); flex: 0 0 auto; }
.moss-ribbon-btn { width: 22px; height: 22px; display: flex; align-items: center; justify-content: center; padding: 0; border: 1px solid transparent; border-radius: 5px; background: transparent; color: #ccc; cursor: pointer; flex: 0 0 auto; transition: background 0.12s, border-color 0.12s, color 0.12s, opacity 0.12s; }
.moss-ribbon-btn svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.4; stroke-linecap: round; stroke-linejoin: round; pointer-events: none; }
.moss-ribbon-btn:hover { background: var(--moss-bg-control-hover); border-color: #8a8a8a; color: #fff; }
.moss-ribbon-btn.is-active { background: #24405e; border-color: #4a9eff; color: #dbe9ff; }
.moss-ribbon-btn.is-active:hover { background: #2c4c6e; border-color: #6bb0ff; }
.moss-ribbon-btn:disabled { opacity: 0.35; cursor: default; background: transparent; border-color: transparent; color: #ccc; }
.moss-ribbon-select { height: 24px; padding: 0 4px; border: 1px solid var(--moss-border); border-radius: 5px; background: var(--moss-bg-control); color: #ddd; font-size: 11px; outline: none; cursor: pointer; flex: 0 0 auto; }
.moss-ribbon-select:hover { border-color: #666; color: #fff; }
.moss-ribbon-tip { position: fixed; z-index: 2147483000; padding: 4px 8px; border-radius: 4px; background: #111; border: 1px solid var(--moss-border); color: #ddd; font-size: 11px; line-height: 1.4; pointer-events: none; white-space: nowrap; opacity: 0; transition: opacity 0.12s; }
.moss-popover { position: fixed; z-index: 2147482500; padding: 10px; border: 1px solid var(--moss-border-strong); border-radius: var(--moss-radius-lg); background: var(--moss-bg); box-shadow: 0 12px 30px rgba(0, 0, 0, 0.55); display: flex; flex-direction: column; gap: 8px; box-sizing: border-box; }
`;
    document.head.appendChild(style);
}

function bindTooltip(btn, text) {
    let tip = null;
    let timer = null;
    const show = () => {
        timer = setTimeout(() => {
            tip = document.createElement("div");
            tip.className = "moss-ribbon-tip";
            tip.textContent = text;
            document.body.appendChild(tip);
            const r = btn.getBoundingClientRect();
            const w = tip.offsetWidth;
            tip.style.left = Math.max(6, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 6)) + "px";
            tip.style.top = r.bottom + 6 + "px";
            requestAnimationFrame(() => { if (tip) tip.style.opacity = "1"; });
        }, 400);
    };
    const hide = () => {
        clearTimeout(timer);
        if (tip) {
            tip.remove();
            tip = null;
        }
    };
    btn.addEventListener("mouseenter", show);
    btn.addEventListener("mouseleave", hide);
    btn.addEventListener("mousedown", hide);
}

export function closePopover() {
    if (!activePopover) return;
    activePopover.anchor.classList.remove("is-active");
    activePopover.el.remove();
    activePopover = null;
}

export function openPopover(anchor, content, { width = 0 } = {}) {
    const same = activePopover && activePopover.anchor === anchor;
    closePopover();
    if (same) return;

    const pop = document.createElement("div");
    pop.className = "moss-popover";
    if (width) pop.style.width = width + "px";
    pop.appendChild(content);
    document.body.appendChild(pop);

    const r = anchor.getBoundingClientRect();
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    let left = Math.min(Math.max(6, r.left), window.innerWidth - w - 6);
    let top = r.bottom + 6;
    if (top + h > window.innerHeight - 6) top = Math.max(6, r.top - h - 6);
    pop.style.left = left + "px";
    pop.style.top = top + "px";

    anchor.classList.add("is-active");
    activePopover = { anchor, el: pop };

    const onDown = (e) => {
        // 带这个标记的遮罩（弹窗）点进去不算「外部点击」，否则弹窗一开 popover 就没了
        if (e.target?.closest?.("[data-moss-keep-popover]")) return;
        if (pop.contains(e.target) || anchor.contains(e.target)) return;
        closePopover();
    };
    const onKey = (e) => {
        if (e.key === "Escape") closePopover();
    };
    setTimeout(() => {
        document.addEventListener("mousedown", onDown, true);
        document.addEventListener("keydown", onKey, true);
    }, 0);

    pop._mossCleanup = () => {
        document.removeEventListener("mousedown", onDown, true);
        document.removeEventListener("keydown", onKey, true);
    };
    const origRemove = pop.remove.bind(pop);
    pop.remove = () => {
        pop._mossCleanup?.();
        origRemove();
    };
}

export function createRibbon() {
    ensureStyle();

    const el = document.createElement("div");
    el.className = "moss-ribbon";
    let groupCount = 0;

    const button = (icon, title, onClick) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "moss-ribbon-btn";
        btn.innerHTML = `<svg viewBox="0 0 16 16">${ICONS[icon] || ""}</svg>`;
        if (title) {
            btn.title = title;
            bindTooltip(btn, title);
        }
        if (onClick) btn.addEventListener("click", onClick);
        return btn;
    };

    const select = (options, onChange) => {
        const sel = document.createElement("select");
        sel.className = "moss-ribbon-select";
        options.forEach(({ value, label }) => {
            const opt = document.createElement("option");
            opt.value = value;
            opt.textContent = label;
            sel.appendChild(opt);
        });
        if (onChange) sel.addEventListener("change", onChange);
        return sel;
    };

    const group = (nodes) => {
        if (groupCount) {
            const sep = document.createElement("div");
            sep.className = "moss-ribbon-sep";
            el.appendChild(sep);
        }
        const g = document.createElement("div");
        g.className = "moss-ribbon-group";
        (Array.isArray(nodes) ? nodes : [nodes]).forEach((n) => n && g.appendChild(n));
        el.appendChild(g);
        groupCount++;
        return g;
    };

    return { el, group, button, select };
}
