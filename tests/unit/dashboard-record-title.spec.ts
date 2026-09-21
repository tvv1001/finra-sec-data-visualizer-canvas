import { describe, expect, it } from 'vitest';
import { resolveMainRecordTitle } from '../../src/lib/dashboard-record-title';

describe('resolveMainRecordTitle', () => {
	it('prefers a derived firm name from payload data when the label is still generic', () => {
		const title = resolveMainRecordTitle({
			mainJsonLabel: 'Firm 149777',
			fallbackName: '',
			entity: 'firm',
			id: '149777',
			payload: {
				basicInformation: {
					firmName: 'MORGAN STANLEY',
				},
			},
		});

		expect(title).toBe('Morgan Stanley');
	});

	it('prefers a derived name when the label is just a placeholder like Result', () => {
		const title = resolveMainRecordTitle({
			mainJsonLabel: 'Result',
			fallbackName: 'Result',
			entity: 'individual',
			id: '8276416',
			payload: {
				basicInformation: {
					firstName: 'Alice',
					lastName: 'Johnson',
				},
			},
		});

		expect(title).toBe('Alice Johnson');
	});
});
