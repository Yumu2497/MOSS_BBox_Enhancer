import { app } from "../../../../scripts/app.js";
import { api } from "../../../../scripts/api.js";
import { serializeLayout } from "../core/json-schema.js";
import { openPanelIds } from "../core/panel-registry.js";
import { attachJsonCopyButtons } from "../ui/copy-buttons.js";
import { createFloatingPanel } from "../panel/floating-panel.js";

export const jsonImporterExtension = {
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
                "preview": "显示画布预览",
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

            // 🌟 JSON 控件下方的「复制 / 复制(带长宽)」按钮
            attachJsonCopyButtons(node, jsonWidget);

            // 🌟 框色表：面板写入的隐藏控件，只喂给「边界框」输出，不进入 layout_json
            const hideColorWidget = () => {
                const w = node.widgets?.find((x) => x.name === "bbox_colors");
                if (!w) return false;
                w.computeSize = () => [0, -4];
                w.serialize = true;
                return true;
            };
            if (!hideColorWidget()) setTimeout(hideColorWidget, 60);

            // 🌟 节点被重建（例如 Ctrl+Z 触发整图 reconfigure）后自动恢复面板
            if (openPanelIds.has(node.id)) {
                setTimeout(() => {
                    if (document.getElementById(`moss-bbox-panel-${node.id}`)) return;
                    const w = node.widgets?.find((x) => x.name === "layout_json");
                    if (w) createFloatingPanel(node, w);
                }, 120);
            }
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

                                jsonWidget.value = serializeLayout(finalJson);
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
                // 取色浮层、标签样式挂在 body/head 上，节点删除时要一并清理
                document.getElementById(`moss-color-popup-${node.id}`)?.remove();
                document.getElementById(`moss-color-popup-style-${node.id}`)?.remove();
                document.getElementById(`moss-tag-style-${node.id}`)?.remove();
                // 属性面板若处于独立悬浮态，它是挂在 body 上的
                document.getElementById(`moss-editor-${node.id}`)?.remove();
                // 键盘监听挂在 window 捕获阶段，节点删除时必须摘掉
                if (node._mossKeyHandler) {
                    window.removeEventListener("keydown", node._mossKeyHandler, true);
                    node._mossKeyHandler = null;
                }
                node._mossToastCleanup?.();
                node._mossToastCleanup = null;
                node._mossPanelUpdate = null;
                node._mossPendingBackground = null;

                // 节点被移除：如果它是被整图重建掉的（Ctrl+Z），稍后会以同 id 重新出现，
                // 那就保留"面板打开"的记录让新节点自动恢复；否则清掉。
                if (openPanelIds.has(node.id)) {
                    setTimeout(() => {
                        const live = node.graph?.getNodeById?.(node.id);
                        if (!live) openPanelIds.delete(node.id);
                    }, 500);
                }

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
};

export function registerJsonImporter() {
    return app.registerExtension(jsonImporterExtension);
}
