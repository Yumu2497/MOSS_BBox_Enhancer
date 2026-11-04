// 记录哪些节点的管理面板当前是打开的。
// ComfyUI 的全局撤销（Ctrl+Z）会重建整张图，节点被移除再新建，
// 面板会跟着消失；靠这份记录在节点重建后自动把它恢复。
export const openPanelIds = new Set();
