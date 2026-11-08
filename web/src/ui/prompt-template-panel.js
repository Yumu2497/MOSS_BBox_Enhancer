// 主提示词模板：把当前 summary.caption 整段存下来，之后一键套用。
// 和「提示词预设」（往框描述里塞标签）不是一回事，两者共用 user_presets.json 的不同分区。

import { createInput, createButton } from "./kit.js";
import { ensureTheme } from "./theme.js";
import { showTemplateDialog } from "./text-dialog.js";

const API = "/moss/presets";

/**
 * @param {object} opts
 * @param {(text: string, opt: {append: boolean}) => void} opts.onApply 套用模板
 * @param {(msg: string) => void} opts.onToast
 * @param {() => string} opts.getText 读取当前主提示词
 */
export function createPromptTemplatePanel({ onApply, onToast, getText, fetchImpl } = {}) {
    ensureTheme();
    const fetchFn = fetchImpl || ((...args) => fetch(...args));
    const toast = (msg) => onToast?.(msg);

    const el = document.createElement("div");
    el.style.cssText = "display: flex; flex-direction: column; gap: 8px; min-width: 0;";

    const saveRow = document.createElement("div");
    saveRow.style.cssText = "display: flex; gap: 6px; align-items: center;";
    const nameInput = createInput({ placeholder: "模板名（留空取首行）" });
    nameInput.style.flex = "1 1 auto";
    const saveBtn = createButton("保存当前", { small: true });
    saveRow.appendChild(nameInput);
    saveRow.appendChild(saveBtn);

    const tip = document.createElement("div");
    tip.textContent = "点击套用（覆盖主提示词），Shift + 点击追加到末尾";
    tip.style.cssText = "font-size: 10px; color: #666; line-height: 1.4;";

    const listEl = document.createElement("div");
    listEl.style.cssText =
        "display: flex; flex-direction: column; gap: 2px; max-height: 260px; overflow-y: auto;";

    const emptyEl = document.createElement("div");
    emptyEl.textContent = "还没有模板";
    emptyEl.style.cssText = "font-size: 11px; color: #666; padding: 6px 0;";

    el.appendChild(saveRow);
    el.appendChild(tip);
    el.appendChild(listEl);
    el.appendChild(emptyEl);

    let templates = [];

    async function load() {
        try {
            const resp = await fetchFn(API);
            const data = await resp.json();
            templates = Array.isArray(data?.templates) ? data.templates : [];
        } catch (_) {
            templates = [];
        }
        render();
        return templates;
    }

    async function persist() {
        try {
            const resp = await fetchFn(API, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                // 只提交 templates，后端会保留已有的 groups
                body: JSON.stringify({ templates }),
            });
            const data = await resp.json();
            if (!data?.success) throw new Error(data?.error || "保存失败");
            if (Array.isArray(data.templates)) templates = data.templates;
            return true;
        } catch (err) {
            toast(`模板保存失败：${err?.message || err}`);
            return false;
        }
    }

    function render() {
        listEl.innerHTML = "";
        emptyEl.style.display = templates.length ? "none" : "";

        templates.forEach((t, index) => {
            const item = document.createElement("div");
            item.className = "moss-tpl-item";

            const head = document.createElement("div");
            head.className = "moss-tpl-head";

            const title = document.createElement("span");
            title.className = "moss-tpl-title";
            title.textContent = t.name;
            head.appendChild(title);

            const edit = createButton("✎", { icon: true, title: "编辑模板" });
            edit.onclick = async (e) => {
                e.stopPropagation();
                const current = templates[index];
                if (!current) return;
                const result = await showTemplateDialog({ name: current.name, text: current.text });
                if (!result) return;
                if (templates.some((x, i) => i !== index && x.name === result.name)) {
                    toast(`模板「${result.name}」已存在`);
                    return;
                }
                templates[index] = result;
                const ok = await persist();
                render();
                if (ok) toast(`已更新模板：${result.name}`);
            };
            const del = createButton("×", { icon: true, title: "删除模板" });
            del.onclick = async (e) => {
                e.stopPropagation();
                templates.splice(index, 1);
                const ok = await persist();
                render();
                if (ok) toast(`已删除模板：${t.name}`);
            };
            head.appendChild(edit);
            head.appendChild(del);

            const preview = document.createElement("div");
            preview.className = "moss-tpl-preview";
            preview.textContent = (t.text || "").replace(/\s+/g, " ").slice(0, 90);

            item.appendChild(head);
            item.appendChild(preview);

            item.title = "点击套用，Shift + 点击追加";
            item.addEventListener("click", (e) => {
                if (e.target.closest("button")) return;
                onApply?.(t.text, { append: e.shiftKey });
            });
            listEl.appendChild(item);
        });
    }

    saveBtn.onclick = async () => {
        const text = (getText?.() || "").trim();
        if (!text) {
            toast("主提示词是空的，先写点内容再存");
            return;
        }
        const firstLine = text.split("\n").map((s) => s.trim()).find(Boolean) || "未命名";
        const name = (nameInput.value || "").trim() || firstLine.slice(0, 20);
        const idx = templates.findIndex((t) => t.name === name);
        if (idx >= 0) templates[idx] = { name, text };
        else templates.unshift({ name, text });
        if (await persist()) {
            nameInput.value = "";
            render();
            toast(idx >= 0 ? `已覆盖模板：${name}` : `已保存模板：${name}`);
        }
    };

    render();
    return { el, load, render };
}
