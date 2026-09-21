// Runtime-configurable hop defaults (range 1-5)
export let RUNTIME_EXPANSION_HOPS = 1;
export let RUNTIME_CLICK_EXPANSION_HOPS = 1;
export let RUNTIME_SELECTION_HOPS = 1;

export function setRuntimeHopDefaults(expansion: number, click: number, selection: number) {
	RUNTIME_EXPANSION_HOPS = Math.max(1, Math.min(5, Math.floor(expansion)));
	RUNTIME_CLICK_EXPANSION_HOPS = Math.max(1, Math.min(5, Math.floor(click)));
	RUNTIME_SELECTION_HOPS = Math.max(1, Math.min(5, Math.floor(selection)));
}

export function getRuntimeHopDefaults() {
	return {
		expansion: RUNTIME_EXPANSION_HOPS,
		click: RUNTIME_CLICK_EXPANSION_HOPS,
		selection: RUNTIME_SELECTION_HOPS,
	};
}

export const DEFAULT_EXPANSION_HOPS = 1;
export const DEFAULT_CLICK_EXPANSION_HOPS = 1;
export const DEFAULT_SELECTION_HOPS = 1;
export const DEFAULT_NODE_LABEL_FONT_SIZE_PX = 16;
export const DEFAULT_NODE_LABEL_FONT_SIZE = `${DEFAULT_NODE_LABEL_FONT_SIZE_PX}px`;
export const DEFAULT_NODE_LABEL_FONT_WEIGHT = '400';
export const DEFAULT_NODE_LABEL_GAP_PX = 0;
