// 画布顶部的操作文字提示：按住修饰键时常驻，快捷键操作后短暂弹出
const STYLE_ID = "moss-toast-style";

function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
.moss-toast {
    position: absolute; top: 12px; left: 50%; z-index: 24;
    transform: translate(-50%, -6px); display: flex; align-items: center; gap: 7px;
    max-width: calc(100% - 24px); padding: 6px 13px; box-sizing: border-box;
    border: 1px solid #4a7ab5; border-radius: 999px;
    background: rgba(22, 34, 50, 0.94); box-shadow: 0 6px 20px rgba(0, 0, 0, 0.45);
    color: #e8f1ff; font: 12px/1.4 "Segoe UI", "Microsoft YaHei", sans-serif;
    letter-spacing: 0.2px; white-space: nowrap; pointer-events: none;
    opacity: 0; transition: opacity 0.14s ease, transform 0.14s ease;
}
.moss-toast.is-on { opacity: 1; transform: translate(-50%, 0); }
.moss-toast.is-hint { border-color: #555; background: rgba(26, 26, 26, 0.94); color: #d8d8d8; }
.moss-toast-dot { width: 6px; height: 6px; border-radius: 50%; background: #4a9eff; flex: 0 0 auto; }
.moss-toast.is-hint .moss-toast-dot { background: #8a8a8a; }
.moss-toast-text { overflow: hidden; text-overflow: ellipsis; }
`;
    document.head.appendChild(style);
}

export function createToast(host) {
    ensureStyle();

    const el = document.createElement("div");
    el.className = "moss-toast";
    const dot = document.createElement("span");
    dot.className = "moss-toast-dot";
    const label = document.createElement("span");
    label.className = "moss-toast-text";
    el.appendChild(dot);
    el.appendChild(label);
    host.appendChild(el);

    let hint = "";
    let message = "";
    let timer = null;

    // 提示优先级：临时操作反馈 > 常驻修饰键提示 > 隐藏
    const render = () => {
        const text = message || hint;
        if (!text) {
            el.classList.remove("is-on");
            return;
        }
        label.textContent = text;
        el.classList.toggle("is-hint", !message && !!hint);
        el.classList.add("is-on");
    };

    // 同一条消息连着触发时只续时长，不重播淡入动画
    const show = (text, duration = 1500) => {
        clearTimeout(timer);
        message = String(text || "");
        render();
        timer = setTimeout(() => {
            message = "";
            timer = null;
            render();
        }, Math.max(400, duration));
    };

    const setHint = (text) => {
        const next = String(text || "");
        if (next === hint) return;
        hint = next;
        if (!message) render();
    };

    const destroy = () => {
        clearTimeout(timer);
        timer = null;
        el.remove();
    };

    return { show, setHint, destroy };
}
