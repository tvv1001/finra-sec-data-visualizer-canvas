import { getRecordDisplayName } from './recordDisplay';
import { formatEntityName, formatPersonName, formatFirmName } from './nameFormat';

export function resolveMainRecordTitle(options: {
	mainJsonLabel?: string | null;
	fallbackName?: string | null;
	entity?: 'individual' | 'firm' | string | null;
	id?: string | null;
	payload?: unknown;
}) {
	const normalizedLabel = String(options.mainJsonLabel || '').trim();
	const normalizedFallbackName = String(options.fallbackName || '').trim();
	const normalizedEntity = String(options.entity || '')
		.trim()
		.toLowerCase();
	const normalizedId = String(options.id || '').trim();
	const genericTitlePattern = /^(individual|firm)\s+\d+$/i;
	const placeholderLabelPattern = /^(result|record|individual|firm)$/i;
	const derivedName =
		normalizedEntity === 'firm' || normalizedEntity === 'individual' ? getRecordDisplayName(options.payload, normalizedEntity as 'individual' | 'firm', normalizedId || '0') : '';
	const hasUsefulLabel = Boolean(normalizedLabel && !genericTitlePattern.test(normalizedLabel) && !placeholderLabelPattern.test(normalizedLabel));
	const shouldPreferDerivedName = Boolean(derivedName && (!normalizedLabel || genericTitlePattern.test(normalizedLabel) || placeholderLabelPattern.test(normalizedLabel)));

	const formatResolved = (name: string) => {
		if (!name) return name;
		if (genericTitlePattern.test(name) || placeholderLabelPattern.test(name)) return name;
		if (normalizedEntity === 'individual' || normalizedEntity === 'firm') {
			return formatEntityName(name, normalizedEntity);
		}
		return formatPersonName(name);
	};

	if (shouldPreferDerivedName) {
		return formatResolved(derivedName);
	}
	if (normalizedFallbackName && (!normalizedLabel || genericTitlePattern.test(normalizedLabel) || placeholderLabelPattern.test(normalizedLabel))) {
		return formatResolved(normalizedFallbackName);
	}
	if (hasUsefulLabel) {
		return formatResolved(normalizedLabel);
	}
	if (normalizedFallbackName) {
		return formatResolved(normalizedFallbackName);
	}
	if (derivedName) {
		return formatResolved(derivedName);
	}
	if (normalizedEntity === 'firm' || normalizedEntity === 'individual') {
		return `${normalizedEntity === 'firm' ? 'Firm' : 'Individual'} ${normalizedId || ''}`.trim();
	}
	return normalizedId ? `Record ${normalizedId}` : '';
}
