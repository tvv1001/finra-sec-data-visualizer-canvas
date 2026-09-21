import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('rememberCrdLogEntries', () => {
	let tmpDir = '';
	let cwdSpy: ReturnType<typeof vi.spyOn> | null = null;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crd-log-'));
		fs.mkdirSync(path.join(tmpDir, 'data'), { recursive: true });
		cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
		vi.resetModules();
	});

	afterEach(() => {
		cwdSpy?.mockRestore();
		try {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});

	it('upserts individuals and employer firms into the CRD log', async () => {
		const { rememberCrdLogEntries, loadCrdLogSync, resetCrdLogModuleCache } = await import('@/lib/crdLog');
		resetCrdLogModuleCache();
		await rememberCrdLogEntries([
			{ kind: 'individual', id: '1085996', name: 'Timothy Dale Register' },
			{ kind: 'firm', id: '7691', name: 'MERRILL LYNCH, PIERCE, FENNER & SMITH INCORPORATED' },
		]);
		resetCrdLogModuleCache();
		const log = loadCrdLogSync();
		expect(log.individuals[0]).toEqual({ id: 1085996, name: 'Timothy Dale Register' });
		expect(log.firms[0]).toEqual({
			id: 7691,
			name: 'MERRILL LYNCH, PIERCE, FENNER & SMITH INCORPORATED',
		});
	});
});
