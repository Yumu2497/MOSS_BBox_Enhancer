import { BUILTIN_GROUPS } from "./preset-data.js";
import { ensureTheme } from "../ui/theme.js";

// 提示词预设弹层：点标签只是选中，可多选；点右上角「写入」才落到描述里
const STYLE_ID = "moss-preset-style";
const API = "/moss/presets";
const LS_KEY = "moss-user-presets";
const CHANGE_EVENT = "moss-presets-changed";
const NEW_TYPE = "__moss_new_type__";

function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    ensureTheme();
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
.moss-preset-panel { display: flex; flex-direction: column; gap: 8px; width: 100%; max-height: 68vh; font-size: 12px; color: var(--moss-text-dim); box-sizing: border-box; position: relative; }
.moss-preset-head { display: flex; align-items: center; gap: 8px; margin: 0 -10px; padding: 0 10px 6px 14px; border-bottom: 1px solid var(--moss-border); flex: 0 0 auto; }
.moss-preset-body { display: flex; flex-direction: column; gap: 8px; flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 0 2px 0 4px; }
.moss-preset-title { font-weight: bold; color: var(--moss-text); }
.moss-preset-count { color: var(--moss-text-muted); font-size: 11px; }
.moss-preset-preview { display: flex; flex-direction: column; gap: 2px; flex: 0 0 auto; padding: 5px 7px; border: 1px solid #3a3a3a; border-radius: 5px; background: #202020; }
.moss-preset-preview-line { display: flex; align-items: flex-start; gap: 6px; }
.moss-preset-preview-hint { display: none; color: #c8a45c; font-size: 11px; line-height: 15px; }
.moss-preset-preview-hint.is-on { display: block; }
.moss-preset-preview-label { flex: 0 0 auto; color: #7d7d7d; font-size: 11px; line-height: 16px; user-select: none; }
.moss-preset-preview-text { flex: 1 1 0; min-width: 0; max-height: 64px; overflow-y: auto; color: #dbe9ff; font-size: 11px; line-height: 16px; word-break: break-word; }
.moss-preset-preview-text.is-empty { color: #666; }
.moss-preset-clear { margin-left: auto; padding: 3px 10px; border: 1px solid #555; border-radius: 5px; background: #2a2a2a; color: #ccc; cursor: pointer; font-size: 11px; white-space: nowrap; }
.moss-preset-clear:hover { background: #3a3a3a; color: #fff; }
.moss-preset-clear:disabled { opacity: 0.4; cursor: default; }
.moss-preset-apply { padding: 3px 12px; border: 1px solid #4a7ab5; border-radius: 5px; background: #24405e; color: #dbe9ff; cursor: pointer; font-size: 12px; white-space: nowrap; }
.moss-preset-apply:hover { background: #2c4c6e; border-color: #6bb0ff; color: #fff; }
.moss-preset-apply:disabled { opacity: 0.4; cursor: default; }
.moss-preset-scroll { display: flex; flex-direction: column; gap: 9px; }
.moss-preset-group-name { display: inline-flex; align-items: center; gap: 0; box-sizing: border-box; max-width: 100%; margin: 0 0 5px; padding: 1px 4px; border-radius: 4px; font-size: 11px; color: #999; user-select: none; -webkit-user-select: none; transition: background 120ms ease, color 120ms ease; }
.moss-preset-group-name.is-prefix { color: #ff7b7b; }
.moss-preset-group-name.is-custom { cursor: pointer; }
.moss-preset-group-name.is-custom:hover { background: #333; color: #ccc; }
.moss-preset-group-name.is-prefix.is-custom:hover { color: #ff7b7b; }
.moss-preset-group-name.is-armed { background: #3a3a3a; }
.moss-preset-group-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.moss-preset-group-del { display: flex; align-items: center; justify-content: center; flex: 0 0 auto; box-sizing: border-box; width: 0; height: 14px; margin-left: 0; padding: 0; border: 0 solid #7a3a3a; border-radius: 3px; background: transparent; color: #ffb3b3; font-size: 12px; line-height: 1; cursor: pointer; opacity: 0; overflow: hidden; transform: translateX(5px); transition: width 140ms ease, margin-left 140ms ease, opacity 140ms ease, transform 140ms ease, background 120ms ease; }
.moss-preset-group-del.is-on { width: 15px; margin-left: 3px; border-width: 1px; opacity: 1; transform: none; background: #4a2424; }
.moss-preset-group-del:hover { background: #6a2f2f; color: #fff; }
.moss-preset-group-rename { box-sizing: border-box; width: 120px; min-width: 0; padding: 0 4px; border: 1px solid #4a9eff; border-radius: 3px; background: #1e1e1e; color: #eee; font-size: 11px; line-height: 15px; outline: none; }
.moss-preset-group-name.is-renaming { background: #2a2a2a; }
.moss-preset-group-name.is-renaming .moss-preset-group-del { display: none; }
.moss-preset-row { display: flex; align-items: flex-start; gap: 6px; padding-left: 4px; }
.moss-preset-row + .moss-preset-row { margin-top: 5px; }
.moss-preset-row-label { flex: 0 0 24px; color: #7d7d7d; font-size: 11px; line-height: 19px; user-select: none; }
.moss-preset-row .moss-preset-chips { flex: 1 1 0; min-width: 0; }
.moss-preset-chips { display: flex; flex-wrap: wrap; gap: 5px; }
.moss-preset-chip { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border: 1px solid #444; border-radius: 999px; background: #2a2a2a; color: #ccc; cursor: pointer; font-size: 11px; user-select: none; }
.moss-preset-chip:hover { border-color: #777; color: #fff; }
.moss-preset-chip.is-selected { background: #24405e; border-color: #4a9eff; color: #dbe9ff; }
.moss-preset-chip-prefix { display: none; flex: 0 0 auto; width: 5px; height: 5px; border-radius: 50%; background: #ff7b7b; }
.moss-preset-chip.is-prefixed .moss-preset-chip-prefix { display: inline-block; }
.moss-preset-del { padding: 0 2px; color: #888; font-size: 12px; line-height: 1; }
.moss-preset-del:hover { color: #ff7b7b; }
.moss-preset-empty { font-size: 11px; color: #666; }
.moss-preset-add { display: flex; gap: 5px; padding-top: 8px; border-top: 1px solid #444; }
.moss-preset-add select, .moss-preset-add input { min-width: 0; padding: 3px 6px; border: 1px solid #444; border-radius: 4px; background: #2a2a2a; color: #ddd; font-size: 11px; box-sizing: border-box; }
.moss-preset-add select { flex: 0 0 92px; }
.moss-preset-add input { flex: 1 1 0; }
.moss-preset-add button, .moss-preset-newtype button { flex: 0 0 auto; padding: 3px 10px; border: 1px solid #555; border-radius: 4px; background: #333; color: #ddd; cursor: pointer; font-size: 11px; }
.moss-preset-add button:hover, .moss-preset-newtype button:hover { background: #444; color: #fff; }
.moss-preset-newtype { display: none; gap: 5px; }
.moss-preset-newtype > input { flex: 1 1 0; min-width: 0; padding: 3px 6px; border: 1px solid #444; border-radius: 4px; background: #2a2a2a; color: #ddd; font-size: 11px; }
.moss-preset-newtype-check { display: flex; align-items: center; gap: 4px; flex: 0 0 auto; color: #999; font-size: 11px; white-space: nowrap; user-select: none; cursor: pointer; }
.moss-preset-newtype-check:hover { color: #ddd; }
.moss-preset-newtype-check input { margin: 0; cursor: pointer; }
.moss-preset-tip { display: flex; flex-direction: column; flex: 0 0 auto; font-size: 11px; color: #777; line-height: 1.5; }
.moss-preset-tip-head { display: flex; align-items: flex-start; gap: 4px; padding: 1px 2px; border-radius: 3px; cursor: pointer; }
.moss-preset-tip-head:hover { color: #aaa; }
.moss-preset-tip-head:focus-visible { outline: 1px solid #4a9eff; outline-offset: 1px; }
.moss-preset-tip-arrow { flex: 0 0 auto; width: 0; height: 0; margin-top: 5px; border-left: 4px solid #777; border-top: 3.5px solid transparent; border-bottom: 3.5px solid transparent; transition: transform 120ms ease, border-left-color 120ms ease; }
.moss-preset-tip-head:hover .moss-preset-tip-arrow { border-left-color: #aaa; }
.moss-preset-tip.is-open .moss-preset-tip-arrow { transform: rotate(90deg); }
.moss-preset-tip-label { flex: 0 0 auto; }
.moss-preset-tip-text { flex: 1 1 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.moss-preset-tip.is-open .moss-preset-tip-text { white-space: normal; overflow: visible; }
.moss-preset-confirm { display: none; position: absolute; inset: 0; z-index: 5; align-items: center; justify-content: center; padding: 12px; background: rgba(0, 0, 0, 0.62); border-radius: 6px; }
.moss-preset-confirm.is-on { display: flex; }
.moss-preset-confirm-box { width: 100%; max-width: 260px; padding: 12px; border: 1px solid #555; border-radius: 6px; background: #262626; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45); }
.moss-preset-confirm-title { color: #eee; font-size: 12px; font-weight: bold; word-break: break-word; }
.moss-preset-confirm-desc { margin: 6px 0 10px; color: #999; font-size: 11px; line-height: 1.5; }
.moss-preset-confirm-actions { display: flex; justify-content: flex-end; gap: 6px; }
.moss-preset-confirm-actions button { padding: 3px 10px; border: 1px solid #555; border-radius: 5px; background: #333; color: #ddd; cursor: pointer; font-size: 11px; }
.moss-preset-confirm-actions button:hover { background: #444; color: #fff; }
.moss-preset-confirm-del { border-color: #7a3a3a !important; background: #4a2424 !important; color: #ffb3b3 !important; }
.moss-preset-confirm-del:hover { background: #5c2b2b !important; color: #fff !important; }
`;
    document.head.appendChild(style);
}

const keyOf = (group, text) => group + "\u0000" + text;

export function createPresetPanel({ onApply, onToast, fetchImpl } = {}) {
    ensureStyle();

    const fetchFn = fetchImpl || ((...args) => fetch(...args));
    let customGroups = [];
    const selected = new Map();
    let pendingDelete = null;

    const el = document.createElement("div");
    el.className = "moss-preset-panel";

    const head = document.createElement("div");
    head.className = "moss-preset-head";
    const title = document.createElement("span");
    title.className = "moss-preset-title";
    title.textContent = "提示词预设";
    const count = document.createElement("span");
    count.className = "moss-preset-count";
    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "moss-preset-clear";
    clearBtn.textContent = "取消选中";
    clearBtn.title = "清空已选中的标签（不会改动描述）";
    const applyBtn = document.createElement("button");
    applyBtn.type = "button";
    applyBtn.className = "moss-preset-apply";
    applyBtn.textContent = "写入";
    applyBtn.title = "写入选中的标签（按住 Shift 覆盖描述）";
    head.appendChild(title);
    head.appendChild(count);
    head.appendChild(clearBtn);
    head.appendChild(applyBtn);

    // 预览条固定在标题栏下方：按选中顺序拼出真正会写入的描述文本
    const preview = document.createElement("div");
    preview.className = "moss-preset-preview";
    const previewLine = document.createElement("div");
    previewLine.className = "moss-preset-preview-line";
    const previewLabel = document.createElement("span");
    previewLabel.className = "moss-preset-preview-label";
    previewLabel.textContent = "预览";
    previewLabel.title = "按选中顺序拼接，写入时用「, 」连接；方向起点与终点会拼成一段";
    const previewText = document.createElement("div");
    previewText.className = "moss-preset-preview-text is-empty";
    const previewHint = document.createElement("div");
    previewHint.className = "moss-preset-preview-hint";
    previewLine.appendChild(previewLabel);
    previewLine.appendChild(previewText);
    preview.appendChild(previewLine);
    preview.appendChild(previewHint);

    // 标签与自定义区共用一个滚动容器，顶部「取消选中 / 写入」始终可见
    const body = document.createElement("div");
    body.className = "moss-preset-body";
    const scroll = document.createElement("div");
    scroll.className = "moss-preset-scroll";

    const addRow = document.createElement("div");
    addRow.className = "moss-preset-add";
    const typeSelect = document.createElement("select");
    typeSelect.className = "moss-preset-type";
    const contentInput = document.createElement("input");
    contentInput.className = "moss-preset-content";
    contentInput.type = "text";
    contentInput.placeholder = "内容（写什么就填什么）";
    const addBtn = document.createElement("button");
    addBtn.className = "moss-preset-add-btn";
    addBtn.type = "button";
    addBtn.textContent = "添加";
    addRow.appendChild(typeSelect);
    addRow.appendChild(contentInput);
    addRow.appendChild(addBtn);

    const newTypeRow = document.createElement("div");
    newTypeRow.className = "moss-preset-newtype";
    const newTypeInput = document.createElement("input");
    newTypeInput.className = "moss-preset-newtype-input";
    newTypeInput.type = "text";
    newTypeInput.placeholder = "新类型名称";
    const newTypeBtn = document.createElement("button");
    newTypeBtn.className = "moss-preset-newtype-btn";
    newTypeBtn.type = "button";
    newTypeBtn.textContent = "创建";
    // 自建类型默认不带前缀，勾选后才在写入时拼「类型名：」
    const newTypeCheck = document.createElement("label");
    newTypeCheck.className = "moss-preset-newtype-check";
    newTypeCheck.title = "勾选后，这个类型的预设写入时会带上「类型名：」前缀";
    const newTypePrefix = document.createElement("input");
    newTypePrefix.type = "checkbox";
    newTypePrefix.className = "moss-preset-newtype-prefix";
    const newTypeCheckText = document.createElement("span");
    newTypeCheckText.textContent = "带前缀";
    newTypeCheck.appendChild(newTypePrefix);
    newTypeCheck.appendChild(newTypeCheckText);
    newTypeRow.appendChild(newTypeInput);
    newTypeRow.appendChild(newTypeCheck);
    newTypeRow.appendChild(newTypeBtn);

    // 说明默认收成一行，点三角形（或整行）展开；折叠时超出部分用省略号截断
    const tip = document.createElement("div");
    tip.className = "moss-preset-tip";
    const tipHead = document.createElement("div");
    tipHead.className = "moss-preset-tip-head";
    tipHead.tabIndex = 0;
    tipHead.setAttribute("role", "button");
    const tipArrow = document.createElement("span");
    tipArrow.className = "moss-preset-tip-arrow";
    const tipLabel = document.createElement("span");
    tipLabel.className = "moss-preset-tip-label";
    tipLabel.textContent = "Tips:";
    const tipText = document.createElement("span");
    tipText.className = "moss-preset-tip-text";
    tipText.textContent = "点标签选中，可多选；「写入」追加到描述，按住 Shift 点「写入」覆盖描述。「方向」的起点 + 终点会拼成一段，中间不加逗号。红色标题的类型会自动带上「类型名：」前缀，选中后按住 Alt 点标签可切换带不带。自建类型的标题双击可以改名，单击后点右侧 × 或直接右键标题可删除。自定义项保存在插件根目录。";
    tipHead.appendChild(tipArrow);
    tipHead.appendChild(tipLabel);
    tipHead.appendChild(tipText);
    tip.appendChild(tipHead);

    const toggleTip = () => {
        const open = tip.classList.toggle("is-open");
        tipHead.title = open ? "点击收起说明" : "点击展开完整说明";
    };
    tipHead.title = "点击展开完整说明";
    tipHead.addEventListener("click", toggleTip);
    tipHead.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggleTip();
        }
    });

    // 删除自建类型的确认层：盖住整个弹层，点空白处或「取消」都不会删
    const confirmLayer = document.createElement("div");
    confirmLayer.className = "moss-preset-confirm";
    confirmLayer.tabIndex = -1;
    const confirmBox = document.createElement("div");
    confirmBox.className = "moss-preset-confirm-box";
    const confirmTitle = document.createElement("div");
    confirmTitle.className = "moss-preset-confirm-title";
    const confirmDesc = document.createElement("div");
    confirmDesc.className = "moss-preset-confirm-desc";
    const confirmActions = document.createElement("div");
    confirmActions.className = "moss-preset-confirm-actions";
    const confirmCancel = document.createElement("button");
    confirmCancel.type = "button";
    confirmCancel.className = "moss-preset-confirm-cancel";
    confirmCancel.textContent = "取消";
    const confirmDelete = document.createElement("button");
    confirmDelete.type = "button";
    confirmDelete.className = "moss-preset-confirm-del";
    confirmDelete.textContent = "删除";
    confirmActions.appendChild(confirmCancel);
    confirmActions.appendChild(confirmDelete);
    confirmBox.appendChild(confirmTitle);
    confirmBox.appendChild(confirmDesc);
    confirmBox.appendChild(confirmActions);
    confirmLayer.appendChild(confirmBox);

    body.appendChild(scroll);
    body.appendChild(addRow);
    body.appendChild(newTypeRow);
    body.appendChild(tip);
    el.appendChild(head);
    el.appendChild(preview);
    el.appendChild(body);
    el.appendChild(confirmLayer);

    const groupNames = () => {
        const names = BUILTIN_GROUPS.map((g) => g.name);
        customGroups.forEach((g) => {
            if (!names.includes(g.name)) names.push(g.name);
        });
        return names;
    };

    // 同名类型合并展示：内置项只读，用户加的项带删除按钮。
    // rows 让「方向」这类分组按起点 / 终点分行；pair 可以把多行都标成同一种角色
    // （方向是每个角色占两行：正方向一行、斜方向一行），配对时只看角色不看行号。
    // prefix 是写入前缀：内置组由数据声明，自建类型由新建时的勾选框决定。
    const mergedGroups = () => {
        const map = new Map();
        BUILTIN_GROUPS.forEach((g) => {
            const source = g.rows || [g.items || []];
            const pair = g.pair || null;
            const startRows = pair ? [].concat(pair.start) : [];
            const endRows = pair ? [].concat(pair.end) : [];
            const prefix = g.prefix ? g.name : "";
            const rows = source.map((row, idx) => {
                let kind = "";
                if (startRows.includes(idx)) kind = "start";
                else if (endRows.includes(idx)) kind = "end";
                return { kind, items: row.map((text) => ({ text, own: false, kind, prefix })) };
            });
            map.set(g.name, { name: g.name, rows, prefix, custom: false });
        });
        customGroups.forEach((g) => {
            if (!map.has(g.name)) {
                map.set(g.name, {
                    name: g.name,
                    rows: [],
                    prefix: g.prefix ? g.name : "",
                    // 只有纯自建类型能整组删除，内置同名类型不行
                    custom: true,
                });
            }
            const target = map.get(g.name);
            if (g.items.length) {
                // 自定义项不参与配对，始终是普通的独立预设；前缀跟随所在类型
                target.rows.push({
                    kind: "",
                    items: g.items.map((text) => ({ text, own: true, kind: "", prefix: target.prefix })),
                });
            }
        });
        return Array.from(map.values());
    };

    // 把选区拼成「段」：方向组按起点 / 终点行内先后两两配对，段内不加逗号；
    // 段的位置取两半里先被选中的那个槽位，所以先点起点还是先点终点结果一致。
    // prefixOn 是每项的实时前缀开关，Alt+点选可以逐项反转。
    const buildTokens = () => {
        const tokens = [];
        const dirs = new Map();
        Array.from(selected.values()).forEach((entry, idx) => {
            if (entry.kind !== "start" && entry.kind !== "end") {
                const text = entry.prefixOn ? `${entry.group}：${entry.text}` : entry.text;
                tokens.push({ text, at: idx });
                return;
            }
            const bucketKey = entry.group;
            if (!dirs.has(bucketKey)) dirs.set(bucketKey, { starts: [], ends: [] });
            const bucket = dirs.get(bucketKey);
            (entry.kind === "start" ? bucket.starts : bucket.ends).push({ text: entry.text, at: idx });
        });
        let loneStarts = 0;
        let loneEnds = 0;
        dirs.forEach((bucket) => {
            const pairs = Math.min(bucket.starts.length, bucket.ends.length);
            for (let i = 0; i < pairs; i += 1) {
                const start = bucket.starts[i];
                const end = bucket.ends[i];
                tokens.push({ text: start.text + end.text, at: Math.min(start.at, end.at) });
            }
            bucket.starts.slice(pairs).forEach((half) => {
                loneStarts += 1;
                tokens.push({ text: half.text, at: half.at });
            });
            bucket.ends.slice(pairs).forEach((half) => {
                loneEnds += 1;
                tokens.push({ text: half.text, at: half.at });
            });
        });
        tokens.sort((a, b) => a.at - b.at);
        return { texts: tokens.map((t) => t.text), loneStarts, loneEnds };
    };

    // 选中顺序即写入顺序（Map 保持插入顺序），预览直接给出拼接结果
    const updatePreview = () => {
        const state = buildTokens();
        const joined = state.texts.join(", ");
        previewText.textContent = state.texts.length ? joined : "选中标签后在这里预览顺序";
        previewText.classList.toggle("is-empty", !state.texts.length);
        previewText.title = state.texts.length ? joined : "";

        // 有半截没配上时提醒一句，避免以为写进去的是完整方向
        const lone = state.loneStarts + state.loneEnds;
        if (lone && state.loneStarts) {
            previewHint.textContent = `还有 ${state.loneStarts} 个起点没配对，会单独写入`;
        } else if (lone && state.loneEnds) {
            previewHint.textContent = `还有 ${state.loneEnds} 个终点没配对，会单独写入`;
        }
        previewHint.classList.toggle("is-on", !!lone);
        return state.texts;
    };

    const updateCount = () => {
        const texts = updatePreview();
        if (!selected.size) {
            count.textContent = "未选中";
        } else if (texts.length !== selected.size) {
            count.textContent = `已选 ${selected.size} 项 · ${texts.length} 段`;
        } else {
            count.textContent = `已选 ${selected.size} 项`;
        }
        applyBtn.disabled = selected.size === 0;
        clearBtn.disabled = selected.size === 0;
    };

    const renderTypeOptions = () => {
        const prev = typeSelect.value;
        typeSelect.innerHTML = "";
        groupNames().forEach((name) => {
            const opt = document.createElement("option");
            opt.value = name;
            opt.textContent = name;
            typeSelect.appendChild(opt);
        });
        const optNew = document.createElement("option");
        optNew.value = NEW_TYPE;
        optNew.textContent = "+ 新建类型";
        typeSelect.appendChild(optNew);
        if (prev && Array.from(typeSelect.options).some((o) => o.value === prev)) {
            typeSelect.value = prev;
        }
    };

    const makeChip = (groupName, item) => {
        const chip = document.createElement("span");
        chip.className = "moss-preset-chip";
        const key = keyOf(groupName, item.text);
        const defaultOn = !!item.prefix;
        const current = selected.get(key);
        // 方向的两半只负责配对，不参与前缀切换
        const toggleable = !item.kind;
        const dot = document.createElement("span");
        dot.className = "moss-preset-chip-prefix";
        const label = document.createElement("span");
        label.textContent = item.text;
        chip.appendChild(dot);
        chip.appendChild(label);
        if (current) chip.classList.add("is-selected");
        if (current && current.prefixOn) chip.classList.add("is-prefixed");

        if (item.own) {
            chip.title = toggleable
                ? "点击选中；Alt+点击切换是否带类型前缀；× 删除这个自定义项"
                : "点击选中；× 删除这个自定义项";
        } else if (item.kind === "start") {
            chip.title = "起点：再选一个终点，会拼成「从左到右」这样的一段";
        } else if (item.kind === "end") {
            chip.title = "终点：和起点配对，中间不加逗号";
        } else {
            chip.title = defaultOn
                ? `点击选中；Alt+点击切换是否带类型前缀（默认写入「${groupName}：${item.text}」）`
                : "点击选中；Alt+点击切换是否带类型前缀";
        }

        chip.addEventListener("click", (e) => {
            if (e.altKey && toggleable) {
                e.preventDefault();
                e.stopPropagation();
                const entry = selected.get(key);
                if (entry) {
                    entry.prefixOn = !entry.prefixOn;
                } else {
                    // 没选中就先选中，并按「反转默认值」处理
                    selected.set(key, {
                        group: groupName,
                        text: item.text,
                        kind: item.kind || "",
                        prefixOn: !defaultOn,
                    });
                }
                const next = selected.get(key);
                chip.classList.add("is-selected");
                chip.classList.toggle("is-prefixed", !!next.prefixOn);
                updateCount();
                return;
            }

            if (selected.has(key)) selected.delete(key);
            else selected.set(key, {
                group: groupName,
                text: item.text,
                kind: item.kind || "",
                prefixOn: defaultOn,
            });
            const next = selected.get(key);
            chip.classList.toggle("is-selected", !!next);
            chip.classList.toggle("is-prefixed", !!(next && next.prefixOn));
            updateCount();
        });

        if (item.own) {
            const del = document.createElement("span");
            del.className = "moss-preset-del";
            del.textContent = "×";
            del.title = "删除这个自定义项";
            del.addEventListener("click", (e) => {
                e.stopPropagation();
                removeCustom(groupName, item.text);
            });
            chip.appendChild(del);
        }
        return chip;
    };

    // 单击自建类型标题后延迟滑出的删除按钮：先等一会儿，避开双击的第一下
    const GROUP_DEL_DELAY = 420;
    let armTimer = 0;
    let armedHost = null;
    let armedBtn = null;

    const hideGroupDel = () => {
        if (armTimer) {
            clearTimeout(armTimer);
            armTimer = 0;
        }
        if (armedHost) {
            armedHost.classList.remove("is-armed");
            armedHost = null;
        }
        if (armedBtn) {
            armedBtn.classList.remove("is-on");
            armedBtn = null;
        }
    };

    // 双击标题就地改名：只展开一个输入框，Enter / 失焦提交，Esc 放弃
    let renameState = null;

    const commitRename = async (oldName, nextName) => {
        if (!nextName || nextName === oldName) return;
        if (groupNames().includes(nextName)) {
            onToast?.(`类型「${nextName}」已存在`);
            return;
        }
        const group = customGroups.find((g) => g.name === oldName);
        if (!group) return;
        group.name = nextName;
        // 选中项换到新类型的 key 上，选中顺序保持不变
        const entries = Array.from(selected.entries());
        selected.clear();
        entries.forEach(([, entry]) => {
            const owner = entry.group === oldName ? nextName : entry.group;
            selected.set(keyOf(owner, entry.text), { ...entry, group: owner });
        });
        await saveCustom();
        render();
        typeSelect.value = nextName;
        onToast?.(`类型已重命名为「${nextName}」`);
    };

    const endRename = (commit) => {
        const state = renameState;
        if (!state) return;
        renameState = null;
        const next = String(state.inputEl.value || "").trim().slice(0, 40);
        state.inputEl.style.display = "none";
        state.labelEl.style.display = "";
        state.host.classList.remove("is-renaming");
        if (commit) commitRename(state.groupName, next);
    };

    const startRename = (groupName, host, labelEl, inputEl) => {
        if (renameState) endRename(false);
        if (!customGroups.some((g) => g.name === groupName)) return;
        hideGroupDel();
        inputEl.value = groupName;
        labelEl.style.display = "none";
        inputEl.style.display = "inline-block";
        host.classList.add("is-renaming");
        renameState = { groupName, host, labelEl, inputEl };
        inputEl.focus?.();
        inputEl.select?.();
    };

    const render = () => {
        hideGroupDel();
        // 列表重建后旧的输入框已经不在文档里，编辑态作废
        renameState = null;
        scroll.innerHTML = "";
        mergedGroups().forEach((group) => {
            const box = document.createElement("div");
            const name = document.createElement("div");
            name.className = group.prefix ? "moss-preset-group-name is-prefix" : "moss-preset-group-name";
            const nameText = document.createElement("span");
            nameText.className = "moss-preset-group-text";
            nameText.textContent = group.name;
            name.appendChild(nameText);
            const tips = [];
            if (group.prefix) tips.push(`写入时自动带上「${group.prefix}：」前缀`);
            if (group.custom) tips.push("双击标题重命名；单击标题后点右侧 × 删除，右键标题也能删除");
            if (tips.length) name.title = tips.join("；");
            if (group.custom) {
                name.classList.add("is-custom");

                // 双击标题就地改名的输入框，平时藏起来
                const renameInput = document.createElement("input");
                renameInput.type = "text";
                renameInput.className = "moss-preset-group-rename";
                renameInput.maxLength = 40;
                renameInput.style.display = "none";
                renameInput.title = "改名后按回车确认，Esc 取消";
                renameInput.addEventListener("click", (e) => e.stopPropagation());
                renameInput.addEventListener("dblclick", (e) => e.stopPropagation());
                renameInput.addEventListener("keydown", (e) => {
                    // 别让按键漏到画布快捷键
                    e.stopPropagation();
                    if (e.key === "Enter") {
                        e.preventDefault();
                        endRename(true);
                    } else if (e.key === "Escape") {
                        e.preventDefault();
                        endRename(false);
                    }
                });
                renameInput.addEventListener("blur", () => endRename(true));
                name.appendChild(renameInput);

                const groupDel = document.createElement("button");
                groupDel.type = "button";
                groupDel.className = "moss-preset-group-del";
                groupDel.textContent = "×";
                groupDel.title = `删除类型「${group.name}」`;
                groupDel.setAttribute("aria-label", `删除类型「${group.name}」`);
                groupDel.addEventListener("click", (e) => {
                    e.stopPropagation();
                    hideGroupDel();
                    openDeleteConfirm(group.name);
                });
                name.appendChild(groupDel);

                name.addEventListener("click", (e) => {
                    // 标题的点击自己处理，别让下面那条「点别处收起」把刚起的计时器掐掉
                    e.stopPropagation();
                    if (renameState && renameState.host === name) return;
                    if (e.detail > 1) return;
                    // 已经滑出时再单击标题就收起
                    if (armedBtn === groupDel) {
                        hideGroupDel();
                        return;
                    }
                    hideGroupDel();
                    armTimer = setTimeout(() => {
                        armTimer = 0;
                        armedHost = name;
                        armedBtn = groupDel;
                        name.classList.add("is-armed");
                        groupDel.classList.add("is-on");
                    }, GROUP_DEL_DELAY);
                });
                // 第二次按下会触发浏览器选词，提前拦掉，免得划词工具跟着弹窗
                name.addEventListener("mousedown", (e) => {
                    if (e.detail > 1) e.preventDefault();
                });
                // 右键 = 删除（和插件里标签的「双击编辑、右键删除」保持一致）
                name.addEventListener("contextmenu", (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    endRename(false);
                    hideGroupDel();
                    openDeleteConfirm(group.name);
                });
                // 双击 = 改名
                name.addEventListener("dblclick", (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    startRename(group.name, name, nameText, renameInput);
                });
            }
            box.appendChild(name);

            const rows = group.rows.length ? group.rows : [{ kind: "", items: [] }];
            const hasRowLabels = rows.some((row) => !!row.kind);
            let prevKind = "";
            rows.forEach((row) => {
                const rowEl = document.createElement("div");
                rowEl.className = "moss-preset-row";
                if (row.kind || hasRowLabels) {
                    // 同一分组里用户自定义行没有标签，补个占位保持左侧对齐；
                    // 同一角色连着的第二行（斜方向那行）也留空，不重复写「起点」
                    const rowLabel = document.createElement("span");
                    rowLabel.className = "moss-preset-row-label";
                    if (row.kind && row.kind !== prevKind) {
                        rowLabel.textContent = row.kind === "start" ? "起点" : "终点";
                    }
                    rowEl.appendChild(rowLabel);
                }
                if (row.kind) prevKind = row.kind;
                const chips = document.createElement("div");
                chips.className = "moss-preset-chips";
                if (!row.items.length) {
                    const empty = document.createElement("span");
                    empty.className = "moss-preset-empty";
                    empty.textContent = "暂无预设";
                    chips.appendChild(empty);
                } else {
                    row.items.forEach((item) => chips.appendChild(makeChip(group.name, item)));
                }
                rowEl.appendChild(chips);
                box.appendChild(rowEl);
            });

            scroll.appendChild(box);
        });
        renderTypeOptions();
        updateCount();
    };

    // 点面板别处（标签、输入框、按钮）时收起按钮；标题的点击已在自身处理并阻止冒泡
    el.addEventListener("click", () => {
        if (armTimer || armedHost) hideGroupDel();
    });

    const closeDeleteConfirm = () => {
        pendingDelete = null;
        confirmLayer.classList.remove("is-on");
    };

    const openDeleteConfirm = (name) => {
        const group = customGroups.find((g) => g.name === name);
        if (!group) return;
        pendingDelete = name;
        const count = group.items.length;
        confirmTitle.textContent = `删除类型「${name}」？`;
        confirmDesc.textContent = count
            ? `这个类型下的 ${count} 个预设会一起删除，内置预设不受影响。`
            : "这个类型下还没有预设，删除后分类会消失。";
        confirmLayer.classList.add("is-on");
        // 默认停在「取消」上，避免回车误删
        confirmCancel.focus?.();
    };

    // 只删自建类型本身，内置同名分组里的内容不受影响
    const removeType = async (name) => {
        const group = customGroups.find((g) => g.name === name);
        if (!group) return;
        const count = group.items.length;
        customGroups = customGroups.filter((g) => g.name !== name);
        Array.from(selected.keys()).forEach((key) => {
            if (selected.get(key)?.group === name) selected.delete(key);
        });
        await saveCustom();
        render();
        onToast?.(`已删除类型「${name}」${count ? `（含 ${count} 个预设）` : ""}`);
    };

    const readLocal = () => {
        try {
            const raw = localStorage.getItem(LS_KEY);
            if (!raw) return [];
            const parsed = JSON.parse(raw);
            const groups = Array.isArray(parsed) ? parsed : parsed && parsed.groups;
            return Array.isArray(groups) ? groups : [];
        } catch (_) {
            return [];
        }
    };

    const asGroups = (list) =>
        (Array.isArray(list) ? list : []).map((g) => ({
            name: String((g && g.name) || ""),
            items: Array.isArray(g && g.items) ? g.items.filter((t) => typeof t === "string") : [],
            prefix: !!(g && g.prefix),
        })).filter((g) => g.name);

    const saveCustom = async () => {
        try {
            const resp = await fetchFn(API, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ version: 2, groups: customGroups }),
            });
            const data = await resp.json();
            if (!data || !data.success) throw new Error((data && data.error) || "保存失败");
            document.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: { groups: customGroups } }));
            return true;
        } catch (_) {
            try {
                localStorage.setItem(LS_KEY, JSON.stringify(customGroups));
            } catch (err) {
                // 本地存储也不可用时只提示，不阻断本次会话内的使用
            }
            onToast?.("写入文件失败，已存到浏览器本地");
            return false;
        }
    };

    const load = async () => {
        try {
            const resp = await fetchFn(API);
            const data = await resp.json();
            customGroups = asGroups(data && data.groups);
        } catch (_) {
            customGroups = asGroups(readLocal());
        }
        render();
    };

    const addCustom = async () => {
        let groupName = typeSelect.value;
        const wantPrefix = !!newTypePrefix.checked;
        if (groupName === NEW_TYPE) {
            groupName = newTypeInput.value.trim();
            if (!groupName) {
                onToast?.("请填写新类型名称");
                return;
            }
        }
        const text = contentInput.value.trim();
        if (!text) {
            onToast?.("请填写预设内容");
            return;
        }
        let group = customGroups.find((g) => g.name === groupName);
        if (!group) {
            group = { name: groupName, items: [], prefix: wantPrefix };
            customGroups.push(group);
        }
        if (group.items.includes(text)) {
            onToast?.("这个预设已存在");
            return;
        }
        group.items.push(text);
        contentInput.value = "";
        newTypeInput.value = "";
        newTypeRow.style.display = "none";
        await saveCustom();
        render();
        typeSelect.value = groupName;
        onToast?.(`已添加预设「${text}」`);
    };

    const removeCustom = async (groupName, text) => {
        const group = customGroups.find((g) => g.name === groupName);
        if (!group) return;
        group.items = group.items.filter((t) => t !== text);
        selected.delete(keyOf(groupName, text));
        await saveCustom();
        render();
        onToast?.(`已删除预设「${text}」`);
    };

    const createType = async () => {
        const name = newTypeInput.value.trim();
        if (!name) {
            onToast?.("请填写新类型名称");
            return;
        }
        if (groupNames().includes(name)) {
            onToast?.("这个类型已存在");
            return;
        }
        customGroups.push({ name, items: [], prefix: !!newTypePrefix.checked });
        newTypeInput.value = "";
        newTypeRow.style.display = "none";
        await saveCustom();
        render();
        typeSelect.value = name;
        onToast?.(`已添加类型「${name}」`);
    };

    typeSelect.addEventListener("change", () => {
        newTypeRow.style.display = typeSelect.value === NEW_TYPE ? "flex" : "none";
    });
    addBtn.addEventListener("click", addCustom);
    newTypeBtn.addEventListener("click", createType);
    contentInput.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") addCustom();
    });
    newTypeInput.addEventListener("keydown", (e) => e.stopPropagation());

    // 确认层：取消 / 点空白都只关闭，只有「删除」才真删
    confirmCancel.addEventListener("click", closeDeleteConfirm);
    confirmDelete.addEventListener("click", () => {
        const name = pendingDelete;
        closeDeleteConfirm();
        if (name) removeType(name);
    });
    confirmLayer.addEventListener("click", (e) => {
        if (e.target === confirmLayer) closeDeleteConfirm();
    });
    confirmLayer.addEventListener("keydown", (e) => {
        // 别让 Esc / 方向键漏到画布的快捷键处理里
        e.stopPropagation();
        if (e.key === "Escape") {
            e.preventDefault();
            closeDeleteConfirm();
        }
    });

    clearBtn.addEventListener("click", () => {
        selected.clear();
        render();
    });

    applyBtn.addEventListener("click", (e) => {
        if (!selected.size) return;
        const { texts } = buildTokens();
        if (!texts.length) return;
        onApply?.(texts, { overwrite: !!e.shiftKey });
        selected.clear();
        render();
    });

    // 同一个 ComfyUI 页面里可能有多个布局编辑器节点，任一处改动都同步过来
    const onExternalChange = (e) => {
        customGroups = asGroups(e.detail && e.detail.groups);
        render();
    };
    document.addEventListener(CHANGE_EVENT, onExternalChange);

    return {
        el,
        load,
        destroy: () => document.removeEventListener(CHANGE_EVENT, onExternalChange),
    };
}
