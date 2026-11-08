import { serializeLayout, normalizeLayoutSchema } from "../core/json-schema.js";
import { openPanelIds } from "../core/panel-registry.js";
import { createEditorModel } from "./editor-model.js";
import { createRibbon, openPopover, closePopover } from "./ribbon.js";
import { createToast } from "./toast.js";
import { createPresetPanel } from "./preset-panel.js";
import { getPluginVersion, onPluginVersion } from "../core/version.js";
import { snapAxisWithAnchors, snapEdgeToTargets, matchTarget } from "../core/bg-snap.js";
import { getItemsBounds, alignItems, distributeItems } from "../core/box-layout.js";
import { hsvToHex, hexToHsv } from "../core/color-utils.js";
import { isOverlapping } from "../core/box-geometry.js";
import {
    buildSnapTargets as buildSnapTargetsCore,
    snapMoveRect as snapMoveRectCore,
    snapEdge as snapEdgeCore,
    applyGridSnap,
} from "../core/box-snap.js";
import {
    getVisualBounds as getVisualBoundsCore,
    applyVisualBounds as applyVisualBoundsCore,
} from "../core/extreme-box.js";
import {
    CLIPBOARD_PREFIX,
    cloneItemForClipboard,
    formatClipboardPayload,
    parseClipboardBoxes,
} from "../core/box-clipboard.js";
import { createResolutionControl, watchWidgetSize } from "../ui/resolution-control.js";
import { createCard, createSection, createTextarea, createCheckbox, createLabel, createSelect, createInput, createButton } from "../ui/kit.js";
import { showCharacterDialog } from "../ui/character-dialog.js";
import { createPromptTemplatePanel } from "../ui/prompt-template-panel.js";

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
    // 背景图吸附命中的辅助线（和框的吸附同一套视觉：蓝色虚线）
    let bgSnapGuides = [];
    const addBgGuide = (axis, pos) => {
        if (pos === null || pos === undefined) return;
        if (bgSnapGuides.some((g) => g.axis === axis && Math.abs(g.pos - pos) < 0.01)) return;
        bgSnapGuides.push({ axis, pos });
    };
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
        bgSnapGuides = [];
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

    // ================= 面板出现 / 收起的轻微缩放 =================
    // 用独立的 scale 属性做动画，不动 transform（居中、拖拽都靠它定位）
    let panelCloseAnim = null;
    const cancelPanelCloseAnim = () => {
        if (!panelCloseAnim) return;
        try {
            panelCloseAnim.cancel();
        } catch (_) {
            /* 忽略 */
        }
        panelCloseAnim = null;
    };
    const playPanelPop = () => {
        cancelPanelCloseAnim();
        if (!panel || typeof panel.animate !== "function") return;
        try {
            panel.animate(
                [
                    { scale: "0.972", opacity: 0.45 },
                    { scale: "1", opacity: 1 },
                ],
                { duration: 170, easing: "cubic-bezier(0.2, 0.8, 0.3, 1)" }
            );
        } catch (_) {
            /* 老浏览器忽略 */
        }
    };
    const hidePanelAnimated = () => {
        if (!panel || panel.style.display === "none") return;
        // 关闭动画没跑完又点开时，取消它能恢复到正常透明度
        cancelPanelCloseAnim();
        if (typeof panel.animate !== "function") {
            panel.style.display = "none";
            return;
        }
        try {
            const anim = panel.animate(
                [
                    { scale: "1", opacity: 1 },
                    { scale: "0.972", opacity: 0 },
                ],
                { duration: 130, easing: "ease-in", fill: "forwards" }
            );
            panelCloseAnim = anim;
            anim.onfinish = () => {
                if (panelCloseAnim !== anim) return;
                panelCloseAnim = null;
                panel.style.display = "none";
                // 关掉 fill: forwards，否则下次打开会被这条动画的 opacity 0 压住
                try {
                    anim.cancel();
                } catch (_) {
                    /* 忽略 */
                }
            };
            anim.oncancel = () => {
                if (panelCloseAnim === anim) panelCloseAnim = null;
            };
        } catch (_) {
            panel.style.display = "none";
        }
    };

    const panelId = `moss-bbox-panel-${node.id}`;
    let panel = document.getElementById(panelId);
    if (panel) {
        panel.style.display = "flex";
        panel.style.zIndex = "10000";
        playPanelPop();
        if (node._mossRefreshPanel) node._mossRefreshPanel();
        // 窗口比上次小的话，重新打开时先把尺寸收进可视范围
        node._mossPanelFit?.();
        return;
    }

    // --- 1. 构建主面板 ---
    panel = document.createElement("div");
    panel.id = panelId;
    panel.style.cssText =
        "position: fixed; left: 50%; top: 10%; transform: translateX(-50%); width: 750px; height: 600px; overflow: hidden; background: rgba(30, 30, 30, 0.95); backdrop-filter: blur(10px); border: 1px solid #555; border-radius: 8px; display: flex; flex-direction: column; z-index: 9999; box-shadow: 0 10px 30px rgba(0,0,0,0.8); font-family: sans-serif; color: #eee; font-size: 13px;";

    const header = document.createElement("div");
    header.style.cssText =
        "display: flex; justify-content: space-between; align-items: center; padding: 10px 12px; background: #2a2a2a; border-bottom: 1px solid #444; border-radius: 8px 8px 0 0; font-weight: bold; cursor: move; flex-shrink: 0;";
    
    const titleLeft = document.createElement("div");
    titleLeft.style.cssText = "display: flex; align-items: center; gap: 10px;";
    
    const title = document.createElement("span");
    title.textContent = "边界框管理与预览";
    titleLeft.appendChild(title);

    // 版本号从后端读，拿到之前先不占位，免得闪一下空胶囊
    const versionTag = document.createElement("span");
    versionTag.className = "moss-panel-version";
    versionTag.style.cssText =
        "font-size: 11px; font-weight: normal; color: #8a8a8a; padding: 1px 6px; border: 1px solid #4a4a4a; border-radius: 9px; line-height: 1.4; cursor: default;";
    versionTag.style.display = "none";
    titleLeft.appendChild(versionTag);
    const applyVersion = (version) => {
        if (!version) return;
        versionTag.textContent = `v${version}`;
        versionTag.title = `MOSS_BBox_Enhancer v${version}`;
        versionTag.style.display = "inline-block";
    };
    applyVersion(getPluginVersion());
    // 节点删掉时把订阅摘掉，别让回调拽着已经移除的节点
    node._mossVersionCleanup?.();
    node._mossVersionCleanup = onPluginVersion(applyVersion);

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
        closeColorPopup();
        closePopover();
        openPanelIds.delete(node.id); // 用户主动关闭，不再自动恢复
        hidePanelAnimated();
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

    // 画布矩形与尺寸缓存：拖动时每帧读 getBoundingClientRect 会反复触发同步布局
    let canvasRect = null;
    let canvasCssW = 0;
    let canvasCssH = 0;
    let canvasDpr = 0;

    const getCanvasRect = () => {
        if (!canvasRect) canvasRect = canvasContainer.getBoundingClientRect();
        return canvasRect;
    };
    const invalidateCanvasRect = () => {
        canvasRect = null;
    };

    // ================= 左下角：当前选中框的坐标 =================
    const coordHud = document.createElement("div");
    coordHud.style.cssText =
        "position: absolute; left: 10px; bottom: 10px; z-index: 18; display: none; " +
        "padding: 4px 8px; border-radius: 5px; background: rgba(18, 18, 18, 0.78); " +
        "border: 1px solid #3a3a3a; color: #b8b8b8; pointer-events: none; white-space: pre; " +
        "font: 11px/1.55 ui-monospace, Consolas, monospace;";
    canvasContainer.appendChild(coordHud);

    // 画布顶部的文字提示：按住修饰键时常驻，快捷键操作后短暂弹出
    const toast = createToast(canvasContainer);

    // 属性面板停靠时会盖住画布下沿，读数需要抬高；
    // offsetHeight 是强制布局的读操作，只在面板开合时算一次，不要放到每帧里
    let hudOffset = 10;
    let hudLastText = "";
    let hudLastBottom = "";
    let hudVisible = false;

    const refreshHudOffset = () => {
        let next = 10;
        try {
            const docked = editorContainer.style.display !== "none" && !isPanelDetached;
            if (docked) next = editorContainer.offsetHeight + 10;
        } catch (e) {
            // 初始化时这些变量还没声明，保持默认位置
        }
        hudOffset = next;
    };

    const updateCoordHud = () => {
        const index = model.active >= 0
            ? model.active
            : model.selection.size ? Math.min(...model.selection) : -1;
        const item = index >= 0 ? model.items[index] : null;
        const bbox = item && Array.isArray(item.bbox) ? item.bbox : null;
        if (!bbox || bbox.length !== 4) {
            if (hudVisible) {
                coordHud.style.display = "none";
                hudVisible = false;
            }
            return;
        }

        const [ymin, xmin, ymax, xmax] = bbox;
        const { w, h } = getCanvasSize();
        const x1 = Math.round(xmin + w / 2);
        const y1 = Math.round(ymin + h / 2);
        const x2 = Math.round(xmax + w / 2);
        const y2 = Math.round(ymax + h / 2);

        const text =
            `左上  x ${x1}, y ${y1}, x ${x2}, y ${y2}\n` +
            `中心  y ${ymin}, x ${xmin}, y ${ymax}, x ${xmax}`;
        if (text !== hudLastText) {
            coordHud.textContent = text;
            hudLastText = text;
        }

        const bottom = `${hudOffset}px`;
        if (bottom !== hudLastBottom) {
            coordHud.style.bottom = bottom;
            hudLastBottom = bottom;
        }
        if (!hudVisible) {
            coordHud.style.display = "block";
            hudVisible = true;
        }
    };

    // ================= 顶部工具条：撤销 / 重做 / 重置视图 =================
    const undoBtn = ribbon.button("undo", "撤销", () => {
        if (!model.canUndo()) return;
        undoEdit();
        toast.show("已撤销", 1000);
    });
    const redoBtn = ribbon.button("redo", "重做", () => {
        if (!model.canRedo()) return;
        redoEdit();
        toast.show("已重做", 1000);
    });
    const resetViewBtn = ribbon.button("reset", "重置视图", () => {
        model.view.scale = 1.0;
        model.view.x = 0;
        model.view.y = 0;
        drawCanvas();
    });

    // ================= 右侧栏：主提示词 =================
    const promptCard = createCard({
        title: "📝 主提示词 (摘要)",
        collapsible: true,
        open: true,
        flush: true,
    });
    promptCard.el.style.cssText = "flex: 0 0 auto; margin: 10px 10px 0;";

    const promptTextarea = createTextarea({
        placeholder: "在此输入画面主描述...",
        height: 80,
    });

    // 阻止事件冒泡，防止输入时触发画布快捷键或拖拽
    promptTextarea.addEventListener("mousedown", (e) => e.stopPropagation());
    promptTextarea.addEventListener("wheel", (e) => e.stopPropagation());
    promptTextarea.addEventListener("keydown", (e) => e.stopPropagation());

    promptCard.body.appendChild(promptTextarea);

    // ================= 主提示词模板 =================
    // 把当前 summary.caption 整段存成模板，点开弹层选一个套用（覆盖 / Shift 追加）。
    // 标题撑满，让 📚 和折叠三角贴在一起（默认 space-between 会把三个元素均分）
    promptCard.titleEl.style.cssText =
        "flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;";
    const tplBtn = createButton("📚", { icon: true, title: "提示词模板" });
    promptCard.head.insertBefore(tplBtn, promptCard.head.lastElementChild);

    const tplPanel = createPromptTemplatePanel({
        getText: () => promptTextarea.value,
        onToast: (msg) => toast.show(msg, 1600),
        onApply: (text, { append } = {}) => {
            const current = promptTextarea.value.trim();
            setPromptText(append && current ? `${current}\n\n${text}` : text);
            closePopover();
            toast.show(append ? "已追加模板" : "已套用模板", 1400);
        },
    });

    tplBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        await tplPanel.load();
        openPopover(tplBtn, tplPanel.el, { width: 300 });
    });
    
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

    // 提示词预设：框色右边、输入栏上方，点开后是一层分组弹层
    const presetBtn = document.createElement("button");
    presetBtn.type = "button";
    presetBtn.textContent = "提示词预设";
    presetBtn.title = "给当前框套用提示词预设（标签可多选；Alt+点击切换类型前缀；按住 Shift 写入即覆盖描述）";
    presetBtn.style.cssText =
        "margin-left: auto; flex: 0 0 auto; padding: 2px 8px; border-radius: 4px; border: 1px solid #4a7ab5; " +
        "background: #24405e; color: #dbe9ff; font-size: 11px; cursor: pointer; white-space: nowrap;";
    frameColorRow.appendChild(presetBtn);
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
        const map = {};
        model.items.forEach((it, i) => {
            if (it && typeof it._color === "string" && it._color) map[i] = it._color;
        });

        const widget = node.widgets?.find((w) => w.name === "bbox_colors");
        if (widget) {
            const next = Object.keys(map).length ? JSON.stringify(map) : "";
            if (widget.value !== next) widget.value = next;
        }
        // 节点 properties 跟着工作流一起存，控件被清空时还能从这儿恢复
        if (node.properties) node.properties.mossBboxColors = map;
    };

    // 打开面板 / 刷新页面时把颜色读回来：先看隐藏控件，再退回节点 properties
    const readStoredColors = () => {
        const map = {};
        const widget = node.widgets?.find((w) => w.name === "bbox_colors");
        if (widget && typeof widget.value === "string" && widget.value.trim()) {
            try {
                const parsed = JSON.parse(widget.value);
                if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                    Object.entries(parsed).forEach(([key, value]) => {
                        if (typeof value === "string" && value) map[key] = value;
                    });
                }
            } catch (e) {
                console.warn("[MOSS] 框色缓存解析失败:", e);
            }
        }
        const cached = node.properties?.mossBboxColors;
        if (cached && typeof cached === "object") {
            Object.entries(cached).forEach(([key, value]) => {
                if (!map[key] && typeof value === "string" && value) map[key] = value;
            });
        }
        return map;
    };

    const restoreItemColors = () => {
        const map = readStoredColors();
        if (!Object.keys(map).length) return;
        model.items.forEach((item, index) => {
            if (!item || item._color) return;
            const color = map[index];
            if (typeof color === "string" && color) item._color = color;
        });
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

    // 角色下拉：纯文本功能，选中后只改描述前缀，不写 JSON 字段
    const charLabel = document.createElement("div");
    charLabel.textContent = "角色";
    charLabel.style.cssText = "font-size: 11px; color: #888; margin-bottom: 4px;";
    const charSelect = createSelect([]);
    charSelect.style.cssText = "width: 100%; margin-bottom: 8px;";
    editorContainer.appendChild(charLabel);
    editorContainer.appendChild(charSelect);

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
        refreshHudOffset();
        updateCoordHud();
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
    const canvasModeSection = createSection({ title: "🧩 画布模式", inline: true });
    const canvasModePanel = canvasModeSection.el;

    const canvasModeSelect = createSelect([
        { value: "", label: "默认 (不设置)" },
        { value: "single", label: "单图" },
        { value: "multi_panel", label: "多面板/分镜" },
        { value: "collage", label: "拼贴" },
    ]);
    canvasModeSelect.style.flex = "1 1 auto";
    canvasModeSelect.style.padding = "4px 6px";
    canvasModeSelect.style.fontSize = "12px";
    canvasModeSection.body.appendChild(canvasModeSelect);

    // （原「对齐 / 分布」面板已移除：构图以手操为主，不再占用右栏空间）

    // ================= 极小框控制 =================
    const smallBoxSection = createSection({ title: "📐 极小框控制" });
    const smallBoxPanel = smallBoxSection.el;

    const smallBoxRow = document.createElement("div");
    smallBoxRow.style.cssText = "display: flex; align-items: center; gap: 6px; flex-wrap: wrap;";

    const enableSmallCb = createCheckbox();

    const sizeLabel = createLabel("尺寸:");

    const sizeInput = createInput({ type: "number", value: 8, min: 1, max: 15, width: 40 });
    sizeInput.style.textAlign = "center";

    // 🌟 对齐方式下拉框
    const alignSelect = createSelect([
        { value: "center", label: "中心" },
        { value: "tl", label: "左上" },
        { value: "tr", label: "右上" },
        { value: "bl", label: "左下" },
        { value: "br", label: "右下" },
    ]);
    alignSelect.style.flex = "1 1 auto";

    smallBoxRow.appendChild(enableSmallCb);
    smallBoxRow.appendChild(sizeLabel);
    smallBoxRow.appendChild(sizeInput);
    smallBoxSection.body.appendChild(smallBoxRow);

    // 🌟 第二行，专门放对齐方式
    const alignRow = document.createElement("div");
    alignRow.style.cssText = "display: flex; align-items: center; gap: 6px;";

    const alignLabel = createLabel("实际坐标位于:");

    alignRow.appendChild(alignLabel);
    alignRow.appendChild(alignSelect);

    smallBoxSection.body.appendChild(alignRow);
    
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

    // 🌟 背景图设置
    const bgSection = createSection({ title: "🖼️ 背景图设置" });
    const bgPanel = bgSection.el;
    const bgBody = bgSection.body;

    // 标题行右侧的「操控」开关
    const bgTitle = bgSection.titleEl;
    bgTitle.style.cssText = "flex: 1 1 auto; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;";

    const bgActiveLabel = document.createElement("label");
    bgActiveLabel.style.cssText =
        "display: flex; align-items: center; gap: 3px; color: #ccc; font-size: var(--moss-font); font-weight: normal; cursor: pointer; flex-shrink: 0;";
    bgActiveLabel.title = "开启后可在画布上移动 / 拉伸背景图";
    const bgActiveCb = createCheckbox();
    bgActiveCb.disabled = true;
    bgActiveCb.onchange = () => { bgActive = bgActiveCb.checked; };
    bgActiveLabel.appendChild(bgActiveCb);
    bgActiveLabel.appendChild(document.createTextNode("操控"));

    bgSection.head.appendChild(bgActiveLabel);

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

    // 多选时对齐到选区包围盒，单选或按住 Alt 时对齐到画布
    const alignSelection = (mode, useCanvas) => {
        const indices = getSelectedIndices();
        const items = indices.map((i) => model.items[i]).filter((it) => it && Array.isArray(it.bbox));
        if (!items.length) return;
        if (model.active === -1) model.setActive(indices[0]);

        const base = items.length > 1 && !useCanvas ? getItemsBounds(items) : canvasBounds();
        alignItems(items, mode, base);
        saveEditorChanges();
    };

    // 首尾不动，中间按等间距重排（间距指框与框之间的空隙）
    const distributeSelection = (axis) => {
        const indices = getSelectedIndices();
        const items = indices.map((i) => model.items[i]).filter((it) => it && Array.isArray(it.bbox));
        if (items.length < 3) return;
        if (model.active === -1) model.setActive(indices[0]);
        distributeItems(items, axis);
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

    // ================= 右栏：分辨率选择器（统一卡片组件，默认收起） =================
    // 节点上直接改宽高时，面板里的选择器也要跟着刷新
    watchWidgetSize(node);
    const resolutionCard = createCard({ title: "🖼 分辨率", collapsible: true, open: false });
    resolutionCard.el.style.cssText = "flex: 0 0 auto; margin: 10px 10px 0;";
    resolutionCard.body.style.maxHeight = "260px";
    resolutionCard.body.style.overflowY = "auto";

    const resolutionControl = createResolutionControl({
        node,
        getSize: () => ({
            width: node.widgets?.find((w) => w.name === "canvas_width")?.value || 1024,
            height: node.widgets?.find((w) => w.name === "canvas_height")?.value || 1024,
        }),
        applySize: ({ width, height }) => {
            const wW = node.widgets?.find((w) => w.name === "canvas_width");
            const hW = node.widgets?.find((w) => w.name === "canvas_height");
            if (wW) {
                wW.value = width;
                wW.callback?.(width);
            }
            if (hW) {
                hW.value = height;
                hW.callback?.(height);
            }
            // drawCanvas 定义在后面，初始化那次 apply 用下一帧兜住
            setTimeout(() => drawCanvas(), 0);
        },
        flat: true,
    });
    resolutionCard.body.appendChild(resolutionControl.el);
    resolutionCard.onToggle((open) => {
        if (open) resolutionControl.refresh();
    });

    // ================= 右侧栏：角色（纯提示词层面的临时预设） =================
    // 角色只存在于 node.properties，不进 layout_json；增删只改 summary.caption 文本。
    const charCard = createCard({
        title: "🎭 角色",
        collapsible: true,
        open: true,
        bodyClass: "moss-card__body--stack",
    });
    charCard.el.style.cssText = "flex: 0 0 auto; margin: 10px 10px 0;";

    const charListEl = document.createElement("div");
    charListEl.style.cssText = "display: flex; flex-direction: column; gap: 4px;";

    const charEmptyEl = document.createElement("div");
    charEmptyEl.textContent = "还没有角色";
    charEmptyEl.style.cssText = "font-size: 11px; color: #666;";

    const charAddBtn = createButton("＋ 增加角色", { small: true });
    charAddBtn.style.width = "100%";

    charCard.body.appendChild(charListEl);
    charCard.body.appendChild(charEmptyEl);
    charCard.body.appendChild(charAddBtn);

    rightContainer.appendChild(resolutionCard.el);
    rightContainer.appendChild(promptCard.el);
    rightContainer.appendChild(charCard.el);
    rightContainer.appendChild(listArea);

    contentContainer.appendChild(rightContainer);
    panel.appendChild(contentContainer);
    document.body.appendChild(panel);
    playPanelPop();

    // 🌟 主提示词输入框的高度上限：最多占右边栏的 3/4，
    // 再高就会把下面的框列表挤没、甚至顶出面板底部
    let promptMaxH = 0;
    const fitPromptHeight = () => {
        const h = rightContainer.clientHeight;
        if (!h) return;
        const cap = Math.max(80, Math.round(h * 0.75));
        if (cap === promptMaxH) return;
        promptMaxH = cap;
        promptTextarea.style.maxHeight = `${cap}px`;
    };
    fitPromptHeight();
    try {
        // 面板缩放 / 窗口变化时右栏高度会变，上限跟着重算
        new ResizeObserver(fitPromptHeight).observe(rightContainer);
    } catch (_) {
        /* 老浏览器忽略 */
    }

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
        // 下限放宽到 240×200：吸附成半屏后可能比默认最小尺寸还小，得原样恢复
        const w = Math.min(Math.max(saved.width || 750, 240), Math.max(240, window.innerWidth - 16));
        const h = Math.min(Math.max(saved.height || 600, 200), Math.max(200, window.innerHeight - 16));
        const left = Math.min(Math.max(saved.left, 0), Math.max(0, window.innerWidth - w));
        const top = Math.min(Math.max(saved.top, 0), Math.max(0, window.innerHeight - 40));
        panel.style.transform = "none";
        panel.style.left = `${left}px`;
        panel.style.top = `${top}px`;
        panel.style.width = `${w}px`;
        panel.style.height = `${h}px`;
    };
    restorePanelRect();

    // 🌟 宽度边界：面板不能横向越出视口，否则右侧手柄跑到屏幕外就抓不回来了。
    // 高度不再设 max-height：有了八向缩放和贴边吸附，拖标题栏往下时自动压矮反而碍事，
    // 面板允许临时沉到视口下方，抓住标题栏拖回来即可。
    const PANEL_MARGIN = 8;
    // 拖手柄时的最小尺寸；吸附成半屏时不受这个限制，可能比它还窄
    const MIN_PANEL_W = 450;
    const MIN_PANEL_H = 400;
    let appliedMaxW = 0;
    const applyPanelMaxSize = () => {
        if (panel.style.display === "none") return;
        // 清掉旧版本可能留下的高度上限
        if (panel.style.maxHeight) panel.style.maxHeight = "";
        const rect = panel.getBoundingClientRect();
        // 居中态由 CSS 定位，左右各留边距；拖动过则从当前左边缘算可用宽度
        const centered = panel.style.transform !== "none";
        // 吸附有过渡时 rect 是动画中间值，用 inline 的目标值算上限，免得目标宽度被中途压掉
        const inlineLeft = parseFloat(panel.style.left);
        const baseLeft = centered ? rect.left : (Number.isFinite(inlineLeft) ? inlineLeft : rect.left);
        const availW = centered
            ? window.innerWidth - PANEL_MARGIN * 2
            : window.innerWidth - baseLeft - PANEL_MARGIN;
        const maxW = Math.max(200, Math.floor(availW));
        if (maxW !== appliedMaxW) {
            appliedMaxW = maxW;
            panel.style.maxWidth = `${maxW}px`;
        }
    };
    node._mossPanelFit = applyPanelMaxSize;
    applyPanelMaxSize();

    // ================= 八向缩放 =================
    // CSS 的 resize 只给右下角一个手柄，这里自己做 8 个透明手柄：
    // 上下左右四边 + 四角，拖哪边改哪边，对边保持不动。
    const HANDLE_THICK = 6;
    const HANDLE_CORNER = 12;
    let panelResize = null;

    const startPanelResize = (e, dir, host) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        const rect = panel.getBoundingClientRect();
        // 居中布局靠 transform 实现，先固化成 left/top 再改尺寸
        panel.style.transform = "none";
        panel.style.left = `${rect.left}px`;
        panel.style.top = `${rect.top}px`;
        panel.style.width = `${rect.width}px`;
        panel.style.height = `${rect.height}px`;
        panelResize = {
            dir,
            host,
            pointerId: e.pointerId,
            startX: e.clientX,
            startY: e.clientY,
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
        };
        host?.setPointerCapture?.(e.pointerId);
        // 手动拖过尺寸就不再是「吸附态」，下次拖标题栏不该把这次调整覆盖掉
        snapRestore = null;
        hideSnapPreview();
        clearSnapTransition();
    };

    const onPanelResizeMove = (e) => {
        if (!panelResize || e.pointerId !== panelResize.pointerId) return;
        const { dir, startX, startY, left: l0, top: t0, width: w0, height: h0 } = panelResize;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;

        let left = l0;
        let top = t0;
        let width = w0;
        let height = h0;

        if (dir.includes("e")) width = w0 + dx;
        if (dir.includes("s")) height = h0 + dy;
        if (dir.includes("w")) {
            width = w0 - dx;
            left = l0 + dx;
        }
        if (dir.includes("n")) {
            height = h0 - dy;
            top = t0 + dy;
        }

        // 最小尺寸：拖左 / 上边时钉住对边，让这一侧停住
        if (width < MIN_PANEL_W) {
            if (dir.includes("w")) left = l0 + w0 - MIN_PANEL_W;
            width = MIN_PANEL_W;
        }
        if (height < MIN_PANEL_H) {
            if (dir.includes("n")) top = t0 + h0 - MIN_PANEL_H;
            height = MIN_PANEL_H;
        }

        // 左 / 上不能越出视口，越界时钉住右 / 下边缘
        if (left < 0) {
            if (dir.includes("w")) width = l0 + w0;
            left = 0;
        }
        if (top < 0) {
            if (dir.includes("n")) height = t0 + h0;
            top = 0;
        }

        // 右边界仍要守（右侧手柄不能跑出视口）；下边界不再主动压高度：
        // 只有往下拖、还想继续变高时才封顶，已经伸出视口的尺寸不会被反向压矮
        const maxRight = window.innerWidth - PANEL_MARGIN;
        const maxBottom = window.innerHeight - PANEL_MARGIN;
        if (left + width > maxRight) width = Math.max(MIN_PANEL_W, maxRight - left);
        if (dir.includes("s") && height > h0 && top + height > maxBottom) {
            height = Math.max(h0, Math.max(MIN_PANEL_H, maxBottom - top));
        }

        panel.style.left = `${Math.round(left)}px`;
        panel.style.top = `${Math.round(top)}px`;
        panel.style.width = `${Math.round(width)}px`;
        panel.style.height = `${Math.round(height)}px`;
        applyPanelMaxSize();
    };

    const endPanelResize = (e) => {
        if (!panelResize) return;
        panelResize.host?.releasePointerCapture?.(panelResize.pointerId);
        panelResize = null;
        savePanelRect();
    };

    [
        ["n", `top: 0; left: ${HANDLE_CORNER}px; right: ${HANDLE_CORNER}px; height: ${HANDLE_THICK}px; cursor: ns-resize;`],
        ["s", `bottom: 0; left: ${HANDLE_CORNER}px; right: ${HANDLE_CORNER}px; height: ${HANDLE_THICK}px; cursor: ns-resize;`],
        ["w", `left: 0; top: ${HANDLE_CORNER}px; bottom: ${HANDLE_CORNER}px; width: ${HANDLE_THICK}px; cursor: ew-resize;`],
        ["e", `right: 0; top: ${HANDLE_CORNER}px; bottom: ${HANDLE_CORNER}px; width: ${HANDLE_THICK}px; cursor: ew-resize;`],
        ["nw", `left: 0; top: 0; width: ${HANDLE_CORNER}px; height: ${HANDLE_CORNER}px; cursor: nwse-resize;`],
        ["ne", `right: 0; top: 0; width: ${HANDLE_CORNER}px; height: ${HANDLE_CORNER}px; cursor: nesw-resize;`],
        ["sw", `left: 0; bottom: 0; width: ${HANDLE_CORNER}px; height: ${HANDLE_CORNER}px; cursor: nesw-resize;`],
        ["se", `right: 0; bottom: 0; width: ${HANDLE_CORNER}px; height: ${HANDLE_CORNER}px; cursor: nwse-resize;`],
    ].forEach(([dir, css]) => {
        const handle = document.createElement("div");
        handle.dataset.mossResize = dir;
        handle.style.cssText = `position: absolute; z-index: 30; touch-action: none; ${css}`;
        handle.addEventListener("pointerdown", (e) => startPanelResize(e, dir, handle));
        handle.addEventListener("pointermove", onPanelResizeMove);
        handle.addEventListener("pointerup", endPanelResize);
        handle.addEventListener("pointercancel", endPanelResize);
        panel.appendChild(handle);
    });

    // ================= 贴边吸附（类似 Win 的 Aero Snap）=================
    const SNAP_EDGE = 10;      // 指针进入距边界多少像素算贴边
    const SNAP_MIN_MOVE = 8;   // 从吸附态拖出时，移动超过这个距离才恢复原尺寸
    const SNAP_PREVIEW_DELAY = 280; // 停在边缘多久才亮预览框，避免扫过边界闪一下
    const SNAP_LAYOUT_MS = 190;     // 松手吸附时展开成目标尺寸的过渡时长
    let pendingSnap = null;
    let snapRestore = null;    // 吸附前的矩形，拖出时恢复
    let snapArmed = true;      // 离开过边界才允许再次吸附，避免刚拖出就被吸回去
    // 预览状态：换区要重新计时，亮出来之后松手才真正吸附
    let snapPreviewZone = null;
    let snapPreviewShown = false;
    let snapPreviewTimer = null;
    let snapLayoutTimer = null;

    // ComfyUI 的工作区：优先取 graph canvas，拿不到就退回整个视口
    const getComfyBounds = () => {
        const probes = ["#graph-canvas", ".graph-canvas-container", ".comfyui-body"];
        for (const sel of probes) {
            let el = null;
            try {
                el = document.querySelector(sel);
            } catch (_) {
                el = null;
            }
            if (!el || typeof el.getBoundingClientRect !== "function") continue;
            const r = el.getBoundingClientRect();
            if (r.width >= 200 && r.height >= 200) {
                return { left: r.left, top: r.top, width: r.width, height: r.height };
            }
        }
        return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
    };

    // 距离边界三倍阈值就算彻底离开了贴边区，可以解除「刚拖出别立刻吸回去」的抑制
    const farFromSnapZone = (x, y) => {
        const b = getComfyBounds();
        return y > b.top + SNAP_EDGE * 3
            && x > b.left + SNAP_EDGE * 3
            && x < b.left + b.width - SNAP_EDGE * 3;
    };

    const computeSnap = (x, y) => {
        const b = getComfyBounds();
        // 吸附目标也要守住视口边界，否则右侧 / 底部会多出几像素被 max-* 压掉
        const fit = (left, top, width, height) => ({
            left,
            top,
            width: Math.min(width, window.innerWidth - left - PANEL_MARGIN),
            height: Math.min(height, window.innerHeight - top - PANEL_MARGIN),
        });
        const nearTop = y <= b.top + SNAP_EDGE;
        const nearLeft = x <= b.left + SNAP_EDGE;
        const nearRight = x >= b.left + b.width - SNAP_EDGE;
        // 顶部三段优先：角落同时命中时按顶部的分栏处理
        if (nearTop) {
            const third = b.width / 3;
            const rel = (x - b.left) / b.width;
            if (rel < 1 / 3) return { ...fit(b.left, b.top, third * 2, b.height), zone: "top-left" };
            if (rel < 2 / 3) return { ...fit(b.left + third / 2, b.top, third * 2, b.height), zone: "top-mid" };
            return { ...fit(b.left + third, b.top, third * 2, b.height), zone: "top-right" };
        }
        if (nearLeft) return { ...fit(b.left, b.top, b.width / 2, b.height), zone: "left" };
        if (nearRight) return { ...fit(b.left + b.width / 2, b.top, b.width / 2, b.height), zone: "right" };
        return null;
    };

    const snapPreview = document.createElement("div");
    snapPreview.className = "moss-snap-preview";
    snapPreview.style.cssText =
        "position: fixed; pointer-events: none; z-index: 9998; display: none; box-sizing: border-box; background: rgba(74, 158, 255, 0.14); border: 1px solid rgba(74, 158, 255, 0.75); border-radius: 8px; transition: left 90ms ease, top 90ms ease, width 90ms ease, height 90ms ease;";
    document.body.appendChild(snapPreview);

    const showSnapPreview = (snap) => {
        const wasHidden = snapPreview.style.display !== "block";
        snapPreview.style.display = "block";
        snapPreview.style.left = `${snap.left}px`;
        snapPreview.style.top = `${snap.top}px`;
        snapPreview.style.width = `${snap.width}px`;
        snapPreview.style.height = `${snap.height}px`;
        // 从无到有时轻微放大一下，配合延迟出现，像“落定”而不是突然闪出
        if (wasHidden && typeof snapPreview.animate === "function") {
            try {
                snapPreview.animate(
                    [
                        { opacity: 0, scale: "0.99" },
                        { opacity: 1, scale: "1" },
                    ],
                    { duration: 160, easing: "cubic-bezier(0.2, 0.8, 0.3, 1)" }
                );
            } catch (_) {
                /* 老浏览器忽略 */
            }
        }
    };
    const clearSnapPreviewTimer = () => {
        if (!snapPreviewTimer) return;
        clearTimeout(snapPreviewTimer);
        snapPreviewTimer = null;
    };
    // 彻底收起：清计时、清区域，下次进边缘重新等
    const hideSnapPreview = () => {
        clearSnapPreviewTimer();
        snapPreviewZone = null;
        snapPreviewShown = false;
        snapPreview.style.display = "none";
    };
    // 指针还在吸附区里时调用：同区跟随更新，换区重新计时
    const refreshSnapPreview = (snap) => {
        if (!snap) {
            hideSnapPreview();
            return;
        }
        if (snap.zone === snapPreviewZone) {
            if (snapPreviewShown) showSnapPreview(snap);
            return;
        }
        clearSnapPreviewTimer();
        snapPreviewZone = snap.zone;
        snapPreviewShown = false;
        snapPreview.style.display = "none";
        snapPreviewTimer = setTimeout(() => {
            snapPreviewTimer = null;
            if (!isDraggingPanel || !pendingSnap || pendingSnap.zone !== snapPreviewZone) return;
            snapPreviewShown = true;
            showSnapPreview(pendingSnap);
        }, SNAP_PREVIEW_DELAY);
    };

    // 吸附时给位置/尺寸加一次过渡，松手不再硬跳；拖动、缩放前必须清掉，否则跟手会滞后
    const clearSnapTransition = () => {
        if (snapLayoutTimer) {
            clearTimeout(snapLayoutTimer);
            snapLayoutTimer = null;
        }
        if (panel.style.transition) panel.style.transition = "";
    };
    const startSnapTransition = () => {
        const ease = "cubic-bezier(0.2, 0.8, 0.3, 1)";
        panel.style.transition = [
            `left ${SNAP_LAYOUT_MS}ms ${ease}`,
            `top ${SNAP_LAYOUT_MS}ms ${ease}`,
            `width ${SNAP_LAYOUT_MS}ms ${ease}`,
            `height ${SNAP_LAYOUT_MS}ms ${ease}`,
        ].join(", ");
        // 先把起点样式落一帧，否则新值会和起点算在同一帧里，过渡不生效
        void panel.offsetWidth;
        if (snapLayoutTimer) clearTimeout(snapLayoutTimer);
        snapLayoutTimer = setTimeout(() => {
            snapLayoutTimer = null;
            panel.style.transition = "";
            // 过渡中 rect 还是旧值，等落定再存，避免下次打开跳回吸附前的位置
            savePanelRect();
        }, SNAP_LAYOUT_MS + 60);
    };

    const applySnapLayout = (snap) => {
        const r = panel.getBoundingClientRect();
        // 已经是吸附态时保留最早那份尺寸，别把吸附后的宽高当成「原尺寸」记下来
        snapRestore = snapRestore || { left: r.left, top: r.top, width: r.width, height: r.height };
        // 居中态靠 transform 定位，先固化成像素再撤 transform，不然过渡会从 50% 处先跳一下
        panel.style.left = `${Math.round(r.left)}px`;
        panel.style.top = `${Math.round(r.top)}px`;
        panel.style.width = `${Math.round(r.width)}px`;
        panel.style.height = `${Math.round(r.height)}px`;
        panel.style.transform = "none";
        startSnapTransition();
        panel.style.left = `${Math.round(snap.left)}px`;
        panel.style.top = `${Math.round(snap.top)}px`;
        panel.style.width = `${Math.round(snap.width)}px`;
        panel.style.height = `${Math.round(snap.height)}px`;
        applyPanelMaxSize();
        // 位置/尺寸的持久化交给过渡结束的定时器（此刻 rect 还没走到目标值）
    };

    // 从吸附态拖出：恢复吸附前的宽高，并让指针停在标题栏的相对位置
    const restoreFromSnap = (e) => {
        if (!snapRestore) return false;
        // 恢复要跟手，不能还带着吸附那一下的过渡
        clearSnapTransition();
        const target = snapRestore;
        snapRestore = null;
        const rect = panel.getBoundingClientRect();
        const ratio = rect.width > 0 ? Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)) : 0.5;
        const offsetY = Math.min(rect.height, Math.max(0, e.clientY - rect.top));
        panel.style.width = `${target.width}px`;
        panel.style.height = `${target.height}px`;
        panel.style.left = `${e.clientX - target.width * ratio}px`;
        panel.style.top = `${Math.max(0, e.clientY - offsetY)}px`;
        return true;
    };

    let saveRectTimer = null;
    const queueSavePanelRect = () => {
        if (saveRectTimer) clearTimeout(saveRectTimer);
        saveRectTimer = setTimeout(savePanelRect, 300);
    };
    try {
        // CSS resize 拖拽不会触发事件，用尺寸变化监听兜住
        new ResizeObserver(() => {
            // 缩放到边界时兜底收回一次：写样式会再触发观察，丢到下一帧避免 loop 告警
            const raf = typeof requestAnimationFrame === "function"
                ? requestAnimationFrame
                : (fn) => setTimeout(fn, 16);
            raf(applyPanelMaxSize);
            queueSavePanelRect();
        }).observe(panel);
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

        pendingSnap = null;
        snapArmed = true;
        hideSnapPreview();
        // 上次吸附的过渡还没跑完就重新抓起时，先落地，别让拖动跟手带延迟
        clearSnapTransition();

        // 核心修复：锁定指针，确保鼠标移出面板依然能收到松开事件
        header.setPointerCapture(e.pointerId);
        e.preventDefault();
    });

    header.addEventListener("pointermove", (e) => {
        if (!isDraggingPanel) return;

        // 从吸附态拖出后，得先离开边界区域才重新允许吸附；
        // 这样「拖出来再甩到另一侧」不用松手重拖一次
        if (!snapArmed && farFromSnapZone(e.clientX, e.clientY)) snapArmed = true;

        // 从吸附态拖出：先恢复吸附前的宽高，再把拖动起点对齐到当前指针，避免跳一下
        if (snapRestore) {
            const moved = Math.abs(e.clientX - panelStartX) + Math.abs(e.clientY - panelStartY);
            if (moved > SNAP_MIN_MOVE) {
                restoreFromSnap(e);
                // 已经拖到中间就直接允许吸附；还在边界附近则等离开后再解除
                snapArmed = farFromSnapZone(e.clientX, e.clientY);
                const r2 = panel.getBoundingClientRect();
                const p2 = clampPanelPosition(r2.left, r2.top);
                panel.style.left = `${p2.left}px`;
                panel.style.top = `${p2.top}px`;
                panelStartX = e.clientX;
                panelStartY = e.clientY;
                panelStartLeft = p2.left;
                panelStartTop = p2.top;
                applyPanelMaxSize();
            }
        }

        const pos = clampPanelPosition(
            panelStartLeft + e.clientX - panelStartX,
            panelStartTop + e.clientY - panelStartY
        );
        panel.style.left = pos.left + "px";
        panel.style.top = pos.top + "px";

        // 贴边预览：先停一小会儿再亮框，松手才真正吸附，避免扫过边缘就闪一片
        pendingSnap = snapArmed ? computeSnap(e.clientX, e.clientY) : null;
        refreshSnapPreview(pendingSnap);
    });

    header.addEventListener("pointerup", (e) => {
        isDraggingPanel = false;
        header.releasePointerCapture(e.pointerId);
        // 只有预览真的亮过才算决定吸附：没看到蓝框就松手，不做跳变
        const snap = snapPreviewShown ? pendingSnap : null;
        pendingSnap = null;
        hideSnapPreview();
        if (snap) {
            applySnapLayout(snap);
            return;
        }
        // 拖到靠近视口底部时，可用高度变小，把面板收回来再保存
        applyPanelMaxSize();
        savePanelRect();
    });

    // 窗口尺寸变化后，把已经拖出去的面板拉回可见区域
    window.addEventListener("resize", () => {
        if (panel.style.display === "none") return;
        if (panel.style.transform !== "none") {
            // 还没被拖动过，位置由 CSS 居中决定，但尺寸上限仍要跟着窗口走
            applyPanelMaxSize();
            return;
        }
        const rect = panel.getBoundingClientRect();
        const pos = clampPanelPosition(rect.left, rect.top);
        panel.style.left = pos.left + "px";
        panel.style.top = pos.top + "px";
        applyPanelMaxSize();
    });

    // --- 核心状态与变量 ---
    const model = createEditorModel();
    let isUpdatingFromUI = false;
    updateAlignState();

    let dragMode = null;
    let dragCtrlKey = false;
    // 新建框的拉伸：起点是一个零尺寸的点，四个方向都可能拉，角要跟着鼠标方向变
    let dragCreating = false;
    // Alt 拖动：按下时只登记，真正产生位移后才复制，避免 Alt+单击凭空多出一个重叠框
    let pendingCopyDrag = null;
    let dragCopyMode = false;
    let dragCopyCount = 0;
    // 拖动起始时的 Alt 状态；Alt 已用于复制时不再兼任「临时关闭吸附」
    let dragStartAlt = false;
    // 框选：画布像素坐标的矩形，null 表示没有在框选
    let marqueeRect = null;
    let marqueeAdditive = false;
    let dragStartMouse = { x: 0, y: 0 };
    let dragStartBBox = [0, 0, 0, 0];
    // 多选拖动：起始坐标快照，整组按同一位移移动
    let dragStartGroup = [];
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
        const rect = getCanvasRect();
        const padding = 40;
        const displayW = Math.max(1, rect.width - padding);
        const displayH = Math.max(1, rect.height - padding);
        return Math.min(displayW / w, displayH / h);
    };

    const getActualScale = () => getBaseScale() * model.view.scale;

    const physToLogic = (px, py) => {
        const scale = getActualScale();
        const rect = getCanvasRect();
        const centerX = rect.width / 2;
        const centerY = rect.height / 2;
        return {
            x: (px - centerX - model.view.x) / scale,
            y: (py - centerY - model.view.y) / scale,
        };
    };

    const logicToPhys = (lx, ly) => {
        const scale = getActualScale();
        const rect = getCanvasRect();
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

    const buildSnapTargets = (excludeIndices) => {
        const { w, h } = getCanvasSize();
        snapTargets = buildSnapTargetsCore({
            items: model.items,
            canvasW: w,
            canvasH: h,
            exclude: excludeIndices,
        });
        snapReady = true;
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
        const { w, h } = getCanvasSize();
        return applyGridSnap(val, {
            isX,
            grid: GRID_SNAP,
            canvasW: w,
            canvasH: h,
            altKey: isAltPressed,
            mode: snapMode,
        });
    };

    // 对象吸附：边对齐 / 等距的几何计算都在 core/box-snap.js 里
    const snapMoveRect = (rect, altKey) => {
        ensureSnapTargets();
        return snapMoveRectCore(rect, snapTargets, {
            mode: snapMode,
            altKey,
            grid: GRID_SNAP,
            scale: getActualScale(),
            snapPx: SNAP_PX,
        });
    };

    const snapEdge = (value, axis, altKey) => {
        ensureSnapTargets();
        return snapEdgeCore(value, axis, snapTargets, {
            mode: snapMode,
            altKey,
            scale: getActualScale(),
            snapPx: SNAP_PX,
        });
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
        if (nudgeSelected(dx, dy)) {
            const sign = (n) => (n > 0 ? "+" + n : String(n));
            toast.show(`微移 x ${sign(dx)}, y ${sign(dy)}`, 800);
        }
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
            refreshHudOffset();
            updateCoordHud();
            return;
        }
        editorContainer.style.display = "flex";
        refreshHudOffset();
        updateCoordHud();
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

        // 角色下拉：按描述前缀回显，没有前缀就停在「（不指定）」
        refreshCharacterSelect();

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

    // 提示词预设：标签文本原样追加到当前框的描述；按住 Shift 写入则覆盖
    const applyPresets = (texts, { overwrite }) => {
        const item = model.active >= 0 ? model.items[model.active] : null;
        if (!item) {
            toast.show("请先选中一个框", 1200);
            return;
        }
        const joined = texts.join(", ");
        const current = typeof item.caption === "string" && item.caption
            ? item.caption
            : (typeof item.desc === "string" ? item.desc : "");
        item.caption = overwrite ? joined : (current ? `${current}, ${joined}` : joined);
        descArea.value = item.caption;
        saveEditorChanges();
        closePopover();
        toast.show(overwrite ? `已覆盖描述：${joined}` : `已写入 ${texts.length} 个预设`, 1600);
    };

    const presetPanel = createPresetPanel({
        onToast: (msg) => toast.show(msg, 1600),
        onApply: applyPresets,
    });
    presetPanel.load();
    presetBtn.addEventListener("click", async () => {
        await presetPanel.load();
        openPopover(presetBtn, presetPanel.el, { width: 340 });
    });
    node._mossPresetCleanup = () => presetPanel.destroy();

    // 🌟 极小框的视觉代理范围：真实 bbox 小于网格时按一个网格大小显示，几何在 core/extreme-box.js
    const getVisualBounds = (item) => getVisualBoundsCore(item, GRID_SNAP);

    // 🌟 将视觉范围反向映射回真实数据
    const applyVisualBounds = (item, vXmin, vYmin) => applyVisualBoundsCore(item, vXmin, vYmin, GRID_SNAP);

    // 一帧最多重绘一次：高回报率鼠标一帧能发十几个 mousemove
    let drawScheduled = false;
    const requestDraw = () => {
        if (drawScheduled) return;
        drawScheduled = true;
        requestAnimationFrame(() => {
            drawScheduled = false;
            drawCanvas();
        });
    };

    // --- 绘制画布 ---
    const drawCanvas = () => {
        const rect = getCanvasRect();
        if (rect.width === 0 || rect.height === 0) return; // 面板隐藏时跳过

        updateCoordHud();

        const ctx = canvas.getContext("2d");
        const { w, h } = getCanvasSize();
        const actualScale = getActualScale();

        const dpr = window.devicePixelRatio || 1;
        const cssW = Math.round(rect.width);
        const cssH = Math.round(rect.height);
        if (canvasCssW !== cssW || canvasCssH !== cssH || canvasDpr !== dpr) {
            canvasCssW = cssW;
            canvasCssH = cssH;
            canvasDpr = dpr;
            canvas.width = Math.round(cssW * dpr);
            canvas.height = Math.round(cssH * dpr);
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        }

        ctx.fillStyle = "#111";
        ctx.fillRect(0, 0, cssW, cssH);

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

        // 背景图吸附：画法照搬框的辅助线，蓝色 1px 虚线，贯穿画布
        if (bgSnapGuides.length) {
            ctx.save();
            ctx.strokeStyle = "#4a9eff";
            ctx.lineWidth = 1;
            ctx.setLineDash([5, 4]);
            bgSnapGuides.forEach((guide) => {
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

        if (marqueeRect) {
            const x = Math.min(marqueeRect.x1, marqueeRect.x2);
            const y = Math.min(marqueeRect.y1, marqueeRect.y2);
            const w = Math.abs(marqueeRect.x2 - marqueeRect.x1);
            const h = Math.abs(marqueeRect.y2 - marqueeRect.y1);
            ctx.save();
            ctx.fillStyle = "rgba(74, 158, 255, 0.12)";
            ctx.strokeStyle = "#4a9eff";
            ctx.lineWidth = 1;
            ctx.setLineDash([4, 3]);
            ctx.fillRect(x, y, w, h);
            ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(w), Math.round(h));
            ctx.restore();
        }
    };

    const resizeObserver = new ResizeObserver(() => {
        invalidateCanvasRect();
        drawCanvas();
    });
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
                    toast.show("已粘贴背景图");
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

            const rect = getCanvasRect();
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

    // 框选结算：矩形与框的视觉范围相交即选中；矩形太小当成在空白处点了一下
    const applyMarqueeSelection = (rect, additive) => {
        const x1 = Math.min(rect.x1, rect.x2);
        const x2 = Math.max(rect.x1, rect.x2);
        const y1 = Math.min(rect.y1, rect.y2);
        const y2 = Math.max(rect.y1, rect.y2);

        if (!additive) model.selection.clear();

        if (x2 - x1 < 3 && y2 - y1 < 3) {
            if (!additive) model.setActive(-1);
        } else {
            model.items.forEach((item, i) => {
                if (!item || !Array.isArray(item.bbox)) return;
                const b = getVisualBounds(item);
                const p1 = logicToPhys(b.vXmin, b.vYmin);
                const p2 = logicToPhys(b.vXmax, b.vYmax);
                if (p2.x >= x1 && p1.x <= x2 && p2.y >= y1 && p1.y <= y2) {
                    model.selection.add(i);
                }
            });
            if (model.selection.size) {
                model.setActive(Math.min(...model.selection));
            } else if (!additive) {
                model.setActive(-1);
            }
        }

        updateListSelection();
        syncEditorPanel();
        drawCanvas();

        if (model.selection.size) toast.show(`已框选 ${model.selection.size} 个框`);
        else if (!additive) toast.show("框选区域为空", 1000);
    };

    // 开始拖动时确定这一组：多选且点在选区内 → 整组；否则只有自己
    const beginMoveGroup = (targetIdx) => {
        const indices = model.selection.size > 1 && model.selection.has(targetIdx)
            ? Array.from(model.selection)
            : [targetIdx];
        dragStartGroup = indices
            .filter((i) => Number.isInteger(i) && i >= 0 && i < model.items.length
                && model.items[i] && Array.isArray(model.items[i].bbox)
                && !model.items[i]._locked) // 锁住的框不跟着动
            .sort((a, b) => a - b)
            .map((i) => ({ index: i, bbox: [...model.items[i].bbox] }));
    };

    // 原地复制整组：深拷贝保留框色 / 锁定 / 极小框对齐等会话状态，
    // 并把选区与 active 一起切到副本上，后续拖动只动副本
    const duplicateItemsInPlace = (indices, focusIdx) => {
        const valid = [...new Set(indices)]
            .filter((i) => Number.isInteger(i) && i >= 0 && i < model.items.length
                && model.items[i] && Array.isArray(model.items[i].bbox))
            .sort((a, b) => a - b);
        if (!valid.length) return null;

        const added = [];
        const indexMap = new Map();
        valid.forEach((i) => {
            const clone = JSON.parse(JSON.stringify(model.items[i]));
            delete clone._isNew;
            model.items.push(clone);
            indexMap.set(i, model.items.length - 1);
            added.push(model.items.length - 1);
        });

        model.selection.clear();
        added.forEach((i) => model.selection.add(i));
        const active = indexMap.get(focusIdx) ?? added[0];
        model.setActive(active);
        syncColorWidget();
        // 复制必须独占一步撤销，不能和之前的连续输入合并
        model.resetCoalesce();
        return { added, active };
    };

    // 复制结果的落盘 / 重绘（Ctrl+D 没有后续 mouseup，需要自己收尾）
    const commitDuplicates = (added) => {
        if (!added.length) return false;
        saveEditorChanges();
        renderList(false);
        updateListSelection();
        syncEditorPanel();
        drawCanvas();
        if (node.graph) node.graph.setDirtyCanvas(true, true);
        return true;
    };

    // 记录一次「Alt 拖拽复制」的候选，等 mousemove 真的产生位移再执行
    const armCopyDrag = (targetIdx) => {
        const indices = model.selection.size > 1 && model.selection.has(targetIdx)
            ? Array.from(model.selection)
            : [targetIdx];
        pendingCopyDrag = { indices, targetIdx };
    };

    canvas.addEventListener("mousedown", (e) => {
        invalidateCanvasRect();
        canvas.focus();
        snapReady = false;
        const rect = getCanvasRect();
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
        dragCtrlKey = isCtrl;
        dragStartAlt = e.altKey;
        dragCopyMode = false;
        dragCreating = false;
        pendingCopyDrag = null;

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
                beginMoveGroup(targetIdx);
                if (e.altKey && !isCtrl) armCopyDrag(targetIdx);
            }

            e.preventDefault();
            return;
        }

        if (hit.type === "create") {
            // Shift + 拖空白 = 框选（普通拖拽仍然是新建框）
            if (e.shiftKey) {
                marqueeRect = { x1: mouseX, y1: mouseY, x2: mouseX, y2: mouseY };
                marqueeAdditive = isCtrl;
                dragMode = "marquee";
                dragStartMouse = { x: mouseX, y: mouseY };
                drawCanvas();
                e.preventDefault();
                return;
            }

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
            dragCreating = true;
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
            if (hit.type === "move") {
                beginMoveGroup(targetIdx);
                if (e.altKey && !isCtrl && model.items[targetIdx] && !model.items[targetIdx]._locked) {
                    armCopyDrag(targetIdx);
                }
            }
        }

        updateListSelection();
        if (hit.type !== "create") {
            syncEditorPanel();
        }
        drawCanvas();
        e.preventDefault();
    });

    window.addEventListener("mousemove", (e) => {
        const rect = getCanvasRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        if (isPanning) {
            model.view.x = panStartViewX + (mouseX - panStartX);
            model.view.y = panStartViewY + (mouseY - panStartY);
            requestDraw();
            return;
        }

        // 🌟 背景图拖拽计算
        if (bgDragMode && bgImage) {
            const dx = (mouseX - bgStartMouse.x) / getActualScale();
            const dy = (mouseY - bgStartMouse.y) / getActualScale();

            let nx = bgStartBBox.x, ny = bgStartBBox.y, nw = bgStartBBox.w, nh = bgStartBBox.h;
            bgSnapGuides = [];

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
                    const snappedX = snapAxisWithAnchors(nx, nw, xTargets, snapThreshold);
                    const snappedY = snapAxisWithAnchors(ny, nh, yTargets, snapThreshold);
                    nx = snappedX.pos;
                    ny = snappedY.pos;
                    // 命中的是画布的哪条线，就在那条线上画虚线（和框的吸附一致）
                    addBgGuide("x", snappedX.target);
                    addBgGuide("y", snappedY.target);
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

                    if (bgDragMode.includes("l")) L = snapEdgeToTargets(L, xTargets, snapThr).value;
                    if (bgDragMode.includes("r")) R = snapEdgeToTargets(R, xTargets, snapThr).value;
                    if (bgDragMode.includes("t")) T = snapEdgeToTargets(T, yTargets, snapThr).value;
                    if (bgDragMode.includes("b")) B = snapEdgeToTargets(B, yTargets, snapThr).value;
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

                // 长宽比联动可能把刚吸附好的边又推开一点，所以按最终位置判断是否还落在目标线上
                if (bgSnap) {
                    const { w: cw, h: ch } = getCanvasSize();
                    const xT = [-cw / 2, 0, cw / 2];
                    const yT = [-ch / 2, 0, ch / 2];
                    const markEdge = (value, targets, axis) => addBgGuide(axis, matchTarget(value, targets));
                    if (bgDragMode.includes("l")) markEdge(nx - nw / 2, xT, "x");
                    if (bgDragMode.includes("r")) markEdge(nx + nw / 2, xT, "x");
                    if (bgDragMode.includes("t")) markEdge(ny - nh / 2, yT, "y");
                    if (bgDragMode.includes("b")) markEdge(ny + nh / 2, yT, "y");
                }
            }

            if (nw > 10 && nh > 10) {
                bgX = nx; bgY = ny; bgW = nw; bgH = nh;
                drawCanvas();
            }
            return; // 阻断后续的 bbox 逻辑
        }

        if (!dragMode) return;

        if (dragMode === "marquee") {
            if (marqueeRect) {
                marqueeRect.x2 = mouseX;
                marqueeRect.y2 = mouseY;
                requestDraw();
            }
            return;
        }

        // Alt 复制：真正拖出位移才生成副本，之后本次拖动只移动副本
        if (pendingCopyDrag) {
            const start = pendingCopyDrag;
            if (Math.abs(mouseX - dragStartMouse.x) < 2 && Math.abs(mouseY - dragStartMouse.y) < 2) return;
            pendingCopyDrag = null;
            const copied = duplicateItemsInPlace(start.indices, start.targetIdx);
            if (copied) {
                dragCopyMode = true;
                dragCopyCount = copied.added.length;
                dragStartBBox = [...model.items[copied.active].bbox];
                beginMoveGroup(copied.active);
                updateListSelection();
                syncEditorPanel();
            }
        }

        // 副本拖动仍走正常吸附：Alt 已用于触发复制，不再兼任「临时关闭吸附」
        const bypassSnap = dragStartAlt && !dragCopyMode;

        const dx = mouseX - dragStartMouse.x;
        const dy = mouseY - dragStartMouse.y;

        // 新建框的起点是零尺寸的点：按鼠标所在象限决定在拉哪个角，
        // 这样左上 / 右上 / 左下 / 右下四个方向都能画，拖动中越过起点也会自动换向
        if (dragCreating) {
            dragMode = "resize-" + (dy >= 0 ? "b" : "t") + (dx >= 0 ? "r" : "l");
        }

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

            // 这次拖动带走的框：多选时整组，否则只有自己
            const group = dragStartGroup.length
                ? dragStartGroup
                : [{ index: model.active, bbox: dragStartBBox }];

            let targetXmin;
            let targetYmin;
            let visualVx = null;
            let visualVy = null;

            if (isExtreme) {
                let newVx = vXmin + logicDx;
                let newVy = vYmin + logicDy;

                newVx = applySnap(newVx, bypassSnap, true);
                newVy = applySnap(newVy, bypassSnap, false);

                const snapped = snapMoveRect({ x: newVx, y: newVy, w: GRID_SNAP, h: GRID_SNAP }, bypassSnap);
                newVx = snapped.x;
                newVy = snapped.y;
                setGuides(snapped.guides);

                newVx = Math.max(-limitX, Math.min(newVx, limitX - GRID_SNAP));
                newVy = Math.max(-limitY, Math.min(newVy, limitY - GRID_SNAP));

                visualVx = newVx;
                visualVy = newVy;
                // 视觉代理与真实框是同一个平移，换算回真实坐标
                targetXmin = newVx + (dragStartBBox[1] - vXmin);
                targetYmin = newVy + (dragStartBBox[0] - vYmin);
            } else {
                let newXmin = vXmin + logicDx;
                let newYmin = vYmin + logicDy;

                newXmin = applySnap(newXmin, bypassSnap, true);
                newYmin = applySnap(newYmin, bypassSnap, false);

                const snapped = snapMoveRect(
                    { x: newXmin, y: newYmin, w: vXmax - vXmin, h: vYmax - vYmin },
                    bypassSnap
                );
                newXmin = snapped.x;
                newYmin = snapped.y;
                setGuides(snapped.guides);

                newXmin = Math.max(-limitX, Math.min(newXmin, limitX - (vXmax - vXmin)));
                newYmin = Math.max(-limitY, Math.min(newYmin, limitY - (vYmax - vYmin)));

                targetXmin = newXmin;
                targetYmin = newYmin;
            }

            if (isExtreme && group.length === 1) {
                // 单个极小框：仍走视觉代理反算，保持原来的取整行为
                applyVisualBounds(model.items[model.active], visualVx, visualVy);
            } else {
                // 整组按同一位移移动，相对位置不变
                let dx = targetXmin - dragStartBBox[1];
                let dy = targetYmin - dragStartBBox[0];

                if (group.length > 1) {
                    // 整组不许出画布：按整组包围盒夹一次位移
                    let gXmin = Infinity, gXmax = -Infinity, gYmin = Infinity, gYmax = -Infinity;
                    group.forEach(({ bbox }) => {
                        gYmin = Math.min(gYmin, bbox[0]);
                        gYmax = Math.max(gYmax, bbox[2]);
                        gXmin = Math.min(gXmin, bbox[1]);
                        gXmax = Math.max(gXmax, bbox[3]);
                    });
                    dx = Math.max(-limitX - gXmin, Math.min(dx, limitX - gXmax));
                    dy = Math.max(-limitY - gYmin, Math.min(dy, limitY - gYmax));
                }

                group.forEach(({ index, bbox }) => {
                    const item = model.items[index];
                    if (!item) return;
                    item.bbox = [bbox[0] + dy, bbox[1] + dx, bbox[2] + dy, bbox[3] + dx];
                });
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
            if (isLeft) newXmin = applySnap(newXmin, bypassSnap, true);
            if (isRight) newXmax = applySnap(newXmax, bypassSnap, true);
            if (isTop) newYmin = applySnap(newYmin, bypassSnap, false);
            if (isBottom) newYmax = applySnap(newYmax, bypassSnap, false);

            const edgeGuides = [];
            if (isLeft) {
                const r = snapEdge(newXmin, "x", bypassSnap);
                newXmin = r.value;
                if (r.guide) edgeGuides.push(r.guide);
            }
            if (isRight) {
                const r = snapEdge(newXmax, "x", bypassSnap);
                newXmax = r.value;
                if (r.guide) edgeGuides.push(r.guide);
            }
            if (isTop) {
                const r = snapEdge(newYmin, "y", bypassSnap);
                newYmin = r.value;
                if (r.guide) edgeGuides.push(r.guide);
            }
            if (isBottom) {
                const r = snapEdge(newYmax, "y", bypassSnap);
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
        requestDraw();
    });

    window.addEventListener("mouseup", () => {
        if (bgDragMode) {
            bgDragMode = null;
            bgSnapGuides = [];
            drawCanvas();
            if (syncBgSizeHook) syncBgSizeHook(); // 拖动/拉伸结束后刷新尺寸输入框
            return;
        }
        if (isPanning) {
            isPanning = false;
            canvas.style.cursor = "default";
            return;
        }
        if (!dragMode) {
            dragCreating = false;
            return;
        }
        // Alt+单击（没有真正拖动）不该留下重叠副本
        pendingCopyDrag = null;
        dragCreating = false;

        if (dragMode === "marquee") {
            const rect = marqueeRect;
            dragMode = null;
            marqueeRect = null;
            if (rect) applyMarqueeSelection(rect, marqueeAdditive);
            marqueeAdditive = false;
            drawCanvas();
            if (node.graph) node.graph.setDirtyCanvas(true, true);
            return;
        }

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

                    // 单击（没有位移）时把选区收敛到这一个框，
                    // 否则点一个已在多选里的框时，Ctrl+C 复制的是整组旧选区
                    const unchanged =
                        Array.isArray(dragStartBBox) && item.bbox.join(",") === dragStartBBox.join(",");
                    if (unchanged && !dragCtrlKey && !dragCopyMode && model.selection.size > 1) {
                        model.selection.clear();
                        model.selection.add(currentActive);
                        updateListSelection();
                        syncEditorPanel();
                        drawCanvas();
                    }

                    // 🌟 身份证查验
                    const isNew = !knownBboxHistory.has(dragStartBBox.join(","));

                    // 1. 防误触：新建框且极小，直接静默删除
                    if (isNew && !dragCopyMode && w <= 5 && h <= 5) {
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
                    
                    // 3. 刷新通行证（整组一起记，避免下次被当成新建框）
                    knownBboxHistory.add(item.bbox.join(","));
                    dragStartGroup.forEach(({ index }) => {
                        const moved = model.items[index];
                        if (moved && Array.isArray(moved.bbox)) knownBboxHistory.add(moved.bbox.join(","));
                    });
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
            dragStartGroup = [];
            pendingCopyDrag = null;
            if (dragCopyCount) toast.show(`已复制 ${dragCopyCount} 个框`);
            dragCopyCount = 0;
            dragCopyMode = false;
            updateListSelection();
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
        const rect = getCanvasRect();
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
    // 文本协议与克隆逻辑在 core/box-clipboard.js，这里只负责系统剪贴板读写

    const fallbackCopyText = (text) => {
        try {
            const area = document.createElement("textarea");
            area.value = text;
            area.style.cssText = "position: fixed; left: -9999px; top: 0; opacity: 0;";
            document.body.appendChild(area);
            area.select();
            document.execCommand("copy");
            document.body.removeChild(area);
        } catch (e) {
            console.warn("[MOSS] 写入剪贴板失败:", e);
        }
    };

    const writeClipboardText = (text) => {
        try {
            if (navigator.clipboard?.writeText) {
                navigator.clipboard.writeText(text).catch(() => fallbackCopyText(text));
                return;
            }
        } catch (e) {
            // 继续走兜底
        }
        fallbackCopyText(text);
    };

    const copySelectedBoxes = () => {
        const inRange = (i) => Number.isInteger(i) && i >= 0 && i < model.items.length;
        const selected = Array.from(model.selection).filter(inRange);
        const idxs = selected.length ? selected : inRange(model.active) ? [model.active] : [];
        if (!idxs.length) return false;
        idxs.sort((a, b) => a - b);
        bboxClipboard = idxs
            .map((i) => model.items[i])
            .filter(Boolean)
            .map(cloneItemForClipboard);
        if (!bboxClipboard.length) return false;
        writeClipboardText(formatClipboardPayload(bboxClipboard));
        return true;
    };

    const pasteBoxes = () => {
        if (!bboxClipboard.length) return false;
        const { w, h } = getCanvasSize();
        const limitX = w / 2;
        const limitY = h / 2;
        // 网格吸附时往右下挪一整格（16 / 32）并落到网格线上，否则只错开 10px
        const onGrid = snapMode === "grid";
        const offset = onGrid ? GRID_SNAP : 10;

        const added = [];
        bboxClipboard.forEach((src) => {
            const clone = JSON.parse(JSON.stringify(src));
            const bbox = Array.isArray(clone.bbox) ? clone.bbox : null;
            if (!bbox || bbox.length !== 4) return;

            const bw = bbox[3] - bbox[1];
            const bh = bbox[2] - bbox[0];
            // 整格平移，不再二次吸附：否则原本不在网格上的框可能被拉回左边
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
    // 焦点随时会飘走（浏览器默认行为、ComfyUI 的全局监听），
    // 所以用「最后一次按下的位置」判断上下文，焦点只作为兜底
    let pointerInsidePanel = false;
    document.addEventListener(
        "pointerdown",
        (e) => {
            pointerInsidePanel = panel.contains(e.target) || e.target === canvas;
        },
        true
    );

    const isOurContext = (target) => {
        if (target === canvas || panel.contains(target)) return true;
        if (pointerInsidePanel) return true;
        const ae = document.activeElement;
        return ae === canvas || (ae && panel.contains(ae));
    };

    const isTypingElsewhere = () => {
        const ae = document.activeElement;
        if (!ae) return false;
        if (ae.isContentEditable) return true;
        const tag = ae.tagName;
        if (tag === "TEXTAREA" || tag === "SELECT") return true;
        if (tag === "INPUT") {
            const type = String(ae.type || "text").toLowerCase();
            // 勾选框 / 单选 / 滑块 / 颜色块不是文本输入，不该拦 Delete
            return !["checkbox", "radio", "button", "submit", "reset", "range", "color"].includes(type);
        }
        return false;
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
            toast.show(`已复制 ${bboxClipboard.length} 个框`);
            e.preventDefault();
            e.stopPropagation();
        } else {
            toast.show("没有选中可复制的框", 1000);
        }
    };
    window.addEventListener("keydown", onPanelCopyKeydown, true);

    // 删除选中的框；处于「操控背景图」模式时优先删背景图。返回是否处理过。
    // 画布聚焦、右侧列表点选、右上角全选都走这一个入口，不再只认 canvas 的 keydown
    const deleteSelectionOrBackground = () => {
        if (bgActive && bgImage) {
            deleteBackgroundImage();
            toast.show("已删除背景图");
            return true;
        }
        if (!model.selection.size) return false;

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
        toast.show(`已删除 ${indicesToRemove.length} 个框`);
        return true;
    };

    // Ctrl+A 全选 / Ctrl+D 原地复制 / Esc 取消选择
    const onPanelEditKeydown = (e) => {
        if (!document.body.contains(panel)) {
            window.removeEventListener("keydown", onPanelEditKeydown, true);
            return;
        }
        if (e.defaultPrevented || !isPanelOpen() || isTypingElsewhere()) return;
        if (!isOurContext(e.target)) return;

        const key = (e.key || "").toLowerCase();
        const isCtrl = e.ctrlKey || e.metaKey;

        // Delete / Backspace：焦点在画布、列表行、全选按钮上都生效；
        // 输入框 / 下拉框里由 isTypingElsewhere 挡住，不会误删
        if ((key === "delete" || key === "backspace") && !isCtrl && !e.altKey) {
            if (!deleteSelectionOrBackground()) return;
            e.preventDefault();
            e.stopPropagation();
            return;
        }

        if (key === "escape" && !isCtrl && !e.altKey) {
            if (!model.selection.size && model.active === -1 && !marqueeRect) return;
            // 框选拖到一半按 Esc：直接作废，不结算选区
            if (marqueeRect) {
                dragMode = null;
                marqueeRect = null;
                marqueeAdditive = false;
                pendingCopyDrag = null;
            }
            model.selection.clear();
            model.setActive(-1);
            updateListSelection();
            syncEditorPanel();
            drawCanvas();
            if (node.graph) node.graph.setDirtyCanvas(true, true);
            toast.show("已取消选择", 1000);
            // 不拦事件：颜色浮层、内联输入框等也要收到 Esc
            return;
        }

        if (!isCtrl || e.altKey) return;

        if (key === "a") {
            if (!model.items.length) {
                toast.show("当前没有边界框", 1000);
                return;
            }
            model.selection.clear();
            model.items.forEach((_, i) => model.selection.add(i));
            model.setActive(model.items.length - 1);
            updateListSelection();
            syncEditorPanel();
            drawCanvas();
            toast.show(`已全选 ${model.items.length} 个框`);
            e.preventDefault();
            e.stopPropagation();
            return;
        }

        if (key === "d") {
            const idxs = model.selection.size
                ? Array.from(model.selection)
                : model.active >= 0 ? [model.active] : [];
            if (!idxs.length) {
                toast.show("没有选中可复制的框", 1000);
                return;
            }
            const copied = duplicateItemsInPlace(idxs, model.active >= 0 ? model.active : idxs[0]);
            if (!copied) return;
            commitDuplicates(copied.added);
            toast.show(`已复制 ${copied.added.length} 个框（原地）`);
            e.preventDefault();
            e.stopPropagation();
        }
    };
    window.addEventListener("keydown", onPanelEditKeydown, true);

    // 按住修饰键时，画布顶部常驻这一组快捷键说明；松开 / 窗口失焦后收起
    const HINT_ALT = "Alt · 拖动框 = 复制副本（原件留在原处）";
    const HINT_CTRL = "Ctrl · C 复制 / V 粘贴 / A 全选 / D 原地复制";
    const HINT_SHIFT = "Shift · 拖空白 = 框选 / 方向键 = 按步长微移";
    const hintFor = (e) => {
        if (e.altKey && !e.ctrlKey && !e.metaKey) return HINT_ALT;
        if ((e.ctrlKey || e.metaKey) && !e.altKey) return HINT_CTRL;
        if (e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) return HINT_SHIFT;
        return "";
    };
    const detachModifierHints = () => {
        window.removeEventListener("keydown", onModifierKeydown, true);
        window.removeEventListener("keyup", onModifierKeyup, true);
        window.removeEventListener("blur", onWindowBlur);
    };
    const onModifierKeydown = (e) => {
        if (!document.body.contains(panel)) { detachModifierHints(); return; }
        if (!isPanelOpen() || isTypingElsewhere()) { toast.setHint(""); return; }
        toast.setHint(hintFor(e));
    };
    const onModifierKeyup = (e) => {
        if (!document.body.contains(panel)) { detachModifierHints(); return; }
        toast.setHint(hintFor(e));
    };
    const onWindowBlur = () => toast.setHint("");
    window.addEventListener("keydown", onModifierKeydown, true);
    window.addEventListener("keyup", onModifierKeyup, true);
    window.addEventListener("blur", onWindowBlur);

    node._mossToastCleanup = () => {
        detachModifierHints();
        toast.destroy();
    };

    const onPanelPaste = (e) => {
        if (!document.body.contains(panel)) {
            document.removeEventListener("paste", onPanelPaste, true);
            return;
        }
        if (e.defaultPrevented || !isPanelOpen() || isTypingElsewhere()) return;
        if (!isOurContext(e.target)) return;

        // 1) 剪贴板里是我们复制过的框（带前缀）→ 只认剪贴板，不再退回内存
        const clipText = e.clipboardData?.getData ? e.clipboardData.getData("text/plain") : "";
        if (typeof clipText === "string" && clipText.startsWith(CLIPBOARD_PREFIX)) {
            const clipBoxes = parseClipboardBoxes(clipText);
            if (!clipBoxes || !clipBoxes.length) return; // 内容坏了就当没有，别粘出旧框
            bboxClipboard = clipBoxes;
            if (pasteBoxes()) {
                toast.show(`已粘贴 ${bboxClipboard.length} 个框`);
                e.preventDefault();
                e.stopPropagation();
            }
            return;
        }

        // 2) 剪贴板里是图片 → 图片优先，当背景图处理
        const items = e.clipboardData?.items;
        const imageItem = items
            ? Array.from(items).find((it) => it.type && it.type.startsWith("image/"))
            : null;
        if (imageItem) {
            // 焦点不在画布上时 canvas 自己的 paste 监听不会触发，这里补上
            if (document.activeElement !== canvas) {
                const file = imageItem.getAsFile();
                if (file && loadBackgroundFromBlob(file)) {
                    toast.show("已粘贴背景图");
                    e.preventDefault();
                    e.stopPropagation();
                }
            }
            return;
        }

        if (bboxClipboard.length && pasteBoxes()) {
            toast.show(`已粘贴 ${bboxClipboard.length} 个框`);
            e.preventDefault();
            e.stopPropagation();
        }
    };
    document.addEventListener("paste", onPanelPaste, true);

    canvas.addEventListener("mousemove", (e) => {
        if (isPanning || dragMode) return;
        const rect = getCanvasRect();
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
            canvas.style.cursor = e.altKey ? "copy" : "pointer";
            return;
        }

        const hit = getHitInfo(mouseX, mouseY);

        // Alt 悬停在框上 = 拖拽复制；Shift 悬停在空白处 = 框选
        if (e.altKey && !e.shiftKey && hit.type === "move") {
            canvas.style.cursor = "copy";
            return;
        }

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

    // ================= 角色：纯文本层面的临时预设 =================
    // 角色列表存在 node.properties（跟着工作流走，但**不进** layout_json）；
    // 增删只改 summary.caption 的文本，选中角色只改框描述的文本前缀。
    function readCharacters() {
        const list = node.properties?.moss_characters;
        if (!Array.isArray(list)) return [];
        return list.filter((c) => c && typeof c.name === "string" && c.name.trim());
    }

    function writeCharacters(list) {
        if (!node.properties) node.properties = {};
        node.properties.moss_characters = list;
    }

    function characterLine(c) {
        // 描述允许多行，写进主提示词时压成一行，保持「一行一个角色」
        const desc = (c.desc || "").replace(/\s+/g, " ").trim();
        return desc ? `${c.name}，${desc}` : c.name;
    }

    function setPromptText(text) {
        promptTextarea.value = text;
        // 复用主提示词的 input 监听，保证 JSON 跟 UI 同步
        promptTextarea.dispatchEvent(new Event("input"));
    }

    function addCharacterToPrompt(c) {
        const line = characterLine(c);
        const text = promptTextarea.value.replace(/\s+$/, "");
        setPromptText(text ? `${text}\n\n${line}` : line);
    }

    function removeCharacterFromPrompt(c) {
        const line = characterLine(c);
        const text = promptTextarea.value;
        const idx = text.indexOf(line);
        // 用户手改过主提示词、匹配不到就跳过，不误删别的文本
        if (idx === -1) return;
        const before = text.slice(0, idx).replace(/\s+$/, "");
        const after = text.slice(idx + line.length).replace(/^\s+/, "");
        setPromptText(before && after ? `${before}\n\n${after}` : before || after);
    }

    // 描述开头是不是某个角色名（中英文逗号都认）
    function matchCharacter(text) {
        const src = typeof text === "string" ? text : "";
        for (const c of readCharacters()) {
            if (src.startsWith(`${c.name}，`) || src.startsWith(`${c.name},`)) return c.name;
        }
        return "";
    }

    function stripCharacterPrefix(text) {
        let out = typeof text === "string" ? text : "";
        for (const c of readCharacters()) {
            let hit = false;
            for (const sep of ["，", ","]) {
                if (out.startsWith(c.name + sep)) {
                    out = out.slice(c.name.length + 1);
                    hit = true;
                    break;
                }
            }
            if (hit) break;
        }
        return out.replace(/^[\s，,]+/, "");
    }

    function refreshCharacterSelect() {
        const list = readCharacters();
        charSelect.innerHTML = "";
        const none = document.createElement("option");
        none.value = "";
        none.textContent = "（不指定）";
        charSelect.appendChild(none);
        list.forEach((c) => {
            const opt = document.createElement("option");
            opt.value = c.name;
            opt.textContent = c.name;
            charSelect.appendChild(opt);
        });
        const item = model.active >= 0 ? model.items[model.active] : null;
        charSelect.disabled = !item;
        charSelect.value = item ? matchCharacter(item.caption || "") : "";
    }

    function deleteCharacterAt(index) {
        const list = readCharacters();
        const c = list[index];
        if (!c) return;
        writeCharacters(list.filter((_, i) => i !== index));
        removeCharacterFromPrompt(c);
        renderCharacterList();
        refreshCharacterSelect();
        toast.show(`已删除角色：${c.name}`, 1400);
    }

    // 改角色时把主提示词里那一行原地替换，不改变它在文中的位置
    function replaceCharacterInPrompt(oldC, newC) {
        const oldLine = characterLine(oldC);
        const newLine = characterLine(newC);
        const text = promptTextarea.value;
        const idx = text.indexOf(oldLine);
        if (idx === -1) {
            addCharacterToPrompt(newC);
            return;
        }
        setPromptText(text.slice(0, idx) + newLine + text.slice(idx + oldLine.length));
    }

    async function editCharacterAt(index) {
        const current = readCharacters()[index];
        if (!current) return;
        const result = await showCharacterDialog({
            name: current.name,
            desc: current.desc,
            title: "修改角色",
            subtitle: "改完会替换主提示词里对应的那一行。",
        });
        if (!result) return;

        const list = readCharacters();
        if (list.some((c, i) => i !== index && c.name === result.name)) {
            toast.show(`角色「${result.name}」已存在`, 1600);
            return;
        }
        const old = list[index];
        list[index] = result;
        writeCharacters(list);
        replaceCharacterInPrompt(old, result);
        renderCharacterList();
        refreshCharacterSelect();
        toast.show(`已更新角色：${result.name}`, 1400);
    }

    function renderCharacterList() {
        const list = readCharacters();
        charListEl.innerHTML = "";
        charEmptyEl.style.display = list.length ? "none" : "";
        list.forEach((c, index) => {
            const row = document.createElement("div");
            row.className = "moss-char-row";
            row.title = "双击修改，右键删除";

            const label = document.createElement("span");
            label.className = "moss-char-name";
            label.textContent = characterLine(c);

            const edit = createButton("✎", { icon: true, title: "修改角色" });
            edit.onclick = (e) => {
                e.stopPropagation();
                editCharacterAt(index);
            };

            const del = createButton("×", { icon: true, title: "删除角色" });
            del.onclick = (e) => {
                e.stopPropagation();
                deleteCharacterAt(index);
            };

            row.addEventListener("dblclick", () => editCharacterAt(index));
            row.addEventListener("contextmenu", (e) => {
                e.preventDefault();
                e.stopPropagation();
                deleteCharacterAt(index);
            });

            row.appendChild(label);
            row.appendChild(edit);
            row.appendChild(del);
            charListEl.appendChild(row);
        });
    }

    // 选中角色：把「角色名，」插到描述最前面，换角色时替换掉旧前缀
    charSelect.onchange = () => {
        const name = charSelect.value;
        const item = model.active >= 0 ? model.items[model.active] : null;
        if (!item) return;
        const rest = stripCharacterPrefix(item.caption || "");
        item.caption = name ? (rest ? `${name}，${rest}` : name) : rest;
        descArea.value = item.caption;
        saveEditorChanges();
    };

    charAddBtn.onclick = async () => {
        const result = await showCharacterDialog();
        if (!result) return;
        const list = readCharacters();
        if (list.some((c) => c.name === result.name)) {
            toast.show(`角色「${result.name}」已存在`, 1600);
            return;
        }
        writeCharacters([...list, result]);
        addCharacterToPrompt(result);
        renderCharacterList();
        refreshCharacterSelect();
        toast.show(`已添加角色：${result.name}`, 1400);
    };

    renderCharacterList();
    refreshCharacterSelect();

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
            // 先按 bbox 继承本次会话的颜色（最准），再用缓存补上其余
            carryEditorState(prevItems, model.items);
            restoreItemColors();
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
                <li>在空白处按住左键拖动：<b>创建新框</b>（四个方向都能拖出，越过起点自动换向）</li>
                <li>拖动框的内部或数字标签：<b>移动框</b></li>
                <li>拖动框的四个角：<b>拉伸缩放</b></li>
                <li>双击框内部：<b>快速编辑描述</b></li>
                <li>滚轮：<b>缩放画布</b>；中键拖动：<b>平移画布</b></li>
                <li>开启「背景图设置 → 操控」后：拖动 / 拉伸背景图，靠近画布边缘或中心会<b>吸附并显示蓝色虚线</b></li>
            </ul>

            <div style="margin-bottom: 10px;"><b style="color:#fff;">⌨️ 快捷键：</b></div>
            <ul style="margin: 0 0 10px 20px; padding: 0; color: #ccc;">
                <li><b>Shift + 拖空白</b>：框选多个框；<b>Ctrl + Shift + 拖空白</b>：追加框选</li>
                <li><b>Alt + 拖动框</b>：复制选中的框并拖动副本，原件留在原处</li>
                <li><b>Ctrl + A</b>：全选；<b>Esc</b>：取消选择</li>
                <li><b>Ctrl + D</b>：原地复制选中框（副本与原件重合，复制后可直接拖动）</li>
                <li><b>Ctrl + C / Ctrl + V</b>：复制框到系统剪贴板 / 粘贴框或背景图</li>
                <li><b>Delete / Backspace</b>：删除选中框（或在操控模式下删除背景图）</li>
                <li><b>方向键</b>：微移选中的框 1px；<b>Shift + 方向键</b>：按吸附步长移动</li>
                <li><b>撤销 / 重做 / 重置视图</b>：画布右下角的 ↶ ↷ 🎯 按钮</li>
                <li><b>Ctrl + 点击</b>：增减多选框</li>
                <li><b>按住 Alt / Ctrl / Shift</b>：画布顶部显示这一组快捷键提示；每次操作后也会短暂显示结果</li>
                <li><b>框色右侧「提示词预设」</b>：点标签选中（可多选），点「写入」追加到描述；按住 Shift 点「写入」覆盖描述。「方向」的起点 + 终点会拼成一段（从左到右），中间不加逗号；红色标题的类型自动带上「类型名：」前缀，选中后按住 Alt 点标签可切换带不带；自建类型的标题双击改名，单击后点右侧 × 或直接右键标题可删除</li>
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
