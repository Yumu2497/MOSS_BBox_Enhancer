/**
 * 三个页签（框 / 背景 / 深度）共用的列表拖拽。
 *
 * 拖起的那一行脱离列表、浮起跟随指针，原位置留虚线占位符，其余行用 FLIP 平滑让位。
 * 拖动过程中**不重建 DOM、不动数据**，松手才回调 onDrop(fromIndex, toIndex) 让各页重排。
 * 之前背景 / 深度每越过一格就重排数组 + 重建整张表，动画互相叠加，往下拖就卡。
 */

const FLIP_MS = "transform 0.16s cubic-bezier(0.2, 0.8, 0.3, 1)";

export function createListDrag({
    container,          // 行的直接父元素
    panel,              // 浮起行挂到主面板下（面板有 transform，挂 body 会错位）
    rowFilter,          // (el) => boolean，判断哪些子元素参与排序
    tailSelector = "",  // 可选：占位符不能越过的尾部锚点（深度页的「笔刷层」）
    onFirstMove,        // 指针真的移动过（越过 4px 死区）才触发，用来入撤销快照
    onDrop,             // (fromIndex, toIndex) —— 索引都是「显示顺序」
    onCancel,           // 拖动中途列表被外部重建时收尾
}) {
    let d = null;

    const rows = () => Array.from(container.children).filter(rowFilter);
    const tail = () => (tailSelector ? container.querySelector(tailSelector) : null);

    // FLIP：先反向位移，再过渡回原位
    function flip(before) {
        rows().forEach((el) => {
            const b = before.get(el);
            if (b == null) return;
            const dy = b - el.getBoundingClientRect().top;
            if (Math.abs(dy) < 1) return;
            el.style.transition = "none";
            el.style.transform = `translateY(${dy}px)`;
            void el.offsetHeight; // 强制回流，让上面的位移立即生效
            el.style.transition = FLIP_MS;
            el.style.transform = "";
        });
    }

    function begin(e, row, fromIndex) {
        if (d || rows().length < 2) return false;
        e.preventDefault();
        e.stopPropagation();

        const rect = row.getBoundingClientRect();
        const panelRect = panel.getBoundingClientRect();
        const ph = document.createElement("div");
        ph.className = "moss-row-placeholder";
        ph.style.height = `${rect.height}px`;
        ph.style.boxSizing = "border-box";
        container.insertBefore(ph, row);

        const origCss = row.style.cssText;
        row.classList.add("is-dragging");
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

        d = {
            row, ph, fromIndex, origCss,
            startY: e.clientY,
            grabOffsetY: e.clientY - rect.top,
            panelTop: panelRect.top,
            moved: false,
        };

        document.body.style.userSelect = "none";
        document.body.style.cursor = "grabbing";
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", end);
        window.addEventListener("pointercancel", end);
        return true;
    }

    function move(e) {
        if (!d) return;
        const { row, ph } = d;
        // 拖动期间列表被外部重建（例如别人调了 renderList），直接放弃这次拖动
        if (!row.isConnected || !ph.isConnected) { end(); return; }

        if (!d.moved) {
            if (Math.abs(e.clientY - d.startY) < 4) return;
            d.moved = true;
            onFirstMove?.(d.fromIndex);
        }

        row.style.top = `${e.clientY - d.grabOffsetY - d.panelTop}px`;

        const others = rows();
        const before = new Map();
        others.forEach((el) => before.set(el, el.getBoundingClientRect().top));

        // 指针落在哪一行的上半部之前，占位符就插到那一行前面
        let ref = null;
        for (const el of others) {
            const r = el.getBoundingClientRect();
            if (e.clientY < r.top + r.height / 2) { ref = el; break; }
        }
        const t = tail();
        const already = ref
            ? ph.nextElementSibling === ref
            : ph.nextElementSibling === t || (!t && ph === container.lastElementChild);
        if (already) return;

        if (ref) container.insertBefore(ph, ref);
        else if (t) container.insertBefore(ph, t);
        else container.appendChild(ph);
        flip(before);
    }

    function cleanup() {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", end);
        window.removeEventListener("pointercancel", end);
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
        const cur = d;
        d = null;
        return cur;
    }

    function end() {
        const cur = cleanup();
        if (!cur) return;
        const { row, ph, fromIndex, origCss } = cur;
        row.classList.remove("is-dragging");
        row.style.cssText = origCss;

        // 占位符已经被列表重建清掉时，只要把浮起的行收回来即可
        if (!ph.isConnected) {
            row.remove();
            onCancel?.();
            return;
        }

        container.insertBefore(row, ph);
        const all = Array.from(container.children);
        const toIndex = all.slice(0, all.indexOf(row)).filter(rowFilter).length;
        ph.remove();
        onDrop?.(fromIndex, toIndex);
    }

    return { begin, isActive: () => !!d };
}
