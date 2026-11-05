// 框复制 / 粘贴的文本协议：带 moss-bbox: 前缀的 JSON 才算「我们复制的框」。
// 纯数据处理，系统剪贴板读写在主面板里做。

export const CLIPBOARD_PREFIX = "moss-bbox:";

// 复制时去掉内部字段（_align、_selected 等），只保留可持久化数据
export function cloneItemForClipboard(item) {
    const copy = JSON.parse(JSON.stringify(item));
    Object.keys(copy).forEach((k) => {
        if (k.startsWith("_")) delete copy[k];
    });
    return copy;
}

export function formatClipboardPayload(items) {
    return CLIPBOARD_PREFIX + JSON.stringify(items);
}

export function parseClipboardBoxes(text) {
    if (typeof text !== "string" || !text.startsWith(CLIPBOARD_PREFIX)) return null;
    try {
        const data = JSON.parse(text.slice(CLIPBOARD_PREFIX.length));
        if (!Array.isArray(data)) return null;
        return data.filter((it) => it && Array.isArray(it.bbox) && it.bbox.length === 4);
    } catch (e) {
        return null;
    }
}
