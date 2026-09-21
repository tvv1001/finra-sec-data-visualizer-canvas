export type JsonDisplayNode = {
	key?: string;
	type: 'object' | 'array' | 'primitive';
	value?: string;
	children?: JsonDisplayNode[];
};

export function safeParseJson(value: unknown) {
	if (typeof value !== 'string') return value;
	const trimmed = value.trim();
	if (!trimmed) return value;
	try {
		return JSON.parse(trimmed);
	} catch {
		return value;
	}
}

export function coerceStructuredValue(value: unknown) {
	if (value === null || value === undefined) return value;
	if (typeof value === 'string') {
		const parsed = safeParseJson(value);
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			return parsed;
		}
		if (Array.isArray(parsed)) {
			return parsed;
		}
	}
	return value;
}

export function normalizeRenderablePayload(payload: unknown) {
	if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
		return payload;
	}

	const obj = payload as Record<string, any>;
	const parsedContent = safeParseJson(obj.content);
	const parsedIaContent = safeParseJson(obj.iacontent);
	const parsedMeta = safeParseJson(obj.meta);

	const merged = {
		...obj,
		...(parsedContent && typeof parsedContent === 'object' ? parsedContent : {}),
		...(parsedIaContent && typeof parsedIaContent === 'object' ? parsedIaContent : {}),
		...(parsedMeta && typeof parsedMeta === 'object' ? parsedMeta : {}),
	} as Record<string, any>;

	if (parsedContent && typeof parsedContent === 'object') delete merged.content;
	if (parsedIaContent && typeof parsedIaContent === 'object') delete merged.iacontent;
	if (parsedMeta && typeof parsedMeta === 'object') delete merged.meta;

	return merged;
}

export function buildJsonDisplayTree(value: unknown, key?: string): JsonDisplayNode {
	if (value === null || value === undefined) {
		return { key, type: 'primitive', value: 'null' };
	}

	if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
		return { key, type: 'primitive', value: String(value) };
	}

	if (Array.isArray(value)) {
		return {
			key,
			type: 'array',
			children: value.map((entry, index) => buildJsonDisplayTree(entry, `${index}`)),
		};
	}

	if (value && typeof value === 'object') {
		const entries = Object.entries(value as Record<string, unknown>);
		return {
			key,
			type: 'object',
			children: entries.map(([childKey, childValue]) => buildJsonDisplayTree(childValue, childKey)),
		};
	}

	return { key, type: 'primitive', value: String(value) };
}

export function renderJsonForDisplay(payload: unknown) {
	const parsed = safeParseJson(payload);
	const normalized = normalizeRenderablePayload(parsed);
	try {
		return JSON.stringify(normalized, null, 2);
	} catch {
		return String(normalized ?? '');
	}
}
