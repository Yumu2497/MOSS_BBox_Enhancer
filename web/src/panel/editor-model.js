export function createEditorModel() {
    const UNDO_LIMIT = 100;
    const COALESCE_MS = 700;

    const state = {
        items: [],
        active: -1,
        selection: new Set(),
        view: { scale: 1, x: 0, y: 0 },
        history: { stack: [], index: -1, lastAt: 0 },
    };

    const listeners = new Set();
    const emit = (reason) => listeners.forEach((fn) => fn(reason, state));

    return {
        get items() {
            return state.items;
        },
        setItems(items) {
            state.items = items;
            emit("items");
        },

        get active() {
            return state.active;
        },
        setActive(index) {
            if (state.active === index) return;
            state.active = index;
            emit("active");
        },

        get selection() {
            return state.selection;
        },
        clearSelection() {
            state.selection.clear();
            emit("selection");
        },

        view: state.view,

        // 700ms 内的连续改动合并成一步（打字 / 连续微移）
        record(snapshot, coalesce = true) {
            if (typeof snapshot !== "string") return false;
            const h = state.history;
            if (h.index >= 0 && h.stack[h.index] === snapshot) return false;
            if (h.index < h.stack.length - 1) h.stack.length = h.index + 1;

            const now = Date.now();
            if (coalesce && h.index >= 0 && now - h.lastAt < COALESCE_MS) {
                h.stack[h.index] = snapshot;
            } else {
                h.stack.push(snapshot);
                if (h.stack.length > UNDO_LIMIT) h.stack.shift();
                h.index = h.stack.length - 1;
            }
            h.lastAt = now;
            return true;
        },
        hasHistory(index) {
            return index >= 0 && index < state.history.stack.length;
        },
        historyAt(index) {
            return state.history.stack[index];
        },
        setHistoryIndex(index) {
            state.history.index = index;
        },
        get historyIndex() {
            return state.history.index;
        },
        canUndo() {
            return state.history.index > 0;
        },
        canRedo() {
            const h = state.history;
            return h.index >= 0 && h.index < h.stack.length - 1;
        },
        resetCoalesce() {
            state.history.lastAt = 0;
        },

        subscribe(fn) {
            listeners.add(fn);
            return () => listeners.delete(fn);
        },
    };
}
