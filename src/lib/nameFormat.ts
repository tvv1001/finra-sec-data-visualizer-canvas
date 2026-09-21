/**
 * Centralized name formatting utility.
 * - Individuals: First Middle Last in Capital Case (Title Case).
 * - Firms: If 3 letters only in the name -> ALL CAPS. For multi-word firms, Title Case with 2-3 letter acronyms in ALL CAPS.
 */

const SUFFIX_MAP: Record<string, string> = {
	jr: 'Jr.',
	'jr.': 'Jr.',
	sr: 'Sr.',
	'sr.': 'Sr.',
	ii: 'II',
	iii: 'III',
	iv: 'IV',
	v: 'V',
	vi: 'VI',
	vii: 'VII',
	viii: 'VIII',
	ix: 'IX',
	x: 'X',
	md: 'MD',
	'md.': 'MD',
	phd: 'PhD',
	'ph.d.': 'PhD',
	'ph.d': 'PhD',
	cpa: 'CPA',
	cfp: 'CFP',
	cfa: 'CFA',
	jd: 'JD',
	esq: 'Esq.',
	'esq.': 'Esq.',
};

const COMMON_SMALL_WORDS = new Set(['of', 'and', 'the', 'in', 'on', 'at', 'to', 'for', 'by', 'with', '&']);

/**
 * Capitalizes an individual word in a person's name.
 * Handles apostrophes (O'Connor, D'Angelo), hyphens (Smith-Jones), and suffixes (Jr., III).
 */
export function capitalizePersonWord(rawWord: string): string {
	if (!rawWord) return '';
	const trimmed = rawWord.trim().replace(/^,+|,+$/g, '');
	if (!trimmed) return '';

	const clean = trimmed.toLowerCase();
	if (SUFFIX_MAP[clean]) {
		return SUFFIX_MAP[clean];
	}

	// If word contains hyphen
	if (trimmed.includes('-')) {
		return trimmed
			.split('-')
			.map((part) => capitalizePersonWord(part))
			.join('-');
	}

	// If word contains apostrophe (e.g. O'Connor, D'Angelo)
	if (trimmed.includes("'")) {
		return trimmed
			.split("'")
			.map((part, idx) => {
				if (!part) return '';
				if (idx === 0 && part.length === 1) return part.toUpperCase();
				return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
			})
			.join("'");
	}

	// Handle single-letter initial (e.g. "J" or "J.")
	if (/^[A-Za-z]\.?$/.test(trimmed)) {
		return trimmed.toUpperCase();
	}

	// If word already contains mixed case (e.g. McDonald, DeLaCruz), preserve internal casing
	if (/[a-z]/.test(trimmed) && /[A-Z]/.test(trimmed.slice(1))) {
		return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
	}

	// Standard word capitalization
	return trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase();
}

/**
 * Formats a person's name into Capital Case with "First Middle Last [Suffix]" ordering.
 */
export function formatPersonName(
	input: string | { firstName?: unknown; middleName?: unknown; lastName?: unknown; suffix?: unknown } | null | undefined,
): string {
	if (!input) return '';

	if (typeof input === 'object' && input !== null) {
		const first = String(input.firstName || '').trim();
		const middle = String(input.middleName || '').trim();
		const last = String(input.lastName || '').trim();
		const suffix = String(input.suffix || '').trim();

		const parts = [first, middle, last, suffix].filter(Boolean);
		if (parts.length > 0) {
			return parts
				.map((part) =>
					part
						.split(/\s+/)
						.map((w) => capitalizePersonWord(w))
						.filter(Boolean)
						.join(' '),
				)
				.filter(Boolean)
				.join(' ')
				.replace(/\s+/g, ' ')
				.trim();
		}
		return '';
	}

	const raw = String(input || '').trim();
	if (!raw) return '';

	// Check for "LAST, FIRST MIDDLE [SUFFIX]" format with one or more commas
	if (raw.includes(',')) {
		const commaSegments = raw.split(',').map((seg) => seg.trim()).filter(Boolean);
		if (commaSegments.length >= 2) {
			const last = commaSegments[0];
			const firstAndMiddle = commaSegments[1];
			const suffixes = commaSegments.slice(2);

			const reordered = [firstAndMiddle, last, ...suffixes].join(' ');
			return reordered
				.split(/\s+/)
				.map((tok) => capitalizePersonWord(tok))
				.filter(Boolean)
				.join(' ')
				.replace(/\s+/g, ' ')
				.trim();
		}
	}

	// Standard whitespace-separated name
	return raw
		.split(/\s+/)
		.map((word) => capitalizePersonWord(word))
		.filter(Boolean)
		.join(' ')
		.replace(/\s+/g, ' ')
		.trim();
}

/**
 * Builds a person's name from individual parts in "First Middle Last Suffix" order.
 */
export function buildPersonName(
	firstName?: unknown,
	middleName?: unknown,
	lastName?: unknown,
	suffix?: unknown,
): string {
	const first = String(firstName || '').trim();
	const middle = String(middleName || '').trim();
	const last = String(lastName || '').trim();
	const suf = String(suffix || '').trim();

	const combined = [first, middle, last, suf].filter(Boolean).join(' ');
	if (!combined) return '';
	return formatPersonName(combined);
}

/**
 * Formats a firm's name:
 * - If only 3 letters in the entire name -> ALL CAPS (e.g. "UBS", "PNC", "RIA", "KGI", "ABC").
 * - Multi-word / general firms -> Capital Case, keeping 2-3 letter abbreviations (LLC, INC, LP, LLP, RIA, SEC, USA, etc.) ALL CAPS.
 */
export function formatFirmName(name: string | null | undefined): string {
	if (!name) return '';
	const raw = String(name).trim();
	if (!raw) return '';

	// Count only alphabetical letters in the entire name
	const alphaOnly = raw.replace(/[^A-Za-z]/g, '');
	if (alphaOnly.length === 3) {
		return raw.toUpperCase();
	}

	if (raw.length <= 3 && /^[A-Za-z0-9.&'-]+$/.test(raw)) {
		return raw.toUpperCase();
	}

	// Split by whitespace
	const words = raw.split(/\s+/);
	const formattedWords = words.map((word, idx) => {
		if (!word) return '';

		// Check for punctuation around the word, e.g. "(LLC)", "&", "CO."
		const match = word.match(/^([^A-Za-z0-9]*)([A-Za-z0-9'.&-]+)([^A-Za-z0-9]*)$/);
		if (!match) return word;

		const [, prefix, core, suffix] = match;
		const coreLower = core.toLowerCase();
		const coreAlpha = core.replace(/[^A-Za-z]/g, '');

		// Keep small words lowercase if not the first word (e.g. "of", "and")
		if (idx > 0 && COMMON_SMALL_WORDS.has(coreLower)) {
			return `${prefix}${coreLower}${suffix}`;
		}

		// Co. / Corp. / Inc.
		if (coreLower === 'co' || coreLower === 'co.') {
			return `${prefix}Co.${suffix}`;
		}
		if (coreLower === 'corp' || coreLower === 'corp.') {
			return `${prefix}Corp.${suffix}`;
		}
		if (coreLower === 'inc' || coreLower === 'inc.') {
			return `${prefix}Inc.${suffix}`;
		}

		// If a token/acronym has 2 to 3 letters (e.g. LLC, LP, LLP, PLC, RIA, SEC, USA, UK, US, PNC, UBS, KGI, BMO, TD, RBC, BB&T, J.P.) -> ALL CAPS
		if (coreAlpha.length >= 2 && coreAlpha.length <= 3 && !COMMON_SMALL_WORDS.has(coreLower)) {
			return `${prefix}${core.toUpperCase()}${suffix}`;
		}

		// Check for hyphenated firm words
		if (core.includes('-')) {
			const hyphenated = core
				.split('-')
				.map((part) => {
					const pAlpha = part.replace(/[^A-Za-z]/g, '');
					if (pAlpha.length >= 2 && pAlpha.length <= 3) return part.toUpperCase();
					return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
				})
				.join('-');
			return `${prefix}${hyphenated}${suffix}`;
		}

		// Standard Capital Case
		// If word already contains mixed case (like CardJSON or McDonald), preserve internal casing
		const isMixedCase = /[a-z]/.test(core) && /[A-Z]/.test(core.slice(1));
		const formattedCore = isMixedCase ? core.charAt(0).toUpperCase() + core.slice(1) : core.charAt(0).toUpperCase() + core.slice(1).toLowerCase();
		return `${prefix}${formattedCore}${suffix}`;
	});

	return formattedWords.join(' ').replace(/\s+/g, ' ').trim();
}

export function formatEntityName(name: string | null | undefined, entity?: 'individual' | 'firm' | string | null): string {
	if (!name) return '';
	if (entity === 'firm') return formatFirmName(name);
	if (entity === 'individual') return formatPersonName(name);
	const raw = String(name).trim();
	const alphaOnly = raw.replace(/[^A-Za-z]/g, '');
	if (
		alphaOnly.length === 3 ||
		/\b(llc|inc|corp|corporation|co|ltd|lp|llp|advisors?|partners?|capital|management|group|holdings?|bank|securities|wealth|financial|investments?)\b/i.test(raw)
	) {
		return formatFirmName(raw);
	}
	return formatPersonName(raw);
}
