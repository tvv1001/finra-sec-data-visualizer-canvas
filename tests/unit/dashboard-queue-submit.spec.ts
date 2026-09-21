import { describe, expect, it } from 'vitest';
import { buildQueueRunItems, createQueueTerminalLogId } from '../../src/app/dashboard/page';

describe('dashboard queue submission display', () => {
	it('creates one queued badge per submitted query', () => {
		const submitted = ['jackie', 'jackson', 'larry'];

		expect(buildQueueRunItems(submitted)).toEqual([
			{ query: 'jackie', status: 'queued', elapsedSec: 0, message: undefined },
			{ query: 'jackson', status: 'queued', elapsedSec: 0, message: undefined },
			{ query: 'larry', status: 'queued', elapsedSec: 0, message: undefined },
		]);
	});

	it('returns an empty list when there is nothing to submit', () => {
		expect(buildQueueRunItems([])).toEqual([]);
	});

	it('creates stable terminal log ids for queue updates', () => {
		expect(createQueueTerminalLogId('start', 1, 1)).toBe('queue:start:1:1');
		expect(createQueueTerminalLogId('done', 2, 3)).toBe('queue:done:2:3');
	});
});
