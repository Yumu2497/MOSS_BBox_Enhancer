// 版本号的「前端缓存层」。
// 真正的来源是后端 MOSS_Version.py，由 json-importer 启动时拉取一次写进来，
// 这里只负责保存与通知，不直接依赖 ComfyUI 的 api 模块（这样面板仍可独立测试）。

let version = "";
const listeners = new Set();

export const getPluginVersion = () => version;

export const setPluginVersion = (value) => {
    version = typeof value === "string" ? value.trim() : "";
    listeners.forEach((fn) => {
        try {
            fn(version);
        } catch (err) {
            console.warn("[MOSS] 版本号回调失败:", err);
        }
    });
};

// 版本号是异步来的，可能晚于面板创建：先订阅，拿到后再补上徽标
export const onPluginVersion = (fn) => {
    if (version) {
        fn(version);
        return () => {};
    }
    listeners.add(fn);
    return () => listeners.delete(fn);
};
