import { registerJsonImporter } from "./nodes/json-importer.js";
import { registerResizerNode } from "./nodes/resizer-node.js";
import { registerDrawBBoxes } from "./nodes/draw-bboxes.js";
import { registerOutputSlots } from "./nodes/output-slots.js";

export function registerMossBBoxManager() {
    registerJsonImporter();
    registerResizerNode();
    registerDrawBBoxes();
    registerOutputSlots();
}

export { createFloatingPanel } from "./panel/floating-panel.js";
export { attachJsonCopyButtons } from "./ui/copy-buttons.js";
export { serializeLayout, normalizeLayoutSchema } from "./core/json-schema.js";
