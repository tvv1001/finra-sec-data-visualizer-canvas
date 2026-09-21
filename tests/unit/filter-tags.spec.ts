import { describe, expect, it } from 'vitest';
import { matchesConnectionsFilter, matchesFilterTags, partitionConnectionsByFilter, shouldPreviewUnfilteredConnections } from '@/lib/filterTags';

describe('matchesConnectionsFilter', () => {
	it('matches tags when enabled', () => {
		expect(matchesConnectionsFilter('Jane Doe CRD#123', ['jane'], '', true)).toBe(true);
		expect(matchesConnectionsFilter('Jane Doe CRD#123', ['smith'], '', true)).toBe(false);
	});

	it('ignores committed tags when the checkbox is off but still applies live text', () => {
		expect(matchesConnectionsFilter('Jane Doe CRD#123', ['smith'], '', false)).toBe(true);
		expect(matchesConnectionsFilter('Jane Doe CRD#123', ['smith'], '123', false)).toBe(true);
		expect(matchesConnectionsFilter('Jane Doe CRD#123', ['smith'], 'zzz', false)).toBe(false);
	});

	it('ignores tags during empty-focus preview', () => {
		expect(matchesConnectionsFilter('Jane Doe CRD#123', ['smith'], '', true, true)).toBe(true);
	});

	it('keeps OR tag matching via matchesFilterTags', () => {
		expect(matchesFilterTags('alpha beta', ['zzz', 'beta'])).toBe(true);
	});

	it('requires all tokens in a multi-word live query (timothy dale)', () => {
		expect(matchesFilterTags('timothy dale register crd 1085996', [], 'timothy dale')).toBe(true);
		expect(matchesFilterTags('timothy peter ryan', [], 'timothy dale')).toBe(false);
		// Token order does not matter — both timothy and dale must appear.
		expect(matchesFilterTags('dale register timothy', [], 'timothy dale')).toBe(true);
	});

	it('matches committed tags as ordered phrases, even when the phrase is a prefix inside a longer word', () => {
		expect(matchesFilterTags('timothy d register', ['timothy d'], '')).toBe(true);
		expect(matchesFilterTags('timothy dale register', ['timothy d'], '')).toBe(true);
		expect(matchesFilterTags('dale smith register', ['dale smith'], '')).toBe(true);
		expect(matchesFilterTags('smith dale register', ['dale smith'], '')).toBe(false);
	});

	it('does not let leftover tags block a live CRD / name query', () => {
		expect(matchesFilterTags('timothy dale register 1085996', ['smith'], '1085996')).toBe(true);
		expect(matchesFilterTags('timothy dale register 1085996', ['smith'], 'timothy dale')).toBe(true);
		expect(matchesFilterTags('bob jones', ['smith'], '')).toBe(false);
	});
});

describe('shouldPreviewUnfilteredConnections', () => {
	it('previews the full list on empty focus', () => {
		expect(shouldPreviewUnfilteredConnections({ focused: true, liveText: '', justCommitted: false })).toBe(true);
	});

	it('applies tags after the first typed character', () => {
		expect(shouldPreviewUnfilteredConnections({ focused: true, liveText: 'j', justCommitted: false })).toBe(false);
	});

	it('stays filtered after Enter commits a tag', () => {
		expect(shouldPreviewUnfilteredConnections({ focused: true, liveText: '', justCommitted: true })).toBe(false);
	});
});

describe('partitionConnectionsByFilter', () => {
	it('keeps unmatched items after matched ones instead of dropping them', () => {
		const items = [
			{ name: 'Alice Smith' },
			{ name: 'Bob Jones' },
			{ name: 'Carol Smith' },
		];
		const result = partitionConnectionsByFilter(items, (item) => item.name, ['smith'], '', true, false);
		expect(result.matched.map((item) => item.name)).toEqual(['Alice Smith', 'Carol Smith']);
		expect(result.unmatched.map((item) => item.name)).toEqual(['Bob Jones']);
		expect(result.ordered.map((item) => item.name)).toEqual(['Alice Smith', 'Carol Smith', 'Bob Jones']);
	});

	it('treats every item as matched when filtering is disabled', () => {
		const items = [{ name: 'Alice' }, { name: 'Bob' }];
		const result = partitionConnectionsByFilter(items, (item) => item.name, ['zzz'], '', false, false);
		expect(result.matched).toHaveLength(2);
		expect(result.unmatched).toHaveLength(0);
	});

	it('ranks multi-word matches ahead of single-token noise', () => {
		const items = [
			{ name: 'Timothy PETER Ryan' },
			{ name: 'Timothy Dale Register' },
			{ name: 'Tyler Dale Bonar' },
		];
		const result = partitionConnectionsByFilter(items, (item) => item.name.toLowerCase(), [], 'timothy dale', true, false);
		expect(result.matched.map((item) => item.name)).toEqual(['Timothy Dale Register']);
		expect(result.ordered[0].name).toBe('Timothy Dale Register');
	});
});
