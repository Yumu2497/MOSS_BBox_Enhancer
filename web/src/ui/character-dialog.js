// 角色弹窗：填「角色名 + 角色描述」，确定后由调用方写进主提示词。
// 纯文本功能，不碰 layout_json 的任何字段。

import { ensureTheme } from "./theme.js";

const STYLE_ID = "moss-char-dialog-style";

function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    ensureTheme();
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
.moss-char-mask { position: fixed; inset: 0; z-index: 2147482610; display: flex; align-items: center; justify-content: center; background: rgba(0, 0, 0, 0.45); font-family: system-ui, "Microsoft YaHei", sans-serif; }
.moss-char-dialog { width: 340px; max-width: calc(100vw - 32px); box-sizing: border-box; padding: 14px; border: 1px solid var(--moss-border-strong); border-radius: var(--moss-radius-lg); background: var(--moss-bg); color: var(--moss-text-dim); box-shadow: 0 18px 48px rgba(0, 0, 0, 0.6); }
.moss-char-title { font-size: 14px; font-weight: 600; color: var(--moss-text); }
.moss-char-sub { margin-top: 4px; font-size: 11px; color: var(--moss-text-muted); line-height: 1.5; }
.moss-char-field { display: flex; flex-direction: column; gap: 4px; margin-top: 10px; }
.moss-char-field > span { font-size: 11px; color: var(--moss-text-muted); }
.moss-char-input { width: 100%; box-sizing: border-box; padding: 6px 8px; border: 1px solid var(--moss-border); border-radius: var(--moss-radius-sm); background: #111; color: var(--moss-text); font-size: 12px; font-family: inherit; outline: none; }
.moss-char-input:focus { border-color: var(--moss-accent); }
.moss-char-foot { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
.moss-char-btn { padding: 4px 12px; border: 1px solid var(--moss-border-strong); border-radius: 5px; background: var(--moss-bg-control); color: var(--moss-text-dim); cursor: pointer; font-size: var(--moss-font-sm); font-family: inherit; }
.moss-char-btn:hover { background: var(--moss-bg-control-hover); color: var(--moss-text); }
.moss-char-btn--primary { background: #24405e; border-color: #4a7ab5; color: #dbe9ff; }
.moss-char-btn--primary:hover { background: #2c4f75; }
`;
    document.head.appendChild(style);
}

/**
 * 弹出角色输入框。
 * @returns {Promise<{name: string, desc: string}|null>} 取消返回 null
 */
export function showCharacterDialog({ name = "", desc = "", title: dialogTitle = "增加角色", subtitle } = {}) {
    return new Promise((resolve) => {
        ensureStyle();

        const mask = document.createElement("div");
        mask.className = "moss-char-mask";
        const dialog = document.createElement("div");
        dialog.className = "moss-char-dialog";
        dialog.setAttribute("role", "dialog");
        dialog.setAttribute("aria-modal", "true");
        dialog.setAttribute("aria-label", dialogTitle);

        const title = document.createElement("div");
        title.className = "moss-char-title";
        title.textContent = dialogTitle;
        const sub = document.createElement("div");
        sub.className = "moss-char-sub";
        sub.textContent = subtitle || "会作为一行追加到主提示词末尾，删除角色时同一行一并移除。";

        const makeField = (labelText, placeholder, value) => {
            const field = document.createElement("div");
            field.className = "moss-char-field";
            const label = document.createElement("span");
            label.textContent = labelText;
            const input = document.createElement("input");
            input.type = "text";
            input.className = "moss-char-input";
            input.placeholder = placeholder;
            input.value = value;
            field.appendChild(label);
            field.appendChild(input);
            return { field, input };
        };

        const nameField = makeField("角色名", "比如：少女A", name);
        const descField = makeField("角色描述", "比如：坐姿", desc);

        const foot = document.createElement("div");
        foot.className = "moss-char-foot";
        const cancelBtn = document.createElement("button");
        cancelBtn.type = "button";
        cancelBtn.className = "moss-char-btn";
        cancelBtn.textContent = "取消";
        const okBtn = document.createElement("button");
        okBtn.type = "button";
        okBtn.className = "moss-char-btn moss-char-btn--primary";
        okBtn.textContent = "确定";
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
            const n = nameField.input.value.trim();
            if (!n) {
                nameField.input.focus();
                return;
            }
            close({ name: n, desc: descField.input.value.trim() });
        };
        const onKey = (e) => {
            if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                close(null);
            } else if (e.key === "Enter") {
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

        dialog.appendChild(title);
        dialog.appendChild(sub);
        dialog.appendChild(nameField.field);
        dialog.appendChild(descField.field);
        dialog.appendChild(foot);
        mask.appendChild(dialog);
        document.body.appendChild(mask);
        nameField.input.focus();
        nameField.input.select();
    });
}
