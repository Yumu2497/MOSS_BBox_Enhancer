// 模板编辑弹窗：名字（单行）+ 正文（多行）。
// 和角色弹窗的区别是正文用 textarea，能编辑整段主提示词。

import { ensureTheme } from "./theme.js";

const STYLE_ID = "moss-tpl-dialog-style";

function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    ensureTheme();
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
.moss-tpl-mask { position: fixed; inset: 0; z-index: 2147482610; display: flex; align-items: center; justify-content: center; background: rgba(0, 0, 0, 0.45); font-family: system-ui, "Microsoft YaHei", sans-serif; }
.moss-tpl-dialog { width: 440px; max-width: calc(100vw - 32px); box-sizing: border-box; padding: 14px; border: 1px solid var(--moss-border-strong); border-radius: var(--moss-radius-lg); background: var(--moss-bg); color: var(--moss-text-dim); box-shadow: 0 18px 48px rgba(0, 0, 0, 0.6); }
.moss-tpl-dialog-title { font-size: 14px; font-weight: 600; color: var(--moss-text); }
.moss-tpl-dialog-sub { margin-top: 4px; font-size: 11px; color: var(--moss-text-muted); line-height: 1.5; }
.moss-tpl-field { display: flex; flex-direction: column; gap: 4px; margin-top: 10px; }
.moss-tpl-field > span { font-size: 11px; color: var(--moss-text-muted); }
.moss-tpl-input,
.moss-tpl-textarea { width: 100%; box-sizing: border-box; padding: 6px 8px; border: 1px solid var(--moss-border); border-radius: var(--moss-radius-sm); background: #111; color: var(--moss-text); font-size: 12px; font-family: inherit; outline: none; }
.moss-tpl-textarea { min-height: 180px; max-height: 46vh; resize: vertical; line-height: 1.5; }
.moss-tpl-input:focus,
.moss-tpl-textarea:focus { border-color: var(--moss-accent); }
.moss-tpl-foot { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
.moss-tpl-btn { padding: 4px 12px; border: 1px solid var(--moss-border-strong); border-radius: 5px; background: var(--moss-bg-control); color: var(--moss-text-dim); cursor: pointer; font-size: var(--moss-font-sm); font-family: inherit; }
.moss-tpl-btn:hover { background: var(--moss-bg-control-hover); color: var(--moss-text); }
.moss-tpl-btn--primary { background: #24405e; border-color: #4a7ab5; color: #dbe9ff; }
.moss-tpl-btn--primary:hover { background: #2c4f75; }
`;
    document.head.appendChild(style);
}

/**
 * @returns {Promise<{name: string, text: string}|null>}
 */
export function showTemplateDialog({ name = "", text = "", title = "修改模板" } = {}) {
    return new Promise((resolve) => {
        ensureStyle();

        const mask = document.createElement("div");
        mask.className = "moss-tpl-mask";
        // 让 popover 的「点外部关闭」跳过这层遮罩，否则编辑时模板列表会先被关掉
        mask.dataset.mossKeepPopover = "1";
        const dialog = document.createElement("div");
        dialog.className = "moss-tpl-dialog";
        dialog.setAttribute("role", "dialog");
        dialog.setAttribute("aria-modal", "true");
        dialog.setAttribute("aria-label", title);

        const titleEl = document.createElement("div");
        titleEl.className = "moss-tpl-dialog-title";
        titleEl.textContent = title;
        const sub = document.createElement("div");
        sub.className = "moss-tpl-dialog-sub";
        sub.textContent = "模板只影响主提示词，和框描述、JSON 字段无关。";

        const nameField = document.createElement("div");
        nameField.className = "moss-tpl-field";
        const nameLabel = document.createElement("span");
        nameLabel.textContent = "模板名";
        const nameInput = document.createElement("input");
        nameInput.type = "text";
        nameInput.className = "moss-tpl-input";
        nameInput.value = name;
        nameInput.placeholder = "比如：公园三少女";
        nameField.appendChild(nameLabel);
        nameField.appendChild(nameInput);

        const textField = document.createElement("div");
        textField.className = "moss-tpl-field";
        const textLabel = document.createElement("span");
        textLabel.textContent = "主提示词";
        const textArea = document.createElement("textarea");
        textArea.className = "moss-tpl-textarea";
        textArea.value = text;
        textArea.placeholder = "整段主提示词…";
        textField.appendChild(textLabel);
        textField.appendChild(textArea);

        const foot = document.createElement("div");
        foot.className = "moss-tpl-foot";
        const cancelBtn = document.createElement("button");
        cancelBtn.type = "button";
        cancelBtn.className = "moss-tpl-btn";
        cancelBtn.textContent = "取消";
        const okBtn = document.createElement("button");
        okBtn.type = "button";
        okBtn.className = "moss-tpl-btn moss-tpl-btn--primary";
        okBtn.textContent = "保存";
        foot.appendChild(cancelBtn);
        foot.appendChild(okBtn);

        let settled = false;
        const close = (result) => {
            if (settled) return;
            settled = true;
            document.removeEventListener("keydown", onKey, true);
            mask.remove();
            resolve(result);
        };
        const submit = () => {
            const n = nameInput.value.trim();
            const t = textArea.value.trim();
            if (!n || !t) {
                (n ? textArea : nameInput).focus();
                return;
            }
            close({ name: n, text: t });
        };
        // 正文里 Enter 要能换行，只有 Ctrl/Cmd + Enter 才提交
        const onKey = (e) => {
            if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                close(null);
            } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                e.stopPropagation();
                submit();
            }
        };
        document.addEventListener("keydown", onKey, true);

        mask.addEventListener("click", (e) => {
            if (e.target === mask) close(null);
        });
        cancelBtn.addEventListener("click", () => close(null));
        okBtn.addEventListener("click", submit);

        dialog.appendChild(titleEl);
        dialog.appendChild(sub);
        dialog.appendChild(nameField);
        dialog.appendChild(textField);
        dialog.appendChild(foot);
        mask.appendChild(dialog);
        document.body.appendChild(mask);
        nameInput.focus();
        nameInput.select();
    });
}
