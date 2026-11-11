// ==========================================
// 导入提示词 JSON：先选范围，再选图片
// ==========================================
//   full   = 主提示词 + bbox + 布局，覆盖当前内容
//   prompt = 只改 summary.caption，保留现有 bbox 与画布尺寸
//   layout = 只换 items / 坐标格式 / 画布尺寸，保留现有主提示词
// 这里只管弹层与文件框，真正的合并计算在 core/import-layout.js。

import { ensureTheme } from "./theme.js";

export const IMPORT_MODES = [
    {
        id: "full",
        name: "导入完整提示词",
        desc: "主提示词、全部 bbox 与布局一起导入，覆盖当前内容",
    },
    {
        id: "prompt",
        name: "仅导入主提示词",
        desc: "只替换主提示词，保留现有 bbox 与画布尺寸",
    },
    {
        id: "layout",
        name: "仅导入 bbox 及其布局",
        desc: "只替换 bbox、布局与画布尺寸，保留现有主提示词",
    },
];

const IMPORT_STYLE_ID = "moss-import-mode-style";

function ensureImportDialogStyle() {
    if (document.getElementById(IMPORT_STYLE_ID)) return;
    ensureTheme();
    const style = document.createElement("style");
    style.id = IMPORT_STYLE_ID;
    style.textContent = `
.moss-import-mask { position: fixed; inset: 0; z-index: 2147482600; display: flex; align-items: center; justify-content: center; background: rgba(0, 0, 0, 0.45); font-family: system-ui, "Microsoft YaHei", sans-serif; }
.moss-import-dialog { width: 360px; max-width: calc(100vw - 32px); box-sizing: border-box; padding: 14px; border: 1px solid var(--moss-border-strong); border-radius: var(--moss-radius-lg); background: var(--moss-bg); color: var(--moss-text-dim); box-shadow: 0 18px 48px rgba(0, 0, 0, 0.6); }
.moss-import-title { font-size: 14px; font-weight: 600; color: var(--moss-text); }
.moss-import-sub { margin-top: 4px; font-size: 11px; color: var(--moss-text-muted); line-height: 1.5; }
.moss-import-opts { display: flex; flex-direction: column; gap: 6px; margin-top: 12px; }
.moss-import-opt { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; padding: 8px 10px; border: 1px solid var(--moss-border); border-radius: var(--moss-radius); background: var(--moss-bg-elevated); color: var(--moss-text-dim); text-align: left; cursor: pointer; font-family: inherit; }
.moss-import-opt:hover { border-color: var(--moss-accent); background: #2c3340; }
.moss-import-opt:focus-visible { outline: none; border-color: var(--moss-accent); background: #2c3340; }
.moss-import-opt-name { font-size: var(--moss-font); color: var(--moss-text); }
.moss-import-opt-desc { font-size: var(--moss-font-sm); color: var(--moss-text-muted); line-height: 1.45; }
.moss-import-foot { display: flex; justify-content: flex-end; margin-top: 10px; }
.moss-import-cancel { padding: 4px 12px; border: 1px solid var(--moss-border-strong); border-radius: 5px; background: var(--moss-bg-control); color: var(--moss-text-dim); cursor: pointer; font-size: var(--moss-font-sm); font-family: inherit; }
.moss-import-cancel:hover { background: var(--moss-bg-control-hover); color: var(--moss-text); }
`;
    document.head.appendChild(style);
}

export function showImportModeDialog(nodeId) {
    return new Promise((resolve) => {
        ensureImportDialogStyle();

        const mask = document.createElement("div");
        mask.className = "moss-import-mask";
        // 记下是哪个节点开的，节点被删时只收掉自己那一层
        mask.dataset.mossNodeId = String(nodeId);
        const dialog = document.createElement("div");
        dialog.className = "moss-import-dialog";
        dialog.setAttribute("role", "dialog");
        dialog.setAttribute("aria-modal", "true");
        dialog.setAttribute("aria-label", "选择导入范围");

        const title = document.createElement("div");
        title.className = "moss-import-title";
        title.textContent = "导入图片中的提示词 JSON";
        const sub = document.createElement("div");
        sub.className = "moss-import-sub";
        sub.textContent = "先选导入范围，再选一张带工作流的图片。";
        const opts = document.createElement("div");
        opts.className = "moss-import-opts";

        let settled = false;
        const close = (mode) => {
            if (settled) return;
            settled = true;
            document.removeEventListener("keydown", onKey, true);
            mask.remove();
            resolve(mode);
        };
        // Esc 只在弹层里生效，别让它继续冒泡到画布取消选中
        const onKey = (e) => {
            if (e.key !== "Escape") return;
            e.preventDefault();
            e.stopPropagation();
            close(null);
        };
        document.addEventListener("keydown", onKey, true);

        IMPORT_MODES.forEach((mode) => {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "moss-import-opt";
            const name = document.createElement("span");
            name.className = "moss-import-opt-name";
            name.textContent = mode.name;
            const desc = document.createElement("span");
            desc.className = "moss-import-opt-desc";
            desc.textContent = mode.desc;
            btn.appendChild(name);
            btn.appendChild(desc);
            btn.addEventListener("click", () => close(mode.id));
            opts.appendChild(btn);
        });

        const foot = document.createElement("div");
        foot.className = "moss-import-foot";
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.className = "moss-import-cancel";
        cancel.textContent = "取消";
        cancel.addEventListener("click", () => close(null));
        foot.appendChild(cancel);

        // 只有「按下」和「松开」都落在遮罩空白处才算点击外部（拖选文本时松手在遮罩上不算）
        let downOnMask = false;
        mask.addEventListener("mousedown", (e) => {
            downOnMask = e.target === mask;
        });
        mask.addEventListener("mouseup", (e) => {
            if (downOnMask && e.target === mask) close(null);
            downOnMask = false;
        });

        dialog.appendChild(title);
        dialog.appendChild(sub);
        dialog.appendChild(opts);
        dialog.appendChild(foot);
        mask.appendChild(dialog);
        document.body.appendChild(mask);
        // 默认停在第一个选项上，回车即可按原行为导入
        opts.firstChild?.focus?.();
    });
}

// 取消选择时浏览器不一定触发 change，这里把 cancel 和焦点回来都兜住
export function pickImageFile() {
    return new Promise((resolve) => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "image/png, image/jpeg, image/webp";
        input.style.display = "none";
        document.body.appendChild(input);

        let done = false;
        let focusTimer = 0;
        const finish = (file, reason) => {
            if (done) return;
            done = true;
            clearTimeout(focusTimer);
            window.removeEventListener("focus", onFocus);
            input.remove();
            console.log("[MOSS] 文件框结束:", reason, file ? file.name : "");
            resolve(file || null);
        };
        // 旧实现：focus 回来后 300ms 检查 input.files，空就当「取消」。
        // 但用户还在文件对话框里翻目录时 focus 也可能先回来，300ms 一过就把
        // Promise 以 null 结束；之后 change 到了也被 done 挡掉，请求根本不发，
        // 界面表现就是「点了没反应」。新生成的图常放在子目录，挑得久就必现。
        // 现在 focus 只启动一个很长的兜底计时器，change / cancel 一到立即清掉。
        const onFocus = () => {
            clearTimeout(focusTimer);
            focusTimer = setTimeout(() => {
                if (!done && (!input.files || !input.files.length)) finish(null, "超时或取消");
            }, 60000);
        };
        input.addEventListener("change", () => finish(input.files && input.files[0], "已选文件"));
        input.addEventListener("cancel", () => finish(null, "用户取消"));
        window.addEventListener("focus", onFocus);
        input.click();
    });
}
