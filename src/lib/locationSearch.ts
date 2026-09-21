const STATE_NAME_TO_CODE: Record<string, string> = {
	'alabama': 'AL',
	'alaska': 'AK',
	'arizona': 'AZ',
	'arkansas': 'AR',
	'california': 'CA',
	'colorado': 'CO',
	'connecticut': 'CT',
	'delaware': 'DE',
	'district of columbia': 'DC',
	'florida': 'FL',
	'georgia': 'GA',
	'hawaii': 'HI',
	'idaho': 'ID',
	'illinois': 'IL',
	'indiana': 'IN',
	'iowa': 'IA',
	'kansas': 'KS',
	'kentucky': 'KY',
	'louisiana': 'LA',
	'maine': 'ME',
	'maryland': 'MD',
	'massachusetts': 'MA',
	'michigan': 'MI',
	'minnesota': 'MN',
	'mississippi': 'MS',
	'missouri': 'MO',
	'montana': 'MT',
	'nebraska': 'NE',
	'nevada': 'NV',
	'new hampshire': 'NH',
	'new jersey': 'NJ',
	'new mexico': 'NM',
	'new york': 'NY',
	'north carolina': 'NC',
	'north dakota': 'ND',
	'ohio': 'OH',
	'oklahoma': 'OK',
	'oregon': 'OR',
	'pennsylvania': 'PA',
	'rhode island': 'RI',
	'south carolina': 'SC',
	'south dakota': 'SD',
	'tennessee': 'TN',
	'texas': 'TX',
	'utah': 'UT',
	'vermont': 'VT',
	'virginia': 'VA',
	'washington': 'WA',
	'west virginia': 'WV',
	'wisconsin': 'WI',
	'wyoming': 'WY',
	'american samoa': 'AS',
	'guam': 'GU',
	'northern mariana islands': 'MP',
	'puerto rico': 'PR',
	'u.s. virgin islands': 'VI',
	'virgin islands': 'VI',
};

const STATE_CODES = new Set(Object.values(STATE_NAME_TO_CODE));
const STATE_CODE_TO_NAME = Object.entries(STATE_NAME_TO_CODE).reduce<Record<string, string>>((acc, [name, code]) => {
	acc[code] = name;
	return acc;
}, {});
const US_COUNTRY_PATTERN = /^(?:us|u\.s\.|usa|united states(?: of america)?)$/i;

type LocationRecord = {
	text: string;
	city: string;
	state: string;
	postalCode: string;
	country: string;
	registrationStateOnly?: boolean;
	latitude?: number;
	longitude?: number;
};

function stringifyValue(value: unknown) {
	return String(value || '').trim();
}

function normalizeText(value: unknown) {
	return stringifyValue(value).toLowerCase();
}

function normalizePostalDigits(value: unknown) {
	return stringifyValue(value).replace(/\D/g, '');
}

function parseAddressObject(value: unknown): Record<string, any> | null {
	if (!value) return null;
	if (typeof value === 'string') {
		try {
			const parsed = JSON.parse(value);
			return parsed && typeof parsed === 'object' ? parsed : null;
		} catch {
			return null;
		}
	}
	return typeof value === 'object' ? (value as Record<string, any>) : null;
}

function createLocationRecord(input: Record<string, any>) {
	const street1 = stringifyValue(input.street1 || input.address1 || input.street);
	const street2 = stringifyValue(input.street2 || input.address2 || input.suite || input.unit);
	const city = stringifyValue(input.city || input.branch_city || input.officeCity);
	const state = stringifyValue(input.state || input.stateCode || input.branch_state || input.officeState || input.province);
	const postalCode = stringifyValue(input.postalCode || input.zipCode || input.zip || input.branch_zip);
	const country = stringifyValue(input.country);
	const latVal = input.latitude ?? input.lat;
	const lonVal = input.longitude ?? input.lon ?? input.lng;
	const latitude = latVal !== undefined && latVal !== null && latVal !== '' ? parseFloat(String(latVal)) : undefined;
	const longitude = lonVal !== undefined && lonVal !== null && lonVal !== '' ? parseFloat(String(lonVal)) : undefined;

	const text = [street1, street2, city, state, postalCode, country].filter(Boolean).join(', ');
	if (!text && !city && !state && !postalCode && !country && latitude === undefined && longitude === undefined) return null;
	return {
		text,
		city,
		state,
		postalCode,
		country,
		latitude: latitude && !isNaN(latitude) ? latitude : undefined,
		longitude: longitude && !isNaN(longitude) ? longitude : undefined,
	};
}

function addRecord(records: LocationRecord[], seen: Set<string>, record: LocationRecord | null) {
	if (!record) return;
	const key = [normalizeText(record.text), normalizeText(record.city), normalizeText(record.state), normalizeText(record.postalCode), normalizeText(record.country)].join('|');
	if (!key || seen.has(key)) return;
	seen.add(key);
	records.push(record);
}

function addStructuredAddress(records: LocationRecord[], seen: Set<string>, value: unknown) {
	const parsed = parseAddressObject(value);
	if (!parsed) return;

	if (parsed.officeAddress || parsed.office || parsed.mailingAddress || parsed.mailing) {
		addStructuredAddress(records, seen, parsed.officeAddress || parsed.office);
		addStructuredAddress(records, seen, parsed.mailingAddress || parsed.mailing);
		return;
	}

	addRecord(records, seen, createLocationRecord(parsed));
}

function isPersonLocationNode(node: any) {
	return (
		String(node?.group || '')
			.trim()
			.toLowerCase() === 'individual' || Boolean(node?.crd || node?.individualId || node?.basicInformation?.individualId)
	);
}

function isCurrentRegistrationState(record: Record<string, any>) {
	const statusText = normalizeText(record?.status || record?.registrationStatus || record?.scopeStatus || record?.stateStatus || record?.regStatus);
	if (!statusText) return true;
	if (/(inactive|terminated|revoked|suspended|withdrawn|expired|ceased|closed|not\s*active|not\s*in\s*scope|previous)/.test(statusText)) return false;
	return /(approved|active|current|licensed|registered|effective|valid)/.test(statusText);
}

function addRegisteredStateRecords(records: LocationRecord[], seen: Set<string>, value: unknown) {
	for (const entry of Array.isArray(value) ? value : []) {
		if (!entry || typeof entry !== 'object') continue;
		if (!isCurrentRegistrationState(entry as Record<string, any>)) continue;
		const state = stringifyValue((entry as Record<string, any>).state || (entry as Record<string, any>).registeredState || (entry as Record<string, any>).stateCode);
		if (!state) continue;
		const stateName = STATE_CODE_TO_NAME[state.toUpperCase()] || '';
		const record = createLocationRecord({
			city: stateName,
			state,
			country: 'US',
		});
		if (record) {
			addRecord(records, seen, { ...record, registrationStateOnly: true });
		}
	}
}

export function normalizeStateCode(value: unknown) {
	const trimmed = stringifyValue(value);
	if (!trimmed) return '';
	const upper = trimmed.toUpperCase();
	if (STATE_CODES.has(upper)) return upper;
	return STATE_NAME_TO_CODE[trimmed.toLowerCase()] || '';
}

export function normalizeLocationStateFilter(value: unknown) {
	const trimmed = stringifyValue(value).toUpperCase();
	if (!trimmed) return '';
	if (trimmed === 'INT' || trimmed === 'INTERNATIONAL') return 'INT';
	return normalizeStateCode(trimmed);
}

export function isValidLocationStateFilter(value: unknown) {
	const trimmed = stringifyValue(value);
	if (!trimmed) return true;
	return Boolean(normalizeLocationStateFilter(trimmed));
}

export function isZipLikeLocationQuery(value: unknown) {
	return /^\d{5}(?:-\d{4})?$/.test(stringifyValue(value));
}

export function isInternationalLocationRecord(record: Pick<LocationRecord, 'text' | 'state' | 'postalCode' | 'country'>) {
	const country = stringifyValue(record.country);
	if (country && !US_COUNTRY_PATTERN.test(country)) return true;

	const rawState = stringifyValue(record.state);
	if (rawState && !normalizeStateCode(rawState)) return true;

	const postal = stringifyValue(record.postalCode);
	if (postal && /[A-Za-z]/.test(postal)) return true;

	const text = stringifyValue(record.text);
	if (text) {
		if (/\b(canada|england|ireland|scotland|wales|australia|new zealand|mexico|germany|france|switzerland|singapore|hong kong|japan)\b/i.test(text)) {
			return true;
		}
		if (!rawState && /\b[A-Z]\d[A-Z][ -]?\d[A-Z]\d\b/i.test(text)) {
			return true;
		}
	}

	return false;
}

export function collectNodeLocationRecords(node: any) {
	const records: LocationRecord[] = [];
	const seen = new Set<string>();
	const isPersonNode = isPersonLocationNode(node);

	if (isPersonNode) {
		const currentEmploymentCollections = [node?.currentEmployments, node?.currentIAEmployments, node?.ind_current_employments, node?.ind_ia_current_employments];
		for (const collection of currentEmploymentCollections) {
			for (const entry of Array.isArray(collection) ? collection : []) {
				addRecord(records, seen, createLocationRecord(entry || {}));
			}
		}
		if (typeof node?.officeAddress === 'string') {
			addRecord(
				records,
				seen,
				createLocationRecord({
					address1: node.officeAddress,
				}),
			);
		} else {
			addStructuredAddress(records, seen, node?.officeAddress);
		}
		addStructuredAddress(records, seen, node?.primaryOffice);
		addRegisteredStateRecords(records, seen, node?.registeredStates);
		addRegisteredStateRecords(records, seen, node?.basicInformation?.registeredStates);
	} else {
		addStructuredAddress(records, seen, node?.firmAddressDetails);
		addStructuredAddress(records, seen, node?.iaFirmAddressDetails);
		addStructuredAddress(records, seen, node?.firm_address_details);
		addStructuredAddress(records, seen, node?.address_details);
		addStructuredAddress(records, seen, node?.basicInformation?.firmAddressDetails);
		addStructuredAddress(records, seen, node?.basicInformation?.iaFirmAddressDetails);
		addStructuredAddress(records, seen, node?.primaryOffice);

		if (typeof node?.officeAddress === 'string') {
			addRecord(
				records,
				seen,
				createLocationRecord({
					address1: node.officeAddress,
				}),
			);
		} else {
			addStructuredAddress(records, seen, node?.officeAddress);
		}
	}

	const employmentCollections =
		isPersonNode ?
			[node?.currentEmployments, node?.currentIAEmployments, node?.ind_current_employments, node?.ind_ia_current_employments]
		:	[
				node?.currentEmployments,
				node?.previousEmployments,
				node?.currentIAEmployments,
				node?.previousIAEmployments,
				node?.ind_current_employments,
				node?.ind_previous_employments,
				node?.ind_ia_current_employments,
				node?.ind_ia_previous_employments,
				node?.branchOfficeLocations,
			];

	for (const collection of employmentCollections) {
		for (const entry of Array.isArray(collection) ? collection : []) {
			addRecord(records, seen, createLocationRecord(entry || {}));
		}
	}

	// Fallback for root-level coordinates or basic information coords
	if (node?.latitude !== undefined || node?.longitude !== undefined || node?.lat !== undefined) {
		const rootLat = node.latitude ?? node.lat;
		const rootLon = node.longitude ?? node.lon ?? node.lng;
		addRecord(
			records,
			seen,
			createLocationRecord({
				city: node.city || node.officeCity,
				state: node.state || node.officeState,
				postalCode: node.postalCode || node.zipCode || node.zip,
				latitude: rootLat,
				longitude: rootLon,
			}),
		);
	}

	return records;
}

export function getHaversineDistanceMiles(lat1: number, lon1: number, lat2: number, lon2: number): number {
	const R = 3958.8; // Earth's radius in miles
	const dLat = ((lat2 - lat1) * Math.PI) / 180;
	const dLon = ((lon2 - lon1) * Math.PI) / 180;
	const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
	const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
	return R * c;
}

export function nodeMatchesLocationSearch(
	node: any,
	{
		locationQuery = '',
		stateFilter = '',
		radius,
		refLat,
		refLon,
	}: {
		locationQuery?: string;
		stateFilter?: string;
		radius?: number;
		refLat?: number;
		refLon?: number;
	} = {},
) {
	const queryTerms = normalizeText(locationQuery)
		.split(/[\s,]+/)
		.filter(Boolean);
	const normalizedState = normalizeLocationStateFilter(stateFilter);

	if (!queryTerms.length && !normalizedState && radius === undefined) return false;

	const records = collectNodeLocationRecords(node);
	if (!records.length) return false;

	// If we have refLat and refLon and a radius, check if any record is within the radius
	if (radius !== undefined && refLat !== undefined && refLon !== undefined) {
		return records.some((record) => {
			if (record.latitude === undefined || record.longitude === undefined) return false;
			const dist = getHaversineDistanceMiles(refLat, refLon, record.latitude, record.longitude);
			return dist <= radius;
		});
	}

	return records.some((record) => {
		const recordState = normalizeStateCode(record.state);
		const isInternational = isInternationalLocationRecord(record);

		if (record.registrationStateOnly) {
			if (!normalizedState) return false;
			return recordState === normalizedState;
		}

		if (normalizedState === 'INT') {
			if (!isInternational) return false;
		} else if (normalizedState && recordState !== normalizedState) {
			return false;
		}

		if (!queryTerms.length) return true;

		// If query looks like a ZIP code and we have a single term
		const queryLooksLikeZip = queryTerms.length === 1 && isZipLikeLocationQuery(queryTerms[0]);
		if (queryLooksLikeZip) {
			const recordZipDigits = normalizePostalDigits(record.postalCode);
			const queryZipDigits = normalizePostalDigits(queryTerms[0]);
			return Boolean(recordZipDigits) && recordZipDigits.startsWith(queryZipDigits);
		}

		// Check if all query terms exist in the record
		const recordFullText = [record.text, record.city, record.state, record.postalCode, record.country].filter(Boolean).join(' ').toLowerCase();
		return queryTerms.every((term) => recordFullText.includes(term));
	});
}
