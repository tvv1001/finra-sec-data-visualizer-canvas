const truthy = new Set(['1', 'true', 'yes', 'on']);
const falsey = new Set(['0', 'false', 'no', 'off']);

function getFlagValue(...names: string[]) {
	for (const name of names) {
		const value = process.env[name];
		if (value == null) continue;
		const normalized = String(value).trim().toLowerCase();
		if (normalized === '') continue;
		return normalized;
	}
	return '';
}

function isExplicitlyDisabled() {
	const raw = getFlagValue('EXTERNAL_API_DISABLED', 'DISABLE_EXTERNAL_API_FETCH');
	return raw !== '' && truthy.has(raw);
}

function isExplicitlyEnabled() {
	const raw = getFlagValue('EXTERNAL_API_DISABLED', 'DISABLE_EXTERNAL_API_FETCH');
	if (raw !== '' && falsey.has(raw)) return true;
	const allowRaw = getFlagValue('EXTERNAL_API_ENABLED', 'ALLOW_EXTERNAL_API_FETCH');
	return allowRaw !== '' && truthy.has(allowRaw);
}

function getExternalApiContext() {
	return String(process.env.EXTERNAL_API_CONTEXT || '')
		.trim()
		.toLowerCase();
}

export function canCallExternalApis() {
	if (isExplicitlyDisabled()) return false;
	
	const context = getExternalApiContext();
	if (context === 'cronjob' || context === 'build') {
		return true;
	}
	
	return false;
}

export function setExternalApiContext(context: string | null | undefined) {
	if (context == null || String(context).trim() === '') {
		delete process.env.EXTERNAL_API_CONTEXT;
		return;
	}
	process.env.EXTERNAL_API_CONTEXT = String(context).trim().toLowerCase();
}
