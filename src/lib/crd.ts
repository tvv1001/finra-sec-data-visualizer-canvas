export function isValidCrd(value: string | null | undefined): boolean {
	if (typeof value !== 'string') return false;
	const v = value.trim();
	return /^\d+$/.test(v);
}

export function ensureFirmCrd(raw: string): string {
	const v = String(raw || '')
		.replace(/^firm:/, '')
		.trim();
	if (!isValidCrd(v)) throw new Error(`invalid firm CRD: ${raw}`);
	return v;
}

export function ensurePersonCrd(raw: string): string {
	let v = String(raw || '').trim();
	if (v.startsWith('person:')) v = v.slice('person:'.length);
	if (v.startsWith('individual:')) v = v.slice('individual:'.length);
	if (!isValidCrd(v)) throw new Error(`invalid person/individual CRD: ${raw}`);
	return v;
}

export function makeRedisKey(namespace: string, type: 'firm' | 'individual', crd: string, suffix?: string) {
	if (!isValidCrd(crd)) throw new Error(`invalid CRD when building redis key: ${crd}`);
	return suffix ? `${namespace}:${type}:${crd}:${suffix}` : `${namespace}:${type}:${crd}`;
}
