// 页面顶部的常驻提醒条：用于「首次使用需要下载模型」这类不能一闪而过的提示。
// 固定在最上层，即使面板被关掉也能看到。

const STYLE_ID = "moss-top-banner-style";
const EL_ID = "moss-top-banner";

function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
.moss-top-banner {
    position: fixed; top: 14px; left: 50%; z-index: 2147483600;  /* 必须高于面板弹层（2147482500），否则下载进度会被挡住 */
    transform: translate(-50%, -12px); opacity: 0; pointer-events: none;
    display: flex; align-items: flex-start; gap: 9px;
    min-width: 300px; max-width: min(560px, calc(100vw - 40px));
    padding: 10px 15px; box-sizing: border-box;
    border: 1px solid #4a7ab5; border-radius: 10px;
    background: rgba(24, 30, 40, 0.97);
    box-shadow: 0 10px 34px rgba(0, 0, 0, 0.55);
    color: #e8f1ff; font: 12.5px/1.45 "Segoe UI", "Microsoft YaHei", sans-serif;
    letter-spacing: 0.2px;
    transition: opacity 0.18s ease, transform 0.18s ease;
}
.moss-top-banner.is-on { opacity: 1; transform: translate(-50%, 0); }
.moss-top-banner__dot {
    flex: 0 0 auto; width: 8px; height: 8px; margin-top: 5px; border-radius: 50%;
    background: #4a9eff; animation: moss-banner-pulse 1s ease-in-out infinite;
}
@keyframes moss-banner-pulse {
    0%, 100% { opacity: 0.35; transform: scale(0.8); }
    50% { opacity: 1; transform: scale(1.15); }
}
.moss-top-banner__body { flex: 1 1 auto; min-width: 0; }
.moss-top-banner__text { display: block; }
.moss-top-banner__track {
    display: none; margin-top: 7px; height: 3px; border-radius: 2px;
    background: rgba(255, 255, 255, 0.14); overflow: hidden;
}
.moss-top-banner__track.is-on { display: block; }
.moss-top-banner__fill {
    display: block; height: 100%; width: 0; border-radius: 2px;
    background: linear-gradient(90deg, #3f8ae0, #63c6ff);
    transition: width 0.35s ease;
}
.moss-top-banner.is-done { border-color: #3f9e62; }
.moss-top-banner.is-done .moss-top-banner__dot { background: #57d085; animation: none; opacity: 1; }
.moss-top-banner.is-error { border-color: #b5524a; }
.moss-top-banner.is-error .moss-top-banner__dot { background: #ff6b61; animation: none; opacity: 1; }
`;
    document.head.appendChild(style);
}

/**
 * 显示顶部常驻提醒，返回更新/关闭句柄。
 * ratio 传 0~1 时显示进度条，省略则隐藏进度条。
 */
export function showTopBanner(text = "") {
    ensureStyle();

    let el = document.getElementById(EL_ID);
    if (!el) {
        el = document.createElement("div");
        el.id = EL_ID;
        el.className = "moss-top-banner";
        el.setAttribute("role", "status");

        const dot = document.createElement("span");
        dot.className = "moss-top-banner__dot";

        const body = document.createElement("div");
        body.className = "moss-top-banner__body";
        const label = document.createElement("span");
        label.className = "moss-top-banner__text";
        const track = document.createElement("div");
        track.className = "moss-top-banner__track";
        const fill = document.createElement("span");
        fill.className = "moss-top-banner__fill";
        track.appendChild(fill);
        body.appendChild(label);
        body.appendChild(track);

        el.appendChild(dot);
        el.appendChild(body);
        document.body.appendChild(el);
    }

    const label = el.querySelector(".moss-top-banner__text");
    const track = el.querySelector(".moss-top-banner__track");
    const fill = el.querySelector(".moss-top-banner__fill");

    el.classList.remove("is-done", "is-error");
    label.textContent = String(text || "");
    el.classList.add("is-on");

    return {
        update(nextText, ratio) {
            if (nextText !== undefined) label.textContent = String(nextText || "");
            if (typeof ratio === "number" && ratio >= 0) {
                track.classList.add("is-on");
                fill.style.width = `${Math.max(0, Math.min(100, ratio * 100)).toFixed(1)}%`;
            } else {
                track.classList.remove("is-on");
            }
        },
        done(nextText) {
            if (nextText) label.textContent = String(nextText);
            track.classList.add("is-on");
            fill.style.width = "100%";
            el.classList.remove("is-error");
            el.classList.add("is-done");
        },
        fail(nextText) {
            if (nextText) label.textContent = String(nextText);
            el.classList.remove("is-done");
            el.classList.add("is-error");
        },
        close() {
            el.classList.remove("is-on");
        },
    };
}
