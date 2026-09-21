let nativeModule: any = null;

function getRuntimeRequire() {
	try {
		return Function('return typeof require === "function" ? require : null')() as ((id: string) => any) | null;
	} catch {
		return null;
	}
}

function getNodeRuntimeHelpers() {
	const runtimeRequire = getRuntimeRequire();
	if (!runtimeRequire) return null;
	try {
		return {
			fs: runtimeRequire('fs'),
			path: runtimeRequire('path'),
		};
	} catch {
		return null;
	}
}

export function canUseNativeGraphLayout() {
	return typeof process !== 'undefined' && !!process.versions?.node;
}

export async function getNativeGraphLayoutModule() {
	if (nativeModule) return nativeModule;
	if (!canUseNativeGraphLayout()) return null;

	try {
		const helpers = getNodeRuntimeHelpers();
		if (!helpers) return null;
		const runtimeRequire = getRuntimeRequire();
		if (!runtimeRequire) return null;
		const nativeEntry = helpers.path.resolve(process.cwd(), 'native/graph-layout');
		if (!helpers.fs.existsSync(helpers.path.join(nativeEntry, 'package.json'))) return null;
		const mod = runtimeRequire(nativeEntry);
		nativeModule = mod;
		return mod;
	} catch {
		return null;
	}
}

export async function computeNativeGraphLayoutSnapshot(nodes: Array<{ id: string; x?: number; y?: number }>, links: Array<{ source: any; target: any }>) {
	const mod = await getNativeGraphLayoutModule();
	if (!mod?.build_force_snapshot) return null;

	const flat = [] as number[];
	for (const node of nodes) {
		flat.push(Number.isFinite(node.x) ? node.x : 0);
		flat.push(Number.isFinite(node.y) ? node.y : 0);
	}
	const edgePairs = [] as number[];
	for (const link of links) {
		const source = String(link.source?.id ?? link.source ?? '');
		const target = String(link.target?.id ?? link.target ?? '');
		const sourceIndex = nodes.findIndex((n) => String(n.id) === source);
		const targetIndex = nodes.findIndex((n) => String(n.id) === target);
		if (sourceIndex >= 0 && targetIndex >= 0) {
			edgePairs.push(sourceIndex, targetIndex);
		}
	}
	const out = (mod.buildForceSnapshot ? mod.buildForceSnapshot(flat, edgePairs) : mod.build_force_snapshot?.(flat, edgePairs)) as number[];
	const positions = nodes.map((node, index) => ({
		id: node.id,
		x: Number.isFinite(out[index * 2]) ? out[index * 2] : Number(node.x) || 0,
		y: Number.isFinite(out[index * 2 + 1]) ? out[index * 2 + 1] : Number(node.y) || 0,
	}));
	return { positions };
}
