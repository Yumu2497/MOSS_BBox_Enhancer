import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// ==========================================
// 1. MOSS_JSON_Importer 的快捷编辑功能
// ==========================================
app.registerExtension({
    name: "Comfy.MOSS_BBox_Manager",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name !== "MOSS_JSON_Importer") return;

        // 🌟 onExecuted：接收 Python 返回的 width/height/background_images
        const onExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (message) {
            const r = onExecuted?.apply(this, arguments);
            console.log("[MOSS Debug] onExecuted message:", message);
            const node = this;

            try {
                const hasW = message && Array.isArray(message.width) && message.width.length;
                const hasH = message && Array.isArray(message.height) && message.height.length;

                const wWidget = node.widgets.find((w) => w.name === "canvas_width");
                const hWidget = node.widgets.find((w) => w.name === "canvas_height");
                if (hasW && wWidget) { 
                    wWidget.value = message.width[0]; 
                    wWidget.callback?.(wWidget.value); 
                }
                if (hasH && hWidget) { 
                    hWidget.value = message.height[0]; 
                    hWidget.callback?.(hWidget.value); 
                }

                const hasBg = message && Array.isArray(message.background_images)
                    && message.background_images.length;
                if (hasBg) {
                    const info = message.background_images[0];
                    if (info && info.filename) {
                        const url = `/view?filename=${encodeURIComponent(info.filename)}`
                            + `&subfolder=${encodeURIComponent(info.subfolder || "")}`
                            + `&type=${encodeURIComponent(info.type || "output")}`;
                        const img = new Image();
                        img.crossOrigin = "anonymous";
                        img.onload = () => {
                            if (node._mossPanelUpdate) {
                                node._mossPanelUpdate({ image: img });
                            } else {
                                node._mossPendingBackground = img;
                            }
                        };
                        img.onerror = () => console.warn("[MOSS] 背景图加载失败:", url);
                        img.src = url;
                    }
                } else if (node._mossPanelUpdate) {
                    // 只更新了尺寸、没有图片时，也要触发一次重绘
                    node._mossPanelUpdate({ image: null });
                }

                if (node.graph) node.graph.setDirtyCanvas(true, true);
            } catch (e) {
                console.error("[MOSS] onExecuted 处理失败:", e);
            }

            return r;
        };

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onNodeCreated
                ? onNodeCreated.apply(this, arguments)
                : undefined;
            const node = this;

            // 🌟 中文化显示名（内部 name 不变，不影响已有工作流和后续 find 逻辑）
            const LABELS = {
                "canvas_width": "画布宽度",
                "canvas_height": "画布高度",
                "use_image_size": "使用背景图并修改尺寸",
                "image": "背景",
            };
            node.widgets?.forEach((w) => {
                if (LABELS[w.name]) w.label = LABELS[w.name];
            });
            // input 端口的 label 要在下一帧才就绪（可能被 ComfyUI 延迟创建）
            setTimeout(() => {
                node.inputs?.forEach((inp) => {
                    if (LABELS[inp.name]) inp.label = LABELS[inp.name];
                });
                if (node.graph) node.graph.setDirtyCanvas(true, true);
            }, 50);

            // 🌟 初始化 token 计数
            node._mossImageLoadToken = 0;

            // 🌟 前端自动读图尺寸（仅对 LoadImage 类上游有效）
            const tryReadImageSize = () => {
                const inputSlot = node.inputs?.find((i) => i.name === "image");
                if (!inputSlot || inputSlot.link == null) return false;
                const link = node.graph?.links?.[inputSlot.link];
                if (!link) return false;
                const upstream = node.graph.getNodeById(link.origin_id);
                if (!upstream?.widgets) return false;

                const imgWidget = upstream.widgets.find(
                    (w) => w.name === "image" && typeof w.value === "string" && w.value.trim()
                );
                if (!imgWidget) return false;

                const m = imgWidget.value.match(/^(.*?)(?:\s*\[(input|output|temp)\])?\s*$/);
                if (!m) return false;
                const filename = m[1].trim();
                if (!filename) return false;
                const type = m[2] || "input";
                const url = `/view?filename=${encodeURIComponent(filename)}&type=${encodeURIComponent(type)}`;

                // 🌟 每次发起加载时，Token +1
                const currentToken = ++node._mossImageLoadToken;

                const img = new Image();
                img.crossOrigin = "anonymous";
                img.onload = () => {
                    // 🌟 检查 Token，如果不一致说明已经被最新的开关操作打断，直接丢弃结果
                    if (node._mossImageLoadToken !== currentToken) return;

                    // 再次确认开关状态，防止加载过程中被关闭
                    const w = node.widgets?.find((x) => x.name === "use_image_size");
                    if (!w || !w.value) return;

                    const wW = node.widgets.find((w) => w.name === "canvas_width");
                    const hW = node.widgets.find((w) => w.name === "canvas_height");

                    // 避免重复赋值触发多余的 callback
                    if (wW && wW.value !== img.naturalWidth) {
                        wW.value = img.naturalWidth; 
                        wW.callback?.(wW.value); 
                    }
                    if (hW && hW.value !== img.naturalHeight) {
                        hW.value = img.naturalHeight; 
                        hW.callback?.(hW.value); 
                    }
                    if (node.graph) node.graph.setDirtyCanvas(true, true);

                    if (node._mossPanelUpdate) {
                        node._mossPanelUpdate({ image: img });
                    } else {
                        node._mossPendingBackground = img;
                    }
                    console.log(`[MOSS] 自动读取背景尺寸: ${img.naturalWidth}x${img.naturalHeight}`);
                };
                img.onerror = () => {
                    if (node._mossImageLoadToken === currentToken) {
                        console.warn(`[MOSS] 读取图片尺寸失败: ${url}`);
                    }
                };
                img.src = url;
                return true;
            };
            node._mossTryReadImageSize = tryReadImageSize;

            // 🌟 统一开关状态：未连接 image 时禁用；断开时自动关闭并清理
            const updateToggleState = () => {
                const w = node.widgets?.find((x) => x.name === "use_image_size");
                if (!w) return;
                const inputSlot = node.inputs?.find((i) => i.name === "image");
                const connected = !!(inputSlot && inputSlot.link != null);

                w.disabled = !connected;

                // 断开连接时取消异步读图、恢复尺寸，并清理自动背景图
                if (!connected) {
                    node._mossImageLoadToken++;
                    if (w.value) w.value = false;

                    const wW = node.widgets.find((x) => x.name === "canvas_width");
                    const hW = node.widgets.find((x) => x.name === "canvas_height");
                    if (node._mossSizeBeforeUseImage) {
                        if (wW) { wW.value = node._mossSizeBeforeUseImage.w; wW.callback?.(wW.value); }
                        if (hW) { hW.value = node._mossSizeBeforeUseImage.h; hW.callback?.(hW.value); }
                        node._mossSizeBeforeUseImage = null;
                    }
                    if (node._mossPanelUpdate) node._mossPanelUpdate({ clear: true });
                    node._mossPendingBackground = null;
                    if (node.graph) node.graph.setDirtyCanvas(true, true);
                }
            };
            node._mossUpdateToggleState = updateToggleState;

            // 🌟 开关切换：开启时保存当前尺寸并尝试读图；关闭时恢复
            const useImageSizeWidget = node.widgets.find((w) => w.name === "use_image_size");
            if (useImageSizeWidget) {
                const origCb = useImageSizeWidget.callback;
                useImageSizeWidget.callback = function () {
                    // 🌟 未连接时拦截，回滚 value 并提示
                    const inputSlot = node.inputs?.find((i) => i.name === "image");
                    const connected = !!(inputSlot && inputSlot.link != null);
                    if (!connected) {
                        useImageSizeWidget.value = !useImageSizeWidget.value; // 回滚
                        if (useImageSizeWidget.value === false && origCb) {
                            // 若原本是开被切到关再回滚，什么都不做
                        }
                        alert("请先连接背景图，再使用「使用背景尺寸」开关");
                        if (node.graph) node.graph.setDirtyCanvas(true, true);
                        return;
                    }

                    if (origCb) origCb.apply(this, arguments);

                    const wW = node.widgets.find((w) => w.name === "canvas_width");
                    const hW = node.widgets.find((w) => w.name === "canvas_height");

                    if (useImageSizeWidget.value) {
                        if (!node._mossSizeBeforeUseImage && wW && hW) {
                            node._mossSizeBeforeUseImage = { w: wW.value, h: hW.value };
                        }
                        tryReadImageSize();
                    } else {
                        // 🌟 关闭时打断尚未完成的异步加载
                        node._mossImageLoadToken++; 
                        
                        if (node._mossSizeBeforeUseImage) {
                            if (wW && wW.value !== node._mossSizeBeforeUseImage.w) {
                                wW.value = node._mossSizeBeforeUseImage.w; 
                                wW.callback?.(wW.value);
                            }
                            if (hW && hW.value !== node._mossSizeBeforeUseImage.h) {
                                hW.value = node._mossSizeBeforeUseImage.h; 
                                hW.callback?.(hW.value);
                            }
                            node._mossSizeBeforeUseImage = null;
                            if (node.graph) node.graph.setDirtyCanvas(true, true);
                        }
                        if (node._mossPanelUpdate) node._mossPanelUpdate({ clear: true });
                        node._mossPendingBackground = null;
                    }
                };
            }

            // 🌟 旧版 LiteGraph 走 mouse 路径：未连接时消费点击事件，直接弹提示
            if (useImageSizeWidget && typeof useImageSizeWidget.mouse === "function") {
                const origMouse = useImageSizeWidget.mouse;
                useImageSizeWidget.mouse = function (event, pos, nodeRef) {
                    const inputSlot = node.inputs?.find((i) => i.name === "image");
                    const connected = !!(inputSlot && inputSlot.link != null);
                    if (!connected) {
                        if (event && (event.type === "pointerdown" || event.type === "mousedown")) {
                            alert("请先连接背景图，再使用「使用背景尺寸」开关");
                        }
                        return true; // 消费事件，阻止 value 被 toggle
                    }
                    return origMouse?.apply(this, arguments);
                };
            }

            setTimeout(updateToggleState, 100);

            // 🌟 首次创建 / 加载工作流时，如果已开启且已连线，延迟尝试一次
            setTimeout(() => {
                if (useImageSizeWidget?.value) {
                    const wW = node.widgets.find((w) => w.name === "canvas_width");
                    const hW = node.widgets.find((w) => w.name === "canvas_height");
                    if (!node._mossSizeBeforeUseImage && wW && hW) {
                        node._mossSizeBeforeUseImage = { w: wW.value, h: hW.value };
                    }
                    tryReadImageSize();
                }
            }, 200);

            const jsonWidget = node.widgets.find((w) => w.name === "layout_json");
            if (!jsonWidget) return r;

            // 面板与 onExecuted 之间的桥
            node._mossPanelUpdate = null;
            node._mossPendingBackground = null;

            node.addWidget("button", "📋 打开边界框管理面板", null, () => {
                createFloatingPanel(node, jsonWidget);
            });
            // 🌟 新增：导入图片提示词按钮
            node.addWidget("button", "📂 导入图片中的提示词JSON", null, () => {
                console.log("[MOSS] 导入按钮被点击");
                
                const fileInput = document.createElement("input");
                fileInput.type = "file";
                fileInput.accept = "image/png, image/jpeg, image/webp";
                // 🌟 修复 1：必须添加到 DOM 中，防止某些浏览器拦截 click
                fileInput.style.display = "none";
                document.body.appendChild(fileInput);
                
                fileInput.onchange = async (e) => {
                    const file = e.target.files[0];
                    // 清理 DOM
                    document.body.removeChild(fileInput);
                    if (!file) return;
                    
                    console.log("[MOSS] 选择了文件:", file.name);
                    
                    const formData = new FormData();
                    formData.append("image", file);
                    
                    try {
                        console.log("[MOSS] 发送请求到 /moss/extract_prompt...");
                        const resp = await api.fetchApi("/moss/extract_prompt", {
                            method: "POST",
                            body: formData
                        });
                        
                        // 检查 HTTP 状态
                        if (!resp.ok) {
                            throw new Error(`HTTP error! status: ${resp.status}`);
                        }
                        
                        const data = await resp.json();
                        console.log("[MOSS] 后端返回数据:", data);
                        
                        if (data.success) {
                            const flows = data.flows;
                            let targetFlow = flows[0];
                            
                            // 🌟 多流程选择
                            if (flows.length > 1) {
                                let optionsText = flows.map((f, i) => {
                                    let desc = "";
                                    if (f.moss_jsons.length > 0) desc = `包含自制节点 (尺寸: ${f.moss_jsons[0].w}x${f.moss_jsons[0].h})`;
                                    else if (f.official_boxes.length > 0) desc = `包含官方画框 (尺寸: ${f.official_boxes[0].w}x${f.official_boxes[0].h}, ${f.official_boxes[0].boxes.length}个框)`;
                                    else desc = `纯文本提示词 (${f.texts.length} 段)`;
                                    return `${i + 1}. 采样器 ID:${f.samplerId} - ${desc}`;
                                }).join('\n');
                                
                                const choice = prompt(`检测到 ${flows.length} 个独立的生成流程，请选择要导入的序号：\n\n${optionsText}`, "1");
                                if (choice === null) return;
                                
                                const idx = parseInt(choice) - 1;
                                if (idx >= 0 && idx < flows.length) {
                                    targetFlow = flows[idx];
                                } else {
                                    alert("输入无效，取消导入。");
                                    return;
                                }
                            }

                            // 🌟 提取或组装数据
                            if (targetFlow.moss_jsons.length > 0) {
                                const moss = targetFlow.moss_jsons[0];
                                jsonWidget.value = moss.json;
                                if (jsonWidget.callback) jsonWidget.callback(jsonWidget.value);
                                
                                const wWidget = node.widgets.find((w) => w.name === "canvas_width");
                                const hWidget = node.widgets.find((w) => w.name === "canvas_height");
                                if (wWidget) { wWidget.value = moss.w; wWidget.callback?.(wWidget.value); }
                                if (hWidget) { hWidget.value = moss.h; hWidget.callback?.(hWidget.value); }

                                alert(`✅ 成功导入 MOSS JSON！\n尺寸: ${moss.w} x ${moss.h}`);
                            } 
                            else if (targetFlow.official_boxes.length > 0) {
                                const boxData = targetFlow.official_boxes[0];
                                const W = boxData.w, H = boxData.h;
                                const halfW = W / 2, halfH = H / 2;
                                
                                const items = boxData.boxes.map(box => {
                                    const item = {
                                        label: box.metadata?.type === "text" ? "text" : "object",
                                        caption: box.metadata?.desc || "",
                                        bbox: [
                                            box.y - halfH, 
                                            box.x - halfW, 
                                            box.y - halfH + box.height, 
                                            box.x - halfW + box.width
                                        ]
                                    };
                                    if (box.metadata?.text) item.text = box.metadata.text;
                                    if (box.metadata?.palette && box.metadata.palette.length > 0) item.palette = box.metadata.palette;
                                    return item;
                                });
                                
                                const finalJson = {
                                    summary: { caption: targetFlow.texts.length > 0 ? targetFlow.texts[0] : "" },
                                    items: items,
                                    bbox_coord_space: "abs_centralized",
                                    bbox_format: "yxyx"
                                };

                                jsonWidget.value = JSON.stringify(finalJson, null, 2);
                                if (jsonWidget.callback) jsonWidget.callback(jsonWidget.value);

                                const wWidget = node.widgets.find((w) => w.name === "canvas_width");
                                const hWidget = node.widgets.find((w) => w.name === "canvas_height");
                                if (wWidget) { wWidget.value = W; wWidget.callback?.(wWidget.value); }
                                if (hWidget) { hWidget.value = H; hWidget.callback?.(hWidget.value); }

                                alert(`✅ 已将官方边界框转换为 MOSS JSON 并导入！\n尺寸: ${W} x ${H}`);
                            } 
                            else if (targetFlow.texts.length > 0) {
                                const allTexts = targetFlow.texts.join('\n\n');
                                jsonWidget.value = JSON.stringify({
                                    summary: { caption: allTexts },
                                    items: [],
                                    bbox_coord_space: "abs_centralized",
                                    bbox_format: "yxyx"
                                }, null, 2);
                                if (jsonWidget.callback) jsonWidget.callback(jsonWidget.value);
                                
                                alert(`✅ 未找到边界框数据，但已为您提取并填入纯文本提示词。`);
                            }
                            
                        } else {
                            alert("❌ " + data.error);
                        }
                    } catch (err) {
                        console.error("[MOSS] 请求解析图片失败:", err);
                        alert("请求后端失败，请查看 F12 控制台！\n" + err.message);
                    }
                };
                
                // 🌟 修复 2：触发点击
                console.log("[MOSS] 触发 fileInput.click()");
                fileInput.click();
            });

            const onRemoved = this.onRemoved;
            this.onRemoved = function () {
                const panel = document.getElementById(`moss-bbox-panel-${node.id}`);
                if (panel) panel.remove();
                node._mossPanelUpdate = null;
                node._mossPendingBackground = null;
                return onRemoved?.apply(this, arguments);
            };

            return r;
        };

        const onConnectionsChange = nodeType.prototype.onConnectionsChange;
        nodeType.prototype.onConnectionsChange = function (type, slotIndex, isConnected) {
            const r = onConnectionsChange?.apply(this, arguments);
            // type === 1 表示 INPUT（LiteGraph.INPUT）
            if (type === 1) {
                const slot = this.inputs?.[slotIndex];
                this._mossUpdateToggleState?.();
                if (isConnected && slot?.name === "image") {
                    const w = this.widgets?.find((x) => x.name === "use_image_size");
                    if (w?.value) setTimeout(() => this._mossTryReadImageSize?.(), 100);
                }
            }
            return r;
        };
    },
});

function createFloatingPanel(node, jsonWidget) {
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
        if (bgUploadInput) bgUploadInput.value = ""; 
        drawCanvas();
    }

    // 🌟 将图片对象套用为背景图
    function applyBackgroundImage(img, source = "manual") {
        bgImage = img;
        bgSource = source;

        let w, h;
        try {
            ({ w, h } = getCanvasSize());
        } catch (_) {
            w = node.widgets?.find((x) => x.name === "canvas_width")?.value || 1024;
            h = node.widgets?.find((x) => x.name === "canvas_height")?.value || 1024;
        }

        const scale = Math.max(w / img.width, h / img.height);
        bgW = img.width * scale;
        bgH = img.height * scale;
        bgX = 0;
        bgY = 0;
        bgInitialState = { x: bgX, y: bgY, w: bgW, h: bgH };
        if (bgActiveCb) bgActiveCb.disabled = false;
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
        jsonWidget.value = JSON.stringify(finalJsonObj, null, 2);
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
    closeBtn.onclick = () => (panel.style.display = "none");
    
    header.appendChild(titleLeft);
    header.appendChild(closeBtn);
    panel.appendChild(header);

    const contentContainer = document.createElement("div");
    contentContainer.style.cssText =
        "display: flex; flex-direction: row; flex: 1; overflow: hidden;";

    // 左侧容器：包含画布和编辑面板
    const leftContainer = document.createElement("div");
    leftContainer.style.cssText =
        "flex: 1; position: relative; display: flex; flex-direction: column; border-right: 1px solid #333; overflow: hidden;";

    const canvasContainer = document.createElement("div");
    canvasContainer.style.cssText =
        "flex: 1; position: relative; display: flex; align-items: center; justify-content: center; background: #111; overflow: hidden;";

        const canvas = document.createElement("canvas");
    canvas.style.cssText =
        "width: 100%; height: 100%; display: block; cursor: crosshair;";
    canvas.tabIndex = 0;
    canvasContainer.appendChild(canvas);

    // ================= 新增：画布主提示词悬浮窗 =================
    const promptWrapper = document.createElement("div");
    promptWrapper.style.cssText = "position: absolute; top: 12px; right: 12px; width: 260px; background: rgba(30, 30, 30, 0.85); backdrop-filter: blur(8px); border: 1px solid #444; border-radius: 6px; display: flex; flex-direction: column; z-index: 20; box-shadow: 0 4px 12px rgba(0,0,0,0.5); transition: width 0.2s;";
    
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
    canvasContainer.appendChild(promptWrapper);
    // ==========================================================
    
    leftContainer.appendChild(canvasContainer);

    // 画布下方的动态编辑面板
    const editorContainer = document.createElement("div");
    // 改为绝对定位，悬浮在画布底部
    editorContainer.style.cssText =
        "position: absolute; bottom: 0; left: 0; width: 100%; box-sizing: border-box; display: none; flex-direction: column; padding: 10px 12px; background: rgba(30, 30, 30, 0.95); backdrop-filter: blur(10px); border-top: 1px solid #444; z-index: 10; max-height: 250px; overflow-y: auto;";

    // 类型 Tab 切换
    const tabContainer = document.createElement("div");
    tabContainer.style.cssText =
        "display: flex; gap: 2px; margin-bottom: 10px; background: #111; padding: 2px; border-radius: 6px;";
    const objBtn = document.createElement("button");
    objBtn.textContent = "对象";
    const textBtn = document.createElement("button");
    textBtn.textContent = "文字";
    [objBtn, textBtn].forEach((btn) => {
        btn.style.cssText =
            "flex: 1; padding: 6px 0; border: none; border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: bold; transition: 0.2s;";
    });
    tabContainer.appendChild(objBtn);
    tabContainer.appendChild(textBtn);
    editorContainer.appendChild(tabContainer);

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

    // 真正的颜色选择器，平时隐藏
    const hiddenColorPicker = document.createElement("input");
    hiddenColorPicker.type = "color";
    hiddenColorPicker.style.cssText =
        "position: absolute; opacity: 0; width: 0; height: 0; pointer-events: none;";
    editorContainer.appendChild(hiddenColorPicker);

    const paletteContainer = document.createElement("div");
    paletteContainer.style.cssText =
        "display: flex; flex-wrap: wrap; gap: 6px; align-items: center;";

    const addColorBtn = document.createElement("button");
    addColorBtn.textContent = "+";
    addColorBtn.style.cssText =
        "width: 24px; height: 24px; background: #333; border: 1px solid #555; border-radius: 4px; color: #ccc; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 16px; padding: 0;";

    paletteContainer.appendChild(addColorBtn);
    editorContainer.appendChild(colorLabel);
    editorContainer.appendChild(paletteContainer);

    leftContainer.appendChild(editorContainer);
    contentContainer.appendChild(leftContainer);

    const rightContainer = document.createElement("div");
    rightContainer.style.cssText =
        "flex: 0 0 280px; display: flex; flex-direction: column; background: #1e1e1e;";


    const toolbar = document.createElement("div");
    // 🌟 改为纵向排列，分成两行
    toolbar.style.cssText =
        "display: flex; flex-direction: column; gap: 8px; padding: 10px; border-bottom: 1px solid #333; flex-shrink: 0;";

    // --- 第一行：视图与辅助工具 ---
    const topRow = document.createElement("div");
    topRow.style.cssText = "display: flex; justify-content: space-between; align-items: center; gap: 6px;";

    const resetBtn = document.createElement("button");
    resetBtn.textContent = "🎯 重置";
    resetBtn.title = "重置视图 (缩放与位置)";
    // 使用 flex:1 让三个控件平分宽度
    resetBtn.style.cssText =
        "flex: 1; background: #333; color: #ccc; border: 1px solid #555; padding: 6px 0; border-radius: 4px; cursor: pointer; font-size: 12px; text-align: center;";
    resetBtn.onclick = () => {
        viewScale = 1.0;
        viewX = 0;
        viewY = 0;
        drawCanvas();
    };

    const selectAllLabel = document.createElement("label");
    selectAllLabel.style.cssText =
        "flex: 1; display: flex; align-items: center; justify-content: center; cursor: pointer; gap: 4px; font-size: 12px; background: #2a2a2a; border: 1px solid #444; border-radius: 4px; padding: 5px 0;";
    const selectAllCb = document.createElement("input");
    selectAllCb.type = "checkbox";
    selectAllCb.style.cssText =
        "cursor: pointer; accent-color: #4a9eff; margin: 0;";
    selectAllLabel.appendChild(selectAllCb);
    selectAllLabel.appendChild(document.createTextNode("全选"));

    // 找到原来的 snapLabel 部分，整体替换为：
    const snapWrapper = document.createElement("div");
    snapWrapper.style.cssText =
        "flex: 1.5; display: flex; align-items: center; justify-content: center; gap: 6px; font-size: 12px; color: #aaa; background: #2a2a2a; border: 1px solid #444; border-radius: 4px; padding: 3px 6px;";

    const snapCb = document.createElement("input");
    snapCb.type = "checkbox";
    snapCb.checked = false;
    snapCb.style.cssText = "cursor: pointer; accent-color: #4a9eff; margin: 0;";
    
    const snapText = document.createElement("span");
    snapText.textContent = "吸附";

    const gridSizeSelect = document.createElement("select");
    gridSizeSelect.style.cssText = "background: #111; color: #eee; border: 1px solid #444; border-radius: 4px; padding: 0 2px; outline: none; cursor: pointer; font-size: 11px;";
    [16, 32].forEach(sz => {
        const opt = document.createElement("option");
        opt.value = sz;
        opt.textContent = sz;
        gridSizeSelect.appendChild(opt);
    });
    gridSizeSelect.onchange = () => {
        GRID_SNAP = parseInt(gridSizeSelect.value);
        drawCanvas(); // 立刻重绘画布，更新网格线
    };

    snapWrapper.appendChild(snapCb);
    snapWrapper.appendChild(snapText);
    snapWrapper.appendChild(gridSizeSelect);

    // 最后把 snapWrapper 塞入顶部的 topRow 中
    topRow.appendChild(resetBtn);
    topRow.appendChild(selectAllLabel);
    topRow.appendChild(snapWrapper);
    toolbar.appendChild(topRow);

    // --- 第二行：增删操作 ---
    const bottomRow = document.createElement("div");
    bottomRow.style.cssText = "display: flex; gap: 8px;";

    const addBtn = document.createElement("button");
    addBtn.textContent = "➕ 添加";
    addBtn.title = "新建一个边界框";
    addBtn.style.cssText =
        "flex: 1; background: #2e7d32; color: white; border: none; padding: 6px 0; border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: bold;";
        
    const deleteBtn = document.createElement("button");
    deleteBtn.textContent = "🗑 删除";
    deleteBtn.title = "删除选中的边界框";
    deleteBtn.style.cssText =
        "flex: 1; background: #d32f2f; color: white; border: none; padding: 6px 0; border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: bold;";

    bottomRow.appendChild(addBtn);
    bottomRow.appendChild(deleteBtn);
    toolbar.appendChild(bottomRow);

    rightContainer.appendChild(toolbar);

    // ================= 极小框控制面板 =================
    const smallBoxPanel = document.createElement("div");
    smallBoxPanel.style.cssText = "margin: 10px; padding: 10px; border: 1px solid #444; border-radius: 6px; display: flex; flex-direction: column; gap: 8px; background: #1a1a1a;";
    
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
    rightContainer.appendChild(smallBoxPanel);
    
    alignSelect.onchange = () => {
        if (activeIndex === -1) return;
        const item = currentItems[activeIndex];
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
        if (activeIndex === -1) {
            enableSmallCb.checked = false;
            return alert("请先在画布上选中一个框！");
        }
        const item = currentItems[activeIndex];
        const oldBounds = getVisualBounds(item);
        
        let size = enableSmallCb.checked ? (parseInt(sizeInput.value) || 8) : 16;
        size = Math.max(1, Math.min(enableSmallCb.checked ? 15 : 16, size));
        
        const finalXmin = Math.round((oldBounds.vXmin + oldBounds.vXmax) / 2 - size / 2);
        const finalYmin = Math.round((oldBounds.vYmin + oldBounds.vYmax) / 2 - size / 2);
        
        item.bbox = [finalYmin, finalXmin, finalYmin + size, finalXmin + size];
        if (!enableSmallCb.checked) item._align = "center";
        
        saveEditorChanges();
        renderList(false);
        drawCanvas();
    };

    sizeInput.onchange = () => {
        if (activeIndex === -1 || !enableSmallCb.checked) return;
        const item = currentItems[activeIndex];
        const oldBounds = getVisualBounds(item);
        
        let size = parseInt(sizeInput.value) || 8;
        size = Math.max(1, Math.min(15, size));
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
    bgPanel.style.cssText = "margin: 10px; padding: 10px; border: 1px solid #444; border-radius: 6px; display: flex; flex-direction: column; gap: 8px; background: #1a1a1a;";
    
    // 添加区域标题
    const bgTitle = document.createElement("div");
    bgTitle.textContent = "🖼️ 背景图设置";
    bgTitle.style.cssText = "font-size: 12px; font-weight: bold; color: #aaa; border-bottom: 1px solid #333; padding-bottom: 4px; margin-bottom: 2px;";
    bgPanel.appendChild(bgTitle);

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
    bgPanel.appendChild(bgUploadRow);

    // 🌟 新增：画布模式选择行
    const canvasModeRow = document.createElement("div");
    canvasModeRow.style.cssText = "display: flex; align-items: center; gap: 6px; font-size: 12px; margin-top: 4px;";
    
    const canvasModeLabel = document.createElement("span");
    canvasModeLabel.textContent = "画布模式";
    canvasModeLabel.style.color = "#aaa";
    canvasModeLabel.style.whiteSpace = "nowrap";

    const canvasModeSelect = document.createElement("select");
    canvasModeSelect.style.cssText = "flex: 1; background: #111; color: #eee; border: 1px solid #444; border-radius: 4px; padding: 4px 6px; outline: none; cursor: pointer; font-size: 12px;";
    
    const options = [
        { value: "", label: "默认 (不设置)" },
        { value: "single", label: "单图" },
        { value: "multi_panel", label: "多面板/分镜" },
        { value: "collage", label: "拼贴" }
    ];
    options.forEach(opt => {
        const o = document.createElement("option");
        o.value = opt.value;
        o.textContent = opt.label;
        canvasModeSelect.appendChild(o);
    });

    canvasModeRow.appendChild(canvasModeLabel);
    canvasModeRow.appendChild(canvasModeSelect);
    bgPanel.appendChild(canvasModeRow);

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
    bgPanel.appendChild(bgControlRow);

    const bgActionRow = document.createElement("div");
    bgActionRow.style.cssText = "display: flex; align-items: center; justify-content: space-between; margin-top: 2px;";
    
    const bgActiveLabel = document.createElement("label");
    bgActiveLabel.style.cssText = "display: flex; align-items: center; gap: 4px; color: #ccc; font-size: 12px; cursor: pointer;";
    const bgActiveCb = document.createElement("input");
    bgActiveCb.type = "checkbox";
    bgActiveCb.disabled = true;
    bgActiveCb.style.cssText = "accent-color: #4a9eff; margin: 0;";
    bgActiveCb.onchange = () => { bgActive = bgActiveCb.checked; };
    bgActiveLabel.appendChild(bgActiveCb);
    bgActiveLabel.appendChild(document.createTextNode("操控"));

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

    bgActionRow.appendChild(bgActiveLabel);
    bgActionRow.appendChild(bgBtnGroup);
    bgPanel.appendChild(bgActionRow);
    rightContainer.appendChild(bgPanel);

    const listArea = document.createElement("div");
    listArea.style.cssText =
        "display: flex; flex-direction: column; gap: 4px; padding: 10px; overflow-y: auto; flex: 1;";
    rightContainer.appendChild(listArea);

    contentContainer.appendChild(rightContainer);
    panel.appendChild(contentContainer);
    document.body.appendChild(panel);

    // --- 拖拽面板逻辑 ---
    // --- 拖拽面板逻辑 ---
    let isDraggingPanel = false,
        panelStartX,
        panelStartY,
        panelStartLeft,
        panelStartTop;

    header.addEventListener("pointerdown", (e) => {
        if (e.target === closeBtn || e.target === helpBtn) return;

        isDraggingPanel = true;
        panelStartX = e.clientX;
        panelStartY = e.clientY;
        const rect = panel.getBoundingClientRect();
        panelStartLeft = rect.left;
        panelStartTop = rect.top;
        panel.style.transform = "none";
        panel.style.left = panelStartLeft + "px";
        panel.style.top = panelStartTop + "px";

        // 核心修复：锁定指针，确保鼠标移出面板依然能收到松开事件
        header.setPointerCapture(e.pointerId);
        e.preventDefault();
    });

    header.addEventListener("pointermove", (e) => {
        if (!isDraggingPanel) return;
        panel.style.left = panelStartLeft + e.clientX - panelStartX + "px";
        panel.style.top = panelStartTop + e.clientY - panelStartY + "px";
    });

    header.addEventListener("pointerup", (e) => {
        isDraggingPanel = false;
        header.releasePointerCapture(e.pointerId);
    });

    // --- 核心状态与变量 ---
    let isUpdatingFromUI = false;
    let currentItems = [];
    let activeIndex = -1;
    let selectedIndices = new Set();

    let dragMode = null;
    let dragStartMouse = { x: 0, y: 0 };
    let dragStartBBox = [0, 0, 0, 0];
    let labelCache = [];

    // 视口状态
    let viewScale = 1.0;
    let viewX = 0;
    let viewY = 0;
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

    const getActualScale = () => getBaseScale() * viewScale;

    const physToLogic = (px, py) => {
        const scale = getActualScale();
        const rect = canvasContainer.getBoundingClientRect();
        const centerX = rect.width / 2;
        const centerY = rect.height / 2;
        return {
            x: (px - centerX - viewX) / scale,
            y: (py - centerY - viewY) / scale,
        };
    };

    const logicToPhys = (lx, ly) => {
        const scale = getActualScale();
        const rect = canvasContainer.getBoundingClientRect();
        const centerX = rect.width / 2;
        const centerY = rect.height / 2;
        return { x: centerX + viewX + lx * scale, y: centerY + viewY + ly * scale };
    };

    const applySnap = (val, isAltPressed, isX) => {
        if (snapCb.checked !== isAltPressed) {
            const { w, h } = getCanvasSize();
            const offset = isX ? w / 2 : h / 2;
            // 核心逻辑：以左上角为基准画网格线
            return Math.round((val + offset) / GRID_SNAP) * GRID_SNAP - offset;
        }
        return Math.round(val);
    };

    const isOverlapping = (r1, r2) => {
        return !(
            r1.x + r1.w < r2.x ||
            r1.x > r2.x + r2.w ||
            r1.y + r1.h < r2.y ||
            r1.y > r2.y + r2.h
        );
    };

    // --- 编辑面板逻辑 ---
    const saveEditorChanges = () => {
        if (activeIndex === -1 || !currentItems[activeIndex]) return;

        currentItems.forEach(item => { if ("_isNew" in item) delete item._isNew; });

        const data = Array.isArray(JSON.parse(jsonWidget.value))
            ? currentItems
            : { ...JSON.parse(jsonWidget.value), items: currentItems };

        isUpdatingFromUI = true;
        jsonWidget.value = JSON.stringify(data, null, 2);
        if (jsonWidget.callback) jsonWidget.callback(jsonWidget.value);
        isUpdatingFromUI = false;

        // 实时更新右侧列表的文本显示（不整体重建列表，防止失去焦点）
        const cbs = listArea.querySelectorAll("input[type='checkbox']");
        const row = cbs[activeIndex]?.parentElement;
        if (row) {
            const span = row.querySelector("span");
            const item = currentItems[activeIndex];
            const text =
                item.caption || item.desc || `未命名 (${item.label || "object"})`;
            if (span)
                span.textContent = `${activeIndex + 1}. ${text.length > 15 ? text.substring(0, 15) + "..." : text}`;
        }

        drawCanvas();
        if (node.graph) node.graph.setDirtyCanvas(true, true);
    };

    const syncEditorPanel = () => {
        if (activeIndex === -1 || !currentItems[activeIndex]) {
            editorContainer.style.display = "none";
            return;
        }
        editorContainer.style.display = "flex";
        const item = currentItems[activeIndex];
        const isText = item.label === "text";

        // 🌟 同步极小框 UI
        const { isExtreme } = getVisualBounds(item);
        enableSmallCb.checked = isExtreme;
        sizeInput.disabled = !isExtreme;
        alignSelect.disabled = !isExtreme;
        if (isExtreme) {
            sizeInput.value = item.bbox[3] - item.bbox[1];
            alignSelect.value = item._align || "center";
        }

        // 更新 Tab 状态
        objBtn.style.background = isText ? "transparent" : "#444";
        objBtn.style.color = isText ? "#888" : "#fff";
        textBtn.style.background = isText ? "#444" : "transparent";
        textBtn.style.color = isText ? "#fff" : "#888";

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

        // 更新颜色 (动态生成多色块)
        while (paletteContainer.children.length > 1) {
            paletteContainer.removeChild(paletteContainer.lastChild);
        }

        const palette =
            item.palette && Array.isArray(item.palette) ? item.palette : [];

        palette.forEach((color, colorIdx) => {
            const swatch = document.createElement("div");
            swatch.style.cssText = `width: 24px; height: 24px; border-radius: 4px; cursor: pointer; border: 1px solid #555; position: relative; background-color: ${color};`;

            // 点击色块修改颜色
            swatch.onclick = (e) => {
                e.stopPropagation();
                hiddenColorPicker.value = color || "#ffffff";
                hiddenColorPicker.onchange = () => {
                    currentItems[activeIndex].palette[colorIdx] = hiddenColorPicker.value;
                    syncEditorPanel();
                    saveEditorChanges();
                };
                hiddenColorPicker.click();
            };

            // 双击色块删除
            swatch.ondblclick = (e) => {
                e.stopPropagation();
                currentItems[activeIndex].palette.splice(colorIdx, 1);
                syncEditorPanel();
                saveEditorChanges();
            };
            swatch.title = "单击修改颜色，双击删除";

            paletteContainer.appendChild(swatch);
        });
    };

    objBtn.onclick = () => {
        if (activeIndex === -1) return;
        currentItems[activeIndex].label = "object";
        syncEditorPanel();
        saveEditorChanges();
    };

    textBtn.onclick = () => {
        if (activeIndex === -1) return;
        currentItems[activeIndex].label = "text";
        if (!currentItems[activeIndex].text) currentItems[activeIndex].text = "";
        syncEditorPanel();
        saveEditorChanges();
    };

    descArea.addEventListener("input", () => {
        if (activeIndex === -1) return;
        currentItems[activeIndex].caption = descArea.value;
        saveEditorChanges();
    });

    textArea.addEventListener("input", () => {
        if (activeIndex === -1) return;
        currentItems[activeIndex].text = textArea.value;
        saveEditorChanges();
    });

    addColorBtn.onclick = () => {
        if (activeIndex === -1) return;
        if (!currentItems[activeIndex].palette) {
            currentItems[activeIndex].palette = [];
        }
        // 默认添加一个随机颜色或白色
        currentItems[activeIndex].palette.push("#FFFFFF");
        syncEditorPanel();
        saveEditorChanges();
    };

    // 🌟 获取视觉上的 16x16 范围
    const getVisualBounds = (item) => {
        const [ymin, xmin, ymax, xmax] = item.bbox;
        const realW = xmax - xmin;
        const realH = ymax - ymin;
        if (realW >= 16 && realH >= 16) {
            return { vXmin: xmin, vYmin: ymin, vXmax: xmax, vYmax: ymax, isExtreme: false };
        }

        // 极小框
        const align = item._align || "center";
        let vXmin = xmin, vYmin = ymin, vXmax = xmin + 16, vYmax = ymin + 16;

        if (align === "center") {
            const cx = (xmin + xmax) / 2;
            const cy = (ymin + ymax) / 2;
            vXmin = cx - 8; vXmax = cx + 8;
            vYmin = cy - 8; vYmax = cy + 8;
        } else if (align === "tl") {
            vXmin = xmin; vYmin = ymin; vXmax = xmin + 16; vYmax = ymin + 16;
        } else if (align === "tr") {
            vXmin = xmax - 16; vYmin = ymin; vXmax = xmax; vYmax = ymin + 16;
        } else if (align === "bl") {
            vXmin = xmin; vYmin = ymax - 16; vXmax = xmin + 16; vYmax = ymax;
        } else if (align === "br") {
            vXmin = xmax - 16; vYmin = ymax - 16; vXmax = xmax; vYmax = ymax;
        }

        return { vXmin, vYmin, vXmax, vYmax, isExtreme: true };
    };

    // 🌟 将视觉范围反向映射回真实数据
    const applyVisualBounds = (item, vXmin, vYmin) => {
        const [ymin, xmin, ymax, xmax] = item.bbox;
        const realW = xmax - xmin;
        const realH = ymax - ymin;
        if (realW >= 16 && realH >= 16) return; // 只有极小框需要反向映射

        const align = item._align || "center";
        let newXmin = xmin, newYmin = ymin, newXmax = xmax, newYmax = ymax;

        if (align === "center") {
            const cx = vXmin + 8;
            const cy = vYmin + 8;
            newXmin = cx - realW / 2; newXmax = cx + realW / 2;
            newYmin = cy - realH / 2; newYmax = cy + realH / 2;
        } else if (align === "tl") {
            newXmin = vXmin; newYmin = vYmin; newXmax = vXmin + realW; newYmax = vYmin + realH;
        } else if (align === "tr") {
            newXmin = vXmin + 16 - realW; newYmin = vYmin; newXmax = vXmin + 16; newYmax = vYmin + realH;
        } else if (align === "bl") {
            newXmin = vXmin; newYmin = vYmin + 16 - realH; newXmax = vXmin + realW; newYmax = vYmin + 16;
        } else if (align === "br") {
            newXmin = vXmin + 16 - realW; newYmin = vYmin + 16 - realH; newXmax = vXmin + 16; newYmax = vYmin + 16;
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

        // 🌟 渲染背景图
        if (bgImage) {
            ctx.save();
            // 剪裁到画布范围内
            ctx.beginPath();
            ctx.rect(p1.x, p1.y, canvasW_phys, canvasH_phys);
            ctx.clip();

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
            ctx.strokeStyle = snapCb.checked
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

        currentItems.forEach((item, index) => {
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

            const isSelected = selectedIndices.has(index);
            const isActive = index === activeIndex;
            // 边框颜色只和选中状态有关，不再被调色板覆盖
            const itemColor = isActive ? "#4a9eff" : "#ccc";

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
            const lx = (mouseX - centerX - viewX) / oldScale;
            const ly = (mouseY - centerY - viewY) / oldScale;

            const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
            viewScale *= zoomFactor;
            viewScale = Math.max(0.1, Math.min(10, viewScale));

            const newScale = getActualScale();
            viewX = mouseX - centerX - lx * newScale;
            viewY = mouseY - centerY - ly * newScale;

            drawCanvas();
        },
        { passive: false },
    );

    canvas.addEventListener("mousedown", (e) => {
        canvas.focus();
        const rect = canvasContainer.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        if (e.button === 1) {
            isPanning = true;
            panStartX = mouseX;
            panStartY = mouseY;
            panStartViewX = viewX;
            panStartViewY = viewY;
            canvas.style.cursor = "grabbing";
            e.preventDefault();
            return;
        }

        if (e.button !== 0) return;

        // 🌟 背景图操控拦截
        if (bgActive && bgImage) {
            const bp1 = logicToPhys(bgX - bgW / 2, bgY - bgH / 2);
            const bp2 = logicToPhys(bgX + bgW / 2, bgY + bgH / 2);
            const handleDist = 15;

            const nearTL = Math.abs(mouseX - bp1.x) < handleDist && Math.abs(mouseY - bp1.y) < handleDist;
            const nearTR = Math.abs(mouseX - bp2.x) < handleDist && Math.abs(mouseY - bp1.y) < handleDist;
            const nearBL = Math.abs(mouseX - bp1.x) < handleDist && Math.abs(mouseY - bp2.y) < handleDist;
            const nearBR = Math.abs(mouseX - bp2.x) < handleDist && Math.abs(mouseY - bp2.y) < handleDist;

            const nearT = !nearTL && !nearTR && mouseY > bp1.y - handleDist && mouseY < bp1.y + handleDist && mouseX > bp1.x && mouseX < bp2.x;
            const nearB = !nearBL && !nearBR && mouseY > bp2.y - handleDist && mouseY < bp2.y + handleDist && mouseX > bp1.x && mouseX < bp2.x;
            const nearL = !nearTL && !nearBL && mouseX > bp1.x - handleDist && mouseX < bp1.x + handleDist && mouseY > bp1.y && mouseY < bp2.y;
            const nearR = !nearTR && !nearBR && mouseX > bp2.x - handleDist && mouseX < bp2.x + handleDist && mouseY > bp1.y && mouseY < bp2.y;

            let hitMode = null;
            if (nearTL) hitMode = "tl"; else if (nearTR) hitMode = "tr";
            else if (nearBL) hitMode = "bl"; else if (nearBR) hitMode = "br";
            else if (nearT) hitMode = "t"; else if (nearB) hitMode = "b";
            else if (nearL) hitMode = "l"; else if (nearR) hitMode = "r";
            else if (mouseX > bp1.x && mouseX < bp2.x && mouseY > bp1.y && mouseY < bp2.y) hitMode = "move";

            if (hitMode) {
                bgDragMode = hitMode;
                bgStartMouse = { x: mouseX, y: mouseY };
                bgStartBBox = { x: bgX, y: bgY, w: bgW, h: bgH };
                e.preventDefault();
                return; // 阻断后续的 bbox 逻辑
            }
        }

        const hit = getHitInfo(mouseX, mouseY);
        const isCtrl = e.ctrlKey || e.metaKey;

        if (hit.type === "select-label") {
            const targetIdx = hit.index;
            const item = currentItems[targetIdx];

            // 1. 处理选中逻辑
            if (isCtrl) {
                if (selectedIndices.has(targetIdx)) selectedIndices.delete(targetIdx);
                else selectedIndices.add(targetIdx);
                activeIndex = targetIdx;
            } else {
                if (!selectedIndices.has(targetIdx)) {
                    selectedIndices.clear();
                    selectedIndices.add(targetIdx);
                }
                activeIndex = targetIdx;
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
            if (!isCtrl) selectedIndices.clear();

            const { w, h } = getCanvasSize(); // 🌟 补上缺失的宽高获取
            const limitX = w / 2;
            const limitY = h / 2;

            const logicPos = physToLogic(mouseX, mouseY);
            let snapX = applySnap(logicPos.x, e.altKey, true);
            let snapY = applySnap(logicPos.y, e.altKey, false);

            snapX = Math.max(-limitX, Math.min(snapX, limitX));
            snapY = Math.max(-limitY, Math.min(snapY, limitY));

            currentItems.push({
                label: "object",
                caption: "新对象",
                bbox: [snapY, snapX, snapY, snapX],
            });
            activeIndex = currentItems.length - 1;
            selectedIndices.add(activeIndex);

            dragMode = "resize-br";
            dragStartMouse = { x: mouseX, y: mouseY };
            dragStartBBox = [...currentItems[activeIndex].bbox];

            editorContainer.style.display = "none";
        } else {
            const targetIdx = hit.index;
            if (isCtrl) {
                if (selectedIndices.has(targetIdx)) selectedIndices.delete(targetIdx);
                else selectedIndices.add(targetIdx);
                activeIndex = targetIdx;
            } else {
                if (!selectedIndices.has(targetIdx)) {
                    selectedIndices.clear();
                    selectedIndices.add(targetIdx);
                }
                activeIndex = targetIdx;
            }

            dragMode = hit.type;
            dragStartMouse = { x: mouseX, y: mouseY };
            dragStartBBox = [...currentItems[targetIdx].bbox];
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
            viewX = panStartViewX + (mouseX - panStartX);
            viewY = panStartViewY + (mouseY - panStartY);
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
            } else {
                const aspectRatio = bgStartBBox.w / bgStartBBox.h;

                if (bgDragMode.includes("l")) { nx += dx; nw -= dx; }
                if (bgDragMode.includes("r")) { nw += dx; }
                if (bgDragMode.includes("t")) { ny += dy; nh -= dy; }
                if (bgDragMode.includes("b")) { nh += dy; }

                // 如果带有角标（tl, tr, bl, br），保持长宽比
                if (bgDragMode.length === 2) {
                    if (bgDragMode.includes("l")) {
                        nh = nw / aspectRatio;
                        if (bgDragMode.includes("t")) ny = bgStartBBox.y + bgStartBBox.h - nh;
                    } else {
                        nh = nw / aspectRatio;
                        if (bgDragMode.includes("t")) ny = bgStartBBox.y + bgStartBBox.h - nh;
                    }
                }
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
            const tempItem = { bbox: dragStartBBox, _align: currentItems[activeIndex]._align };
            const { isExtreme, vXmin, vYmin, vXmax, vYmax } = getVisualBounds(tempItem);
            
            if (isExtreme) {
                let newVx = vXmin + logicDx;
                let newVy = vYmin + logicDy;

                newVx = applySnap(newVx, e.altKey, true);
                newVy = applySnap(newVy, e.altKey, false);

                newVx = Math.max(-limitX, Math.min(newVx, limitX - 16));
                newVy = Math.max(-limitY, Math.min(newVy, limitY - 16));

                applyVisualBounds(currentItems[activeIndex], newVx, newVy);
            } else {
                let newXmin = vXmin + logicDx;
                let newYmin = vYmin + logicDy;

                newXmin = applySnap(newXmin, e.altKey, true);
                newYmin = applySnap(newYmin, e.altKey, false);

                newXmin = Math.max(-limitX, Math.min(newXmin, limitX - (vXmax - vXmin)));
                newYmin = Math.max(-limitY, Math.min(newYmin, limitY - (vYmax - vYmin)));

                currentItems[activeIndex].bbox = [
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

            currentItems[activeIndex].bbox = [
                Math.min(newYmin, newYmax), Math.min(newXmin, newXmax),
                Math.max(newYmin, newYmax), Math.max(newXmin, newXmax),
            ];
        }
        drawCanvas();
    });

    window.addEventListener("mouseup", () => {
        if (bgDragMode) { bgDragMode = null; return; }
        if (isPanning) {
            isPanning = false;
            canvas.style.cursor = "default";
            return;
        }
        if (!dragMode) return;

        const currentDragMode = dragMode;
        const currentActive = activeIndex;
        dragMode = null;

        try {
            if (currentActive !== -1) {
                const item = currentItems[currentActive];
                if (item) {
                    const [ymin, xmin, ymax, xmax] = item.bbox;
                    let w = xmax - xmin;
                    let h = ymax - ymin;

                    // 🌟 身份证查验
                    const isNew = !knownBboxHistory.has(dragStartBBox.join(","));

                    // 1. 防误触：新建框且极小，直接静默删除
                    if (isNew && w <= 5 && h <= 5) {
                        currentItems.splice(currentActive, 1);
                        selectedIndices.delete(currentActive);
                        activeIndex = -1;
                        syncEditorPanel();
                        drawCanvas();
                        return;
                    }

                    // 2. 缩放到小于 16，强制变为正方形极小框
                    if (currentDragMode && currentDragMode.startsWith("resize") && (w < 16 || h < 16)) {
                        const finalSize = Math.max(1, Math.min(w, h));
                        
                        // 🌟 核心修复：在这里获取画布尺寸，防止 limitX 报错！
                        const { w: canvasW, h: canvasH } = getCanvasSize();
                        const limitX = canvasW / 2;
                        const limitY = canvasH / 2;

                        // 计算 16x16 视觉框的安全中心点，防止视觉框溢出画布
                        let cx = (xmin + xmax) / 2;
                        let cy = (ymin + ymax) / 2;
                        cx = Math.max(-limitX + 8, Math.min(cx, limitX - 8));
                        cy = Math.max(-limitY + 8, Math.min(cy, limitY - 8));

                        const finalXmin = Math.round(cx - finalSize / 2);
                        const finalYmin = Math.round(cy - finalSize / 2);
                        
                        item.bbox = [finalYmin, finalXmin, finalYmin + finalSize, finalXmin + finalSize];
                    }
                    
                    // 3. 刷新通行证
                    knownBboxHistory.add(item.bbox.join(","));
                }
            }

            if (activeIndex !== -1) {
                saveEditorChanges();
                const lastActive = activeIndex;
                renderList(false);
                activeIndex = lastActive;
                if (currentItems[activeIndex]) {
                    syncEditorPanel();
                }
            }
        } catch (err) {
            console.error("[MOSS] mouseup error:", err);
        } finally {
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
        if (activeIndex !== -1 && currentItems[activeIndex]) {
            const hit = checkItemHit(currentItems[activeIndex], activeIndex);
            if (hit) return hit;
        }

        // 🌟 3. 最后：检测其他框（从后往前遍历）
        for (let i = currentItems.length - 1; i >= 0; i--) {
            if (i === activeIndex) continue; // 刚刚已经测过了，跳过
            const hit = checkItemHit(currentItems[i], i);
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

        // 寻找双击位置对应的最上层框
        let targetIdx = -1;
        for (let i = currentItems.length - 1; i >= 0; i--) {
            const bbox = currentItems[i].bbox;
            if (!bbox || bbox.length !== 4) continue;
            const [ymin, xmin, ymax, xmax] = bbox;
            const p1 = logicToPhys(xmin, ymin);
            const p2 = logicToPhys(xmax, ymax);

            if (
                mouseX >= p1.x &&
                mouseX <= p2.x &&
                mouseY >= p1.y &&
                mouseY <= p2.y
            ) {
                targetIdx = i;
                break;
            }
        }

        if (targetIdx !== -1) {
            // 选中该框
            activeIndex = targetIdx;
            selectedIndices.clear();
            selectedIndices.add(targetIdx);
            updateListSelection();
            syncEditorPanel();
            drawCanvas();

            // 计算悬浮输入框的位置和大小
            const bbox = currentItems[targetIdx].bbox;
            const p1 = logicToPhys(bbox[1], bbox[0]);
            const p2 = logicToPhys(bbox[3], bbox[2]);

            // 创建 textarea
            const inlineInput = document.createElement("textarea");
            inlineInput.value =
                currentItems[targetIdx].caption || currentItems[targetIdx].desc || "";
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
            const saveInline = () => {
                const newText = inlineInput.value.trim();
                if (currentItems[targetIdx]) {
                    currentItems[targetIdx].caption = newText;
                    saveEditorChanges(); // 同步到 JSON、右侧列表和下方面板
                }
                if (inlineInput.parentNode)
                    inlineInput.parentNode.removeChild(inlineInput);
            };

            // 失焦保存
            inlineInput.addEventListener("blur", saveInline);

            // 键盘快捷键
            inlineInput.addEventListener("keydown", (ev) => {
                ev.stopPropagation(); // 防止触发画布的删除快捷键
                if (ev.key === "Enter" && !ev.shiftKey) {
                    ev.preventDefault();
                    saveInline();
                } else if (ev.key === "Escape") {
                    ev.preventDefault();
                    if (inlineInput.parentNode)
                        inlineInput.parentNode.removeChild(inlineInput);
                }
            });
        }
    });

    canvas.addEventListener("keydown", (e) => {
        if (e.key === "Delete" || e.key === "Backspace") {
            if (document.activeElement !== canvas) return;

            // 🌟 优先：处于"操控背景图"模式时，Delete/Backspace 删除背景图
            if (bgActive && bgImage) {
                deleteBackgroundImage();
                e.preventDefault();
                return;
            }
            
            if (selectedIndices.size > 0 && document.activeElement === canvas) {
                const indicesToRemove = Array.from(selectedIndices).sort((a, b) => b - a);
                const raw = JSON.parse(jsonWidget.value);
                const isArray = Array.isArray(raw);
                const data = isArray ? raw : { ...raw, items: currentItems };
                const items = isArray ? data : data.items;
                indicesToRemove.forEach((idx) => items.splice(idx, 1));

                activeIndex = -1;
                selectedIndices.clear();

                isUpdatingFromUI = true;
                jsonWidget.value = JSON.stringify(data, null, 2);
                if (jsonWidget.callback) jsonWidget.callback(jsonWidget.value);
                isUpdatingFromUI = false;
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

        if (hit.type === "create") canvas.style.cursor = "crosshair";
        else if (hit.type === "move") canvas.style.cursor = "move";
        else if (hit.type === "resize-tl" || hit.type === "resize-br")
            canvas.style.cursor = "nwse-resize";
        else if (hit.type === "resize-tr" || hit.type === "resize-bl")
            canvas.style.cursor = "nesw-resize";
    });

    canvas.addEventListener("mouseleave", () => {
        if (!isPanning && !dragMode) canvas.style.cursor = "default";
    });

    snapCb.addEventListener("change", () => drawCanvas());

    const updateListSelection = () => {
        const cbs = listArea.querySelectorAll("input[type='checkbox']");
        Array.from(listArea.children).forEach((child, i) => {
            const isSel = selectedIndices.has(i);
            if (cbs[i]) cbs[i].checked = isSel;

            child.style.background =
                i === activeIndex ? "#324664" : isSel ? "#2a3a4f" : "#2a2a2a";
            child.style.borderColor =
                i === activeIndex ? "#5c8ccb" : isSel ? "#4a7ab5" : "#333";
        });
        selectAllCb.checked =
            currentItems.length > 0 && selectedIndices.size === currentItems.length;
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
            jsonWidget.value = JSON.stringify(data, null, 2);
            if (jsonWidget.callback) jsonWidget.callback(jsonWidget.value);
            isUpdatingFromUI = false;
            
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
            jsonWidget.value = JSON.stringify(data, null, 2);
            if (jsonWidget.callback) jsonWidget.callback(jsonWidget.value);
            isUpdatingFromUI = false;
            
            if (node.graph) node.graph.setDirtyCanvas(true, true);
        } catch (e) {
            console.error("[MOSS] 更新 canvas 字段失败:", e);
        }
    };

    const renderList = (resetActive = true) => {
        syncCanvasMode();
        syncPrompt();

        if (resetActive) {
            activeIndex = -1;
            selectedIndices.clear();
            syncEditorPanel();
        }
        listArea.innerHTML = "";
        selectAllCb.checked = false;

        try {
            const data = JSON.parse(jsonWidget.value || "{}");
            currentItems = Array.isArray(data) ? data : data.items || [];

            knownBboxHistory.clear();
            currentItems.forEach(item => {
                if (item.bbox && item.bbox.length === 4) {
                    knownBboxHistory.add(item.bbox.join(","));
                }
            });
        } catch (e) {
            listArea.innerHTML = "<div style='color:#888;'>JSON 格式错误</div>";
            drawCanvas();
            return;
        }

        if (currentItems.length === 0) {
            listArea.innerHTML = "<div style='color:#888;'>当前没有边界框</div>";
            drawCanvas();
            return;
        }

        currentItems.forEach((item, index) => {
            const row = document.createElement("div");
            // 🌟 极小框红色高亮
            const realW = item.bbox[3] - item.bbox[1];
            const realH = item.bbox[2] - item.bbox[0];
            const isExtreme = realW < 16 || realH < 16;
            
            row.style.cssText = `display: flex; align-items: center; gap: 8px; padding: 6px 8px; background: #2a2a2a; border-radius: 4px; border: 1px solid ${isExtreme ? '#ff4a4a' : '#333'}; flex-shrink: 0; cursor: pointer;`;

            const cb = document.createElement("input");
            cb.type = "checkbox";
            cb.dataset.index = index;
            cb.checked = selectedIndices.has(index);
            cb.style.cssText = "cursor: pointer; accent-color: #4a9eff;";

            cb.addEventListener("change", () => {
                if (cb.checked) {
                    selectedIndices.add(index);
                    activeIndex = index;
                } else {
                    selectedIndices.delete(index);
                    if (activeIndex === index) activeIndex = -1;
                }
                updateListSelection();
                syncEditorPanel();
                drawCanvas();
            });

            row.addEventListener("click", (e) => {
                if (e.target !== cb && e.target.tagName !== "BUTTON") {
                    if (e.ctrlKey || e.metaKey) {
                        cb.checked = !cb.checked;
                    } else {
                        if (!cb.checked) {
                            selectedIndices.clear();
                            cb.checked = true;
                        }
                    }
                    cb.dispatchEvent(new Event("change"));
                }
            });

            const label = document.createElement("span");
            let text = item.caption || item.desc || `未命名 (${item.label || "object"})`;
            if (isExtreme) text = `[极小框 ${realW}x${realH}] ${text}`; // 显示真实尺寸
            
            label.textContent = `${index + 1}. ${text.length > 15 ? text.substring(0, 15) + "..." : text}`;
            label.style.cssText = `color: ${isExtreme ? '#ff4a4a' : '#ccc'}; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; pointer-events: none;`;

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

    selectAllCb.addEventListener("change", (e) => {
        const isChecked = e.target.checked;
        selectedIndices.clear();
        if (isChecked) {
            currentItems.forEach((_, i) => selectedIndices.add(i));
            activeIndex = currentItems.length - 1;
        } else {
            activeIndex = -1;
        }
        updateListSelection();
        syncEditorPanel();
        drawCanvas();
    });

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
            jsonWidget.value = JSON.stringify(data, null, 2);
            if (jsonWidget.callback) jsonWidget.callback(jsonWidget.value);
            isUpdatingFromUI = false;

            selectedIndices.clear();
            selectedIndices.add(data.items.length - 1);
            activeIndex = data.items.length - 1;

            renderList(false);
            syncEditorPanel();
            listArea.scrollTop = listArea.scrollHeight;
            if (node.graph) node.graph.setDirtyCanvas(true, true);
        } catch (e) {
            alert("增加失败！");
        }
    });

    deleteBtn.addEventListener("click", () => {
        if (selectedIndices.size === 0) return alert("请先勾选要删除的框！");
        if (!confirm(`确定要删除选中的 ${selectedIndices.size} 个框吗？`)) return;

        const indicesToRemove = Array.from(selectedIndices).sort((a, b) => b - a);

        try {
            let data = JSON.parse(jsonWidget.value);
            let items = Array.isArray(data) ? data : data.items;
            indicesToRemove.forEach((idx) => items.splice(idx, 1));

            isUpdatingFromUI = true;
            jsonWidget.value = JSON.stringify(data, null, 2);
            if (jsonWidget.callback) jsonWidget.callback(jsonWidget.value);
            isUpdatingFromUI = false;

            selectedIndices.clear();
            activeIndex = -1;
            renderList();
            syncEditorPanel();
            if (node.graph) node.graph.setDirtyCanvas(true, true);
        } catch (e) {
            alert("删除失败！");
        }
    });

    const origCallback = jsonWidget.callback;
    jsonWidget.callback = function () {
        if (origCallback) origCallback.apply(this, arguments);
        if (!isUpdatingFromUI) renderList();
    };

    const wWidget = node.widgets.find((w) => w.name === "canvas_width");
    const hWidget = node.widgets.find((w) => w.name === "canvas_height");
    if (wWidget && hWidget) {
        const origWCb = wWidget.callback,
            origHCb = hWidget.callback;
        wWidget.callback = function () {
            if (origWCb) origWCb.apply(this, arguments);
            drawCanvas();
        };
        hWidget.callback = function () {
            if (origHCb) origHCb.apply(this, arguments);
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
                <li><b>Ctrl + V</b>：在画布聚焦时粘贴背景图</li>
                <li><b>Ctrl + 点击</b>：多选框</li>
            </ul>

            <div style="margin-bottom: 10px;"><b style="color:#fff;">📐 极小框控制：</b></div>
            <ul style="margin: 0 0 10px 20px; padding: 0; color: #ccc;">
                <li>当框小于 16x16 时，会在画布上显示为 16x16 的红色虚线框。</li>
                <li>在右侧菜单勾选“极小框控制”，可自定义 1-15px 尺寸及对齐方式。</li>
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

    renderList();

    // 🌟 暴露刷新接口，供重新打开面板时调用
    node._mossRefreshPanel = () => {
        renderList();
    };

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

app.registerExtension({
    name: "Comfy.MOSS_Resizer_DynamicUI",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name !== "MOSS_BBox_Resizer") return;

        const onExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (message) {
            const r = onExecuted?.apply(this, arguments);
            const ui = message?.ui || message?.output || message || {};
            const oldWidth = ui.old_width?.[0];
            const oldHeight = ui.old_height?.[0];
            console.log("[MOSS] 尺寸映射执行结果:", { oldWidth, oldHeight, message });
            const updateWidget = (name, value) => {
                const widget = this.widgets?.find((item) => item.name === name);
                if (widget && Number.isFinite(value) && widget.value !== value) {
                    widget.value = value;
                    widget.callback?.(value);
                }
            };
            updateWidget("old_width", oldWidth);
            updateWidget("old_height", oldHeight);
            if (!Number.isFinite(oldWidth) || !Number.isFinite(oldHeight)) {
                setTimeout(() => this._mossCalculateAndLockSize?.(), 0);
            }
            return r;
        };

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onNodeCreated
                ? onNodeCreated.apply(this, arguments)
                : undefined;
            const node = this;

            const LABELS = {
                "layout_json": "布局 JSON",
                "auto_guess_old_size": "自动推测原尺寸",
                "guess_ratio": "推测宽高比",
                "old_width": "原图宽度",
                "old_height": "原图高度",
                "new_width": "目标宽度",
                "new_height": "目标高度",
                "resize_mode": "尺寸映射模式",
                "scale_factor": "额外缩放倍率",
            };
            node.widgets?.forEach((widget) => {
                if (LABELS[widget.name]) widget.label = LABELS[widget.name];
            });
            setTimeout(() => {
                node.inputs?.forEach((input) => {
                    if (LABELS[input.name]) input.label = LABELS[input.name];
                });
                node.graph?.setDirtyCanvas(true, true);
            }, 50);

            const jsonWidget = node.widgets.find((w) => w.name === "layout_json");
            const autoGuessWidget = node.widgets.find(
                (w) => w.name === "auto_guess_old_size",
            );
            const ratioWidget = node.widgets.find((w) => w.name === "guess_ratio");
            const modeWidget = node.widgets.find((w) => w.name === "resize_mode");
            const scaleWidget = node.widgets.find((w) => w.name === "scale_factor");
            const oldWWidget = node.widgets.find((w) => w.name === "old_width");
            const oldHWidget = node.widgets.find((w) => w.name === "old_height");

            if (!jsonWidget || !autoGuessWidget || !modeWidget || !scaleWidget || !oldWWidget || !oldHWidget)
                return r;

            // 🌟 1. 核心逻辑：实时计算并填入尺寸，同时控制禁用状态
            const readConnectedJson = (currentNode, visited = new Set()) => {
                if (!currentNode || visited.has(currentNode.id)) return "";
                visited.add(currentNode.id);
                const input = currentNode.inputs?.find((item) => item.name === "layout_json");
                if (!input?.link) return "";
                const link = currentNode.graph?.links?.[input.link];
                const origin = link ? currentNode.graph?.getNodeById(link.origin_id) : null;
                if (!origin) return "";

                const candidates = ["layout_json", "json", "text", "string", "value", "prompt"];
                for (const name of candidates) {
                    const widget = origin.widgets?.find((item) => item.name === name);
                    if (typeof widget?.value !== "string" || !widget.value.trim()) continue;
                    try {
                        const parsed = JSON.parse(widget.value);
                        const items = Array.isArray(parsed) ? parsed : parsed.items;
                        if (Array.isArray(items)) return widget.value;
                    } catch (_) { }
                }
                return readConnectedJson(origin, visited);
            };

            const calculateAndLockSize = () => {
                if (autoGuessWidget.value) {
                    let maxX = 0,
                        maxY = 0;
                    let hasItems = false;
                    const connectedJson = readConnectedJson(node);
                    const jsonValue = connectedJson || jsonWidget.value;
                    try {
                        const parsed = JSON.parse(jsonValue);
                        const items = Array.isArray(parsed) ? parsed : parsed.items || [];
                        for (let item of items) {
                            if (item.bbox && item.bbox.length === 4) {
                                hasItems = true;
                                let [ymin, xmin, ymax, xmax] = item.bbox;
                                maxY = Math.max(maxY, Math.abs(ymin), Math.abs(ymax));
                                maxX = Math.max(maxX, Math.abs(xmin), Math.abs(xmax));
                            }
                        }
                    } catch (e) { }

                    const inputSlot = node.inputs?.find((item) => item.name === "layout_json");
                    const hasUpstream = Boolean(inputSlot?.link);
                    if (!hasItems && hasUpstream) {
                        oldWWidget.disabled = true;
                        oldHWidget.disabled = true;
                        if (node.graph) node.graph.setDirtyCanvas(true, true);
                        return;
                    }

                    let guessW = maxX * 2;
                    let guessH = maxY * 2;

                    const ratioStr = ratioWidget.value;
                    if (ratioStr && ratioStr !== "自动(不限定)") {
                        const [rw, rh] = ratioStr.split(":").map(Number);
                        const targetRatio = rw / rh;
                        const currentRatio = guessH > 0 ? guessW / guessH : 1;
                        if (currentRatio < targetRatio) {
                            guessW = guessH * targetRatio;
                        } else {
                            guessH = guessW / targetRatio;
                        }
                    }

                    guessW = Math.max(64, Math.ceil(guessW / 16) * 16);
                    guessH = Math.max(64, Math.ceil(guessH / 16) * 16);

                    oldWWidget.value = guessW;
                    oldHWidget.value = guessH;
                }

                // 无论是否开启猜测，只要猜测开启，输入框就变灰
                oldWWidget.disabled = autoGuessWidget.value;
                oldHWidget.disabled = autoGuessWidget.value;

                if (node.graph) node.graph.setDirtyCanvas(true, true);
            };
            node._mossCalculateAndLockSize = calculateAndLockSize;

            // 监听输入变化
            const origJsonCb = jsonWidget.callback;
            jsonWidget.callback = function () {
                if (origJsonCb) origJsonCb.apply(this, arguments);
                calculateAndLockSize();
            };

            const origAutoCb = autoGuessWidget.callback;
            autoGuessWidget.callback = function () {
                if (origAutoCb) origAutoCb.apply(this, arguments);
                calculateAndLockSize();
                updateVisibility();
            };

            const origRatioCb = ratioWidget.callback;
            ratioWidget.callback = function () {
                if (origRatioCb) origRatioCb.apply(this, arguments);
                calculateAndLockSize();
            };

            // 🌟 2. 控制 scale_factor 的隐藏（锁死节点总高度版）
            const originalType = scaleWidget.type;
            const originalComputeSize = scaleWidget.computeSize;

            let lastMode = "";

            const updateVisibility = () => {
                const isFixed = modeWidget.value === "保持固定坐标(不缩放)";

                if (lastMode === modeWidget.value) return;

                // 记录当前节点绝对尺寸
                const currentWidth = node.size[0];
                const currentHeight = node.size[1];

                if (isFixed) {
                    scaleWidget.type = "hidden";
                    scaleWidget.computeSize = () => [0, -4];
                } else {
                    scaleWidget.type = originalType;
                    scaleWidget.computeSize = originalComputeSize;
                }

                lastMode = modeWidget.value;

                // 🌟 核心修复：强制把节点尺寸恢复原样！
                // 这样 ComfyUI 就不会认为节点总高度变了，也就绝对不会去重置 layout_json 的初始高度。
                // 空出来的位置会被 layout_json 自动吸走（输入框会变长一点，手感更好）。
                node.setSize([currentWidth, currentHeight]);

                if (node.graph) node.graph.setDirtyCanvas(true, true);
            };
            const origModeCb2 = modeWidget.callback;
            modeWidget.callback = function () {
                if (origModeCb2) origModeCb2.apply(this, arguments);
                updateVisibility();
            };

            // 加载工作流时恢复状态
            const onConfigure = this.onConfigure;
            this.onConfigure = function (info) {
                const res = onConfigure
                    ? onConfigure.apply(this, arguments)
                    : undefined;
                setTimeout(() => {
                    lastMode = "";
                    calculateAndLockSize();
                    updateVisibility();
                }, 50);
                return res;
            };

            setTimeout(() => {
                calculateAndLockSize();
                updateVisibility();
            }, 50);

            return r;
        };

        const onConnectionsChange = nodeType.prototype.onConnectionsChange;
        nodeType.prototype.onConnectionsChange = function () {
            const r = onConnectionsChange?.apply(this, arguments);
            setTimeout(() => {
                this._mossCalculateAndLockSize?.();
            }, 0);
            return r;
        };
    },
});
