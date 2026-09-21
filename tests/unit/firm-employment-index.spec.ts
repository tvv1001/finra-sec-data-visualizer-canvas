import { describe, expect, it, afterEach } from 'vitest';
import zlib from 'node:zlib';
import { isFirmEmploymentFullScanEnabled, unwrapIndividualPayload, getFirmEmploymentEdgesFromFullScan } from '@/lib/firmEmploymentIndex';

describe('firmEmploymentIndex (shared Redis throughput)', () => {
	const originalFullScan = process.env.FINRA_FIRM_EMPLOYMENT_FULL_SCAN;

	afterEach(() => {
		if (originalFullScan === undefined) delete process.env.FINRA_FIRM_EMPLOYMENT_FULL_SCAN;
		else process.env.FINRA_FIRM_EMPLOYMENT_FULL_SCAN = originalFullScan;
	});

	it('disables full individual SCAN by default', () => {
		delete process.env.FINRA_FIRM_EMPLOYMENT_FULL_SCAN;
		expect(isFirmEmploymentFullScanEnabled()).toBe(false);
	});

	it('enables full SCAN only when FINRA_FIRM_EMPLOYMENT_FULL_SCAN=1', () => {
		process.env.FINRA_FIRM_EMPLOYMENT_FULL_SCAN = '1';
		expect(isFirmEmploymentFullScanEnabled()).toBe(true);
	});

	it('returns no edges when full SCAN is disabled (no Redis thrash)', async () => {
		delete process.env.FINRA_FIRM_EMPLOYMENT_FULL_SCAN;
		const edges = await getFirmEmploymentEdgesFromFullScan('107342');
		expect(edges).toEqual([]);
	});

	it('unwraps brotli br: binary individual payloads', () => {
		const payload = {
			hits: {
				hits: [
					{
						_source: {
							content: JSON.stringify({
								basicInformation: { firstName: 'Ada', lastName: 'Lovelace', individualId: 42 },
								currentEmployments: [{ firmId: '6413', firmName: 'LPL FINANCIAL LLC' }],
								previousEmployments: [],
							}),
						},
					},
				],
			},
		};
		const compressed = 'br:' + zlib.brotliCompressSync(Buffer.from(JSON.stringify(payload))).toString('base64');
		const unwrapped = unwrapIndividualPayload(compressed);
		expect(unwrapped?.basicInformation?.lastName).toBe('Lovelace');
		expect(unwrapped?.currentEmployments?.[0]?.firmId).toBe('6413');
	});

	it('unwraps plain JSON object payloads', () => {
		const unwrapped = unwrapIndividualPayload({
			basicInformation: { firstName: 'Grace', lastName: 'Hopper' },
			currentEmployments: [{ firmId: '107342' }],
		});
		expect(unwrapped?.basicInformation?.firstName).toBe('Grace');
		expect(unwrapped?.currentEmployments?.[0]?.firmId).toBe('107342');
	});
});
