import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('crdInventorySidecar', () => {
	let tmpDir = '';
	let cwdSpy: ReturnType<typeof vi.spyOn> | null = null;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crd-inv-'));
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

	it('merges unique firm/individual ids and keeps same numeric id in both namespaces', async () => {
		const {
			rememberInventoryEntities,
			flushCrdInventorySidecar,
			loadCrdInventorySync,
			getCrdInventoryCounts,
			resetCrdInventoryModuleCache,
		} = await import('@/lib/crdInventorySidecar');
		resetCrdInventoryModuleCache();

		const first = await rememberInventoryEntities([
			{ kind: 'firm', id: 100 },
			{ kind: 'individual', id: 100 },
			{ kind: 'firm', id: 100 },
		]);
		expect(first.added).toBe(2);
		expect(first.counts).toEqual({ people: 1, firms: 1, unique: 2 });

		const second = await rememberInventoryEntities([{ kind: 'individual', id: '200' }]);
		expect(second.added).toBe(1);
		expect(getCrdInventoryCounts()).toEqual({ people: 2, firms: 1, unique: 3 });

		await flushCrdInventorySidecar();
		resetCrdInventoryModuleCache();
		const loaded = loadCrdInventorySync();
		expect(loaded.firms).toEqual([100]);
		expect(loaded.individuals).toEqual([100, 200]);
		expect(loaded.counts.unique).toBe(3);
	});

	it('replaceCrdInventory writes gzip that round-trips', async () => {
		const { replaceCrdInventory, resetCrdInventoryModuleCache, loadCrdInventorySync, getCrdInventoryPath } =
			await import('@/lib/crdInventorySidecar');
		resetCrdInventoryModuleCache();

		await replaceCrdInventory({
			firms: [305, 149018],
			individuals: [1085996],
		});

		const filePath = getCrdInventoryPath();
		const buf = fs.readFileSync(filePath);
		expect(buf[0]).toBe(0x1f);
		expect(buf[1]).toBe(0x8b);
		const parsed = JSON.parse(zlib.gunzipSync(buf).toString('utf8'));
		expect(parsed.counts).toEqual({ people: 1, firms: 2, unique: 3 });

		resetCrdInventoryModuleCache();
		expect(loadCrdInventorySync().counts.unique).toBe(3);
	});

	it('skips disk writes on Vercel', async () => {
		vi.stubEnv('VERCEL', '1');
		const { replaceCrdInventory, hasCrdInventorySidecar, resetCrdInventoryModuleCache, getCrdInventoryPath } =
			await import('@/lib/crdInventorySidecar');
		resetCrdInventoryModuleCache();
		await replaceCrdInventory({ firms: [1], individuals: [2] });
		expect(hasCrdInventorySidecar()).toBe(false);
		expect(fs.existsSync(getCrdInventoryPath())).toBe(false);
		vi.unstubAllEnvs();
	});
});
