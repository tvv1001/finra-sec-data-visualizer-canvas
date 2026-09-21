import { formatPersonName, formatFirmName, formatEntityName } from '../nameFormat';
export { formatPersonName, formatFirmName, formatEntityName };

export function esc(str) {
	if (str == null) return '';
	// Handle arrays and plain objects more gracefully so templates don't render
	// the unhelpful "[object Object]" string. Arrays are joined with comma,
	// and object elements inside arrays will try to surface a useful label
	// (label/name/status/code/etc.) before falling back to JSON.
	let raw: string;
	function elementToString(s: any) {
		if (s == null) return '';
		if (typeof s === 'string') return s;
		if (typeof s === 'number' || typeof s === 'boolean') return String(s);
		if (typeof s === 'object') {
			// Prefer common human-friendly keys when stringifying objects
			const preferred = s.label || s.name || s.title || s.code || s.state || s.status || s.registrationStatus || s.value || s.description;
			if (preferred && (typeof preferred === 'string' || typeof preferred === 'number')) return String(preferred);
			try {
				return JSON.stringify(s);
			} catch {
				return String(s);
			}
		}
		return String(s);
	}

	if (Array.isArray(str)) {
		raw = str.map(elementToString).filter(Boolean).join(', ');
	} else if (typeof str === 'object') {
		try {
			raw = JSON.stringify(str);
		} catch {
			raw = String(str);
		}
	} else {
		raw = String(str);
	}
	return raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\"/g, '&quot;');
}

export function normalizePersonLabel(str) {
	const s = String(str || '').trim();
	if (!s) return '';
	return formatPersonName(s);
}

// Format an "other name" for display in the UI. For firms, prefer Title Case
// but preserve short corporate suffixes (e.g., LLC, INC) as all-caps when they
// are exactly 2-3 alpha characters.
export function formatOtherName(rawName, isFirm = false) {
	const s = String(rawName || '').trim();
	if (!s) return '';
	return isFirm ? formatFirmName(s) : formatPersonName(s);
}

export function formatNodeLabel(str, group?: 'individual' | 'firm' | string) {
	const s = String(str || '').trim();
	if (!s) return '';
	if (group === 'individual') {
		return formatPersonName(s);
	}
	if (group === 'firm') {
		return formatFirmName(s);
	}
	return formatEntityName(s);
}

export function capitalize(str) {
	const s = String(str || '').trim();
	return s ? s[0].toUpperCase() + s.slice(1) : '';
}

export function formatUiText(str) {
	const raw = String(str || '').trim();
	if (!raw) return '';

	const normalizedSpacing = raw.replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
	const shouldNormalizeCase = !/[a-z]/.test(normalizedSpacing);
	const source = shouldNormalizeCase ? normalizedSpacing.toLowerCase() : normalizedSpacing;
	const acronyms = new Set(['IA', 'FINRA', 'SEC', 'CRD', 'SRO', 'PDF', 'ADV', 'BD']);

	return source
		.split(/\s+/)
		.map((word) => {
			return word
				.split(/([-\/])/)
				.map((part) => {
					if (!part) return '';
					if (/^[-\/]$/.test(part)) return part;
					const upper = part.toUpperCase();
					if (acronyms.has(upper)) return upper;
					return part[0].toUpperCase() + part.slice(1).toLowerCase();
				})
				.join('');
		})
		.join(' ');
}

export function formatLocationText(str) {
	const raw = String(str || '').trim();
	if (!raw) return '';

	const normalizedSpacing = raw.replace(/\s+/g, ' ').trim();
	const uppercaseTokens = new Set([
		'N',
		'S',
		'E',
		'W',
		'NE',
		'NW',
		'SE',
		'SW',
		'NY',
		'NJ',
		'CT',
		'MA',
		'PA',
		'DC',
		'DE',
		'RI',
		'VT',
		'NH',
		'ME',
		'MD',
		'VA',
		'NC',
		'SC',
		'GA',
		'FL',
		'AL',
		'MS',
		'TN',
		'KY',
		'OH',
		'MI',
		'IN',
		'IL',
		'WI',
		'MN',
		'IA',
		'MO',
		'AR',
		'LA',
		'TX',
		'OK',
		'KS',
		'NE',
		'SD',
		'ND',
		'MT',
		'WY',
		'CO',
		'NM',
		'AZ',
		'UT',
		'ID',
		'NV',
		'CA',
		'OR',
		'WA',
		'AK',
		'HI',
		'PR',
		'VI',
		'GU',
		'AS',
		'MP',
		'PO',
		'P.O.',
	]);

	function formatCore(core) {
		if (!core) return core;
		if (/^\d+[A-Za-z]?$/.test(core)) return core.toUpperCase();
		if (/^\d+$/.test(core)) return core;
		const upper = core.toUpperCase();
		if (uppercaseTokens.has(upper)) return upper;
		const source = !/[a-z]/.test(core) ? core.toLowerCase() : core;
		if (/^mc[a-z]/.test(source)) {
			return `Mc${source.charAt(2).toUpperCase()}${source.slice(3).toLowerCase()}`;
		}
		return source.charAt(0).toUpperCase() + source.slice(1).toLowerCase();
	}

	function formatPart(part) {
		if (!part || /^[-/]$/.test(part)) return part;
		const match = part.match(/^([^A-Za-z0-9]*)([A-Za-z0-9'.]+)([^A-Za-z0-9]*)$/);
		if (!match) return part;
		const [, prefix, core, suffix] = match;
		return `${prefix}${formatCore(core)}${suffix}`;
	}

	return normalizedSpacing
		.split(',')
		.map((segment) =>
			segment
				.trim()
				.split(/\s+/)
				.map((word) =>
					word
						.split(/([-\/])/)
						.map((part) => formatPart(part))
						.join(''),
				)
				.join(' '),
		)
		.filter(Boolean)
		.join(', ');
}

// Safely join an array of possibly heterogeneous items into a readable string.
export function safeJoin(arr: any[], sep = ', ') {
	if (!Array.isArray(arr)) return '';
	return arr
		.map((s) => {
			if (s == null) return '';
			if (typeof s === 'string') return s;
			if (typeof s === 'number' || typeof s === 'boolean') return String(s);
			if (typeof s === 'object') {
				const preferred = s.label || s.name || s.title || s.code || s.state || s.status || s.registrationStatus || s.value || s.description;
				if (preferred && (typeof preferred === 'string' || typeof preferred === 'number')) return String(preferred);
				try {
					return JSON.stringify(s);
				} catch {
					return String(s);
				}
			}
			return String(s);
		})
		.filter(Boolean)
		.join(sep);
}

export function truncate(str, n) {
	return str && str.length > n ? str.slice(0, n - 1) + '…' : str;
}

export function firmSizeLabel(size) {
	if (size == null) return '';
	const s = String(size).trim();
	if (/^\d+$/.test(s)) {
		const n = parseInt(s, 10);
		if (n <= 150) return `Small (${n.toLocaleString()})`;
		if (n <= 499) return `Mid (${n.toLocaleString()})`;
		return `Large (${n.toLocaleString()})`;
	}
	switch (s.toLowerCase()) {
		case 'small':
			return 'Small (1-150)';
		case 'mid':
		case 'medium':
			return 'Mid (151-499)';
		case 'large':
			return 'Large (500+)';
		default:
			return capitalize(s);
	}
}

export function openSidebarToggles() {
	const sidebar = document.getElementById('fg-sidebar-inner');
	if (!sidebar) return;
	const toggles = sidebar.querySelectorAll<HTMLDetailsElement>('details.fg-section-toggle');
	toggles.forEach((toggle) => {
		toggle.open = true;
	});
}

export function row(label, value, extraClass = '') {
	return `<div class="fg-detail-row${extraClass ? ` ${extraClass}` : ''}">
    <span class="fg-label">${label}</span>
    <span>${value}</span>
  </div>`;
}
