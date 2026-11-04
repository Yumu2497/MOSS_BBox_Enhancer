import { serializeLayout, normalizeLayoutSchema } from "../core/json-schema.js";
import { openPanelIds } from "../core/panel-registry.js";
import { createEditorModel } from "./editor-model.js";
import { createRibbon, openPopover, closePopover } from "./ribbon.js";

// 框的复制/粘贴缓冲（模块级，可在不同节点的面板之间通用）
let bboxClipboard = [];

export function createFloatingPanel(node, jsonWidget) {
    // 🌟 背景图状态（提前声明，避免 TDZ）
    let bgImage = null;
    let bgOpacity = 0.5;
    let bgActive = false;
    let bgX = 0, bgY = 0, bgW = 0, bgH = 0;
    let bgDragMode = null;
    let bgStartBBox = null;
    let bgStartMouse = { x: 0, y: 0 };
    let bgInitialState = null;
    let bgSource = "none"; // 'manual' | 'auto'

    // 拖动背景图时是否吸附画布边缘/中心（面板里的“吸附”勾选框控制）
    let bgSnap = true;
    // 锁定长宽比：输入尺寸、拖拽边角都按比例同步
    let bgLockRatio = true;

    // 面板里的“尺寸”输入框建好后挂上来（避免上面的函数提前引用导致 TDZ）
    let syncBgSizeHook = null;

    // 🌟 新增：记录所有历史存在过的框的坐标，用于精准识别新建框
    const knownBboxHistory = new Set(); 


    // 🌟 删除背景图
    function deleteBackgroundImage() {
        if (!bgImage) return;
        bgImage = null;
        bgInitialState = null;
        bgSource = "none";
        bgX = 0; bgY = 0; bgW = 0; bgH = 0;
        bgActive = false;
        bgDragMode = null;
        if (bgActiveCb) {
            bgActiveCb.checked = false;
            bgActiveCb.disabled = true;
        }
        if (syncBgSizeHook) syncBgSizeHook();
        if (bgUploadInput) bgUploadInput.value = ""; 
        drawCanvas();
    }

    // 🌟 将图片对象套用为背景图
    function applyBackgroundImage(img, source = "manual") {
        bgImage = img;
        bgSource = source;

        // 导入时使用原图尺寸（1:1 像素），需要铺满时点「⤢ 铺满」
        bgW = img.width;
        bgH = img.height;
        bgX = 0;
        bgY = 0;
        bgInitialState = { x: bgX, y: bgY, w: bgW, h: bgH };
        if (bgActiveCb) bgActiveCb.disabled = false;
        if (syncBgSizeHook) syncBgSizeHook();
        if (typeof drawCanvas === "function") drawCanvas();
    }

    // 🌟 注入面板更新接口（供 node.onExecuted 调用）
    node._mossPanelUpdate = ({ image, clear } = {}) => {
        if (clear) {
            // 只有开关自动加载的图才随开关清理
            if (bgSource === "auto") {
                deleteBackgroundImage();
            }
        } else if (image) {
            // 标记为自动来源
            applyBackgroundImage(image, "auto");
        } else {
            drawCanvas();
        }
    };

    // 🌟 从 Blob/File 加载背景图（文件上传、粘贴共用）
    function loadBackgroundFromBlob(blob) {
        if (!blob || !blob.type || !blob.type.startsWith("image/")) return false;
        const reader = new FileReader();
        reader.onload = (ev) => {
            const img = new Image();
            img.onload = () => applyBackgroundImage(img);
            img.src = ev.target.result;
        };
        reader.readAsDataURL(blob);
        return true;
    }

    // 🌟 核心修复：智能容错，处理空文本与纯文本输入
    const rawVal = (jsonWidget.value || "").trim();
    let needReset = false;
    let finalJsonObj = null;

    if (!rawVal) {
        // 情况 A：完全为空
        needReset = true;
        finalJsonObj = {
            summary: { caption: "" },
            items: [],
            bbox_coord_space: "abs_centralized",
            bbox_format: "yxyx",
        };
    } else {
        try {
            JSON.parse(rawVal); 
            // 解析成功，说明格式合法，什么都不做
        } catch (e) {
            // 情况 B：解析失败（说明用户输入了纯文本），自动包装为 JSON
            needReset = true;
            finalJsonObj = {
                summary: { caption: rawVal }, // 把纯文本直接塞进主提示词
                items: [],
                bbox_coord_space: "abs_centralized",
                bbox_format: "yxyx",
            };
        }
    }

    if (needReset && finalJsonObj) {
        jsonWidget.value = serializeLayout(finalJsonObj);
        if (jsonWidget.callback) jsonWidget.callback(jsonWidget.value);
    }

    const panelId = `moss-bbox-panel-${node.id}`;
    let panel = document.getElementById(panelId);
    if (panel) {
        panel.style.display = "flex";
        panel.style.zIndex = "10000";
        if (node._mossRefreshPanel) node._mossRefreshPanel();
        return;
    }

    // --- 1. 构建主面板 ---
    panel = document.createElement("div");
    panel.id = panelId;
    panel.style.cssText =
        "position: fixed; left: 50%; top: 10%; transform: translateX(-50%); width: 750px; height: 600px; min-width: 450px; min-height: 400px; resize: both; overflow: hidden; background: rgba(30, 30, 30, 0.95); backdrop-filter: blur(10px); border: 1px solid #555; border-radius: 8px; display: flex; flex-direction: column; z-index: 9999; box-shadow: 0 10px 30px rgba(0,0,0,0.8); font-family: sans-serif; color: #eee; font-size: 13px;";

    const header = document.createElement("div");
    header.style.cssText =
        "display: flex; justify-content: space-between; align-items: center; padding: 10px 12px; background: #2a2a2a; border-bottom: 1px solid #444; border-radius: 8px 8px 0 0; font-weight: bold; cursor: move; flex-shrink: 0;";
    
    const titleLeft = document.createElement("div");
    titleLeft.style.cssText = "display: flex; align-items: center; gap: 10px;";
    
    const title = document.createElement("span");
    title.textContent = "边界框管理与预览";
    titleLeft.appendChild(title);

    // 🌟 修改：加上“帮助”文字
    const helpBtn = document.createElement("button");
    helpBtn.textContent = "❓ 帮助";
    helpBtn.title = "查看操作帮助";
    helpBtn.style.cssText = "background: #333; border: 1px solid #555; color: #4a9eff; cursor: pointer; font-size: 11px; padding: 2px 8px; border-radius: 4px; line-height: 1.2; font-weight: normal;";
    
    // 🌟 核心修复 1：阻止 pointerdown 冒泡，防止被标题栏的拖拽逻辑吞噬
    helpBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
    
    helpBtn.onclick = (e) => {
        e.stopPropagation();
        showHelpModal();
    };
    titleLeft.appendChild(helpBtn);

    const closeBtn = document.createElement("button");
    closeBtn.textContent = "✖";
    closeBtn.style.cssText =
        "background: transparent; border: none; color: #aaa; cursor: pointer; font-size: 16px; font-weight: bold;";
    closeBtn.onclick = () => {
        setDetached(false); // 悬浮态要先收回，否则它会留在页面上
        panel.style.display = "none";
        closeColorPopup();
        closePopover();
        openPanelIds.delete(node.id); // 用户主动关闭，不再自动恢复
    };
    
    header.appendChild(titleLeft);
    header.appendChild(closeBtn);
    panel.appendChild(header);

    const contentContainer = document.createElement("div");
    contentContainer.style.cssText =
        "display: flex; flex-direction: row; flex: 1; overflow: hidden;";

    // 左侧容器：包含工具条、画布和编辑面板
    const leftContainer = document.createElement("div");
    leftContainer.style.cssText =
        "flex: 1; position: relative; display: flex; flex-direction: column; border-right: 1px solid #333; overflow: hidden;";

    const ribbon = createRibbon();
    leftContainer.appendChild(ribbon.el);

    const canvasContainer = document.createElement("div");
    canvasContainer.style.cssText =
        "flex: 1; position: relative; display: flex; align-items: center; justify-content: center; background: #111; overflow: hidden;";

        const canvas = document.createElement("canvas");
    canvas.style.cssText =
        "width: 100%; height: 100%; display: block; cursor: crosshair;";
    canvas.tabIndex = 0;
    canvasContainer.appendChild(canvas);

    // ================= 顶部工具条：撤销 / 重做 / 重置视图 =================
    const undoBtn = ribbon.button("undo", "撤销", () => undoEdit());
    const redoBtn = ribbon.button("redo", "重做", () => redoEdit());
    const resetViewBtn = ribbon.button("reset", "重置视图", () => {
        model.view.scale = 1.0;
        model.view.x = 0;
        model.view.y = 0;
        drawCanvas();
    });

    // ================= 右侧栏：主提示词 =================
    const promptWrapper = document.createElement("div");
    promptWrapper.style.cssText = "flex: 0 0 auto; margin: 10px 10px 0; background: #1a1a1a; border: 1px solid #444; border-radius: 6px; display: flex; flex-direction: column; overflow: hidden;";
    
    const promptHeader = document.createElement("div");
    promptHeader.style.cssText = "display: flex; justify-content: space-between; align-items: center; padding: 6px 10px; font-size: 11px; color: #aaa; border-bottom: 1px solid #333; font-weight: bold; cursor: pointer; user-select: none;";
    
    const promptTitle = document.createElement("span");
    promptTitle.textContent = "📝 主提示词 (摘要)";
    
    const toggleIcon = document.createElement("span");
    toggleIcon.textContent = "▼";
    toggleIcon.style.cssText = "font-size: 10px; transition: transform 0.2s;";
    
    promptHeader.appendChild(promptTitle);
    promptHeader.appendChild(toggleIcon);
    
    const promptTextarea = document.createElement("textarea");
    promptTextarea.style.cssText = "width: 100%; height: 80px; box-sizing: border-box; background: transparent; color: #eee; border: none; padding: 8px 10px; font-size: 12px; font-family: sans-serif; resize: vertical; outline: none; line-height: 1.4;";
    promptTextarea.placeholder = "在此输入画面主描述...";

    // 折叠逻辑
    let isPromptExpanded = true;
    promptHeader.onclick = () => {
        isPromptExpanded = !isPromptExpanded;
        promptTextarea.style.display = isPromptExpanded ? "block" : "none";
        promptHeader.style.borderBottom = isPromptExpanded ? "1px solid #333" : "none";
        toggleIcon.style.transform = isPromptExpanded ? "rotate(0deg)" : "rotate(-90deg)";
    };

    // 阻止事件冒泡，防止输入时触发画布快捷键或拖拽
    promptTextarea.addEventListener("mousedown", (e) => e.stopPropagation());
    promptTextarea.addEventListener("wheel", (e) => e.stopPropagation());
    promptTextarea.addEventListener("keydown", (e) => e.stopPropagation());

    promptWrapper.appendChild(promptHeader);
    promptWrapper.appendChild(promptTextarea);
    
    leftContainer.appendChild(canvasContainer);

    // 画布下方的动态编辑面板（属性面板）：默认吸附在画布底部，可切换成独立悬浮窗
    const editorContainer = document.createElement("div");
    editorContainer.className = "moss-editor";
    editorContainer.id = `moss-editor-${node.id}`;

    // 吸附态：画布底部整条
    const DOCKED_STYLE =
        "position: absolute; bottom: 0; left: 0; width: 100%; box-sizing: border-box; display: none; flex-direction: column; padding: 10px 12px; background: rgba(30, 30, 30, 0.95); backdrop-filter: blur(10px); border-top: 1px solid #444; z-index: 10; max-height: 250px; overflow-y: auto;";
    // 独立悬浮态：固定定位，可拖到屏幕任意位置
    const DETACHED_STYLE =
        "position: fixed; box-sizing: border-box; display: none; flex-direction: column; padding: 10px 12px; background: rgba(28, 28, 28, 0.98); backdrop-filter: blur(12px); border: 1px solid #555; border-radius: 8px; z-index: 2147482000; max-height: 70vh; overflow-y: auto; box-shadow: 0 12px 36px rgba(0, 0, 0, 0.7);";
    editorContainer.style.cssText = DOCKED_STYLE;

    // 类型 Tab 切换
    const tabContainer = document.createElement("div");
    tabContainer.style.cssText =
        "display: flex; gap: 2px; margin-bottom: 10px; background: #111; padding: 2px; border-radius: 6px;";
    const objBtn = document.createElement("button");
    objBtn.textContent = "对象";
    const charBtn = document.createElement("button");
    charBtn.textContent = "角色";
    const textBtn = document.createElement("button");
    textBtn.textContent = "文字";
    [objBtn, charBtn, textBtn].forEach((btn) => {
        btn.style.cssText =
            "flex: 1; padding: 6px 0; border: none; border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: bold; transition: 0.2s;";
    });
    tabContainer.appendChild(objBtn);
    tabContainer.appendChild(charBtn);
    tabContainer.appendChild(textBtn);

    // 🌟 独立悬浮按钮：位于属性面板右上角
    const detachBtn = document.createElement("button");
    detachBtn.type = "button";
    detachBtn.textContent = "⧉";
    detachBtn.title = "独立悬浮属性面板（也可在面板空白处双击）";
    detachBtn.style.cssText =
        "flex: 0 0 22px; height: 26px; padding: 0; background: #2a2a2a; border: 1px solid #444; border-radius: 4px; color: #aaa; cursor: pointer; font-size: 12px; line-height: 1;";
    detachBtn.onclick = (e) => {
        e.stopPropagation();
        toggleDetached();
    };
    tabContainer.appendChild(detachBtn);

    editorContainer.appendChild(tabContainer);

    // 框色：只影响画布描边与「边界框」输出，不写进 layout_json
    const frameColorRow = document.createElement("div");
    frameColorRow.style.cssText =
        "display: flex; align-items: center; gap: 8px; margin-bottom: 10px; font-size: 12px; color: #aaa;";

    const frameColorLabel = document.createElement("span");
    frameColorLabel.textContent = "框色";
    frameColorLabel.title = "边框颜色：只用于画布描边和「边界框」输出，不写入 JSON";

    // 直接用原生取色控件当色块：点击就在原地弹出，不会像隐藏 input 那样弹到屏幕外
    const frameColorInput = document.createElement("input");
    frameColorInput.type = "color";
    frameColorInput.className = "moss-frame-color";
    frameColorInput.value = "#ff4a4a";
    frameColorInput.title = "未设置颜色，使用默认描边（点击选择）";

    const frameColorAuto = document.createElement("button");
    frameColorAuto.type = "button";
    frameColorAuto.textContent = "自动";
    frameColorAuto.title = "清除颜色，使用默认描边";
    frameColorAuto.style.cssText =
        "padding: 2px 8px; border-radius: 4px; border: 1px solid #444; background: #2a2a2a; color: #aaa; font-size: 11px; cursor: pointer;";

    frameColorRow.appendChild(frameColorLabel);
    frameColorRow.appendChild(frameColorInput);
    frameColorRow.appendChild(frameColorAuto);
    editorContainer.appendChild(frameColorRow);

    // 框色读写（_color 由 sanitizeItemForJson 自动过滤，不会写进 JSON）
    const syncFrameColorRow = () => {
        const item = model.active >= 0 ? model.items[model.active] : null;
        if (!item) return;
        const color = typeof item._color === "string" ? item._color : "";
        frameColorInput.value = color || "#3a3a3a";
        frameColorInput.classList.toggle("is-auto", !color);
        frameColorInput.title = color
            ? `框色 ${color}（点击修改）`
            : "未设置颜色，使用默认描边（点击选择）";
        frameColorAuto.disabled = !color;
        frameColorAuto.style.opacity = color ? "1" : "0.45";
    };

    const setFrameColor = (color) => {
        const item = model.active >= 0 ? model.items[model.active] : null;
        if (!item) return;
        if (color) item._color = color;
        else delete item._color;
        syncFrameColorRow();
        syncColorWidget();
        drawCanvas();
    };

    // 把各框的颜色写给隐藏控件，后端只在「边界框」输出里使用
    const syncColorWidget = () => {
        const widget = node.widgets?.find((w) => w.name === "bbox_colors");
        if (!widget) return;
        const map = {};
        model.items.forEach((it, i) => {
            if (it && typeof it._color === "string" && it._color) map[i] = it._color;
        });
        const next = Object.keys(map).length ? JSON.stringify(map) : "";
        if (widget.value !== next) widget.value = next;
    };

    frameColorInput.oninput = () => setFrameColor(frameColorInput.value);
    frameColorAuto.onclick = () => setFrameColor("");

    // 独立悬浮时才显示的拖动条（收在面板顶部，按住即可移动）
    const detachBar = document.createElement("div");
    detachBar.style.cssText =
        "display: none; align-items: center; justify-content: space-between; gap: 8px; margin: 0 0 8px; padding: 4px 8px; background: #2a2a2a; border: 1px solid #444; border-radius: 5px; font-size: 11px; color: #999; cursor: move; user-select: none;";
    detachBar.innerHTML =
        '<span>⠿ 按住此条拖动</span><span style="color:#666;">双击空白处收回</span>';
    editorContainer.insertBefore(detachBar, editorContainer.firstChild);

    // 官方 schema 的 label 只有 object / character / text 三种
    const TYPE_TABS = [
        { btn: objBtn, label: "object" },
        { btn: charBtn, label: "character" },
        { btn: textBtn, label: "text" },
    ];
    const updateTypeTabs = (label) => {
        TYPE_TABS.forEach(({ btn, label: value }) => {
            const active = label === value;
            btn.style.background = active ? "#444" : "transparent";
            btn.style.color = active ? "#fff" : "#888";
        });
    };

    // 文字输入框 (仅 text 类型显示)
    const textLabel = document.createElement("div");
    textLabel.textContent = "文字";
    textLabel.style.cssText =
        "font-size: 11px; color: #888; margin-bottom: 4px; display: none;";
    const textArea = document.createElement("textarea");
    textArea.style.cssText =
        "width: 100%; height: 36px; background: #111; color: #eee; border: 1px solid #444; border-radius: 4px; padding: 6px; resize: vertical; font-family: sans-serif; box-sizing: border-box; margin-bottom: 8px; display: none; font-size: 12px;";
    editorContainer.appendChild(textLabel);
    editorContainer.appendChild(textArea);

    // 描述输入框
    const descLabel = document.createElement("div");
    descLabel.textContent = "描述";
    descLabel.style.cssText = "font-size: 11px; color: #888; margin-bottom: 4px;";
    const descArea = document.createElement("textarea");
    descArea.style.cssText =
        "width: 100%; height: 52px; background: #111; color: #eee; border: 1px solid #444; border-radius: 4px; padding: 6px; resize: vertical; font-family: sans-serif; box-sizing: border-box; margin-bottom: 8px; font-size: 12px;";
    editorContainer.appendChild(descLabel);
    editorContainer.appendChild(descArea);

    // 颜色调色板 (多色)
    const colorLabel = document.createElement("div");
    colorLabel.textContent = "调色板";
    colorLabel.style.cssText =
        "font-size: 11px; color: #888; margin-bottom: 4px;";

    // 取色器不再用原生 <input type="color">：它的弹窗位置由浏览器决定，无法夹取。
    // 改为下方自绘浮层（colorPopup），位置完全可控。

    const paletteContainer = document.createElement("div");
    paletteContainer.style.cssText =
        "display: flex; flex-wrap: wrap; gap: 6px; align-items: center;";

    editorContainer.appendChild(colorLabel);
    editorContainer.appendChild(paletteContainer);

    const tagsLabel = document.createElement("div");
    tagsLabel.textContent = "标签";
    tagsLabel.style.cssText = "font-size: 11px; color: #888; margin: 8px 0 4px;";
    const tagsContainer = document.createElement("div");
    tagsContainer.style.cssText = "display: flex; flex-wrap: wrap; gap: 6px; align-items: center;";
    editorContainer.appendChild(tagsLabel);
    editorContainer.appendChild(tagsContainer);

    // 标签的悬浮/选中样式只能靠 CSS（内联样式写不了 :hover）
    const tagStyle = document.createElement("style");
    tagStyle.id = `moss-tag-style-${node.id}`;
    tagStyle.textContent = `
.moss-grip { flex: 0 0 auto; padding: 0 1px; color: #666; font-size: 13px; line-height: 1; letter-spacing: -1px; cursor: grab; user-select: none; transition: color 0.12s; }
.moss-grip:hover { color: #bbb; }
.moss-grip:active { cursor: grabbing; }
.moss-row-placeholder { flex: 0 0 auto; border-radius: 4px; border: 1px dashed #4a9eff; background: rgba(74, 158, 255, 0.10); }
.moss-editor > * { flex-shrink: 0; }
.moss-editor .moss-tag { display: inline-block; padding: 3px 8px; border: 1px solid #555; border-radius: 12px; background: #333; color: #ccc; font-size: 11px; line-height: 1.4; cursor: pointer; user-select: none; transition: background 0.12s, border-color 0.12s, color 0.12s; }
.moss-editor .moss-tag:hover { background: #414141; border-color: #8a8a8a; color: #fff; }
.moss-editor .moss-tag.is-selected { background: #24405e; border-color: #4a9eff; color: #dbe9ff; }
.moss-editor .moss-tag.is-selected:hover { background: #2c4c6e; border-color: #6bb0ff; }
.moss-editor .moss-tag-input { width: 100px; padding: 2px 8px; border-radius: 12px; border: 1px solid #4a9eff; background: #111; color: #eee; font-size: 11px; outline: none; }
.moss-editor .moss-chip-add { width: 24px; height: 24px; padding: 0; box-sizing: border-box; display: flex; align-items: center; justify-content: center; background: #333; border: 1px solid #555; border-radius: 4px; color: #ccc; cursor: pointer; font-size: 16px; line-height: 1; transition: background 0.12s, border-color 0.12s, color 0.12s; }
.moss-editor .moss-chip-add:hover { background: #444; border-color: #8a8a8a; color: #fff; }
.moss-editor .moss-frame-color { -webkit-appearance: none; appearance: none; width: 44px; height: 20px; padding: 0; border: 1px solid #555; border-radius: 4px; background: #3a3a3a; cursor: pointer; transition: border-color 0.12s, opacity 0.12s; }
.moss-editor .moss-frame-color:hover { border-color: #8a8a8a; }
.moss-editor .moss-frame-color.is-auto { opacity: 0.5; }
.moss-editor .moss-frame-color::-webkit-color-swatch-wrapper { padding: 0; }
.moss-editor .moss-frame-color::-webkit-color-swatch { border: none; border-radius: 3px; }
.moss-editor .moss-frame-color::-moz-color-swatch { border: none; border-radius: 3px; }
.moss-editor .moss-swatch { width: 24px; height: 24px; box-sizing: border-box; border-radius: 4px; border: 2px solid #555; cursor: pointer; transition: border-color 0.12s, transform 0.12s, box-shadow 0.12s; }
.moss-editor .moss-swatch:hover { border-color: #8a8a8a; transform: translateY(-1px); }
.moss-editor .moss-swatch.is-selected { border-color: #4a9eff; box-shadow: 0 0 0 2px rgba(74, 158, 255, 0.35); }
.moss-editor .moss-swatch.is-selected:hover { border-color: #6bb0ff; }
`;
    document.head.appendChild(tagStyle);

    let selectedPaletteIndex = -1;
    // 记录“当前高亮”属于哪个框，切换框时才能把残留的选中态清掉
    let selectedPaletteOwner = -1;
    // 🌟 延时开浮层的定时器：双击必须在弹窗之前判定，所以单击要等一小会儿
    let paletteClickTimer = null;

    // 🌟 只切换选中样式，不重建 DOM（重建会打断取色浮层的锚点元素）
    const refreshPaletteHighlight = () => {
        paletteContainer.querySelectorAll("[data-color-idx]").forEach((el) => {
            const idx = Number(el.dataset.colorIdx);
            el.classList.toggle("is-selected", idx === selectedPaletteIndex);
        });
    };

    // 🌟 删除指定色块（双击 / 右键 / Delete 键共用同一条路径）
    const deletePaletteColor = (colorIdx) => {
        const target = model.items[model.active];
        if (!target || !Array.isArray(target.palette)) return;
        if (colorIdx < 0 || colorIdx >= target.palette.length) return;
        if (paletteClickTimer) {
            clearTimeout(paletteClickTimer);
            paletteClickTimer = null;
        }
        closeColorPopup(false);
        target.palette.splice(colorIdx, 1);
        // 空数组不留字段
        if (target.palette.length === 0) delete target.palette;
        selectedPaletteIndex = -1;
        syncEditorPanel();
        saveEditorChanges();
    };

    const deleteSelectedPalette = () => {
        if (model.active === -1 || selectedPaletteIndex < 0) return;
        deletePaletteColor(selectedPaletteIndex);
    };

    // 🌟 「+」按钮：色块栏和标签栏共用同一套外观与行为
    const makeAddChipButton = (title, onClick) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "moss-chip-add";
        btn.textContent = "+";
        btn.title = title;
        btn.onclick = (e) => {
            e.stopPropagation();
            onClick();
        };
        return btn;
    };

    // 🌟 调色板整行重建：色块在前、「+」永远排在最后（与标签栏一致）
    const renderPalette = () => {
        const item = model.items[model.active];
        paletteContainer.innerHTML = "";
        if (!item) return;

        // 换了框就清掉上一个框的选中态
        if (selectedPaletteOwner !== model.active) {
            selectedPaletteIndex = -1;
            selectedPaletteOwner = model.active;
        }

        const palette = Array.isArray(item.palette) ? item.palette : [];

        palette.forEach((color, colorIdx) => {
            const swatch = document.createElement("div");
            swatch.className = "moss-swatch" + (colorIdx === selectedPaletteIndex ? " is-selected" : "");
            swatch.dataset.colorIdx = String(colorIdx);
            swatch.tabIndex = 0;
            swatch.style.backgroundColor = color;
            swatch.title = "单击改颜色，双击或右键删除";

            // 单击：先立刻高亮（反馈要即时），再延时开取色浮层——
            // 那 200ms 是留给双击判定的，双击时绝不弹窗
            swatch.onclick = (e) => {
                e.stopPropagation();
                selectedPaletteIndex = colorIdx;
                selectedPaletteOwner = model.active;
                // 色块和标签是互斥选中，避免 Delete 键删错对象
                selectedTagIndex = -1;
                refreshTagHighlight();
                refreshPaletteHighlight();
                swatch.focus();

                if (paletteClickTimer) clearTimeout(paletteClickTimer);
                paletteClickTimer = setTimeout(() => {
                    paletteClickTimer = null;
                    openColorPopup(swatch, colorIdx);
                }, 200);
            };

            // 双击：先掐掉待开的浮层，再删除
            swatch.ondblclick = (e) => {
                e.stopPropagation();
                if (paletteClickTimer) {
                    clearTimeout(paletteClickTimer);
                    paletteClickTimer = null;
                }
                closeColorPopup(false);
                deletePaletteColor(colorIdx);
            };

            // 右键删除
            swatch.oncontextmenu = (e) => {
                e.preventDefault();
                e.stopPropagation();
                closeColorPopup(false);
                deletePaletteColor(colorIdx);
            };

            paletteContainer.appendChild(swatch);
        });

        paletteContainer.appendChild(
            makeAddChipButton("添加颜色", () => {
                if (model.active === -1) return;
                const cur = model.items[model.active];
                if (!cur) return;
                if (!Array.isArray(cur.palette)) cur.palette = [];
                cur.palette.push("#FFFFFF");
                const newIdx = cur.palette.length - 1;
                selectedPaletteIndex = newIdx;
                selectedPaletteOwner = model.active;
                renderPalette();
                saveEditorChanges();
                // 新建后直接弹取色浮层，和标签栏「点 + 直接进编辑」对齐
                const swatchEl = paletteContainer.querySelector(`[data-color-idx="${newIdx}"]`);
                if (swatchEl) openColorPopup(swatchEl, newIdx);
            })
        );
    };

    // ================= 标签：选中 / 编辑 / 删除 =================
    let selectedTagIndex = -1;
    let selectedTagOwner = -1;
    let editingTagIndex = null; // null=不在编辑; -1=新增; >=0=编辑已有

    const refreshTagHighlight = () => {
        tagsContainer.querySelectorAll(".moss-tag").forEach((el) => {
            const idx = Number(el.dataset.tagIdx);
            el.classList.toggle("is-selected", idx === selectedTagIndex);
        });
    };

    const deleteTag = (tagIdx) => {
        const item = model.items[model.active];
        if (!item || !Array.isArray(item.tags)) return;
        if (tagIdx < 0 || tagIdx >= item.tags.length) return;
        item.tags.splice(tagIdx, 1);
        // 空数组不留字段
        if (item.tags.length === 0) delete item.tags;
        selectedTagIndex = -1;
        editingTagIndex = null;
        renderTags();
        saveEditorChanges();
    };

    // 内联输入框：Enter 提交、Esc 取消、失焦提交（不再依赖原生 prompt，
    // 原生 prompt 被浏览器拦截时会静默失败，表现为“点 + 没反应”）
    const makeTagInput = (tagIdx, value) => {
        const input = document.createElement("input");
        input.type = "text";
        input.className = "moss-tag-input";
        input.value = value || "";
        input.placeholder = tagIdx >= 0 ? "" : "新标签…";

        let finished = false;
        const finish = (ok) => {
            if (finished) return;
            finished = true;
            const cur = model.items[model.active];
            let text = "";
            if (ok && cur) {
                text = input.value.trim();
                if (text) {
                    if (!Array.isArray(cur.tags)) cur.tags = [];
                    if (tagIdx >= 0 && tagIdx < cur.tags.length) cur.tags[tagIdx] = text;
                    else cur.tags.push(text);
                    selectedTagIndex = tagIdx >= 0 ? tagIdx : cur.tags.length - 1;
                    selectedTagOwner = model.active;
                }
            }
            editingTagIndex = null;
            renderTags();
            if (text) saveEditorChanges();
        };

        input.addEventListener("keydown", (e) => {
            // 别让编辑器的 Delete/Backspace 逻辑把标签误删
            e.stopPropagation();
            if (e.key === "Enter") {
                e.preventDefault();
                finish(true);
            } else if (e.key === "Escape") {
                e.preventDefault();
                finish(false);
            }
        });
        input.addEventListener("blur", () => finish(true));
        return input;
    };

    const renderTags = () => {
        const item = model.items[model.active];
        tagsContainer.innerHTML = "";
        if (!item) return;

        // 换了框就清掉上一个框的选中态，并退出编辑
        if (selectedTagOwner !== model.active) {
            selectedTagIndex = -1;
            selectedTagOwner = model.active;
            editingTagIndex = null;
        }

        const tags = Array.isArray(item.tags) ? item.tags : [];

        tags.forEach((tag, idx) => {
            if (editingTagIndex === idx) {
                tagsContainer.appendChild(makeTagInput(idx, tag));
                return;
            }
            const chip = document.createElement("span");
            chip.className = "moss-tag" + (idx === selectedTagIndex ? " is-selected" : "");
            chip.textContent = tag;
            chip.dataset.tagIdx = String(idx);
            chip.tabIndex = 0;
            chip.title = "单击选中，双击编辑，右键或 Delete 删除";

            chip.onclick = (e) => {
                e.stopPropagation();
                selectedTagIndex = idx;
                selectedTagOwner = model.active;
                // 色块和标签是互斥选中
                selectedPaletteIndex = -1;
                refreshPaletteHighlight();
                chip.focus();
                refreshTagHighlight();
            };
            chip.ondblclick = (e) => {
                e.stopPropagation();
                editingTagIndex = idx;
                renderTags();
            };
            chip.oncontextmenu = (e) => {
                e.preventDefault();
                e.stopPropagation();
                deleteTag(idx);
            };
            tagsContainer.appendChild(chip);
        });

        if (editingTagIndex === -1) {
            tagsContainer.appendChild(makeTagInput(-1, ""));
        } else {
            tagsContainer.appendChild(
                makeAddChipButton("添加标签", () => {
                    if (model.active === -1) return;
                    editingTagIndex = -1;
                    renderTags();
                })
            );
        }

        const editingInput = tagsContainer.querySelector(".moss-tag-input");
        if (editingInput && document.activeElement !== editingInput) {
            editingInput.focus();
            editingInput.select();
        }
    };

    editorContainer.addEventListener("keydown", (event) => {
        if (event.key !== "Delete" && event.key !== "Backspace") return;
        // 在输入框里打字时不要触发删除
        const el = event.target;
        if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
        event.preventDefault();
        // 先删选中的标签，没有选中标签再删选中的色块
        if (selectedTagIndex >= 0 && selectedTagOwner === model.active) {
            deleteTag(selectedTagIndex);
            return;
        }
        deleteSelectedPalette();
    });

    // ================= 自绘取色浮层 =================
    // 定位规则（全部由这里掌握，不交给浏览器）：
    //   1. 默认贴在“被选中色块”的右上角，浮层整体位于色块上方；
    //   2. 右边超出视口时停下，不再继续往右（只夹到视口右边缘）；
    //   3. 无论如何都不会翻到色块下方。
    const colorPopup = document.createElement("div");
    colorPopup.id = `moss-color-popup-${node.id}`;
    colorPopup.style.cssText =
        "position: fixed; left: 0; top: 0; display: none; width: 208px; padding: 8px; box-sizing: border-box; " +
        "background: rgba(32,32,32,0.98); border: 1px solid #555; border-radius: 8px; " +
        "box-shadow: 0 10px 28px rgba(0,0,0,0.65); font-family: sans-serif; z-index: 2147483647;";
    document.body.appendChild(colorPopup);

    // 滑块拇指只能靠伪元素样式，内联样式管不到
    const colorPopupStyle = document.createElement("style");
    colorPopupStyle.id = `moss-color-popup-style-${node.id}`;
    colorPopupStyle.textContent = `
#${colorPopup.id} input[type="range"] { -webkit-appearance: none; appearance: none; background: transparent; }
#${colorPopup.id} input[type="range"]::-webkit-slider-thumb { -webkit-appearance: none; width: 14px; height: 14px; border-radius: 50%; background: #fff; border: 2px solid #222; box-shadow: 0 0 0 1px #888; cursor: pointer; }
#${colorPopup.id} input[type="range"]::-moz-range-thumb { width: 12px; height: 12px; border-radius: 50%; background: #fff; border: 2px solid #222; box-shadow: 0 0 0 1px #888; cursor: pointer; }
`;
    document.head.appendChild(colorPopupStyle);

    // 饱和度/明度面板
    const svBox = document.createElement("div");
    svBox.style.cssText =
        "position: relative; width: 100%; height: 108px; border-radius: 4px; cursor: crosshair; touch-action: none; user-select: none; background-color: #f00;";
    const svCursor = document.createElement("div");
    svCursor.style.cssText =
        "position: absolute; left: 0; top: 0; width: 10px; height: 10px; margin: -5px 0 0 -5px; border: 2px solid #fff; border-radius: 50%; box-shadow: 0 0 0 1px rgba(0,0,0,0.7); pointer-events: none;";
    svBox.appendChild(svCursor);
    colorPopup.appendChild(svBox);

    // 色相滑块
    const hueInput = document.createElement("input");
    hueInput.type = "range";
    hueInput.min = "0";
    hueInput.max = "360";
    hueInput.step = "1";
    hueInput.style.cssText =
        "display: block; width: 100%; height: 14px; margin: 10px 0 0; border-radius: 7px; outline: none; cursor: pointer; " +
        "background: linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00);";
    colorPopup.appendChild(hueInput);

    // 预览 + 十六进制输入
    const hexRow = document.createElement("div");
    hexRow.style.cssText = "display: flex; align-items: center; gap: 6px; margin-top: 8px;";
    const hexPreview = document.createElement("div");
    hexPreview.style.cssText =
        "width: 22px; height: 22px; flex-shrink: 0; border-radius: 4px; border: 1px solid #555;";
    const hexInput = document.createElement("input");
    hexInput.type = "text";
    hexInput.spellcheck = false;
    hexInput.style.cssText =
        "flex: 1; min-width: 0; background: #111; color: #eee; border: 1px solid #444; border-radius: 4px; " +
        "padding: 4px 6px; font-size: 12px; font-family: monospace; outline: none; text-transform: uppercase;";
    hexRow.appendChild(hexPreview);
    hexRow.appendChild(hexInput);
    colorPopup.appendChild(hexRow);

    // ---- 颜色换算 ----
    const hsvToHex = (h, s, v) => {
        const c = v * s;
        const hp = (((h % 360) + 360) % 360) / 60;
        const x = c * (1 - Math.abs((hp % 2) - 1));
        let r = 0, g = 0, b = 0;
        if (hp < 1) { r = c; g = x; }
        else if (hp < 2) { r = x; g = c; }
        else if (hp < 3) { g = c; b = x; }
        else if (hp < 4) { g = x; b = c; }
        else if (hp < 5) { r = x; b = c; }
        else { r = c; b = x; }
        const m = v - c;
        const toHex = (n) =>
            Math.round(Math.max(0, Math.min(1, n + m)) * 255)
                .toString(16)
                .padStart(2, "0");
        return `#${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase();
    };

    const hexToHsv = (hex) => {
        let raw = String(hex || "").trim().replace(/^#/, "");
        if (!/^([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(raw)) return { h: 0, s: 1, v: 1 };
        if (raw.length === 3) raw = raw.split("").map((c) => c + c).join("");
        const r = parseInt(raw.slice(0, 2), 16) / 255;
        const g = parseInt(raw.slice(2, 4), 16) / 255;
        const b = parseInt(raw.slice(4, 6), 16) / 255;
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const d = max - min;
        let h = 0;
        if (d !== 0) {
            if (max === r) h = ((g - b) / d) % 6;
            else if (max === g) h = (b - r) / d + 2;
            else h = (r - g) / d + 4;
            h *= 60;
            if (h < 0) h += 360;
        }
        return { h: Math.round(h), s: max === 0 ? 0 : d / max, v: max };
    };

    const picker = { h: 0, s: 1, v: 1, colorIdx: -1 };
    let pickerDirty = false;

    // 把 picker 的当前颜色写回数据（不落盘），并刷新浮层
    const applyPickerColor = () => {
        const hex = hsvToHex(picker.h, picker.s, picker.v);

        const pureHue = hsvToHex(picker.h, 1, 1);
        svBox.style.backgroundImage =
            `linear-gradient(to top, #000, rgba(0,0,0,0)), linear-gradient(to right, #fff, ${pureHue})`;
        const boxW = svBox.clientWidth || 192;
        const boxH = svBox.clientHeight || 108;
        svCursor.style.left = `${picker.s * boxW}px`;
        svCursor.style.top = `${(1 - picker.v) * boxH}px`;
        if (String(hueInput.value) !== String(Math.round(picker.h))) {
            hueInput.value = String(Math.round(picker.h));
        }
        hexPreview.style.backgroundColor = hex;
        if (document.activeElement !== hexInput) hexInput.value = hex;

        const item = model.items[model.active];
        if (
            item &&
            Array.isArray(item.palette) &&
            picker.colorIdx >= 0 &&
            picker.colorIdx < item.palette.length
        ) {
            if (item.palette[picker.colorIdx] !== hex) {
                item.palette[picker.colorIdx] = hex;
                pickerDirty = true;
            }
            const swatchEl = paletteContainer.querySelector(`[data-color-idx="${picker.colorIdx}"]`);
            if (swatchEl) swatchEl.style.backgroundColor = hex;
        }
    };

    const commitPickerColor = () => {
        if (!pickerDirty) return;
        pickerDirty = false;
        // 不要在这里重建面板 DOM：commit 可能发生在 pointerdown 阶段，
        // 重建会把「+」这类按钮换掉，导致紧接着的 click 落空。
        saveEditorChanges();
    };

    const closeColorPopup = (commit = true) => {
        if (colorPopup.style.display === "none") return;
        colorPopup.style.display = "none";
        picker.colorIdx = -1;
        if (commit) commitPickerColor();
        pickerDirty = false;
    };

    const openColorPopup = (anchorEl, colorIdx) => {
        const item = model.items[model.active];
        if (!item) return;
        // 延时开窗期间色块可能被重绘过，重新取一次锚点
        if (!anchorEl || !anchorEl.isConnected) {
            anchorEl = paletteContainer.querySelector(`[data-color-idx="${colorIdx}"]`);
            if (!anchorEl) return;
        }
        const current = Array.isArray(item.palette) ? item.palette[colorIdx] : null;
        const hsv = hexToHsv(current || "#FFFFFF");
        picker.h = hsv.h;
        picker.s = hsv.s;
        picker.v = hsv.v;
        picker.colorIdx = colorIdx;
        pickerDirty = false;

        selectedPaletteIndex = colorIdx;
        selectedPaletteOwner = model.active;
        refreshPaletteHighlight();

        // 先显示再测量，否则 offsetHeight 为 0
        colorPopup.style.display = "block";
        applyPickerColor();
        pickerDirty = false;

        const popupW = colorPopup.offsetWidth;
        const popupH = colorPopup.offsetHeight;
        const rect = anchorEl.getBoundingClientRect();
        const margin = 8;

        // 默认：色块右上角外侧，且整体在色块上方
        let left = rect.right + 6;
        let top = rect.top - popupH - 6;

        // 右边到界就停（不越过视口右边缘），左右都夹一次，保证不越界；
        // 顶部同理，但绝不翻到色块下方
        const maxLeft = Math.max(margin, window.innerWidth - margin - popupW);
        if (left > maxLeft) left = maxLeft;
        if (left < margin) left = margin;
        if (top < margin) top = margin;

        colorPopup.style.left = `${Math.round(left)}px`;
        colorPopup.style.top = `${Math.round(top)}px`;
    };

    // ---- 浮层交互 ----
    let isSvDragging = false;
    const updateSvFromPointer = (e) => {
        const rect = svBox.getBoundingClientRect();
        const x = Math.min(Math.max(e.clientX - rect.left, 0), rect.width);
        const y = Math.min(Math.max(e.clientY - rect.top, 0), rect.height);
        picker.s = rect.width ? x / rect.width : 0;
        picker.v = rect.height ? 1 - y / rect.height : 1;
        applyPickerColor();
    };

    svBox.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        isSvDragging = true;
        svBox.setPointerCapture?.(e.pointerId);
        updateSvFromPointer(e);
    });
    svBox.addEventListener("pointermove", (e) => {
        if (isSvDragging) updateSvFromPointer(e);
    });
    const endSvDrag = () => {
        if (!isSvDragging) return;
        isSvDragging = false;
        commitPickerColor();
    };
    svBox.addEventListener("pointerup", endSvDrag);
    svBox.addEventListener("pointercancel", endSvDrag);

    hueInput.addEventListener("input", () => {
        picker.h = Number(hueInput.value) || 0;
        applyPickerColor();
    });
    hueInput.addEventListener("change", () => commitPickerColor());

    hexInput.addEventListener("focus", () => hexInput.select());
    hexInput.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
            e.preventDefault();
            hexInput.blur();
        } else if (e.key === "Escape") {
            e.preventDefault();
            closeColorPopup();
        }
    });
    hexInput.addEventListener("change", () => {
        const hsv = hexToHsv(hexInput.value);
        picker.h = hsv.h;
        picker.s = hsv.s;
        picker.v = hsv.v;
        applyPickerColor();
        commitPickerColor();
    });

    // 点击浮层以外任何地方就收起；点色块自己除外（交给它的 click 重新定位）
    document.addEventListener(
        "pointerdown",
        (e) => {
            if (e.target.closest?.("[data-color-idx]")) return;
            if (colorPopup.contains(e.target)) return;
            // 还没弹出来的延时任务也要掐掉，否则点了别处它仍会冒出来
            if (paletteClickTimer) {
                clearTimeout(paletteClickTimer);
                paletteClickTimer = null;
            }
            closeColorPopup();
        },
        true
    );
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") closeColorPopup();
    });

    // ================= 属性面板：独立悬浮 / 收回 =================
    let isPanelDetached = false;
    let detachedPos = { x: 0, y: 0 };

    const setDetached = (detached) => {
        if (detached === isPanelDetached) return;
        const wasVisible = editorContainer.style.display !== "none";
        isPanelDetached = detached;

        if (detached) {
            // 以当前屏幕位置作为悬浮窗初始位置，并夹进视口
            const rect = editorContainer.getBoundingClientRect();
            const width = Math.min(380, Math.max(280, Math.round(rect.width) || 360));
            const x = Math.min(Math.max(rect.left, 8), Math.max(8, window.innerWidth - width - 8));
            const y = Math.min(Math.max(rect.top, 8), Math.max(8, window.innerHeight - 80));
            detachedPos = { x, y };

            editorContainer.style.cssText = DETACHED_STYLE;
            editorContainer.style.width = `${width}px`;
            editorContainer.style.left = `${x}px`;
            editorContainer.style.top = `${y}px`;
            document.body.appendChild(editorContainer);

            detachBar.style.display = "flex";
            detachBtn.textContent = "⤓";
            detachBtn.title = "收回属性面板（也可在面板空白处双击）";
        } else {
            editorContainer.style.cssText = DOCKED_STYLE;
            leftContainer.appendChild(editorContainer);
            detachBar.style.display = "none";
            detachBtn.textContent = "⧉";
            detachBtn.title = "独立悬浮属性面板（也可在面板空白处双击）";
        }

        if (wasVisible) editorContainer.style.display = "flex";
    };

    const toggleDetached = () => {
        if (model.active === -1) return; // 没有选中框时面板本身是隐藏的
        setDetached(!isPanelDetached);
    };

    // 按住拖动条移动悬浮窗
    let isDraggingDetached = false;
    let detachGrabX = 0;
    let detachGrabY = 0;

    detachBar.addEventListener("pointerdown", (e) => {
        if (e.target.closest("button")) return;
        isDraggingDetached = true;
        const rect = editorContainer.getBoundingClientRect();
        detachGrabX = e.clientX - rect.left;
        detachGrabY = e.clientY - rect.top;
        detachBar.setPointerCapture?.(e.pointerId);
        e.preventDefault();
    });

    detachBar.addEventListener("pointermove", (e) => {
        if (!isDraggingDetached) return;
        const w = editorContainer.offsetWidth || 360;
        const x = Math.min(Math.max(e.clientX - detachGrabX, 0), Math.max(0, window.innerWidth - w));
        const y = Math.min(Math.max(e.clientY - detachGrabY, 0), Math.max(0, window.innerHeight - 40));
        detachedPos = { x, y };
        editorContainer.style.left = `${x}px`;
        editorContainer.style.top = `${y}px`;
    });

    const endDetachDrag = (e) => {
        if (!isDraggingDetached) return;
        isDraggingDetached = false;
        detachBar.releasePointerCapture?.(e.pointerId);
    };
    detachBar.addEventListener("pointerup", endDetachDrag);
    detachBar.addEventListener("pointercancel", endDetachDrag);

    // 空白处双击：独立 / 收回
    editorContainer.addEventListener("dblclick", (e) => {
        const t = e.target;
        if (t.closest("input, textarea, select, button, .moss-tag, .moss-tag-input, .moss-swatch, .moss-chip-add")) return;
        toggleDetached();
    });

    // 窗口变小后把悬浮窗拉回可见区域
    window.addEventListener("resize", () => {
        if (!isPanelDetached) return;
        const w = editorContainer.offsetWidth || 360;
        const x = Math.min(detachedPos.x, Math.max(0, window.innerWidth - w));
        const y = Math.min(detachedPos.y, Math.max(0, window.innerHeight - 40));
        if (x !== detachedPos.x || y !== detachedPos.y) {
            detachedPos = { x, y };
            editorContainer.style.left = `${x}px`;
            editorContainer.style.top = `${y}px`;
        }
    });

    leftContainer.appendChild(editorContainer);
    contentContainer.appendChild(leftContainer);

    const rightContainer = document.createElement("div");
    // 锁死宽度：否则行内超长文本会通过 min-content 把整列撑宽，把左边画布挤窄
    rightContainer.style.cssText =
        "flex: 0 0 280px; width: 280px; min-width: 280px; max-width: 280px; overflow: hidden; display: flex; flex-direction: column; background: #1e1e1e;";


    // ================= 顶部工具条：选择 =================
    const selectAllBtn = ribbon.button("selectAll", "全选 / 取消全选", () => {
        const allSelected = model.items.length > 0 && model.selection.size === model.items.length;
        model.selection.clear();
        if (allSelected) {
            model.setActive(-1);
        } else {
            model.items.forEach((_, i) => model.selection.add(i));
            model.setActive(model.items.length - 1);
        }
        updateListSelection();
        syncEditorPanel();
        drawCanvas();
    });

    const addBtn = ribbon.button("plus", "新建一个边界框");
    const deleteBtn = ribbon.button("trash", "删除选中的边界框");

    // ================= 顶部工具条：吸附 =================
    const gridSizeSelect = ribbon.select(
        [{ value: 16, label: "16" }, { value: 32, label: "32" }],
        () => {
            GRID_SNAP = parseInt(gridSizeSelect.value, 10);
            sizeInput.max = String(Math.max(1, GRID_SNAP - 1));
            syncEditorPanel();
            drawCanvas();
        }
    );
    gridSizeSelect.title = "网格尺寸";

    const snapModeSelect = ribbon.select(
        [
            { value: "none", label: "无吸附" },
            { value: "object", label: "对象吸附" },
            { value: "grid", label: "网格吸附" },
        ],
        () => {
            snapMode = snapModeSelect.value;
            gridSizeSelect.style.display = snapMode === "grid" ? "" : "none";
            setGuides([]);
            drawCanvas();
        }
    );
    snapModeSelect.title = "吸附模式（按住 Alt 临时关闭）";
    gridSizeSelect.style.display = "none";

    // ================= 画布模式（summary.canvas） =================
    // JSON 顶层字段，不属于背景图设置，单独放在工具栏下方
    const canvasModePanel = document.createElement("div");
    canvasModePanel.style.cssText =
        "margin: 8px 10px 0; padding: 8px 10px; border: 1px solid #444; border-radius: 6px; display: flex; align-items: center; gap: 8px; background: #1a1a1a;";

    const canvasModeLabel = document.createElement("span");
    canvasModeLabel.textContent = "🧩 画布模式";
    canvasModeLabel.style.cssText = "font-size: 12px; color: #aaa; white-space: nowrap;";

    const canvasModeSelect = document.createElement("select");
    canvasModeSelect.style.cssText =
        "flex: 1; min-width: 0; background: #111; color: #eee; border: 1px solid #444; border-radius: 4px; padding: 4px 6px; outline: none; cursor: pointer; font-size: 12px;";
    [
        { value: "", label: "默认 (不设置)" },
        { value: "single", label: "单图" },
        { value: "multi_panel", label: "多面板/分镜" },
        { value: "collage", label: "拼贴" },
    ].forEach((opt) => {
        const o = document.createElement("option");
        o.value = opt.value;
        o.textContent = opt.label;
        canvasModeSelect.appendChild(o);
    });

    canvasModePanel.appendChild(canvasModeLabel);
    canvasModePanel.appendChild(canvasModeSelect);

    // （原「对齐 / 分布」面板已移除：构图以手操为主，不再占用右栏空间）

    // ================= 极小框控制面板 =================
    const smallBoxPanel = document.createElement("div");
    smallBoxPanel.style.cssText = "margin: 8px 10px 0; padding: 10px; border: 1px solid #444; border-radius: 6px; display: flex; flex-direction: column; gap: 8px; background: #1a1a1a;";
    
    const smallBoxTitle = document.createElement("div");
    smallBoxTitle.textContent = "📐 极小框控制";
    smallBoxTitle.style.cssText = "font-size: 12px; font-weight: bold; color: #aaa; border-bottom: 1px solid #333; padding-bottom: 4px; margin-bottom: 2px;";
    smallBoxPanel.appendChild(smallBoxTitle);

    const smallBoxRow = document.createElement("div");
    smallBoxRow.style.cssText = "display: flex; align-items: center; gap: 6px; font-size: 12px; flex-wrap: wrap;";
    
    const enableSmallCb = document.createElement("input");
    enableSmallCb.type = "checkbox";
    enableSmallCb.style.cssText = "cursor: pointer; accent-color: #4a9eff; margin: 0;";
    
    const sizeLabel = document.createElement("span");
    sizeLabel.textContent = "尺寸:";
    sizeLabel.style.color = "#aaa";
    
    const sizeInput = document.createElement("input");
    sizeInput.type = "number";
    sizeInput.min = "1";
    sizeInput.max = "15";
    sizeInput.value = "8";
    sizeInput.style.cssText = "width: 40px; background: #111; color: #eee; border: 1px solid #444; border-radius: 4px; padding: 2px 4px; text-align: center;";

    // 🌟 新增：对齐方式下拉框
    const alignSelect = document.createElement("select");
    alignSelect.style.cssText = "flex: 1; background: #111; color: #eee; border: 1px solid #444; border-radius: 4px; padding: 2px 4px; outline: none; cursor: pointer; font-size: 11px;";
    const alignOptions = [
        { value: "center", label: "中心" },
        { value: "tl", label: "左上" },
        { value: "tr", label: "右上" },
        { value: "bl", label: "左下" },
        { value: "br", label: "右下" }
    ];
    alignOptions.forEach(opt => {
        const o = document.createElement("option");
        o.value = opt.value;
        o.textContent = opt.label;
        alignSelect.appendChild(o);
    });
    
    smallBoxRow.appendChild(enableSmallCb);
    smallBoxRow.appendChild(sizeLabel);
    smallBoxRow.appendChild(sizeInput);
    smallBoxPanel.appendChild(smallBoxRow);

    // 🌟 新增：第二行，专门放对齐方式
    const alignRow = document.createElement("div");
    alignRow.style.cssText = "display: flex; align-items: center; gap: 6px; font-size: 12px; margin-top: 4px;";
    
    const alignLabel = document.createElement("span");
    alignLabel.textContent = "实际坐标位于:";
    alignLabel.style.color = "#aaa";
    alignLabel.style.whiteSpace = "nowrap";
    
    alignRow.appendChild(alignLabel);
    alignRow.appendChild(alignSelect);
    
    smallBoxPanel.appendChild(alignRow);
    
    alignSelect.onchange = () => {
        if (model.active === -1) return;
        const item = model.items[model.active];
        const oldAlign = item._align || "center";
        
        // 先拿到旧视觉框的左上角，保证视觉位置不动
        const oldBounds = getVisualBounds(item);
        item._align = alignSelect.value;
        
        // 根据新对齐方式，反推真实坐标
        applyVisualBounds(item, oldBounds.vXmin, oldBounds.vYmin);
        saveEditorChanges();
        drawCanvas();
    };

    enableSmallCb.onchange = () => {
        if (model.active === -1) {
            enableSmallCb.checked = false;
            return alert("请先在画布上选中一个框！");
        }
        const item = model.items[model.active];
        const oldBounds = getVisualBounds(item);
        const cx = (oldBounds.vXmin + oldBounds.vXmax) / 2;
        const cy = (oldBounds.vYmin + oldBounds.vYmax) / 2;

        let w;
        let h;

        if (enableSmallCb.checked) {
            // 进入极小框：先记住原来的尺寸，取消勾选时还原
            if (!oldBounds.isExtreme) item._prevBBox = [...item.bbox];
            let size = parseInt(sizeInput.value) || Math.round(GRID_SNAP / 2);
            size = Math.max(1, Math.min(GRID_SNAP - 1, size));
            w = size;
            h = size;
        } else {
            // 取消勾选：回到原来的尺寸；没有记录（比如本来就很小）才退回网格大小
            if (Array.isArray(item._prevBBox) && item._prevBBox.length === 4) {
                w = Math.max(1, item._prevBBox[3] - item._prevBBox[1]);
                h = Math.max(1, item._prevBBox[2] - item._prevBBox[0]);
                delete item._prevBBox;
            } else {
                w = GRID_SNAP;
                h = GRID_SNAP;
            }
            item._align = "center";
        }

        const finalXmin = Math.round(cx - w / 2);
        const finalYmin = Math.round(cy - h / 2);
        item.bbox = [finalYmin, finalXmin, finalYmin + h, finalXmin + w];

        saveEditorChanges();
        renderList(false);
        drawCanvas();
    };

    sizeInput.onchange = () => {
        if (model.active === -1 || !enableSmallCb.checked) return;
        const item = model.items[model.active];
        const oldBounds = getVisualBounds(item);
        
        let size = parseInt(sizeInput.value) || Math.round(GRID_SNAP / 2);
        size = Math.max(1, Math.min(GRID_SNAP - 1, size));
        sizeInput.value = size;
        
        const cx = (oldBounds.vXmin + oldBounds.vXmax) / 2;
        const cy = (oldBounds.vYmin + oldBounds.vYmax) / 2;
        const finalXmin = Math.round(cx - size / 2);
        const finalYmin = Math.round(cy - size / 2);
        
        item.bbox = [finalYmin, finalXmin, finalYmin + size, finalXmin + size];
        saveEditorChanges();
        renderList(false);
        drawCanvas();
    };

    // 🌟 背景图控制面板（卡片化包装）
    const bgPanel = document.createElement("div");
    bgPanel.style.cssText = "margin: 8px 10px 0; padding: 10px; border: 1px solid #444; border-radius: 6px; display: flex; flex-direction: column; gap: 8px; background: #1a1a1a;";
    
    // 添加区域标题
    // 标题行：标题 + 操控 + 折叠按钮
    const bgHeader = document.createElement("div");
    bgHeader.style.cssText =
        "display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: bold; color: #aaa;" +
        "border-bottom: 1px solid #333; padding-bottom: 4px; margin-bottom: 2px;";

    const bgTitle = document.createElement("span");
    bgTitle.textContent = "🖼️ 背景图设置";
    bgTitle.style.cssText = "flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;";

    const bgActiveLabel = document.createElement("label");
    bgActiveLabel.style.cssText =
        "display: flex; align-items: center; gap: 3px; color: #ccc; font-size: 12px; font-weight: normal; cursor: pointer; flex-shrink: 0;";
    bgActiveLabel.title = "开启后可在画布上移动 / 拉伸背景图";
    const bgActiveCb = document.createElement("input");
    bgActiveCb.type = "checkbox";
    bgActiveCb.disabled = true;
    bgActiveCb.style.cssText = "accent-color: #4a9eff; margin: 0;";
    bgActiveCb.onchange = () => { bgActive = bgActiveCb.checked; };
    bgActiveLabel.appendChild(bgActiveCb);
    bgActiveLabel.appendChild(document.createTextNode("操控"));

    const bgCollapseBtn = document.createElement("button");
    bgCollapseBtn.type = "button";
    bgCollapseBtn.title = "展开 / 收起背景图设置";
    bgCollapseBtn.style.cssText =
        "display: flex; align-items: center; justify-content: center; flex: 0 0 auto;" +
        "width: 22px; height: 20px; padding: 0; border-radius: 4px; background: #2a2a2a;" +
        "border: 1px solid #444; cursor: pointer;";
    // 用 CSS 三角形，比 ▾ 字符大好控制
    const bgCollapseArrow = document.createElement("span");
    bgCollapseArrow.style.cssText =
        "display: block; width: 0; height: 0; border-left: 5px solid transparent;" +
        "border-right: 5px solid transparent; border-top: 6px solid #bbb;" +
        "transition: transform 0.15s;";
    bgCollapseBtn.appendChild(bgCollapseArrow);
    bgCollapseBtn.onmouseover = () => { bgCollapseBtn.style.background = "#3a3a3a"; };
    bgCollapseBtn.onmouseout = () => { bgCollapseBtn.style.background = "#2a2a2a"; };

    bgHeader.appendChild(bgTitle);
    bgHeader.appendChild(bgActiveLabel);
    bgHeader.appendChild(bgCollapseBtn);
    bgPanel.appendChild(bgHeader);

    // 正文容器（可折叠）
    const bgBody = document.createElement("div");
    bgBody.style.cssText = "display: flex; flex-direction: column; gap: 8px;";
    bgPanel.appendChild(bgBody);

    bgCollapseBtn.onclick = () => {
        const collapsed = bgBody.style.display === "none";
        bgBody.style.display = collapsed ? "flex" : "none";
        // 展开时箭头朝下，收起时朝右
        bgCollapseArrow.style.transform = collapsed ? "rotate(0deg)" : "rotate(-90deg)";
    };

    const bgUploadLabel = document.createElement("label");
    bgUploadLabel.style.cssText = "background: #333; color: #ccc; text-align: center; padding: 6px; border-radius: 4px; cursor: pointer; font-size: 12px; border: 1px solid #555; flex: 1; transition: 0.2s;";
    bgUploadLabel.textContent = "📁 导入";
    bgUploadLabel.onmouseover = () => bgUploadLabel.style.background = "#444";
    bgUploadLabel.onmouseout = () => bgUploadLabel.style.background = "#333";
    
    const bgUploadInput = document.createElement("input");
    bgUploadInput.type = "file";
    bgUploadInput.accept = "image/*";
    bgUploadInput.style.display = "none";
    bgUploadInput.onchange = (e) => {
        const file = e.target.files[0];
        if (file) loadBackgroundFromBlob(file);
        e.target.value = "";
    };
    bgUploadLabel.appendChild(bgUploadInput);

    const bgPasteBtn = document.createElement("button");
    bgPasteBtn.textContent = "📋 粘贴";
    bgPasteBtn.title = "从剪贴板粘贴图片（或在画布聚焦时按 Ctrl+V）";
    bgPasteBtn.style.cssText = "background: #333; color: #ccc; border: 1px solid #555; padding: 6px; border-radius: 4px; cursor: pointer; font-size: 12px; flex: 1; transition: 0.2s;";
    bgPasteBtn.onmouseover = () => bgPasteBtn.style.background = "#444";
    bgPasteBtn.onmouseout = () => bgPasteBtn.style.background = "#333";
    bgPasteBtn.onclick = async () => {
        try {
            if (!navigator.clipboard || !navigator.clipboard.read) {
                alert("当前浏览器不支持读取剪贴板，请在画布聚焦时按 Ctrl+V 粘贴。");
                return;
            }
            const items = await navigator.clipboard.read();
            for (const item of items) {
                const imageType = item.types.find((t) => t.startsWith("image/"));
                if (imageType) {
                    const blob = await item.getType(imageType);
                    if (loadBackgroundFromBlob(blob)) return;
                }
            }
            alert("剪贴板中没有图片。");
        } catch (err) {
            console.warn("[MOSS] 读取剪贴板失败:", err);
            alert("读取剪贴板失败（可能缺少权限），请在画布聚焦时按 Ctrl+V 粘贴。");
        }
    };

    const bgUploadRow = document.createElement("div");
    bgUploadRow.style.cssText = "display: flex; gap: 6px;";
    bgUploadRow.appendChild(bgUploadLabel);
    bgUploadRow.appendChild(bgPasteBtn);
    bgBody.appendChild(bgUploadRow);

    const bgControlRow = document.createElement("div");
    bgControlRow.style.cssText = "display: flex; align-items: center; gap: 6px; font-size: 12px;";
    
    const bgOpacityLabel = document.createElement("span");
    bgOpacityLabel.textContent = "透明度";
    bgOpacityLabel.style.color = "#aaa";
    bgOpacityLabel.style.whiteSpace = "nowrap";
    
    const bgOpacitySlider = document.createElement("input");
    bgOpacitySlider.type = "range";
    bgOpacitySlider.min = "0";
    bgOpacitySlider.max = "1";
    bgOpacitySlider.step = "0.05";
    bgOpacitySlider.value = bgOpacity;
    bgOpacitySlider.style.flex = "1";
    bgOpacitySlider.oninput = (e) => { bgOpacity = parseFloat(e.target.value); drawCanvas(); };
    
    bgControlRow.appendChild(bgOpacityLabel);
    bgControlRow.appendChild(bgOpacitySlider);
    bgBody.appendChild(bgControlRow);

    // 🌟 背景图尺寸（没有背景图时禁用变灰）
    const bgSizeRow = document.createElement("div");
    bgSizeRow.style.cssText = "display: flex; align-items: center; gap: 5px; font-size: 12px; min-width: 0;";

    const bgSizeLabel = document.createElement("span");
    bgSizeLabel.textContent = "尺寸";
    bgSizeLabel.style.cssText = "color: #aaa; white-space: nowrap;";

    const mkSizeInput = (ph) => {
        const inp = document.createElement("input");
        inp.type = "number";
        inp.min = "16";
        inp.step = "1";
        inp.disabled = true;
        inp.placeholder = ph;
        inp.style.cssText =
            "flex: 1 1 0; min-width: 44px; background: #111; color: #eee; border: 1px solid #444; border-radius: 4px; " +
            "padding: 2px 4px; text-align: center; outline: none; box-sizing: border-box; transition: opacity 0.12s;";
        return inp;
    };
    const bgWInput = mkSizeInput("宽");
    const bgHInput = mkSizeInput("高");
    const bgSizeX = document.createElement("span");
    bgSizeX.textContent = "×";
    bgSizeX.style.cssText = "color: #666;";

    // 🌟 锁定长宽比
    const bgLockBtn = document.createElement("button");
    bgLockBtn.type = "button";
    bgLockBtn.textContent = bgLockRatio ? "🔒" : "🔓";
    bgLockBtn.title = bgLockRatio ? "已锁定长宽比（点按解锁）" : "未锁定长宽比（点按锁定）";
    bgLockBtn.style.cssText =
        "flex: 0 0 auto; width: 24px; height: 22px; line-height: 1; padding: 0; border-radius: 4px;" +
        `background: #2a2a2a; border: 1px solid ${bgLockRatio ? "#4a9eff" : "#555"};` +
        `color: ${bgLockRatio ? "#8ecbff" : "#ccc"}; font-size: 12px; cursor: pointer;`;
    bgLockBtn.onclick = () => {
        bgLockRatio = !bgLockRatio;
        bgLockBtn.textContent = bgLockRatio ? "🔒" : "🔓";
        bgLockBtn.title = bgLockRatio ? "已锁定长宽比（点按解锁）" : "未锁定长宽比（点按锁定）";
        bgLockBtn.style.borderColor = bgLockRatio ? "#4a9eff" : "#555";
        bgLockBtn.style.color = bgLockRatio ? "#8ecbff" : "#ccc";
    };

    // 🌟 铺满：按原图比例放大到盖住画布并居中
    const bgCoverBtn = document.createElement("button");
    bgCoverBtn.type = "button";
    bgCoverBtn.textContent = "⤢ 铺满";
    bgCoverBtn.title = "按原图比例放大到铺满画布并居中";
    bgCoverBtn.disabled = true;
    bgCoverBtn.style.cssText =
        "background:#333;color:#ccc;border:1px solid #555;padding:2px 6px;border-radius:4px;" +
        "cursor:pointer;font-size:11px;white-space:nowrap;transition:background 0.12s,opacity 0.12s;";
    bgCoverBtn.onmouseover = () => {
        if (!bgCoverBtn.disabled) bgCoverBtn.style.background = "#3f3f3f";
    };
    bgCoverBtn.onmouseout = () => {
        bgCoverBtn.style.background = "#333";
    };
    bgCoverBtn.onclick = () => {
        if (!bgImage) return;
        const { w, h } = getCanvasSize();
        const scale = Math.max(w / bgImage.width, h / bgImage.height);
        bgW = bgImage.width * scale;
        bgH = bgImage.height * scale;
        bgX = 0;
        bgY = 0;
        if (syncBgSizeHook) syncBgSizeHook();
        drawCanvas();
    };

    bgSizeRow.appendChild(bgSizeLabel);
    bgSizeRow.appendChild(bgWInput);
    bgSizeRow.appendChild(bgSizeX);
    bgSizeRow.appendChild(bgHInput);
    bgSizeRow.appendChild(bgLockBtn);
    bgSizeRow.appendChild(bgCoverBtn);
    bgBody.appendChild(bgSizeRow);

    const syncBgSizeInputs = () => {
        const has = !!bgImage;
        [bgWInput, bgHInput].forEach((inp) => {
            inp.disabled = !has;
            inp.style.opacity = has ? "1" : "0.45";
            inp.style.cursor = has ? "text" : "not-allowed";
        });
        bgCoverBtn.disabled = !has;
        bgCoverBtn.style.opacity = has ? "1" : "0.45";
        bgCoverBtn.style.cursor = has ? "pointer" : "not-allowed";
        if (has) {
            // 正在输入时不要覆盖
            if (document.activeElement !== bgWInput) bgWInput.value = String(Math.round(bgW));
            if (document.activeElement !== bgHInput) bgHInput.value = String(Math.round(bgH));
        } else {
            bgWInput.value = "";
            bgHInput.value = "";
        }
    };

    const applyBgSizeFromInputs = (which) => {
        if (!bgImage) return;
        let w = Math.max(16, Math.round(Number(bgWInput.value) || bgW));
        let h = Math.max(16, Math.round(Number(bgHInput.value) || bgH));

        // 锁定长宽比时，改任意一边都按当前比例同步另一边
        if (bgLockRatio && bgW > 0 && bgH > 0) {
            const ratio = bgW / bgH;
            if (which === "h") w = Math.max(16, Math.round(h * ratio));
            else h = Math.max(16, Math.round(w / ratio));
        }

        bgW = w;
        bgH = h;
        bgWInput.value = String(w);
        bgHInput.value = String(h);
        drawCanvas();
    };
    bgWInput.addEventListener("change", () => applyBgSizeFromInputs("w"));
    bgHInput.addEventListener("change", () => applyBgSizeFromInputs("h"));

    syncBgSizeHook = syncBgSizeInputs;
    syncBgSizeInputs();

    const bgActionRow = document.createElement("div");
    bgActionRow.style.cssText = "display: flex; align-items: center; justify-content: space-between; margin-top: 2px;";
    
    const bgSnapLabel = document.createElement("label");
    bgSnapLabel.style.cssText = "display: flex; align-items: center; gap: 4px; color: #ccc; font-size: 12px; cursor: pointer;";
    bgSnapLabel.title = "勾选：拖动时吸附画布的上/下/左/右边缘与中心；取消：自由拖动";
    const bgSnapCb = document.createElement("input");
    bgSnapCb.type = "checkbox";
    bgSnapCb.checked = bgSnap;
    bgSnapCb.style.cssText = "accent-color: #4a9eff; margin: 0;";
    bgSnapCb.onchange = () => { bgSnap = bgSnapCb.checked; };
    bgSnapLabel.appendChild(bgSnapCb);
    bgSnapLabel.appendChild(document.createTextNode("吸附"));

    const bgBtnGroup = document.createElement("div");
    bgBtnGroup.style.cssText = "display: flex; gap: 4px;";

    const bgResetBtn = document.createElement("button");
    bgResetBtn.textContent = "↺ 重置";
    bgResetBtn.title = "恢复为导入时的初始尺寸与位置";
    bgResetBtn.style.cssText = "background: #333; color: #ccc; border: 1px solid #555; padding: 2px 6px; border-radius: 4px; cursor: pointer; font-size: 11px;";
    bgResetBtn.onclick = () => {
        if (!bgImage || !bgInitialState) return;
        bgX = bgInitialState.x;
        bgY = bgInitialState.y;
        bgW = bgInitialState.w;
        bgH = bgInitialState.h;
        if (syncBgSizeHook) syncBgSizeHook();
        drawCanvas();
    };

    const bgCenterBtn = document.createElement("button");
    bgCenterBtn.textContent = "🎯 居中";
    bgCenterBtn.title = "将背景图中心对齐画布中心（不改变尺寸）";
    bgCenterBtn.style.cssText = "background: #333; color: #ccc; border: 1px solid #555; padding: 2px 6px; border-radius: 4px; cursor: pointer; font-size: 11px;";
    bgCenterBtn.onclick = () => {
        if (bgImage) { bgX = 0; bgY = 0; drawCanvas(); }
    };

    const bgDeleteBtn = document.createElement("button");
    bgDeleteBtn.textContent = "✖ 移除";
    bgDeleteBtn.title = "移除背景图";
    // 🌟 这里改了样式：灰色次要按钮，避免和上方大红色的“删除边框”混淆
    bgDeleteBtn.style.cssText =
        "background: #2a2a2a; color: #aaa; border: 1px solid #444; padding: 2px 6px; border-radius: 4px; cursor: pointer; font-size: 11px;";
    bgDeleteBtn.onmouseover = () => { bgDeleteBtn.style.background = "#3a2a2a"; bgDeleteBtn.style.color = "#ffaaaa"; bgDeleteBtn.style.borderColor = "#5a3a3a"; };
    bgDeleteBtn.onmouseout = () => { bgDeleteBtn.style.background = "#2a2a2a"; bgDeleteBtn.style.color = "#aaa"; bgDeleteBtn.style.borderColor = "#444"; };
    bgDeleteBtn.onclick = () => deleteBackgroundImage();

    bgBtnGroup.appendChild(bgResetBtn);
    bgBtnGroup.appendChild(bgCenterBtn);
    bgBtnGroup.appendChild(bgDeleteBtn);

    bgActionRow.appendChild(bgSnapLabel);
    bgActionRow.appendChild(bgBtnGroup);
    bgBody.appendChild(bgActionRow);

    const listArea = document.createElement("div");
    // min-width: 0 让列表可以被父级压缩，而不是用内容宽度把右栏顶宽
    listArea.style.cssText =
        "display: flex; flex-direction: column; gap: 4px; padding: 10px; overflow-y: auto; overflow-x: hidden; flex: 1; min-width: 0;";

    // ================= 顶部工具条：画布 / 背景 / 视图 =================
    // 面板自带外框，装进弹层后去掉，避免双层描边
    [canvasModePanel, smallBoxPanel, bgPanel].forEach((el) => {
        el.style.margin = "0";
        el.style.border = "none";
        el.style.background = "transparent";
        el.style.padding = "0";
    });
    bgCollapseBtn.style.display = "none";

    const canvasPop = document.createElement("div");
    canvasPop.style.cssText = "display: flex; flex-direction: column; gap: 10px;";
    canvasPop.appendChild(canvasModePanel);
    canvasPop.appendChild(smallBoxPanel);

    const canvasBtn = ribbon.button("canvas", "画布模式与极小框", () => {
        openPopover(canvasBtn, canvasPop, { width: 250 });
    });

    const bgBtn = ribbon.button("image", "背景图设置", () => {
        openPopover(bgBtn, bgPanel, { width: 268 });
    });

    ribbon.group([selectAllBtn, addBtn, deleteBtn]);

    // ================= 顶部工具条：对齐 / 分布 =================
    const getSelectedIndices = () =>
        model.selection.size ? Array.from(model.selection) : model.active >= 0 ? [model.active] : [];

    const canvasBounds = () => {
        const { w, h } = getCanvasSize();
        return { xmin: -w / 2, ymin: -h / 2, xmax: w / 2, ymax: h / 2 };
    };

    const itemsBounds = (list) => {
        const boxes = list.map((it) => it.bbox);
        return {
            xmin: Math.min(...boxes.map((b) => b[1])),
            xmax: Math.max(...boxes.map((b) => b[3])),
            ymin: Math.min(...boxes.map((b) => b[0])),
            ymax: Math.max(...boxes.map((b) => b[2])),
        };
    };

    // 多选时对齐到选区包围盒，单选或按住 Alt 时对齐到画布
    const alignSelection = (mode, useCanvas) => {
        const indices = getSelectedIndices();
        const items = indices.map((i) => model.items[i]).filter((it) => it && Array.isArray(it.bbox));
        if (!items.length) return;
        if (model.active === -1) model.setActive(indices[0]);

        const base = items.length > 1 && !useCanvas ? itemsBounds(items) : canvasBounds();
        const cx = (base.xmin + base.xmax) / 2;
        const cy = (base.ymin + base.ymax) / 2;

        items.forEach((item) => {
            const [ymin, xmin, ymax, xmax] = item.bbox;
            const w = xmax - xmin;
            const h = ymax - ymin;
            if (mode === "left") item.bbox = [ymin, Math.round(base.xmin), ymax, Math.round(base.xmin + w)];
            else if (mode === "right") item.bbox = [ymin, Math.round(base.xmax - w), ymax, Math.round(base.xmax)];
            else if (mode === "centerH") item.bbox = [ymin, Math.round(cx - w / 2), ymax, Math.round(cx + w / 2)];
            else if (mode === "top") item.bbox = [Math.round(base.ymin), xmin, Math.round(base.ymin + h), xmax];
            else if (mode === "bottom") item.bbox = [Math.round(base.ymax - h), xmin, Math.round(base.ymax), xmax];
            else if (mode === "centerV") item.bbox = [Math.round(cy - h / 2), xmin, Math.round(cy + h / 2), xmax];
        });
        saveEditorChanges();
    };

    // 首尾不动，中间按等间距重排（间距指框与框之间的空隙）
    const distributeSelection = (axis) => {
        const indices = getSelectedIndices();
        const items = indices.map((i) => model.items[i]).filter((it) => it && Array.isArray(it.bbox));
        if (items.length < 3) return;
        if (model.active === -1) model.setActive(indices[0]);

        const isX = axis === "x";
        const startOf = (it) => (isX ? it.bbox[1] : it.bbox[0]);
        const sizeOf = (it) => (isX ? it.bbox[3] - it.bbox[1] : it.bbox[2] - it.bbox[0]);

        items.sort((a, b) => startOf(a) - startOf(b));
        const spanStart = startOf(items[0]);
        const lastItem = items[items.length - 1];
        const spanEnd = startOf(lastItem) + sizeOf(lastItem);
        const totalSize = items.reduce((sum, it) => sum + sizeOf(it), 0);
        const gap = (spanEnd - spanStart - totalSize) / (items.length - 1);

        let cursor = spanStart + sizeOf(items[0]) + gap;
        for (let i = 1; i < items.length - 1; i++) {
            const item = items[i];
            const size = sizeOf(item);
            if (isX) item.bbox = [item.bbox[0], Math.round(cursor), item.bbox[2], Math.round(cursor + size)];
            else item.bbox = [Math.round(cursor), item.bbox[1], Math.round(cursor + size), item.bbox[3]];
            cursor += size + gap;
        }
        saveEditorChanges();
    };

    const alignBtns = [
        ["alignLeft", "左对齐", "left"],
        ["alignCenterH", "水平居中", "centerH"],
        ["alignRight", "右对齐", "right"],
        ["alignTop", "上对齐", "top"],
        ["alignCenterV", "垂直居中", "centerV"],
        ["alignBottom", "下对齐", "bottom"],
    ].map(([icon, title, mode]) => ribbon.button(icon, title, (e) => alignSelection(mode, e.altKey)));

    const alignPop = document.createElement("div");
    alignPop.style.cssText = "display: flex; flex-direction: column; gap: 6px;";

    const popItem = (label, onClick) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = label;
        btn.style.cssText =
            "padding: 7px 10px; background: #2a2a2a; border: 1px solid #444; border-radius: 5px; color: #ccc; font-size: 12px; text-align: left; cursor: pointer;";
        btn.onmouseover = () => {
            btn.style.background = "#414141";
            btn.style.borderColor = "#8a8a8a";
            btn.style.color = "#fff";
        };
        btn.onmouseout = () => {
            btn.style.background = "#2a2a2a";
            btn.style.borderColor = "#444";
            btn.style.color = "#ccc";
        };
        btn.addEventListener("click", onClick);
        return btn;
    };

    alignPop.appendChild(popItem("水平等距分布", () => distributeSelection("x")));
    alignPop.appendChild(popItem("垂直等距分布", () => distributeSelection("y")));
    const alignHint = document.createElement("div");
    alignHint.textContent = "分布需要选中至少 3 个框";
    alignHint.style.cssText = "font-size: 11px; color: #888; padding: 0 2px;";
    alignPop.appendChild(alignHint);

    const alignMoreBtn = ribbon.button("chevronDown", "等距分布", () => {
        openPopover(alignMoreBtn, alignPop, { width: 176 });
    });

    const updateAlignState = () => {
        const count = model.selection.size || (model.active >= 0 ? 1 : 0);
        alignBtns.forEach((btn) => {
            btn.disabled = count === 0;
        });
        alignMoreBtn.disabled = count < 3;
    };

    ribbon.group([...alignBtns, alignMoreBtn]);
    ribbon.group([snapModeSelect, gridSizeSelect]);
    ribbon.group([canvasBtn, bgBtn]);
    ribbon.group([undoBtn, redoBtn, resetViewBtn]);

    rightContainer.appendChild(promptWrapper);
    rightContainer.appendChild(listArea);

    contentContainer.appendChild(rightContainer);
    panel.appendChild(contentContainer);
    document.body.appendChild(panel);

    // ================= 面板位置 / 尺寸持久化 =================
    const PANEL_RECT_KEY = "moss.bbox.panelRect";
    const savePanelRect = () => {
        if (panel.style.display === "none") return;
        const r = panel.getBoundingClientRect();
        try {
            localStorage.setItem(PANEL_RECT_KEY, JSON.stringify({
                left: Math.round(r.left),
                top: Math.round(r.top),
                width: Math.round(r.width),
                height: Math.round(r.height),
            }));
        } catch (_) {
            /* 存储不可用时忽略 */
        }
    };
    const restorePanelRect = () => {
        let saved = null;
        try {
            saved = JSON.parse(localStorage.getItem(PANEL_RECT_KEY) || "null");
        } catch (_) {
            saved = null;
        }
        if (!saved || !Number.isFinite(saved.left) || !Number.isFinite(saved.top)) return;
        const w = Math.min(Math.max(saved.width || 750, 450), Math.max(450, window.innerWidth - 16));
        const h = Math.min(Math.max(saved.height || 600, 300), Math.max(300, window.innerHeight - 16));
        const left = Math.min(Math.max(saved.left, 0), Math.max(0, window.innerWidth - w));
        const top = Math.min(Math.max(saved.top, 0), Math.max(0, window.innerHeight - 40));
        panel.style.transform = "none";
        panel.style.left = `${left}px`;
        panel.style.top = `${top}px`;
        panel.style.width = `${w}px`;
        panel.style.height = `${h}px`;
    };
    restorePanelRect();

    let saveRectTimer = null;
    const queueSavePanelRect = () => {
        if (saveRectTimer) clearTimeout(saveRectTimer);
        saveRectTimer = setTimeout(savePanelRect, 300);
    };
    try {
        // CSS resize 拖拽不会触发事件，用尺寸变化监听兜住
        new ResizeObserver(queueSavePanelRect).observe(panel);
    } catch (_) {
        /* 老浏览器忽略 */
    }

    // --- 拖拽面板逻辑 ---
    let isDraggingPanel = false,
        panelStartX,
        panelStartY,
        panelStartLeft,
        panelStartTop;

    // 🌟 拖拽边界：标题栏必须始终留在视口内，否则一旦拖出去就再也抓不回来
    //   · 上边界：标题栏不能顶出视口顶部
    //   · 下边界：标题栏不能掉出视口底部
    //   · 左右：至少留 KEEP_W 宽，保证还抓得住标题栏
    const clampPanelPosition = (left, top) => {
        const w = panel.offsetWidth || 450;
        const headerH = header.offsetHeight || 36;
        const KEEP_W = Math.min(160, w);

        const minLeft = -(w - KEEP_W);
        const maxLeft = Math.max(minLeft, window.innerWidth - KEEP_W);
        const maxTop = Math.max(0, window.innerHeight - headerH - 4);

        return {
            left: Math.min(Math.max(left, minLeft), maxLeft),
            top: Math.min(Math.max(top, 0), maxTop),
        };
    };

    header.addEventListener("pointerdown", (e) => {
        if (e.target === closeBtn || e.target === helpBtn) return;

        isDraggingPanel = true;
        panelStartX = e.clientX;
        panelStartY = e.clientY;

        // 换算成 left/top 之前先夹一次：窗口变小后重新打开也能自动回到可见区域
        const rect = panel.getBoundingClientRect();
        const pos = clampPanelPosition(rect.left, rect.top);
        panelStartLeft = pos.left;
        panelStartTop = pos.top;
        panel.style.transform = "none";
        panel.style.left = panelStartLeft + "px";
        panel.style.top = panelStartTop + "px";

        // 核心修复：锁定指针，确保鼠标移出面板依然能收到松开事件
        header.setPointerCapture(e.pointerId);
        e.preventDefault();
    });

    header.addEventListener("pointermove", (e) => {
        if (!isDraggingPanel) return;
        const pos = clampPanelPosition(
            panelStartLeft + e.clientX - panelStartX,
            panelStartTop + e.clientY - panelStartY
        );
        panel.style.left = pos.left + "px";
        panel.style.top = pos.top + "px";
    });

    header.addEventListener("pointerup", (e) => {
        isDraggingPanel = false;
        header.releasePointerCapture(e.pointerId);
        savePanelRect();
    });

    // 窗口尺寸变化后，把已经拖出去的面板拉回可见区域
    window.addEventListener("resize", () => {
        if (panel.style.display === "none") return;
        if (panel.style.transform !== "none") return; // 还没被拖动过，仍是居中布局
        const rect = panel.getBoundingClientRect();
        const pos = clampPanelPosition(rect.left, rect.top);
        panel.style.left = pos.left + "px";
        panel.style.top = pos.top + "px";
    });

    // --- 核心状态与变量 ---
    const model = createEditorModel();
    let isUpdatingFromUI = false;
    updateAlignState();

    let dragMode = null;
    let dragStartMouse = { x: 0, y: 0 };
    let dragStartBBox = [0, 0, 0, 0];
    let labelCache = [];

    // 视口状态
    let isPanning = false;
    let panStartX = 0,
        panStartY = 0,
        panStartViewX = 0,
        panStartViewY = 0;

    const HANDLE_SIZE = 8;
    let GRID_SNAP = 16;

    const getCanvasSize = () => {
        const w = node.widgets.find((w) => w.name === "canvas_width")?.value || 1024;
        const h = node.widgets.find((w) => w.name === "canvas_height")?.value || 1024;
        return { w, h };
    };

    const getBaseScale = () => {
        const { w, h } = getCanvasSize();
        const rect = canvasContainer.getBoundingClientRect();
        const padding = 40;
        const displayW = Math.max(1, rect.width - padding);
        const displayH = Math.max(1, rect.height - padding);
        return Math.min(displayW / w, displayH / h);
    };

    const getActualScale = () => getBaseScale() * model.view.scale;

    const physToLogic = (px, py) => {
        const scale = getActualScale();
        const rect = canvasContainer.getBoundingClientRect();
        const centerX = rect.width / 2;
        const centerY = rect.height / 2;
        return {
            x: (px - centerX - model.view.x) / scale,
            y: (py - centerY - model.view.y) / scale,
        };
    };

    const logicToPhys = (lx, ly) => {
        const scale = getActualScale();
        const rect = canvasContainer.getBoundingClientRect();
        const centerX = rect.width / 2;
        const centerY = rect.height / 2;
        return { x: centerX + model.view.x + lx * scale, y: centerY + model.view.y + ly * scale };
    };

    // ================= 吸附（无 / 对象 / 网格） =================
    const SNAP_PX = 6;
    let snapMode = "none";
    let snapTargets = { xs: [], ys: [] };
    let snapGuides = [];

    const setGuides = (list) => {
        snapGuides = list || [];
    };

    let snapReady = false;

    // 候选线：画布左中右 / 上中下，加上其他框的三条竖线、三条横线
    const buildSnapTargets = (excludeIndices) => {
        const { w, h } = getCanvasSize();
        const xs = [-w / 2, 0, w / 2];
        const ys = [-h / 2, 0, h / 2];
        const skip = excludeIndices instanceof Set ? excludeIndices : new Set(excludeIndices == null ? [] : [excludeIndices]);
        const boxes = [];
        model.items.forEach((item, i) => {
            if (skip.has(i) || !item || !Array.isArray(item.bbox)) return;
            const [ymin, xmin, ymax, xmax] = item.bbox;
            xs.push(xmin, (xmin + xmax) / 2, xmax);
            ys.push(ymin, (ymin + ymax) / 2, ymax);
            boxes.push({ xmin, xmax, ymin, ymax });
        });
        snapTargets = { xs, ys, boxes, gapsX: collectGaps(boxes, "x"), gapsY: collectGaps(boxes, "y") };
        snapReady = true;
    };

    // 其他框之间已有的间距，供等距吸附复用
    const collectGaps = (boxes, axis) => {
        const out = [];
        for (let i = 0; i < boxes.length; i++) {
            for (let j = 0; j < boxes.length; j++) {
                if (i === j) continue;
                const a = boxes[i];
                const b = boxes[j];
                if (axis === "x") {
                    if (a.xmax > b.xmin) continue;
                    if (!(a.ymin < b.ymax && b.ymin < a.ymax)) continue;
                    out.push(b.xmin - a.xmax);
                } else {
                    if (a.ymax > b.ymin) continue;
                    if (!(a.xmin < b.xmax && b.xmin < a.xmax)) continue;
                    out.push(b.ymin - a.ymax);
                }
            }
        }
        // 相同间距只留一份，避免框多时列表膨胀
        return [...new Set(out.filter((g) => g > 0).map((g) => Math.round(g * 100) / 100))];
    };

    // 拖拽真正开始时才构建，此时选中项已经确定，才能把自己排除掉
    const ensureSnapTargets = () => {
        if (snapReady) return;
        const exclude = model.selection.size
            ? new Set(model.selection)
            : new Set(model.active >= 0 ? [model.active] : []);
        buildSnapTargets(exclude);
    };

    const applySnap = (val, isAltPressed, isX) => {
        if (!isAltPressed && snapMode === "grid") {
            const { w, h } = getCanvasSize();
            const offset = isX ? w / 2 : h / 2;
            // 核心逻辑：以左上角为基准画网格线
            return Math.round((val + offset) / GRID_SNAP) * GRID_SNAP - offset;
        }
        return Math.round(val);
    };

    // 对象吸附：把当前框的边 / 中线与其他框、画布对齐，返回偏移量与命中的辅助线
    const nearestSnap = (edges, targets) => {
        const tol = SNAP_PX / getActualScale();
        let best = null;
        edges.forEach((edge) => {
            targets.forEach((t) => {
                const d = t - edge;
                if (Math.abs(d) <= tol && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, pos: t };
            });
        });
        return best;
    };

    // 等距吸附：夹在两框之间取等距，或与邻居保持其他框之间已有的间距
    const snapSpacing = (rect, axis) => {
        const boxes = snapTargets.boxes;
        if (!boxes.length) return null;

        const isX = axis === "x";
        const start = isX ? rect.x : rect.y;
        const size = isX ? rect.w : rect.h;
        const end = start + size;
        const crossStart = isX ? rect.y : rect.x;
        const crossEnd = isX ? rect.y + rect.h : rect.x + rect.w;

        let near = null;
        let far = null;
        boxes.forEach((b) => {
            const bStart = isX ? b.xmin : b.ymin;
            const bEnd = isX ? b.xmax : b.ymax;
            const bCrossStart = isX ? b.ymin : b.xmin;
            const bCrossEnd = isX ? b.ymax : b.xmax;
            if (!(bCrossStart < crossEnd && crossStart < bCrossEnd)) return;
            if (bEnd <= start) {
                if (!near || bEnd > (isX ? near.xmax : near.ymax)) near = b;
            } else if (bStart >= end) {
                if (!far || bStart < (isX ? far.xmin : far.ymin)) far = b;
            }
        });

        const nearEnd = near ? (isX ? near.xmax : near.ymax) : null;
        const farStart = far ? (isX ? far.xmin : far.ymin) : null;
        const at = (crossStart + crossEnd) / 2;
        const tol = SNAP_PX / getActualScale();

        // 规则一：左右两边都挨着框，让两个间距相等
        if (near && far) {
            const free = farStart - nearEnd;
            if (free > size) {
                const gap = (free - size) / 2;
                const target = nearEnd + gap;
                if (Math.abs(target - start) <= tol) {
                    return {
                        delta: target - start,
                        guides: [
                            { type: "spacing", axis, from: nearEnd, to: target, at, gap },
                            { type: "spacing", axis, from: target + size, to: farStart, at, gap },
                        ],
                    };
                }
            }
        }

        // 规则二：贴着某个框时，间距等于其他框之间已有的某个间距
        const gaps = isX ? snapTargets.gapsX : snapTargets.gapsY;
        let best = null;
        gaps.forEach((gap) => {
            if (near) {
                const target = nearEnd + gap;
                const d = target - start;
                if (Math.abs(d) <= tol && (!best || Math.abs(d) < Math.abs(best.delta))) {
                    best = {
                        delta: d,
                        guides: [{ type: "spacing", axis, from: nearEnd, to: target, at, gap }],
                    };
                }
            }
            if (far) {
                const target = farStart - gap - size;
                const d = target - start;
                if (Math.abs(d) <= tol && (!best || Math.abs(d) < Math.abs(best.delta))) {
                    best = {
                        delta: d,
                        guides: [{ type: "spacing", axis, from: farStart - gap, to: farStart, at, gap }],
                    };
                }
            }
        });
        return best;
    };

    const snapMoveRect = (rect, altKey) => {
        ensureSnapTargets();
        if (altKey || snapMode !== "object" || !snapTargets.xs.length) {
            return { x: rect.x, y: rect.y, guides: [] };
        }

        const xHit = nearestSnap([rect.x, rect.x + rect.w / 2, rect.x + rect.w], snapTargets.xs);
        const yHit = nearestSnap([rect.y, rect.y + rect.h / 2, rect.y + rect.h], snapTargets.ys);
        const xGap = snapSpacing(rect, "x");
        const yGap = snapSpacing(rect, "y");

        // 边对齐与等距同时命中时，取位移更小的那个
        const pick = (hit, gap, axisName) => {
            const edgeD = hit ? hit.d : null;
            const gapD = gap ? gap.delta : null;
            if (edgeD !== null && (gapD === null || Math.abs(edgeD) <= Math.abs(gapD))) {
                return { d: edgeD, guides: [{ axis: axisName, pos: hit.pos }] };
            }
            if (gapD !== null) return { d: gapD, guides: gap.guides };
            return { d: 0, guides: [] };
        };

        const rx = pick(xHit, xGap, "x");
        const ry = pick(yHit, yGap, "y");
        return {
            x: rect.x + rx.d,
            y: rect.y + ry.d,
            guides: [...rx.guides, ...ry.guides],
        };
    };

    const snapEdge = (value, axis, altKey) => {
        ensureSnapTargets();
        if (altKey || snapMode !== "object") return { value, guide: null };
        const targets = axis === "x" ? snapTargets.xs : snapTargets.ys;
        const hit = nearestSnap([value], targets);
        return hit ? { value: hit.pos, guide: { axis, pos: hit.pos } } : { value, guide: null };
    };

    const isOverlapping = (r1, r2) => {
        return !(
            r1.x + r1.w < r2.x ||
            r1.x > r2.x + r2.w ||
            r1.y + r1.h < r2.y ||
            r1.y > r2.y + r2.h
        );
    };

    // ================= 撤销 / 重做 =================

    // snapshot 是写回后的完整 JSON；700ms 内的连续改动合并成一步（打字/连续微移）
    const recordHistory = (snapshot, coalesce = true) => {
        if (!model.record(snapshot, coalesce)) return;
        updateUndoButtons();
    };

    const applyHistory = (index) => {
        if (!model.hasHistory(index)) return;
        model.setHistoryIndex(index);
        const value = model.historyAt(index);
        isUpdatingFromUI = true;
        jsonWidget.value = value;
        jsonWidget.callback?.(value);
        isUpdatingFromUI = false;

        // 保留选中态：撤销不应该把下方属性面板一起关掉
        renderList(false);
        const maxIdx = model.items.length - 1;
        if (model.active > maxIdx) model.setActive(-1);
        model.selection.forEach((i) => {
            if (i > maxIdx) model.selection.delete(i);
        });
        updateListSelection();
        syncEditorPanel();
        drawCanvas();
        if (node.graph) node.graph.setDirtyCanvas(true, true);
        model.resetCoalesce(); // 撤销/重做之后的下一次改动必须新开一步，不能合并掉当前状态
        updateUndoButtons();
    };
    const undoEdit = () => applyHistory(model.historyIndex - 1);
    const redoEdit = () => applyHistory(model.historyIndex + 1);

    // 按钮可用状态：栈底/栈顶时置灰
    const updateUndoButtons = () => {
        const canUndo = model.canUndo();
        const canRedo = model.canRedo();
        [[undoBtn, canUndo], [redoBtn, canRedo]].forEach(([btn, enabled]) => {
            if (!btn) return;
            btn.disabled = !enabled;
            btn.style.opacity = enabled ? "1" : "0.38";
            btn.style.cursor = enabled ? "pointer" : "default";
        });
    };

    // 编辑器内部状态（极小框对齐 / 锁定）不进 JSON，靠 bbox + 序号跨重绘继承
    const carryEditorState = (prev, next) => {
        if (!Array.isArray(prev) || !prev.length || !Array.isArray(next)) return;
        const byBbox = new Map();
        prev.forEach((it) => {
            if (it && Array.isArray(it.bbox)) byBbox.set(it.bbox.join(","), it);
        });
        next.forEach((it, i) => {
            if (!it) return;
            const src = (Array.isArray(it.bbox) && byBbox.get(it.bbox.join(","))) || prev[i];
            if (!src) return;
            if (src._align && !it._align) it._align = src._align;
            if (src._locked) it._locked = true;
            if (src._color && !it._color) it._color = src._color;
            // 极小框的“原尺寸”也要跨重绘保留，否则取消勾选时还原不回去
            if (Array.isArray(src._prevBBox) && !it._prevBBox) it._prevBBox = [...src._prevBBox];
        });
    };

    // ================= 键盘微移 =================
    const nudgeSelected = (dx, dy) => {
        if (model.active === -1 && model.selection.size) {
            model.setActive(model.selection.values().next().value);
        }
        const indices = model.selection.size
            ? Array.from(model.selection)
            : model.active >= 0 ? [model.active] : [];
        if (!indices.length) return false;

        const { w, h } = getCanvasSize();
        const limitX = w / 2;
        const limitY = h / 2;
        let moved = false;

        indices.forEach((i) => {
            const item = model.items[i];
            if (!item || !Array.isArray(item.bbox)) return;
            const [ymin, xmin, ymax, xmax] = item.bbox;
            const bw = xmax - xmin;
            const bh = ymax - ymin;
            const nx = Math.max(-limitX, Math.min(xmin + dx, limitX - bw));
            const ny = Math.max(-limitY, Math.min(ymin + dy, limitY - bh));
            if (nx === xmin && ny === ymin) return;
            item.bbox = [Math.round(ny), Math.round(nx), Math.round(ny + bh), Math.round(nx + bw)];
            moved = true;
        });

        if (moved) saveEditorChanges();
        return moved;
    };

    // ================= 键盘：方向键微移 =================
    // ⚠️ Ctrl+Z 不再拦截：ComfyUI 的全局撤销会在更早阶段执行并把整图重建，
    // 拦不住反而容易双触发。撤销/重做改由画布右下角的按钮触发。
    const panelKeyHandler = (e) => {
        if (!panel.contains(e.target)) return; // 只在面板内部生效

        const t = e.target;
        if (!t) return;
        // 文本类输入框内交给原生行为；checkbox / 按钮 不算
        const isTextEditable =
            t.tagName === "TEXTAREA" ||
            t.isContentEditable ||
            (t.tagName === "INPUT" && !["checkbox", "radio", "button", "range", "color"].includes((t.type || "text").toLowerCase()));
        if (isTextEditable || t.tagName === "SELECT") return;
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (model.active === -1 && model.selection.size === 0) return;

        const step = e.shiftKey ? GRID_SNAP : 1;
        let dx = 0;
        let dy = 0;
        if (e.key === "ArrowLeft") dx = -step;
        else if (e.key === "ArrowRight") dx = step;
        else if (e.key === "ArrowUp") dy = -step;
        else if (e.key === "ArrowDown") dy = step;
        else return;
        e.preventDefault();
        e.stopPropagation();
        nudgeSelected(dx, dy);
    };
    window.addEventListener("keydown", panelKeyHandler, true);
    node._mossKeyHandler = panelKeyHandler; // 节点删除时在 onRemoved 里摘掉

    // --- 编辑面板逻辑 ---
    // 写回 JSON 时统一走模块级的 serializeLayout()，字段规则只保留一处
    const saveEditorChanges = () => {
        if (model.active === -1 || !model.items[model.active]) return;

        model.items.forEach(item => { if ("_isNew" in item) delete item._isNew; });

        let parsed = {};
        try {
            parsed = JSON.parse(jsonWidget.value);
        } catch (_) {
            parsed = {};
        }
        const data = Array.isArray(parsed)
            ? model.items
            : parsed && typeof parsed === "object"
                ? { ...parsed, items: model.items }
                : { items: model.items };

        isUpdatingFromUI = true;
        jsonWidget.value = serializeLayout(data);
        if (jsonWidget.callback) jsonWidget.callback(jsonWidget.value);
        isUpdatingFromUI = false;
        recordHistory(jsonWidget.value);

        // 实时更新右侧列表的文本显示（不整体重建列表，防止失去焦点）
        // ⚠️ 必须按类名找：行首现在是拖动柄 span，querySelector("span") 会抓错元素
        const cbs = listArea.querySelectorAll("input[type='checkbox']");
        const row = cbs[model.active]?.parentElement;
        if (row) {
            const span = row.querySelector(".moss-row-label");
            const item = model.items[model.active];
            const text =
                item.caption || item.desc || `未命名 (${item.label || "object"})`;
            if (span)
                span.textContent = `${model.active + 1}. ${text.length > 15 ? text.substring(0, 15) + "..." : text}`;
        }

        drawCanvas();
        if (node.graph) node.graph.setDirtyCanvas(true, true);
    };

    const syncEditorPanel = () => {
        if (model.active === -1 || !model.items[model.active]) {
            editorContainer.style.display = "none";
            closeColorPopup(false);
            return;
        }
        editorContainer.style.display = "flex";
        const item = model.items[model.active];
        // 🌟 换了框就清掉上一个框残留的色块选中态（取色浮层也要跟着收起）
        if (selectedPaletteOwner !== model.active) {
            selectedPaletteIndex = -1;
            selectedPaletteOwner = model.active;
            closeColorPopup(false);
        }
        const isText = item.label === "text";

        // 🌟 同步极小框 UI
        const { isExtreme } = getVisualBounds(item);
        enableSmallCb.checked = isExtreme;
        sizeInput.disabled = !isExtreme;
        alignSelect.disabled = !isExtreme;
        // 上限跟着网格走：16px 网格 → 最大 15，32px 网格 → 最大 31
        sizeInput.max = String(Math.max(1, GRID_SNAP - 1));
        if (isExtreme) {
            sizeInput.value = item.bbox[3] - item.bbox[1];
            alignSelect.value = item._align || "center";
        }

        // 更新类型 Tab 状态（object / character / text）
        updateTypeTabs(item.label || "object");

        // 显示/隐藏文字框
        textLabel.style.display = isText ? "block" : "none";
        textArea.style.display = isText ? "block" : "none";

        // 更新值（防止正在输入时被覆盖）
        if (document.activeElement !== descArea) {
            descArea.value = item.caption || item.desc || "";
        }
        if (isText && document.activeElement !== textArea) {
            textArea.value = item.text || "";
        }

        syncFrameColorRow();

        // 调色板整行重建（色块在前、「+」在后）
        renderPalette();

        // 标签区整体重建（选中态 / 编辑态都在 renderTags 里处理）
        renderTags();

    };

    const setItemLabel = (label) => {
        if (model.active === -1) return;
        const item = model.items[model.active];
        if (!item) return;
        item.label = label;
        if (label === "text") {
            if (typeof item.text !== "string") item.text = "";
        } else {
            // 只有 text 类型才有 text 字段，切回对象/角色要删掉
            delete item.text;
        }
        syncEditorPanel();
        saveEditorChanges();
    };

    objBtn.onclick = () => setItemLabel("object");
    charBtn.onclick = () => setItemLabel("character");
    textBtn.onclick = () => setItemLabel("text");

    descArea.addEventListener("input", () => {
        if (model.active === -1) return;
        model.items[model.active].caption = descArea.value;
        saveEditorChanges();
    });

    textArea.addEventListener("input", () => {
        if (model.active === -1) return;
        model.items[model.active].text = textArea.value;
        saveEditorChanges();
    });

    // 🌟 获取视觉上的代理范围（边长 = 当前网格尺寸：16 或 32）
    const getVisualBounds = (item) => {
        const [ymin, xmin, ymax, xmax] = item.bbox;
        const realW = xmax - xmin;
        const realH = ymax - ymin;
        // 极小框的视觉代理边长跟随网格尺寸（16 → 16，32 → 32）
        const T = GRID_SNAP;
        if (realW >= T && realH >= T) {
            return { vXmin: xmin, vYmin: ymin, vXmax: xmax, vYmax: ymax, isExtreme: false };
        }

        // 极小框
        const half = T / 2;
        const align = item._align || "center";
        let vXmin = xmin, vYmin = ymin, vXmax = xmin + T, vYmax = ymin + T;

        if (align === "center") {
            const cx = (xmin + xmax) / 2;
            const cy = (ymin + ymax) / 2;
            vXmin = cx - half; vXmax = cx + half;
            vYmin = cy - half; vYmax = cy + half;
        } else if (align === "tl") {
            vXmin = xmin; vYmin = ymin; vXmax = xmin + T; vYmax = ymin + T;
        } else if (align === "tr") {
            vXmin = xmax - T; vYmin = ymin; vXmax = xmax; vYmax = ymin + T;
        } else if (align === "bl") {
            vXmin = xmin; vYmin = ymax - T; vXmax = xmin + T; vYmax = ymax;
        } else if (align === "br") {
            vXmin = xmax - T; vYmin = ymax - T; vXmax = xmax; vYmax = ymax;
        }

        return { vXmin, vYmin, vXmax, vYmax, isExtreme: true };
    };

    // 🌟 将视觉范围反向映射回真实数据
    const applyVisualBounds = (item, vXmin, vYmin) => {
        const [ymin, xmin, ymax, xmax] = item.bbox;
        const realW = xmax - xmin;
        const realH = ymax - ymin;
        const T = GRID_SNAP;
        if (realW >= T && realH >= T) return; // 只有极小框需要反向映射

        const align = item._align || "center";
        let newXmin = xmin, newYmin = ymin, newXmax = xmax, newYmax = ymax;

        if (align === "center") {
            const cx = vXmin + T / 2;
            const cy = vYmin + T / 2;
            newXmin = cx - realW / 2; newXmax = cx + realW / 2;
            newYmin = cy - realH / 2; newYmax = cy + realH / 2;
        } else if (align === "tl") {
            newXmin = vXmin; newYmin = vYmin; newXmax = vXmin + realW; newYmax = vYmin + realH;
        } else if (align === "tr") {
            newXmin = vXmin + T - realW; newYmin = vYmin; newXmax = vXmin + T; newYmax = vYmin + realH;
        } else if (align === "bl") {
            newXmin = vXmin; newYmin = vYmin + T - realH; newXmax = vXmin + realW; newYmax = vYmin + T;
        } else if (align === "br") {
            newXmin = vXmin + T - realW; newYmin = vYmin + T - realH; newXmax = vXmin + T; newYmax = vYmin + T;
        }

        item.bbox = [Math.round(newYmin), Math.round(newXmin), Math.round(newYmax), Math.round(newXmax)];
    };

    // --- 绘制画布 ---
    const drawCanvas = () => {
        const rect = canvasContainer.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return; // 面板隐藏时跳过

        const ctx = canvas.getContext("2d");
        const { w, h } = getCanvasSize();
        const actualScale = getActualScale();

        if (canvas.width !== rect.width || canvas.height !== rect.height) {
            canvas.width = rect.width;
            canvas.height = rect.height;
        }

        ctx.fillStyle = "#111";
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        const p1 = logicToPhys(-w / 2, -h / 2);
        const p2 = logicToPhys(w / 2, h / 2);
        const canvasW_phys = p2.x - p1.x;
        const canvasH_phys = p2.y - p1.y;

        ctx.fillStyle = "#1a1a1a";
        ctx.fillRect(p1.x, p1.y, canvasW_phys, canvasH_phys);

        // 🌟 渲染背景图（不裁剪到逻辑画布内：否则超出部分和四角控制点会被剪掉，没法拉伸）
        if (bgImage) {
            ctx.save();
            ctx.globalAlpha = bgOpacity;
            const bp1 = logicToPhys(bgX - bgW / 2, bgY - bgH / 2);
            const bp2 = logicToPhys(bgX + bgW / 2, bgY + bgH / 2);
            ctx.drawImage(bgImage, bp1.x, bp1.y, bp2.x - bp1.x, bp2.y - bp1.y);

            // 如果开启背景图操控模式，画一个虚线框提示
            if (bgActive) {
                ctx.globalAlpha = 1;
                ctx.strokeStyle = "#ff9800";
                ctx.lineWidth = 2;
                ctx.setLineDash([5, 5]);
                ctx.strokeRect(bp1.x, bp1.y, bp2.x - bp1.x, bp2.y - bp1.y);
                ctx.setLineDash([]);

                // 画四角控制点
                ctx.fillStyle = "#ff9800";
                const hs = HANDLE_SIZE;
                [[bp1.x, bp1.y], [bp2.x, bp1.y], [bp1.x, bp2.y], [bp2.x, bp2.y]].forEach(([hx, hy]) => {
                    ctx.fillRect(hx - hs / 2, hy - hs / 2, hs, hs);
                });
            }
            ctx.restore();
        }
        ctx.strokeStyle = "#333";
        ctx.lineWidth = 1;
        ctx.strokeRect(p1.x + 0.5, p1.y + 0.5, canvasW_phys - 1, canvasH_phys - 1);

        const gridSize = GRID_SNAP * actualScale;
        if (gridSize > 4) {
            ctx.strokeStyle = snapMode === "grid"
                ? "rgba(255,255,255,0.08)"
                : "rgba(255,255,255,0.02)";
            ctx.lineWidth = 1;
            ctx.beginPath();
            for (let lx = -w / 2; lx <= w / 2; lx += GRID_SNAP) {
                const px = logicToPhys(lx, 0).x;
                ctx.moveTo(px, p1.y);
                ctx.lineTo(px, p2.y);
            }
            for (let ly = -h / 2; ly <= h / 2; ly += GRID_SNAP) {
                const py = logicToPhys(0, ly).y;
                ctx.moveTo(p1.x, py);
                ctx.lineTo(p2.x, py);
            }
            ctx.stroke();
        }

        labelCache = [];

        model.items.forEach((item, index) => {
            const bbox = item.bbox;
            if (!bbox || bbox.length !== 4) return;

            const [ymin, xmin, ymax, xmax] = bbox;

            let realW = xmax - xmin;
            let realH = ymax - ymin;
            
            // 原来的一大段 isExtreme 计算换成：
            const { vXmin, vYmin, vXmax, vYmax, isExtreme } = getVisualBounds(item);

            const bp1 = logicToPhys(vXmin, vYmin);
            const bp2 = logicToPhys(vXmax, vYmax);
            const rectW = bp2.x - bp1.x;
            const rectH = bp2.y - bp1.y;

            const isSelected = model.selection.has(index);
            const isActive = index === model.active;
            // 优先用框色；没设置时按选中状态取默认色（调色板不影响描边）
            const customColor = typeof item._color === "string" ? item._color : "";
            const itemColor = customColor || (isActive ? "#4a9eff" : "#ccc");

            // 画框
            if (isActive) {
                ctx.fillStyle = "rgba(74, 158, 255, 0.4)";
                ctx.strokeStyle = itemColor;
                ctx.lineWidth = 2;
            } else if (isSelected) {
                ctx.fillStyle = "rgba(74, 158, 255, 0.15)";
                ctx.strokeStyle = itemColor;
                ctx.lineWidth = 1;
            } else {
                ctx.fillStyle = "rgba(255, 255, 255, 0.05)";
                ctx.strokeStyle = itemColor;
                ctx.lineWidth = 1;
            }
            ctx.fillRect(bp1.x, bp1.y, rectW, rectH);
            ctx.strokeRect(bp1.x, bp1.y, rectW, rectH);

            if (isExtreme) {
                ctx.strokeStyle = "#ff4a4a"; // 红色边框
                ctx.setLineDash([4, 4]);
                ctx.strokeRect(bp1.x, bp1.y, rectW, rectH);
                ctx.setLineDash([]); // 画完虚线后必须恢复实线，否则后续全变虚线
            }
            if (item._locked) {
                ctx.fillStyle = "#ff4a4a";
                ctx.font = "12px sans-serif";
                ctx.textBaseline = "top"; // 保证文字从上往下对齐
                ctx.fillText("🔒", bp2.x - 14, bp1.y + 4); // 稍微调整了位置，防止超出框外
            }

            if (isActive) {
                ctx.fillStyle = "#fff";
                const hs = HANDLE_SIZE / 2;
                [
                    [bp1.x, bp1.y],
                    [bp2.x, bp1.y],
                    [bp1.x, bp2.y],
                    [bp2.x, bp2.y],
                ].forEach(([hx, hy]) => {
                    ctx.fillRect(hx - hs, hy - hs, HANDLE_SIZE, HANDLE_SIZE);
                });
            }

            // 绘制数字标签
            const labelText = (index + 1).toString();
            const displayScale = Math.max(1, actualScale);
            const labelFontSize = Math.max(10, Math.round(12 * displayScale));
            ctx.font = `bold ${labelFontSize}px sans-serif`;
            const textW = ctx.measureText(labelText).width;
            const labelW = textW + 8;
            const labelH = labelFontSize + 6;

            const candidates = [
                { x: bp1.x, y: bp1.y },
                { x: bp2.x - labelW, y: bp1.y },
                { x: bp1.x, y: bp2.y - labelH },
                { x: bp2.x - labelW, y: bp2.y - labelH },
            ];

            let finalPos = candidates[0];
            for (let pos of candidates) {
                const testRect = { x: pos.x, y: pos.y, w: labelW, h: labelH };
                const overlaps = labelCache.some((cachedRect) =>
                    isOverlapping(testRect, cachedRect),
                );
                if (!overlaps) {
                    finalPos = pos;
                    break;
                }
            }
            labelCache.push({
                x: finalPos.x,
                y: finalPos.y,
                w: labelW,
                h: labelH,
                index,
            });

            ctx.fillStyle = itemColor;
            ctx.fillRect(finalPos.x, finalPos.y, labelW, labelH);
            ctx.fillStyle = "#fff";
            ctx.textBaseline = "middle";
            ctx.fillText(labelText, finalPos.x + 4, finalPos.y + labelH / 2);
            // 🌟 新增：绘制顶部多色横条
            if (item.palette && item.palette.length > 0) {
                let barStartX = bp1.x;
                let barWidth = rectW;

                // 如果数字标签在左上角，颜色条从标签右边开始画
                if (finalPos.x === bp1.x && finalPos.y === bp1.y) {
                    barStartX = bp1.x + labelW;
                    barWidth = rectW - labelW;
                }
                // 如果数字标签在右上角，颜色条从左边画到标签左边
                else if (finalPos.x === bp2.x - labelW && finalPos.y === bp1.y) {
                    barWidth = rectW - labelW;
                }

                // 如果还有剩余宽度，绘制多色块
                if (barWidth > 0) {
                    const colorW = barWidth / item.palette.length;
                    item.palette.forEach((color, i) => {
                        // 防止颜色为空，给个默认灰色
                        ctx.fillStyle = color || "#8c8c8c";
                        ctx.fillRect(barStartX + i * colorW, bp1.y, colorW, labelH);
                    });
                }
            }

            // 🌟 绘制框内描述 (完美复刻原版的 text 逻辑)
            let displayText = "";
            if (item.label === "text") {
                const textContent = item.text ? `"${item.text}"` : "";
                const descContent = item.caption || item.desc || "";
                if (textContent && descContent) {
                    displayText = `${textContent} — ${descContent}`;
                } else {
                    displayText = textContent || descContent;
                }
            } else {
                displayText = item.caption || item.desc || "";
            }

            if (displayText && rectH > labelH + 4) {
                const descFontSize = Math.max(9, Math.round(11 * displayScale));
                ctx.font = `${descFontSize}px sans-serif`;
                ctx.textBaseline = "top";

                const maxDescW = Math.max(10, rectW - 8);
                let displayDesc = displayText;
                let currentW = ctx.measureText(displayDesc).width;
                if (currentW > maxDescW) {
                    while (displayDesc.length > 1 && currentW > maxDescW) {
                        displayDesc = displayDesc.slice(0, -1);
                        currentW = ctx.measureText(displayDesc + "...").width;
                    }
                    displayDesc += "...";
                }

                let drawX = bp1.x + 4;
                let drawY = bp1.y + 4;
                if (finalPos.x === bp1.x && finalPos.y === bp1.y) {
                    drawY = finalPos.y + labelH + 2;
                }

                ctx.fillStyle = "rgba(0,0,0,0.6)";
                ctx.fillText(displayDesc, drawX + 1, drawY + 1);
                ctx.fillStyle = isActive ? "#fff" : "#ccc";
                ctx.fillText(displayDesc, drawX, drawY);
            }
        });

        if (snapGuides.length) {
            ctx.save();
            ctx.strokeStyle = "#4a9eff";
            ctx.lineWidth = 1;
            ctx.setLineDash([5, 4]);
            snapGuides.forEach((guide) => {
                if (guide.type === "spacing") {
                    const a = guide.axis === "x" ? logicToPhys(guide.from, guide.at) : logicToPhys(guide.at, guide.from);
                    const b = guide.axis === "x" ? logicToPhys(guide.to, guide.at) : logicToPhys(guide.at, guide.to);

                    ctx.beginPath();
                    ctx.moveTo(a.x, a.y);
                    ctx.lineTo(b.x, b.y);
                    ctx.stroke();

                    // 两端的刻度用实线，和虚线的距离线区分开
                    ctx.setLineDash([]);
                    ctx.beginPath();
                    if (guide.axis === "x") {
                        ctx.moveTo(a.x, a.y - 4);
                        ctx.lineTo(a.x, a.y + 4);
                        ctx.moveTo(b.x, b.y - 4);
                        ctx.lineTo(b.x, b.y + 4);
                    } else {
                        ctx.moveTo(a.x - 4, a.y);
                        ctx.lineTo(a.x + 4, a.y);
                        ctx.moveTo(b.x - 4, b.y);
                        ctx.lineTo(b.x + 4, b.y);
                    }
                    ctx.stroke();
                    ctx.setLineDash([5, 4]);

                    ctx.fillStyle = "#7cc0ff";
                    ctx.font = "11px sans-serif";
                    const label = String(Math.round(guide.gap));
                    if (guide.axis === "x") ctx.fillText(label, (a.x + b.x) / 2 - 6, a.y - 6);
                    else ctx.fillText(label, a.x + 6, (a.y + b.y) / 2);
                    return;
                }

                ctx.beginPath();
                if (guide.axis === "x") {
                    const px = logicToPhys(guide.pos, 0).x;
                    ctx.moveTo(px, p1.y);
                    ctx.lineTo(px, p2.y);
                } else {
                    const py = logicToPhys(0, guide.pos).y;
                    ctx.moveTo(p1.x, py);
                    ctx.lineTo(p2.x, py);
                }
                ctx.stroke();
            });
            ctx.restore();
        }
    };

    const resizeObserver = new ResizeObserver(() => drawCanvas());
    resizeObserver.observe(canvasContainer);

    // 🌟 画布聚焦时 Ctrl+V 粘贴图片为背景图
    canvas.addEventListener("paste", (e) => {
        if (document.activeElement !== canvas) return;
        const items = e.clipboardData?.items;
        if (!items) return;
        for (const item of items) {
            if (item.type && item.type.startsWith("image/")) {
                const blob = item.getAsFile();
                if (blob && loadBackgroundFromBlob(blob)) {
                    e.preventDefault();
                    e.stopPropagation(); // 防止 ComfyUI 全局粘贴节点/图片
                    return;
                }
            }
        }
    });
    // --- 鼠标交互 ---
    canvas.addEventListener(
        "wheel",
        (e) => {
            e.preventDefault();

            const rect = canvasContainer.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            const mouseY = e.clientY - rect.top;
            const centerX = rect.width / 2;
            const centerY = rect.height / 2;

            const oldScale = getActualScale();
            const lx = (mouseX - centerX - model.view.x) / oldScale;
            const ly = (mouseY - centerY - model.view.y) / oldScale;

            const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
            model.view.scale *= zoomFactor;
            model.view.scale = Math.max(0.1, Math.min(10, model.view.scale));

            const newScale = getActualScale();
            model.view.x = mouseX - centerX - lx * newScale;
            model.view.y = mouseY - centerY - ly * newScale;

            drawCanvas();
        },
        { passive: false },
    );

    // 背景图命中检测（操控模式）：返回 "tl"/"tr"/"bl"/"br"/"t"/"b"/"l"/"r"/"move"/null
    const getBgHitMode = (mouseX, mouseY) => {
        if (!bgActive || !bgImage) return null;
        const bp1 = logicToPhys(bgX - bgW / 2, bgY - bgH / 2);
        const bp2 = logicToPhys(bgX + bgW / 2, bgY + bgH / 2);
        // 拉伸点可能在画布外的黑色区域，容差放宽一点
        const handleDist = 18;

        const nearTL = Math.abs(mouseX - bp1.x) < handleDist && Math.abs(mouseY - bp1.y) < handleDist;
        const nearTR = Math.abs(mouseX - bp2.x) < handleDist && Math.abs(mouseY - bp1.y) < handleDist;
        const nearBL = Math.abs(mouseX - bp1.x) < handleDist && Math.abs(mouseY - bp2.y) < handleDist;
        const nearBR = Math.abs(mouseX - bp2.x) < handleDist && Math.abs(mouseY - bp2.y) < handleDist;

        const nearT = !nearTL && !nearTR && mouseY > bp1.y - handleDist && mouseY < bp1.y + handleDist && mouseX > bp1.x && mouseX < bp2.x;
        const nearB = !nearBL && !nearBR && mouseY > bp2.y - handleDist && mouseY < bp2.y + handleDist && mouseX > bp1.x && mouseX < bp2.x;
        const nearL = !nearTL && !nearBL && mouseX > bp1.x - handleDist && mouseX < bp1.x + handleDist && mouseY > bp1.y && mouseY < bp2.y;
        const nearR = !nearTR && !nearBR && mouseX > bp2.x - handleDist && mouseX < bp2.x + handleDist && mouseY > bp1.y && mouseY < bp2.y;

        if (nearTL) return "tl";
        if (nearTR) return "tr";
        if (nearBL) return "bl";
        if (nearBR) return "br";
        if (nearT) return "t";
        if (nearB) return "b";
        if (nearL) return "l";
        if (nearR) return "r";
        if (mouseX > bp1.x && mouseX < bp2.x && mouseY > bp1.y && mouseY < bp2.y) return "move";
        return null;
    };

    canvas.addEventListener("mousedown", (e) => {
        canvas.focus();
        snapReady = false;
        const rect = canvasContainer.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        if (e.button === 1) {
            isPanning = true;
            panStartX = mouseX;
            panStartY = mouseY;
            panStartViewX = model.view.x;
            panStartViewY = model.view.y;
            canvas.style.cursor = "grabbing";
            e.preventDefault();
            return;
        }

        if (e.button !== 0) return;

        // 🌟 背景图操控拦截
        if (bgActive && bgImage) {
            const hitMode = getBgHitMode(mouseX, mouseY);
            if (hitMode) {
                bgDragMode = hitMode;
                bgStartMouse = { x: mouseX, y: mouseY };
                bgStartBBox = { x: bgX, y: bgY, w: bgW, h: bgH };
                e.preventDefault();
                return; // 阻断后续的 bbox 逻辑
            }

            // 操控模式下点在空白处：既不新建框，也不平移画布。
            // 否则画布黑色区域里的背景图拉伸点会被“平移画布”的逻辑抢走。
            e.preventDefault();
            return;
        }

        // 🌟 画布外的黑色区域：左键拖动改为平移画布，不创建新框
        {
            const { w: cw, h: ch } = getCanvasSize();
            const tl = logicToPhys(-cw / 2, -ch / 2);
            const br = logicToPhys(cw / 2, ch / 2);
            const insideCanvas =
                mouseX >= tl.x && mouseX <= br.x && mouseY >= tl.y && mouseY <= br.y;

            if (!insideCanvas) {
                // 只有当这里本来会“新建框”时才改成平移，避免抢走框/标签的拖拽
                const preHit = getHitInfo(mouseX, mouseY);
                if (preHit.type === "create") {
                    isPanning = true;
                    panStartX = mouseX;
                    panStartY = mouseY;
                    panStartViewX = model.view.x;
                    panStartViewY = model.view.y;
                    canvas.style.cursor = "grabbing";
                    e.preventDefault();
                    return;
                }
            }
        }

        const hit = getHitInfo(mouseX, mouseY);
        const isCtrl = e.ctrlKey || e.metaKey;

        if (hit.type === "select-label") {
            const targetIdx = hit.index;
            const item = model.items[targetIdx];

            // 1. 处理选中逻辑
            if (isCtrl) {
                if (model.selection.has(targetIdx)) model.selection.delete(targetIdx);
                else model.selection.add(targetIdx);
                model.setActive(targetIdx);
            } else {
                if (!model.selection.has(targetIdx)) {
                    model.selection.clear();
                    model.selection.add(targetIdx);
                }
                model.setActive(targetIdx);
            }

            updateListSelection();
            syncEditorPanel(); // 点标签也弹出下方面板
            drawCanvas();

            // 2. 🌟 核心优化：如果不是锁定的，允许按住标签直接拖动！
            if (!item._locked) {
                dragMode = "move";
                dragStartMouse = { x: mouseX, y: mouseY };
                dragStartBBox = [...item.bbox];
            }
            
            e.preventDefault();
            return;
        }

        if (hit.type === "create") {
            if (!isCtrl) model.selection.clear();

            const { w, h } = getCanvasSize(); // 🌟 补上缺失的宽高获取
            const limitX = w / 2;
            const limitY = h / 2;

            const logicPos = physToLogic(mouseX, mouseY);
            let snapX = applySnap(logicPos.x, e.altKey, true);
            let snapY = applySnap(logicPos.y, e.altKey, false);

            snapX = Math.max(-limitX, Math.min(snapX, limitX));
            snapY = Math.max(-limitY, Math.min(snapY, limitY));

            model.items.push({
                label: "object",
                caption: "新对象",
                bbox: [snapY, snapX, snapY, snapX],
            });
            model.setActive(model.items.length - 1);
            model.selection.add(model.active);

            dragMode = "resize-br";
            dragStartMouse = { x: mouseX, y: mouseY };
            dragStartBBox = [...model.items[model.active].bbox];

            editorContainer.style.display = "none";
        } else {
            const targetIdx = hit.index;
            if (isCtrl) {
                if (model.selection.has(targetIdx)) model.selection.delete(targetIdx);
                else model.selection.add(targetIdx);
                model.setActive(targetIdx);
            } else {
                if (!model.selection.has(targetIdx)) {
                    model.selection.clear();
                    model.selection.add(targetIdx);
                }
                model.setActive(targetIdx);
            }

            dragMode = hit.type;
            dragStartMouse = { x: mouseX, y: mouseY };
            dragStartBBox = [...model.items[targetIdx].bbox];
        }

        updateListSelection();
        if (hit.type !== "create") {
            syncEditorPanel();
        }
        drawCanvas();
        e.preventDefault();
    });

    window.addEventListener("mousemove", (e) => {
        const rect = canvasContainer.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        if (isPanning) {
            model.view.x = panStartViewX + (mouseX - panStartX);
            model.view.y = panStartViewY + (mouseY - panStartY);
            drawCanvas();
            return;
        }

        // 🌟 背景图拖拽计算
        if (bgDragMode && bgImage) {
            const dx = (mouseX - bgStartMouse.x) / getActualScale();
            const dy = (mouseY - bgStartMouse.y) / getActualScale();

            let nx = bgStartBBox.x, ny = bgStartBBox.y, nw = bgStartBBox.w, nh = bgStartBBox.h;

            if (bgDragMode === "move") {
                nx += dx;
                ny += dy;

                // 🌟 吸附到画布：左/中/右、上/中/下（仅在勾选“吸附”时生效）
                if (bgSnap) {
                    const snapThreshold = 8 / getActualScale();
                    const { w: canvasW, h: canvasH } = getCanvasSize();
                    const xTargets = [-canvasW / 2, 0, canvasW / 2];
                    const yTargets = [-canvasH / 2, 0, canvasH / 2];

                    // 用三个锚点（起始边 / 中心 / 结束边）里最近的那个去吸附
                    const snapAxis = (pos, size, targets) => {
                        const anchors = [pos - size / 2, pos, pos + size / 2];
                        let bestDelta = null;
                        for (const a of anchors) {
                            for (const t of targets) {
                                const d = t - a;
                                if (
                                    Math.abs(d) <= snapThreshold &&
                                    (bestDelta === null || Math.abs(d) < Math.abs(bestDelta))
                                ) {
                                    bestDelta = d;
                                }
                            }
                        }
                        return bestDelta === null ? pos : pos + bestDelta;
                    };

                    nx = snapAxis(nx, nw, xTargets);
                    ny = snapAxis(ny, nh, yTargets);
                }
            } else {
                const startL = bgStartBBox.x - bgStartBBox.w / 2;
                const startR = bgStartBBox.x + bgStartBBox.w / 2;
                const startT = bgStartBBox.y - bgStartBBox.h / 2;
                const startB = bgStartBBox.y + bgStartBBox.h / 2;

                let L = startL, R = startR, T = startT, B = startB;
                if (bgDragMode.includes("l")) L = startL + dx;
                if (bgDragMode.includes("r")) R = startR + dx;
                if (bgDragMode.includes("t")) T = startT + dy;
                if (bgDragMode.includes("b")) B = startB + dy;

                // 🌟 吸附：拖动的这条边靠近画布边缘/中心时自动对齐（和平移吸附同一开关）
                if (bgSnap) {
                    const { w: canvasW, h: canvasH } = getCanvasSize();
                    const snapThr = 8 / getActualScale();
                    const xTargets = [-canvasW / 2, 0, canvasW / 2];
                    const yTargets = [-canvasH / 2, 0, canvasH / 2];

                    const snapEdge = (value, targets) => {
                        let best = null;
                        for (const t of targets) {
                            const d = Math.abs(t - value);
                            if (d <= snapThr && (best === null || d < Math.abs(best - value))) best = t;
                        }
                        return best === null ? value : best;
                    };

                    if (bgDragMode.includes("l")) L = snapEdge(L, xTargets);
                    if (bgDragMode.includes("r")) R = snapEdge(R, xTargets);
                    if (bgDragMode.includes("t")) T = snapEdge(T, yTargets);
                    if (bgDragMode.includes("b")) B = snapEdge(B, yTargets);
                }

                let w = R - L;
                let h = B - T;
                const horiz = bgDragMode.includes("l") || bgDragMode.includes("r");
                const vert = bgDragMode.includes("t") || bgDragMode.includes("b");

                // 🌟 锁定长宽比：拖四条边也会按比例联动，不只是拖角
                if (bgLockRatio && bgStartBBox.w > 0 && bgStartBBox.h > 0) {
                    const aspect = bgStartBBox.w / bgStartBBox.h;

                    if (horiz && vert) {
                        // 角：以位移较大的一维为准
                        if (Math.abs(w) >= Math.abs(h) * aspect) h = w / aspect;
                        else w = h * aspect;
                    } else if (horiz) {
                        h = w / aspect;
                    } else if (vert) {
                        w = h * aspect;
                    }

                    // 固定未被拖拽的边，其余方向保持原中心
                    if (bgDragMode.includes("l")) L = R - w;
                    else if (bgDragMode.includes("r")) R = L + w;
                    else {
                        L = bgStartBBox.x - w / 2;
                        R = bgStartBBox.x + w / 2;
                    }

                    if (bgDragMode.includes("t")) T = B - h;
                    else if (bgDragMode.includes("b")) B = T + h;
                    else {
                        T = bgStartBBox.y - h / 2;
                        B = bgStartBBox.y + h / 2;
                    }
                }

                nx = (L + R) / 2;
                ny = (T + B) / 2;
                nw = Math.abs(R - L);
                nh = Math.abs(B - T);
            }

            if (nw > 10 && nh > 10) {
                bgX = nx; bgY = ny; bgW = nw; bgH = nh;
                drawCanvas();
            }
            return; // 阻断后续的 bbox 逻辑
        }

        if (!dragMode) return;

        const dx = mouseX - dragStartMouse.x;
        const dy = mouseY - dragStartMouse.y;
        const scale = getActualScale();
        const logicDx = dx / scale;
        const logicDy = dy / scale;
        const { w, h } = getCanvasSize();
        const limitX = w / 2;
        const limitY = h / 2;

        let [ymin, xmin, ymax, xmax] = dragStartBBox;
        let newYmin = ymin, newXmin = xmin, newYmax = ymax, newXmax = xmax;

        if (dragMode === "move") {
            // 🌟 核心修复：用起始快照算出初始视觉边界，防止每一帧重复叠加总位移
            const tempItem = { bbox: dragStartBBox, _align: model.items[model.active]._align };
            const { isExtreme, vXmin, vYmin, vXmax, vYmax } = getVisualBounds(tempItem);
            
            if (isExtreme) {
                let newVx = vXmin + logicDx;
                let newVy = vYmin + logicDy;

                newVx = applySnap(newVx, e.altKey, true);
                newVy = applySnap(newVy, e.altKey, false);

                const snapped = snapMoveRect({ x: newVx, y: newVy, w: GRID_SNAP, h: GRID_SNAP }, e.altKey);
                newVx = snapped.x;
                newVy = snapped.y;
                setGuides(snapped.guides);

                newVx = Math.max(-limitX, Math.min(newVx, limitX - GRID_SNAP));
                newVy = Math.max(-limitY, Math.min(newVy, limitY - GRID_SNAP));

                applyVisualBounds(model.items[model.active], newVx, newVy);
            } else {
                let newXmin = vXmin + logicDx;
                let newYmin = vYmin + logicDy;

                newXmin = applySnap(newXmin, e.altKey, true);
                newYmin = applySnap(newYmin, e.altKey, false);

                const snapped = snapMoveRect(
                    { x: newXmin, y: newYmin, w: vXmax - vXmin, h: vYmax - vYmin },
                    e.altKey
                );
                newXmin = snapped.x;
                newYmin = snapped.y;
                setGuides(snapped.guides);

                newXmin = Math.max(-limitX, Math.min(newXmin, limitX - (vXmax - vXmin)));
                newYmin = Math.max(-limitY, Math.min(newYmin, limitY - (vYmax - vYmin)));

                model.items[model.active].bbox = [
                    newYmin, newXmin,
                    newYmin + (vYmax - vYmin), newXmin + (vXmax - vXmin)
                ];
            }
        } else if (dragMode.startsWith("resize")) {
            // 🌟 核心补全：处理四角拉伸拖拽
            const isRight = dragMode === "resize-r" || dragMode === "resize-tr" || dragMode === "resize-br";
            const isLeft = dragMode === "resize-l" || dragMode === "resize-tl" || dragMode === "resize-bl";
            const isTop = dragMode === "resize-t" || dragMode === "resize-tl" || dragMode === "resize-tr";
            const isBottom = dragMode === "resize-b" || dragMode === "resize-bl" || dragMode === "resize-br";

            if (isRight) newXmax += logicDx;
            if (isLeft) newXmin += logicDx;
            if (isBottom) newYmax += logicDy;
            if (isTop) newYmin += logicDy;

            // 吸附处理（只吸附正在拖拽的边，固定边不动）
            if (isLeft) newXmin = applySnap(newXmin, e.altKey, true);
            if (isRight) newXmax = applySnap(newXmax, e.altKey, true);
            if (isTop) newYmin = applySnap(newYmin, e.altKey, false);
            if (isBottom) newYmax = applySnap(newYmax, e.altKey, false);

            const edgeGuides = [];
            if (isLeft) {
                const r = snapEdge(newXmin, "x", e.altKey);
                newXmin = r.value;
                if (r.guide) edgeGuides.push(r.guide);
            }
            if (isRight) {
                const r = snapEdge(newXmax, "x", e.altKey);
                newXmax = r.value;
                if (r.guide) edgeGuides.push(r.guide);
            }
            if (isTop) {
                const r = snapEdge(newYmin, "y", e.altKey);
                newYmin = r.value;
                if (r.guide) edgeGuides.push(r.guide);
            }
            if (isBottom) {
                const r = snapEdge(newYmax, "y", e.altKey);
                newYmax = r.value;
                if (r.guide) edgeGuides.push(r.guide);
            }
            setGuides(edgeGuides);

            // 约束：允许自由缩小到 1，不再强制卡在 16
            if (isLeft) {
                newXmin = Math.min(newXmin, newXmax - 1);
            } else if (isRight) {
                newXmax = Math.max(newXmax, newXmin + 1);
            }
            if (isTop) {
                newYmin = Math.min(newYmin, newYmax - 1);
            } else if (isBottom) {
                newYmax = Math.max(newYmax, newYmin + 1);
            }

            // 画布边界限制
            newXmin = Math.max(-limitX, Math.min(newXmin, limitX));
            newXmax = Math.max(-limitX, Math.min(newXmax, limitX));
            newYmin = Math.max(-limitY, Math.min(newYmin, limitY));
            newYmax = Math.max(-limitY, Math.min(newYmax, limitY));

            model.items[model.active].bbox = [
                Math.min(newYmin, newYmax), Math.min(newXmin, newXmax),
                Math.max(newYmin, newYmax), Math.max(newXmin, newXmax),
            ];
        }
        drawCanvas();
    });

    window.addEventListener("mouseup", () => {
        if (bgDragMode) {
            bgDragMode = null;
            if (syncBgSizeHook) syncBgSizeHook(); // 拖动/拉伸结束后刷新尺寸输入框
            return;
        }
        if (isPanning) {
            isPanning = false;
            canvas.style.cursor = "default";
            return;
        }
        if (!dragMode) return;

        const currentDragMode = dragMode;
        const currentActive = model.active;
        dragMode = null;

        try {
            if (currentActive !== -1) {
                const item = model.items[currentActive];
                if (item) {
                    const [ymin, xmin, ymax, xmax] = item.bbox;
                    let w = xmax - xmin;
                    let h = ymax - ymin;

                    // 🌟 身份证查验
                    const isNew = !knownBboxHistory.has(dragStartBBox.join(","));

                    // 1. 防误触：新建框且极小，直接静默删除
                    if (isNew && w <= 5 && h <= 5) {
                        model.items.splice(currentActive, 1);
                        model.selection.delete(currentActive);
                        model.setActive(-1);
                        syncEditorPanel();
                        drawCanvas();
                        return;
                    }

                    // 2. 缩放到小于网格尺寸时，强制变为正方形极小框
                    if (currentDragMode && currentDragMode.startsWith("resize") && (w < GRID_SNAP || h < GRID_SNAP)) {
                        const finalSize = Math.max(1, Math.min(w, h));
                        
                        // 🌟 核心修复：在这里获取画布尺寸，防止 limitX 报错！
                        const { w: canvasW, h: canvasH } = getCanvasSize();
                        const limitX = canvasW / 2;
                        const limitY = canvasH / 2;
                        const halfT = GRID_SNAP / 2;

                        // 计算视觉代理框的安全中心点，防止视觉框溢出画布
                        let cx = (xmin + xmax) / 2;
                        let cy = (ymin + ymax) / 2;
                        cx = Math.max(-limitX + halfT, Math.min(cx, limitX - halfT));
                        cy = Math.max(-limitY + halfT, Math.min(cy, limitY - halfT));

                        const finalXmin = Math.round(cx - finalSize / 2);
                        const finalYmin = Math.round(cy - finalSize / 2);
                        
                        item.bbox = [finalYmin, finalXmin, finalYmin + finalSize, finalXmin + finalSize];
                    }
                    
                    // 3. 刷新通行证
                    knownBboxHistory.add(item.bbox.join(","));
                }
            }

            if (model.active !== -1) {
                saveEditorChanges();
                const lastActive = model.active;
                renderList(false);
                model.setActive(lastActive);
                if (model.items[model.active]) {
                    syncEditorPanel();
                }
            }
        } catch (err) {
            console.error("[MOSS] mouseup error:", err);
        } finally {
            setGuides([]);
            snapReady = false;
            drawCanvas();
            if (node.graph) node.graph.setDirtyCanvas(true, true);
        }
    });

    canvas.addEventListener("auxclick", (e) => {
        if (e.button === 1) e.preventDefault();
    });

    const getHitInfo = (mouseX, mouseY) => {
        const handleDist = 12;
        
        // 提取单框命中检测逻辑
        const checkItemHit = (item, i) => {
            const { vXmin, vYmin, vXmax, vYmax, isExtreme } = getVisualBounds(item);
            const p1 = logicToPhys(vXmin, vYmin);
            const p2 = logicToPhys(vXmax, vYmax);

            // 检测四角（极小框跳过）
            if (!isExtreme) {
                const nearTL = Math.abs(mouseX - p1.x) < handleDist && Math.abs(mouseY - p1.y) < handleDist;
                const nearTR = Math.abs(mouseX - p2.x) < handleDist && Math.abs(mouseY - p1.y) < handleDist;
                const nearBL = Math.abs(mouseX - p1.x) < handleDist && Math.abs(mouseY - p2.y) < handleDist;
                const nearBR = Math.abs(mouseX - p2.x) < handleDist && Math.abs(mouseY - p2.y) < handleDist;

                if (nearTL) return { type: "resize-tl", index: i };
                if (nearTR) return { type: "resize-tr", index: i };
                if (nearBL) return { type: "resize-bl", index: i };
                if (nearBR) return { type: "resize-br", index: i };
            }

            // 检测框体内部或极小框
            if (mouseX >= p1.x && mouseX <= p2.x && mouseY >= p1.y && mouseY <= p2.y) {
                if (item._locked) return { type: "select-label", index: i };
                return { type: "move", index: i };
            }
            return null;
        };

        // 🌟 1. 绝对最高优先级：检测数字标签（确保重叠时能通过点标签切换选中）
        for (let i = labelCache.length - 1; i >= 0; i--) {
            const l = labelCache[i];
            if (mouseX >= l.x && mouseX <= l.x + l.w && mouseY >= l.y && mouseY <= l.y + l.h) {
                return { type: "select-label", index: l.index };
            }
        }

        // 🌟 2. 次高优先级：检测当前已经选中的框（选中后操作它时，不被其他框抢走焦点）
        if (model.active !== -1 && model.items[model.active]) {
            const hit = checkItemHit(model.items[model.active], model.active);
            if (hit) return hit;
        }

        // 🌟 3. 最后：检测其他框（从后往前遍历）
        for (let i = model.items.length - 1; i >= 0; i--) {
            if (i === model.active) continue; // 刚刚已经测过了，跳过
            const hit = checkItemHit(model.items[i], i);
            if (hit) return hit;
        }
        
        return { type: "create", index: -1 };
    };

    // --- 🌟 双击修改描述功能 ---
    canvas.addEventListener("dblclick", (e) => {
        e.preventDefault();
        const rect = canvasContainer.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        // 与单击保持一致：优先「当前选中的框」→ 数字标签 → 其他框。
        // 之前这里只按序号从大到小扫，重叠时会把精确选中的小框顶掉。
        let targetIdx = -1;

        const hit = getHitInfo(mouseX, mouseY);
        if (hit && typeof hit.index === "number" && model.items[hit.index]) {
            targetIdx = hit.index;
        }

        if (targetIdx === -1) {
            for (let i = model.items.length - 1; i >= 0; i--) {
                const item = model.items[i];
                const bbox = item && item.bbox;
                if (!bbox || bbox.length !== 4) continue;
                const { vXmin, vYmin, vXmax, vYmax } = getVisualBounds(item);
                const p1 = logicToPhys(vXmin, vYmin);
                const p2 = logicToPhys(vXmax, vYmax);
                if (mouseX >= p1.x && mouseX <= p2.x && mouseY >= p1.y && mouseY <= p2.y) {
                    targetIdx = i;
                    break;
                }
            }
        }

        if (targetIdx !== -1) {
            // 选中该框
            model.setActive(targetIdx);
            model.selection.clear();
            model.selection.add(targetIdx);
            updateListSelection();
            syncEditorPanel();
            drawCanvas();

            // 计算悬浮输入框的位置和大小
            const bbox = model.items[targetIdx].bbox;
            const p1 = logicToPhys(bbox[1], bbox[0]);
            const p2 = logicToPhys(bbox[3], bbox[2]);

            // 创建 textarea
            const inlineInput = document.createElement("textarea");
            inlineInput.value =
                model.items[targetIdx].caption || model.items[targetIdx].desc || "";
            inlineInput.style.cssText = `
                position: absolute;
                left: ${p1.x}px;
                top: ${p1.y}px;
                width: ${Math.max(50, p2.x - p1.x)}px;
                height: ${Math.max(30, p2.y - p1.y)}px;
                background: rgba(0, 0, 0, 0.85);
                color: #fff;
                border: 2px solid #4a9eff;
                border-radius: 4px;
                padding: 4px;
                font-size: 12px;
                font-family: sans-serif;
                resize: none;
                outline: none;
                z-index: 100;
            `;

            canvasContainer.appendChild(inlineInput);
            inlineInput.focus();
            inlineInput.select();

            // 保存逻辑
            let inlineSaved = false;
            const saveInline = () => {
                if (inlineSaved) return; // Enter 后移除元素会再触发 blur，避免重复保存
                inlineSaved = true;
                const newText = inlineInput.value.trim();
                if (model.items[targetIdx]) {
                    const changed = (model.items[targetIdx].caption || "") !== newText;
                    model.items[targetIdx].caption = newText;
                    saveEditorChanges(); // 同步到 JSON、右侧列表
                    // 同步下方属性面板的「描述」输入框
                    if (changed) syncEditorPanel();
                }
                if (inlineInput.parentNode)
                    inlineInput.parentNode.removeChild(inlineInput);
            };

            // 失焦保存
            inlineInput.addEventListener("blur", saveInline);

            // 边打字边把内容同步到下方属性面板的「描述」
            inlineInput.addEventListener("input", () => {
                if (document.activeElement === descArea) return;
                descArea.value = inlineInput.value;
            });

            // 键盘快捷键
            inlineInput.addEventListener("keydown", (ev) => {
                ev.stopPropagation(); // 防止触发画布的删除快捷键
                if (ev.key === "Enter" && !ev.shiftKey) {
                    ev.preventDefault();
                    saveInline();
                } else if (ev.key === "Escape") {
                    ev.preventDefault();
                    inlineSaved = true; // 放弃修改：别让 blur 再保存一次
                    if (inlineInput.parentNode)
                        inlineInput.parentNode.removeChild(inlineInput);
                    syncEditorPanel(); // 把面板里的临时文本还原
                }
            });
        }
    });

    // 🌟 框的复制 / 粘贴（Ctrl+C / Ctrl+V）
    const cloneItemForClipboard = (item) => {
        const copy = JSON.parse(JSON.stringify(item));
        Object.keys(copy).forEach((k) => {
            if (k.startsWith("_")) delete copy[k];
        });
        return copy;
    };

    const copySelectedBoxes = () => {
        const idxs = model.selection.size
            ? Array.from(model.selection)
            : model.active !== -1
              ? [model.active]
              : [];
        if (!idxs.length) return false;
        idxs.sort((a, b) => a - b);
        bboxClipboard = idxs
            .map((i) => model.items[i])
            .filter(Boolean)
            .map(cloneItemForClipboard);
        return bboxClipboard.length > 0;
    };

    const pasteBoxes = () => {
        if (!bboxClipboard.length) return false;
        const { w, h } = getCanvasSize();
        const limitX = w / 2;
        const limitY = h / 2;
        const offset = 10; // 粘出来的框稍微错开，避免完全重叠看不见

        const added = [];
        bboxClipboard.forEach((src) => {
            const clone = JSON.parse(JSON.stringify(src));
            const bbox = Array.isArray(clone.bbox) ? clone.bbox : null;
            if (!bbox || bbox.length !== 4) return;

            const bw = bbox[3] - bbox[1];
            const bh = bbox[2] - bbox[0];
            const xmin = Math.max(-limitX, Math.min(bbox[1] + offset, limitX - bw));
            const ymin = Math.max(-limitY, Math.min(bbox[0] + offset, limitY - bh));

            clone.bbox = [ymin, xmin, ymin + bh, xmin + bw];
            model.items.push(clone);
            added.push(model.items.length - 1);
        });

        if (!added.length) return false;

        model.setActive(added[added.length - 1]);
        model.selection.clear();
        added.forEach((i) => model.selection.add(i));

        saveEditorChanges();
        renderList();
        syncEditorPanel();
        drawCanvas();
        return true;
    };

    const isPanelOpen = () => {
        if (!panel || !document.body.contains(panel)) return false;
        return panel.style.display !== "none";
    };

    // 只在"面板内"或"画布聚焦"时接管快捷键，避免抢走 ComfyUI 自己的复制粘贴
    const isOurContext = (target) => {
        if (target === canvas || panel.contains(target)) return true;
        const ae = document.activeElement;
        return ae === canvas || (ae && panel.contains(ae));
    };

    const isTypingElsewhere = () => {
        const ae = document.activeElement;
        if (!ae) return false;
        return (
            ae.tagName === "INPUT" ||
            ae.tagName === "TEXTAREA" ||
            ae.tagName === "SELECT" ||
            ae.isContentEditable
        );
    };

    const onPanelCopyKeydown = (e) => {
        if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
        if ((e.key || "").toLowerCase() !== "c") return;
        if (!document.body.contains(panel)) {
            window.removeEventListener("keydown", onPanelCopyKeydown, true);
            return;
        }
        if (!isPanelOpen() || isTypingElsewhere()) return;
        if (!isOurContext(e.target)) return;

        if (copySelectedBoxes()) {
            e.preventDefault();
            e.stopPropagation();
        }
    };
    window.addEventListener("keydown", onPanelCopyKeydown, true);

    const onPanelPaste = (e) => {
        if (!document.body.contains(panel)) {
            document.removeEventListener("paste", onPanelPaste, true);
            return;
        }
        if (e.defaultPrevented || !isPanelOpen() || isTypingElsewhere()) return;
        if (!isOurContext(e.target)) return;

        // 剪贴板里是图片 → 交给背景图逻辑（canvas 的 paste 监听会处理）
        const items = e.clipboardData?.items;
        const hasImage = items
            ? Array.from(items).some((it) => it.type && it.type.startsWith("image/"))
            : false;
        if (hasImage) return;

        if (bboxClipboard.length && pasteBoxes()) {
            e.preventDefault();
            e.stopPropagation();
        }
    };
    document.addEventListener("paste", onPanelPaste, true);

    canvas.addEventListener("keydown", (e) => {
        if (e.key === "Delete" || e.key === "Backspace") {
            if (document.activeElement !== canvas) return;

            // 🌟 优先：处于"操控背景图"模式时，Delete/Backspace 删除背景图
            if (bgActive && bgImage) {
                deleteBackgroundImage();
                e.preventDefault();
                return;
            }
            
            if (model.selection.size > 0 && document.activeElement === canvas) {
                const indicesToRemove = Array.from(model.selection).sort((a, b) => b - a);
                const raw = JSON.parse(jsonWidget.value);
                const isArray = Array.isArray(raw);
                const data = isArray ? raw : { ...raw, items: model.items };
                const items = isArray ? data : data.items;
                indicesToRemove.forEach((idx) => items.splice(idx, 1));

                model.setActive(-1);
                model.selection.clear();

                isUpdatingFromUI = true;
                jsonWidget.value = serializeLayout(data);
                if (jsonWidget.callback) jsonWidget.callback(jsonWidget.value);
                isUpdatingFromUI = false;
                recordHistory(jsonWidget.value, false);
                renderList();
                syncEditorPanel();
                drawCanvas();
                if (node.graph) node.graph.setDirtyCanvas(true, true);
                e.preventDefault();
            }
        }
    });

    canvas.addEventListener("mousemove", (e) => {
        if (isPanning || dragMode) return;
        const rect = canvasContainer.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        // 🌟 最高优先级：操控背景图时的光标（移动 / 拉伸），优先于框和黑色区域
        if (bgActive && bgImage) {
            const mode = getBgHitMode(mouseX, mouseY);
            if (mode === "tl" || mode === "br") canvas.style.cursor = "nwse-resize";
            else if (mode === "tr" || mode === "bl") canvas.style.cursor = "nesw-resize";
            else if (mode === "t" || mode === "b") canvas.style.cursor = "ns-resize";
            else if (mode === "l" || mode === "r") canvas.style.cursor = "ew-resize";
            else if (mode === "move") canvas.style.cursor = "move";
            else canvas.style.cursor = "default"; // 操控模式下空白处不建框、不平移
            return;
        }

        let hoveredLabel = false;
        for (let l of labelCache) {
            if (
                mouseX >= l.x &&
                mouseX <= l.x + l.w &&
                mouseY >= l.y &&
                mouseY <= l.y + l.h
            ) {
                hoveredLabel = true;
                break;
            }
        }

        if (hoveredLabel) {
            canvas.style.cursor = "pointer";
            return;
        }

        const hit = getHitInfo(mouseX, mouseY);

        if (hit.type === "create") {
            // 画布外的黑色区域拖动是“平移”，光标也换成抓手
            const { w: cw, h: ch } = getCanvasSize();
            const tl = logicToPhys(-cw / 2, -ch / 2);
            const br = logicToPhys(cw / 2, ch / 2);
            const insideCanvas =
                mouseX >= tl.x && mouseX <= br.x && mouseY >= tl.y && mouseY <= br.y;
            canvas.style.cursor = insideCanvas ? "crosshair" : "grab";
        } else if (hit.type === "move") canvas.style.cursor = "move";
        else if (hit.type === "resize-tl" || hit.type === "resize-br")
            canvas.style.cursor = "nwse-resize";
        else if (hit.type === "resize-tr" || hit.type === "resize-bl")
            canvas.style.cursor = "nesw-resize";
    });

    canvas.addEventListener("mouseleave", () => {
        if (!isPanning && !dragMode) canvas.style.cursor = "default";
    });

    const updateListSelection = () => {
        const cbs = listArea.querySelectorAll("input[type='checkbox']");
        Array.from(listArea.children).forEach((child, i) => {
            const isSel = model.selection.has(i);
            if (cbs[i]) cbs[i].checked = isSel;

            child.style.background =
                i === model.active ? "#324664" : isSel ? "#2a3a4f" : "#2a2a2a";
            child.style.borderColor =
                i === model.active ? "#5c8ccb" : isSel ? "#4a7ab5" : "#333";
        });
        selectAllBtn.classList.toggle(
            "is-active",
            model.items.length > 0 && model.selection.size === model.items.length
        );
        updateAlignState();
    };

        // 🌟 同步 canvas 字段到 UI
    const syncCanvasMode = () => {
        try {
            const data = JSON.parse(jsonWidget.value || "{}");
            const canvasMode = data?.summary?.canvas || "";
            if (canvasModeSelect.value !== canvasMode) {
                // 如果 JSON 里有个我们预设之外的 custom 值，动态添加进去
                let optionExists = Array.from(canvasModeSelect.options).some(o => o.value === canvasMode);
                if (!optionExists && canvasMode) {
                    const o = document.createElement("option");
                    o.value = canvasMode;
                    o.textContent = canvasMode;
                    canvasModeSelect.appendChild(o);
                }
                canvasModeSelect.value = canvasMode;
            }
        } catch (e) { }
    };

        // 🌟 同步主提示词到 UI
    const syncPrompt = () => {
        // 如果用户正在输入，不要覆盖它的光标和内容
        if (document.activeElement === promptTextarea) return;
        try {
            const data = JSON.parse(jsonWidget.value || "{}");
            const caption = data?.summary?.caption || "";
            if (promptTextarea.value !== caption) {
                promptTextarea.value = caption;
            }
        } catch (e) { }
    };

    // 🌟 监听主提示词输入，写入 JSON
    promptTextarea.addEventListener("input", () => {
        const val = promptTextarea.value;
        try {
            let data = JSON.parse(jsonWidget.value || "{}");
            if (Array.isArray(data)) {
                data = { summary: { caption: "" }, items: data };
            }
            if (!data.summary) data.summary = {};
            data.summary.caption = val;

            isUpdatingFromUI = true;
            jsonWidget.value = serializeLayout(data);
            if (jsonWidget.callback) jsonWidget.callback(jsonWidget.value);
            isUpdatingFromUI = false;
            recordHistory(jsonWidget.value);
            
            if (node.graph) node.graph.setDirtyCanvas(true, true);
        } catch (e) {
            console.error("[MOSS] 更新主提示词失败:", e);
        }
    });

    // 🌟 监听下拉框变化，写入 JSON
    canvasModeSelect.onchange = () => {
        const val = canvasModeSelect.value;
        try {
            let data = JSON.parse(jsonWidget.value || "{}");
            if (Array.isArray(data)) {
                data = { summary: { caption: "" }, items: data };
            }
            if (!data.summary) data.summary = {};

            if (val === "") {
                delete data.summary.canvas;
            } else {
                data.summary.canvas = val;
            }

            isUpdatingFromUI = true;
            jsonWidget.value = serializeLayout(data);
            if (jsonWidget.callback) jsonWidget.callback(jsonWidget.value);
            isUpdatingFromUI = false;
            recordHistory(jsonWidget.value, false);
            
            if (node.graph) node.graph.setDirtyCanvas(true, true);
        } catch (e) {
            console.error("[MOSS] 更新 canvas 字段失败:", e);
        }
    };

    // ================= 列表拖动排序 =================
    let listDrag = null;

    const listRows = () =>
        Array.from(listArea.children).filter((el) => el.dataset && el.dataset.index !== undefined);

    const snapshotTops = (rows) => {
        const map = new Map();
        rows.forEach((el) => map.set(el, el.getBoundingClientRect()));
        return map;
    };

    // FLIP：先反向位移，再过渡回原位，得到平滑的让位动画
    const animateRows = (rows, beforeMap) => {
        rows.forEach((el) => {
            const before = beforeMap.get(el);
            if (!before) return;
            const after = el.getBoundingClientRect();
            const dy = before.top - after.top;
            if (Math.abs(dy) < 1) return;
            el.style.transition = "none";
            el.style.transform = `translateY(${dy}px)`;
            void el.offsetHeight; // 强制回流，让上面的位移立即生效
            el.style.transition = "transform 0.16s cubic-bezier(0.2, 0.8, 0.3, 1)";
            el.style.transform = "";
        });
    };

    const onRowDragMove = (e) => {
        if (!listDrag) return;
        const { row, placeholder } = listDrag;
        // 拖动期间列表被重建（例如外部触发了 renderList），直接放弃这次拖动
        if (!row.isConnected || !placeholder.isConnected) return;

        row.style.top = `${e.clientY - listDrag.grabOffsetY - listDrag.panelTop}px`;

        const rowsNow = listRows().filter((el) => el !== row);
        const beforeMap = snapshotTops(rowsNow);
        const others = rowsNow.filter((el) => el !== placeholder);

        // 指针落在哪一行的上半部之前，就插到那一行前面
        let ref = null;
        for (const el of others) {
            const r = el.getBoundingClientRect();
            if (e.clientY < r.top + r.height / 2) {
                ref = el;
                break;
            }
        }

        const alreadyThere = ref
            ? placeholder.nextElementSibling === ref
            : placeholder === listArea.lastElementChild;
        if (alreadyThere) return;

        if (ref) listArea.insertBefore(placeholder, ref);
        else listArea.appendChild(placeholder);

        animateRows(rowsNow, beforeMap);
    };

    const onRowDragEnd = () => {
        if (!listDrag) return;
        const { row, placeholder, fromIndex, origCss } = listDrag;

        window.removeEventListener("pointermove", onRowDragMove);
        window.removeEventListener("pointerup", onRowDragEnd);
        window.removeEventListener("pointercancel", onRowDragEnd);
        document.body.style.userSelect = "";
        document.body.style.cursor = "";

        row.classList.remove("is-dragging");
        row.style.cssText = origCss;

        // 占位符已经被列表重建清掉时，只要把行收回来即可
        if (!placeholder.isConnected) {
            row.remove();
            listDrag = null;
            renderList();
            return;
        }

        // 占位符前面有多少个真实行，就是新的落点
        const all = Array.from(listArea.children);
        const toIndex = all
            .slice(0, all.indexOf(placeholder))
            .filter((el) => el.dataset.index !== undefined).length;

        listArea.insertBefore(row, placeholder);
        placeholder.remove();
        listDrag = null;

        if (toIndex === fromIndex) {
            updateListSelection();
            return;
        }

        // 重排数据并写回 JSON
        const [moved] = model.items.splice(fromIndex, 1);
        model.items.splice(toIndex, 0, moved);

        try {
            let parsed = JSON.parse(jsonWidget.value || "{}");
            if (Array.isArray(parsed)) {
                parsed = model.items;
            } else {
                parsed.items = model.items;
            }
            isUpdatingFromUI = true;
            jsonWidget.value = serializeLayout(parsed);
            if (jsonWidget.callback) jsonWidget.callback(jsonWidget.value);
            isUpdatingFromUI = false;
            recordHistory(jsonWidget.value, false);
        } catch (err) {
            console.error("[MOSS] 排序写回失败:", err);
        }

        renderList();
        model.selection.clear();
        model.selection.add(toIndex);
        model.setActive(toIndex);
        updateListSelection();
        syncEditorPanel();
        drawCanvas();
        if (node.graph) node.graph.setDirtyCanvas(true, true);
    };

    const beginRowDrag = (e, row, index) => {
        if (listDrag || model.items.length < 2) return;
        e.preventDefault();
        e.stopPropagation();

        const rect = row.getBoundingClientRect();
        const panelRect = panel.getBoundingClientRect();
        const placeholder = document.createElement("div");
        placeholder.className = "moss-row-placeholder";
        placeholder.style.height = `${rect.height}px`;
        placeholder.style.boxSizing = "border-box";

        const origCss = row.style.cssText;
        row.parentElement.insertBefore(placeholder, row);

        row.dataset.index = String(index);
        row.classList.add("is-dragging");
        // 🌟 挂在主面板内部并用面板相对坐标：
        // 挂到 body 上会受页面变换/视口影响，可能撑出滚动条把左侧画布挤窄
        row.style.position = "absolute";
        row.style.boxSizing = "border-box";
        row.style.left = `${rect.left - panelRect.left}px`;
        row.style.top = `${rect.top - panelRect.top}px`;
        row.style.width = `${rect.width}px`;
        row.style.height = `${rect.height}px`;
        row.style.margin = "0";
        row.style.zIndex = "9999";
        row.style.pointerEvents = "none";
        row.style.opacity = "0.98";
        row.style.boxShadow = "0 12px 26px rgba(0, 0, 0, 0.65)";
        row.style.transition = "box-shadow 0.15s ease";
        panel.appendChild(row);

        listDrag = {
            row,
            placeholder,
            fromIndex: index,
            origCss,
            grabOffsetY: e.clientY - rect.top,
            pointerId: e.pointerId,
            panelTop: panelRect.top,
        };

        document.body.style.userSelect = "none";
        document.body.style.cursor = "grabbing";

        window.addEventListener("pointermove", onRowDragMove);
        window.addEventListener("pointerup", onRowDragEnd);
        window.addEventListener("pointercancel", onRowDragEnd);
    };

    const renderList = (resetActive = true) => {
        syncCanvasMode();
        syncPrompt();

        if (resetActive) {
            model.setActive(-1);
            model.selection.clear();
            syncEditorPanel();
        }
        listArea.innerHTML = "";
        selectAllBtn.classList.remove("is-active");

        const prevItems = model.items;
        try {
            const data = JSON.parse(jsonWidget.value || "{}");
            model.setItems(Array.isArray(data) ? data : data.items || []);
            carryEditorState(prevItems, model.items);
            syncColorWidget();

            knownBboxHistory.clear();
            model.items.forEach(item => {
                if (item.bbox && item.bbox.length === 4) {
                    knownBboxHistory.add(item.bbox.join(","));
                }
            });
        } catch (e) {
            listArea.innerHTML = "<div style='color:#888;'>JSON 格式错误</div>";
            drawCanvas();
            return;
        }

        if (model.items.length === 0) {
            listArea.innerHTML = "<div style='color:#888;'>当前没有边界框</div>";
            drawCanvas();
            return;
        }

        model.items.forEach((item, index) => {
            const row = document.createElement("div");
            // 🌟 极小框红色高亮
            const realW = item.bbox[3] - item.bbox[1];
            const realH = item.bbox[2] - item.bbox[0];
            const isExtreme = realW < GRID_SNAP || realH < GRID_SNAP;
            
            row.style.cssText = `display: flex; align-items: center; gap: 8px; padding: 6px 8px; background: #2a2a2a; border-radius: 4px; border: 1px solid ${isExtreme ? '#ff4a4a' : '#333'}; flex-shrink: 0; min-width: 0; cursor: pointer;`;
            row.dataset.index = String(index);

            // 🌟 左侧六点拖动柄：按住即可上下拖动排序
            const grip = document.createElement("span");
            grip.className = "moss-grip";
            grip.textContent = "⠿";
            grip.title = "按住拖动排序";
            grip.addEventListener("pointerdown", (e) => beginRowDrag(e, row, index));

            const cb = document.createElement("input");
            cb.type = "checkbox";
            cb.dataset.index = index;
            cb.checked = model.selection.has(index);
            cb.style.cssText = "cursor: pointer; accent-color: #4a9eff;";

            cb.addEventListener("change", () => {
                if (cb.checked) {
                    model.selection.add(index);
                    model.setActive(index);
                } else {
                    model.selection.delete(index);
                    if (model.active === index) model.setActive(-1);
                }
                updateListSelection();
                syncEditorPanel();
                drawCanvas();
            });

            row.addEventListener("click", (e) => {
                if (e.target.closest?.(".moss-grip")) return; // 拖动柄不触发选中
                if (e.target !== cb && e.target.tagName !== "BUTTON") {
                    if (e.ctrlKey || e.metaKey) {
                        cb.checked = !cb.checked;
                    } else {
                        if (!cb.checked) {
                            model.selection.clear();
                            cb.checked = true;
                        }
                    }
                    cb.dispatchEvent(new Event("change"));
                }
            });

            const label = document.createElement("span");
            label.className = "moss-row-label";
            let text = item.caption || item.desc || `未命名 (${item.label || "object"})`;
            if (isExtreme) text = `[极小框 ${realW}x${realH}] ${text}`; // 显示真实尺寸
            
            label.textContent = `${index + 1}. ${text.length > 15 ? text.substring(0, 15) + "..." : text}`;
            label.style.cssText = `color: ${isExtreme ? '#ff4a4a' : '#ccc'}; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; pointer-events: none;`;

            // 🌟 锁定按钮
            const lockBtn = document.createElement("button");
            lockBtn.textContent = item._locked ? "🔒" : "🔓";
            lockBtn.title = item._locked ? "已锁住，点击解锁" : "锁住框，禁止拖动";
            lockBtn.style.cssText = "background: transparent; border: none; cursor: pointer; font-size: 14px; padding: 0;";
            lockBtn.onclick = (e) => {
                e.stopPropagation();
                item._locked = !item._locked;
                lockBtn.textContent = item._locked ? "🔒" : "🔓";
                // 锁定状态不存入 JSON，只是前端内存状态
                drawCanvas();
            };

            row.appendChild(grip);
            row.appendChild(cb);
            row.appendChild(label);
            row.appendChild(lockBtn);
            listArea.appendChild(row);
        });

        setTimeout(() => {
            updateListSelection();
            syncEditorPanel();
            drawCanvas();
        }, 10);
    };

    addBtn.addEventListener("click", () => {
        try {
            let data = JSON.parse(jsonWidget.value || "{}");
            if (Array.isArray(data))
                data = { summary: { caption: "杰作" }, items: data };
            if (!data.items) data.items = [];
            data.items.push({
                label: "object",
                caption: "新对象",
                bbox: [-128, -128, 128, 128],
            });

            knownBboxHistory.add("-128,-128,128,128");

            isUpdatingFromUI = true;
            jsonWidget.value = serializeLayout(data);
            if (jsonWidget.callback) jsonWidget.callback(jsonWidget.value);
            isUpdatingFromUI = false;
            recordHistory(jsonWidget.value, false);

            model.selection.clear();
            model.selection.add(data.items.length - 1);
            model.setActive(data.items.length - 1);

            renderList(false);
            syncEditorPanel();
            listArea.scrollTop = listArea.scrollHeight;
            if (node.graph) node.graph.setDirtyCanvas(true, true);
        } catch (e) {
            alert("增加失败！");
        }
    });

    deleteBtn.addEventListener("click", () => {
        if (model.selection.size === 0) return alert("请先勾选要删除的框！");
        if (!confirm(`确定要删除选中的 ${model.selection.size} 个框吗？`)) return;

        const indicesToRemove = Array.from(model.selection).sort((a, b) => b - a);

        try {
            let data = JSON.parse(jsonWidget.value);
            let items = Array.isArray(data) ? data : data.items;
            indicesToRemove.forEach((idx) => items.splice(idx, 1));

            isUpdatingFromUI = true;
            jsonWidget.value = serializeLayout(data);
            if (jsonWidget.callback) jsonWidget.callback(jsonWidget.value);
            isUpdatingFromUI = false;
            recordHistory(jsonWidget.value, false);

            model.selection.clear();
            model.setActive(-1);
            renderList();
            syncEditorPanel();
            if (node.graph) node.graph.setDirtyCanvas(true, true);
        } catch (e) {
            alert("删除失败！");
        }
    });

    // 把草稿格式（abs/xyxy）就地转成模型格式（abs_centralized/yxyx），并同步画布尺寸。
    // width / height 会保留在 JSON 里（模型格式也允许携带），只在生成提示词时剥离。
    const normalizeJsonWidget = () => {
        const wW = node.widgets?.find((x) => x.name === "canvas_width");
        const hW = node.widgets?.find((x) => x.name === "canvas_height");
        let parsed;
        try {
            parsed = JSON.parse(jsonWidget.value || "{}");
        } catch (_) {
            return;
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;

        const res = normalizeLayoutSchema(parsed, wW?.value, hW?.value);

        // JSON 自带画布尺寸时，以它为准同步到节点控件
        if (res.width && wW && wW.value !== res.width) {
            wW.value = res.width;
            wW.callback?.(wW.value);
        }
        if (res.height && hW && hW.value !== res.height) {
            hW.value = res.height;
            hW.callback?.(hW.value);
        }

        if (!res.converted) return;

        isUpdatingFromUI = true;
        jsonWidget.value = serializeLayout(parsed);
        jsonWidget.callback?.(jsonWidget.value); // 只刷新控件显示，不触发 renderList
        isUpdatingFromUI = false;
        console.log("[MOSS] 已把草稿格式(abs/xyxy)转换为模型格式(abs_centralized/yxyx)");
    };

    // 画布控件变化时，把 JSON 里已有的 width / height 同步过去（不主动新增字段）
    const syncCanvasSizeToJson = (key, value) => {
        let parsed;
        try {
            parsed = JSON.parse(jsonWidget.value || "{}");
        } catch (_) {
            return;
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
        if (!(key in parsed)) return;
        const num = Number(value);
        if (!Number.isFinite(num) || Number(parsed[key]) === num) return;
        parsed[key] = num;
        isUpdatingFromUI = true;
        jsonWidget.value = serializeLayout(parsed);
        jsonWidget.callback?.(jsonWidget.value);
        isUpdatingFromUI = false;
    };

    const origCallback = jsonWidget.callback;
    jsonWidget.callback = function () {
        if (origCallback) origCallback.apply(this, arguments);
        if (isUpdatingFromUI) return;
        normalizeJsonWidget();
        recordHistory(jsonWidget.value); // 手动改 JSON 也进撤销栈（连续输入会合并）
        renderList();
    };

    const wWidget = node.widgets.find((w) => w.name === "canvas_width");
    const hWidget = node.widgets.find((w) => w.name === "canvas_height");
    if (wWidget && hWidget) {
        const origWCb = wWidget.callback,
            origHCb = hWidget.callback;
        wWidget.callback = function () {
            if (origWCb) origWCb.apply(this, arguments);
            syncCanvasSizeToJson("width", wWidget.value);
            drawCanvas();
        };
        hWidget.callback = function () {
            if (origHCb) origHCb.apply(this, arguments);
            syncCanvasSizeToJson("height", hWidget.value);
            drawCanvas();
        };
    }

    const showHelpModal = () => {
        const modal = document.createElement("div");
        modal.style.cssText = "position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); background: rgba(30, 30, 30, 0.95); backdrop-filter: blur(10px); border: 1px solid #555; border-radius: 8px; padding: 20px; z-index: 9999; box-shadow: 0 10px 30px rgba(0,0,0,0.8); color: #eee; text-align: left; width: 400px; font-family: sans-serif; font-size: 13px; line-height: 1.6;";
        
        modal.innerHTML = `
            <div style="font-size: 16px; font-weight: bold; margin-bottom: 15px; color: #4a9eff; text-align: center;">📖 边界框画布操作指南</div>
            
            <div style="margin-bottom: 10px;"><b style="color:#fff;">🖱️ 基础操作：</b></div>
            <ul style="margin: 0 0 10px 20px; padding: 0; color: #ccc;">
                <li>在空白处按住左键拖动：<b>创建新框</b></li>
                <li>拖动框的内部或数字标签：<b>移动框</b></li>
                <li>拖动框的四个角：<b>拉伸缩放</b></li>
                <li>双击框内部：<b>快速编辑描述</b></li>
                <li>滚轮：<b>缩放画布</b>；中键拖动：<b>平移画布</b></li>
            </ul>

            <div style="margin-bottom: 10px;"><b style="color:#fff;">⌨️ 快捷键：</b></div>
            <ul style="margin: 0 0 10px 20px; padding: 0; color: #ccc;">
                <li><b>Delete / Backspace</b>：删除选中框（或在操控模式下删除背景图）</li>
                <li><b>方向键</b>：微移选中的框 1px；<b>Shift + 方向键</b>：按吸附步长移动</li>
                <li><b>撤销 / 重做 / 重置视图</b>：画布右下角的 ↶ ↷ 🎯 按钮</li>
                <li><b>Ctrl + V</b>：在画布聚焦时粘贴背景图</li>
                <li><b>Ctrl + 点击</b>：多选框</li>
            </ul>

            <div style="margin-bottom: 10px;"><b style="color:#fff;">📐 极小框控制：</b></div>
            <ul style="margin: 0 0 10px 20px; padding: 0; color: #ccc;">
                <li>当框的宽或高小于当前网格尺寸（16 或 32）时，会在画布上显示为同样大小的红色虚线框。</li>
                <li>在右侧菜单勾选“极小框控制”，可自定义 1 ~ (网格尺寸-1) px 的尺寸及对齐方式。</li>
            </ul>

            <div style="margin-bottom: 10px;"><b style="color:#fff;">🔒 锁定功能：</b></div>
            <ul style="margin: 0 0 10px 20px; padding: 0; color: #ccc;">
                <li>在右侧列表点击 🔓 锁定框，锁定后不可拖拽和缩放。</li>
                <li>只能点击数字标签选中，在右侧修改参数。</li>
            </ul>

            <div style="text-align: center; margin-top: 20px;">
                <button id="close-help-btn" style="background: #4a9eff; color: white; border: none; padding: 6px 20px; border-radius: 4px; cursor: pointer; font-weight: bold;">我知道了</button>
            </div>
        `;
        
        canvasContainer.appendChild(modal);
        modal.querySelector("#close-help-btn").onclick = () => modal.remove();
    };

    normalizeJsonWidget(); // 打开面板时就把草稿格式转成模型格式
    renderList();
    recordHistory(jsonWidget.value, false); // 撤销栈的初始状态
    model.resetCoalesce(); // 保证首次编辑不会被合并进初始状态

    // 🌟 暴露刷新接口，供重新打开面板时调用
    node._mossRefreshPanel = () => {
        renderList();
    };

    openPanelIds.add(node.id); // 记下来，节点被重建（如 Ctrl+Z）时可自动恢复

    // 🌟 消费 pending 背景图（放在函数末尾，此时 getCanvasSize / drawCanvas 等全部已初始化）
    if (node._mossPendingBackground) {
        try {
            applyBackgroundImage(node._mossPendingBackground);
        } catch (e) {
            console.error("[MOSS] 消费 pending 背景图失败:", e);
        }
        node._mossPendingBackground = null;
    }
}
